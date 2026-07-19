"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const canvas = $("#gameCanvas");
const ctx = canvas.getContext("2d");
const W = 1200, H = 675, GROUND = 590, SLING = {x: 177, y: 475};
const images = {};
for (const [name, src] of Object.entries({
  background:"/assets/background.png", sling:"/assets/sling.png",
  birdSheet:"/assets/characters/bird-sheet.png",
  pig:"/assets/characters/pig.png"
})) {
  images[name] = new Image(); images[name].src = src;
}
if(!window.Matter)throw new Error("Matter.js failed to load");
const {Engine,Bodies,Body,Composite,Events,Sleeping}=Matter;

const fallbackBirds = {
  red:{name:"红羽",cost:70,ability:"冲击",power:1}, yellow:{name:"疾风",cost:105,ability:"加速",power:.84},
  blue:{name:"霜蓝",cost:120,ability:"分裂",power:.72}, bomb:{name:"黑曜",cost:155,ability:"爆破",power:1.25}
};
const fallbackItems = {
  wood_beam:{name:"木横梁",cost:45,w:110,h:20,hp:80,material:"wood"},wood_post:{name:"木立柱",cost:45,w:22,h:100,hp:80,material:"wood"},
  stone_beam:{name:"石横梁",cost:75,w:105,h:24,hp:155,material:"stone"},stone_post:{name:"石立柱",cost:75,w:26,h:95,hp:155,material:"stone"},
  glass_beam:{name:"玻璃梁",cost:30,w:105,h:16,hp:42,material:"glass"},pig:{name:"小猪",cost:90,w:42,h:42,hp:100,material:"pig"}
};
const BIRD_SPRITES = {
  red:{x:185,y:34,w:62,h:60},
  blue:{x:218,y:139,w:41,h:40},
  yellow:{x:188,y:210,w:87,h:69},
  bomb:{x:119,y:309,w:65,h:97}
};

const LEVELS = [
  {name:"风丘前哨",tag:"基础梁柱",birds:["red","red","yellow","red"],par:65,items:[
    ["wood_post",850,540],["wood_post",950,540],["wood_beam",900,480],["pig",900,555],
    ["wood_post",850,420],["wood_post",950,420],["wood_beam",900,360],["pig",900,445]]},
  {name:"玻璃回廊",tag:"脆弱连锁",birds:["blue","red","yellow","blue"],par:80,items:[
    ["glass_beam",820,582],["wood_post",780,524],["wood_post",860,524],["glass_beam",820,466],["pig",820,553],
    ["glass_beam",980,582],["wood_post",940,524],["wood_post",1020,524],["glass_beam",980,466],["pig",980,553],
    ["glass_beam",900,450],["pig",900,421]]},
  {name:"石牙堡",tag:"重甲核心",birds:["yellow","bomb","red","red","blue"],par:95,items:[
    ["stone_post",850,542.5],["stone_post",950,542.5],["stone_beam",900,483],["pig",900,569],
    ["wood_post",870,421],["wood_post",930,421],["stone_beam",900,359],["pig",900,450],["pig",900,326]]},
  {name:"王冠工事",tag:"混合要塞",birds:["red","blue","yellow","bomb","red"],par:110,items:[
    ["stone_post",780,542.5],["stone_post",870,542.5],["stone_beam",825,483],["pig",825,569],
    ["stone_post",960,542.5],["stone_post",1050,542.5],["stone_beam",1005,483],["pig",1005,569],
    ["stone_post",870,423.5],["stone_post",960,423.5],["wood_beam",915,366],["glass_beam",915,463],["pig",915,434],["pig",915,335]]}
];

const game = {
  mode:null, level:0, phase:"menu", role:null, room:null, serverState:null, birds:fallbackBirds, itemSpecs:fallbackItems,
  queue:[], entities:[], projectiles:[], selectedKind:null, dragging:null, aiming:false, aim:{x:SLING.x,y:SLING.y}, pointer:{x:0,y:0,inside:false},
  score:0, startedAt:0, shotAt:0, shotSleeping:0, lastFrame:performance.now(), simSent:0, hudAt:0, abilityUsed:false, sound:true,
  shake:0, impactFlash:0,
  stars:JSON.parse(localStorage.getItem("flock-stars") || "{}")
};

function showScreen(id){ $$(".screen").forEach(el=>el.classList.toggle("active",el.id===id)); }
function toast(message){ const el=$("#toast"); el.textContent=message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove("show"),2200); }
function escapeText(value){ return String(value).replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch])); }
function birdColor(type){ return {red:"#e94b35",yellow:"#efb62f",blue:"#5aaad1",bomb:"#252b30"}[type] || "#e94b35"; }
function birdSpriteMarkup(type,size=34){
  const sprite=BIRD_SPRITES[type]||BIRD_SPRITES.red,scale=Math.min(size/sprite.w,size/sprite.h),width=799*scale,height=1169*scale;
  const left=(size-sprite.w*scale)/2-sprite.x*scale,top=(size-sprite.h*scale)/2-sprite.y*scale;
  return `<span class="bird-sprite" style="width:${size}px;height:${size}px"><img src="/assets/characters/bird-sheet.png" alt="" style="width:${width}px;height:${height}px;left:${left}px;top:${top}px"></span>`;
}
function materialColor(mat){ return {wood:"#b87534",stone:"#7e8b8d",glass:"#7bd6e5",pig:"#9acb42"}[mat] || "#aaa"; }
function itemFromTuple(tuple,index){ const [kind,x,y]=tuple,spec=game.itemSpecs[kind]; return {id:`l${game.level}-${index}`,kind,x,y,w:spec.w,h:spec.h,hp:spec.hp,maxHp:spec.hp,material:spec.material,angle:0,vx:0,vy:0}; }
function syncEntities(items){
  const old=new Map(game.entities.map(e=>[e.id,e]));
  game.entities=(items||[]).map(raw=>{ const prev=old.get(raw.id);if(prev){Object.assign(prev,raw);prev.angle=raw.angle??prev.angle??0;return prev;}return {...raw,angle:raw.angle??0,vx:0,vy:0}; });
}

