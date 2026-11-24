const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Durable account database. On Render, mount a persistent disk at /var/data and set DATA_DIR=/var/data.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "sasr-accounts.json");
let accountDB = { users: {}, tokens: {} };
try { fs.mkdirSync(DATA_DIR, { recursive: true }); if (fs.existsSync(DATA_FILE)) accountDB = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { console.error("Could not load account database:", e.message); }
function saveAccountDB() { const tmp = DATA_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(accountDB)); fs.renameSync(tmp, DATA_FILE); }
function accountToken(ws) { const h = String(ws || "").replace(/^Bearer\s+/i, ""); return accountDB.tokens[crypto.createHash("sha256").update(h).digest("hex")]; }
function sendJSON(res, status, data) { res.writeHead(status, { "content-type":"application/json", "access-control-allow-origin":"*", "access-control-allow-headers":"content-type, authorization", "access-control-allow-methods":"GET, POST, OPTIONS" }); res.end(JSON.stringify(data)); }
function readBody(req) { return new Promise((resolve,reject)=>{ let b=""; req.on("data",c=>{ b+=c; if(b.length>1100000) reject(new Error("Request too large")); }); req.on("end",()=>{ try{resolve(JSON.parse(b||"{}"));}catch(e){reject(e);} }); req.on("error",reject); }); }
function issueToken(username) { const token=crypto.randomBytes(32).toString("hex"); accountDB.tokens[crypto.createHash("sha256").update(token).digest("hex")]=username; saveAccountDB(); return token; }

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
    anim:p.anim||"idle",animSpeed:p.animSpeed||0,rebirth:p.baseState.rebirth,runners:p.baseState.runners};
}
function roomPlayers(room) { return [...room.players.values()].map(publicPlayer); }
function roomWalkers(room) { return [...room.runners.values()]; }
function broadcast(room, data, exceptId) {
  for (const p of room.players.values()) if (p.id !== exceptId) send(p.ws, data);
}
function leave(ws) {
  const c = clients.get(ws); if (!c) return;
  clients.delete(ws);
  const room = rooms.get(c.roomId); if (!room) return;
  room.players.delete(c.id);
  for(const [id,r] of room.runners)if(r.ownerId===c.id){room.runners.delete(id);broadcast(room,{type:"runner-end",runnerId:id});}
  broadcast(room,{type:"player-left",id:c.id,name:c.name,baseId:c.baseId,count:room.players.size});
  if (room.players.size === 0) rooms.delete(c.roomId);
}
function fail(ws,message){send(ws,{type:"error",message});}
const server=http.createServer(async (req,res)=>{
  res.setHeader("access-control-allow-origin","*");
  res.setHeader("access-control-allow-headers","content-type, authorization");
  res.setHeader("access-control-allow-methods","GET, POST, OPTIONS");
  if(req.method==="OPTIONS"){res.writeHead(204);return res.end();}
  if(req.method==="POST" && req.url==="/api/register"){
    try { const b=await readBody(req), name=String(b.username||"").trim(), key=name.toLowerCase(), pw=String(b.password||"");
      if(!/^[A-Za-z0-9_]{3,16}$/.test(name)||pw.length<4)return sendJSON(res,400,{error:"Use a 3-16 character username and password of at least 4 characters."});
      if(accountDB.users[key])return sendJSON(res,409,{error:"That username is already taken."});
      const salt=crypto.randomBytes(16).toString("hex"), hash=crypto.scryptSync(pw,salt,64).toString("hex");
      const initial=(b.migrate===true && b.initialSave && typeof b.initialSave==="object" && !Array.isArray(b.initialSave))?b.initialSave:{}; accountDB.users[key]={name,salt,hash,save:initial,created:Date.now()}; const token=issueToken(key);
      return sendJSON(res,201,{token,username:name,save:initial});
    } catch(e){return sendJSON(res,400,{error:"Could not create account."});}
  }
  if(req.method==="POST" && req.url==="/api/login"){
    try { const b=await readBody(req), key=String(b.username||"").trim().toLowerCase(), pw=String(b.password||""), u=accountDB.users[key];
      if(!u)return sendJSON(res,404,{error:"Account not found."}); if(crypto.scryptSync(pw,u.salt,64).toString("hex")!==u.hash)return sendJSON(res,401,{error:"Incorrect username or password."});
      const token=issueToken(key); return sendJSON(res,200,{token,username:u.name,save:u.save||{}});
    } catch(e){return sendJSON(res,400,{error:"Could not sign in."});}
  }
  if(req.method==="POST" && req.url==="/api/save"){
    try { const key=accountToken(req.headers.authorization); if(!key||!accountDB.users[key])return sendJSON(res,401,{error:"Please sign in again."});
      const b=await readBody(req); if(!b.save||typeof b.save!=="object"||Array.isArray(b.save))return sendJSON(res,400,{error:"Invalid save data."});
      accountDB.users[key].save=b.save; accountDB.users[key].updated=Date.now(); saveAccountDB(); return sendJSON(res,200,{ok:true});
    } catch(e){return sendJSON(res,400,{error:"Could not save progress."});}
  }
  if(req.method==="POST" && req.url==="/api/logout"){
    try { const raw=String(req.headers.authorization||"").replace(/^Bearer\s+/i,""), h=crypto.createHash("sha256").update(raw).digest("hex"); delete accountDB.tokens[h]; saveAccountDB(); return sendJSON(res,200,{ok:true}); } catch(e){return sendJSON(res,200,{ok:true});}
  }
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
        if(!room){const id=crypto.randomUUID();room={id,code:makeCode("online"),mode:"online",public:true,players:new Map(),runners:new Map(),combatCooldowns:new Map()};rooms.set(id,room);}
      }else{
        const id=crypto.randomUUID();room={id,code:makeCode("solo"),mode:"solo",public:false,players:new Map(),runners:new Map(),combatCooldowns:new Map()};rooms.set(id,room);
      }
      if(room.players.size>=MAX_PLAYERS)return fail(ws,"This room is full (8/8).");
      const used=new Set([...room.players.values()].map(p=>p.baseId));
      let baseId=Array.from({length:BASE_COUNT},(_,i)=>i).find(i=>!used.has(i));
      if(baseId===undefined)return fail(ws,"All bases in this room are occupied.");
      const player={id:crypto.randomUUID(),ws,
        name:String(msg.name||"Guest").replace(/[^A-Za-z0-9_ -]/g,"").slice(0,16)||"Guest",
        gender:msg.gender==="female"?"female":"male",x:0,y:0,z:0,yaw:0,roomId:room.id,baseId,
        baseState:{rebirth:0,runners:[]},anim:"idle",animSpeed:0};
      room.players.set(player.id,player);clients.set(ws,player);
      send(ws,{type:"joined",id:player.id,code:room.code,baseId,count:room.players.size,players:roomPlayers(room).filter(p=>p.id!==player.id),walkers:roomWalkers(room).filter(r=>r.ownerId!==player.id)});
      broadcast(room,{type:"player-joined",player:publicPlayer(player),count:room.players.size},player.id);
      return;
    }
    const player=clients.get(ws);if(!player)return fail(ws,"Join a room first.");
    const room=rooms.get(player.roomId);if(!room)return fail(ws,"Room no longer exists.");
    if(msg.type==="move"){
      const n=v=>Number.isFinite(Number(v))?Math.max(-1000,Math.min(1000,Number(v))):0;
      player.x=n(msg.x);player.y=n(msg.y);player.z=n(msg.z);player.yaw=n(msg.yaw);
      player.anim=["walk","jump","fall","crouch","land"].includes(msg.anim)?msg.anim:"idle";player.animSpeed=Math.max(0,Math.min(1,Number(msg.animSpeed)||0));
      broadcast(room,{type:"state",players:[{id:player.id,name:player.name,gender:player.gender,x:player.x,y:player.y,z:player.z,yaw:player.yaw,baseId:player.baseId,anim:player.anim,animSpeed:player.animSpeed}]},player.id);
    }else if(msg.type==="combat"){
      const target=room.players.get(String(msg.targetId||""));
      if(!target||target.id===player.id)return fail(ws,"That player is no longer available.");
      const power=msg.power==="freeze"?"freeze":msg.power==="punch"?"punch":null;if(!power)return;
      const distance=Math.hypot(target.x-player.x,target.z-player.z);
      const range=power==="freeze"?18:5.5;if(distance>range||Math.abs(target.y-player.y)>4)return fail(ws,"That player is too far away.");
      const now=Date.now(),key=player.id+":"+power,previous=room.combatCooldowns.get(key)||0;if(now<previous)return;
      room.combatCooldowns.set(key,now+(power==="freeze"?2000:650));
      const level=Math.max(1,Math.min(power==="freeze"?3:10,Math.floor(Number(msg.level)||1)));
      const duration=power==="freeze"?[3,6,9][level-1]:0;
      broadcast(room,{type:"combat",power,targetId:target.id,attackerId:player.id,attackerName:player.name,x:player.x,y:player.y,z:player.z,level,duration},null);
    }else if(msg.type==="runner-walk"){
      const id=String(msg.runnerId||"");if(!id)return;
      const prev=room.runners.get(id);if(prev?prev.ownerId!==player.id:!id.startsWith(player.id+":"))return;
      const cfgId=String(msg.cfgId||"").slice(0,48);if(!cfgId)return;
      const runner={type:"runner-walk",runnerId:id,ownerId:player.id,ownerName:player.name,ownerBaseId:player.baseId,cfgId,
        variant:msg.variant==="GOLD"||msg.variant==="DIAMOND"?msg.variant:null,
        x:Number(msg.x)||0,y:Number(msg.y)||0,z:Number(msg.z)||0,yaw:Number(msg.yaw)||0};
      room.runners.set(id,runner);broadcast(room,runner,player.id);
    }else if(msg.type==="runner-snipe"){
      const id=String(msg.runnerId||""),runner=room.runners.get(id);
      if(!runner||runner.ownerId===player.id)return fail(ws,"That Show Runner is no longer available.");
      const previousOwnerId=runner.ownerId,previousOwnerName=runner.ownerName;
      runner.ownerId=player.id;runner.ownerName=player.name;runner.ownerBaseId=player.baseId;
      broadcast(room,{type:"runner-snipe",runnerId:id,ownerId:previousOwnerId,buyerId:player.id,buyerName:player.name,ownerName:previousOwnerName,cfgId:runner.cfgId,variant:runner.variant,x:runner.x,y:runner.y,z:runner.z});
    }else if(msg.type==="runner-end"){
      const id=String(msg.runnerId||""),runner=room.runners.get(id);
      if(runner&&runner.ownerId===player.id){room.runners.delete(id);broadcast(room,{type:"runner-end",runnerId:id});}
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
