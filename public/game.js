"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const canvas = $("#gameCanvas");
const ctx = canvas.getContext("2d");
const W = 1200, H = 675, GROUND = 590, SLING = {x: 177, y: 475};
const images = {};
for (const [name, src] of Object.entries({background:"/assets/background.png", sling:"/assets/sling.png", red:"/assets/red-bird.png"})) {
  images[name] = new Image(); images[name].src = src;
}

const fallbackBirds = {
  red:{name:"红羽",cost:70,ability:"冲击",power:1}, yellow:{name:"疾风",cost:105,ability:"加速",power:.84},
  blue:{name:"霜蓝",cost:120,ability:"分裂",power:.72}, bomb:{name:"黑曜",cost:155,ability:"爆破",power:1.25}
};
const fallbackItems = {
  wood_beam:{name:"木横梁",cost:45,w:110,h:20,hp:80,material:"wood"},wood_post:{name:"木立柱",cost:45,w:22,h:100,hp:80,material:"wood"},
  stone_beam:{name:"石横梁",cost:75,w:105,h:24,hp:155,material:"stone"},stone_post:{name:"石立柱",cost:75,w:26,h:95,hp:155,material:"stone"},
  glass_beam:{name:"玻璃梁",cost:30,w:105,h:16,hp:42,material:"glass"},pig:{name:"小猪",cost:90,w:42,h:42,hp:100,material:"pig"}
};

const LEVELS = [
  {name:"风丘前哨",tag:"基础梁柱",birds:["red","red","yellow","red"],par:65,items:[
    ["wood_post",850,540],["wood_post",950,540],["wood_beam",900,480],["pig",900,555],
    ["wood_post",850,420],["wood_post",950,420],["wood_beam",900,360],["pig",900,445]]},
  {name:"玻璃回廊",tag:"脆弱连锁",birds:["blue","red","yellow","blue"],par:80,items:[
    ["glass_beam",800,570],["wood_post",760,510],["wood_post",840,510],["glass_beam",800,450],["pig",800,545],
    ["glass_beam",1000,570],["wood_post",960,510],["wood_post",1040,510],["glass_beam",1000,450],["pig",1000,545],
    ["glass_beam",900,430],["pig",900,397]]},
  {name:"石牙堡",tag:"重甲核心",birds:["yellow","bomb","red","red","blue"],par:95,items:[
    ["stone_post",820,530],["stone_post",980,530],["stone_beam",900,470],["pig",900,555],
    ["wood_post",850,410],["wood_post",950,410],["stone_beam",900,350],["pig",900,435],["pig",900,317]]},
  {name:"王冠工事",tag:"混合要塞",birds:["red","blue","yellow","bomb","red"],par:110,items:[
    ["stone_post",760,530],["wood_post",850,540],["wood_beam",805,480],["pig",805,555],
    ["stone_post",980,530],["wood_post",1070,540],["wood_beam",1025,480],["pig",1025,555],
    ["stone_post",850,410],["stone_post",980,410],["stone_beam",915,350],["glass_beam",915,460],["pig",915,435],["pig",915,317]]}
];

const game = {
  mode:null, level:0, phase:"menu", role:null, room:null, serverState:null, birds:fallbackBirds, itemSpecs:fallbackItems,
  queue:[], entities:[], projectiles:[], selectedKind:null, dragging:null, aiming:false, aim:{x:SLING.x,y:SLING.y},
  score:0, startedAt:0, shotAt:0, shotSleeping:0, lastFrame:performance.now(), simSent:0, abilityUsed:false, sound:true,
  stars:JSON.parse(localStorage.getItem("flock-stars") || "{}")
};

function showScreen(id){ $$(".screen").forEach(el=>el.classList.toggle("active",el.id===id)); }
function toast(message){ const el=$("#toast"); el.textContent=message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove("show"),2200); }
function escapeText(value){ return String(value).replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch])); }
function birdColor(type){ return {red:"#e94b35",yellow:"#efb62f",blue:"#5aaad1",bomb:"#252b30"}[type] || "#e94b35"; }
function materialColor(mat){ return {wood:"#b87534",stone:"#7e8b8d",glass:"#7bd6e5",pig:"#9acb42"}[mat] || "#aaa"; }
function itemFromTuple(tuple,index){ const [kind,x,y]=tuple,spec=game.itemSpecs[kind]; return {id:`l${game.level}-${index}`,kind,x,y,w:spec.w,h:spec.h,hp:spec.hp,maxHp:spec.hp,material:spec.material,vx:0,vy:0}; }
function syncEntities(items){
  const old=new Map(game.entities.map(e=>[e.id,e]));
  game.entities=(items||[]).map(raw=>{ const prev=old.get(raw.id)||{}; return {...raw,vx:prev.vx||0,vy:prev.vy||0}; });
}

