const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const BASE_COUNT = 10;
const rooms = new Map();
const clients = new Map();
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function makeCode(mode) {
  let code;
  do {
    code = (mode === "solo" ? "S" : "P") +
      Array.from({length:5}, () => CODE_CHARS[Math.floor(Math.random()*CODE_CHARS.length)]).join("");
  } while ([...rooms.values()].some(r => r.code === code));
  return code;
}
function send(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }
function publicPlayer(p) {
  return {id:p.id,name:p.name,gender:p.gender,x:p.x,y:p.y,z:p.z,yaw:p.yaw,baseId:p.baseId,
    rebirth:p.baseState.rebirth,runners:p.baseState.runners};
}
function roomPlayers(room) { return [...room.players.values()].map(publicPlayer); }
function broadcast(room, data, exceptId) {
  for (const p of room.players.values()) if (p.id !== exceptId) send(p.ws, data);
}
function leave(ws) {
  const c = clients.get(ws); if (!c) return;
  clients.delete(ws);
  const room = rooms.get(c.roomId); if (!room) return;
  room.players.delete(c.id);
  broadcast(room,{type:"player-left",id:c.id,name:c.name,baseId:c.baseId,count:room.players.size});
  if (room.players.size === 0) rooms.delete(c.roomId);
}
function fail(ws,message){send(ws,{type:"error",message});}
const server=http.createServer((req,res)=>{
  if(req.url==="/health"||req.url==="/"){
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({ok:true,service:"Steal a Show Runner multiplayer",rooms:rooms.size,players:clients.size}));
  }else{res.writeHead(404);res.end("Not found");}
});
const wss=new WebSocketServer({server,maxPayload:16384});
wss.on("connection",ws=>{
  ws.on("message",raw=>{
    let msg;try{msg=JSON.parse(raw.toString());}catch{return fail(ws,"Invalid message.");}
    if(msg.type==="join"){
      if(clients.has(ws))return fail(ws,"Already joined a room.");
      const mode=msg.mode==="online"?"online":"solo",code=String(msg.code||"").toUpperCase().trim();
      let room;
      if(code){
        room=[...rooms.values()].find(r=>r.code===code);
        if(!room)return fail(ws,"Invite code not found. Ask the host to open their room first.");
        if(room.mode!==mode)return fail(ws,"That invite code is for a different room type.");
      }else if(mode==="online"){
        room=[...rooms.values()].find(r=>r.mode==="online"&&r.public&&r.players.size<MAX_PLAYERS);
        if(!room){const id=crypto.randomUUID();room={id,code:makeCode("online"),mode:"online",public:true,players:new Map()};rooms.set(id,room);}
      }else{
        const id=crypto.randomUUID();room={id,code:makeCode("solo"),mode:"solo",public:false,players:new Map()};rooms.set(id,room);
      }
      if(room.players.size>=MAX_PLAYERS)return fail(ws,"This room is full (8/8).");
      const used=new Set([...room.players.values()].map(p=>p.baseId));
      let baseId=Array.from({length:BASE_COUNT},(_,i)=>i).find(i=>!used.has(i));
      if(baseId===undefined)return fail(ws,"All bases in this room are occupied.");
      const player={id:crypto.randomUUID(),ws,
        name:String(msg.name||"Guest").replace(/[^A-Za-z0-9_ -]/g,"").slice(0,16)||"Guest",
        gender:msg.gender==="female"?"female":"male",x:0,y:0,z:0,yaw:0,roomId:room.id,baseId,
        baseState:{rebirth:0,runners:[]}};
      room.players.set(player.id,player);clients.set(ws,player);
      send(ws,{type:"joined",id:player.id,code:room.code,baseId,count:room.players.size,players:roomPlayers(room).filter(p=>p.id!==player.id)});
      broadcast(room,{type:"player-joined",player:publicPlayer(player),count:room.players.size},player.id);
      return;
    }
    const player=clients.get(ws);if(!player)return fail(ws,"Join a room first.");
    const room=rooms.get(player.roomId);if(!room)return fail(ws,"Room no longer exists.");
    if(msg.type==="move"){
      const n=v=>Number.isFinite(Number(v))?Math.max(-1000,Math.min(1000,Number(v))):0;
      player.x=n(msg.x);player.y=n(msg.y);player.z=n(msg.z);player.yaw=n(msg.yaw);
      broadcast(room,{type:"state",players:[{id:player.id,name:player.name,gender:player.gender,x:player.x,y:player.y,z:player.z,yaw:player.yaw,baseId:player.baseId}]},player.id);
    }else if(msg.type==="base-state"){
      const rebirth=Math.max(0,Math.min(20,Math.floor(Number(msg.rebirth)||0)));
      const runners=Array.isArray(msg.runners)?msg.runners.slice(0,40).map(r=>({
        id:String(r.id||"").slice(0,48),v:r.v==="GOLD"||r.v==="DIAMOND"?r.v:null,
        s:Math.max(0,Math.min(99,Math.floor(Number(r.s)||0)))
      })).filter(r=>r.id):[];
      player.baseState={rebirth,runners};
      broadcast(room,{type:"base-state",player:publicPlayer(player)},player.id);
    }
  });
  ws.on("close",()=>leave(ws));ws.on("error",()=>leave(ws));
});
server.listen(PORT,()=>console.log(`Multiplayer server listening on ${PORT}`));
