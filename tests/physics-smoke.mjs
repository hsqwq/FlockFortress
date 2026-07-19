/* Verifies that the fixed-step Matter.js world settles a representative tower. */
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const Matter = require("../public/vendor/matter.min.js");
const {Engine, Bodies, Composite, Sleeping} = Matter;

const engine = Engine.create({enableSleeping:true});
engine.gravity.y = 1;
engine.gravity.scale = 0.00072;
Composite.add(engine.world, Bodies.rectangle(600, 628, 1700, 76, {isStatic:true, friction:.92, restitution:.03}));

const definitions = [
  ["post",850,540,22,100],["post",950,540,22,100],["beam",900,480,110,20],["pig",900,555,42,42],
  ["post",850,420,22,100],["post",950,420,22,100],["beam",900,360,110,20],["pig",900,445,42,42],
];
const bodies = definitions.map(([kind,x,y,w,h]) => kind === "pig"
  ? Bodies.circle(x,y,w/2,{density:.002,friction:.68,frictionStatic:.9,restitution:.22})
  : Bodies.rectangle(x,y,w,h,{density:.0017,friction:.72,frictionStatic:1,restitution:.08,chamfer:{radius:3}}));
Composite.add(engine.world,bodies);

let accumulator = 0;
const fixedStep = 1000/60;
for(let frame=0;frame<240;frame++){
  const frameDelta = [16.7, 8.3, 25, 16.1][frame%4];
  accumulator = Math.min(fixedStep*3, accumulator+frameDelta);
  while(accumulator>=fixedStep){Engine.update(engine,fixedStep);accumulator-=fixedStep;}
}
for(let index=0;index<bodies.length;index++){
  const body=bodies[index],[,startX,startY]=definitions[index];
  if(Math.abs(body.position.x-startX)>12||Math.abs(body.position.y-startY)>20||body.speed>.35){
    throw new Error(`tower body ${index} failed to settle: ${JSON.stringify({position:body.position,speed:body.speed})}`);
  }
}

// Removing any supporting entity must wake every sleeping dynamic body so no
// pig, beam, or post can remain suspended after its support disappears.
const support=Bodies.rectangle(1090,540,22,100,{density:.0017});
const suspended=Bodies.rectangle(1090,480,110,20,{density:.0017});
Composite.add(engine.world,[support,suspended]);
for(let frame=0;frame<120;frame++)Engine.update(engine,fixedStep);
Sleeping.set(support,true);Sleeping.set(suspended,true);
const beforeDrop=suspended.position.y;
Composite.remove(engine.world,support);
for(const body of [...bodies,suspended])Sleeping.set(body,false);
for(let frame=0;frame<45;frame++)Engine.update(engine,fixedStep);
if(suspended.position.y<beforeDrop+25)throw new Error(`unsupported body did not fall: ${suspended.position.y-beforeDrop}`);

console.log("physics smoke ok: tower stable and unsupported bodies wake/fall");
