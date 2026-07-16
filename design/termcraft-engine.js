// Shared terminal-UI rendering engine for the Termcraft design system pages.
// Instantiate with `new Engine()`, call `engine.measure(onReady)` once mounted
// (remeasures monospace glyph metrics after fonts load), then call the frame
// methods (home, workspace, tweaks, ...) — each returns a React element.
export class Engine {
  pal = {
    bg:'#14110d', fg:'#d7d0c2', dim:'#8f877a', faint:'#5b544a',
    border:'#403a2f', line:'#2c2820',
    amber:'#e6a23c', amberHi:'#f6c163', amberDim:'#8a6d33',
    sel:'#392c11', selFg:'#f6c163',
    green:'#8fb96b', red:'#dd7b60', redDim:'#4d2a20',
    statusBg:'#231d12'
  };
  FS = 15;
  LH = 17;
  cw = 9;
  glyphScale = {};

  measure(onReady){
    const SPECIAL = "\u2502\u2500\u256d\u256e\u2570\u256f\u250c\u2510\u2514\u2518\u251c\u2524\u252c\u2534\u253c\u2588\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u258c\u258f\u256c\u2551\u2550\u274f\u25b8\u25cf\u2191\u2193\u23ce\u2713\u2717\u2839\u2026\u2039\u203a\u00b7\u26a0\u25ce\u2261\u231c\u231d\u231e\u231f\u27f2\u25a3\u25cb\u25b2\u25be\u21a9\u22ef";
    const doMeasure = () => {
      try {
        const probe = document.createElement('span');
        probe.style.cssText = "position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:pre;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:"+this.FS+"px";
        document.body.appendChild(probe);
        const adv = (s) => { probe.textContent = s.repeat(24); return probe.getBoundingClientRect().width/24; };
        const cw = adv('0') || 9;
        const scales = {};
        for (const g of SPECIAL) { const a = adv(g); if (a > 0) { const s = cw/a; if (Math.abs(1-s) > 0.015) scales[g] = +s.toFixed(4); } }
        document.body.removeChild(probe);
        this.cw = cw; this.glyphScale = scales; if (onReady) onReady();
      } catch(e) {}
    };
    let measuredOnce=false; const once=()=>{ if(measuredOnce) return; measuredOnce=true; doMeasure(); };
    if (document.fonts && document.fonts.ready) { document.fonts.ready.then(once); setTimeout(once, 1500); }
    else doMeasure();
  }

  // ---- buffer helpers ----
  mk(w,h){ const c=[]; for(let y=0;y<h;y++){ const r=[]; for(let x=0;x<w;x++) r.push({ch:' ',fg:this.pal.fg,bg:this.pal.bg,bold:false,blink:false}); c.push(r);} return {w,h,c}; }
  put(b,x,y,ch,s){ if(x<0||y<0||x>=b.w||y>=b.h) return; const cell=b.c[y][x]; cell.ch=ch; if(s){ if(s.fg)cell.fg=s.fg; if(s.bg)cell.bg=s.bg; if('bold'in s)cell.bold=s.bold; if('blink'in s)cell.blink=s.blink; } }
  text(b,x,y,str,s){ str=String(str); for(let i=0;i<str.length;i++) this.put(b,x+i,y,str[i],s); }
  hline(b,x,y,w,s){ for(let i=0;i<w;i++) this.put(b,x+i,y,'─',s); }
  fillRow(b,y,ch,s){ for(let x=0;x<b.w;x++) this.put(b,x,y,ch,s); }
  fillRect(b,x,y,w,h,s){ const ch=(s&&s.ch)||' '; for(let j=0;j<h;j++) for(let i=0;i<w;i++) this.put(b,x+i,y+j,ch,s); }
  dim(b,x0,y0,w,h,pal){ pal=pal||this.pal; for(let y=y0;y<y0+h;y++){ if(y<0||y>=b.h) continue; for(let x=x0;x<x0+w;x++){ if(x<0||x>=b.w) continue; const c=b.c[y][x]; if(c.ch!==' '){ c.fg=pal.faint; c.bold=false; c.blink=false; } c.bg=pal.bg; } } }
  box(b,x,y,w,h,o){ o=o||{}; const fg=o.fg||this.pal.border, bg=o.bg; const r=o.rounded!==false; let tl=r?'╭':'┌',tr=r?'╮':'┐',bl=r?'╰':'└',br=r?'╯':'┘';
    if(o.tee){ tl='├'; tr='┤'; bl='├'; br='┤'; }
    this.put(b,x,y,tl,{fg,bg}); this.put(b,x+w-1,y,tr,{fg,bg}); this.put(b,x,y+h-1,bl,{fg,bg}); this.put(b,x+w-1,y+h-1,br,{fg,bg});
    for(let i=1;i<w-1;i++){ this.put(b,x+i,y,'─',{fg,bg}); this.put(b,x+i,y+h-1,'─',{fg,bg}); }
    if(!o.tee){ for(let j=1;j<h-1;j++){ this.put(b,x,y+j,'│',{fg,bg}); this.put(b,x+w-1,y+j,'│',{fg,bg}); } }
    if(o.title){ this.text(b,x+2,y,' '+o.title+' ',{fg:o.titleFg||this.pal.fg,bg,bold:o.titleBold!==false}); } }
  pad(s,n){ s=String(s); return s.length>=n? s.slice(0,n) : s+' '.repeat(n-s.length); }
  padl(s,n){ s=String(s); return s.length>=n? s.slice(0,n) : ' '.repeat(n-s.length)+s; }

  gauge(b,x,y,w,label,pct,dim,pal){ const P=pal||this.pal; const lw=4; this.text(b,x,y,this.pad(label,lw),{fg:dim?P.faint:P.dim});
    const pctS=pct+'%'; const bw=w-lw-1-5; const bx=x+lw+1; const fill=Math.round(bw*pct/100);
    for(let i=0;i<bw;i++) this.put(b,bx+i,y, i<fill?'█':'╌', {fg: i<fill?(dim?P.faint:P.amber):(dim?P.line:P.border)});
    this.text(b,bx+bw+1,y,this.padl(pctS,4),{fg:dim?P.faint:P.fg,bold:!dim}); }

  spark(b,x,y,vals,dim,pal){ const g='▁▂▃▄▅▆▇█'; const P=pal||this.pal; const mx=Math.max.apply(null,vals);
    for(let i=0;i<vals.length;i++){ const lv=Math.max(0,Math.min(7,Math.round(vals[i]/mx*7))); this.put(b,x+i,y,g[lv],{fg:dim?P.faint:P.green}); } }

  statusBar(b,y,left,keys){ const P=this.pal; this.fillRow(b,y,' ',{fg:P.dim,bg:P.statusBg});
    let x=1; left.forEach(seg=>{ this.text(b,x,y,seg.t,{fg:seg.fg||P.dim,bg:seg.bg||P.statusBg,bold:seg.bold}); x+=seg.t.length; });
    const leftEnd=x;
    const build=(ks)=>{ const s=[]; ks.forEach(k=>{ const kt=' '+k[0]+' '; const lt=(k[1]?' '+k[1]:'')+' '; s.push({t:kt,active:k[2]}); s.push({t:lt,label:true}); }); return s; };
    let ks=keys.slice(); let segs=build(ks); let total=segs.reduce((a,s)=>a+s.t.length,0);
    while(ks.length>1 && leftEnd+2+total>b.w){ ks=ks.slice(0,-1); segs=build(ks); total=segs.reduce((a,s)=>a+s.t.length,0); }
    let rx=Math.max(b.w-1-total, leftEnd+2);
    segs.forEach(s=>{ if(s.label){ this.text(b,rx,y,s.t,{fg:P.dim,bg:P.statusBg}); } else { this.text(b,rx,y,s.t,{fg:s.active?P.bg:P.amber,bg:s.active?P.amber:P.statusBg,bold:true}); } rx+=s.t.length; }); }

  render(b){ const P=this.pal; const cw=this.cw||9; const SC=this.glyphScale||{}; const LH=this.LH;
    const React = window.React;
    const special=(ch)=> SC[ch]!==undefined;
    const styleKey=(c)=> c.fg+'|'+c.bg+'|'+(c.bold?1:0)+'|'+(c.blink?1:0);
    const rows=[];
    for(let y=0;y<b.h;y++){ const line=b.c[y]; const cells=[]; let x=0;
      while(x<b.w){ const c=line[x]; const sk=styleKey(c); const sp=special(c.ch); let end=x+1;
        if(sp){ while(end<b.w && line[end].ch===c.ch && styleKey(line[end])===sk) end++; }
        else { while(end<b.w && !special(line[end].ch) && styleKey(line[end])===sk) end++; }
        const n=end-x; let str=''; for(let k=x;k<end;k++) str+=line[k].ch;
        const st={display:'inline-block',verticalAlign:'top',width:(n*cw)+'px',height:LH+'px',whiteSpace:'pre',overflow:'hidden',
          color:c.fg,background:c.bg!==P.bg?c.bg:undefined,fontWeight:c.bold?700:400,
          animation:c.blink?'tcblink 1.05s steps(1,end) infinite':undefined};
        if(sp){ st.textAlign='center';
          cells.push(React.createElement('span',{key:x,style:st},
            React.createElement('span',{style:{display:'inline-block',transform:'scaleX('+SC[c.ch]+')',transformOrigin:'center'}},str))); }
        else cells.push(React.createElement('span',{key:x,style:st},str));
        x=end; }
      rows.push(React.createElement('div',{key:y,style:{height:LH+'px',lineHeight:LH+'px',whiteSpace:'nowrap'}},cells)); }
    return React.createElement('div',{style:{fontFamily:"'JetBrains Mono',ui-monospace,monospace",fontSize:this.FS+'px',lineHeight:LH+'px',background:P.bg,color:P.fg,width:(b.w*cw)+'px'}},rows); }

  // ---- reusable content ----
  drawMonitor(b,x,y,w,h,o){ o=o||{}; const P=o.pal||this.pal; const d=o.dim; const F=d?P.faint:P.fg, A=d?P.faint:P.amber, D=P.faint, BD=d?P.line:P.border;
    const cl=x+2, cw=w-4;
    this.text(b,cl,y,'system-monitor',{fg:F,bold:!d}); this.text(b,x+w-8,y,'● live',{fg:d?P.faint:P.green});
    this.box(b,x,y+2,w,9,{title:'resources',fg:BD,titleFg:d?P.faint:P.dim,titleBold:false,tee:true});
    this.gauge(b,cl,y+4,cw,'CPU',63,d,P); this.gauge(b,cl,y+6,cw,'MEM',72,d,P); this.gauge(b,cl,y+8,cw,'SWP',18,d,P);
    this.text(b,x+w-24,y+2,' load 0.84 0.79 0.61 ',{fg:D});
    this.box(b,x,y+12,w,4,{title:'network',fg:BD,titleFg:d?P.faint:P.dim,titleBold:false,tee:true});
    this.spark(b,cl,y+14,[2,3,5,4,6,7,5,8,6,4,3,5,7,8,6,5,4,6,7,8,6,4,3,5,6,7,8,6],d,P);
    this.text(b,x+w-25,y+14,'↑ 1.2 MB/s   ↓ 4.8 MB/s',{fg:F});
    const py=y+17; const ph=h-17; this.box(b,x,py,w,ph,{title:'processes',fg:BD,titleFg:d?P.faint:P.dim,titleBold:false,tee:true});
    const cols=(pid,cmd,cpu,mem,st)=> this.pad(pid,6)+this.pad(cmd,18)+this.padl(cpu,6)+this.padl(mem,7)+'   '+st;
    this.text(b,cl,py+1,cols('PID','COMMAND','CPU%','MEM%','STATE'),{fg:D,bold:!d});
    const procs=[['1481','ratatui-preview','12.4','3.1','run'],['  22','tokio-runtime','8.7','1.9','run'],['1902','codex-agent','6.2','5.4','run'],['  91','fs-watcher','2.1','0.8','idle'],['3310','render-loop','1.4','0.4','run'],['  --','systemd','0.9','—','—']];
    for(let i=0;i<procs.length && py+2+i<py+ph-1;i++){ const r=procs[i]; const line=cols(r[0],r[1],r[2],r[3],r[4]);
      const sel=i===0; if(sel){ for(let k=1;k<w-1;k++) this.put(b,x+k,py+2+i,' ',{bg:d?P.line:P.sel}); this.put(b,x+1,py+2+i,'▸',{fg:d?P.faint:P.amber,bg:d?P.line:P.sel}); }
      this.text(b,cl,py+2+i,line,{fg:sel?(d?P.faint:P.selFg):F, bg:sel?(d?P.line:P.sel):undefined, bold:sel&&!d}); }
  }

  drawFormDesign(b,x,y,w,h,err){ const P=this.pal; const cl=x+2, cw=w-4;
    this.text(b,cl,y,'invoices',{fg:P.fg,bold:true}); this.text(b,x+w-12,y,'32 records',{fg:P.faint});
    let cy=y+2;
    if(err){ for(let k=1;k<w-1;k++) this.put(b,x+k,cy,' ',{bg:P.redDim}); this.text(b,cl,cy,'✗ Failed to sync — connection refused. Retry?',{fg:P.red,bg:P.redDim,bold:true}); cy+=2; }
    const ibC = err?P.red:P.border;
    this.box(b,x,cy,w,3,{title:'search',fg:ibC,titleFg:err?P.red:P.dim,titleBold:false,tee:true});
    this.text(b,cl,cy+1,'invoices q3',{fg:P.fg}); this.put(b,cl+11,cy+1,'█',{fg:P.amber,blink:true});
    cy+=4;
    this.box(b,x,cy,w,h-(cy-y),{title:'results',fg:P.border,titleFg:P.dim,titleBold:false,tee:true});
    const cols=(a,c,d)=> this.pad(a,10)+this.pad(c,16)+this.padl(d,9);
    this.text(b,cl,cy+1,cols('INVOICE','CLIENT','AMOUNT'),{fg:P.faint,bold:true});
    const rows=[['#4821','Northwind','$12,400'],['#4820','Aperture','$3,150'],['#4819','Initech','$980'],['#4818','Umbrella','$22,010']];
    for(let i=0;i<rows.length && cy+2+i<cy+(h-(cy-y))-1;i++){ this.text(b,cl,cy+2+i,cols(rows[i][0],rows[i][1],rows[i][2]),{fg:P.fg}); }
  }

