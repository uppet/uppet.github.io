// src/remote/protocol.js
var VERSION = 1;
var CHUNK_BYTES = 12 * 1024;
var MAX_MESSAGE_BYTES = 64 * 1024;
var encoder = new TextEncoder();
var decoder = new TextDecoder();
function base64(bytes) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
function unbase64(value) {
  if (typeof value !== "string" || value.length > 90 * 1024) throw new Error("Invalid encoded chunk");
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function randomId() {
  return crypto.randomUUID();
}
async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", typeof bytes === "string" ? encoder.encode(bytes) : bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function secretKey(secret, algorithm, usages) {
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", encoder.encode(secret)), algorithm, false, usages);
}
async function sign(secret, text) {
  return base64(new Uint8Array(await crypto.subtle.sign("HMAC", await secretKey(secret, { name: "HMAC", hash: "SHA-256" }, ["sign"]), encoder.encode(text))));
}
async function verify(secret, text, signature) {
  try {
    return await crypto.subtle.verify("HMAC", await secretKey(secret, { name: "HMAC", hash: "SHA-256" }, ["verify"]), unbase64(signature), encoder.encode(text));
  } catch {
    return false;
  }
}
async function seal(secret, room, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.length > 40 * 1024) throw new Error("Signaling message too large");
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(room) }, await secretKey(secret, "AES-GCM", ["encrypt"]), bytes);
  return { v: VERSION, iv: base64(iv), data: base64(new Uint8Array(encrypted)) };
}
async function unseal(secret, room, value) {
  if (value?.v !== VERSION) throw new Error("Unsupported protocol version");
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(value.iv), additionalData: encoder.encode(room) }, await secretKey(secret, "AES-GCM", ["decrypt"]), unbase64(value.data));
  return JSON.parse(decoder.decode(bytes));
}
function decodeInvite(text) {
  const value = text.trim();
  if (!value.startsWith("cloco1.") || value.length > 12e3) throw new Error("\u8BF7\u8F93\u5165 cloco \u751F\u6210\u7684\u5B8C\u6574\u8FDE\u63A5 token");
  const invite = JSON.parse(decoder.decode(unbase64(value.slice(7).replaceAll("-", "+").replaceAll("_", "/"))));
  validateInvite(invite);
  return invite;
}
function validateInvite(invite) {
  if (invite.v !== VERSION || typeof invite.secret !== "string" || invite.secret.length < 16 || invite.secret.length > 256) throw new Error("Invalid connection token");
  if (!/^cloco-[a-f0-9]{32}$/.test(invite.room)) throw new Error("Invalid room");
  if (!Number.isSafeInteger(invite.expires) || invite.expires <= Date.now()) throw new Error("\u8FDE\u63A5 token \u5DF2\u8FC7\u671F\uFF0C\u8BF7\u5728\u4E3B\u673A\u91CD\u65B0\u751F\u6210");
  const url = new URL(invite.signal);
  if (url.username || url.password || url.hash || url.search) throw new Error("Invalid signaling URL");
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("\u4FE1\u4EE4\u670D\u52A1\u5FC5\u987B\u4F7F\u7528 WSS\uFF0C\u672C\u673A\u6D4B\u8BD5\u53EF\u4F7F\u7528 WS");
  if (invite.provider !== "metered" && invite.provider !== "local") throw new Error("Unknown signaling provider");
  if (invite.key && (!invite.key.startsWith("pk_") || invite.key.length > 1024)) throw new Error("Only a publishable signaling key is allowed");
}
async function sendChannel(channel, message2) {
  const text = JSON.stringify(message2);
  if (encoder.encode(text).length > MAX_MESSAGE_BYTES) throw new Error("DataChannel message too large");
  const deadline = Date.now() + 3e4;
  while (channel.bufferedAmount > 256 * 1024) {
    if (Date.now() > deadline || channel.readyState !== "open") throw new Error("Connection stalled");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (channel.readyState !== "open") throw new Error("Connection closed");
  channel.send(text);
}
function parseMessage(text) {
  if (typeof text !== "string" || encoder.encode(text).length > MAX_MESSAGE_BYTES) throw new Error("Invalid message");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || typeof value.type !== "string") throw new Error("Invalid message");
  return value;
}