function renderLevels(){
  $("#levelGrid").innerHTML=LEVELS.map((level,i)=>`<button class="level-card" data-level="${i}"><strong>${String(i+1).padStart(2,"0")} · ${level.name}</strong><small>${level.tag} · ${level.birds.length} 只小鸟</small><div class="fort"></div><div class="land"></div><span class="stars">${"★".repeat(game.stars[i]||0)}${"☆".repeat(3-(game.stars[i]||0))}</span></button>`).join("");
  $$("[data-level]").forEach(button=>button.addEventListener("click",()=>startSingle(+button.dataset.level)));
}

function startSingle(index){
  game.mode="single"; game.level=index; game.phase="battle"; game.role="bird"; game.room=null; game.serverState=null;
  game.queue=[...LEVELS[index].birds]; game.entities=LEVELS[index].items.map(itemFromTuple); game.projectiles=[]; game.score=0; game.startedAt=performance.now(); game.shotSleeping=0;
  $("#gameModeLabel").textContent="单人远征"; $("#roomLabel").textContent=`堡垒 ${String(index+1).padStart(2,"0")}`;
  $("#leftTeam").textContent="得分"; $("#rightTeam").textContent="剩余猪"; $("#birdScore").textContent="0";
  $("#roundLabel").textContent=LEVELS[index].name; $("#shopPanel").classList.add("hidden"); $("#waitingCard").classList.add("hidden"); $("#roundOverlay").classList.add("hidden");
  $("#roleBadge").textContent="单人 · 进攻方"; $("#phaseLabel").textContent="准备发射"; $("#canvasHint").textContent="拖动弹弓上的小鸟，松开发射"; $("#footerHelp").textContent="拖拽瞄准 · 松开发射 · 空格使用飞行能力 · R 重开";
  updateHud(); showScreen("game");
}

function finishSingle(won){
  if(game.phase!=="battle")return; game.phase="ended";
  const elapsed=(performance.now()-game.startedAt)/1000, remaining=game.queue.length;
  let stars=won?(remaining>=2&&elapsed<LEVELS[game.level].par?3:remaining>=1?2:1):0;
  if(stars>(game.stars[game.level]||0)){game.stars[game.level]=stars;localStorage.setItem("flock-stars",JSON.stringify(game.stars));}
  $("#overlayEyebrow").textContent=won?`${"★".repeat(stars)}${"☆".repeat(3-stars)}`:"挑战失败";
  $("#overlayTitle").textContent=won?"堡垒攻破":"小鸟用尽";
  $("#overlayReason").textContent=won?`得分 ${Math.round(game.score).toLocaleString()} · 用时 ${Math.round(elapsed)} 秒`:`还有 ${livingPigs()} 只猪。调整落点与能力时机再试一次。`;
  $("#nextRoundBtn").textContent=won&&game.level<LEVELS.length-1?"前往下一关":"重新挑战"; $("#roundOverlay").classList.remove("hidden");
}

let socket=null, reconnectTimer=null, heartbeat=null;
function wsUrl(){ return `${location.protocol==="https:"?"wss":"ws"}://${location.host}/ws`; }
function connect(){
  clearTimeout(reconnectTimer); if(socket&&(socket.readyState===0||socket.readyState===1))return;
  socket=new WebSocket(wsUrl());
  socket.addEventListener("open",()=>{ $("#connectionStatus").textContent="对战服务器已连接"; $("#connectionStatus").className="connection-status online"; clearInterval(heartbeat); heartbeat=setInterval(()=>send({type:"ping"}),20000);
    const saved=JSON.parse(sessionStorage.getItem("flock-session")||"null"); if(saved&&game.mode==="multi")send({type:"resume",room:saved.room,token:saved.token}); });
  socket.addEventListener("message",event=>{ try{ onMessage(JSON.parse(event.data)); }catch(err){ console.error(err); } });
  socket.addEventListener("close",()=>{ $("#connectionStatus").textContent="连接中断，正在重连…"; $("#connectionStatus").className="connection-status offline"; clearInterval(heartbeat); reconnectTimer=setTimeout(connect,1800); });
  socket.addEventListener("error",()=>socket.close());
}
function send(payload){ if(socket?.readyState===1){socket.send(JSON.stringify(payload));return true} toast("服务器尚未连接");return false; }