function renderLevels(){
  $("#levelGrid").innerHTML=LEVELS.map((level,i)=>`<button class="level-card" data-level="${i}"><strong>${String(i+1).padStart(2,"0")} · ${level.name}</strong><small>${level.tag} · ${level.birds.length} 只小鸟</small><div class="fort"></div><div class="land"></div><span class="stars">${"★".repeat(game.stars[i]||0)}${"☆".repeat(3-(game.stars[i]||0))}</span></button>`).join("");
  $$("[data-level]").forEach(button=>button.addEventListener("click",()=>startSingle(+button.dataset.level)));
}

function startSingle(index){
  game.mode="single"; game.level=index; game.phase="battle"; game.role="bird"; game.room=null; game.serverState=null;
  game.queue=[...LEVELS[index].birds]; game.entities=LEVELS[index].items.map(itemFromTuple); game.projectiles=[]; game.score=0; game.startedAt=performance.now(); game.shotAt=0; game.shotSleeping=0;
  initPhysics();
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
  if(message.type==="disconnected"){toast(`${message.role==="bird"?"小鸟":"小猪"}玩家掉线；你仍在线时房间保留 3 分钟`);return;}
  if(message.type==="emote"){showEmote(message);return;}
}

function applyServerState(state){
  const previousPhase=game.serverState?.phase, previousRound=game.serverState?.round;
  game.serverState=state; game.phase=state.phase; game.queue=[...(state.birdQueue||[])]; syncEntities(state.items||[]);
  $("#birdScore").textContent=state.scores.bird;$("#pigScore").textContent=state.scores.pig;$("#roundLabel").textContent=`第 ${state.round} 回合 · 先胜 3 局`;$("#roomLabel").textContent=`房间 ${state.room}`;
  const waiting=state.phase==="waiting";$("#waitingCard").classList.toggle("hidden",!waiting);$("#phaseLabel").textContent={waiting:"等待玩家",fortify:"购买与筑城",battle:"交战中",round_end:"回合结束",match_end:"比赛结束"}[state.phase]||state.phase;
  if(state.phase==="fortify"){$("#roundOverlay").classList.add("hidden");game.projectiles=[];destroyPhysics();if(previousPhase!=="fortify"||previousRound!==state.round)game.selectedKind=null;}
  if(state.phase==="battle"&&(previousPhase!=="battle"||previousRound!==state.round)){game.shotAt=0;initPhysics();}
  if(state.phase==="battle"&&!state.activeBird&&game.role==="pig")game.projectiles=[];
  if(state.phase!=="battle"&&state.phase!=="fortify")game.projectiles=[];
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
  $("#shopList").innerHTML=Object.entries(source).map(([key,spec])=>`<button class="shop-item ${!birdSide&&game.selectedKind===key?"selected":""}" data-shop="${key}" ${locked||spec.cost>game.serverState.credits[game.role]?"disabled":""}><span class="shop-swatch" style="background-color:${birdSide?"#dce8e8":materialColor(spec.material)}">${birdSide?birdSpriteMarkup(key,30):spec.material==="pig"?"猪":"▰"}</span><span><strong>${escapeText(spec.name)}</strong><small>${birdSide?escapeText(spec.ability):`${spec.hp} 耐久 · ${spec.w}×${spec.h}`}</small></span><span class="shop-cost">${spec.cost} ◉</span></button>`).join("");
  $$("[data-shop]").forEach(button=>button.addEventListener("click",()=>{if(birdSide)send({type:"buy_bird",bird:button.dataset.shop});else{game.selectedKind=button.dataset.shop;renderShop();toast(`已选择${game.itemSpecs[game.selectedKind].name}，移动鼠标预览位置`);}}));
  $("#queuePanel").classList.toggle("hidden",!birdSide);$("#birdQueue").innerHTML=(game.serverState.birdQueue||[]).map((bird,i)=>`<button class="queue-bird" data-sell="${i}" title="点击退回" aria-label="退回${game.birds[bird].name}">${birdSpriteMarkup(bird,27)}</button>`).join("");
  $$("[data-sell]").forEach(button=>button.addEventListener("click",()=>send({type:"sell_bird",index:+button.dataset.sell})));
  $("#sellBin").classList.toggle("hidden",birdSide||locked);
  const ready=game.serverState.ready.includes(game.role);$("#readyBtn").textContent=ready?"取消准备":"确认准备";$("#readyBtn").disabled=game.serverState.phase!=="fortify";
  $("#validationHint").textContent=birdSide?"每回合 1–6 只；点击队列中的小鸟可全额退回。":"放置 1–3 只猪；拖到左下角垃圾桶可全额卖出。";
  $("#canvasHint").textContent=game.serverState.phase==="fortify"?(birdSide?"购买小鸟并确认准备":"从左侧购买，点击虚线区放置；拖拽调整"):(birdSide?"拖动弹弓上的小鸟，松开发射":"观察来袭小鸟与堡垒状态");
}

