/* End-to-end protocol smoke test. Requires a running local server. */
const url = process.env.FLOCK_TEST_WS || "ws://127.0.0.1:18080/ws";

function peer(name) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (waiters[index].predicate(message)) {
        waiters[index].resolve(message);
        waiters.splice(index, 1);
      }
    }
  });
  function wait(predicate, timeout = 2500) {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const entry = {predicate, resolve};
      waiters.push(entry);
      setTimeout(() => {
        const index = waiters.indexOf(entry);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`${name}: timed out; received ${messages.map(item => item.type).join(",")}`));
      }, timeout).unref();
    });
  }
  return {ws, messages, wait, send: payload => ws.send(JSON.stringify(payload))};
}

async function stateAfter(peer, action) {
  const before = Math.max(0, ...peer.messages.filter(message => message.type === "state").map(message => message.eventId || 0));
  peer.send(action);
  return peer.wait(message => message.type === "state" && (message.eventId || 0) > before);
}

const bird = peer("bird");
const pig = peer("pig");
try {
await Promise.all([bird.wait(message => message.type === "hello"), pig.wait(message => message.type === "hello")]);
bird.send({type:"create_room", name:"test-bird"});
const joinedBird = await bird.wait(message => message.type === "joined");
pig.send({type:"join_room", room:joinedBird.room, name:"test-pig"});
await pig.wait(message => message.type === "joined");
await bird.wait(message => message.type === "state" && message.phase === "fortify");

await stateAfter(bird, {type:"buy_bird", bird:"red"});
for (const build of [
  {kind:"wood_post",x:820,y:540}, {kind:"wood_post",x:920,y:540},
  {kind:"wood_beam",x:870,y:480}, {kind:"pig",x:870,y:569},
]) await stateAfter(pig, {type:"build",action:"add",...build});

await stateAfter(bird, {type:"ready"});
await stateAfter(pig, {type:"ready"});
await bird.wait(message => message.type === "state" && message.phase === "battle");
bird.send({type:"fire",vx:700,vy:-320});
await Promise.all([bird.wait(message => message.type === "fired"),pig.wait(message => message.type === "fired")]);
await new Promise(resolve => setTimeout(resolve, 700));
const battleState = bird.messages.filter(message => message.type === "state").at(-1);
bird.send({type:"shot_end",entities:battleState.items.map(item=>({...item,hp:item.kind==="pig"?0:item.hp}))});
const result = await bird.wait(message => message.type === "round_result");
if (result.winner !== "bird" || result.state.scores.bird !== 1) throw new Error("unexpected round result");
bird.send({type:"next_round"}); pig.send({type:"next_round"});
const roundTwo = await bird.wait(message => message.type === "state" && message.phase === "fortify" && message.round === 2);
if (roundTwo.credits.pig <= 700) throw new Error("loss bonus was not awarded");
bird.ws.close(); pig.ws.close();
console.log(`multiplayer smoke ok: room ${joinedBird.room}, round ${roundTwo.round}`);
} catch (error) {
  console.error("bird messages", bird.messages.map(message => [message.type,message.phase,message.message]));
  console.error("pig messages", pig.messages.map(message => [message.type,message.phase,message.message]));
  bird.ws.close(); pig.ws.close();
  throw error;
}