function onMessage(message){
  if(message.type==="hello"){ game.birds=message.config.birds||fallbackBirds; game.itemSpecs=message.config.items||fallbackItems; return; }
  if(message.type==="error"){ toast(message.message); return; }
  if(message.type==="joined"){
    game.mode="multi";game.room=message.room;game.role=message.role;sessionStorage.setItem("flock-session",JSON.stringify({room:message.room,token:message.token}));
    $("#gameModeLabel").textContent="双人攻防";$("#roomLabel").textContent=`房间 ${message.room}`;$("#copyCode").textContent=message.room;$("#roleBadge").textContent=message.role==="bird"?"你是 · 小鸟进攻方":"你是 · 小猪防守方";
    $("#shopPanel").classList.remove("hidden");$("#roundOverlay").classList.add("hidden");showScreen("game");renderShop();return;
  }
  if(message.type==="state"){ applyServerState(message);return; }
  if(message.type==="fired"){
    if(game.serverState){game.serverState.birdQueue=message.queue;game.serverState.activeBird=message.bird;} game.queue=[...message.queue];
    startProjectile(message.bird,message.vx,message.vy);game.phase="battle";updateHud();return;
  }
  if(message.type==="sim"&&game.role==="pig"){ applyRemoteSim(message);return; }
  if(message.type==="round_result"){ applyServerState(message.state); showRoundResult(message);return; }
  if(message.type==="next_wait"){toast("已准备，等待对方");return;}
  if(message.type==="disconnected"){toast(`${message.role==="bird"?"小鸟":"小猪"}玩家掉线，保留房间 3 分钟`);return;}
  if(message.type==="emote"){showEmote(message);return;}
}

function applyServerState(state){
  const previousPhase=game.serverState?.phase, previousRound=game.serverState?.round;
  game.serverState=state; game.phase=state.phase; game.queue=[...(state.birdQueue||[])]; syncEntities(state.items||[]);
  $("#birdScore").textContent=state.scores.bird;$("#pigScore").textContent=state.scores.pig;$("#roundLabel").textContent=`第 ${state.round} 回合 · 先胜 3 局`;$("#roomLabel").textContent=`房间 ${state.room}`;
  const waiting=state.phase==="waiting";$("#waitingCard").classList.toggle("hidden",!waiting);$("#phaseLabel").textContent={waiting:"等待玩家",fortify:"购买与筑城",battle:"交战中",round_end:"回合结束",match_end:"比赛结束"}[state.phase]||state.phase;
  if(state.phase==="fortify"){$("#roundOverlay").classList.add("hidden");game.projectiles=[];if(previousPhase!=="fortify"||previousRound!==state.round)game.selectedKind=null;}
  renderShop();updateHud();
}

function showRoundResult(message){
  const match=message.state.phase==="match_end";$("#overlayEyebrow").textContent=match?"比赛结束":`第 ${message.state.round} 回合结束`;
  $("#overlayTitle").textContent=message.winner==="bird"?"小鸟方取胜":"小猪方守住了";$("#overlayReason").textContent=message.reason;
  $("#nextRoundBtn").textContent=match?"双方准备再战":"准备下一回合";$("#roundOverlay").classList.remove("hidden");
}