function updateHud(force=true){
  const now=performance.now();if(!force&&now-game.hudAt<100)return;game.hudAt=now;
  if(game.mode==="single"){const score=String(Math.round(game.score)),pigs=String(livingPigs());if($("#birdScore").textContent!==score)$("#birdScore").textContent=score;if($("#pigScore").textContent!==pigs)$("#pigScore").textContent=pigs;}
  const current=game.projectiles.find(p=>p.primary&&!p.dead);$("#abilityPrompt").classList.toggle("hidden",!current||current.abilityUsed);
}

const simulation={engine:null,bodies:new Map(),ground:null,pending:new Set(),accumulator:0,supportAudit:0};
const particles=[];
function isAuthority(){return game.mode==="single"||game.role==="bird";}
function destroyPhysics(){if(simulation.engine)Composite.clear(simulation.engine.world,false,true);simulation.engine=null;simulation.bodies.clear();simulation.ground=null;simulation.pending.clear();simulation.accumulator=0;simulation.supportAudit=0;}
function bodyOptions(entity){
  const material={wood:{density:.0017,friction:.72,frictionStatic:1,restitution:.08},stone:{density:.0045,friction:.86,frictionStatic:1.2,restitution:.025},glass:{density:.0011,friction:.42,frictionStatic:.65,restitution:.16},pig:{density:.002,friction:.68,frictionStatic:.9,restitution:.22}}[entity.material];
  return {...material,frictionAir:.006,sleepThreshold:45,label:`entity:${entity.id}`,chamfer:entity.kind==="pig"?undefined:{radius:Math.min(3,entity.h/5)}};
}
function initPhysics(){
  destroyPhysics();if(!isAuthority()||game.phase!=="battle")return;
  const engine=Engine.create({enableSleeping:true});engine.gravity.y=1;engine.gravity.scale=.00072;simulation.engine=engine;
  simulation.ground=Bodies.rectangle(W/2,GROUND+38,W+500,76,{isStatic:true,label:"ground",friction:.92,restitution:.03});Composite.add(engine.world,simulation.ground);
  for(const entity of game.entities){
    if(entity.hp<=0)continue;const options=bodyOptions(entity);const body=entity.kind==="pig"?Bodies.circle(entity.x,entity.y,entity.w/2,options):Bodies.rectangle(entity.x,entity.y,entity.w,entity.h,options);
    Body.setAngle(body,entity.angle||0);body.gameEntity=entity;body.gameType="entity";simulation.bodies.set(entity.id,body);Composite.add(engine.world,body);
  }
  Events.on(engine,"collisionStart",event=>{for(const pair of event.pairs)resolveCollision(pair.bodyA,pair.bodyB);});
}
function resolveCollision(a,b){
  if(!game.shotAt)return;
  const av=a.velocity||{x:0,y:0},bv=b.velocity||{x:0,y:0},speed=Math.hypot(av.x-bv.x,av.y-bv.y)*60;
  const bird=a.gameType==="bird"?a:b.gameType==="bird"?b:null,target=bird==a?b:bird==b?a:null;
  if(bird&&target?.gameType==="entity"&&speed>85){
    const entity=target.gameEntity,resistance={glass:.42,wood:.82,stone:1.62,pig:.58}[entity.material]||1,power=game.birds[bird.projectile.type]?.power||1;
    damageEntity(entity,(speed-70)*.125*power/resistance,target,true);
  }else if(speed>190){
    for(const body of [a,b])if(body.gameType==="entity"){const entity=body.gameEntity,resistance={glass:.48,wood:1,stone:2.1,pig:.68}[entity.material]||1;damageEntity(entity,(speed-170)*.032/resistance,body,false);}
  }
}
function damageEntity(entity,amount,body,direct){
  if(!Number.isFinite(amount)||amount<=0||entity.hp<=0)return;const wasAlive=entity.hp>0;entity.hp=Math.max(0,entity.hp-amount);game.score+=amount*(direct?14:6);
  if(amount>10){game.shake=Math.min(11,game.shake+amount*.045);game.impactFlash=Math.min(1,game.impactFlash+amount/130);burst(body.position.x,body.position.y,materialColor(entity.material),Math.min(18,5+Math.round(amount/12)));}
  if(wasAlive&&entity.hp<=0){game.score+=entity.kind==="pig"?1200:350;simulation.pending.add(body);burst(entity.x,entity.y,materialColor(entity.material),20);}
}
function wakeDynamicBodies(){
  for(const body of simulation.bodies.values())if(!body.isStatic)Sleeping.set(body,false);
}
function wakeUnsupportedBodies(dt){
  simulation.supportAudit+=dt;if(simulation.supportAudit<.2)return;simulation.supportAudit=0;
  const bodies=[...simulation.bodies.values()];
  for(const body of bodies){
    if(!body.isSleeping||body.isStatic||body.bounds.max.y>=GROUND-2)continue;
    const bottom=body.bounds.max.y,minOverlap=Math.min(12,(body.bounds.max.x-body.bounds.min.x)*.25);
    const supported=bodies.some(base=>{
      if(base===body||base.gameEntity?.hp<=0)return false;const gap=base.bounds.min.y-bottom;
      const overlap=Math.min(body.bounds.max.x,base.bounds.max.x)-Math.max(body.bounds.min.x,base.bounds.min.x);
      return gap>=-5&&gap<=12&&overlap>=minOverlap;
    });
    if(!supported)Sleeping.set(body,false);
  }
}
function makeProjectile(type,x,y,vx,vy,primary=true,id="bird",r=type==="bomb"?22:18){
  const projectile={id,type,x,y,vx,vy,angle:Math.atan2(vy,vx),r,primary,abilityUsed:false,dead:false,age:0,body:null};
  if(simulation.engine&&isAuthority()){
    const body=Bodies.circle(x,y,r,{label:`bird:${id}`,density:.0048,friction:.62,frictionAir:.002,restitution:.36,slop:.02,sleepThreshold:55});body.gameType="bird";body.projectile=projectile;projectile.body=body;
    Body.setAngle(body,projectile.angle);Body.setAngularVelocity(body,vx>=0?.075:-.075);Body.setVelocity(body,{x:vx/60,y:vy/60});Composite.add(simulation.engine.world,body);
  }
  return projectile;
}
function startProjectile(type,vx,vy){
  if(isAuthority()&&!simulation.engine)initPhysics();game.projectiles=[makeProjectile(type,SLING.x,SLING.y,vx,vy)];
  game.abilityUsed=false;game.shotAt=performance.now();game.shotSleeping=0;$("#phaseLabel").textContent=`${game.birds[type].name}飞行中`;
}
function setProjectileVelocity(projectile,vx,vy){projectile.vx=vx;projectile.vy=vy;if(projectile.body)Body.setVelocity(projectile.body,{x:vx/60,y:vy/60});}
function useAbility(){
  const bird=game.projectiles.find(p=>p.primary&&!p.dead&&!p.abilityUsed);if(!bird)return;bird.abilityUsed=true;
  if(bird.type==="red"){setProjectileVelocity(bird,bird.vx*1.35,bird.vy*1.18);burst(bird.x,bird.y,"#ef5b42",18);}
  else if(bird.type==="yellow"){setProjectileVelocity(bird,bird.vx*1.72,bird.vy*1.33);burst(bird.x,bird.y,"#f5c43e",20);}
  else if(bird.type==="blue"){
    for(const sign of [-1,1])game.projectiles.push(makeProjectile("blue",bird.x,bird.y,bird.vx+sign*35,bird.vy+sign*175,false,`split${sign}`,12));burst(bird.x,bird.y,"#7dd9f0",22);
  }else if(bird.type==="bomb"){explode(bird.x,bird.y,150,120);bird.dead=true;if(bird.body)simulation.pending.add(bird.body);}
  updateHud();
}
function burst(x,y,color,count=14){for(let i=0;i<count;i++){const a=Math.random()*Math.PI*2,s=55+Math.random()*210;particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:.45+Math.random()*.4,color,size:2+Math.random()*5,spin:(Math.random()-.5)*8,angle:Math.random()*6});}}
function explode(x,y,r,damage){
  burst(x,y,"#efb438",42);game.shake=14;game.impactFlash=1;
  for(const entity of game.entities){if(entity.hp<=0)continue;const d=Math.hypot(entity.x-x,entity.y-y);if(d>=r)continue;const body=simulation.bodies.get(entity.id),factor=1-d/r;damageEntity(entity,damage*factor*(entity.material==="stone"?.62:1.18),body||{position:entity},true);if(body){const nx=(entity.x-x)/(d||1),ny=(entity.y-y)/(d||1);Body.setVelocity(body,{x:body.velocity.x+nx*factor*12,y:body.velocity.y+ny*factor*12});Sleeping.set(body,false);}}
  game.score+=500;
}
function livingPigs(){return game.entities.filter(e=>e.kind==="pig"&&e.hp>0&&e.y<720).length;}
function physics(dt){
  const authority=isAuthority();
  if(game.phase==="battle"&&authority&&simulation.engine){
    const fixedStep=1000/60;simulation.accumulator=Math.min(fixedStep*3,simulation.accumulator+dt*1000);while(simulation.accumulator>=fixedStep){Engine.update(simulation.engine,fixedStep);simulation.accumulator-=fixedStep;}
    for(const [id,body] of simulation.bodies){const entity=body.gameEntity;if(!entity||entity.hp<=0)continue;entity.x=body.position.x;entity.y=body.position.y;entity.angle=body.angle;entity.vx=body.velocity.x*60;entity.vy=body.velocity.y*60;if(entity.x<-140||entity.x>1340||entity.y>760){entity.hp=0;simulation.pending.add(body);}}
    for(const projectile of game.projectiles){if(projectile.body){projectile.x=projectile.body.position.x;projectile.y=projectile.body.position.y;projectile.vx=projectile.body.velocity.x*60;projectile.vy=projectile.body.velocity.y*60;projectile.angle=projectile.body.angle;projectile.age+=dt;}if(projectile.x>1350||projectile.x<-150||projectile.y>760||projectile.age>20){projectile.dead=true;if(projectile.body)simulation.pending.add(projectile.body);}}
    let removedStructure=false;for(const body of simulation.pending){Composite.remove(simulation.engine.world,body);if(body.gameType==="entity"){simulation.bodies.delete(body.gameEntity.id);removedStructure=true;}if(body.gameType==="bird"&&body.projectile)body.projectile.body=null;}simulation.pending.clear();if(removedStructure)wakeDynamicBodies();
    wakeUnsupportedBodies(dt);
    const activeProjectile=game.projectiles.some(p=>!p.dead&&(p.body?(!p.body.isSleeping&&p.body.speed>.28):Math.hypot(p.vx,p.vy)>18)&&p.age<20),activeStructure=[...simulation.bodies.values()].some(body=>!body.isSleeping&&body.speed>.24);const active=activeProjectile||activeStructure;
    if(game.projectiles.length){game.shotSleeping=active?0:game.shotSleeping+dt;if(game.shotSleeping>1.15||performance.now()-game.shotAt>20000)endShot();}
    if(game.mode==="multi"&&game.role==="bird"&&game.projectiles.length&&performance.now()-game.simSent>66){game.simSent=performance.now();const bird=game.projectiles[0];send({type:"sim",entities:game.entities.map(entity=>({id:entity.id,x:entity.x,y:entity.y,vx:entity.vx,vy:entity.vy,angle:entity.angle,hp:entity.hp})),bird:bird?{x:bird.x,y:bird.y,angle:Math.atan2(Math.sin(bird.angle),Math.cos(bird.angle))}:null});}
  }else if(game.phase==="battle"&&!authority){
    const blend=1-Math.exp(-20*dt);
    for(const entity of game.entities)if(Number.isFinite(entity.netX)){entity.x+=(entity.netX-entity.x)*blend;entity.y+=(entity.netY-entity.y)*blend;const delta=Math.atan2(Math.sin(entity.netAngle-entity.angle),Math.cos(entity.netAngle-entity.angle));entity.angle+=delta*blend;}
    for(const projectile of game.projectiles)if(Number.isFinite(projectile.netX)){projectile.x+=(projectile.netX-projectile.x)*blend;projectile.y+=(projectile.netY-projectile.y)*blend;const delta=Math.atan2(Math.sin(projectile.netAngle-projectile.angle),Math.cos(projectile.netAngle-projectile.angle));projectile.angle+=delta*blend;}
  }
  for(const particle of particles){particle.vy+=330*dt;particle.x+=particle.vx*dt;particle.y+=particle.vy*dt;particle.angle+=particle.spin*dt;particle.life-=dt;}
  for(let i=particles.length-1;i>=0;i--)if(particles[i].life<=0)particles.splice(i,1);game.shake=Math.max(0,game.shake-28*dt);game.impactFlash=Math.max(0,game.impactFlash-3.5*dt);updateHud(false);
}
function endShot(){
  if(!game.projectiles.length)return;for(const projectile of game.projectiles)if(projectile.body&&simulation.engine)Composite.remove(simulation.engine.world,projectile.body);game.projectiles=[];game.shotSleeping=0;
  if(livingPigs()===0){if(game.mode==="single")finishSingle(true);else if(game.role==="bird")sendShotEnd();return;}
  if(game.mode==="single"){
    if(!game.queue.length)finishSingle(false);else{$("#phaseLabel").textContent="准备发射";$("#canvasHint").textContent="拖动下一只小鸟";}
  } else if(game.role==="bird")sendShotEnd();
}
function sendShotEnd(){send({type:"shot_end",entities:game.entities.map(e=>({id:e.id,x:e.x,y:e.y,angle:e.angle||0,hp:e.hp}))});}
function applyRemoteSim(message){
  const map=new Map(game.entities.map(e=>[e.id,e]));for(const remote of message.entities||[]){const e=map.get(remote.id);if(e){e.netX=remote.x;e.netY=remote.y;e.netAngle=Number.isFinite(remote.angle)?remote.angle:e.angle;e.vx=remote.vx;e.vy=remote.vy;e.hp=remote.hp;}}
  if(message.bird&&game.projectiles[0]){const bird=game.projectiles[0];bird.netX=message.bird.x;bird.netY=message.bird.y;bird.netAngle=Number.isFinite(message.bird.angle)?message.bird.angle:bird.angle;}
}

