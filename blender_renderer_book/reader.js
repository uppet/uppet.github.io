/* Local-file reader. No fetch, package runtime, remote font, or server required. */
(() => {
  'use strict';
  const book = window.BOOK;
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeStore = {
    read(key, fallback) {try {return JSON.parse(localStorage.getItem('astra-book-' + key)) ?? fallback;} catch {return fallback;}},
    write(key, value) {try {localStorage.setItem('astra-book-' + key, JSON.stringify(value));} catch {}}
  };
  let current = null, currentSource = null, toastTimer, scrollTimer;
  const completed = new Set(safeStore.read('completed', []));
  let fontSize = safeStore.read('font-size', innerWidth < 560 ? 17 : 18);
  document.documentElement.style.setProperty('--reader-size', fontSize + 'px');
  document.documentElement.dataset.theme = safeStore.read('theme', 'light');

  function toast(message) {
    $('#toast').textContent = message;
    $('#toast').classList.add('visible');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2200);
  }

  function highlight(code, language='python') {
    if (!['python','py','cpp','c++','javascript','js'].includes(language)) return escape(code);
    const pattern = /(#[^\n]*|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\b(?:def|class|import|from|return|if|else|elif|for|while|in|not|and|or|with|as|try|except|finally|raise|assert|yield|True|False|None|pass|continue|break|lambda|const|let|function|void|float|double|int|struct|auto|public|private|namespace|include)\b|\b\d+(?:\.\d+)?(?:e[-+]?\d+)?\b)/g;
    let output = '', at = 0;
    for (const match of code.matchAll(pattern)) {
      output += escape(code.slice(at, match.index));
      const token = match[0];
      const kind = token.startsWith('#') || token.startsWith('//') ? 'comment' : /^["']/.test(token) ? 'string' : /^\d/.test(token) ? 'number' : 'keyword';
      output += `<span class="syntax-${kind}">${escape(token)}</span>`;
      at = match.index + token.length;
    }
    return output + escape(code.slice(at));
  }

  async function copy(text) {
    try {await navigator.clipboard.writeText(text); toast('已复制'); return;} catch {}
    const input = document.createElement('textarea'); input.value = text;
    input.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.append(input); input.select();
    const ok = document.execCommand('copy'); input.remove();
    toast(ok ? '已复制' : '浏览器未允许复制，请选中文本后复制');
  }

  function nav() {
    let part = '';
    $('#book-nav').innerHTML = book.chapters.map(chapter => {
      const heading = chapter.part !== part ? `<div class="nav-part">${escape(chapter.part)}</div>` : '';
      part = chapter.part;
      return heading + `<a class="chapter-link${completed.has(chapter.id) ? ' read' : ''}" data-chapter="${chapter.id}" href="#ch/${chapter.id}"><span class="number">${chapter.number}</span><span>${escape(chapter.title)}</span></a>`;
    }).join('');
    $('#completion-count').textContent = `${completed.size} / ${book.chapters.length} 已读`;
  }

  function syncNav(id) {
    document.querySelectorAll('.chapter-link').forEach(item => {
      const active = item.dataset.chapter === id;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    });
  }

  function stats() {
    document.querySelectorAll('[data-metrics]').forEach(element => {
      const r = book.reports.render;
      element.innerHTML = `<div class="metric"><b>1440 × 1080</b><span>原始图像 / PNG</span></div><div class="metric"><b>${r.core_seconds.toFixed(3)} s</b><span>Astra 引擎回调</span></div><div class="metric"><b>${r.triangles.toLocaleString()}</b><span>求值并展开后的三角形</span></div>`;
    });
  }

  function artifacts() {
    document.querySelectorAll('[data-archive]').forEach(element => {
      const cards = [
        ['output/astra_press.png','Astra Press 原始成图','1440 × 1080 · PNG'],
        ['output/cycles_reference.png','Cycles 对照图','相同场景与相机 · 32 samples + 降噪'],
        ['output/quiet_objects.blend','可编辑的三维场景','相机、光源、材质与内嵌预览图'],
        ['astra_press.zip','Blender 插件安装包','Astra Press 0.1.0'],
        ['output/checks/reopened_scene.png','独立进程重新出图','从 ZIP 加载 · 320 × 240'],
      ];
      let html = `<div class="artifact-grid"><a class="artifact-card" href="astra-press-project.zip" download><strong>下载完整项目快照 ↓</strong><small>${Object.keys(book.files).length} 个原始文件，包括全部源码、图片、场景和报告</small></a>`;
      html += cards.map(([path, title, caption]) => `<a class="artifact-card" href="project/${path}" ${path.endsWith('.png') ? 'target="_blank"' : 'download'}>${path.endsWith('.png') ? `<img loading="lazy" src="project/${path}" alt="${escape(title)}">` : ''}<strong>${escape(title)}</strong><small>${escape(caption)}</small></a>`).join('') + '</div>';
      html += '<div class="table-scroll"><table><thead><tr><th>文件 / 点击源码可逐行阅读</th><th>大小</th><th>SHA-256</th></tr></thead><tbody>';
      html += Object.values(book.files).map(file => `<tr><td><a href="${file.kind === 'text' ? '#source/' + file.path : file.href}">${escape(file.path)}</a></td><td>${formatBytes(file.size)}</td><td class="hash">${file.sha256}</td></tr>`).join('');
      element.innerHTML = html + '</tbody></table></div>';
    });
  }

  function formatBytes(bytes) {return bytes >= 1048576 ? (bytes / 1048576).toFixed(2) + ' MiB' : (bytes / 1024).toFixed(1) + ' KiB';}

  function decorateCode() {
    document.querySelectorAll('.code-card').forEach(card => {
      const code = card.querySelector('pre code'); if (!code) return;
      const raw = code.textContent;
      code.innerHTML = highlight(raw, code.className.replace('language-', ''));
      const button = document.createElement('button'); button.className = 'copy-code'; button.textContent = '复制';
      button.setAttribute('aria-label', '复制这段代码'); button.addEventListener('click', () => copy(raw)); card.append(button);
    });
  }

  function chapterFooter(chapter) {
    const index = book.chapters.indexOf(chapter);
    const item = (c, direction) => c ? `<a href="#ch/${c.id}"><small>${direction}</small>${escape(c.title)}</a>` : '<span></span>';
    return `<div class="chapter-footer"><button class="read-toggle${completed.has(chapter.id) ? ' done' : ''}" id="read-toggle">${completed.has(chapter.id) ? '✓ 已读 · 再次点击取消' : '✓ 标记本章已读'}</button><div class="chapter-pagination">${item(book.chapters[index-1], '← 上一章')}${item(book.chapters[index+1], '下一章 →')}</div></div>`;
  }

  function showChapter(id, anchor) {
    const chapter = book.chapters.find(c => c.id === id) || book.chapters[0];
    if (current !== chapter.id || currentSource) {
      window.BookLabs?.dispose();
      current = chapter.id; currentSource = null;
      document.body.classList.toggle('opening', chapter.number === '00');
      $('#article-layout').classList.remove('source-layout');
      $('#chapter-toc').hidden = false;
      $('#article').innerHTML = `<header><div class="chapter-kicker">${escape(chapter.part)} / ${chapter.number}</div><h1>${escape(chapter.title)}</h1><div class="chapter-subtitle">${escape(chapter.subtitle)}</div><div class="chapter-meta"><span>约 ${chapter.minutes} 分钟 · 含实验与练习</span><span>Blender 4.5.1 LTS</span><span>第 ${Number(chapter.number)+1} / ${book.chapters.length} 章</span></div></header>${chapter.html}${chapterFooter(chapter)}`;
      $('#breadcrumb').textContent = chapter.part;
      $('#chapter-toc').innerHTML = '<h2>本章索引</h2>' + chapter.toc.map(h => `<a class="${h.level === 3 ? 'sub' : ''}" href="#ch/${chapter.id}/${h.id}">${escape(h.title)}</a>`).join('') + '<div class="toc-note">代码片段直接摘自项目快照。点击片段标题，可跳到完整源码。</div>';
      $('#read-toggle').addEventListener('click', () => {
        completed.has(current) ? completed.delete(current) : completed.add(current);
        safeStore.write('completed', [...completed]);
        const button = $('#read-toggle'); button.classList.toggle('done', completed.has(current));
        button.textContent = completed.has(current) ? '✓ 已读 · 再次点击取消' : '✓ 标记本章已读';
        nav(); syncNav(current);
      });
      stats(); artifacts(); decorateCode(); window.BookLabs?.mount($('#article'));
      document.title = chapter.title + ' · 自己写一个 Blender 渲染器';
      safeStore.write('last-chapter', chapter.id);
      syncNav(chapter.id);
      window.scrollTo({top: 0, behavior: 'instant'});
    }
    if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({block:'start', behavior:'instant'}));
    updateProgress();
  }

  function showSource(spec) {
    const match = spec.match(/^(.*?)(?::(\d+))?$/);
    const path = match[1], line = Number(match[2] || 1), file = book.files[path];
    if (!file || file.kind !== 'text') {toast('没有找到这个源码文件'); showChapter('25-archive'); return;}
    if (currentSource !== path) {
      window.BookLabs?.dispose(); currentSource = path; current = null;
      document.body.classList.remove('opening'); $('#article-layout').classList.add('source-layout'); $('#chapter-toc').hidden = true;
      const options = Object.values(book.files).filter(f => f.kind === 'text').map(f => `<option value="${escape(f.path)}"${f.path === path ? ' selected' : ''}>${escape(f.path)}</option>`).join('');
      const language = path.endsWith('.py') ? 'python' : 'text';
      const lines = (file.text.endsWith('\n') ? file.text.slice(0,-1) : file.text).split('\n');
      $('#article').innerHTML = `<header class="source-head"><div class="chapter-kicker">项目快照 / 完整源码</div><h1>${escape(path.split('/').at(-1))}</h1><p class="source-intro">${escape(path)} · ${lines.length} 行 · ${formatBytes(file.size)}<br><span class="hash">SHA-256 ${file.sha256}</span></p><div class="source-actions"><select id="source-select" aria-label="选择源码文件">${options}</select><button id="copy-source">复制全文</button><a href="${file.href}" download="${escape(path.split('/').at(-1))}">下载原文件 ↓</a><a href="#ch/25-archive">返回档案馆</a></div></header><div class="source-code">${lines.map((text,index) => `<div class="source-line" id="source-line-${index+1}"><a class="line-number" href="#source/${escape(path)}:${index+1}" aria-label="第 ${index+1} 行">${index+1}</a><code>${highlight(text,language) || ' '}</code></div>`).join('')}</div>`;
      $('#source-select').addEventListener('change', e => {location.hash = '#source/' + e.target.value;});
      $('#copy-source').addEventListener('click', () => copy(file.text));
      $('#breadcrumb').textContent = '源码档案 / ' + path;
      document.title = path + ' · Astra Press 源码'; syncNav('25-archive');
    }
    document.querySelectorAll('.source-line.selected').forEach(el => el.classList.remove('selected'));
    const selected = $('#source-line-' + line); selected?.classList.add('selected');
    requestAnimationFrame(() => {if (line > 1) selected?.scrollIntoView({block:'center',behavior:'instant'}); else window.scrollTo({top:0,behavior:'instant'}); updateProgress();});
  }

  function route() {
    let hash;
    try {hash = decodeURIComponent(location.hash.slice(1));} catch {hash = '';}
    if (hash.startsWith('source/')) showSource(hash.slice(7));
    else {const [, id, anchor] = hash.split('/'); showChapter(id || '00-opening', anchor);}
    closeMenu();
  }

  function updateProgress() {
    const max = document.documentElement.scrollHeight - innerHeight;
    const progress = max > 0 ? scrollY / max : 0;
    const offset = innerWidth > 900 ? parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) : 0;
    $('#scroll-progress').style.width = `${Math.max(0, Math.min(1, progress)) * (innerWidth - offset)}px`;
    if (current) {
      const chapter = book.chapters.find(c => c.id === current);
      let active = chapter?.toc[0]?.id;
      chapter?.toc.forEach(h => {if ((document.getElementById(h.id)?.getBoundingClientRect().top ?? Infinity) < 155) active = h.id;});
      document.querySelectorAll('#chapter-toc a').forEach(a => a.classList.toggle('active', a.hash.endsWith('/' + active)));
    }
  }

  function search(query) {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const results = [];
    for (const chapter of book.chapters) {
      const text = chapter.title + ' ' + chapter.subtitle + ' ' + chapter.plain;
      const lower = text.toLowerCase();
      if (!terms.every(term => lower.includes(term))) continue;
      const at = lower.indexOf(terms[0]);
      results.push({kind:'章节 ' + chapter.number, title:chapter.title, text:text.slice(Math.max(0,at-35),at+135).replace(/\s+/g,' '), href:'#ch/'+chapter.id, score:terms.filter(t => chapter.title.toLowerCase().includes(t)).length+1});
    }
    for (const file of Object.values(book.files)) {
      if (file.kind !== 'text') continue;
      const text = file.path + '\n' + file.text;
      if (!terms.every(term => text.toLowerCase().includes(term))) continue;
      const at = file.text.toLowerCase().indexOf(terms[0]);
      const line = at >= 0 ? file.text.slice(0,at).split('\n').length : 1;
      results.push({kind:'源码 · L'+line,title:file.path,text:file.text.slice(Math.max(0,at-25),Math.max(0,at)+125).replace(/\s+/g,' '),href:'#source/'+file.path+':'+line,score:0});
    }
    return results.sort((a,b) => b.score-a.score).slice(0,40);
  }

  function runSearch() {
    const query = $('#search-input').value, results = search(query);
    $('#search-summary').textContent = query.trim() ? `${results.length} 条结果 · 搜索本地章节与源码` : '输入中文概念或函数名；也可以输入多个关键词。';
    $('#search-results').innerHTML = results.map(r => `<a class="search-result" href="${escape(r.href)}"><small>${escape(r.kind)}</small><strong>${escape(r.title)}</strong><p>${escape(r.text)}</p></a>`).join('') || (query.trim() ? '<p>没有找到结果。试试“法线”“阴影”或“register”。</p>' : '');
    document.querySelectorAll('.search-result').forEach(a => a.addEventListener('click', () => $('#search-dialog').close()));
  }

  function openSearch() {if (!$('#search-dialog').open) $('#search-dialog').showModal(); runSearch(); $('#search-input').focus();}
  function closeMenu() {document.body.classList.remove('menu-open'); $('#scrim').hidden=true; $('#menu-toggle').setAttribute('aria-expanded','false');}
  $('#search-open').addEventListener('click', openSearch);
  $('#search-close').addEventListener('click', () => $('#search-dialog').close());
  $('#search-input').addEventListener('input', runSearch);
  $('#search-dialog').addEventListener('click', e => {if (e.target === e.currentTarget) {const r=e.target.getBoundingClientRect(); if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
  $('#menu-toggle').addEventListener('click', () => {const open=document.body.classList.toggle('menu-open'); $('#scrim').hidden=!open; $('#menu-toggle').setAttribute('aria-expanded',String(open));});
  $('#scrim').addEventListener('click',closeMenu);
  $('#book-nav').addEventListener('click', e => {if(e.target.closest('a'))closeMenu();});
  $('.skip-link').addEventListener('click', e => {e.preventDefault();$('#reading').focus();$('#reading').scrollIntoView({behavior:'instant'});});
  $('#theme-toggle').addEventListener('click', () => {const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;safeStore.write('theme',next);});
  $('#font-minus').addEventListener('click', () => {fontSize=Math.max(15,fontSize-1);document.documentElement.style.setProperty('--reader-size',fontSize+'px');safeStore.write('font-size',fontSize);});
  $('#font-plus').addEventListener('click', () => {fontSize=Math.min(23,fontSize+1);document.documentElement.style.setProperty('--reader-size',fontSize+'px');safeStore.write('font-size',fontSize);});
  $('#print').addEventListener('click', () => window.print());
  document.addEventListener('keydown', e => {
    const typing=/INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
    if ((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k' || e.key==='/'&&!typing) {e.preventDefault();openSearch();}
    if(e.key==='Escape')closeMenu();
  });
  addEventListener('hashchange',route);
  addEventListener('resize',updateProgress);
  addEventListener('scroll',() => {clearTimeout(scrollTimer);scrollTimer=setTimeout(updateProgress,40);},{passive:true});
  nav(); route();
  window.BookReader={search,route,copy,getState:()=>({chapter:current,source:currentSource,completed:[...completed],fontSize,theme:document.documentElement.dataset.theme})};
})();
