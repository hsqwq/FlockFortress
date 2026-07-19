/* Opens 20 two-player rooms to verify connection limits and memory behavior. */
const url = process.env.FLOCK_TEST_WS || "ws://127.0.0.1:18080/ws";
function openPeer() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const listeners = [];
    ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      for (let index = listeners.length - 1; index >= 0; index--) {
        if (listeners[index].predicate(message)) { listeners[index].resolve(message); listeners.splice(index, 1); }
      }
    });
    ws.addEventListener("error", reject, {once:true});
    const peer = {ws, send:value=>ws.send(JSON.stringify(value)), wait:predicate=>new Promise((res,rej)=>{
      const entry={predicate,resolve:res};listeners.push(entry);setTimeout(()=>{const i=listeners.indexOf(entry);if(i>=0)listeners.splice(i,1);rej(new Error("timeout"));},2500).unref();
    })};
    ws.addEventListener("open", async()=>{try{await peer.wait(message=>message.type==="hello");resolve(peer)}catch(error){reject(error)}},{once:true});
  });
}
const peers = await Promise.all(Array.from({length:40},()=>openPeer()));
for(let index=0;index<20;index++){
  const bird=peers[index*2],pig=peers[index*2+1];bird.send({type:"create_room",name:`b${index}`});
  const joined=await bird.wait(message=>message.type==="joined");pig.send({type:"join_room",room:joined.room,name:`p${index}`});await pig.wait(message=>message.type==="joined");
}
console.log("load smoke ok: 40 connections, 20 active rooms");
await new Promise(resolve=>setTimeout(resolve,1200));
for(const peer of peers)peer.ws.close();