  // ---- HOME ----
  home(w,h){ const P=this.pal; const b=this.mk(w,h); const cx=Math.floor(w/2);
    const iw=Math.min(w-16,84); const ix=Math.floor((w-iw)/2); const boxH=6;
    const iy=Math.floor((h-boxH)/2)-2;
    const logo='❯ termcraft'; this.text(b,cx-Math.floor(logo.length/2),iy-4,logo,{fg:P.amber,bold:true});
    const tag='design terminal UIs by describing them'; this.text(b,cx-Math.floor(tag.length/2),iy-3,tag,{fg:P.dim});
    this.box(b,ix,iy,iw,boxH,{title:'describe',fg:P.amber,titleFg:P.amberHi});
    this.text(b,ix+2,iy+1,'❯ ',{fg:P.amber,bold:true});
    this.text(b,ix+4,iy+1,'Describe the TUI you want to design…',{fg:P.faint});
    this.put(b,ix+4,iy+1,'█',{fg:P.amber,blink:true});
    this.text(b,ix+2,iy+2,'⏎ create',{fg:P.dim});
    let acx=ix+2; const yy=iy+4;
    const sel=(lbl,val)=>{ this.text(b,acx,yy,lbl,{fg:P.faint}); acx+=lbl.length+1; this.text(b,acx,yy,'‹'+val+'›',{fg:P.amberHi,bold:true}); acx+=val.length+3; };
    sel('agent','codex'); sel('model','gpt-5.5'); sel('effort','high');
    if(acx+10<=ix+iw-2) this.text(b,acx,yy,'· / model',{fg:P.faint});
    const health='● codex 0.34 · agent ready'; this.text(b,cx-Math.floor(health.length/2),iy+boxH+1,health,{fg:P.green,bold:true});
    this.statusBar(b,h-1,[{t:' HOME ',fg:P.bg,bg:P.amber,bold:true},{t:'  no project yet',fg:P.dim},{t:'  gpt5.5 · high',fg:P.dim}],
      [['⏎','create'],['q','quit']]);
    return this.render(b);
  }

  // ---- WORKSPACE (idle / gen) ----
  workspace(w,h,state){ const P=this.pal; const b=this.mk(w,h); const gen=state==='gen';
    const chatW=Math.round(w*0.37);
    const div=chatW-1; const frameH=h-1;
    this.box(b,0,0,chatW,frameH,{title: gen?'❯ chat · working':'❯ chat · codex', fg:gen?P.amberDim:P.border, titleFg:P.amber});
    this.box(b,div,0,w-div,frameH,{title:null,fg:P.border});
    this.put(b,div,0,'┬',{fg:P.border}); this.put(b,div,frameH-1,'┴',{fg:P.border});
    const px=div+2;
    this.text(b,px,1,'▸ Main',{fg:P.amber,bold:true});
    this.text(b,px+7,1,'  Settings',{fg:P.dim}); this.text(b,px+17,1,'  Login',{fg:P.dim});
    this.text(b,w-14,1, gen?'⠹ generating':'main',{fg: gen?P.amber:P.faint,bold:gen});
    this.hline(b,div+1,2,w-div-2,{fg:P.border}); this.put(b,div,2,'├',{fg:P.border}); this.put(b,w-1,2,'┤',{fg:P.border});
    const dx=div, dy=4, dw=w-div, dh=frameH-5;
    this.drawMonitor(b,dx,dy,dw,dh,{dim:gen});
    this.drawChat(b,1,chatW-2,frameH,gen,{composerMeta:{model:'codex · gpt5.5 · high',ctx:42}});
    const mode = gen? {t:' GENERATING ',fg:P.bg,bg:P.amber,bold:true} : {t:' STATIC ',fg:P.amberHi,bg:P.line,bold:true};
    const left=[mode,{t:'  main ',fg:P.dim},{t:' '+w+'×'+h+' ',fg:P.dim}];
    if(gen) left.push({t:' ⚠ turn running — export locked ',fg:P.amberHi,bg:P.line,bold:true});
    const keys = gen? [['esc','cancel'],['F2','full']]
                    : [['F2','full'],['F3','tweaks'],['F4','act']];
    if(w<100){ this.statusBar(b,h-1,[mode,{t:' main ',fg:P.dim}], gen?[['esc','cancel']]:[['F3','tweak'],['F4','act']]); }
    else this.statusBar(b,h-1,left,keys);
    return this.render(b);
  }

  drawChat(b,x,w,frameH,gen,o){ o=o||{}; const P=this.pal; const composerTop=frameH-4;
    const tx=x+1, iw=w-2, maxX=x+w-1;
    let y=1;
    this.text(b,tx,y,'● codex',{fg:P.green,bold:true});
    const meta='ratatui · connected';
    if((9+meta.length)<=w){ this.ctext(b,x+9,y,meta,{fg:P.faint},maxX); }
    else { y++; this.ctext(b,tx,y,meta,{fg:P.faint},maxX); }
    y+=2;
    const seq=[
      {role:'❯ you'}, {body:'build a system monitor dashboard with cpu/mem gauges'}, {gap:1},
      {role:'● codex'}, {status:'✓ created page main',c:P.dim}, {status:'✓ added resources + processes',c:P.dim}, {gap:1},
      {role:'❯ you'}, {body:'add a network throughput sparkline'}, {gap:1}
    ];
    if(gen){ seq.push(
      {role:'● codex'}, {status:'⠹ generating design…',c:P.amber,bold:true},
      {status:'✓ read current design',c:P.green}, {status:'✓ planned layout',c:P.green},
      {status:'▸ writing widgets',c:P.fg}, {status:'  network gauge · sparkline',c:P.faint}); }
    else { seq.push(
      {role:'● codex'}, {status:'✓ updated network sparkline',c:P.dim}, {status:'✓ ↑/↓ throughput labels',c:P.dim}); }
    for(const e of seq){ if(y>=composerTop-1) break;
      if(e.gap){ y+=e.gap; continue; }
      if(e.role!==undefined){ this.ctext(b,tx,y,e.role,{fg:e.role[0]==='❯'?P.amber:P.green,bold:true},maxX); y++; continue; }
      const txt = e.body!==undefined ? e.body : e.status;
      const lines = this.wrapLines(txt, iw);
      for(let li=0; li<lines.length && y<composerTop-1; li++){
        this.ctext(b,tx,y,lines[li],{fg:e.c||P.fg,bold:!!e.bold},maxX);
        if(e.spark && li===lines.length-1){ const sx=tx+lines[li].length+1; if(sx+5<=maxX) this.spark(b,sx,y,[3,5,7,6,8],false); }
        y++; }
    }
    this.put(b,0,composerTop,'├',{fg:P.border}); this.hline(b,1,composerTop,w+1,{fg:P.border}); this.put(b,x+w,composerTop,'┤',{fg:P.border});
    if(o.composerMeta){ const cm=o.composerMeta;
      this.text(b,2,composerTop,' '+cm.model+' ',{fg:P.amberHi,bold:true});
      const tag=' ctx '+cm.ctx+'% ', rx=(x+w)-2-tag.length;
      this.text(b,rx,composerTop,' ctx ',{fg:P.faint,bg:P.bg}); this.text(b,rx+5,composerTop,cm.ctx+'% ',{fg:P.fg,bold:true,bg:P.bg}); }
    if(gen){ this.text(b,tx,composerTop+2,'❯ ',{fg:P.faint,bold:true}); this.ctext(b,x+3,composerTop+2,'generating… esc to cancel',{fg:P.faint},maxX); }
    else { this.text(b,tx,composerTop+2,'❯ ',{fg:P.amber,bold:true}); this.ctext(b,x+3,composerTop+2,'Ask for changes…',{fg:P.faint},maxX); this.put(b,x+3,composerTop+2,'█',{fg:P.amber,blink:true}); }
  }

  ctext(b,x,y,str,s,maxX){ str=String(str); for(let i=0;i<str.length;i++){ const cx=x+i; if(maxX!==undefined && cx>maxX) break; this.put(b,cx,y,str[i],s); } }
  wrapLines(str,width){ str=String(str); const words=str.split(' '); const lines=[]; let cur='';
    words.forEach(w=>{ if(cur==='') cur=w; else if((cur+' '+w).length<=width) cur+=' '+w; else { lines.push(cur); cur=w; } });
    if(cur!=='') lines.push(cur);
    const out=[]; lines.forEach(l=>{ while(l.length>width){ out.push(l.slice(0,width)); l=l.slice(width); } out.push(l); });
    return out.length?out:['']; }

  // ---- TWEAKS ----
  tweaks(w,h){ const P=this.pal; const b=this.mk(w,h); const frameH=h-1; const wide=w>=100;
    let previewX0, previewW, twX0, twW, chatW=0;
    if(wide){ chatW=Math.round(w*0.30); const rest=w-(chatW-1); twW=32; previewX0=chatW-1; previewW=rest-twW+1; twX0=previewX0+previewW-1; }
    else { previewX0=0; twW=32; twW=Math.min(32,Math.round(w*0.42)); previewW=w-twW+1; twX0=previewW-1; }
    if(wide){ this.box(b,0,0,chatW,frameH,{title:'❯ chat · codex',fg:P.border,titleFg:P.amber});
      this.text(b,2,1,'● codex',{fg:P.green,bold:true}); this.text(b,2,3,'❯ you',{fg:P.amber,bold:true});
      this.text(b,2,4,'show the error state',{fg:P.fg});
      this.text(b,2,6,'● codex',{fg:P.green,bold:true}); this.text(b,2,7,'✓ opened tweaks (F3)',{fg:P.dim}); this.text(b,2,8,'toggle states on the right',{fg:P.faint});
      this.put(b,0,frameH-4,'├',{fg:P.border}); this.hline(b,1,frameH-4,chatW-2,{fg:P.border}); this.put(b,chatW-1,frameH-4,'┤',{fg:P.border});
      this.text(b,2,frameH-4,' codex · gpt5.5 · high ',{fg:P.amberHi,bold:true});
      { const tag=' ctx 42% ', rx=chatW-2-tag.length; this.text(b,rx,frameH-4,' ctx ',{fg:P.faint}); this.text(b,rx+5,frameH-4,'42% ',{fg:P.fg,bold:true}); }
      this.text(b,2,frameH-2,'❯ ',{fg:P.amber,bold:true}); this.text(b,4,frameH-2,'Ask for changes…',{fg:P.faint}); this.put(b,4,frameH-2,'█',{fg:P.amber,blink:true});
    }
    this.box(b,previewX0,0,previewW,frameH,{fg:P.border});
    this.text(b,previewX0+2,1,'▸ Main',{fg:P.amber,bold:true}); this.text(b,previewX0+9,1,'  Settings',{fg:P.dim});
    this.text(b,previewX0+previewW-11,1,'main',{fg:P.faint});
    this.hline(b,previewX0+1,2,previewW-2,{fg:P.border}); this.put(b,previewX0,2,'├',{fg:P.border}); this.put(b,previewX0+previewW-1,2,'┤',{fg:P.border});
    this.drawFormDesign(b,previewX0,4,previewW,frameH-5,true);
    if(wide){ this.put(b,previewX0,0,'┬',{fg:P.border}); this.put(b,previewX0,frameH-1,'┴',{fg:P.border}); }
    this.box(b,twX0,0,twW,frameH,{title:'tweaks · F3',fg:P.amber,titleFg:P.amberHi});
    this.put(b,twX0,0,'┬',{fg:P.border}); this.put(b,twX0,frameH-1,'┴',{fg:P.border});
    const tx=twX0+2; let ty=2;
    const section=(t)=>{ this.text(b,tx,ty,t,{fg:P.faint,bold:true}); ty++; };
    const toggle=(on,lbl)=>{ this.text(b,tx,ty,on?'[x]':'[ ]',{fg:on?P.amber:P.dim,bold:on}); this.text(b,tx+4,ty,lbl,{fg:on?P.fg:P.dim}); ty++; };
    const select=(lbl,val)=>{ this.text(b,tx,ty,this.pad(lbl,11),{fg:P.dim}); this.text(b,tx+11,ty,'‹ '+val+' ›',{fg:P.amberHi}); ty++; };
    const input=(lbl,val,active)=>{ this.text(b,tx,ty,lbl,{fg:P.dim}); ty++; const iw=twW-6; this.box(b,tx,ty,iw,3,{fg:active?P.red:P.border}); this.text(b,tx+2,ty+1,val,{fg:P.fg}); if(active){ this.put(b,tx+2+val.length,ty+1,'█',{fg:P.amber,blink:true}); } ty+=3; };
    section('STATE'); toggle(true,'Error state'); toggle(false,'Loading'); toggle(true,'Show footer'); ty++;
    section('LAYOUT'); select('Density','comfortable'); select('Columns','3'); ty++;
    section('CONTENT'); input('Search text',this.pad('invoices q3',twW-9).trim(),true);
    this.text(b,tx,frameH-3,'⏎ apply   ␣ toggle',{fg:P.faint}); this.text(b,tx,frameH-2,'esc close',{fg:P.faint});
    const mode={t:' STATIC ',fg:P.amberHi,bg:P.line,bold:true};
    if(w<100) this.statusBar(b,h-1,[mode],[['F3','tweaks',true],['esc','close']]);
    else this.statusBar(b,h-1,[{t:' main ',fg:P.dim},{t:' '+w+'×'+h+' ',fg:P.dim},mode],[['F2','full'],['F3','tweaks',true],['F4','act']]);
    return this.render(b);
  }