function renderShop(){
  if(game.mode!=="multi"||!game.serverState)return;
  const birdSide=game.role==="bird",locked=game.serverState.phase!=="fortify"||game.serverState.ready.includes(game.role);
  $("#shopEyebrow").textContent=birdSide?"小鸟补给":"堡垒工坊";$("#coinValue").textContent=game.serverState.credits[game.role];
  const source=birdSide?game.birds:game.itemSpecs;
  $("#shopList").innerHTML=Object.entries(source).map(([key,spec])=>`<button class="shop-item" data-shop="${key}" ${locked||spec.cost>game.serverState.credits[game.role]?"disabled":""}><span class="shop-swatch" style="background:${birdSide?birdColor(key):materialColor(spec.material)}">${birdSide?spec.name[0]:spec.material==="pig"?"猪":"▰"}</span><span><strong>${escapeText(spec.name)}</strong><small>${birdSide?escapeText(spec.ability):`${spec.hp} 耐久 · ${spec.w}×${spec.h}`}</small></span><span class="shop-cost">${spec.cost} ◉</span></button>`).join("");
  $$("[data-shop]").forEach(button=>button.addEventListener("click",()=>{if(birdSide)send({type:"buy_bird",bird:button.dataset.shop});else{game.selectedKind=button.dataset.shop;toast(`已选择${game.itemSpecs[game.selectedKind].name}，点击建造区放置`);}}));
  $("#queuePanel").classList.toggle("hidden",!birdSide);$("#birdQueue").innerHTML=(game.serverState.birdQueue||[]).map((bird,i)=>`<button class="queue-bird" data-sell="${i}" style="background:${birdColor(bird)}" title="点击退回">${game.birds[bird].name[0]}</button>`).join("");
  $$("[data-sell]").forEach(button=>button.addEventListener("click",()=>send({type:"sell_bird",index:+button.dataset.sell})));
  const ready=game.serverState.ready.includes(game.role);$("#readyBtn").textContent=ready?"取消准备":"确认准备";$("#readyBtn").disabled=game.serverState.phase!=="fortify";
  $("#validationHint").textContent=birdSide?"每回合 1–6 只；点击队列中的小鸟可全额退回。":"放置 1–3 只猪；拖动物品调整，右键删除并全额退款。";
  $("#canvasHint").textContent=game.serverState.phase==="fortify"?(birdSide?"购买小鸟并确认准备":"从左侧购买，点击虚线区放置；拖拽调整"):(birdSide?"拖动弹弓上的小鸟，松开发射":"观察来袭小鸟与堡垒状态");
}

function updateHud(){
  if(game.mode==="single"){$("#birdScore").textContent=Math.round(game.score);$("#pigScore").textContent=livingPigs();}
  const current=game.projectiles.find(p=>p.primary&&!p.dead);$("#abilityPrompt").classList.toggle("hidden",!current||current.abilityUsed);
}

function startProjectile(type,vx,vy){
  game.projectiles=[{id:"bird",type,x:SLING.x,y:SLING.y,vx,vy,r:type==="bomb"?22:18,primary:true,abilityUsed:false,dead:false,age:0,hit:new Set()}];
  game.abilityUsed=false;game.shotAt=performance.now();game.shotSleeping=0;$("#phaseLabel").textContent=`${game.birds[type].name}飞行中`;
}

function useAbility(){
  const bird=game.projectiles.find(p=>p.primary&&!p.dead&&!p.abilityUsed);if(!bird)return;bird.abilityUsed=true;
  if(bird.type==="red"){bird.vx*=1.32;bird.vy*=1.18;burst(bird.x,bird.y,"#ef5b42");}
  else if(bird.type==="yellow"){bird.vx*=1.72;bird.vy*=1.35;burst(bird.x,bird.y,"#f5c43e");}
  else if(bird.type==="blue"){
    for(const sign of [-1,1])game.projectiles.push({...bird,id:`split${sign}`,primary:false,r:12,vx:bird.vx+sign*45,vy:bird.vy+sign*170,hit:new Set()});burst(bird.x,bird.y,"#7dd9f0");
  } else if(bird.type==="bomb"){ explode(bird.x,bird.y,145,95);bird.dead=true; }
  updateHud();
}

const particles=[];
function burst(x,y,color,count=14){for(let i=0;i<count;i++){const a=Math.random()*Math.PI*2,s=60+Math.random()*180;particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:.65,color});}}
function explode(x,y,r,damage){burst(x,y,"#efb438",32);for(const e of game.entities){const d=Math.hypot(e.x-x,e.y-y);if(d<r){e.hp=Math.max(0,e.hp-damage*(1-d/r)*(e.material==="stone"?.6:1.25));e.vx+=(e.x-x)/(d||1)*420;e.vy+=(e.y-y)/(d||1)*420;}}game.score+=500;}