function canvasPoint(event){const rect=canvas.getBoundingClientRect();return{x:(event.clientX-rect.left)*W/rect.width,y:(event.clientY-rect.top)*H/rect.height};}
function itemAt(point){return [...game.entities].reverse().find(e=>e.hp>0&&Math.abs(point.x-e.x)<=e.w/2+5&&Math.abs(point.y-e.y)<=e.h/2+5);}
function overSellBin(clientX,clientY,point){const bin=$("#sellBin"),rect=bin.getBoundingClientRect(),insideRect=clientX>=rect.left&&clientX<=rect.right&&clientY>=rect.top&&clientY<=rect.bottom,insideCanvasZone=point.x<=190&&point.y>=500;return !bin.classList.contains("hidden")&&(insideRect||insideCanvasZone);}
function setSellBinDrag(active){$("#sellBin").classList.toggle("drag-over",active);}
function sellDraggedItem(){
  if(!game.dragging)return false;const e=game.entities.find(item=>item.id===game.dragging.id);if(!e)return false;
  Object.assign(e,game.dragging.origin);send({type:"build",action:"remove",id:e.id});toast(`${game.itemSpecs[e.kind].name}已卖出，全额返还`);game.dragging=null;setSellBinDrag(false);return true;
}
function validatePreview(candidate,excludeId=null){
  if(candidate.rawX<700||candidate.rawX>1165||candidate.rawY<80||candidate.rawY>GROUND)return {valid:false,reason:"移入虚线建造区"};
  if(candidate.x-candidate.w/2<700||candidate.x+candidate.w/2>1165||candidate.y-candidate.h/2<80||candidate.y+candidate.h/2>GROUND)return {valid:false,reason:"超出建造边界"};
  if(candidate.kind==="pig"&&!excludeId&&game.entities.filter(e=>e.kind==="pig"&&e.hp>0).length>=3)return {valid:false,reason:"最多安置 3 只猪"};
  const collision=game.entities.some(e=>e.id!==excludeId&&e.hp>0&&Math.abs(candidate.x-e.x)<(candidate.w+e.w)/2-2&&Math.abs(candidate.y-e.y)<(candidate.h+e.h)/2-2);
  if(collision)return {valid:false,reason:"这里与已有物品重叠"};
  return {valid:true,reason:"点击放置"};
}
function placementPreview(){
  if(!game.selectedKind||!game.pointer.inside||game.dragging||game.phase!=="fortify"||game.role!=="pig")return null;const spec=game.itemSpecs[game.selectedKind];if(!spec)return null;
  const rawX=game.pointer.x,rawY=game.pointer.y,x=Math.max(700+spec.w/2,Math.min(1165-spec.w/2,Math.round(rawX/5)*5)),y=Math.max(80+spec.h/2,Math.min(GROUND-spec.h/2,Math.round(rawY/5)*5));
  const candidate={id:"preview",kind:game.selectedKind,material:spec.material,w:spec.w,h:spec.h,hp:spec.hp,maxHp:spec.hp,x,y,rawX,rawY,angle:0};return {...candidate,...validatePreview(candidate)};
}
canvas.addEventListener("pointerdown",event=>{
  const point=canvasPoint(event);game.pointer={...point,inside:true};
  if(game.mode==="multi"&&game.role==="pig"&&game.phase==="fortify"&&!game.serverState.ready.includes("pig")){
    const existing=itemAt(point);if(existing){game.dragging={id:existing.id,dx:point.x-existing.x,dy:point.y-existing.y,origin:{x:existing.x,y:existing.y},valid:true,overBin:false};canvas.setPointerCapture(event.pointerId);}
    else if(game.selectedKind){const preview=placementPreview();if(preview?.valid)send({type:"build",action:"add",kind:game.selectedKind,x:preview.x,y:preview.y});else toast(preview?.reason||"当前位置不能放置");}else toast("请先从左侧选择建筑物品");return;
  }
  if(game.role==="bird"&&game.phase==="battle"&&!game.projectiles.length&&game.queue.length&&Math.hypot(point.x-SLING.x,point.y-SLING.y)<55){game.aiming=true;game.aim=point;canvas.setPointerCapture(event.pointerId);return;}
  if(game.projectiles.length)useAbility();
});
canvas.addEventListener("pointermove",event=>{
  const point=canvasPoint(event);game.pointer={...point,inside:true};if(game.aiming){const dx=point.x-SLING.x,dy=point.y-SLING.y,len=Math.hypot(dx,dy),scale=Math.min(125,len)/(len||1);game.aim={x:SLING.x+dx*scale,y:SLING.y+dy*scale};}
  if(game.dragging){game.dragging.overBin=overSellBin(event.clientX,event.clientY,point);setSellBinDrag(game.dragging.overBin);const e=game.entities.find(item=>item.id===game.dragging.id);if(e&&!game.dragging.overBin){e.x=Math.max(700+e.w/2,Math.min(1165-e.w/2,Math.round((point.x-game.dragging.dx)/5)*5));e.y=Math.max(80+e.h/2,Math.min(GROUND-e.h/2,Math.round((point.y-game.dragging.dy)/5)*5));game.dragging.valid=validatePreview({...e,rawX:point.x,rawY:point.y},e.id).valid;}}
});
canvas.addEventListener("pointerup",event=>{
  if(game.aiming){game.aiming=false;const dx=SLING.x-game.aim.x,dy=SLING.y-game.aim.y,power=Math.hypot(dx,dy);game.aim={...SLING};if(power<22){toast("再向后多拉一些");return;}const vx=dx*8.2,vy=dy*8.2;if(game.mode==="multi")send({type:"fire",vx,vy});else{const bird=game.queue.shift();startProjectile(bird,vx,vy);} }
  if(game.dragging){const e=game.entities.find(item=>item.id===game.dragging.id);if(game.dragging.overBin){sellDraggedItem();}else{if(e&&game.dragging.valid)send({type:"build",action:"move",id:e.id,x:e.x,y:e.y});else if(e){Object.assign(e,game.dragging.origin);toast("该位置与其他物品重叠");}game.dragging=null;setSellBinDrag(false);}}
});
canvas.addEventListener("pointerenter",event=>{game.pointer={...canvasPoint(event),inside:true};});
canvas.addEventListener("pointerleave",()=>{game.pointer.inside=false;});
canvas.addEventListener("contextmenu",event=>{event.preventDefault();if(game.mode==="multi"&&game.role==="pig"&&game.phase==="fortify"){const e=itemAt(canvasPoint(event));if(e)send({type:"build",action:"remove",id:e.id});}});
$("#sellBin").addEventListener("pointerenter",()=>{if(game.dragging){game.dragging.overBin=true;setSellBinDrag(true);}});
$("#sellBin").addEventListener("pointerleave",()=>{if(game.dragging){game.dragging.overBin=false;setSellBinDrag(false);}});
$("#sellBin").addEventListener("pointerup",event=>{if(game.dragging){event.preventDefault();sellDraggedItem();}});
$("#sellBin").addEventListener("click",()=>{if(!game.dragging)toast("按住堡垒中的物品，把它拖进垃圾桶即可全额卖出");});