  // ---- GIT HISTORY (§05) ----
  // Draw one popup row. r: {current,label,sel} or {hash,author,when,subject,current?,sel?}
  gitRow(b,x,ly,w,r,compact){ const P=this.pal; const lx=x+2; const sel=!!r.sel;
    if(sel){ for(let k=1;k<w-1;k++) this.put(b,x+k,ly,' ',{bg:P.sel}); }
    const bg=sel?P.sel:P.bg;
    this.put(b,lx-1,ly, sel?'▸':' ',{fg:P.amber,bg,bold:true});
    if(r.current && !r.hash){
      this.put(b,lx+1,ly,'●',{fg:P.amber,bg});
      this.text(b,lx+3,ly, r.label||'Current design', {fg:P.amberHi,bg,bold:true});
    } else {
      this.put(b,lx+1,ly, (r.current||sel)?'●':'○',{fg:(r.current||sel)?P.amber:P.dim,bg});
      this.text(b,lx+3,ly,this.pad(r.hash,9),{fg:sel?P.selFg:P.amber,bg});
      let cx=lx+12;
      if(!compact){ this.text(b,cx,ly,this.pad(r.author,13),{fg:sel?P.selFg:P.dim,bg}); cx+=13; }
      this.text(b,cx,ly,this.pad(r.when,11),{fg:sel?P.selFg:P.dim,bg}); cx+=11;
      const subj = r.current ? 'Current design' : r.subject;
      this.text(b,cx,ly,this.pad(subj, x+w-2-cx),{fg:r.current?P.amberHi:(sel?P.selFg:P.fg),bg,bold:!!r.current}); }
    return ly+1; }

  gitPopup(b,x,y,w,h,o){ const P=this.pal; const compact=!!o.compact;
    this.fillRect(b,x-1,y,w+2,h+1,{ch:' ',bg:P.bg});
    this.box(b,x,y,w,h,{title:o.title||'git history',fg:P.amber,titleFg:P.amberHi,bg:P.bg});
    const lx=x+2; let ly=y+2;
    let hdr=this.pad('',3)+this.pad('COMMIT',9); if(!compact) hdr+=this.pad('AUTHOR',13); hdr+=this.pad('WHEN',11)+'SUBJECT';
    this.text(b,lx,ly,hdr,{fg:P.faint,bold:true,bg:P.bg}); ly++;
    o.rows.forEach(r=>{ ly=this.gitRow(b,x,ly,w,r,compact); });
    if(o.caption){ ly++; this.text(b,lx,ly,o.caption,{fg:P.faint,bg:P.bg}); ly++; }
    if(o.footer){ this.hline(b,x+1,y+h-2,w-2,{fg:P.line}); this.put(b,x,y+h-2,'├',{fg:P.amber}); this.put(b,x+w-1,y+h-2,'┤',{fg:P.amber});
      let fx=lx; o.footer.forEach(seg=>{ this.text(b,fx,y+h-1,seg[0],{fg:seg[2]?P.faint:P.amber,bold:!seg[2],bg:P.bg}); fx+=seg[0].length+1;
        this.text(b,fx,y+h-1,seg[1],{fg:P.dim,bg:P.bg}); fx+=seg[1].length+3; }); } }

  verHist(w,h){ const P=this.pal;
    const b=this.mk(w,h); const frameH=h-1; const chatW=Math.round(w*0.37); const div=chatW-1;
    this.box(b,0,0,chatW,frameH,{fg:P.line,titleFg:P.faint,title:'❯ chat · codex',titleBold:false});
    this.box(b,div,0,w-div,frameH,{fg:P.line});
    this.put(b,div,0,'┬',{fg:P.line}); this.put(b,div,frameH-1,'┴',{fg:P.line});
    this.text(b,div+2,1,'▸ Main',{fg:P.faint}); this.text(b,div+9,1,'  Settings',{fg:P.line});
    this.hline(b,div+1,2,w-div-2,{fg:P.line}); this.put(b,div,2,'├',{fg:P.line}); this.put(b,w-1,2,'┤',{fg:P.line});
    const gx=div, gw=w-div;
    this.text(b,gx+2,4,'system-monitor',{fg:P.line});
    this.box(b,gx,6,gw,7,{fg:P.line,title:'resources',titleFg:P.line,titleBold:false,tee:true});
    this.box(b,gx,14,gw,4,{fg:P.line,title:'network',titleFg:P.line,titleBold:false,tee:true});
    this.box(b,gx,19,gw,frameH-20,{fg:P.line,title:'processes',titleFg:P.line,titleBold:false,tee:true});
    this.text(b,2,2,'● codex',{fg:P.line}); this.text(b,2,4,'✓ updated network sparkline',{fg:P.line});
    this.put(b,0,frameH-4,'├',{fg:P.line}); this.hline(b,1,frameH-4,chatW-2,{fg:P.line}); this.put(b,chatW-1,frameH-4,'┤',{fg:P.line});
    this.text(b,2,frameH-4,' codex · gpt5.5 · high ',{fg:P.line});
    { const tag=' ctx 42% ', rx=chatW-2-tag.length; this.text(b,rx,frameH-4,tag,{fg:P.line}); }
    const pw=84, ph=14, pxs=Math.floor((w-pw)/2), pys=Math.floor((h-ph)/2)-1;
    this.gitPopup(b,pxs,pys,pw,ph,{ title:'git history',
      rows:[
        {current:true,label:'Current design · uncommitted',sel:true},
        {hash:'a1b2c3d',author:'dröscher',when:'2h ago',subject:'widen the process table'},
        {hash:'9f4e0b2',author:'dröscher',when:'5h ago',subject:'add cpu / mem gauges'},
        {hash:'3c7d1a8',author:'kessler',when:'yesterday',subject:'initial system-monitor layout'} ],
      caption:'first-parent history of .termcraft/pages/main/page.tsx',
      footer:[['↑↓','move'],['⏎','preview'],['R','Restore…'],['esc','close']] });
    this.statusBar(b,h-1,[{t:' main · Current design · uncommitted ',fg:P.amberHi,bold:true},{t:' '+w+'×'+h+' ',fg:P.dim},{t:' STATIC ',fg:P.amberHi,bg:P.line,bold:true}],[['esc','close']]);
    return this.render(b);
  }

  // Compact popup-only buffers for the row-precedence variants (§05 insets)
  gitHistoryInset(kind){ const P=this.pal; const w=64, h=11; const b=this.mk(w,h);
    const cur={current:true,label:'Current design · uncommitted',sel:true};
    const c1={hash:'a1b2c3d',when:'2h ago',subject:'widen the process table'};
    const c2={hash:'9f4e0b2',when:'5h ago',subject:'add cpu / mem gauges'};
    let rows, caption;
    if(kind==='unborn'){ rows=[cur]; caption='unborn repository — no commits yet'; }
    else if(kind==='untracked'){ rows=[cur]; caption='untracked page — no ancestry'; }
    else if(kind==='recreated'){ rows=[cur,c1,c2]; caption='recreated page · reachable commits below'; }
    else if(kind==='tracked-eq'){ rows=[{current:true,hash:'a1b2c3d',when:'2h ago',sel:true},c2]; caption='source equals a1b2c3d — that row is Current design'; }
    else if(kind==='shallow'){ rows=[cur,c1,{hash:'…','when':'','subject':'partial history'}]; caption='shallow clone · partial history · no Fetch'; }
    else { rows=[cur,c1,c2]; caption='source differs from a1b2c3d'; } // tracked-changes
    this.gitPopup(b,1,0,w-2,h,{ title:kind==='shallow'?'git history · partial':'git history', compact:true, rows, caption });
    return this.render(b); }

  // ---- AGENT / MODEL / EFFORT PICKER ----
  agentPicker(w,h){ const P=this.pal;
    const b=this.mk(w,h); const frameH=h-1; const chatW=Math.round(w*0.37); const div=chatW-1;
    this.box(b,0,0,chatW,frameH,{fg:P.line,titleFg:P.faint,title:'❯ chat · codex',titleBold:false});
    this.box(b,div,0,w-div,frameH,{fg:P.line});
    this.put(b,div,0,'┬',{fg:P.line}); this.put(b,div,frameH-1,'┴',{fg:P.line});
    this.text(b,div+2,1,'▸ Main',{fg:P.faint}); this.text(b,div+9,1,'  Settings',{fg:P.line});
    this.hline(b,div+1,2,w-div-2,{fg:P.line}); this.put(b,div,2,'├',{fg:P.line}); this.put(b,w-1,2,'┤',{fg:P.line});
    const gx=div, gw=w-div;
    this.text(b,gx+2,4,'system-monitor',{fg:P.line});
    this.box(b,gx,6,gw,7,{fg:P.line,title:'resources',titleFg:P.line,titleBold:false,tee:true});
    this.box(b,gx,14,gw,4,{fg:P.line,title:'network',titleFg:P.line,titleBold:false,tee:true});
    this.box(b,gx,19,gw,frameH-20,{fg:P.line,title:'processes',titleFg:P.line,titleBold:false,tee:true});
    this.text(b,2,2,'● codex',{fg:P.line}); this.text(b,2,4,'✓ updated network sparkline',{fg:P.line});
    this.put(b,0,frameH-4,'├',{fg:P.line}); this.hline(b,1,frameH-4,chatW-2,{fg:P.line}); this.put(b,chatW-1,frameH-4,'┤',{fg:P.line});
    this.text(b,2,frameH-4,' codex · gpt5.5 · high ',{fg:P.line});
    { const tag=' ctx 42% ', rx=chatW-2-tag.length; this.text(b,rx,frameH-4,tag,{fg:P.line}); }
    const pw=74, ph=12, pxs=Math.floor((w-pw)/2), pys=Math.floor((h-ph)/2)-1;
    this.fillRect(b,pxs-1,pys,pw+2,ph+1,{ch:' ',bg:P.bg});
    this.box(b,pxs,pys,pw,ph,{title:'agent · model · effort',fg:P.amber,titleFg:P.amberHi,bg:P.bg});
    const lx=pxs+2; let ly=pys+2;
    this.text(b,lx,ly,this.pad('',3)+this.pad('AGENT',9)+this.pad('MODEL',16)+'EFFORT',{fg:P.faint,bold:true}); ly++;
    const rows=[
      ['codex','gpt-5.5','high',true],
      ['codex','gpt-5.5','medium',false],
      ['codex','gpt-5.1-mini','high',false],
      ['claude','sonnet-4.5','high',false]
    ];
    rows.forEach(r=>{ const sel=r[3]; if(sel){ for(let k=1;k<pw-1;k++) this.put(b,pxs+k,ly,' ',{bg:P.sel}); }
      this.put(b,lx-1,ly, sel?'▸':' ',{fg:P.amber,bg:sel?P.sel:P.bg,bold:true});
      this.text(b,lx+1,ly, sel?'●':'○',{fg:sel?P.amber:P.dim,bg:sel?P.sel:P.bg});
      this.text(b,lx+3,ly,this.pad(r[0],7),{fg:sel?P.selFg:P.fg,bg:sel?P.sel:P.bg,bold:sel});
      this.text(b,lx+10,ly,this.pad(r[1],14),{fg:sel?P.selFg:P.dim,bg:sel?P.sel:P.bg});
      this.text(b,lx+24,ly,r[2],{fg:sel?P.selFg:P.dim,bg:sel?P.sel:P.bg}); ly++; });
    ly++;
    this.hline(b,pxs+1,ly,pw-2,{fg:P.line}); this.put(b,pxs,ly,'├',{fg:P.amber}); this.put(b,pxs+pw-1,ly,'┤',{fg:P.amber}); ly++;
    let fx=lx;
    this.text(b,fx,ly,'↑↓',{fg:P.amber,bold:true}); fx+=3; this.text(b,fx,ly,'select',{fg:P.dim}); fx+=9;
    this.put(b,fx,ly,'⏎',{fg:P.amber,bold:true}); fx+=2; this.text(b,fx,ly,'apply',{fg:P.dim}); fx+=8;
    this.text(b,fx,ly,'esc',{fg:P.amber,bold:true}); fx+=3; this.text(b,fx,ly,' close',{fg:P.dim});
    this.statusBar(b,h-1,[{t:' main ',fg:P.dim},{t:' '+w+'×'+h+' ',fg:P.dim},{t:' STATIC ',fg:P.amberHi,bg:P.line,bold:true}],[['F2','full'],['F3','tweaks'],['F4','act']]);
    return this.render(b);
  }