function livingPigs(){return game.entities.filter(e=>e.kind==="pig"&&e.hp>0&&e.y<720).length;}
function rectHitCircle(e,p){const cx=Math.max(e.x-e.w/2,Math.min(p.x,e.x+e.w/2)),cy=Math.max(e.y-e.h/2,Math.min(p.y,e.y+e.h/2));return {hit:(p.x-cx)**2+(p.y-cy)**2<p.r**2,cx,cy};}
function physics(dt){
  if(game.phase!=="battle")return;
  // Simple stable stack physics: bodies fall until the ground or another live body supports them.
  const live=game.entities.filter(e=>e.hp>0);
  for(const e of live){
    e.vy=(e.vy||0)+720*dt;e.x+=(e.vx||0)*dt;e.y+=e.vy*dt;e.vx*=Math.pow(.18,dt);
    let floor=GROUND;
    for(const base of live){if(base===e||base.y<=e.y)continue;const overlapX=Math.min(e.x+e.w/2,base.x+base.w/2)-Math.max(e.x-e.w/2,base.x-base.w/2);const top=base.y-base.h/2;if(overlapX>Math.min(14,e.w*.3)&&e.y+e.h/2<=top+Math.max(12,Math.abs(e.vy)*dt+4))floor=Math.min(floor,top);}
    if(e.y+e.h/2>=floor){e.y=floor-e.h/2;if(e.vy>210)e.hp=Math.max(0,e.hp-(e.vy-200)*.035*(e.material==="glass"?2:1));e.vy=0;}
    if(e.x<-120||e.x>1320||e.y>730)e.hp=0;
  }
  for(const p of game.projectiles){
    if(p.dead)continue;p.age+=dt;p.vy+=730*dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vx*=Math.pow(.997,dt*60);
    if(p.y+p.r>GROUND){p.y=GROUND-p.r;p.vy*=-.34;p.vx*=.66;if(Math.abs(p.vy)<35)p.vy=0;}
    for(const e of live){if(e.hp<=0)continue;const collision=rectHitCircle(e,p);if(!collision.hit)continue;
      const speed=Math.hypot(p.vx,p.vy),dx=p.x-collision.cx,dy=p.y-collision.cy,len=Math.hypot(dx,dy)||1,nx=dx/len,ny=dy/len;
      p.x=collision.cx+nx*(p.r+1);const resistance={glass:.42,wood:.78,stone:1.4,pig:.62}[e.material]||1;
      const power=game.birds[p.type]?.power||1,damage=Math.max(0,(speed-90)*.12*power/resistance);
      if(!p.hit.has(e.id)||speed>280){e.hp=Math.max(0,e.hp-damage);e.vx+=(p.vx*.16)/resistance;e.vy+=(p.vy*.09)/resistance;p.hit.add(e.id);game.score+=damage*12+(e.hp<=0?350:0);if(e.hp<=0)burst(e.x,e.y,materialColor(e.material),12);}
      const dot=p.vx*nx+p.vy*ny;if(dot<0){p.vx-=1.42*dot*nx;p.vy-=1.42*dot*ny;}p.vx*=.72;p.vy*=.72;
    }
    if(p.x>1300||p.y>720||p.age>18)p.dead=true;
  }
  for(const particle of particles){particle.vy+=300*dt;particle.x+=particle.vx*dt;particle.y+=particle.vy*dt;particle.life-=dt;}
  for(let i=particles.length-1;i>=0;i--)if(particles[i].life<=0)particles.splice(i,1);
  const active=game.projectiles.some(p=>!p.dead&&(Math.hypot(p.vx,p.vy)>18||p.age<1.2));
  if(game.projectiles.length){game.shotSleeping=active?0:game.shotSleeping+dt;if(game.shotSleeping>1||performance.now()-game.shotAt>19000)endShot();}
  if(game.mode==="multi"&&game.role==="bird"&&game.projectiles.length&&performance.now()-game.simSent>125){game.simSent=performance.now();send({type:"sim",entities:game.entities.map(entity=>({id:entity.id,x:entity.x,y:entity.y,vx:entity.vx,vy:entity.vy,hp:entity.hp})),bird:game.projectiles[0]?{x:game.projectiles[0].x,y:game.projectiles[0].y}:null});}
  updateHud();
}