function drawBird(x,y,type,r=18,angle=0,alpha=1){
  const image=images.birdSheet,sprite=BIRD_SPRITES[type]||BIRD_SPRITES.red;ctx.save();ctx.translate(x,y);ctx.rotate(Number.isFinite(angle)?angle:0);ctx.globalAlpha=alpha;
  if(image?.complete&&image.naturalWidth){const scale={red:[2.65,2.55],yellow:[3.25,2.72],blue:[2.75,2.75],bomb:[2.65,3.05]}[type]||[2.6,2.6],width=r*scale[0],height=r*scale[1];ctx.drawImage(image,sprite.x,sprite.y,sprite.w,sprite.h,-width*.5,-height*.5,width,height);}
  else{ctx.fillStyle=birdColor(type);ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fill();}
  ctx.restore();
}
function drawPig(e,alpha=1){
  ctx.save();ctx.translate(e.x,e.y);ctx.rotate(e.angle||0);ctx.globalAlpha=alpha;const width=e.w*1.5,height=e.h*1.48;
  if(images.pig.complete&&images.pig.naturalWidth)ctx.drawImage(images.pig,-width/2,-height/2,width,height);else{ctx.fillStyle="#98cc45";ctx.beginPath();ctx.arc(0,0,e.w/2,0,Math.PI*2);ctx.fill();}
  if(e.hp/e.maxHp<.55&&alpha>.5){ctx.strokeStyle="rgba(40,52,32,.8)";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(-8,-18);ctx.lineTo(-2,-7);ctx.lineTo(-7,3);ctx.moveTo(13,-15);ctx.lineTo(7,-5);ctx.stroke();}ctx.restore();
}
function drawItem(e,alpha=1){
  if(e.hp<=0)return;if(e.kind==="pig"){drawPig(e,alpha);return;}ctx.save();ctx.translate(e.x,e.y);ctx.rotate(e.angle||0);ctx.fillStyle=materialColor(e.material);ctx.strokeStyle="#20353c";ctx.lineWidth=2;ctx.globalAlpha=alpha*(.72+.28*Math.max(0,e.hp/e.maxHp));ctx.fillRect(-e.w/2,-e.h/2,e.w,e.h);ctx.strokeRect(-e.w/2,-e.h/2,e.w,e.h);
  if(e.material==="wood"){ctx.fillStyle="rgba(255,214,135,.18)";ctx.fillRect(-e.w/2+3,-e.h/2+3,e.w-6,Math.max(2,e.h*.22));ctx.strokeStyle="rgba(70,36,13,.38)";for(let x=-e.w/2+12;x<e.w/2;x+=22){ctx.beginPath();ctx.moveTo(x,-e.h/2);ctx.lineTo(x+7,e.h/2);ctx.stroke();}}
  else if(e.material==="stone"){ctx.fillStyle="rgba(255,255,255,.16)";ctx.fillRect(-e.w/2+3,-e.h/2+3,e.w-6,Math.max(2,e.h*.2));ctx.strokeStyle="rgba(42,53,56,.35)";for(let x=-e.w/2+22;x<e.w/2;x+=34){ctx.beginPath();ctx.moveTo(x,-e.h/2);ctx.lineTo(x-5,e.h/2);ctx.stroke();}}
  else{ctx.fillStyle="rgba(255,255,255,.45)";ctx.fillRect(-e.w/2+5,-e.h/2+3,e.w*.42,3);ctx.strokeStyle="rgba(32,90,104,.4)";ctx.beginPath();ctx.moveTo(-e.w*.18,-e.h/2);ctx.lineTo(-e.w*.05,e.h/2);ctx.stroke();}
  if(e.hp/e.maxHp<.62&&alpha>.5){ctx.strokeStyle="rgba(38,33,31,.75)";ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(-e.w*.12,-e.h/2);ctx.lineTo(0,-2);ctx.lineTo(-e.w*.08,e.h/2);ctx.stroke();}ctx.restore();
}
function draw(){
  ctx.clearRect(0,0,W,H);ctx.save();if(game.shake>0)ctx.translate((Math.random()-.5)*game.shake,(Math.random()-.5)*game.shake);if(images.background.complete)ctx.drawImage(images.background,0,0,W,GROUND);else{ctx.fillStyle="#91d5e4";ctx.fillRect(0,0,W,GROUND);}
  ctx.fillStyle="#699f43";ctx.fillRect(0,GROUND,W,H-GROUND);ctx.fillStyle="#85bb52";ctx.fillRect(0,GROUND,W,12);
  if(game.mode==="multi"&&game.phase==="fortify"){ctx.save();ctx.setLineDash([10,8]);ctx.lineWidth=3;ctx.strokeStyle="rgba(233,75,53,.7)";ctx.fillStyle="rgba(255,249,233,.12)";ctx.fillRect(700,80,465,GROUND-80);ctx.strokeRect(700,80,465,GROUND-80);ctx.fillStyle="#8c332c";ctx.font="800 13px sans-serif";ctx.fillText("小猪建造区",715,105);ctx.restore();}
  for(const e of game.entities)drawItem(e,(game.dragging?.id===e.id)?0.62:1);
  const preview=placementPreview();if(preview){drawItem(preview,.43);ctx.save();ctx.strokeStyle=preview.valid?"#64b93f":"#e14736";ctx.lineWidth=3;ctx.setLineDash([7,5]);ctx.strokeRect(preview.x-preview.w/2-4,preview.y-preview.h/2-4,preview.w+8,preview.h+8);ctx.setLineDash([]);ctx.font="800 11px sans-serif";const label=preview.reason,width=ctx.measureText(label).width+16;ctx.fillStyle=preview.valid?"rgba(39,100,50,.9)":"rgba(153,45,38,.92)";ctx.fillRect(preview.x-width/2,preview.y-preview.h/2-29,width,20);ctx.fillStyle="#fff";ctx.fillText(label,preview.x-width/2+8,preview.y-preview.h/2-15);ctx.restore();}
  if(game.dragging&&!game.dragging.valid){const e=game.entities.find(item=>item.id===game.dragging.id);if(e){ctx.save();ctx.strokeStyle="#e14736";ctx.lineWidth=4;ctx.setLineDash([6,5]);ctx.strokeRect(e.x-e.w/2-4,e.y-e.h/2-4,e.w+8,e.h+8);ctx.restore();}}
  if(game.role==="bird"||game.mode==="single"){
    ctx.drawImage(images.sling,SLING.x-44,SLING.y-43,84,176);const canAim=game.phase==="battle"&&!game.projectiles.length&&game.queue.length;
    if(canAim){const pos=game.aiming?game.aim:SLING;if(game.aiming){ctx.strokeStyle="#4c291b";ctx.lineWidth=7;ctx.beginPath();ctx.moveTo(SLING.x-19,SLING.y-5);ctx.lineTo(pos.x,pos.y);ctx.lineTo(SLING.x+18,SLING.y-8);ctx.stroke();drawTrajectory(pos); }drawBird(pos.x,pos.y,game.queue[0],game.queue[0]==="bomb"?22:18,game.aiming?Math.atan2(SLING.y-pos.y,SLING.x-pos.x):0);}
  }
  for(const p of game.projectiles)if(!p.dead)drawBird(p.x,p.y,p.type,p.r,p.angle||0);
  for(const p of particles){ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.angle);ctx.globalAlpha=Math.max(0,Math.min(1,p.life/.45));ctx.fillStyle=p.color;ctx.fillRect(-p.size/2,-p.size/2,p.size,p.size);ctx.restore();}ctx.restore();
  if(game.impactFlash>0){ctx.fillStyle=`rgba(255,244,190,${game.impactFlash*.16})`;ctx.fillRect(0,0,W,H);}
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
$("#exitGame").addEventListener("click",()=>{if(game.mode==="multi"&&!confirm("确定退出？若另一位玩家仍在线，房间最多再保留 3 分钟；双方均退出后立即销毁。"))return;if(game.mode==="multi")send({type:"leave_room"});game.phase="menu";game.projectiles=[];game.entities=[];game.room=null;game.serverState=null;destroyPhysics();sessionStorage.removeItem("flock-session");showScreen("home")});
$("#soundBtn").addEventListener("click",()=>{game.sound=!game.sound;$("#soundBtn").textContent=game.sound?"♪":"×"});
$("#emotes").addEventListener("click",event=>{if(event.target.tagName==="BUTTON"&&game.mode==="multi")send({type:"emote",emote:event.target.textContent})});
window.addEventListener("keydown",event=>{if(event.code==="Space"){event.preventDefault();useAbility()}if(event.key.toLowerCase()==="r"&&game.mode==="single"&&$("#game").classList.contains("active"))startSingle(game.level);if(event.key==="Escape"&&$("#rulesDialog").open)$("#rulesDialog").close();});
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&game.mode==="multi")connect()});
renderLevels();connect();