  // ---- shared UI helpers (iteration 2) ----
  ctr(b,x0,w,y,str,s){ str=String(str); this.text(b,x0+Math.max(0,Math.floor((w-str.length)/2)),y,str,s); }
  badge(b,x,y,n,o){ o=o||{}; const P=this.pal; this.put(b,x,y,String(n),{fg:o.fg||P.bg,bg:o.bg||P.amber,bold:true}); }
  chipTag(b,x,y,text,o){ o=o||{}; const P=this.pal; const glyph=o.glyph||'▣'; const full=' '+glyph+' '+text+' ';
    for(let i=0;i<full.length;i++) this.put(b,x+i,y,' ',{bg:P.sel});
    this.put(b,x+1,y,glyph,{fg:P.amber,bg:P.sel}); this.text(b,x+3,y,text,{fg:P.selFg,bg:P.sel,bold:true}); return full.length; }
  selCorners(b,x,y,w,h,c){ const P=this.pal; const a={fg:c||P.amber,bold:true};
    this.put(b,x-1,y-1,'⌜',a); this.put(b,x+w,y-1,'⌝',a); this.put(b,x-1,y+h,'⌞',a); this.put(b,x+w,y+h,'⌟',a); }

  drawTabs(b,x,y,w,tabs,o){ o=o||{}; const P=this.pal; let tx=x;
    if(o.scroll){ this.text(b,x,y,'‹',{fg:P.amber,bold:true}); tx=x+2; }
    tabs.forEach((t)=>{ const name=t[0], active=t[1], ghost=t[2]; const fg=active?P.amber:(ghost?P.faint:P.dim);
      if(active){ this.text(b,tx,y,'▸ '+name,{fg,bold:true}); tx+=name.length+4; }
      else { this.text(b,tx,y,name,{fg}); tx+=name.length+3; } });
    if(o.scroll) this.put(b,x+w-1,y,'›',{fg:P.amber,bold:true});
    if(o.right) this.text(b,x+w-o.right.length,y,o.right,{fg:o.rightFg||P.faint,bold:!!o.rightBold}); }

  paneShell(b,w,h,o){ o=o||{}; const P=this.pal; const frameH=h-1;
    const chatW=o.noChat?0:(o.chatW!==undefined?o.chatW:Math.round(w*0.37)); const div=chatW-1;
    const pbf=o.prevBorderFg||P.border;
    if(!o.noChat) this.box(b,0,0,chatW,frameH,{title:o.chatTitle||'❯ chat · codex',fg:o.chatBorderFg||P.border,titleFg:o.chatTitleFg||P.amber,titleBold:o.chatTitleBold});
    const px0=o.noChat?0:div; const pw=w-px0;
    this.box(b,px0,0,pw,frameH,{fg:pbf});
    if(!o.noChat){ this.put(b,div,0,'┬',{fg:pbf}); this.put(b,div,frameH-1,'┴',{fg:pbf}); }
    if(!o.noTabs){ this.drawTabs(b,px0+2,1,pw-4,o.tabs||[['Main',true],['Settings',false],['Login',false]],{right:o.right,rightFg:o.rightFg,rightBold:o.rightBold,scroll:o.tabScroll});
      this.hline(b,px0+1,2,pw-2,{fg:pbf}); this.put(b,px0,2,'├',{fg:pbf}); this.put(b,px0+pw-1,2,'┤',{fg:pbf}); }
    return {frameH,chatW,div,px0,pw,dx:px0,dy:o.noTabs?2:4,dw:pw,dh:frameH-(o.noTabs?3:5)}; }

  wsStatus(b,w,h,o){ o=o||{}; const P=this.pal;
    const left=[];
    if(o.combo!==false){ const combo=o.combo||'codex · gpt5.5 · high'; left.push({t:' '+combo+' ',fg:P.bg,bg:P.amber,bold:true}); }
    if(o.ver!==false) left.push({t:'  '+(o.ver||'main')+' ',fg:o.verFg||P.dim,bold:!!o.verBold});
    if(o.size) left.push({t:' '+o.size+' ',fg:o.sizeErr?P.bg:P.dim,bg:o.sizeErr?P.red:P.statusBg,bold:!!o.sizeErr});
    else if(!o.noSize) left.push({t:' '+w+'×'+h+' ',fg:P.dim});
    if(o.hint) left.push({t:' '+o.hint+' ',fg:o.hintFg||P.amberHi,bg:o.hintBg||P.line,bold:true});
    left.push(o.mode||{t:' STATIC ',fg:P.amberHi,bg:P.line,bold:true});
    if(o.ctx!==false && (w>=100||o.ctxCaution)){ const cv=o.ctx!==undefined?o.ctx:42; const caution=!!o.ctxCaution||cv>=80; left.push({t:' ctx '+cv+'% ',fg:caution?P.amberHi:P.faint,bold:caution}); }
    this.statusBar(b,h-1,left,this.hintKeys(o.keys)); }
  hintKeys(keys){ const base=keys||[['F2','fullscreen'],['F3','tweaks'],['F4','interact']];
    const short={fullscreen:'full',interact:'act',versions:'vers'};
    const filtered=base.filter(k=>k[0]!=='m'&&k[0]!=='^E'&&k[0]!=='/').map(k=>[k[0],short[k[1]]||k[1],k[2]]);
    return filtered; }

  baseSeq(){ const P=this.pal; return [
    {role:'❯ you'},{body:'build a system monitor with cpu / mem gauges'},{gap:1},
    {role:'● codex'},{status:'✓ created page main',c:P.dim},{status:'✓ resources + processes',c:P.dim},{gap:1},
    {role:'❯ you'},{body:'add a network throughput sparkline'},{gap:1},
    {role:'● codex'},{status:'✓ added network sparkline',c:P.dim} ]; }

  chatSeq(b,chatX,chatW,frameH,o){ o=o||{}; const P=this.pal; const tx=chatX+1, maxX=chatX+chatW-2, iw=chatW-3; let y=1;
    if(o.header!==false){ this.text(b,tx,y,'● codex',{fg:o.offline?P.faint:P.green,bold:true});
      const meta=o.headerMeta||'ratatui · connected'; if((9+meta.length)<=chatW-2) this.ctext(b,chatX+9,y,meta,{fg:P.faint},maxX); y+=2; }
    if(o.scrollback){ this.ctext(b,tx,y,o.scrollback,{fg:P.amberDim,bold:true},maxX); this.put(b,maxX,y,'▲',{fg:P.amberDim}); y+=2; }
    const composerTop=frameH-(o.composerH||4);
    (o.seq||[]).forEach(e=>{ if(y>=composerTop-1) return;
      if(e.gap){ y+=e.gap; return; }
      if(e.head!==undefined){ this.ctext(b,tx,y,e.head,{fg:P.faint,bold:true},maxX); y++; return; }
      if(e.role!==undefined){ this.ctext(b,tx,y,e.role,{fg:e.role[0]==='❯'?P.amber:P.green,bold:true},maxX); y++; return; }
      if(e.pins){ e.pins.forEach(p=>{ if(y>=composerTop-1) return;
          if(p.orphan) this.put(b,tx+1,y,'⚠',{fg:P.amberDim});
          else if(p.resolved) this.put(b,tx+1,y,'✓',{fg:P.green});
          else this.badge(b,tx+1,y,p.n);
          this.ctext(b,tx+3,y,p.text,{fg:(p.resolved||p.orphan)?P.faint:P.dim},maxX); y++; }); return; }
      const txt=e.body!==undefined?e.body:(e.status!==undefined?e.status:e.system);
      const col=e.c||(e.system!==undefined?P.faint:P.fg); const lines=this.wrapLines(txt,iw);
      for(let li=0;li<lines.length&&y<composerTop-1;li++){ this.ctext(b,tx,y,lines[li],{fg:col,bold:!!e.bold},maxX);
        if(e.spark&&li===lines.length-1){ const sx=tx+lines[li].length+1; if(sx+5<=maxX) this.spark(b,sx,y,[3,5,7,6,8],false); } y++; } });
    this.put(b,chatX,composerTop,'├',{fg:P.border}); this.hline(b,chatX+1,composerTop,chatW-2,{fg:P.border}); this.put(b,chatX+chatW-1,composerTop,'┤',{fg:P.border});
    if(o.composerMeta){ const cm=o.composerMeta;
      this.text(b,chatX+2,composerTop,' '+cm.model+' ',{fg:P.amberHi,bold:true});
      const tag=' ctx '+cm.ctx+'% ', rx=chatX+chatW-3-tag.length;
      this.text(b,rx,composerTop,' ctx ',{fg:P.faint,bg:P.bg}); this.text(b,rx+5,composerTop,cm.ctx+'% ',{fg:cm.caution?P.amberHi:P.fg,bold:true,bg:P.bg}); }
    if(o.attach) this.ctext(b,tx,composerTop+1,o.attach,{fg:o.attachFg||P.amberHi,bold:true},maxX);
    else if(o.chip) this.chipTag(b,tx,composerTop+1,o.chip,{glyph:o.chipGlyph});
    const dis=o.composerDisabled;
    this.text(b,tx,composerTop+2,'❯ ',{fg:dis?P.faint:P.amber,bold:true});
    this.ctext(b,chatX+3,composerTop+2,o.placeholder||'Ask for changes…',{fg:P.faint},maxX);
    if(!dis) this.put(b,chatX+3,composerTop+2,'█',{fg:P.amber,blink:true}); }

  drawMonitorV2(b,x,y,w,h){ const P=this.pal; const cl=x+2, cw=w-4;
    this.text(b,cl,y,'system-monitor',{fg:P.fg,bold:true}); this.text(b,x+w-8,y,'● live',{fg:P.green});
    this.box(b,x,y+2,w,6,{title:'resources',fg:P.border,titleFg:P.dim,titleBold:false,tee:true});
    this.gauge(b,cl,y+4,cw,'CPU',58); this.gauge(b,cl,y+6,cw,'MEM',67);
    const py=y+9, ph=h-9; this.box(b,x,py,w,ph,{title:'processes',fg:P.border,titleFg:P.dim,titleBold:false,tee:true});
    const cols=(pid,cmd,cpu)=>this.pad(pid,6)+this.pad(cmd,20)+this.padl(cpu,6);
    this.text(b,cl,py+1,cols('PID','COMMAND','CPU%'),{fg:P.faint,bold:true});
    const procs=[['1481','ratatui-preview','12.4'],['  22','tokio-runtime','8.7'],['1902','codex-agent','6.2'],['  91','fs-watcher','2.1']];
    for(let i=0;i<procs.length&&py+2+i<py+ph-1;i++){ const r=procs[i]; this.text(b,cl,py+2+i,cols(r[0],r[1],r[2]),{fg:P.fg}); } }

  lightPal(){ return { bg:'#efe9dc', fg:'#33302a', dim:'#6f6858', faint:'#a49b86', border:'#c3bba8', line:'#d6cfbe',
    amber:'#a8701a', amberHi:'#8a5c12', amberDim:'#b79a63', sel:'#e2d6b8', selFg:'#5a4415', green:'#5f7d3e', red:'#b5482f', redDim:'#e7cfc4', statusBg:'#d6cfbe' }; }

  // ---- 07 selection & hover ----
  wsHover(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main'});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh);
    this.box(b,s.dx,s.dy+12,s.dw,4,{title:'network',fg:P.amberHi,titleFg:P.amberHi,titleBold:false,tee:true});
    const lbl='panel "network"'; const lx=s.dx+s.dw-lbl.length-4;
    for(let i=-1;i<=lbl.length;i++) this.put(b,lx+i,s.dy+11,' ',{bg:P.line});
    this.text(b,lx,s.dy+11,lbl,{fg:P.amberHi,bg:P.line});
    this.drawChat(b,1,s.chatW-2,s.frameH,false,{composerMeta:{model:'codex · gpt5.5 · high',ctx:42}});
    this.wsStatus(b,w,h,{combo:false,ctx:false,keys:[['F2','fullscreen'],['F3','tweaks'],['F4','interact'],['^E','export']]});
    return this.render(b); }

  wsSelect(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main'});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh);
    const cl=s.dx+2, gy=s.dy+4; this.selCorners(b,cl,gy,s.dw-6,1);
    this.text(b,cl,gy,'CPU',{fg:P.amberHi,bold:true});
    this.chatSeq(b,0,s.chatW,s.frameH,{seq:this.baseSeq(), chip:'gauge "CPU"', placeholder:'make it blue…', composerMeta:{model:'codex · gpt5.5 · high',ctx:42}});
    this.wsStatus(b,w,h,{combo:false,ctx:false,keys:[['esc','deselect'],['F3','tweaks'],['F4','interact'],['^E','export']]});
    return this.render(b); }

  // ---- 08 pins ----
  wsPinInput(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main'});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh);
    this.chatSeq(b,0,s.chatW,s.frameH,{seq:this.baseSeq(), placeholder:'right-click the preview to pin…', composerMeta:{model:'codex · gpt5.5 · high',ctx:42}});
    this.dim(b,0,0,w,s.frameH);
    const cx=s.dx+8, cy=s.dy+19; this.badge(b,cx,cy,1);
    const pw=Math.min(40,s.dw-14), pxs=cx+2, pys=cy;
    this.fillRect(b,pxs,pys,pw,4,{ch:' ',bg:P.bg});
    this.box(b,pxs,pys,pw,3,{title:'new pin',fg:P.amber,titleFg:P.amberHi,bg:P.bg});
    this.text(b,pxs+2,pys+1,'why is this always on top?',{fg:P.fg,bg:P.bg}); this.put(b,pxs+2+26,pys+1,'█',{fg:P.amber,blink:true,bg:P.bg});
    this.text(b,pxs+1,pys+3,'⏎ save · esc cancel',{fg:P.faint,bg:P.bg});
    this.wsStatus(b,w,h,{combo:false,ctx:false,keys:[['esc','cancel'],['F3','tweaks'],['^E','export']]});
    return this.render(b); }

