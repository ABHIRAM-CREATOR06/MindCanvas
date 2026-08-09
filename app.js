(() => {
  const $ = (s) => document.querySelector(s), canvas = $('#canvas');
  // desynchronized:true skips compositor sync — cuts ~1 frame of stylus latency on supported browsers
  const ctx = canvas.getContext('2d', { desynchronized: true });
  // Overlay canvas for S Pen hover cursor — sits on top of the drawing canvas
  const overlay = document.getElementById('overlay'), octx = overlay.getContext('2d', { desynchronized: true });
  // Offscreen canvas: committed strokes are pre-baked here so live drawing only appends one segment
  const offscreen = document.createElement('canvas'), offCtx = offscreen.getContext('2d');
  const KEY = 'mindcanvas-v2', SNAP_KEY = 'mindcanvas-snapshots-v1', VAULT_KEY = 'mindcanvas-vault-v1';
  const state = { objects: [], undone: [], snapshots: [], camera: { x: 0, y: 0, zoom: 1 }, tool: 'pen', color: '#171717', size: 4, shape: 'line', drawing: null, pan: null, moving: null, selected: new Set(), exportType: 'png', vault: { enabled: false, key: null }, writeChain: Promise.resolve(), stylusUntil: 0, ignoredPointers: new Set(), activeDrawPointer: null, pinch: null, barrelPan: null, touchSlop: null, rafPending: false };
  // RAF guard: coalesce all event-driven renders into one rAF callback per frame
  function scheduleRender(){
    if(state.rafPending)return
    state.rafPending=true
    requestAnimationFrame(()=>{state.rafPending=false;render()})
  }
  const screen = (p) => ({x:p.x * state.camera.zoom + state.camera.x,y:p.y * state.camera.zoom + state.camera.y});
  const screenFor = (p, camera) => ({x:p.x * camera.zoom + camera.x,y:p.y * camera.zoom + camera.y});
  const world = (p) => ({x:(p.x - state.camera.x) / state.camera.zoom,y:(p.y - state.camera.y) / state.camera.zoom});
  const mouse = (e) => ({x:e.clientX,y:e.clientY});
  const clone = (x) => JSON.parse(JSON.stringify(x));
  function resize(){
    const r=devicePixelRatio||1
    canvas.width=innerWidth*r;canvas.height=innerHeight*r
    canvas.style.width=innerWidth+'px';canvas.style.height=innerHeight+'px'
    canvas.style.touchAction='none'
    ctx.setTransform(r,0,0,r,0,0)
    offscreen.width=innerWidth*r;offscreen.height=innerHeight*r
    offCtx.setTransform(r,0,0,r,0,0)
    overlay.width=innerWidth*r;overlay.height=innerHeight*r
    overlay.style.width=innerWidth+'px';overlay.style.height=innerHeight+'px'
    octx.setTransform(r,0,0,r,0,0)
    rebakeOffscreen()
    render()
  }
  function bounds(o){if(o.type==='text')return{x:o.x,y:o.y-o.size,w:o.text.length*o.size*.58,h:o.size*1.3};if(o.type==='shape')return{x:Math.min(o.start.x,o.end.x)-o.size,y:Math.min(o.start.y,o.end.y)-o.size,w:Math.abs(o.end.x-o.start.x)+2*o.size,h:Math.abs(o.end.y-o.start.y)+2*o.size};const xs=o.points.map(p=>p.x),ys=o.points.map(p=>p.y);return{x:Math.min(...xs)-o.size,y:Math.min(...ys)-o.size,w:Math.max(...xs)-Math.min(...xs)+2*o.size,h:Math.max(...ys)-Math.min(...ys)+2*o.size}}
  function isVisible(o){const b=bounds(o),z=state.camera.zoom;return b.x*z+state.camera.x<innerWidth+32 && (b.x+b.w)*z+state.camera.x>-32 && b.y*z+state.camera.y<innerHeight+32 && (b.y+b.h)*z+state.camera.y>-32}
  function grid(){const gap=32*state.camera.zoom;if(gap<12)return;ctx.beginPath();ctx.strokeStyle='#ebeae5';ctx.lineWidth=1;for(let x=state.camera.x%gap;x<innerWidth;x+=gap){ctx.moveTo(x,0);ctx.lineTo(x,innerHeight)}for(let y=state.camera.y%gap;y<innerHeight;y+=gap){ctx.moveTo(0,y);ctx.lineTo(innerWidth,y)}ctx.stroke()}
  // Paint a completed stroke/shape/text object.
  // When painting a stroke, each segment uses the pressure stored in point.p (0–1, default 1).
  function paint(o,target=ctx,camera=state.camera){
    if(o.type==='text'){target.fillStyle=o.color;target.font=`${o.size*camera.zoom}px Inter, sans-serif`;target.fillText(o.text,o.x*camera.zoom+camera.x,o.y*camera.zoom+camera.y);return}
    if(o.type==='shape'){const a=screenFor(o.start,camera),b=screenFor(o.end,camera);target.beginPath();if(o.shape==='line'){target.moveTo(a.x,a.y);target.lineTo(b.x,b.y)}else if(o.shape==='rectangle')target.rect(Math.min(a.x,b.x),Math.min(a.y,b.y),Math.abs(b.x-a.x),Math.abs(b.y-a.y));else target.ellipse((a.x+b.x)/2,(a.y+b.y)/2,Math.abs(b.x-a.x)/2,Math.abs(b.y-a.y)/2,0,0,Math.PI*2);target.strokeStyle=o.color;target.lineWidth=o.size*camera.zoom;target.stroke();return}
    if(o.points.length<2)return
    const baseWidth=o.size*camera.zoom*(o.tool==='brush'?1.75:1)
    target.lineCap='round';target.lineJoin='round'
    target.globalAlpha=o.tool==='highlighter'?.24:o.tool==='brush'?.55:1
    target.strokeStyle=o.color
    // Pressure-sensitive rendering: each segment gets its own lineWidth from stored pressure
    let prev=o.points[0]
    for(let i=1;i<o.points.length;i++){
      const pt=o.points[i]
      const pressure=((prev.p||1)+(pt.p||1))/2  // average adjacent pressures
      target.beginPath()
      target.lineWidth=Math.max(0.5,baseWidth*pressure)
      target.moveTo(prev.x*camera.zoom+camera.x,prev.y*camera.zoom+camera.y)
      target.lineTo(pt.x*camera.zoom+camera.x,pt.y*camera.zoom+camera.y)
      target.stroke()
      prev=pt
    }
    target.globalAlpha=1
  }
  // Bake all committed objects into the offscreen canvas.
  // Called after every commit/undo/redo/clear/restore so live drawing can skip full re-render.
  function rebakeOffscreen(){
    offCtx.clearRect(0,0,offscreen.width,offscreen.height)
    state.objects.forEach(o=>{if(isVisible(o))paint(o,offCtx)})
  }
  // Full render: blit the offscreen bake, draw the live stroke on top, then overlays.
  function render(){
    ctx.clearRect(0,0,innerWidth,innerHeight)
    grid()
    ctx.drawImage(offscreen,0,0,offscreen.width,offscreen.height,0,0,innerWidth,innerHeight)
    if(state.drawing){
      if(state.drawing.type==='lasso'){let d=state.drawing;ctx.strokeStyle='#4b4b46';ctx.setLineDash([5,5]);ctx.strokeRect(d.start.x,d.start.y,d.end.x-d.start.x,d.end.y-d.start.y);ctx.setLineDash([])}
      else paint(state.drawing)
    }
    state.selected.forEach(i=>{const o=state.objects[i];if(!o)return;const b=bounds(o),z=state.camera.zoom;ctx.strokeStyle='#222';ctx.setLineDash([4,3]);ctx.strokeRect(b.x*z+state.camera.x-5,b.y*z+state.camera.y-5,b.w*z+10,b.h*z+10);ctx.setLineDash([])})
    $('#zoomLabel').textContent=Math.round(state.camera.zoom*100)+'%'
  }
  const bytesToBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
  const base64ToBytes = (text) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
  async function deriveKey(passphrase, salt){const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(passphrase),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:600000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
  async function encryptPayload(payload, key, salt){const iv=crypto.getRandomValues(new Uint8Array(12));const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(payload));return {version:1,kdf:'PBKDF2-SHA-256',iterations:600000,salt:bytesToBase64(salt),iv:bytesToBase64(iv),ciphertext:bytesToBase64(new Uint8Array(encrypted))}}
  async function decryptPayload(envelope, key){const data=await crypto.subtle.decrypt({name:'AES-GCM',iv:base64ToBytes(envelope.iv)},key,base64ToBytes(envelope.ciphertext));return JSON.parse(new TextDecoder().decode(data))}
  function updateVaultButton(){const b=$('#vaultButton');b.textContent=state.vault.enabled?(state.vault.key?'Lock':'Unlock'):'Encrypt';b.title=state.vault.enabled?'Lock or unlock this encrypted device':'Encrypt local canvas data'}
  function persist(){const payload=JSON.stringify({objects:state.objects,camera:state.camera,snapshots:state.snapshots});if(state.vault.enabled&&state.vault.key){state.writeChain=state.writeChain.then(async()=>localStorage.setItem(VAULT_KEY,JSON.stringify(await encryptPayload(payload,state.vault.key,state.vault.salt)))).then(()=>$('#saveStatus').textContent='Saved locally · Encrypted').catch(()=>toast('Unable to encrypt local save'))}else if(!state.vault.enabled){localStorage.setItem(KEY,JSON.stringify({objects:state.objects,camera:state.camera}));localStorage.setItem(SNAP_KEY,JSON.stringify(state.snapshots));$('#saveStatus').textContent='Saved locally'}$('#hint').classList.toggle('hidden',!!state.objects.length);$('#undoButton').disabled=!state.objects.length;$('#redoButton').disabled=!state.undone.length;updateVaultButton()}
  function commit(o){if(o)state.objects.push(o);state.undone=[];rebakeOffscreen();persist();render()}
  function tool(t){state.tool=t;state.selected.clear();document.querySelectorAll('.tool').forEach(b=>b.classList.toggle('active',b.dataset.tool===t));canvas.style.cursor=t==='hand'?'grab':t==='text'?'text':t==='eraser'?'cell':'crosshair';render()}
  function zoom(f,p={x:innerWidth/2,y:innerHeight/2}){const before=world(p);state.camera.zoom=Math.max(.1,Math.min(8,state.camera.zoom*f));state.camera.x=p.x-before.x*state.camera.zoom;state.camera.y=p.y-before.y*state.camera.zoom;rebakeOffscreen();persist();render()}
  function objectAt(p){for(let i=state.objects.length-1;i>=0;i--){let b=bounds(state.objects[i]);if(p.x>=b.x&&p.x<=b.x+b.w&&p.y>=b.y&&p.y<=b.y+b.h)return i}return -1}
  function deleteSelection(){if(!state.selected.size)return;const chosen=[...state.selected].sort((a,b)=>b-a);chosen.forEach(i=>state.undone.push(state.objects.splice(i,1)[0]));state.selected.clear();rebakeOffscreen();persist();render();toast('Selection deleted')}
  function erase(p){const i=objectAt(p);if(i>=0){state.undone.push(state.objects.splice(i,1)[0]);rebakeOffscreen();persist();render()}}
  // S Pen hover cursor — draw a precision ring on the overlay canvas
  function drawHoverCursor(x,y){
    octx.clearRect(0,0,overlay.width,overlay.height)
    const r=8
    octx.beginPath();octx.arc(x,y,r,0,Math.PI*2)
    octx.strokeStyle='rgba(0,0,0,0.55)';octx.lineWidth=1.5;octx.stroke()
    octx.beginPath();octx.arc(x,y,1.5,0,Math.PI*2)
    octx.fillStyle='rgba(0,0,0,0.7)';octx.fill()
  }
  function clearHoverCursor(){octx.clearRect(0,0,overlay.width,overlay.height)}
  function isPalmContact(e){
    const w=e.width||0,h=e.height||0
    // Lower threshold for mid-stroke monitoring (30×30 or area>800)
    // because a palm that landed with small initial area will have grown by now
    return (w>=30&&h>=30)||(w*h>800)
  }
  function ignorePalm(e){
    // Stylus (pen) — never ignore, but stamp the suppression window aggressively
    if(e.pointerType==='pen'){state.stylusUntil=Date.now()+1400;return false}
    // Everything below is touch
    if(e.pointerType!=='touch')return false
    // A second finger while a pinch is active is handled by pinch logic, not ignored
    if(state.pinch)return false
    // A second finger while we already own a drawing pointer → handled in pointerdown
    if(state.activeDrawPointer!==null&&state.activeDrawPointer!==e.pointerId)return false
    // Large contact area at landing = palm.  Use original 40×40 threshold at pointerdown.
    const w=e.width||0,h=e.height||0
    if((w>=40&&h>=40)||(w*h>1000))return true
    // Stylus was used recently → suppress rogue touch
    if(Date.now()<state.stylusUntil)return true
    return false
  }
  function selectBox(a,b){state.selected.clear();state.objects.forEach((o,i)=>{let q=bounds(o);if(q.x+q.w>=a.x&&q.x<=b.x&&q.y+q.h>=a.y&&q.y<=b.y)state.selected.add(i)});render()}
  canvas.addEventListener('pointerdown',e=>{
    // --- S Pen barrel button (buttons===2): temporary pan regardless of current tool ---
    if(e.pointerType==='pen'&&(e.buttons&2)){
      canvas.setPointerCapture(e.pointerId)
      state.barrelPan={p:mouse(e),c:{...state.camera}}
      return
    }
    if(e.button!==0)return
    // Pen hover: buttons===0 or primary button not held, or zero pressure → reject
    if(e.pointerType==='pen'&&(!(e.buttons&1)||e.pressure===0))return
    clearHoverCursor()
    // --- Pinch-to-zoom: second touch finger while first is already active ---
    if(e.pointerType==='touch'&&state.activeDrawPointer!==null&&state.activeDrawPointer!==e.pointerId){
      // Only allow pinch if the first pointer is also touch (not pen)
      canvas.setPointerCapture(e.pointerId)
      const p1=state.pinch?.p1||{x:0,y:0} // we'll fill from existing move state
      const p2=mouse(e)
      // Grab the first pointer's current position from the draw state's last known point
      const firstPos=state._lastPos||p2
      state.pinch={p1:firstPos,p2,dist:Math.hypot(p2.x-firstPos.x,p2.y-firstPos.y),camSnap:{...state.camera},mid:{x:(p2.x+firstPos.x)/2,y:(p2.y+firstPos.y)/2}}
      // Freeze any in-progress drawing stroke (don't commit it — discard)
      state.drawing=null;state.pan=null;state.moving=null
      return
    }
    if(ignorePalm(e)){state.ignoredPointers.add(e.pointerId);return}
    canvas.setPointerCapture(e.pointerId)
    state.activeDrawPointer=e.pointerId
    const p=mouse(e),w=world(p)
    state._lastPos=p
    if(state.tool==='hand'||e.shiftKey){state.pan={p,c:{...state.camera}};return}
    if(state.tool==='text')return editor(p,w)
    // --- Touch slop: don't commit a stroke/erase/lasso immediately for touch events.
    // A resting palm barely moves, so it will never escape the slop zone.
    // A deliberate drawing touch crosses 10px quickly with no perceptible delay.
    if(e.pointerType==='touch'){
      state.touchSlop={px:p.x,py:p.y,w,tool:state.tool}
      return
    }
    // Pen: start gesture immediately (no slop needed, pen was validated above)
    if(state.tool==='eraser')return erase(w)
    if(state.tool==='lasso'){const hit=objectAt(w);if(hit>=0&&state.selected.has(hit)){state.moving={at:w,objects:[...state.selected]};return}state.drawing={type:'lasso',start:p,end:p};return render()}
    if(state.tool==='shape'){state.drawing={type:'shape',shape:state.shape,color:state.color,size:state.size,start:w,end:w};return}
    state.drawing={type:'stroke',tool:state.tool,color:state.color,size:state.size,points:[{x:w.x,y:w.y,p:e.pressure||1}]}
  });
  canvas.addEventListener('pointermove',e=>{
    if(state.ignoredPointers.has(e.pointerId))return
    const p=mouse(e)
    // --- S Pen barrel button pan ---
    if(state.barrelPan&&e.pointerType==='pen'){
      state.camera.x=state.barrelPan.c.x+p.x-state.barrelPan.p.x
      state.camera.y=state.barrelPan.c.y+p.y-state.barrelPan.p.y
      return render()
    }
    if(e.pointerType==='pen'){
      // Pen lifted (hover) or zero pressure → show hover cursor, cancel any active gesture
      if(!(e.buttons&1)||e.pressure===0){
        drawHoverCursor(p.x,p.y)
        if(state.drawing||state.pan||state.moving){
          state.drawing=null;state.pan=null;state.moving=null
          if(state.activeDrawPointer===e.pointerId)state.activeDrawPointer=null
          render()
        }
        return
      }
      clearHoverCursor()
      state.stylusUntil=Date.now()+1400
    }
    // --- Continuous palm-area monitoring for touch:
    // The browser often reports a small initial contact area that grows as the palm settles.
    // If a touch that got through pointerdown now looks like a palm, cancel it.
    if(e.pointerType==='touch'&&e.pointerId===state.activeDrawPointer&&isPalmContact(e)){
      state.touchSlop=null
      state.drawing=null;state.pan=null;state.moving=null
      state.ignoredPointers.add(e.pointerId)
      state.activeDrawPointer=null
      render()
      return
    }
    // --- Touch slop graduation: start the actual gesture once the finger has moved >=10px ---
    if(state.touchSlop&&e.pointerId===state.activeDrawPointer){
      const dx=p.x-state.touchSlop.px,dy=p.y-state.touchSlop.py
      if(Math.hypot(dx,dy)<10)return // still inside slop zone, do nothing
      // Graduated — now start the real gesture from the original touch-down world position
      const slop=state.touchSlop;state.touchSlop=null
      const sw=slop.w // world-space start position
      if(slop.tool==='hand'){state.pan={p:{x:slop.px,y:slop.py},c:{...state.camera}};}
      else if(slop.tool==='eraser'){erase(sw)}
      else if(slop.tool==='lasso'){const hit=objectAt(sw);if(hit>=0&&state.selected.has(hit)){state.moving={at:sw,objects:[...state.selected]}}else{state.drawing={type:'lasso',start:{x:slop.px,y:slop.py},end:{x:slop.px,y:slop.py}}}}
      else if(slop.tool==='shape'){state.drawing={type:'shape',shape:state.shape,color:state.color,size:state.size,start:sw,end:sw}}
      else{state.drawing={type:'stroke',tool:slop.tool,color:state.color,size:state.size,points:[{x:sw.x,y:sw.y,p:1}]}}
      // fall through to continue processing this move event normally
    }
    // --- Pinch-to-zoom + pan ---
    if(state.pinch){
      if(e.pointerId===state.activeDrawPointer){
        state.pinch.p1=p;state._lastPos=p
      } else {
        state.pinch.p2=p
      }
      const {p1,p2}=state.pinch
      const newDist=Math.hypot(p2.x-p1.x,p2.y-p1.y)
      const newMid={x:(p1.x+p2.x)/2,y:(p1.y+p2.y)/2}
      if(state.pinch.dist>0){
        // Scale factor relative to when pinch started
        const scale=newDist/state.pinch.dist
        // Apply zoom centred on the current midpoint
        const before=world(newMid) // world coord under midpoint before zoom change
        state.camera.zoom=Math.max(.1,Math.min(8,state.pinch.camSnap.zoom*scale))
        state.camera.x=newMid.x-before.x*state.camera.zoom
        state.camera.y=newMid.y-before.y*state.camera.zoom
        // Also translate for pan (mid-point movement)
        const dx=newMid.x-state.pinch.mid.x,dy=newMid.y-state.pinch.mid.y
        state.camera.x+=dx;state.camera.y+=dy
      }
      state.pinch.mid=newMid
      return render()
    }
    // Track last position for pinch initialisation
    if(e.pointerId===state.activeDrawPointer)state._lastPos=p
    if(state.pan){state.camera.x=state.pan.c.x+p.x-state.pan.p.x;state.camera.y=state.pan.c.y+p.y-state.pan.p.y;return render()}
    if(state.moving){const w=world(p),dx=w.x-state.moving.at.x,dy=w.y-state.moving.at.y;state.moving.objects.forEach(i=>{const o=state.objects[i];if(o.type==='text'){o.x+=dx;o.y+=dy}else if(o.type==='shape'){o.start.x+=dx;o.start.y+=dy;o.end.x+=dx;o.end.y+=dy}else o.points.forEach(q=>{q.x+=dx;q.y+=dy})});state.moving.at=w;return render()}
    if(state.tool==='eraser'&&(e.buttons&1)&&e.pointerId===state.activeDrawPointer)return erase(world(p))
    if(!state.drawing)return
    if(state.drawing.type==='lasso'){state.drawing.end=p;return scheduleRender()}
    if(state.drawing.type==='shape'){state.drawing.end=world(p);return scheduleRender()}
    // --- Coalesced events: capture every stylus sample between frames (up to 240Hz on S Pen)
    const events=e.getCoalescedEvents?e.getCoalescedEvents():[e]
    for(const ce of events){
      const cp=mouse(ce)
      state.drawing.points.push({x:(cp.x-state.camera.x)/state.camera.zoom,y:(cp.y-state.camera.y)/state.camera.zoom,p:ce.pressure||1})
    }
    // --- Predicted events: extend the stroke with browser-predicted future positions
    // for lower perceived latency; these points are discarded next frame (not persisted)
    const predicted=e.getPredictedEvents?e.getPredictedEvents():[]
    const predPoints=predicted.map(pe=>{
      const pp=mouse(pe)
      return {x:(pp.x-state.camera.x)/state.camera.zoom,y:(pp.y-state.camera.y)/state.camera.zoom,p:pe.pressure||state.drawing.points[state.drawing.points.length-1]?.p||1,predicted:true}
    })
    // Paint: blit offscreen bake, then full live stroke (including predictions) in one pass
    ctx.clearRect(0,0,innerWidth,innerHeight)
    grid()
    ctx.drawImage(offscreen,0,0,offscreen.width,offscreen.height,0,0,innerWidth,innerHeight)
    if(predPoints.length){
      const withPred={...state.drawing,points:[...state.drawing.points,...predPoints]}
      paint(withPred)
    } else {
      paint(state.drawing)
    }
  });
  function releasePointer(id){
    if(state.activeDrawPointer===id)state.activeDrawPointer=null
    state.ignoredPointers.delete(id)
  }
  canvas.addEventListener('pointerup',e=>{
    // Barrel pan release
    if(state.barrelPan&&e.pointerType==='pen'){state.barrelPan=null;persist();return}
    if(state.ignoredPointers.has(e.pointerId)){releasePointer(e.pointerId);return}
    if(e.pointerType==='pen')state.stylusUntil=Date.now()+1400
    // Pinch release: if one of the two pinch fingers lifts, end pinch
    if(state.pinch){
      state.pinch=null
      releasePointer(e.pointerId)
      persist()
      return render()
    }
    releasePointer(e.pointerId)
    // If finger lifted before crossing the slop threshold, treat as tap — no stroke
    if(state.touchSlop){state.touchSlop=null;return}
    if(state.pan){state.pan=null;persist();return}
    if(state.moving){state.moving=null;persist();return}
    if(!state.drawing)return
    if(state.drawing.type==='lasso'){const d=state.drawing,a=world({x:Math.min(d.start.x,d.end.x),y:Math.min(d.start.y,d.end.y)}),b=world({x:Math.max(d.start.x,d.end.x),y:Math.max(d.start.y,d.end.y)});state.drawing=null;return selectBox(a,b)}
    const o=state.drawing;state.drawing=null
    if(o.type==='shape')return(Math.abs(o.end.x-o.start.x)+Math.abs(o.end.y-o.start.y)>2?commit(o):render())
    o.points.length>1?commit(o):render()
  })
  canvas.addEventListener('pointerleave',e=>{
    if(e.pointerType==='pen')clearHoverCursor()
  })
  canvas.addEventListener('pointercancel',e=>{
    if(state.pinch)state.pinch=null
    state.barrelPan=null
    state.touchSlop=null
    releasePointer(e.pointerId)
    state.drawing=null;state.pan=null;state.moving=null
    render()
  })
  canvas.addEventListener('wheel',e=>{e.preventDefault();zoom(e.deltaY<0?1.12:1/1.12,mouse(e))},{passive:false});
  function editor(p,w){const e=$('#textEditor');e.style.left=p.x+'px';e.style.top=p.y+'px';e.style.fontSize=(18*state.camera.zoom)+'px';e.hidden=false;e.textContent='';e.focus();const done=()=>{const text=e.textContent.trim();e.hidden=true;if(text)commit({type:'text',x:w.x,y:w.y,color:state.color,size:18,text});e.removeEventListener('blur',done)};e.addEventListener('blur',done);e.onkeydown=x=>{if(x.key==='Escape'){e.textContent='';e.blur()}if(x.key==='Enter'&&!x.shiftKey){x.preventDefault();e.blur()}}}
  function area(){const selected=[...state.selected].map(i=>state.objects[i]).filter(Boolean);const mode=document.querySelector('[name="exportArea"]:checked').value;if(mode==='selection'&&selected.length){const bs=selected.map(bounds),x=Math.min(...bs.map(b=>b.x)),y=Math.min(...bs.map(b=>b.y)),r=Math.max(...bs.map(b=>b.x+b.w)),bt=Math.max(...bs.map(b=>b.y+b.h));return{objects:selected,camera:{x:-x+24,y:-y+24,zoom:1},w:Math.ceil(r-x+48),h:Math.ceil(bt-y+48)}}if(mode==='canvas'&&state.objects.length){const bs=state.objects.map(bounds),x=Math.min(...bs.map(b=>b.x)),y=Math.min(...bs.map(b=>b.y)),r=Math.max(...bs.map(b=>b.x+b.w)),bt=Math.max(...bs.map(b=>b.y+b.h));return{objects:state.objects,camera:{x:-x+32,y:-y+32,zoom:1},w:Math.ceil(r-x+64),h:Math.ceil(bt-y+64)}}return{objects:state.objects,camera:{x:state.camera.x,y:state.camera.y,zoom:state.camera.zoom},w:innerWidth,h:innerHeight}}
  function exportCanvas(){const a=area(),scale=$('#highResolution').checked?2:1,c=document.createElement('canvas'),x=c.getContext('2d');c.width=a.w*scale;c.height=a.h*scale;x.scale(scale,scale);if(!$('#transparentBackground').checked){x.fillStyle='#f7f7f4';x.fillRect(0,0,a.w,a.h)}a.objects.forEach(o=>paint(o,x,a.camera));return{canvas:c,area:a}}
  function download(name,type,data){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500);toast('Export complete')}
  function svg(a){let s=`<svg xmlns="http://www.w3.org/2000/svg" width="${a.w}" height="${a.h}" viewBox="0 0 ${a.w} ${a.h}">`;a.objects.forEach(o=>{if(o.type==='text')s+=`<text x="${o.x+a.camera.x}" y="${o.y+a.camera.y}" font-size="${o.size}" fill="${o.color}">${o.text.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</text>`;else if(o.type==='shape'){const x=Math.min(o.start.x,o.end.x)+a.camera.x,y=Math.min(o.start.y,o.end.y)+a.camera.y,w=Math.abs(o.end.x-o.start.x),h=Math.abs(o.end.y-o.start.y);s+=o.shape==='line'?`<path d="M ${o.start.x+a.camera.x} ${o.start.y+a.camera.y} L ${o.end.x+a.camera.x} ${o.end.y+a.camera.y}" fill="none" stroke="${o.color}" stroke-width="${o.size}"/>`:o.shape==='rectangle'?`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${o.color}" stroke-width="${o.size}"/>`:`<ellipse cx="${x+w/2}" cy="${y+h/2}" rx="${w/2}" ry="${h/2}" fill="none" stroke="${o.color}" stroke-width="${o.size}"/>`}else s+=`<path d="M ${o.points.map(p=>(p.x+a.camera.x)+' '+(p.y+a.camera.y)).join(' L ')}" fill="none" stroke="${o.color}" stroke-width="${o.size*(o.tool==='brush'?1.75:1)}" stroke-linecap="round" opacity="${o.tool==='highlighter'?'.24':'1'}"/>`});return s+'</svg>'}
  function printPdf(c){const win=open('','_blank');if(!win)return toast('Allow pop-ups to save a PDF');win.document.write(`<title>MindCanvas export</title><img src="${c.toDataURL('image/png')}" style="max-width:100%;display:block;margin:auto">`);win.document.close();win.focus();win.print();toast('Choose “Save as PDF” in the print dialog')}
  function runExport(){const type=state.exportType,a=area();if(type==='json')return download('mindcanvas.json','application/json',JSON.stringify({version:1,objects:a.objects},null,2));if(type==='svg')return download('mindcanvas.svg','image/svg+xml',svg(a));const c=exportCanvas().canvas;if(type==='pdf')return printPdf(c);c.toBlob(b=>download(`mindcanvas.${type}`,type==='jpg'?'image/jpeg':'image/png',b),type==='jpg'?'image/jpeg':'image/png',.94)}
  function snapshot(){state.snapshots.unshift({id:crypto.randomUUID(),at:new Date().toLocaleString(),objects:clone(state.objects),camera:clone(state.camera)});state.snapshots=state.snapshots.slice(0,20);if(!state.vault.enabled)localStorage.setItem(SNAP_KEY,JSON.stringify(state.snapshots));persist();timeline();toast('Snapshot saved')}
  function timeline(){const root=$('#timeline');root.innerHTML=state.snapshots.length?'':'<p>No snapshots yet.</p>';state.snapshots.forEach(s=>{const row=document.createElement('div');row.className='snapshot-row';const details=document.createElement('span');details.innerHTML=`${s.at}<small>${s.objects.length} objects</small>`;const actions=document.createElement('span');actions.className='snapshot-actions';const restore=document.createElement('button');restore.type='button';restore.textContent='Restore';restore.onclick=()=>{if(confirm('Restore this snapshot? Current work will be replaced.')){state.objects=clone(s.objects);state.camera=clone(s.camera);state.undone=[];rebakeOffscreen();persist();render();$('#historyDialog').close();toast('Snapshot restored')}};const remove=document.createElement('button');remove.type='button';remove.className='danger-button';remove.textContent='Remove';remove.onclick=()=>{if(confirm('Remove this snapshot? This cannot be undone.')){state.snapshots=state.snapshots.filter(x=>x.id!==s.id);persist();timeline();toast('Snapshot removed')}};actions.append(restore,remove);row.append(details,actions);root.append(row)})}
  function toast(t){const x=$('#toast');x.textContent=t;x.classList.add('visible');setTimeout(()=>x.classList.remove('visible'),1600)}
  function showVault(mode){const unlock=mode==='unlock';$('#vaultTitle').textContent=unlock?'Unlock MindCanvas':'Encrypt this device';$('#vaultDescription').textContent=unlock?'Enter your passphrase to decrypt local canvas data. The passphrase is never stored.':'Create a passphrase to encrypt all local canvas data. It cannot be recovered if forgotten.';$('#confirmPassphraseLabel').hidden=unlock;$('#vaultConfirmation').required=!unlock;$('#vaultSubmit').textContent=unlock?'Unlock':'Encrypt data';$('#vaultError').textContent='';$('#vaultPassphrase').value='';$('#vaultConfirmation').value='';$('#vaultDialog').dataset.mode=mode;$('#vaultDialog').showModal();setTimeout(()=>$('#vaultPassphrase').focus(),0)}
  async function submitVault(event){event.preventDefault();const passphrase=$('#vaultPassphrase').value,mode=$('#vaultDialog').dataset.mode,error=$('#vaultError');error.textContent='';if(passphrase.length<12){error.textContent='Use a passphrase of at least 12 characters.';return}try{if(mode==='unlock'){const envelope=JSON.parse(localStorage.getItem(VAULT_KEY));const salt=base64ToBytes(envelope.salt),key=await deriveKey(passphrase,salt),data=await decryptPayload(envelope,key);state.vault={enabled:true,key,salt};state.objects=data.objects||[];state.camera=data.camera||state.camera;state.snapshots=data.snapshots||[];state.undone=[];rebakeOffscreen();persist();render();$('#vaultDialog').close();toast('Local vault unlocked');return}if(passphrase!==$('#vaultConfirmation').value){error.textContent='Passphrases do not match.';return}const salt=crypto.getRandomValues(new Uint8Array(16)),key=await deriveKey(passphrase,salt);state.vault={enabled:true,key,salt};const payload=JSON.stringify({objects:state.objects,camera:state.camera,snapshots:state.snapshots});localStorage.setItem(VAULT_KEY,JSON.stringify(await encryptPayload(payload,key,salt)));localStorage.removeItem(KEY);localStorage.removeItem(SNAP_KEY);$('#vaultDialog').close();persist();toast('Local data encrypted')}catch{error.textContent='Could not unlock this vault. Check the passphrase and try again.'}}
  async function boot(){const encrypted=localStorage.getItem(VAULT_KEY);if(encrypted){state.vault.enabled=true;updateVaultButton();showVault('unlock');return}try{const saved=JSON.parse(localStorage.getItem(KEY));if(saved){state.objects=saved.objects||[];state.camera=saved.camera||state.camera}state.snapshots=JSON.parse(localStorage.getItem(SNAP_KEY))||[]}catch{}rebakeOffscreen();persist();render()}
  function styleSelection(changes){if(!state.selected.size)return;state.selected.forEach(i=>Object.assign(state.objects[i],changes));rebakeOffscreen();persist();render()}
  async function importCanvas(file){try{const data=JSON.parse(await file.text());if(!Array.isArray(data.objects))throw Error();if(!confirm(`Replace this canvas with ${data.objects.length} imported objects? A snapshot of the current canvas will be saved first.`))return;snapshot();state.objects=data.objects;state.camera=data.camera||{x:0,y:0,zoom:1};state.undone=[];state.selected.clear();rebakeOffscreen();persist();render();toast('Canvas imported')}catch{toast('That file is not a valid MindCanvas JSON export')}}
  document.querySelectorAll('.tool').forEach(b=>b.onclick=()=>tool(b.dataset.tool));$('#colorInput').oninput=e=>{state.color=e.target.value;styleSelection({color:state.color})};$('#sizeInput').oninput=e=>{state.size=+e.target.value;$('#sizeOutput').textContent=state.size;styleSelection({size:state.size})};$('#shapeInput').oninput=e=>state.shape=e.target.value;$('#importButton').onclick=()=>$('#importInput').click();$('#importInput').onchange=e=>{if(e.target.files[0])importCanvas(e.target.files[0]);e.target.value=''};$('#undoButton').onclick=()=>{if(state.objects.length){state.undone.push(state.objects.pop());rebakeOffscreen();persist();render()}};$('#redoButton').onclick=()=>{if(state.undone.length){state.objects.push(state.undone.pop());rebakeOffscreen();persist();render()}};$('#clearButton').onclick=()=>{if(state.objects.length&&confirm('Clear everything on this canvas?')){state.undone.push(...state.objects);state.objects=[];rebakeOffscreen();persist();render();toast('Canvas cleared')}};$('#homeButton').onclick=()=>{state.camera={x:0,y:0,zoom:1};rebakeOffscreen();persist();render()};$('#zoomIn').onclick=()=>zoom(1.2);$('#zoomOut').onclick=()=>zoom(1/1.2);$('#zoomLabel').onclick=()=>{state.camera.zoom=1;rebakeOffscreen();persist();render()};
  $('#exportButton').onclick=()=>{const m=$('#exportOptions');m.hidden=!m.hidden};document.querySelectorAll('[data-export]').forEach(b=>b.onclick=()=>{state.exportType=b.dataset.export;$('#exportOptions').hidden=true;$('#exportDialog').showModal()});$('#confirmExport').onclick=e=>{e.preventDefault();runExport();$('#exportDialog').close()};$('#shareButton').onclick=()=>$('#shareDialog').showModal();$('#generateShare').onclick=e=>{e.preventDefault();const opts={permission:document.querySelector('[name="permission"]:checked').value,downloadDisabled:$('#downloadDisabled').checked,password:!!$('#sharePassword').value,expiry:$('#shareExpiry').value||'none'};const token=crypto.randomUUID().replaceAll('-','').slice(0,16),out=$('#shareResult');out.hidden=false;out.textContent=`mindcanvas://share/${token} (${opts.permission}; password: ${opts.password?'set':'none'}; expires: ${opts.expiry})`;toast('Local share configuration created')};$('#historyButton').onclick=()=>{timeline();$('#historyDialog').showModal()};$('#snapshotButton').onclick=e=>{e.preventDefault();snapshot()};$('#vaultButton').onclick=()=>{if(!state.vault.enabled)showVault('create');else if(state.vault.key){state.vault.key=null;updateVaultButton();toast('Vault locked in this tab')}else showVault('unlock')};$('#shortcutsButton').onclick=()=>$('#shortcutsDialog').showModal();$('#vaultClose').onclick=$('#vaultCancel').onclick=()=>$('#vaultDialog').close();$('#vaultDialog form').addEventListener('submit',submitVault);$('#accessibilityButton').onclick=()=>{document.body.classList.toggle('high-contrast');document.body.classList.toggle('large-cursor');toast(document.body.classList.contains('high-contrast')?'High contrast and large cursor on':'Accessibility display reset')};
  addEventListener('keydown',e=>{if(e.target.isContentEditable||e.target.matches('input, textarea, select'))return;const mod=e.ctrlKey||e.metaKey,key=e.key.toLowerCase();if(mod&&key==='z'){e.preventDefault();e.shiftKey?$('#redoButton').click():$('#undoButton').click();return}if(mod&&key==='d'){e.preventDefault();if(state.selected.size){const copies=[...state.selected].map(i=>{const o=clone(state.objects[i]);if(o.type==='text'){o.x+=16;o.y+=16}else if(o.type==='shape'){o.start.x+=16;o.start.y+=16;o.end.x+=16;o.end.y+=16}else o.points.forEach(p=>{p.x+=16;p.y+=16});return o});const start=state.objects.length;state.objects.push(...copies);state.selected=new Set(copies.map((_,i)=>start+i));persist();render();toast('Selection duplicated')}return}if(mod&&key==='s'){e.preventDefault();snapshot();return}if(mod&&key==='e'){e.preventDefault();$('#exportDialog').showModal();return}if(e.key==='?'|| (e.shiftKey&&e.key==='/')){$('#shortcutsDialog').showModal();return}if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deleteSelection();return}if(e.key==='+ '||e.key==='+'){zoom(1.2);return}if(e.key==='-'||e.key==='_'){zoom(1/1.2);return}if(e.key==='0'){state.camera.zoom=1;persist();render();return}if(e.key===' '){tool('hand');e.preventDefault();return}const keys={p:'pen',b:'brush',h:'highlighter',t:'text',r:'shape',e:'eraser',v:'lasso'};if(keys[key])tool(keys[key])});
  resize();addEventListener('resize',resize);boot();
})();