// src/remote/signaling.js
var Signaling = class {
  constructor(invite, { WebSocketImpl = globalThis.WebSocket, onSignal, onStatus, onWelcome } = {}) {
    Object.assign(this, { invite, WebSocketImpl, onSignal, onStatus, onWelcome });
    this.closed = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const url = new URL(this.invite.signal);
      if (this.invite.key) url.searchParams.set("key", this.invite.key);
      const ws = this.ws = new this.WebSocketImpl(url.toString());
      let subscribed = false;
      const subscribeId = randomId();
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("\u4FE1\u4EE4\u670D\u52A1\u8FDE\u63A5\u8D85\u65F6"));
      }, 15e3);
      ws.onmessage = async (event) => {
        try {
          const text = typeof event.data === "string" ? event.data : event.data.toString();
          if (text.length > 90 * 1024) return;
          const message2 = JSON.parse(text);
          if (message2.type === "welcome") {
            this.peerId = message2.peerId;
            this.iceServers = message2.metadata?.iceServers || message2.iceServers || [];
            this.write({ type: "subscribe", channel: this.invite.room, requestId: subscribeId });
            this.onWelcome?.(message2);
          } else if (message2.type === "ack" && message2.requestId === subscribeId && !subscribed) {
            subscribed = true;
            clearTimeout(timer);
            if (typeof ws.ping === "function") this.heartbeat = setInterval(() => {
              if (ws.readyState === 1) ws.ping();
            }, 3e4);
            this.onStatus?.("online");
            resolve(this);
          } else if ((message2.type === "message" || message2.type === "direct") && message2.data) {
            let data;
            try {
              data = await unseal(this.invite.secret, this.invite.room, message2.data);
            } catch {
              return;
            }
            if (data.to && data.to !== this.peerId) return;
            await this.onSignal?.(data, message2.from);
          } else if (message2.type === "error") {
            this.onStatus?.("error", message2.message || message2.code || "\u4FE1\u4EE4\u670D\u52A1\u62D2\u7EDD\u8FDE\u63A5");
            if (!subscribed) {
              clearTimeout(timer);
              reject(new Error(`\u4FE1\u4EE4\u670D\u52A1\u62D2\u7EDD\u8BA2\u9605\uFF08${message2.code || "permission_denied"}\uFF09\uFF0C\u8BF7\u68C0\u67E5 key \u7684\u623F\u95F4\u6743\u9650`));
              ws.close();
            }
          }
        } catch (error2) {
          this.onStatus?.("error", error2.message);
        }
      };
      ws.onerror = () => {
        if (!subscribed) {
          clearTimeout(timer);
          reject(new Error("\u65E0\u6CD5\u8FDE\u63A5\u4FE1\u4EE4\u670D\u52A1\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u548C publishable key"));
        }
      };
      ws.onclose = () => {
        clearTimeout(timer);
        clearInterval(this.heartbeat);
        if (!subscribed) reject(new Error("\u4FE1\u4EE4\u670D\u52A1\u8FDE\u63A5\u88AB\u5173\u95ED"));
        if (!this.closed) this.onStatus?.("offline");
      };
    });
  }
  write(message2) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(message2));
  }
  async send(data, to) {
    if (this.ws?.readyState !== 1) throw new Error("Signaling disconnected");
    const encrypted = await seal(this.invite.secret, this.invite.room, to ? { ...data, to } : data);
    this.write({ type: "publish", channel: this.invite.room, data: encrypted });
  }
  close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    this.ws?.close();
  }
};

// src/remote/turn.js
function validateIceServers(servers) {
  if (!Array.isArray(servers) || servers.length > 16) throw new Error("Invalid ICE server list");
  return servers.map((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    if (!urls.length || urls.length > 16 || urls.some((url) => typeof url !== "string" || url.length > 512 || !/^(stun|stuns|turn|turns):/.test(url))) throw new Error("Invalid ICE server URL");
    if (server.username && (typeof server.username !== "string" || server.username.length > 1024)) throw new Error("Invalid TURN username");
    if (server.credential && (typeof server.credential !== "string" || server.credential.length > 1024)) throw new Error("Invalid TURN credential");
    return { urls, ...server.username ? { username: server.username } : {}, ...server.credential ? { credential: server.credential } : {} };
  });
}
function turnTransports(servers) {
  const available = /* @__PURE__ */ new Set();
  for (const server of servers) for (const url of Array.isArray(server.urls) ? server.urls : [server.urls]) {
    if (url.startsWith("turns:")) available.add("tls");
    else if (url.startsWith("turn:")) available.add(url.includes("transport=tcp") ? "tcp" : "udp");
  }
  return ["tls", "tcp", "udp"].filter((value) => available.has(value));
}

