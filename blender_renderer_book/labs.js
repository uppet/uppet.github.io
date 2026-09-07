/* Small, offline teaching models. The Blender render images are kept as assets;
   these browser models illustrate selected formulas, not a second full engine. */
(() => {
  'use strict';
  const palette = {paper:'#f3eee0', ink:'#29433e', clay:'#cf6c50', teal:'#47857d', gold:'#dba848', faint:'#d6d4c5', muted:'#727a6b'};
  let lifetime = new AbortController();
  const clamp = (v, low=0, high=1) => Math.max(low, Math.min(high, v));
  const mix = (a,b,t) => a.map((v,i) => v*(1-t)+b[i]*t);
  const enc = v => v <= .0031308 ? 12.92*v : 1.055*v**(1/2.4)-.055;
  const dec = v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4;
  const rgb = values => `rgb(${values.map(v=>Math.round(clamp(v)*255)).join(',')})`;
  const on = (el, event, callback) => el.addEventListener(event,callback,{signal:lifetime.signal});
  const controls = el => el.querySelector('.lab-controls');
  const val = (el,key) => Number(el.querySelector(`[data-control="${key}"]`).value);

  function frame(el,title,description,canvas=true) {
    el.innerHTML = `<div class="lab-header"><h3>${title}</h3><span class="lab-label">INTERACTIVE / 动手试试</span></div>${canvas?'<canvas width="720" height="340" role="img"></canvas>':''}<div class="lab-controls"></div><div class="lab-output" role="status" aria-live="polite"></div><p class="lab-description">${description}</p>`;
    const c=el.querySelector('canvas');
    if(c)c.setAttribute('aria-label',title+'；数值结果见下方文字。');
    return c?.getContext('2d');
  }
  function slider(el,key,label,min,max,value,step=1,format=v=>String(v)) {
    const labelEl=document.createElement('label');
    labelEl.innerHTML=`<span>${label}<output>${format(value)}</output></span><input data-control="${key}" type="range" min="${min}" max="${max}" value="${value}" step="${step}" aria-label="${label}">`;
    controls(el).append(labelEl);
    on(labelEl.querySelector('input'),'input',e=>labelEl.querySelector('output').textContent=format(Number(e.target.value)));
  }
  function select(el,key,label,options,value) {
    const node=document.createElement('label');
    node.innerHTML=`<span>${label}</span><select data-control="${key}" aria-label="${label}">${options.map(([v,t])=>`<option value="${v}"${v===value?' selected':''}>${t}</option>`).join('')}</select>`;
    controls(el).append(node);
  }
  function button(el,key,label,callback) {
    const node=document.createElement('button');node.type='button';node.dataset.control=key;node.textContent=label;controls(el).append(node);on(node,'click',()=>callback(node));return node;
  }
  function output(el,text,state) {el.querySelector('.lab-output').textContent=text;el.dataset.state=JSON.stringify(state??{});}
  function reactive(el,draw) {on(controls(el),'input',draw);on(controls(el),'change',draw);draw();el.dataset.ready='true';}
  function clear(ctx) {ctx.fillStyle=palette.paper;ctx.fillRect(0,0,ctx.canvas.width,ctx.canvas.height);ctx.lineWidth=1;ctx.setLineDash([]);}
  function line(ctx,a,b,color=palette.ink,width=1) {ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();}
  function label(ctx,text,x,y,color=palette.ink,size=14,align='left') {ctx.fillStyle=color;ctx.font=`${size}px "Microsoft YaHei","Segoe UI",sans-serif`;ctx.textAlign=align;ctx.fillText(text,x,y);ctx.textAlign='left';}
  function poly(ctx,points,fill,stroke=palette.ink,width=2) {if(!points.length)return;ctx.beginPath();ctx.moveTo(...points[0]);points.slice(1).forEach(p=>ctx.lineTo(...p));ctx.closePath();if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.stroke();}}
  function dot(ctx,x,y,color=palette.clay,r=5) {ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
  function eventPoint(event,canvas) {const r=canvas.getBoundingClientRect();return [(event.clientX-r.left)*canvas.width/r.width,(event.clientY-r.top)*canvas.height/r.height];}

  function pipeline(el) {
    frame(el,'一帧经过的六个站点','点击一个阶段，查看它消费和产生的数据。源码链接打开的是书内完整快照。',false);
    const stages=[
      ['01 / 宿主','Blender 场景','相机、网格、修改器、材质、Sun 和 Scene 属性由 Blender 保存并求值。','render_demo.py'],
      ['02 / 适配','导出三角形','export_geometry 遍历求值实例，输出世界位置、角法线、颜料与标志。','astra_press/__init__.py'],
      ['03 / 几何','裁剪与覆盖','clip_triangle 保留视锥内几何，fragments 找到像素中心与校正权重。','astra_press/core.py:58'],
      ['04 / 可见性','深度与阴影','主 G-buffer 保存相机看到的表面；第二次深度光栅化保存光源看到的表面。','astra_press/core.py:120'],
      ['05 / 视觉','颜料与墨线','shade 混合离散明暗、轮廓、排线与纸粒，最终转换回线性 RGB。','astra_press/core.py:228'],
      ['06 / 交付','RenderResult','Combined 接收 RGBA；演示让 Blender 保存 PNG，再验证、打包和保存场景。','astra_press/__init__.py:120']
    ];
    const nodes=document.createElement('div');nodes.className='pipeline-nodes';
    nodes.innerHTML=stages.map((s,i)=>`<button type="button" data-stage="${i}" aria-pressed="false"><small>${s[0]}</small>${s[1]}</button>`).join('');
    el.querySelector('.lab-header').after(nodes);
    const detail=document.createElement('div');detail.className='pipeline-detail';nodes.after(detail);
    function draw(index) {
      nodes.querySelectorAll('button').forEach((b,i)=>{b.classList.toggle('active',i===index);b.setAttribute('aria-pressed',String(i===index));});
      const s=stages[index];detail.innerHTML=`<strong>${s[1]}</strong><br>${s[2]}<br><a href="#source/${s[3]}">阅读这一层的源码 ↗</a>`;
      output(el,`当前阶段 ${index+1} / 6 · Python 负责适配，NumPy 核心负责计算。`,{stage:index});
    }
    on(nodes,'click',e=>{const b=e.target.closest('button');if(b)draw(Number(b.dataset.stage));});draw(0);el.dataset.ready='true';
  }

  function camera(el) {
    const ctx=frame(el,'距离、焦距与投影','左侧是简化光路，右侧是投影结果。真实 Blender 相机矩阵还处理传感器适配与像素宽高比。');
    slider(el,'distance','物体距离',2,8,4,.1,v=>v.toFixed(1));
    slider(el,'focal','焦距比例',.6,1.6,1,.05,v=>v.toFixed(2));
    select(el,'mode','投影类型',[['persp','透视 / 近大远小'],['ortho','正交 / 尺寸不随距离改变']],'persp');
    function draw() {
      clear(ctx);const d=val(el,'distance'),f=val(el,'focal'),ortho=el.querySelector('[data-control=mode]').value==='ortho';
      label(ctx,'光路示意',28,32);label(ctx,'成像平面',401,32);
      line(ctx,[366,20],[366,315],palette.faint);line(ctx,[32,170],[337,170],palette.faint);
      const pin=[89,170],objX=89+d*29,half=54,imageX=89-46*f,halfImage=ortho?half:half*46*f/(objX-pin[0]);
      line(ctx,[objX,170-half],[objX,170+half],palette.clay,6);
      if(ortho){line(ctx,[imageX,170-half],[objX,170-half],palette.teal);line(ctx,[imageX,170+half],[objX,170+half],palette.teal);}
      else{line(ctx,[imageX,170+halfImage],[objX,170-half],palette.teal);line(ctx,[imageX,170-halfImage],[objX,170+half],palette.teal);dot(ctx,...pin,palette.ink);}
      line(ctx,[imageX,170-halfImage],[imageX,170+halfImage],palette.gold,5);
      label(ctx,'像',imageX-6,251);label(ctx,'物体',objX-14,251);label(ctx,ortho?'平行投影':'针孔',70,288,palette.muted,12);
      const cx=542,cy=183,span=ortho?72:288*f/d;
      ctx.strokeStyle=palette.faint;ctx.strokeRect(390,52,305,245);
      for(let i=-2;i<=2;i++){line(ctx,[cx+i*45,52],[cx+i*45,297],palette.faint);line(ctx,[390,cy+i*45],[695,cy+i*45],palette.faint);}
      const back=[[-.8,-.8,.5],[.8,-.8,.5],[.8,.8,.5],[-.8,.8,.5]].map(([x,y,z])=>[cx+(x+.28)*(ortho?72:288*f/(d+z)),cy+(y-.24)*(ortho?72:288*f/(d+z))]);
      const front=[[-.8,-.8],[.8,-.8],[.8,.8],[-.8,.8]].map(([x,y])=>[cx+x*span,cy+y*span]);
      poly(ctx,back,'#e4d8b5',palette.muted);for(let i=0;i<4;i++)line(ctx,front[i],back[i],palette.ink);
      poly(ctx,front,'#cf6c50cc',palette.clay,2);
      label(ctx,ortho?'正交投影':'透视投影',cx,323,palette.ink,14,'center');
      output(el,`投影宽度 ≈ ${(span*1.6).toFixed(1)} 个实验像素\n${ortho?'尺寸由正交尺度确定，距离与焦距滑块不影响尺寸。':'宽度 ∝ 焦距 / 距离；距离翻倍，宽度约减半。'}`,{distance:d,focal:f,mode:ortho?'ortho':'persp',projectedWidth:span*1.6});
    }
    reactive(el,draw);
  }

  function clipPolygon(points,plane) {
    if(!points.length)return [];const result=[];
    let prev=points.at(-1),dp=plane(prev);
    for(const p of points){const d=plane(p);if((d>=0)!==(dp>=0)){const t=dp/(dp-d);result.push([prev[0]+t*(p[0]-prev[0]),prev[1]+t*(p[1]-prev[1])]);}if(d>=0)result.push(p);prev=p;dp=d;}
    return result;
  }
  function clipping(el) {
    const ctx=frame(el,'把跨界三角形裁成凸多边形','灰虚线是输入，暖色是保留区域。二维示意固定 w=1，只演示矩形的四个半空间。');
    slider(el,'x','水平移动',-260,260,0);slider(el,'y','垂直移动',-180,180,0);
    function draw() {
      clear(ctx);const dx=val(el,'x'),dy=val(el,'y');
      const initial=[[70+dx,270+dy],[410+dx,25+dy],[680+dx,315+dy]];
      let clipped=initial;for(const plane of [p=>p[0]-140,p=>580-p[0],p=>p[1]-65,p=>285-p[1]])clipped=clipPolygon(clipped,plane);
      ctx.fillStyle='#e8e7d9';ctx.fillRect(140,65,440,220);
      ctx.setLineDash([6,5]);poly(ctx,initial,null,palette.muted,1.5);ctx.setLineDash([]);
      poly(ctx,clipped,'#cf6c5066',palette.clay,2);
      if(clipped.length>3)for(let i=2;i<clipped.length-1;i++)line(ctx,clipped[0],clipped[i],palette.clay);
      clipped.forEach((p,i)=>{dot(ctx,...p,palette.ink,4);label(ctx,String(i),p[0]+8,p[1]-7,palette.ink,12);});
      ctx.strokeStyle=palette.ink;ctx.lineWidth=1.5;ctx.strokeRect(140,65,440,220);
      label(ctx,'裁剪区域',148,57,palette.ink,13);label(ctx,'输入：3 个顶点',25,325,palette.muted,12);
      output(el,`保留 ${clipped.length} 个顶点 → ${Math.max(0,clipped.length-2)} 个三角形\n交点参数 t = dA / (dA - dB)`,{vertices:clipped.length,triangles:Math.max(0,clipped.length-2),inside:clipped.every(p=>p[0]>=139.999&&p[0]<=580.001&&p[1]>=64.999&&p[1]<=285.001)});
    }
    reactive(el,draw);
  }

  function depth(el) {
    const ctx=frame(el,'每个样本只留下更近的表面','此处两片面各有常量深度。关闭测试可以看到提交顺序的影响；相等深度时保留先提交者。');
    slider(el,'red','暖色面 z',-1,1,-.45,.05,v=>v.toFixed(2));
    slider(el,'blue','青色面 z',-1,1,.35,.05,v=>v.toFixed(2));
    select(el,'enabled','深度测试',[['yes','开启 z < stored_depth'],['no','关闭：后画覆盖前画']],'yes');
    let reverse=false;
    const swap=button(el,'order','交换提交顺序',()=>{reverse=!reverse;draw();});
    function draw() {
      clear(ctx);
      const red={id:'暖色',z:val(el,'red'),p:[[145,285],[320,55],[488,282]],fill:palette.clay};
      const blue={id:'青色',z:val(el,'blue'),p:[[238,266],[440,55],[608,291]],fill:palette.teal};
      const submitted=reverse?[blue,red]:[red,blue];const enabled=el.querySelector('[data-control=enabled]').value==='yes';
      const drawOrder=enabled?[...submitted].sort((a,b)=>b.z-a.z||submitted.indexOf(b)-submitted.indexOf(a)):submitted;
      drawOrder.forEach(t=>poly(ctx,t.p,t.fill,palette.ink,2));
      const winner=drawOrder.at(-1);dot(ctx,374,207,palette.paper,7);dot(ctx,374,207,palette.ink,3);
      label(ctx,'共享样本',390,214,palette.paper,13);
      label(ctx,'z 越小，越靠近相机',27,31,palette.muted,13);
      swap.setAttribute('aria-pressed',String(reverse));
      output(el,`提交：${submitted.map(t=>t.id).join(' → ')}\n重叠样本：${winner.id}，z = ${winner.z.toFixed(2)}；深度测试${enabled?'开启':'关闭'}`,{winner:winner.id,z:winner.z,enabled,reverse});
    }
    reactive(el,draw);
  }

  function barycentricAt(p,tri) {
    const [a,b,c]=tri,den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
    const u=((b[1]-c[1])*(p[0]-c[0])+(c[0]-b[0])*(p[1]-c[1]))/den;
    const v=((c[1]-a[1])*(p[0]-c[0])+(a[0]-c[0])*(p[1]-c[1]))/den;
    return [u,v,1-u-v];
  }
  function corrected(weights,ws) {const q=weights.map((v,i)=>v/ws[i]),sum=q.reduce((a,b)=>a+b);return q.map(v=>v/sum);}
  function barycentric(el) {
    const ctx=frame(el,'同一个屏幕点，两组插值权重','点击三角形选择样本，或用滑块调整权重。第三个顶点 w 改变时，右侧颜色随透视校正变化。');
    slider(el,'w','第三顶点 w',.25,4,2,.05,v=>v.toFixed(2));
    slider(el,'a','屏幕 λ₀',0,100,34,1,v=>(v/100).toFixed(2));
    slider(el,'split','剩余权重分给 λ₁',0,100,50,1,v=>v+'%');
    const triangles=[[[49,278],[305,278],[177,58]],[[410,278],[666,278],[538,58]]];
    const pigments=[[207,108,80],[71,133,125],[219,168,72]];
    function draw() {
      clear(ctx);const w=val(el,'w'),a=val(el,'a')/100,split=val(el,'split')/100,lambda=[a,(1-a)*split,(1-a)*(1-split)],beta=corrected(lambda,[1,1,w]);
      const image=ctx.getImageData(0,0,720,340);
      for(let side=0;side<2;side++){
        const tri=triangles[side],minX=Math.ceil(tri[0][0]),maxX=Math.floor(tri[1][0]);
        for(let y=58;y<279;y++)for(let x=minX;x<=maxX;x++){
          const ls=barycentricAt([x+.5,y+.5],tri);if(ls.some(v=>v<0))continue;
          const weights=side?corrected(ls,[1,1,w]):ls;const at=(y*720+x)*4;
          for(let c=0;c<3;c++)image.data[at+c]=weights.reduce((s,v,i)=>s+v*pigments[i][c],0);
        }
      }
      ctx.putImageData(image,0,0);
      triangles.forEach((tri,side)=>{
        poly(ctx,tri,null,palette.ink,1.5);
        tri.forEach((p,i)=>label(ctx,`${i}${i===2?' · w='+w.toFixed(2):''}`,p[0],p[1]+(i===2?-12:24),palette.ink,12,'center'));
        const p=[0,1].map(axis=>lambda.reduce((s,v,i)=>s+v*tri[i][axis],0));
        dot(ctx,...p,palette.paper,7);dot(ctx,...p,palette.ink,3);label(ctx,'P',p[0]+10,p[1]-8);
        label(ctx,side?'按 1/w 校正':'普通屏幕插值',side?538:177,28,palette.ink,14,'center');
      });
      output(el,`λ = [${lambda.map(v=>v.toFixed(3)).join(', ')}]\nβ = [${beta.map(v=>v.toFixed(3)).join(', ')}] · 权重和 ${beta.reduce((s,v)=>s+v,0).toFixed(6)}`,{lambda,beta,w});
    }
    on(ctx.canvas,'pointerdown',e=>{
      const p=eventPoint(e,ctx.canvas),tri=triangles[p[0]>360?1:0],ls=barycentricAt(p,tri);if(ls.some(v=>v<0))return;
      const a=el.querySelector('[data-control=a]'),b=el.querySelector('[data-control=split]');
      a.value=Math.round(ls[0]*100);b.value=Math.round(ls[1]/Math.max(1e-8,1-ls[0])*100);
      a.dispatchEvent(new Event('input',{bubbles:true}));b.dispatchEvent(new Event('input',{bubbles:true}));
    });
    reactive(el,draw);
  }

  function shadows(el) {
    const ctx=frame(el,'接收点比阴影图记录更远吗','把九个相邻查询排成一行观察；实际代码查询二维 3×3 邻域。每次先比较深度，再平均可见性。');
    slider(el,'receiver','接收点深度',.15,.9,.53,.01,v=>v.toFixed(2));
    slider(el,'bias','比较偏移 bias',0,.3,.01,.005,v=>v.toFixed(3));
    select(el,'filter','取样方式',[['pcf','九次比较 / PCF'],['single','只比较中心']],'pcf');
    const depths=[.72,.72,.35,.35,.35,.35,.72,.72,.72];
    function draw() {
      clear(ctx);const r=val(el,'receiver'),b=val(el,'bias'),pcf=el.querySelector('[data-control=filter]').value==='pcf';
      const visible=depths.map(d=>r<=d+b),v=pcf?visible.filter(Boolean).length/9:Number(visible[4]);
      label(ctx,'更靠近光 / 深度小',25,28,palette.muted,12);
      depths.forEach((d,i)=>{
        const x=60+i*73,y=55+d*235;line(ctx,[x,50],[x,296],palette.faint);
        line(ctx,[x-22,y],[x+22,y],palette.ink,5);
        ctx.fillStyle=visible[i]?'#dba84855':'#29433e18';ctx.fillRect(x-24,55+r*235-12,48,24);
        dot(ctx,x,55+r*235,visible[i]?palette.gold:palette.teal,7);
        if(!pcf&&i===4){ctx.strokeStyle=palette.clay;ctx.lineWidth=2;ctx.strokeRect(x-28,44,56,259);}
        label(ctx,d.toFixed(2),x,y+22,palette.muted,11,'center');
        label(ctx,visible[i]?'亮':'遮挡',x,324,visible[i]?palette.ink:palette.teal,12,'center');
      });
      ctx.setLineDash([5,4]);line(ctx,[25,55+r*235],[697,55+r*235],palette.clay,1);ctx.setLineDash([]);
      output(el,`receiver = ${r.toFixed(3)}；bias = ${b.toFixed(3)}\n可见性 = ${v.toFixed(3)}（${pcf?visible.filter(Boolean).length+' / 9':'中心 '+Number(visible[4])}）`,{receiver:r,bias:b,visibility:v,pcf});
    }
    reactive(el,draw);
  }

  function lighting(el) {
    const ctx=frame(el,'把球面的连续明暗压成颜料色阶','左：连续余弦。右：分段颜料与排线。浏览器教学模型没有投影阴影、纸粒或真实 Blender 场景。');
    slider(el,'angle','光源方向',-150,150,-38,1,v=>v+'°');
    slider(el,'bands','颜料色阶',2,8,4);slider(el,'hatch','排线强度',0,1,.32,.02,v=>v.toFixed(2));
    function draw() {
      clear(ctx);const angle=val(el,'angle')*Math.PI/180,bands=val(el,'bands'),amount=val(el,'hatch');
      const l=[Math.sin(angle),.38,Math.cos(angle)],len=Math.hypot(...l);l.forEach((_,i)=>l[i]/=len);
      const colors={base:[.81,.4235,.3137],ink:[.161,.263,.243],paper:[.956,.929,.859]};
      const img=ctx.getImageData(0,0,720,340);
      for(let side=0;side<2;side++){
        const cx=side?536:184,cy=175,r=113;
        for(let y=62;y<=288;y++)for(let x=cx-r;x<=cx+r;x++){
          const nx=(x-cx)/r,ny=(cy-y)/r,z2=1-nx*nx-ny*ny;if(z2<0)continue;
          const nz=Math.sqrt(z2),lit=clamp(nx*l[0]+ny*l[1]+nz*l[2]),steps=Math.floor(lit*(bands-.001))/(bands-1);
          let c=side?mix(mix(colors.base,colors.ink,.52),mix(colors.base,colors.paper,.12),.23+.77*steps):colors.base.map(v=>v*(.18+.82*lit));
          if(side&&Math.abs(((x*.78+y*.63)%7.2)-3.6)<.48)c=mix(c,colors.ink,clamp((.58-lit)*2.2)*amount);
          const at=(y*720+x)*4;for(let i=0;i<3;i++)img.data[at+i]=clamp(c[i])*255;
        }
      }
      ctx.putImageData(img,0,0);
      for(const x of [184,536]){ctx.beginPath();ctx.arc(x,175,113,0,Math.PI*2);ctx.strokeStyle=palette.ink;ctx.lineWidth=2;ctx.stroke();}
      label(ctx,'连续余弦',184,31,palette.ink,14,'center');label(ctx,`${bands} 阶颜料`,536,31,palette.ink,14,'center');
      label(ctx,'n · l → 明暗 → 风格映射',360,325,palette.muted,12,'center');
      output(el,`色阶集合：[${Array.from({length:bands},(_,i)=>(i/(bands-1)).toFixed(2)).join(', ')}]\n光方向 = [${l.map(v=>v.toFixed(3)).join(', ')}]`,{bands,angle:val(el,'angle'),hatch:amount,levels:Array.from({length:bands},(_,i)=>i/(bands-1))});
    }
    reactive(el,draw);
  }

  function color(el) {
    frame(el,'黑白混合：0.5 还是 0.735？','两个色块都作为 sRGB 编码值交给浏览器显示。左边直接混编码值，右边先在线性光量上平均。',false);
    const swatches=document.createElement('div');swatches.className='swatch-row';swatches.innerHTML='<div class="swatch" data-swatch="encoded">sRGB 编码域平均</div><div class="swatch" data-swatch="linear">线性域平均后编码</div>';
    el.querySelector('.lab-header').after(swatches);
    slider(el,'t','白色所占比例',0,1,.5,.01,v=>Math.round(v*100)+'%');
    function draw() {
      const t=val(el,'t'),linearEncoded=enc(t);
      el.querySelector('[data-swatch=encoded]').style.background=rgb([t,t,t]);
      el.querySelector('[data-swatch=linear]').style.background=rgb([linearEncoded,linearEncoded,linearEncoded]);
      output(el,`编码域：显示值 ${t.toFixed(5)}，对应线性量 ${dec(t).toFixed(5)}\n线性域：线性量 ${t.toFixed(5)}，显示值 ${linearEncoded.toFixed(5)}`,{t,encodedMix:t,linearMixEncoded:linearEncoded});
    }
    reactive(el,draw);
  }

  function compare(el) {
    frame(el,'同一组静物，两种画面语言','两张原始 PNG 都在本书目录中。拖动整张图上的滑块，或聚焦后使用左右方向键。',false);
    const wrap=document.createElement('div');wrap.innerHTML='<div class="compare-frame"><img src="project/output/cycles_reference.png" alt="同场景的 Cycles 参考渲染"><img class="compare-overlay" src="project/output/astra_press.png" alt="Astra Press 版画风格渲染"><div class="compare-line"></div><div class="compare-handle">↔</div><input class="compare-range" data-control="split" type="range" min="0" max="100" value="50" aria-label="Astra 与 Cycles 图像分界"></div><div class="compare-labels"><span>← ASTRA PRESS · 自定义引擎</span><span>CYCLES · 参考 →</span></div>';
    el.querySelector('.lab-header').after(wrap);
    const range=el.querySelector('.compare-range');
    function draw(){const split=Number(range.value);el.querySelector('.compare-frame').style.setProperty('--split',split+'%');range.setAttribute('aria-valuetext',`Astra 占 ${split}%，Cycles 占 ${100-split}%`);output(el,`Astra ${split}% / Cycles ${100-split}% · 1440 × 1080`,{split});}
    on(range,'input',draw);draw();el.dataset.ready='true';
  }

  function memory(el) {
    frame(el,'一帧缓冲的内存账本','只计算列出的数组容量；真实峰值还包括临时数组、着色工作区、几何、宿主与分配器开销。',false);
    const bar=document.createElement('div');bar.className='budget-bar';bar.setAttribute('role','img');bar.setAttribute('aria-label','主缓冲、阴影和输出容量比例');el.querySelector('.lab-header').after(bar);
    slider(el,'width','输出宽度',320,3840,1440,16,v=>v+' px');
    slider(el,'height','输出高度',240,2160,1080,12,v=>v+' px');
    select(el,'ss','每轴超采样',[['1','1× / 每像素 1 样本'],['2','2× / 每像素 4 样本'],['3','3× / 假设扩展至 9 样本']],'2');
    select(el,'shadow','阴影图边长',[['512','512'],['1024','1024'],['2048','2048']],'2048');
    function draw() {
      const width=val(el,'width'),height=val(el,'height'),ss=val(el,'ss'),sh=val(el,'shadow'),samples=width*height*ss*ss;
      const main=samples*46,shadow=sh*sh*4,rgba=width*height*16,total=main+shadow+rgba;
      bar.innerHTML=[[main,palette.teal],[shadow,palette.gold],[rgba,palette.clay]].map(([n,c])=>`<div class="budget-segment" style="width:${n/total*100}%;background:${c}"></div>`).join('');
      const mib=n=>(n/1048576).toFixed(1)+' MiB';
      output(el,`高分辨率样本：${samples.toLocaleString()}\n青 · 主 G-buffer 46 B/样本：${mib(main)}\n金 · 阴影深度：${mib(shadow)}\n暖 · 输出 RGBA：${mib(rgba)}\n以上合计：${mib(total)}${ss===3?'\n3× 是容量推演，当前插件只提供 1× 与 2×。':''}`,{width,height,ss,shadowSize:sh,samples,mainBytes:main,totalBytes:total});
    }
    reactive(el,draw);
  }

  function generator(seed) {
    let state=seed>>>0;
    return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  }
  function integrate(seed,count) {
    const random=generator(seed);let sum=0,sq=0;const checkpoints=[];
    for(let i=1;i<=count;i++){const f=2*random();sum+=f;sq+=f*f;if((i&(i-1))===0)checkpoints.push([i,sum/i]);}
    const estimate=sum/count,variance=count>1?Math.max(0,(sq-count*estimate*estimate)/(count-1)):0;
    return {estimate,standardError:Math.sqrt(variance/count),checkpoints};
  }
  function montecarlo(el) {
    const ctx=frame(el,'用随机数估计一个已知积分','积分 ∫₀¹2x dx = 1。横轴按 2 的幂增长。固定 seed 可复现；一次误差不会保证单调变小。');
    slider(el,'power','样本数 N = 2 的幂',2,15,8,1,v=>(2**v).toLocaleString());
    slider(el,'seed','随机种子',1,999,19,1);
    button(el,'new-seed','换一组样本',()=>{const input=el.querySelector('[data-control=seed]');input.value=(Number(input.value)+137)%999+1;input.dispatchEvent(new Event('input',{bubbles:true}));});
    function draw() {
      clear(ctx);const power=val(el,'power'),seed=val(el,'seed'),count=2**power,result=integrate(seed,count);
      const x=n=>60+Math.log2(n)/15*620,y=v=>280-(v-.4)/1.2*225;
      for(const value of [.4,.7,1,1.3,1.6]){line(ctx,[60,y(value)],[685,y(value)],value===1?palette.ink:palette.faint,value===1?1.5:1);label(ctx,value.toFixed(1),45,y(value)+4,palette.muted,11,'right');}
      for(const p of [0,3,6,9,12,15])label(ctx,String(2**p),x(2**p),305,palette.muted,11,'center');
      ctx.save();ctx.beginPath();ctx.rect(58,43,630,240);ctx.clip();
      result.checkpoints.forEach(([n,v],i)=>{if(i)line(ctx,[x(result.checkpoints[i-1][0]),y(result.checkpoints[i-1][1])],[x(n),y(v)],palette.clay,2);dot(ctx,x(n),y(v),palette.clay,4);});
      ctx.restore();label(ctx,'真值 1.0',676,y(1)-10,palette.ink,12,'right');label(ctx,'累计均值 / 纵轴裁到 0.4–1.6',27,27,palette.muted,12);
      output(el,`N = ${count.toLocaleString()}；seed = ${seed}\n估计 ${result.estimate.toFixed(6)}；绝对误差 ${Math.abs(result.estimate-1).toFixed(6)}\n样本估计标准误差 ≈ ${result.standardError.toFixed(6)}（不是单次误差上界）`,{count,seed,estimate:result.estimate,error:Math.abs(result.estimate-1),standardError:result.standardError});
    }
    reactive(el,draw);
  }

  const factories={pipeline,camera,clipping,depth,barycentric,shadows,lighting,color,compare,memory,montecarlo};
  window.BookLabs={
    mount(root){root.querySelectorAll('[data-lab]').forEach(el=>{const make=factories[el.dataset.lab];if(!make)throw new Error('Unknown lab: '+el.dataset.lab);make(el);});},
    dispose(){lifetime.abort();lifetime=new AbortController();},
    names:Object.keys(factories),
    math:{enc,dec,corrected,clipPolygon,integrate}
  };
})();