function endShot(){
  if(!game.projectiles.length)return;game.projectiles=[];game.shotSleeping=0;
  if(livingPigs()===0){if(game.mode==="single")finishSingle(true);else if(game.role==="bird")sendShotEnd();return;}
  if(game.mode==="single"){
    if(!game.queue.length)finishSingle(false);else{$("#phaseLabel").textContent="准备发射";$("#canvasHint").textContent="拖动下一只小鸟";}
  } else if(game.role==="bird")sendShotEnd();
}
function sendShotEnd(){send({type:"shot_end",entities:game.entities.map(e=>({id:e.id,x:e.x,y:e.y,hp:e.hp}))});}
function applyRemoteSim(message){
  const map=new Map(game.entities.map(e=>[e.id,e]));for(const remote of message.entities||[]){const e=map.get(remote.id);if(e)Object.assign(e,remote);}
  if(message.bird&&game.projectiles[0]){game.projectiles[0].x=message.bird.x;game.projectiles[0].y=message.bird.y;}
}

function canvasPoint(event){const rect=canvas.getBoundingClientRect();return{x:(event.clientX-rect.left)*W/rect.width,y:(event.clientY-rect.top)*H/rect.height};}
function itemAt(point){return [...game.entities].reverse().find(e=>e.hp>0&&Math.abs(point.x-e.x)<=e.w/2+5&&Math.abs(point.y-e.y)<=e.h/2+5);}
canvas.addEventListener("pointerdown",event=>{
  const point=canvasPoint(event);
  if(game.mode==="multi"&&game.role==="pig"&&game.phase==="fortify"&&!game.serverState.ready.includes("pig")){
    const existing=itemAt(point);if(existing){game.dragging={id:existing.id,dx:point.x-existing.x,dy:point.y-existing.y};canvas.setPointerCapture(event.pointerId);}
    else if(game.selectedKind)send({type:"build",action:"add",kind:game.selectedKind,x:point.x,y:point.y});else toast("请先从左侧选择建筑物品");return;
  }
  if(game.role==="bird"&&game.phase==="battle"&&!game.projectiles.length&&game.queue.length&&Math.hypot(point.x-SLING.x,point.y-SLING.y)<55){game.aiming=true;game.aim=point;canvas.setPointerCapture(event.pointerId);return;}
  if(game.projectiles.length)useAbility();
});
canvas.addEventListener("pointermove",event=>{
  const point=canvasPoint(event);if(game.aiming){const dx=point.x-SLING.x,dy=point.y-SLING.y,len=Math.hypot(dx,dy),scale=Math.min(125,len)/(len||1);game.aim={x:SLING.x+dx*scale,y:SLING.y+dy*scale};}
  if(game.dragging){const e=game.entities.find(item=>item.id===game.dragging.id);if(e){e.x=Math.max(700,Math.min(1165,point.x-game.dragging.dx));e.y=Math.max(80,Math.min(GROUND,point.y-game.dragging.dy));}}
});
canvas.addEventListener("pointerup",event=>{
  if(game.aiming){game.aiming=false;const dx=SLING.x-game.aim.x,dy=SLING.y-game.aim.y,power=Math.hypot(dx,dy);game.aim={...SLING};if(power<22){toast("再向后多拉一些");return;}const vx=dx*8.2,vy=dy*8.2;if(game.mode==="multi")send({type:"fire",vx,vy});else{const bird=game.queue.shift();startProjectile(bird,vx,vy);} }
  if(game.dragging){const e=game.entities.find(item=>item.id===game.dragging.id);if(e)send({type:"build",action:"move",id:e.id,x:e.x,y:e.y});game.dragging=null;}
});
canvas.addEventListener("contextmenu",event=>{event.preventDefault();if(game.mode==="multi"&&game.role==="pig"&&game.phase==="fortify"){const e=itemAt(canvasPoint(event));if(e)send({type:"build",action:"remove",id:e.id});}});