// src/remote/client.js
var RemoteClient = class {
  constructor({ onStatus, onEvent, onDisconnect, relayOnly = false } = {}) {
    Object.assign(this, { onStatus, onEvent, onDisconnect, relayOnly });
    this.pending = /* @__PURE__ */ new Map();
  }
  async connect(token2) {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.turnAttempt = attempt;
      try {
        return await this.connectAttempt(token2);
      } catch (error2) {
        if (attempt + 1 >= (this.availableTurnTransports?.length || 1)) throw error2;
        this.onStatus?.("\u5F53\u524D\u7F51\u7EDC\u901A\u8DEF\u5931\u8D25\uFF0C\u6B63\u5728\u5C1D\u8BD5\u5176\u4ED6 TURN \u4F20\u8F93");
      }
    }
  }
  async connectAttempt(token2) {
    this.invite = typeof token2 === "string" ? decodeInvite(token2) : token2;
    this.connectionId = randomId();
    this.offerSent = false;
    this.answerHash = void 0;
    this.remoteReady = false;
    this.closed = false;
    this.onStatus?.("\u6B63\u5728\u8FDE\u63A5\u4FE1\u4EE4\u670D\u52A1");
    this.signal = new Signaling(this.invite, { onSignal: (data, from) => this.receiveSignal(data, from), onStatus: (status2, error2) => {
      if (status2 === "error") this.onStatus?.(error2);
    } });
    await this.signal.connect();
    let bootstrapTimer;
    const bootstrap = new Promise((resolve, reject) => {
      this.bootstrapResolve = resolve;
      this.bootstrapReject = reject;
      bootstrapTimer = setTimeout(() => reject(new Error("\u4E3B\u673A\u672A\u5E94\u7B54\uFF0C\u8BF7\u786E\u8BA4 cloco remote \u6B63\u5728\u8FD0\u884C")), 15e3);
    });
    try {
      await this.signal.send({ kind: "probe", connectionId: this.connectionId });
      const info = await bootstrap;
      this.availableTurnTransports = Array.isArray(info.turnTransports) ? info.turnTransports.filter((value) => ["tls", "tcp", "udp"].includes(value)) : [];
      this.selectedTurnTransport = this.availableTurnTransports[this.turnAttempt];
      this.hostPeerId = info.from;
      const iceServers = validateIceServers(info.iceServers || this.signal.iceServers);
      if (this.relayOnly && !turnTransports(iceServers).length) throw new Error("\u4E3B\u673A\u6CA1\u6709 TURN \u914D\u7F6E\uFF0C\u8BF7\u542F\u7528 Metered TURN \u81EA\u52A8\u4E0B\u53D1\uFF0C\u6216\u5728\u4E3B\u673A\u914D\u7F6E\u5176\u4ED6 TURN \u670D\u52A1");
      this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: this.relayOnly ? "relay" : "all" });
    } catch (error2) {
      this.disconnect();
      throw error2;
    } finally {
      clearTimeout(bootstrapTimer);
    }
    this.candidates = [];
    this.remoteCandidates = [];
    this.pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const data = { kind: "candidate", connectionId: this.connectionId, candidate: event.candidate.toJSON() };
      if (this.offerSent) this.signal.send(data, this.hostPeerId).catch(() => {
      });
      else this.candidates.push(data);
    };
    this.iceErrors = [];
    this.pc.onicecandidateerror = (event) => this.iceErrors.push({ code: event.errorCode, text: event.errorText });
    this.pc.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(this.pc.connectionState) && !this.closed) this.connectionLost();
      if (this.pc.connectionState === "disconnected") this.lostTimer = setTimeout(() => {
        if (this.pc.connectionState === "disconnected") this.connectionLost();
      }, 5e3);
      if (this.pc.connectionState === "connected") clearTimeout(this.lostTimer);
    };
    this.channel = this.pc.createDataChannel("cloco-v1", { ordered: true });
    this.channel.onmessage = (event) => this.receiveChannel(event.data).catch((error2) => {
      this.readyReject?.(error2);
      this.disconnect();
    });
    this.channel.onclose = () => {
      if (!this.closed) this.connectionLost();
    };
    const ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    ready.catch(() => {
    });
    this.readyTimer = setTimeout(() => {
      this.readyReject(new Error("\u4E3B\u673A\u8FDE\u63A5\u8D85\u65F6\uFF1A\u8BF7\u786E\u8BA4 cloco \u5728\u7EBF\uFF0C\u5E76\u68C0\u67E5 TURN \u914D\u7F6E"));
      this.disconnect();
    }, 3e4);
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.offerHash = await sha256(this.pc.localDescription.sdp);
      this.onStatus?.("\u7B49\u5F85\u4E3B\u673A\u5E94\u7B54");
      await this.signal.send({ kind: "offer", connectionId: this.connectionId, sdp: this.pc.localDescription.sdp, turnTransport: this.selectedTurnTransport }, this.hostPeerId);
      this.offerSent = true;
      for (const candidate of this.candidates.splice(0)) await this.signal.send(candidate, this.hostPeerId);
      const info = await ready;
      this.lastReceived = Date.now();
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastReceived > 15e3) {
          this.connectionLost();
          return;
        }
        sendChannel(this.channel, { type: "heartbeat" }).catch(() => this.connectionLost());
      }, 5e3);
      return info;
    } catch (error2) {
      this.disconnect();
      throw error2;
    }
  }
  async receiveSignal(data, from) {
    if (this.closed || data.connectionId !== this.connectionId) return;
    if (data.kind === "bootstrap") {
      if (data.error) this.bootstrapReject?.(new Error(data.error));
      else this.bootstrapResolve?.({ ...data, from });
      return;
    }
    if (data.kind === "answer" && !this.answerHash) {
      this.hostPeerId = from;
      this.answerHash = await sha256(data.sdp);
      await this.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      this.remoteReady = true;
      for (const candidate of this.remoteCandidates.splice(0)) await this.pc.addIceCandidate(candidate).catch(() => {
      });
      this.onStatus?.("\u6B63\u5728\u5EFA\u7ACB\u52A0\u5BC6\u8FDE\u63A5");
    } else if (data.kind === "candidate") {
      if (this.remoteCandidates.length > 64) return;
      if (this.remoteReady) await this.pc.addIceCandidate(data.candidate).catch(() => {
      });
      else this.remoteCandidates.push(data.candidate);
    }
  }
  async receiveChannel(text) {
    const message2 = parseMessage(text);
    this.lastReceived = Date.now();
    const generation = this.connectionId;
    if (message2.type === "heartbeat") return;
    if (message2.type === "closed" && message2.connectionId === generation) {
      this.connectionLost();
      return;
    }
    if ((message2.type === "challenge" || message2.type === "ready") && message2.connectionId !== generation) return;
    if (message2.type === "challenge") {
      const authText = `${VERSION}:${this.connectionId}:${message2.challenge}:${this.offerHash}:${this.answerHash}`;
      if (message2.v !== VERSION || !await verify(this.invite.secret, `host:${authText}`, message2.proof)) throw new Error("\u4E3B\u673A\u8EAB\u4EFD\u9A8C\u8BC1\u5931\u8D25");
      if (this.closed || generation !== this.connectionId) return;
      await sendChannel(this.channel, { type: "auth", proof: await sign(this.invite.secret, `client:${authText}`) });
    } else if (message2.type === "ready") {
      if (message2.v !== VERSION) throw new Error("\u5BA2\u6237\u7AEF\u4E0E\u4E3B\u673A\u534F\u8BAE\u7248\u672C\u4E0D\u4E00\u81F4");
      clearTimeout(this.readyTimer);
      this.ready = true;
      this.onStatus?.("\u5DF2\u8FDE\u63A5");
      this.readyResolve(message2);
    } else if (message2.type === "response") {
      const pending = this.pending.get(message2.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message2.id);
      if (message2.ok) pending.resolve(message2.result);
      else pending.reject(new Error(message2.error || "\u64CD\u4F5C\u5931\u8D25"));
    } else if (message2.type === "event") this.onEvent?.(message2);
  }
  async request(method, params = {}) {
    if (!this.ready || this.closed) throw new Error("\u8BF7\u5148\u8FDE\u63A5\u4E3B\u673A");
    const id = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("\u64CD\u4F5C\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8FDE\u540E\u67E5\u770B\u72B6\u6001\uFF0C\u52FF\u91CD\u590D\u63D0\u4EA4\u4EFB\u52A1"));
      }, 6e4);
      this.pending.set(id, { resolve, reject, timer });
      sendChannel(this.channel, { type: "request", id, method, params }).catch((error2) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error2);
      });
    });
  }
  async upload(file, onProgress, signal) {
    if (file.size > 50 * 1024 * 1024) throw new Error("\u9644\u4EF6\u4E0D\u80FD\u8D85\u8FC7 50 MB");
    signal?.throwIfAborted();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { id } = await this.request("upload.start", { name: file.name, size: bytes.length, mime: file.type || "application/octet-stream", sha256: await sha256(bytes) });
    try {
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        signal?.throwIfAborted();
        await this.request("upload.chunk", { id, offset, data: base64(bytes.subarray(offset, offset + CHUNK_BYTES)) });
        onProgress?.(Math.min(100, Math.round((offset + CHUNK_BYTES) / bytes.length * 100)));
      }
      return await this.request("upload.finish", { id });
    } catch (error2) {
      this.request("upload.cancel", { id }).catch(() => {
      });
      throw error2;
    }
  }
  async download(reference, mime = "application/octet-stream") {
    const info = await this.request("file.stat", { reference });
    const chunks = [];
    let offset = 0;
    while (offset < info.size) {
      const chunk = await this.request("file.chunk", { reference, offset });
      const bytes = unbase64(chunk.data);
      if (chunk.offset !== offset + bytes.length || chunk.size !== info.size || !bytes.length) throw new Error("\u4E0B\u8F7D\u6570\u636E\u4E0D\u5B8C\u6574");
      chunks.push(bytes);
      offset = chunk.offset;
    }
    return { blob: new Blob(chunks, { type: mime }), name: info.name };
  }
  async route() {
    if (!this.pc) return "";
    const stats = await this.pc.getStats();
    for (const row of stats.values()) if (row.type === "transport" && row.selectedCandidatePairId) {
      const pair = stats.get(row.selectedCandidatePairId);
      const local = stats.get(pair?.localCandidateId);
      const remote = stats.get(pair?.remoteCandidateId);
      return local?.candidateType === "relay" || remote?.candidateType === "relay" ? "TURN \u4E2D\u8F6C" : "\u76F4\u63A5\u8FDE\u63A5";
    }
    return "";
  }
  async diagnostics() {
    const stats = this.pc ? await this.pc.getStats() : /* @__PURE__ */ new Map();
    return {
      connection: this.pc?.connectionState,
      ice: this.pc?.iceConnectionState,
      channel: this.channel?.readyState,
      errors: this.iceErrors || [],
      candidates: [...stats.values()].filter((row) => row.type === "local-candidate" || row.type === "remote-candidate").map((row) => ({ type: row.type, candidateType: row.candidateType, protocol: row.protocol })),
      pairs: [...stats.values()].filter((row) => row.type === "candidate-pair").map((row) => ({ state: row.state, nominated: row.nominated, bytesSent: row.bytesSent, bytesReceived: row.bytesReceived }))
    };
  }
  connectionLost() {
    if (this.closed) return;
    const wasReady = this.ready;
    this.readyReject?.(new Error("\u8FDE\u63A5\u5DF2\u65AD\u5F00"));
    this.disconnect();
    if (wasReady) this.onDisconnect?.();
  }
  disconnect() {
    this.closed = true;
    this.ready = false;
    clearInterval(this.heartbeat);
    clearTimeout(this.readyTimer);
    clearTimeout(this.lostTimer);
    this.signal?.close();
    if (this.channel) this.channel.onclose = null;
    if (this.channel) this.channel.onmessage = null;
    if (this.pc) this.pc.onconnectionstatechange = null;
    if (this.pc) this.pc.onicecandidate = null;
    this.channel?.close();
    this.pc?.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("\u8FDE\u63A5\u5DF2\u65AD\u5F00"));
    }
    this.pending.clear();
  }
};

