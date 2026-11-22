const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
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
function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}
function roomPlayers(room) {
  return [...room.players.values()].map(p => ({
    id:p.id, name:p.name, gender:p.gender, x:p.x, y:p.y, z:p.z, yaw:p.yaw
  }));
}
function broadcast(room, data, exceptId) {
  for (const p of room.players.values()) if (p.id !== exceptId) send(p.ws, data);
}
function leave(ws) {
  const c = clients.get(ws);
  if (!c) return;
  clients.delete(ws);
  const room = rooms.get(c.roomId);
  if (!room) return;
  room.players.delete(c.id);
  broadcast(room, {type:"player-left", id:c.id, name:c.name, count:room.players.size});
  if (room.players.size === 0) rooms.delete(c.roomId);
}
function fail(ws, message) { send(ws, {type:"error", message}); }

const server = http.createServer((req,res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, {"content-type":"application/json"});
    res.end(JSON.stringify({ok:true, service:"Steal a Show Runner multiplayer", rooms:rooms.size, players:clients.size}));
  } else { res.writeHead(404); res.end("Not found"); }
});
const wss = new WebSocketServer({server, maxPayload:4096});
wss.on("connection", ws => {
  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return fail(ws,"Invalid message."); }
    if (msg.type === "join") {
      if (clients.has(ws)) return fail(ws,"Already joined a room.");
      const mode = msg.mode === "online" ? "online" : "solo";
      const code = String(msg.code || "").toUpperCase().trim();
      let room;
      if (code) {
        room = [...rooms.values()].find(r => r.code === code);
        if (!room) return fail(ws,"Invite code not found. Ask the host to open their room first.");
        if (room.mode !== mode) return fail(ws,"That invite code is for a different room type.");
      } else if (mode === "online") {
        room = [...rooms.values()].find(r => r.mode === "online" && r.public && r.players.size < MAX_PLAYERS);
        if (!room) {
          const id = crypto.randomUUID();
          room = {id, code:makeCode("online"), mode:"online", public:true, players:new Map()};
          rooms.set(id,room);
        }
      } else {
        const id = crypto.randomUUID();
        room = {id, code:makeCode("solo"), mode:"solo", public:false, players:new Map()};
        rooms.set(id,room);
      }
      if (room.players.size >= MAX_PLAYERS) return fail(ws,"This room is full (8/8).");
      const player = {
        id:crypto.randomUUID(), ws, name:String(msg.name || "Guest").replace(/[^A-Za-z0-9_ -]/g,"").slice(0,16) || "Guest",
        gender:msg.gender === "female" ? "female" : "male", x:0,y:0,z:0,yaw:0, roomId:room.id
      };
      room.players.set(player.id,player);
      clients.set(ws,player);
      ws.roomId = room.id;
      send(ws,{type:"joined",id:player.id,code:room.code,count:room.players.size,players:roomPlayers(room).filter(p=>p.id!==player.id)});
      broadcast(room,{type:"player-joined",player:{id:player.id,name:player.name,gender:player.gender,x:0,y:0,z:0,yaw:0},count:room.players.size},player.id);
      return;
    }
    const player = clients.get(ws);
    if (!player) return fail(ws,"Join a room first.");
    const room = rooms.get(player.roomId);
    if (!room) return fail(ws,"Room no longer exists.");
    if (msg.type === "move") {
      const n = v => Number.isFinite(Number(v)) ? Math.max(-1000,Math.min(1000,Number(v))) : 0;
      player.x=n(msg.x); player.y=n(msg.y); player.z=n(msg.z); player.yaw=n(msg.yaw);
      broadcast(room,{type:"state",players:[{id:player.id,name:player.name,gender:player.gender,x:player.x,y:player.y,z:player.z,yaw:player.yaw}]},player.id);
    }
  });
  ws.on("close",()=>leave(ws));
  ws.on("error",()=>leave(ws));
});
server.listen(PORT,()=>console.log(`Multiplayer server listening on ${PORT}`));