function drawBird(x,y,type,r=18){
  ctx.save();ctx.translate(x,y);ctx.fillStyle=birdColor(type);ctx.strokeStyle="#152832";ctx.lineWidth=3;ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fill();ctx.stroke();
  ctx.fillStyle="#fff";ctx.beginPath();ctx.arc(r*.32,-r*.22,r*.28,0,Math.PI*2);ctx.fill();ctx.fillStyle="#152832";ctx.beginPath();ctx.arc(r*.4,-r*.2,r*.1,0,Math.PI*2);ctx.fill();
  ctx.fillStyle="#efb63a";ctx.beginPath();ctx.moveTo(r*.68,0);ctx.lineTo(r*1.18,r*.12);ctx.lineTo(r*.7,r*.3);ctx.closePath();ctx.fill();ctx.restore();
}
function drawPig(e){
  const r=Math.min(e.w,e.h)/2;ctx.save();ctx.translate(e.x,e.y);ctx.fillStyle="#98cc45";ctx.strokeStyle="#27452d";ctx.lineWidth=3;ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fill();ctx.stroke();
  ctx.fillStyle="#bce86a";ctx.beginPath();ctx.ellipse(4,6,r*.5,r*.35,0,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle="#27452d";ctx.beginPath();ctx.arc(-1,5,2.5,0,7);ctx.arc(9,5,2.5,0,7);ctx.fill();
  for(const x of [-7,8]){ctx.fillStyle="#fff";ctx.beginPath();ctx.arc(x,-7,5.5,0,7);ctx.fill();ctx.fillStyle="#152832";ctx.beginPath();ctx.arc(x+1,-6,2,0,7);ctx.fill();}ctx.restore();
}
function drawItem(e){
  if(e.hp<=0)return;if(e.kind==="pig"){drawPig(e);return;}ctx.save();ctx.translate(e.x,e.y);ctx.fillStyle=materialColor(e.material);ctx.strokeStyle="#20353c";ctx.lineWidth=2;ctx.globalAlpha=Math.max(.25,e.hp/e.maxHp);ctx.fillRect(-e.w/2,-e.h/2,e.w,e.h);ctx.strokeRect(-e.w/2,-e.h/2,e.w,e.h);
  if(e.material==="wood"){ctx.strokeStyle="rgba(70,36,13,.35)";for(let x=-e.w/2+12;x<e.w/2;x+=22){ctx.beginPath();ctx.moveTo(x,-e.h/2);ctx.lineTo(x+7,e.h/2);ctx.stroke();}}
  else if(e.material==="stone"){ctx.strokeStyle="rgba(255,255,255,.28)";ctx.beginPath();ctx.moveTo(-e.w/2+5,0);ctx.lineTo(e.w/2-5,0);ctx.stroke();}
  else{ctx.fillStyle="rgba(255,255,255,.4)";ctx.fillRect(-e.w/2+5,-e.h/2+3,e.w*.4,3);}ctx.restore();
}
function draw(){
  ctx.clearRect(0,0,W,H);if(images.background.complete)ctx.drawImage(images.background,0,0,W,GROUND);else{ctx.fillStyle="#91d5e4";ctx.fillRect(0,0,W,GROUND);}
  ctx.fillStyle="#699f43";ctx.fillRect(0,GROUND,W,H-GROUND);ctx.fillStyle="#85bb52";ctx.fillRect(0,GROUND,W,12);
  if(game.mode==="multi"&&game.phase==="fortify"){ctx.save();ctx.setLineDash([10,8]);ctx.lineWidth=3;ctx.strokeStyle="rgba(233,75,53,.7)";ctx.fillStyle="rgba(255,249,233,.12)";ctx.fillRect(700,80,465,GROUND-80);ctx.strokeRect(700,80,465,GROUND-80);ctx.fillStyle="#8c332c";ctx.font="800 13px sans-serif";ctx.fillText("小猪建造区",715,105);ctx.restore();}
  for(const e of game.entities)drawItem(e);
  if(game.role==="bird"||game.mode==="single"){
    ctx.drawImage(images.sling,SLING.x-44,SLING.y-43,84,176);const canAim=game.phase==="battle"&&!game.projectiles.length&&game.queue.length;
    if(canAim){const pos=game.aiming?game.aim:SLING;if(game.aiming){ctx.strokeStyle="#4c291b";ctx.lineWidth=7;ctx.beginPath();ctx.moveTo(SLING.x-19,SLING.y-5);ctx.lineTo(pos.x,pos.y);ctx.lineTo(SLING.x+18,SLING.y-8);ctx.stroke();drawTrajectory(pos); }drawBird(pos.x,pos.y,game.queue[0]);}
  }
  for(const p of game.projectiles)if(!p.dead)drawBird(p.x,p.y,p.type,p.r);
  for(const p of particles){ctx.globalAlpha=Math.max(0,p.life/.65);ctx.fillStyle=p.color;ctx.fillRect(p.x-3,p.y-3,6,6);}ctx.globalAlpha=1;
}
function drawTrajectory(pos){const vx=(SLING.x-pos.x)*8.2,vy=(SLING.y-pos.y)*8.2;ctx.fillStyle="rgba(255,255,255,.75)";for(let t=.15;t<1.25;t+=.13){const x=SLING.x+vx*t,y=SLING.y+vy*t+365*t*t;ctx.beginPath();ctx.arc(x,y,3,0,7);ctx.fill();}}
function frame(now){const dt=Math.min(.025,(now-game.lastFrame)/1000);game.lastFrame=now;physics(dt);draw();requestAnimationFrame(frame);}requestAnimationFrame(frame);

function showEmote(message){const badge=document.createElement("div");badge.textContent=message.emote;badge.style.cssText=`position:absolute;top:60px;${message.role==="bird"?"left":"right"}:28px;font-size:44px;z-index:8;transition:.5s`;$(".stage-wrap").append(badge);setTimeout(()=>{badge.style.transform="translateY(-35px)";badge.style.opacity="0";},900);setTimeout(()=>badge.remove(),1500);}

$("#singleBtn").addEventListener("click",()=>{renderLevels();showScreen("levelScreen")});$("#multiBtn").addEventListener("click",()=>{showScreen("multiScreen");connect()});
$$('[data-home]').forEach(btn=>btn.addEventListener("click",()=>showScreen("home")));$("#rulesBtn").addEventListener("click",()=>$("#rulesDialog").showModal());$(".dialog-close").addEventListener("click",()=>$("#rulesDialog").close());
$("#createBtn").addEventListener("click",()=>{game.mode="multi";connect();send({type:"create_room",name:$("#playerName").value})});$("#joinBtn").addEventListener("click",()=>{const room=$("#roomCode").value.trim().toUpperCase();if(room.length!==6)return toast("请输入 6 位房间码");game.mode="multi";connect();send({type:"join_room",room,name:$("#playerName").value})});
$("#roomCode").addEventListener("input",event=>event.target.value=event.target.value.toUpperCase().replace(/[^A-Z2-9]/g,"").slice(0,6));
$("#readyBtn").addEventListener("click",()=>{if(!game.serverState)return;send({type:game.serverState.ready.includes(game.role)?"unready":"ready"})});
$("#nextRoundBtn").addEventListener("click",()=>{if(game.mode==="single"){const next=game.phase==="ended"&&livingPigs()===0&&game.level<LEVELS.length-1?game.level+1:game.level;startSingle(next);}else{send({type:"next_round"});$("#nextRoundBtn").disabled=true;setTimeout(()=>$("#nextRoundBtn").disabled=false,1200);}});
$("#copyCode").addEventListener("click",async()=>{try{await navigator.clipboard.writeText(game.room);toast("房间码已复制")}catch{toast(`房间码：${game.room}`)}});
$("#exitGame").addEventListener("click",()=>{if(game.mode==="multi"&&!confirm("退出后房间会保留 3 分钟，确定退出？"))return;game.phase="menu";game.projectiles=[];game.entities=[];sessionStorage.removeItem("flock-session");showScreen("home")});
$("#soundBtn").addEventListener("click",()=>{game.sound=!game.sound;$("#soundBtn").textContent=game.sound?"♪":"×"});
$("#emotes").addEventListener("click",event=>{if(event.target.tagName==="BUTTON"&&game.mode==="multi")send({type:"emote",emote:event.target.textContent})});
window.addEventListener("keydown",event=>{if(event.code==="Space"){event.preventDefault();useAbility()}if(event.key.toLowerCase()==="r"&&game.mode==="single"&&$("#game").classList.contains("active"))startSingle(game.level);if(event.key==="Escape"&&$("#rulesDialog").open)$("#rulesDialog").close();});
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&game.mode==="multi")connect()});
renderLevels();connect();