// web/remote/app.js
var $ = (id) => document.getElementById(id);
var client;
var token;
var sessionId;
var activeTask;
var uploading = false;
var reconnecting = false;
var recorder;
var stream;
var recordingTimer;
var historyOffset = 0;
var openingSession;
var sessionEvents = [];
var recordingRequest = 0;
var requestingMedia = false;
var pendingFiles = [];
var tasks = /* @__PURE__ */ new Map();
var objectUrls = /* @__PURE__ */ new Set();
function blobUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  return url;
}
function error(message2) {
  $("error").textContent = message2;
  $("error").hidden = !message2;
}
function status(text, connected = false) {
  $("connection-status").textContent = text;
  $("connection-status").classList.toggle("connected", connected);
}
function controls() {
  const connected = Boolean(client?.ready);
  for (const id of ["prompt", "add-file", "record-audio", "record-video"]) $(id).disabled = !connected || uploading;
  $("record-audio").disabled ||= requestingMedia;
  $("record-video").disabled ||= requestingMedia;
  $("send").disabled = !connected || Boolean(activeTask) || uploading || Boolean(recorder) || requestingMedia || Boolean(openingSession);
  $("cancel").hidden = !activeTask;
  $("cancel").disabled = !connected;
  $("session-panel").hidden = !connected;
  $("new-session").disabled = uploading || Boolean(activeTask) || Boolean(openingSession);
  $("sessions").disabled = uploading || Boolean(openingSession);
}
function scroll() {
  $("messages").scrollTop = $("messages").scrollHeight;
}
function content(element, text) {
  element.replaceChildren();
  const blocks = text.split(/```[^\n]*\n([\s\S]*?)```/g);
  blocks.forEach((block, index) => {
    if (index % 2) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = block;
      pre.append(code);
      element.append(pre);
    } else element.append(document.createTextNode(block));
  });
}
function message(role, text = "", taskId) {
  $("empty-state")?.remove();
  const article = document.createElement("article");
  article.className = `message ${role === "error" ? "error-message" : role}`;
  const header = document.createElement("div");
  header.className = "message-header";
  header.textContent = role === "user" ? "\u4F60" : role === "error" ? "\u6267\u884C\u5931\u8D25" : "cloco";
  const body = document.createElement("div");
  body.className = "message-content";
  content(body, text);
  const media = document.createElement("div");
  media.className = "output-attachments";
  article.append(header, body, media);
  $("messages").append(article);
  const entry = { article, body, media, text, details: null };
  if (taskId && role === "assistant") tasks.set(taskId, entry);
  scroll();
  return entry;
}
function mediaCard(blob, name, mime, remove) {
  const card = document.createElement("div");
  card.className = "attachment";
  const url = blobUrl(blob);
  if (mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/")) {
    const element = document.createElement(mime.startsWith("image/") ? "img" : mime.startsWith("audio/") ? "audio" : "video");
    element.src = url;
    if (element.tagName === "IMG") element.alt = name;
    else {
      element.controls = true;
      element.preload = "metadata";
      if (element.tagName === "VIDEO") element.playsInline = true;
    }
    card.append(element);
  }
  const label = document.createElement("div");
  label.className = "attachment-label";
  const link = document.createElement("a");
  link.textContent = name;
  link.href = url;
  link.download = name;
  label.append(link);
  if (remove) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "\u79FB\u9664";
    button.setAttribute("aria-label", `\u79FB\u9664 ${name}`);
    button.onclick = () => {
      remove();
      URL.revokeObjectURL(url);
      objectUrls.delete(url);
      card.remove();
    };
    label.append(button);
  }
  card.append(label);
  return card;
}
async function displayAttachment(entry, attachment) {
  try {
    const result = await client.download(attachment.id || attachment.reference || attachment.path, attachment.mime);
    entry.media.append(mediaCard(result.blob, attachment.name, attachment.mime));
    scroll();
  } catch (err) {
    const p = document.createElement("p");
    p.className = "notice";
    p.textContent = `${attachment.name}\uFF1A${err.message}`;
    entry.media.append(p);
  }
}
function addFiles(files) {
  for (const file of files) {
    if (pendingFiles.length >= 8) {
      error("\u6BCF\u6761\u6D88\u606F\u6700\u591A 8 \u4E2A\u9644\u4EF6");
      break;
    }
    if (file.size > 50 * 1024 * 1024 || file.size === 0) {
      error("\u9644\u4EF6\u4E0D\u80FD\u4E3A\u7A7A\u4E14\u4E0D\u80FD\u8D85\u8FC7 50 MB");
      continue;
    }
    pendingFiles.push(file);
    $("attachments").append(mediaCard(file, file.name, file.type, () => {
      const index = pendingFiles.indexOf(file);
      if (index >= 0) pendingFiles.splice(index, 1);
    }));
  }
}
async function openSession(id) {
  openingSession = id;
  sessionEvents = [];
  controls();
  try {
    const info = await client.request("session.open", { id });
    sessionId = id;
    localStorage.setItem(`cloco-session-${decodeInvite(token).room}`, id);
    $("conversation-name").textContent = info.name;
    $("sessions").value = id;
    $("messages").replaceChildren();
    tasks.clear();
    const history = await client.request("session.history");
    historyOffset = history.offset;
    $("load-history").hidden = historyOffset === 0;
    for (const row of history.items) {
      const entry = message(row.role, row.text || "", row.role === "assistant" ? row.taskId : void 0);
      for (const attachment of row.attachments || []) displayAttachment(entry, attachment);
      expandMessage(entry, row);
    }
    activeTask = history.active?.taskId || null;
    if (activeTask) {
      const entry = message("assistant", history.active.text, activeTask);
      for (const attachment of history.active.attachments || []) displayAttachment(entry, attachment);
    }
    const queued = sessionEvents;
    openingSession = null;
    sessionEvents = [];
    for (const event of queued) if (event.sequence > history.sequence) handleEvent(event);
    scroll();
  } finally {
    openingSession = null;
    sessionEvents = [];
    controls();
  }
}
function expandMessage(entry, row) {
  if (!row.truncated) return;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "\u67E5\u770B\u5B8C\u6574\u6D88\u606F";
  entry.article.append(button);
  const sourceSession = sessionId;
  button.onclick = async () => {
    button.disabled = true;
    try {
      let text = "", offset = 0, total = 1;
      while (offset < total) {
        if (sessionId !== sourceSession) return;
        const part = await client.request("session.message", { id: row.id, offset });
        if (part.offset !== offset || part.next < offset || part.next === offset && part.next < part.total) throw new Error("\u6D88\u606F\u6570\u636E\u4E0D\u5B8C\u6574");
        text += part.text;
        offset = part.next;
        total = part.total;
      }
      entry.text = text;
      content(entry.body, text);
      button.remove();
    } catch (err) {
      error(err.message);
      button.disabled = false;
    }
  };
}
async function refreshSessions() {
  const rows = await client.request("session.list");
  $("sessions").replaceChildren();
  for (const row of rows) {
    const option = document.createElement("option");
    option.value = row.id;
    option.textContent = row.name;
    $("sessions").append(option);
  }
  return rows;
}
function handleEvent(event) {
  if (openingSession) {
    if (event.sessionId === openingSession) sessionEvents.push(event);
    return;
  }
  if (event.sessionId !== sessionId) return;
  let entry = tasks.get(event.taskId);
  if (!entry) entry = message("assistant", "", event.taskId);
  if (event.kind === "progress") {
    const progress = event.progress;
    if (progress.type === "token") {
      entry.text += progress.content;
      entry.body.textContent = entry.text;
    } else if (["tool_start", "tool_complete", "thinking", "reasoning", "plan_progress"].includes(progress.type)) {
      if (!entry.details) {
        entry.details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "\u6267\u884C\u8FC7\u7A0B";
        entry.log = document.createElement("pre");
        entry.details.append(summary, entry.log);
        entry.article.append(entry.details);
      }
      const text = progress.type === "tool_start" ? `\u6267\u884C ${progress.tool}` : progress.type === "tool_complete" ? `${progress.success ? "\u5B8C\u6210" : "\u5931\u8D25"} ${progress.tool}
${JSON.stringify(progress.result)}` : progress.delta || JSON.stringify(progress.plan || "");
      entry.log.textContent = (entry.log.textContent + "\n" + text).slice(-3e4);
    }
  } else if (event.kind === "notice") {
    const p = document.createElement("p");
    p.className = "notice";
    p.textContent = event.text;
    entry.article.append(p);
  } else if (event.kind === "attachment") displayAttachment(entry, event.attachment);
  else if (event.kind === "result") {
    if (event.part === 0) entry.text = "";
    entry.text += event.text;
    content(entry.body, entry.text);
  } else if (event.kind === "done" || event.kind === "failed") {
    if (event.kind === "failed") {
      entry.text = event.text;
      content(entry.body, event.text);
      entry.article.classList.add("error-message");
    }
    if (activeTask === event.taskId) activeTask = null;
    controls();
  }
  scroll();
}
async function connect(value, restore = true) {
  client?.disconnect();
  token = value;
  client = new RemoteClient({ relayOnly: $("relay-only").checked, onStatus: (text) => status(text), onEvent: handleEvent, onDisconnect: () => {
    stopRecording();
    controls();
    reconnect();
  } });
  const info = await client.connect(token);
  status(`\u5DF2\u8FDE\u63A5 \xB7 ${await client.route() || "WebRTC"}`, true);
  $("project").textContent = `\u9879\u76EE\uFF1A${info.project}`;
  $("project").hidden = false;
  $("sidebar").classList.add("connected");
  $("sidebar").classList.remove("expanded");
  $("connection-settings-toggle").hidden = false;
  $("connect").hidden = true;
  $("disconnect").hidden = false;
  $("token").disabled = true;
  const sessions = await refreshSessions();
  const stored = restore ? localStorage.getItem(`cloco-session-${decodeInvite(token).room}`) : null;
  let selected = sessions.find((row) => row.id === stored) || sessions[0];
  if (!selected) {
    selected = await client.request("session.create", { name: "\u8FDC\u7A0B\u4F1A\u8BDD" });
    await refreshSessions();
  }
  await openSession(selected.id);
  controls();
  $("prompt").focus();
}
async function reconnect() {
  if (reconnecting || !token) return;
  reconnecting = true;
  for (let attempt = 0; attempt < 5 && token; attempt++) {
    status(`\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u6B63\u5728\u91CD\u8FDE\uFF08${attempt + 1}/5\uFF09`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(1e3 * 2 ** attempt, 1e4)));
    if (!token) break;
    try {
      await connect(token);
      error("");
      reconnecting = false;
      return;
    } catch (err) {
      error(err.message);
    }
  }
  reconnecting = false;
  if (token) status("\u91CD\u8FDE\u5931\u8D25\uFF0C\u8BF7\u786E\u8BA4\u4E3B\u673A\u5728\u7EBF\u540E\u91CD\u65B0\u8FDE\u63A5");
}
$("connect-form").onsubmit = async (event) => {
  event.preventDefault();
  error("");
  $("connect").disabled = true;
  try {
    await connect($("token").value);
  } catch (err) {
    error(err.message);
    status("\u8FDE\u63A5\u5931\u8D25");
    client?.disconnect();
    controls();
  } finally {
    $("connect").disabled = false;
  }
};
$("disconnect").onclick = () => {
  token = null;
  client?.disconnect();
  stopRecording(true);
  activeTask = null;
  controls();
  status("\u5DF2\u65AD\u5F00");
  $("connect").hidden = false;
  $("disconnect").hidden = true;
  $("token").disabled = false;
  $("sidebar").classList.remove("connected");
  $("connection-settings-toggle").hidden = true;
};
$("connection-settings-toggle").onclick = () => $("sidebar").classList.toggle("expanded");
$("sessions").onchange = () => openSession($("sessions").value).catch((err) => error(err.message));
$("new-session").onclick = async () => {
  try {
    const info = await client.request("session.create", { name: `\u4F1A\u8BDD ${(/* @__PURE__ */ new Date()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` });
    await refreshSessions();
    await openSession(info.id);
  } catch (err) {
    error(err.message);
  }
};
$("load-history").onclick = async () => {
  try {
    const offset = Math.max(0, historyOffset - 5);
    const first = $("messages").firstChild;
    let cursor = offset;
    while (cursor < historyOffset) {
      const history = await client.request("session.history", { offset: cursor });
      if (history.next <= cursor) throw new Error("\u5386\u53F2\u6D88\u606F\u8FC7\u5927\uFF0C\u65E0\u6CD5\u52A0\u8F7D");
      for (const row of history.items.slice(0, historyOffset - cursor)) {
        const entry = message(row.role, row.text || "");
        $("messages").insertBefore(entry.article, first);
        for (const attachment of row.attachments || []) displayAttachment(entry, attachment);
        expandMessage(entry, row);
      }
      cursor = history.next;
    }
    historyOffset = offset;
    $("load-history").hidden = !offset;
  } catch (err) {
    error(err.message);
  }
};
$("composer").onsubmit = async (event) => {
  event.preventDefault();
  if (!client?.ready || activeTask || uploading || recorder) return;
  const text = $("prompt").value.trim();
  if (!text && !pendingFiles.length) return;
  error("");
  uploading = true;
  controls();
  try {
    const attachments = [];
    for (const file of pendingFiles) attachments.push(await client.upload(file, (progress) => {
      $("upload-status").textContent = `\u4E0A\u4F20 ${file.name} ${progress}%`;
    }));
    const taskId = randomId();
    activeTask = taskId;
    const entry = message("user", text);
    for (let index = 0; index < attachments.length; index++) entry.media.append(mediaCard(pendingFiles[index], attachments[index].name, attachments[index].mime));
    message("assistant", "", taskId);
    await client.request("message.send", { text, taskId, attachments: attachments.map((item) => item.id) });
    pendingFiles.length = 0;
    $("attachments").replaceChildren();
    $("prompt").value = "";
  } catch (err) {
    activeTask = null;
    error(err.message);
  } finally {
    uploading = false;
    $("upload-status").textContent = "";
    controls();
  }
};
$("prompt").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
};
$("cancel").onclick = () => client.request("message.cancel", { taskId: activeTask }).catch((err) => error(err.message));
$("add-file").onclick = () => $("file").click();
$("file").onchange = () => {
  addFiles($("file").files);
  $("file").value = "";
};
$("prompt").addEventListener("paste", (event) => {
  const files = [...event.clipboardData.items].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
  if (files.length) {
    event.preventDefault();
    addFiles(files);
  }
});
async function startRecording(video) {
  if (recorder || requestingMedia || !client?.ready) return;
  const request = ++recordingRequest;
  requestingMedia = true;
  controls();
  error("");
  try {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) throw new Error("\u6B64\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u5F55\u5236\uFF0C\u8BF7\u4E0A\u4F20\u5DF2\u6709\u97F3\u89C6\u9891\u6587\u4EF6\uFF1B\u7F51\u9875\u9700\u8981 HTTPS");
    const media = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    if (request !== recordingRequest || !client?.ready) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = media;
    const types = video ? ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"] : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    const mimeType = types.find((type) => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    const instance = recorder, chunks = [];
    let size = 0;
    instance.ondataavailable = (event) => {
      if (event.data.size) {
        chunks.push(event.data);
        size += event.data.size;
        if (size > 45 * 1024 * 1024) stopRecording();
      }
    };
    instance.onstop = () => {
      if (!instance.discard && chunks.length) {
        const mime = instance.mimeType || (video ? "video/webm" : "audio/webm");
        const extension = mime.includes("mp4") ? "mp4" : "webm";
        addFiles([new File(chunks, `${video ? "\u89C6\u9891" : "\u5F55\u97F3"}-${Date.now()}.${extension}`, { type: mime })]);
      }
      controls();
    };
    instance.onerror = () => {
      error("\u5F55\u5236\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u6216\u4E0A\u4F20\u6587\u4EF6");
      stopRecording(true);
    };
    if (video) {
      $("camera-preview").srcObject = stream;
      $("camera-preview").hidden = false;
    }
    instance.start(1e3);
    $("stop-recording").hidden = false;
    $("record-audio").hidden = true;
    $("record-video").hidden = true;
    recordingTimer = setTimeout(() => stopRecording(), 12e4);
    controls();
  } catch (err) {
    if (request === recordingRequest) {
      stopRecording(true);
      error(`\u65E0\u6CD5\u5F55\u5236\uFF1A${err.message}`);
    }
  } finally {
    if (request === recordingRequest) requestingMedia = false;
    controls();
  }
}
function stopRecording(discard = false) {
  recordingRequest++;
  requestingMedia = false;
  clearTimeout(recordingTimer);
  if (recorder) {
    recorder.discard = discard;
    if (recorder.state !== "inactive") recorder.stop();
    recorder = null;
  }
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  $("camera-preview").srcObject = null;
  $("camera-preview").hidden = true;
  $("stop-recording").hidden = true;
  $("record-audio").hidden = false;
  $("record-video").hidden = false;
  controls();
}
$("record-audio").onclick = () => startRecording(false);
$("record-video").onclick = () => startRecording(true);
$("stop-recording").onclick = () => stopRecording();
window.addEventListener("pagehide", () => {
  token = null;
  client?.disconnect();
  stopRecording(true);
  for (const url of objectUrls) URL.revokeObjectURL(url);
});
window.clocoRemote = { get state() {
  return { connected: Boolean(client?.ready), sessionId, activeTask, recording: Boolean(recorder) };
}, diagnostics: () => client?.diagnostics() };