  wsPins(w,h){ const P=this.pal; const b=this.mk(w,h); const narrow=w<100;
    const s=this.paneShell(b,w,h,{right:'main'});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh);
    this.badge(b,s.dx+1,s.dy+4,1); this.badge(b,s.dx+1,s.dy+19,2);
    const seq=[];
    if(!narrow) seq.push({role:'❯ you'},{body:'make the gauges pop'},{pins:[{n:1,text:'make this gauge red'}]},{gap:1},
      {role:'● codex'},{status:'✓ recolored gauge',c:P.dim},{gap:1});
    seq.push({head:'PINS · main'},{pins:[
      {n:2,text:'table · why always top?'},
      {resolved:true,text:'network · add labels · reopen'},
      {orphan:true,text:'header · missing from current render'} ]});
    this.chatSeq(b,0,s.chatW,s.frameH,{seq, scrollback:narrow?null:'▲ 8 earlier messages', attach:'2 open pins attached · sent next', attachFg:P.amberHi, composerMeta:{model:'codex · gpt5.5 · high',ctx:42}});
    this.wsStatus(b,w,h,{combo:false,ctx:false,keys:narrow?[['esc','clear'],['^E','export']]:[['esc','clear pins'],['F3','tweaks'],['^E','export']]});
    return this.render(b); }

  // ---- 09 HISTORICAL COMMIT PREVIEW ----
  wsVerBrowse(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'a1b2c3d · read-only',rightFg:P.amberHi,rightBold:true});
    for(let k=1;k<s.dw-1;k++) this.put(b,s.dx+k,s.dy,' ',{bg:P.line});
    this.text(b,s.dx+2,s.dy,'a1b2c3d · dröscher · 2h ago · "widen the process table"',{fg:P.amberHi,bg:P.line});
    this.drawMonitorV2(b,s.dx,s.dy+2,s.dw,s.dh-2);
    this.chatSeq(b,0,s.chatW,s.frameH,{seq:[
      {role:'❯ you'},{body:'widen the process table'},{gap:1},
      {role:'● codex'},{status:'✓ widened the process table',c:P.dim},{gap:1},
      {role:'❯ you'},{body:'add a network sparkline'},{gap:1},
      {role:'● codex'},{status:'✓ added network sparkline',c:P.dim} ],
      attach:'viewing a1b2c3d · read-only — Send disabled', attachFg:P.red,
      composerDisabled:true, placeholder:'leave history to edit the current design', composerMeta:{model:'codex · gpt5.5 · high',ctx:42}});
    this.wsStatus(b,w,h,{combo:false,ctx:false,ver:'main · a1b2c3d · read-only',verFg:P.amberHi,verBold:true,
      hint:'Send · Tweaks · pins disabled',hintFg:P.faint,hintBg:P.line,
      mode:{t:' READ-ONLY ',fg:P.amberHi,bg:P.line,bold:true},keys:[['esc','leave · reload current']]});
    return this.render(b); }

  // ---- 10 fullscreen ----
  wsFull(w,h,small){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{noChat:true, right:small?'true size':'main', rightFg:small?P.red:P.faint, rightBold:!!small});
    if(small){ for(let k=1;k<s.dw-1;k++) this.put(b,s.dx+k,s.dy,' ',{bg:P.redDim});
      this.text(b,s.dx+2,s.dy,'⚠ minSize 80×24 exceeds preview 78×22 — true size, clipped',{fg:P.red,bg:P.redDim,bold:true});
      this.drawMonitor(b,s.dx,s.dy+2,s.dw,s.dh-2);
    } else this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh);
    const mode={t:' FULLSCREEN ',fg:P.bg,bg:P.amber,bold:true};
    if(small) this.wsStatus(b,w,h,{size:'78×22 < 80×24',sizeErr:true,mode,keys:[['F2','windowed'],['^E','export']]});
    else this.wsStatus(b,w,h,{mode,keys:[['F2','windowed'],['^E','export']]});
    return this.render(b); }

  wsSmallSize(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main'});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh);
    this.chatSeq(b,0,s.chatW,s.frameH,{seq:this.baseSeq(), attach:'⚠ preview 74w < design 80 — F2 for full size', attachFg:P.red, composerMeta:{model:'codex · gpt5.5 · high',ctx:42}});
    this.wsStatus(b,w,h,{combo:false,ctx:false,size:'74×30 < 80×24',sizeErr:true,keys:[['F2','fullscreen'],['^E','export']]});
    return this.render(b); }

  // ---- 11 interact ----
  wsInteract(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main'});
    this.drawFormDesign(b,s.dx,s.dy,s.dw,s.dh,false);
    const ix=s.dx, iy=s.dy+2; this.box(b,ix,iy,s.dw,3,{title:'search',fg:P.amberHi,titleFg:P.amberHi,titleBold:false,tee:true});
    this.selCorners(b,ix+1,iy+1,s.dw-2,1);
    const ddx=s.dx+s.dw-26, ddy=s.dy+6; const items=[['all statuses',false],['paid',false],['overdue',true],['draft',false],['void',false]]; const ddw=22, ddh=items.length+2;
    this.fillRect(b,ddx,ddy,ddw,ddh,{ch:' ',bg:P.bg});
    this.box(b,ddx,ddy,ddw,ddh,{title:'status ▾',fg:P.amber,titleFg:P.amberHi,bg:P.bg});
    items.forEach((it,i)=>{ const yy=ddy+1+i, sel=it[1]; if(sel) for(let k=1;k<ddw-1;k++) this.put(b,ddx+k,yy,' ',{bg:P.sel});
      this.put(b,ddx+1,yy,sel?'▸':' ',{fg:P.amber,bg:sel?P.sel:P.bg,bold:true});
      this.text(b,ddx+3,yy,it[0],{fg:sel?P.selFg:P.fg,bg:sel?P.sel:P.bg,bold:sel}); });
    this.chatSeq(b,0,s.chatW,s.frameH,{seq:this.baseSeq(), attach:'⚠ goTo "settings" — page removed', attachFg:P.amberHi, placeholder:'clicks drive the design — F4 for static', composerMeta:{model:'codex · gpt5.5 · high',ctx:42}});
    this.wsStatus(b,w,h,{combo:false,ctx:false,noSize:true, mode:{t:' INTERACT ',fg:P.bg,bg:P.amberHi,bold:true},keys:[['click','design'],['tab','focus'],['F4','static'],['rclick','pin'],['^E','export']]});
    return this.render(b); }

  // ---- 12 errors ----
  homeErr(w,h){ const P=this.pal; const b=this.mk(w,h); const cx=Math.floor(w/2);
    const logo='❯ termcraft'; this.text(b,cx-Math.floor(logo.length/2),1,logo,{fg:P.amber,bold:true});
    const iw=w-8, ix=4, iy=3, ih=6;
    this.box(b,ix,iy,iw,ih,{title:'agent',fg:P.red,titleFg:P.red});
    this.text(b,ix+2,iy+1,'✗ codex CLI not found',{fg:P.red,bold:true});
    this.text(b,ix+2,iy+2,'termcraft needs the codex agent on your PATH.',{fg:P.dim});
    this.text(b,ix+2,iy+3,'install:',{fg:P.faint}); this.text(b,ix+11,iy+3,'npm i -g @openai/codex',{fg:P.amberHi});
    this.text(b,ix+2,iy+4,'then reopen, or press r to re-check',{fg:P.faint});
    const hy=iy+ih+1; this.text(b,ix,hy,'agents',{fg:P.dim,bold:true}); this.box(b,ix,hy+1,iw,4,{fg:P.border});
    this.text(b,ix+2,hy+2,'✗ codex',{fg:P.red,bold:true}); this.text(b,ix+12,hy+2,'not found',{fg:P.faint});
    this.text(b,ix+2,hy+3,'healthy reads',{fg:P.faint}); this.text(b,ix+16,hy+3,'✓ codex 0.34',{fg:P.green,bold:true});
    this.statusBar(b,h-1,[{t:' HOME ',fg:P.bg,bg:P.amber,bold:true},{t:'  ✗ codex CLI not found ',fg:P.bg,bg:P.red,bold:true}],[['r','re-check'],['q','quit']]);
    return this.render(b); }

  wsErrRetry(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main'});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh);
    const seq=this.baseSeq().concat([{gap:1},
      {role:'❯ you'},{body:'make it a 3-column layout'},{gap:1},
      {role:'● codex'},{status:'✗ invalid design (schema) · retry 1/3',c:P.red},{status:'✗ retry 2/3',c:P.red},{status:'✗ retry 3/3',c:P.red},{gap:1},
      {system:'⟲ generation failed after 3 tries — current design unchanged'} ]);
    this.chatSeq(b,0,s.chatW,s.frameH,{seq, scrollback:'▲ 4 earlier messages', composerMeta:{model:'codex · gpt5.5 · high',ctx:42}});
    this.wsStatus(b,w,h,{combo:false,ctx:false,keys:[['F2','fullscreen'],['F3','tweaks'],['^E','export']]});
    return this.render(b); }

  wsCancelled(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main'});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh);
    this.chatSeq(b,0,s.chatW,s.frameH,{seq:[
      {role:'❯ you'},{body:'add a network throughput sparkline'},{gap:1},
      {role:'● codex'},{status:'✓ added network sparkline',c:P.dim},{gap:1},
      {role:'❯ you'},{body:'add a gpu temperature panel'},{gap:1},
      {role:'● codex'},{status:'⠹ generating…',c:P.faint},{gap:1},
      {system:'⟲ generation cancelled — current design unchanged'},{gap:1},
      {system:'✗ pages/main/page.tsx needs a newer termcraft (kit 2.1)',c:P.red} ], scrollback:'▲ 4 earlier messages', composerMeta:{model:'codex · gpt5.5 · high',ctx:42}});
    this.wsStatus(b,w,h,{combo:false,ctx:false,keys:[['F2','fullscreen'],['F3','tweaks'],['^E','export']]});
    return this.render(b); }

  termSmall(w,h){ const P=this.pal; const b=this.mk(w,h); const cyc=Math.floor(h/2);
    this.ctr(b,0,w,cyc-2,'⚠ terminal too small',{fg:P.amber,bold:true});
    this.ctr(b,0,w,cyc,'enlarge the window to keep designing',{fg:P.fg});
    this.ctr(b,0,w,cyc+2,'now  58×16',{fg:P.red,bold:true});
    this.ctr(b,0,w,cyc+3,'need 80×24',{fg:P.faint});
    return this.render(b); }

  lockScreen(w,h){ const P=this.pal; const b=this.mk(w,h); const cyc=Math.floor(h/2);
    this.ctr(b,0,w,cyc-3,'❯ termcraft',{fg:P.amber,bold:true});
    this.ctr(b,0,w,cyc-1,'✗ already running in this directory',{fg:P.red,bold:true});
    this.ctr(b,0,w,cyc+1,'another instance holds the lock (pid 4821)',{fg:P.dim});
    this.ctr(b,0,w,cyc+2,'close it, then reopen termcraft here',{fg:P.faint});
    this.ctr(b,0,w,cyc+4,'q quit',{fg:P.amberHi,bold:true});
    return this.render(b); }

  // ---- 13 export ----
  wsExport(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main'});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh); this.drawChat(b,1,s.chatW-2,s.frameH,false,{composerMeta:{model:'codex · gpt5.5 · high',ctx:42}});
    const pw=62, ph=11, px=s.dx+Math.floor((s.dw-pw)/2), py=Math.floor((h-ph)/2)-1;
    this.fillRect(b,px,py,pw,ph,{ch:' ',bg:P.bg});
    this.box(b,px,py,pw,ph,{title:'export ^E',fg:P.amber,titleFg:P.amberHi,bg:P.bg});
    const lx=px+3; let y=py+2;
    this.text(b,lx,y,'✓ exported system-monitor',{fg:P.green,bold:true,bg:P.bg}); y+=2;
    this.text(b,lx,y,'.termcraft/export/design-prompt.md',{fg:P.fg,bg:P.bg}); y++;
    this.text(b,lx,y,'.termcraft/export/pages/*.tsx',{fg:P.dim,bg:P.bg}); y++;
    this.text(b,lx,y,'.termcraft/export/snapshots/  layout/',{fg:P.dim,bg:P.bg}); y+=2;
    this.text(b,lx,y,'reads current page.tsx on disk · incl uncommitted',{fg:P.faint,bg:P.bg}); y+=2;
    this.text(b,lx,y,'⏎ ok',{fg:P.amber,bold:true,bg:P.bg});
    this.wsStatus(b,w,h,{combo:false,ctx:false});
    return this.render(b); }

  // ---- 14 first generation ----
  wsFirst(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{tabs:[['main',false,true]], right:'⠹ generating', rightFg:P.amber, rightBold:true});
    this.ctr(b,s.dx,s.dw,s.dy+Math.floor(s.dh/2)-1,'⠹ generating first page…',{fg:P.amber,bold:true});
    this.ctr(b,s.dx,s.dw,s.dy+Math.floor(s.dh/2)+1,'no current page source yet — creating main/page.tsx',{fg:P.faint});
    this.chatSeq(b,0,s.chatW,s.frameH,{seq:[
      {role:'❯ you'},{body:'a system monitor with cpu, memory and network'},{gap:1},
      {role:'● codex'},{status:'⠹ generating design…',c:P.amber,bold:true},{status:'✓ planned layout',c:P.green},{status:'▸ writing widgets',c:P.fg},{status:'  resources · processes',c:P.faint} ],
      composerDisabled:true, placeholder:'generating… esc to cancel', composerMeta:{model:'codex · gpt5.5 · high',ctx:8}});
    this.wsStatus(b,w,h,{combo:false,ctx:false,ver:false,mode:{t:' GENERATING ',fg:P.bg,bg:P.amber,bold:true},keys:[['esc','cancel']]});
    return this.render(b); }

  // ---- 15 focus ----
  wsFocus(w,h,which){ const P=this.pal; const b=this.mk(w,h); const cf=which==='composer';
    const s=this.paneShell(b,w,h,{chatBorderFg:cf?P.amber:P.line, chatTitle:cf?'❯ chat · codex':'chat · codex', chatTitleFg:cf?P.amberHi:P.faint,
      prevBorderFg:cf?P.line:P.amber, right:'main', rightFg:cf?P.faint:P.amberHi, rightBold:!cf});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh);
    this.chatSeq(b,0,s.chatW,s.frameH,{seq:[{role:'❯ you'},{body:'add a network sparkline'},{gap:1},{role:'● codex'},{status:'✓ updated sparkline',c:P.dim}],
      composerDisabled:!cf, placeholder:cf?'Ask for changes…':'tab → focus composer', composerMeta:{model:'codex · gpt5.5 · high',ctx:42}});
    this.wsStatus(b,w,h,{combo:false,ctx:false,mode:{t:cf?' FOCUS: CHAT ':' FOCUS: PREVIEW ',fg:P.bg,bg:P.amberHi,bold:true},keys:[['tab','focus'],['F3','tweaks'],['esc','unfocus']]});
    return this.render(b); }

  // ---- 16 wizard / migrate ----
  wizard(w,h){ const P=this.pal; const b=this.mk(w,h);
    const pw=Math.min(64,w-4), ph=Math.min(18,h-2), px=Math.floor((w-pw)/2), py=Math.floor((h-ph)/2);
    this.box(b,px,py,pw,ph,{title:'termcraft setup',fg:P.amber,titleFg:P.amberHi});
    const lx=px+3; let y=py+2;
    this.text(b,lx,y,'first-run setup',{fg:P.dim,bold:true}); this.text(b,px+pw-6,y,'2/3',{fg:P.amberHi,bold:true}); y+=2;
    this.text(b,lx,y,'agent',{fg:P.faint}); this.text(b,lx+8,y,'✓ codex 0.34 found',{fg:P.green,bold:true}); y+=2;
    this.text(b,lx,y,'target stack',{fg:P.faint}); y++;
    [['rust · ratatui',true],['go · bubbletea',false],['generic ansi',false]].forEach(st=>{ this.text(b,lx+2,y,st[1]?'●':'○',{fg:st[1]?P.amber:P.dim,bold:st[1]}); this.text(b,lx+4,y,st[0],{fg:st[1]?P.fg:P.dim,bold:st[1]}); y++; });
    y++; this.text(b,lx,y,'preview defaults',{fg:P.faint}); y++;
    this.text(b,lx+2,y,'theme',{fg:P.dim}); this.text(b,lx+10,y,'‹ dark ›',{fg:P.amberHi,bold:true}); this.text(b,lx+22,y,'size',{fg:P.dim}); this.text(b,lx+28,y,'‹ 80×24 ›',{fg:P.amberHi,bold:true});
    this.hline(b,px+1,py+ph-3,pw-2,{fg:P.line}); this.put(b,px,py+ph-3,'├',{fg:P.amber}); this.put(b,px+pw-1,py+ph-3,'┤',{fg:P.amber});
    this.text(b,lx,py+ph-2,'● ● ○',{fg:P.amber}); this.text(b,px+pw-19,py+ph-2,'⏎ next · esc back',{fg:P.dim});
    return this.render(b); }

  migrate(w,h){ const P=this.pal; const b=this.mk(w,h);
    const pw=Math.min(64,w-4), ph=Math.min(16,h-2), px=Math.floor((w-pw)/2), py=Math.floor((h-ph)/2);
    this.box(b,px,py,pw,ph,{title:'migrate project',fg:P.amber,titleFg:P.amberHi});
    const lx=px+3; let y=py+2;
    this.text(b,lx,y,'⚠ opened a project from an older termcraft',{fg:P.amberHi,bold:true}); y+=2;
    this.text(b,lx,y,'will migrate to the current format:',{fg:P.dim}); y++;
    ['3 pages → current page.tsx','project + config schema','kit 2.1 · tweaks · pins · agent choice'].forEach(t=>{ this.text(b,lx+2,y,'• '+t,{fg:P.fg}); y++; });
    y++; this.text(b,lx,y,'git history is left untouched — only current sources migrate',{fg:P.faint}); y++;
    this.text(b,lx+2,y,'.termcraft/backup-2026-07-13/',{fg:P.amberHi});
    this.hline(b,px+1,py+ph-3,pw-2,{fg:P.line}); this.put(b,px,py+ph-3,'├',{fg:P.amber}); this.put(b,px+pw-1,py+ph-3,'┤',{fg:P.amber});
    this.text(b,lx,py+ph-2,'⏎ migrate',{fg:P.amber,bold:true}); this.text(b,lx+11,py+ph-2,'· esc later',{fg:P.dim});
    return this.render(b); }

  // ---- 17 preview controls ----
  wsPreviewCtl(w,h){ const P=this.pal; const LP=this.lightPal(); const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main · light'});
    for(let yy=3;yy<s.frameH-1;yy++) for(let xx=s.dx+1;xx<w-1;xx++) this.put(b,xx,yy,' ',{bg:LP.bg,fg:LP.fg});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh,{pal:LP});
    this.drawChat(b,1,s.chatW-2,s.frameH,false,{composerMeta:{model:'codex · gpt5.5 · high',ctx:42}});
    this.dim(b,0,0,s.chatW,s.frameH); this.dim(b,s.px0,0,s.pw,s.frameH,LP);
    const pw=32, ph=8, px=w-pw-3, py=s.frameH-ph-1;
    this.fillRect(b,px,py,pw,ph,{ch:' ',bg:P.bg});
    this.box(b,px,py,pw,ph,{title:'preview · ^P',fg:P.amber,titleFg:P.amberHi,bg:P.bg});
    const lx=px+2; let y=py+2;
    this.text(b,lx,y,'theme',{fg:P.dim,bg:P.bg}); this.text(b,lx+8,y,'‹ light ›',{fg:P.amberHi,bg:P.bg,bold:true}); y++;
    this.text(b,lx+8,y,'dark·light·16·256',{fg:P.faint,bg:P.bg}); y++;
    this.text(b,lx,y,'size',{fg:P.dim,bg:P.bg}); this.text(b,lx+8,y,'‹ 80×24 ›',{fg:P.amberHi,bg:P.bg,bold:true}); y++;
    this.text(b,lx+8,y,'80×24·120×40·auto',{fg:P.faint,bg:P.bg}); y++;
    this.text(b,lx,y,'preview only — not saved',{fg:P.faint,bg:P.bg});
    this.wsStatus(b,w,h,{combo:false,ctx:false,keys:[['^P','preview',true],['F3','tweaks'],['esc','close']]});
    return this.render(b); }

  // ---- 18 tab management ----
  wsTabs(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{tabs:[['Login',false],['Main',true],['Settings',false],['Report',false],['Stats',false]], tabScroll:true, right:'main'});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh); this.drawChat(b,1,s.chatW-2,s.frameH,false,{composerMeta:{model:'codex · gpt5.5 · high',ctx:42}});
    const mx=s.dx+9, my=2, items=['rename','move left','move right','remove'], mw=16, mh=items.length+2;
    this.fillRect(b,mx,my,mw,mh,{ch:' ',bg:P.bg});
    this.box(b,mx,my,mw,mh,{title:'tab',fg:P.amber,titleFg:P.amberHi,bg:P.bg});
    items.forEach((it,i)=>{ const yy=my+1+i, sel=i===0; if(sel) for(let k=1;k<mw-1;k++) this.put(b,mx+k,yy,' ',{bg:P.sel});
      this.put(b,mx+1,yy,sel?'▸':' ',{fg:P.amber,bg:sel?P.sel:P.bg,bold:true});
      this.text(b,mx+3,yy,it,{fg:sel?P.selFg:(it==='remove'?P.red:P.fg),bg:sel?P.sel:P.bg,bold:sel}); });
    this.wsStatus(b,w,h,{combo:false,ctx:false,keys:[['↑↓','select'],['⏎','apply'],['esc','close']]});
    return this.render(b); }

  // ---- 20 zero-pages empty state ----
  wsEmpty(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{tabs:[], right:''});
    this.ctr(b,s.dx,s.dw,s.dy+Math.floor(s.dh/2),'No pages yet — describe what to build',{fg:P.faint});
    this.chatSeq(b,0,s.chatW,s.frameH,{seq:[
      {role:'❯ you'},{body:'a kanban board with three columns'},{gap:1},
      {role:'● codex'},{status:'⠹ generating design…',c:P.faint},{status:'✗ invalid design (schema) · retry 3/3',c:P.red},{gap:1},
      {system:'✗ generation failed — invalid design after 3 retries',c:P.red} ],
      placeholder:'describe the first page…', composerMeta:{model:'codex · gpt5.5 · high',ctx:0}});
    this.wsStatus(b,w,h,{combo:false,ctx:false,ver:false,mode:{t:' STATIC ',fg:P.amberHi,bg:P.line,bold:true},keys:[['F2','fullscreen']]});
    return this.render(b); }

  // ---- 21 custom preview size (invalid input) ----
  wsPreviewCtlCustom(w,h){ const P=this.pal; const LP=this.lightPal(); const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main · light'});
    for(let yy=3;yy<s.frameH-1;yy++) for(let xx=s.dx+1;xx<w-1;xx++) this.put(b,xx,yy,' ',{bg:LP.bg,fg:LP.fg});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh,{pal:LP});
    this.drawChat(b,1,s.chatW-2,s.frameH,false,{composerMeta:{model:'codex · gpt5.5 · high',ctx:87,caution:true}});
    this.dim(b,0,0,s.chatW,s.frameH); this.dim(b,s.px0,0,s.pw,s.frameH,LP);
    const pw=40, ph=11, px=w-pw-3, py=s.frameH-ph-1;
    this.fillRect(b,px,py,pw,ph,{ch:' ',bg:P.bg});
    this.box(b,px,py,pw,ph,{title:'preview · ^P',fg:P.amber,titleFg:P.amberHi,bg:P.bg});
    const lx=px+2; let y=py+2;
    this.text(b,lx,y,'theme',{fg:P.dim,bg:P.bg}); this.text(b,lx+8,y,'‹ light ›',{fg:P.amberHi,bg:P.bg,bold:true}); y++;
    this.text(b,lx,y,'size',{fg:P.dim,bg:P.bg}); this.text(b,lx+8,y,'‹ custom ›',{fg:P.amberHi,bg:P.bg,bold:true}); y+=2;
    this.text(b,lx,y,'W×H',{fg:P.dim,bg:P.bg});
    const iw=pw-11; this.box(b,lx+4,y,iw,3,{fg:P.red,bg:P.bg});
    this.text(b,lx+6,y+1,'banana',{fg:P.fg,bg:P.bg}); this.put(b,lx+6+6,y+1,'█',{fg:P.amber,blink:true,bg:P.bg});
    y+=3;
    this.text(b,lx,y,'⚠ use W×H, e.g. 100x30',{fg:P.red,bg:P.bg,bold:true}); y++;
    this.text(b,lx,y,'⏎ apply · esc close',{fg:P.faint,bg:P.bg});
    this.wsStatus(b,w,h,{combo:false,ctx:false,keys:[['^P','preview',true],['F3','tweaks'],['esc','close']]});
    return this.render(b); }

  // ---- 22 pin dropped in interactive mode ----
  wsInteractPin(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main'});
    this.drawFormDesign(b,s.dx,s.dy,s.dw,s.dh,false);
    const ddx=s.dx+s.dw-26, ddy=s.dy+6; const items=[['all statuses',false],['paid',false],['overdue',true],['draft',false],['void',false]]; const ddw=22, ddh=items.length+2;
    this.box(b,ddx,ddy,ddw,ddh,{title:'status ▾',fg:P.amber,titleFg:P.amberHi});
    items.forEach((it,i)=>{ const yy=ddy+1+i, sel=it[1]; if(sel) for(let k=1;k<ddw-1;k++) this.put(b,ddx+k,yy,' ',{bg:P.sel});
      this.put(b,ddx+1,yy,sel?'▸':' ',{fg:P.amber,bg:sel?P.sel:undefined,bold:true});
      this.text(b,ddx+3,yy,it[0],{fg:sel?P.selFg:P.fg,bg:sel?P.sel:undefined,bold:sel}); });
    this.chatSeq(b,0,s.chatW,s.frameH,{seq:this.baseSeq(), placeholder:'right-click to pin — no need to leave INTERACT', composerMeta:{model:'codex · gpt5.5 · high',ctx:42}});
    this.dim(b,0,0,w,s.frameH);
    const by=ddy+3, bx=ddx+3; this.badge(b,bx,by,3);
    const pw=40, pxs=s.dx+6, pys=by;
    this.fillRect(b,pxs,pys,pw,4,{ch:' ',bg:P.bg});
    this.box(b,pxs,pys,pw,3,{title:'new pin',fg:P.amber,titleFg:P.amberHi,bg:P.bg});
    this.text(b,pxs+2,pys+1,'default this to paid',{fg:P.fg,bg:P.bg}); this.put(b,pxs+2+20,pys+1,'█',{fg:P.amber,blink:true,bg:P.bg});
    this.text(b,pxs+1,pys+3,'⏎ save · esc cancel',{fg:P.faint,bg:P.bg});
    this.wsStatus(b,w,h,{combo:false,ctx:false,noSize:true,mode:{t:' INTERACT ',fg:P.bg,bg:P.amberHi,bold:true},keys:[['esc','cancel'],['rclick','pin',true],['F4','static']]});
    return this.render(b); }

  // ---- 23 slash menu · shared command registry ----
  commandRegistry(){ return [
    {cmd:'/new',    desc:'start a new chat'},
    {cmd:'/chats',  desc:'switch or list chats'},
    {cmd:'/export', desc:'write the export package'},
    {cmd:'/model',  desc:'agent · model · effort'},
    {cmd:'/commit-page',  desc:'current page · 1 file', dot:true},
    {cmd:'/commit-infra', desc:'infrastructure · clean', clean:true},
    {cmd:'/commit-all',   desc:'entire project · 7 files', dot:true} ]; }

  // The non-modal autocomplete popup, anchored directly above the composer.
  slashMenu(b,chatX,chatW,composerTop,typed,o){ o=o||{}; const P=this.pal;
    const all=this.commandRegistry();
    const rows=(typed==='/'?all:all.filter(c=>c.cmd.indexOf(typed)===0));
    const isCommit=c=>c.cmd.indexOf('/commit')===0;
    rows.forEach(c=>{ c._dis = !!c.clean || (o.turn && !isCommit(c)); });
    let selIdx=rows.findIndex(c=>!c._dis); if(selIdx<0) selIdx=0;
    const boxW=chatW-2, boxH=rows.length+2, bx=chatX+1, by=composerTop-boxH;
    this.fillRect(b,bx,by,boxW,boxH,{ch:' ',bg:P.bg});
    this.box(b,bx,by,boxW,boxH,{title:typed==='/'?'commands':typed,fg:P.amber,titleFg:P.amberHi,bg:P.bg});
    rows.forEach((c,i)=>{ const yy=by+1+i, sel=(i===selIdx), dis=c._dis;
      if(sel) for(let k=1;k<boxW-1;k++) this.put(b,bx+k,yy,' ',{bg:P.sel});
      this.put(b,bx+1,yy,sel?'▸':' ',{fg:dis?P.faint:P.amber,bg:sel?P.sel:P.bg,bold:true});
      this.put(b,bx+2,yy,c.dot?'●':' ',{fg:dis?P.faint:(sel?P.selFg:P.amber),bg:sel?P.sel:P.bg,bold:!dis});
      this.text(b,bx+3,yy,this.pad(c.cmd,13),{fg:dis?P.faint:(sel?P.selFg:P.fg),bg:sel?P.sel:P.bg,bold:sel&&!dis});
      this.text(b,bx+17,yy,c.desc,{fg:dis?P.faint:(sel?P.selFg:P.dim),bg:sel?P.sel:P.bg}); }); }

  wsSlash(w,h,typed,o){ o=o||{}; typed = (typeof typed==='string')?typed:(typed?'/ch':'/');
    const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main'});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh);
    const chatW=s.chatW, frameH=s.frameH, flt=(typed!=='/');
    const ctx=(o.ctx!==undefined)?o.ctx:(flt?87:42);
    const caution=(o.caution!==undefined)?o.caution:(ctx>=80);
    this.chatSeq(b,0,chatW,frameH,{seq:[
      {role:'❯ you'},{body:'build a system monitor with cpu / mem gauges'},{gap:1},
      {role:'● codex'},{status:'✓ updated network sparkline',c:P.dim} ], composerMeta:{model:'codex · gpt5.5 · high',ctx,caution}});
    const composerTop=frameH-4;
    for(let k=3;k<chatW-1;k++) this.put(b,k,composerTop+2,' ',{});
    this.text(b,1,composerTop+2,'❯ ',{fg:P.amber,bold:true});
    this.text(b,3,composerTop+2,typed,{fg:P.fg,bold:true}); this.put(b,3+typed.length,composerTop+2,'█',{fg:P.amber,blink:true});
    this.slashMenu(b,0,chatW,composerTop,typed,{});
    this.wsStatus(b,w,h,{combo:false,ctx:false,keys:[['F2','fullscreen'],['F3','tweaks'],['F4','interact']]});
    return this.render(b); }

  // ---- 24 chats ----
  wsChats(w,h){ const P=this.pal; const b=this.mk(w,h); const frameH=h-1; const chatW=Math.round(w*0.37); const div=chatW-1;
    this.box(b,0,0,chatW,frameH,{fg:P.line,titleFg:P.faint,title:'❯ chat · codex',titleBold:false});
    this.box(b,div,0,w-div,frameH,{fg:P.line});
    this.put(b,div,0,'┬',{fg:P.line}); this.put(b,div,frameH-1,'┴',{fg:P.line});
    this.text(b,div+2,1,'▸ Main',{fg:P.faint}); this.text(b,div+9,1,'  Settings',{fg:P.line});
    this.hline(b,div+1,2,w-div-2,{fg:P.line}); this.put(b,div,2,'├',{fg:P.line}); this.put(b,w-1,2,'┤',{fg:P.line});
    const gx=div, gw=w-div;
    this.text(b,gx+2,4,'system-monitor',{fg:P.line});
    this.box(b,gx,6,gw,7,{fg:P.line,title:'resources',titleFg:P.line,titleBold:false,tee:true});
    this.box(b,gx,14,gw,4,{fg:P.line,title:'network',titleFg:P.line,titleBold:false,tee:true});
    this.box(b,gx,19,gw,frameH-20,{fg:P.line,title:'processes',titleFg:P.line,titleBold:false,tee:true});
    this.text(b,2,2,'● codex',{fg:P.line}); this.text(b,2,4,'✓ updated network sparkline',{fg:P.line});
    this.put(b,0,frameH-4,'├',{fg:P.line}); this.hline(b,1,frameH-4,chatW-2,{fg:P.line}); this.put(b,chatW-1,frameH-4,'┤',{fg:P.line});
    this.text(b,2,frameH-4,' codex · gpt5.5 · high ',{fg:P.line});
    { const tag=' ctx 42% ', rx=chatW-2-tag.length; this.text(b,rx,frameH-4,tag,{fg:P.line}); }
    const pw=74, ph=13, pxs=Math.floor((w-pw)/2), pys=Math.floor((h-ph)/2)-1;
    this.fillRect(b,pxs-1,pys,pw+2,ph+1,{ch:' ',bg:P.bg});
    this.box(b,pxs,pys,pw,ph,{title:'chats',fg:P.amber,titleFg:P.amberHi,bg:P.bg});
    const lx=pxs+2; let ly=pys+2;
    this.text(b,lx,ly,this.pad('',3)+this.pad('CHAT',44)+'WHEN',{fg:P.faint,bold:true}); ly++;
    const chats=[
      ['build a system monitor with cpu / mem gauges','now',true],
      ['make the process table sortable','8m ago',false],
      ['try a 256-color palette variant','1h ago',false],
      ['login screen with a centered form','yesterday',false],
      ['first draft — kanban board','2d ago',false] ];
    chats.forEach(c=>{ const sel=c[2]; if(sel){ for(let k=1;k<pw-1;k++) this.put(b,pxs+k,ly,' ',{bg:P.sel}); }
      this.put(b,lx-1,ly, sel?'▸':' ',{fg:P.amber,bg:sel?P.sel:P.bg,bold:true});
      this.text(b,lx+1,ly, sel?'●':'○',{fg:sel?P.amber:P.dim,bg:sel?P.sel:P.bg});
      this.text(b,lx+3,ly,this.pad(c[0].length>41?c[0].slice(0,40)+'…':c[0],44),{fg:sel?P.selFg:P.fg,bg:sel?P.sel:P.bg,bold:sel});
      this.text(b,lx+47,ly,this.pad(c[1],pw-51),{fg:sel?P.selFg:P.dim,bg:sel?P.sel:P.bg}); ly++; });
    ly++;
    this.hline(b,pxs+1,ly,pw-2,{fg:P.line}); this.put(b,pxs,ly,'├',{fg:P.amber}); this.put(b,pxs+pw-1,ly,'┤',{fg:P.amber}); ly++;
    let fx=lx;
    this.text(b,fx,ly,'↑↓',{fg:P.amber,bold:true}); fx+=3; this.text(b,fx,ly,'select',{fg:P.dim}); fx+=9;
    this.put(b,fx,ly,'⏎',{fg:P.amber,bold:true}); fx+=2; this.text(b,fx,ly,'switch',{fg:P.dim}); fx+=9;
    this.text(b,fx,ly,'/new',{fg:P.amber,bold:true}); fx+=5; this.text(b,fx,ly,'fresh chat',{fg:P.dim}); fx+=13;
    this.text(b,fx,ly,'esc',{fg:P.amber,bold:true}); fx+=3; this.text(b,fx,ly,' close',{fg:P.dim});
    this.wsStatus(b,w,h,{combo:false,ctx:false,keys:[['F2','fullscreen'],['F3','tweaks'],['F4','interact']]});
    return this.render(b); }

  wsChatFresh(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main'});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh);
    const chatW=s.chatW, frameH=s.frameH, maxX=chatW-2;
    this.text(b,1,1,'● codex',{fg:P.green,bold:true}); this.ctext(b,9,1,'ratatui · connected',{fg:P.faint},maxX);
    const composerTop=frameH-4;
    const midY=Math.floor((3+composerTop)/2);
    const ph1='new chat — fresh context'; this.text(b,1+Math.max(0,Math.floor((chatW-2-ph1.length)/2)),midY,ph1,{fg:P.faint});
    const ph2='ask for a change to begin'; this.text(b,1+Math.max(0,Math.floor((chatW-2-ph2.length)/2)),midY+1,ph2,{fg:P.line});
    this.put(b,0,composerTop,'├',{fg:P.border}); this.hline(b,1,composerTop,chatW-2,{fg:P.border}); this.put(b,chatW-1,composerTop,'┤',{fg:P.border});
    this.text(b,2,composerTop,' codex · gpt5.5 · high ',{fg:P.amberHi,bold:true});
    { const tag=' ctx 3% ', rx=chatW-3-tag.length; this.text(b,rx,composerTop,' ctx ',{fg:P.faint,bg:P.bg}); this.text(b,rx+5,composerTop,'3% ',{fg:P.fg,bold:true,bg:P.bg}); }
    this.text(b,1,composerTop+2,'❯ ',{fg:P.amber,bold:true}); this.ctext(b,3,composerTop+2,'Ask for changes…',{fg:P.faint},maxX); this.put(b,3,composerTop+2,'█',{fg:P.amber,blink:true});
    this.wsStatus(b,w,h,{combo:false,ctx:false,keys:[['F2','fullscreen'],['F3','tweaks'],['F4','interact']]});
    return this.render(b); }

  // ---- v1 shared helpers (Git composition) ----
  insetBox(b,x,y,w,h,title,lines,o){ o=o||{}; const P=this.pal; const bg=o.bg||P.bg;
    this.fillRect(b,x,y,w,h,{ch:' ',bg});
    this.box(b,x,y,w,h,{title,fg:o.fg||P.amber,titleFg:o.titleFg||P.amberHi,bg});
    let yy=y+1; (lines||[]).forEach(l=>{ if(yy>=y+h-1) return; const t=typeof l==='string'?l:l.t;
      this.text(b,x+2,yy,t,{fg:(l&&l.fg)||P.fg,bold:!!(l&&l.bold),bg}); yy++; }); }

  v1Base(b,w,h,o){ o=o||{}; const P=this.pal;
    const s=this.paneShell(b,w,h,{right:o.right||'main · Current design',rightFg:o.rightFg||P.faint,rightBold:!!o.rightBold});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh,{dim:!!o.dim});
    this.chatSeq(b,0,s.chatW,s.frameH,{seq:o.seq||this.baseSeq(), scrollback:o.scrollback, attach:o.attach, attachFg:o.attachFg,
      composerDisabled:o.composerDisabled, placeholder:o.placeholder, composerMeta:{model:'codex · gpt5.5 · high',ctx:o.ctx!==undefined?o.ctx:42}});
    return s; }

  // Bottom status with the clickable source segment. Committing is invoked only
  // through the composer slash commands (/commit-page · /commit-infra · /commit-all).
  v1CommitStatus(b,w,h,o){ o=o||{}; const P=this.pal;
    const mode=o.mode||{t:' STATIC ',fg:P.amberHi,bg:P.line,bold:true};
    const seg={t:' main · '+(o.seg||'Current design · uncommitted')+' ',fg:P.amberHi,bold:true};
    this.statusBar(b,h-1,[mode,seg],o.keys||[['F2','full'],['F3','tweaks'],['F4','act']]); }

  // ---- 12 broken canonical source (repair turn) ----
  wsBrokenSource(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main · Current design · uncommitted',rightFg:P.amberHi,rightBold:true});
    const midY=s.dy+Math.floor(s.dh/2)-2;
    this.ctr(b,s.dx,s.dw,midY,'✗ could not render current design',{fg:P.red,bold:true});
    this.ctr(b,s.dx,s.dw,midY+2,'pages/main/page.tsx — Gate: unknown widget "GpuPanel"',{fg:P.fg});
    this.ctr(b,s.dx,s.dw,midY+3,'fix it in a repair turn — the composer stays open',{fg:P.faint});
    this.insetBox(b,s.dx+s.dw-38,s.dy+1,36,4,'restore (v1)',[
      {t:'usable git history found',fg:P.dim},
      {t:'⏎ Restore… a working commit',fg:P.amberHi} ]);
    this.chatSeq(b,0,s.chatW,s.frameH,{seq:[
      {role:'❯ you'},{body:'add a gpu temperature panel'},{gap:1},
      {role:'● codex'},{status:'✓ wrote main/page.tsx',c:P.dim},{gap:1},
      {system:'✗ current design failed Gate — preview unavailable',c:P.red} ],
      attach:'describe a fix — composer is enabled', attachFg:P.amberHi, placeholder:'fix the GpuPanel widget…', composerMeta:{model:'codex · gpt5.5 · high',ctx:44}});
    this.wsStatus(b,w,h,{combo:false,ctx:false,ver:'main · Current design · uncommitted',verFg:P.amberHi,verBold:true,
      hint:'preview error — composer enabled',hintFg:P.red,hintBg:P.redDim,mode:{t:' STATIC ',fg:P.amberHi,bg:P.line,bold:true},keys:[['F2','full'],['F3','tweaks']]});
    return this.render(b); }

  // ---- 25 commit commands (v1) ----
  // Composer shows /commit typed; the slash menu filters to the three commit commands.
  wsCommitCommands(w,h){ return this.wsSlash(w,h,'/commit',{ctx:44}); }

  wsCommitConfirm(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.v1Base(b,w,h,{dim:true,ctx:44});
    this.dim(b,0,0,w,s.frameH);
    const pw=58, ph=13, px=Math.floor((w-pw)/2), py=Math.floor((h-ph)/2)-1;
    this.fillRect(b,px,py,pw,ph,{ch:' ',bg:P.bg});
    this.box(b,px,py,pw,ph,{title:'commit · current page',fg:P.amber,titleFg:P.amberHi,bg:P.bg});
    const lx=px+3; let y=py+2;
    this.text(b,lx,y,'message',{fg:P.dim,bg:P.bg}); y++;
    this.box(b,lx,y,pw-6,3,{fg:P.amber,bg:P.bg});
    const msg='design(main): update System monitor'; this.text(b,lx+2,y+1,msg,{fg:P.fg,bg:P.bg}); this.put(b,lx+2+msg.length,y+1,'█',{fg:P.amber,blink:true,bg:P.bg}); y+=4;
    this.text(b,lx,y,'scope',{fg:P.dim,bg:P.bg}); this.text(b,lx+8,y,'current page',{fg:P.amberHi,bg:P.bg,bold:true}); y++;
    this.text(b,lx,y,'M .termcraft/pages/main/page.tsx',{fg:P.green,bg:P.bg}); y+=2;
    this.text(b,lx,y,'⏎ commit',{fg:P.amber,bold:true,bg:P.bg}); this.text(b,lx+9,y,'· esc cancel · empty msg disables',{fg:P.faint,bg:P.bg});
    this.insetBox(b,px+pw+2,py+1,26,7,'stale plan',[
      {t:'⚠ HEAD moved since',fg:P.amberHi},
      {t:'the preview',fg:P.amberHi},
      {t:'file plan refreshed —',fg:P.dim},
      {t:'confirm again to',fg:P.dim},
      {t:'commit',fg:P.dim} ]);
    this.v1CommitStatus(b,w,h,{seg:'Current design · uncommitted',keys:[['⏎','commit'],['esc','cancel']]});
    return this.render(b); }

  wsCommitTurn(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main · Current design',rightFg:P.faint});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh,{dim:true});
    this.ctr(b,s.dx,s.dw,s.dy+Math.floor(s.dh/2),'⠹ generating…',{fg:P.amber,bold:true});
    const chatW=s.chatW, frameH=s.frameH;
    this.chatSeq(b,0,chatW,frameH,{seq:[
      {role:'❯ you'},{body:'add a gpu temperature panel'},{gap:1},
      {role:'● codex'},{status:'⠹ generating design…',c:P.amber,bold:true},{status:'▸ writing widgets',c:P.fg},{gap:1},
      {system:'⚑ commit now records the applied design; the new apply may land as a fresh uncommitted change'},
      {system:'Restore is disabled until the turn finishes'} ],
      attach:'local commands only — /commit-* still run', attachFg:P.amberHi,
      composerMeta:{model:'codex · gpt5.5 · high',ctx:47}});
    const composerTop=frameH-4;
    for(let k=3;k<chatW-1;k++) this.put(b,k,composerTop+2,' ',{});
    this.text(b,1,composerTop+2,'❯ ',{fg:P.amber,bold:true});
    this.text(b,3,composerTop+2,'/',{fg:P.fg,bold:true}); this.put(b,4,composerTop+2,'█',{fg:P.amber,blink:true});
    this.slashMenu(b,0,chatW,composerTop,'/',{turn:true});
    this.wsStatus(b,w,h,{combo:false,ctx:false,mode:{t:' GENERATING ',fg:P.bg,bg:P.amber,bold:true},keys:[['esc','cancel']]});
    return this.render(b); }

  // ---- 26 explicit Restore (v1) ----
  wsRestoreConfirm(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.v1Base(b,w,h,{dim:true,ctx:42});
    this.dim(b,0,0,w,s.frameH);
    const pw=62, ph=13, px=Math.floor((w-pw)/2), py=Math.floor((h-ph)/2)-1;
    this.fillRect(b,px,py,pw,ph,{ch:' ',bg:P.bg});
    this.box(b,px,py,pw,ph,{title:'restore · main',fg:P.amber,titleFg:P.amberHi,bg:P.bg});
    const lx=px+3; let y=py+2;
    this.text(b,lx,y,'restore .termcraft/pages/main/page.tsx',{fg:P.fg,bg:P.bg}); y++;
    this.text(b,lx,y,'from a1b2c3d3e9f0c14b7',{fg:P.amberHi,bg:P.bg,bold:true}); this.text(b,lx+21,y,'(a1b2c3d)',{fg:P.dim,bg:P.bg}); y++;
    this.text(b,lx,y,'dröscher · 2h ago · "widen the process table"',{fg:P.dim,bg:P.bg}); y+=2;
    for(let k=1;k<pw-1;k++) this.put(b,px+k,y,' ',{bg:P.redDim});
    this.text(b,lx-1,y,'⚠ overwrites uncommitted design changes — no backup',{fg:P.red,bg:P.redDim,bold:true}); y+=2;
    this.text(b,lx,y,'⏎ restore',{fg:P.amber,bold:true,bg:P.bg}); this.text(b,lx+10,y,'· esc cancel',{fg:P.faint,bg:P.bg}); y++;
    this.text(b,lx,y,'disabled during a turn or when the source fails Gate',{fg:P.faint,bg:P.bg});
    this.insetBox(b,px+pw+2,py+1,25,7,'staged',[
      {t:'✗ page source is',fg:P.red,bold:true},
      {t:'staged — termcraft',fg:P.red},
      {t:'will not unstage it',fg:P.red},
      {t:'unstage, then',fg:P.faint},
      {t:'retry Restore',fg:P.faint} ]);
    this.v1CommitStatus(b,w,h,{seg:'Current design · uncommitted',keys:[['⏎','restore'],['esc','cancel']]});
    return this.render(b); }

  wsRestoreApplied(w,h){ const P=this.pal; const b=this.mk(w,h);
    this.v1Base(b,w,h,{seq:[
      {role:'❯ you'},{body:'widen the process table'},{gap:1},
      {role:'● codex'},{status:'✓ widened the process table',c:P.dim},{gap:1},
      {system:'⟲ restored main from a1b2c3d'},{gap:1},
      {system:'no commit created · branch and index unchanged',c:P.faint} ],
      attach:'restored — now an uncommitted change', attachFg:P.amberHi, ctx:42});
    this.v1CommitStatus(b,w,h,{seg:'Current design · uncommitted',keys:[['F2','full'],['F3','tweaks']]});
    return this.render(b); }

  wsRestoreRecordPending(w,h){ const P=this.pal; const b=this.mk(w,h);
    this.v1Base(b,w,h,{seq:[
      {role:'● codex'},{status:'✓ widened the process table',c:P.dim},{gap:1},
      {system:'⟲ restored main from a1b2c3d'},{gap:1},
      {system:'✗ couldn\u2019t append the restore record — disk full',c:P.red},
      {system:'the page is restored and active — only the record failed',c:P.faint},
      {system:'retry records into chat "system monitor"',c:P.faint} ],
      attach:'⏎ Retry record · records only, no rewrite', attachFg:P.amberHi, ctx:42});
    this.v1CommitStatus(b,w,h,{seg:'Current design · uncommitted',keys:[['⏎','retry record'],['esc','dismiss']]});
    return this.render(b); }

  // ---- 27 git availability & errors (v1) ----
  gitUnavailable(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.paneShell(b,w,h,{right:'main'});
    this.drawMonitor(b,s.dx,s.dy,s.dw,s.dh);
    this.chatSeq(b,0,s.chatW,s.frameH,{seq:[
      {role:'❯ you'},{body:'build a system monitor'},{gap:1},
      {role:'● codex'},{status:'✓ created page main',c:P.dim},{gap:1},
      {system:'git not found — history & commit unavailable',c:P.faint},
      {system:'design, tweaks, pins and export still work',c:P.faint} ],
      placeholder:'Ask for changes…', composerMeta:{model:'codex · gpt5.5 · high',ctx:22}});
    this.wsStatus(b,w,h,{combo:false,ctx:false,ver:'main',hint:'git off',hintFg:P.faint,hintBg:P.line,mode:{t:' STATIC ',fg:P.amberHi,bg:P.line,bold:true},keys:[['F2','full'],['F3','tweaks']]});
    return this.render(b); }

  wsGitEdge(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.v1Base(b,w,h,{dim:true,ctx:42});
    this.dim(b,0,0,w,s.frameH);
    const gx=s.dx+3, gy=s.dy+1, iw=Math.floor((s.dw-9)/2), ih=6;
    this.insetBox(b,gx,gy,iw,ih,'no commits',[
      {t:'history shows only',fg:P.dim},
      {t:'Current design · uncommitted',fg:P.amberHi},
      {t:'a commit scope may',fg:P.dim},
      {t:'create the root commit',fg:P.dim} ]);
    this.insetBox(b,gx+iw+3,gy,iw,ih,'detached HEAD',[
      {t:'browse + Restore work',fg:P.dim},
      {t:'commit confirmation adds',fg:P.dim},
      {t:'a second explicit warning',fg:P.amberHi} ]);
    this.insetBox(b,gx,gy+ih+1,iw,ih,'sequencer active',[
      {t:'merge / rebase / revert',fg:P.dim},
      {t:'commit controls disabled',fg:P.red},
      {t:'until the op finishes',fg:P.dim} ]);
    this.insetBox(b,gx+iw+3,gy+ih+1,iw,ih,'shallow clone',[
      {t:'local rows carry',fg:P.dim},
      {t:'partial history',fg:P.amberHi},
      {t:'no Fetch action',fg:P.dim} ]);
    this.v1CommitStatus(b,w,h,{seg:'Current design · uncommitted',mode:{t:' STATIC ',fg:P.amberHi,bg:P.line,bold:true},keys:[['esc','close']]});
    return this.render(b); }

  wsGitError(w,h){ const P=this.pal; const b=this.mk(w,h);
    const s=this.v1Base(b,w,h,{dim:true,ctx:42});
    this.dim(b,0,0,w,s.frameH);
    const pw=76, ph=16, px=Math.floor((w-pw)/2), py=Math.floor((h-ph)/2)-1;
    this.fillRect(b,px,py,pw,ph,{ch:' ',bg:P.bg});
    this.box(b,px,py,pw,ph,{title:'git error',fg:P.red,titleFg:P.red,bg:P.bg});
    const lx=px+3; let y=py+2;
    const rows=[
      ['identity','✗ no user.name / user.email — set them, then retry'],
      ['hook / signing','✗ pre-commit hook failed (exit 1) — commit aborted'],
      ['timeout','✗ git timed out after 10s — nothing was written'],
      ['corrupt object','✗ object 3c7d1a8 is corrupt — repository unreadable'],
      ['index lock','✗ index.lock held — another git is running'] ];
    rows.forEach(r=>{ this.text(b,lx,y,this.pad(r[0],15),{fg:P.faint,bg:P.bg,bold:true}); this.text(b,lx+15,y,r[1],{fg:P.red,bg:P.bg}); y++; });
    y++;
    this.text(b,lx,y,'index lock:',{fg:P.dim,bg:P.bg}); this.text(b,lx+12,y,'⏎ Retry',{fg:P.amber,bg:P.bg,bold:true}); y++;
    this.text(b,lx,y,'after a failed commit, status refreshes — hooks may edit files',{fg:P.faint,bg:P.bg});
    this.v1CommitStatus(b,w,h,{seg:'Current design · uncommitted',keys:[['esc','close']]});
    return this.render(b); }

  legendEl(){ const P=this.pal; const React = window.React;
    const sw=(c,l)=>React.createElement('div',{style:{display:'flex',alignItems:'center',gap:7}},
      React.createElement('span',{style:{width:14,height:14,borderRadius:3,background:c,border:'1px solid rgba(255,255,255,.08)'}}),
      React.createElement('span',{style:{color:P.dim,fontSize:11}},l));
    const col=(title,items)=>React.createElement('div',{style:{display:'flex',flexDirection:'column',gap:8}},
      React.createElement('span',{style:{color:P.faint,fontSize:10,letterSpacing:'.18em',textTransform:'uppercase'}},title),
      ...items);
    return React.createElement('div',{style:{display:'flex',gap:26}},
      col('accent',[sw(P.amber,'amber #e6a23c'),sw(P.amberHi,'focus #f6c163'),sw(P.sel,'selection')]),
      col('neutral',[sw(P.fg,'text'),sw(P.dim,'muted'),sw(P.faint,'faint')]),
      col('semantic',[sw(P.green,'ok'),sw(P.red,'error'),sw(P.bg,'bg #14110d')]) );
  }
}
