// 温州双扣联机服务器：静态文件 + WebSocket，内存房间，无数据库
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const TURN_SECONDS = 60; // 回合限时
const DISCONNECTED_TURN_SECONDS = 5; // 断线玩家回合限时（快速自动处理）
const SEAT_HOLD_MS = 15 * 60 * 1000; // 断线留座 15 分钟（手机切后台/接电话常见）
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 无歧义字符

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// ---------------- 静态文件 + 健康检查 ----------------
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    res.writeHead(500); res.end('Server error');
  }
});

const wss = new WebSocket.Server({ server });

// ---------------- 房间 ----------------
const rooms = new Map(); // code -> room

function genCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: genCode(),
    players: [null, null, null, null], // {name, ws, connected, ready, voiceOn}
    game: new Game(),
    again: new Set(), // 已点“再来一局”的座位
    // 注意：聊天不保存——消息只实时广播，不存历史；昵称只存在内存房间状态里，房间解散即消失；日志不写昵称
    startingTimeout: null,
    startingAt: 0, // 倒计时开始时间戳（0 表示未倒计时）
    turnTimeout: null,
    turnDeadline: 0,
    removeTimers: new Map(), // seat -> timeout（断线留座计时）
    createdAt: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function seatCount(room) { return room.players.filter(Boolean).length; }
function allSeated(room) { return room.players.every(Boolean); }
function allConnected(room) { return room.players.every((p) => p && p.connected); }
function allReady(room) { return room.players.every((p) => p && p.ready); }

function log(room, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${room.code}] ${msg}`);
}

// ---------------- 状态广播 ----------------
function stateFor(room, seat) {
  const g = room.game;
  const seats = room.players.map((p, i) => ({
    name: p ? p.name : null,
    ready: p ? p.ready : false,
    connected: p ? p.connected : false,
    voice: p ? !!p.voiceOn : false,
    mic: p ? !!p.micOn : false,
    score: g.scores[i],
    cards: g.phase === 'playing' ? g.hands[i].length : 0,
    out: g.isOut(i),
    place: g.places[i] || 0,
  }));
  return {
    t: 'state',
    code: room.code,
    phase: g.phase,
    handNo: g.handNo,
    mySeat: seat,
    seats: seats,
    hand: seat >= 0 && g.phase === 'playing' ? g.hands[seat].slice() : [],
    turn: g.turn,
    turnDeadline: room.turnDeadline,
    turnSeconds: TURN_SECONDS,
    currentPlay: g.currentPlay ? {
      seat: g.currentPlay.seat,
      cards: g.currentPlay.cards,
      desc: g.currentPlay.combo.desc,
      type: g.currentPlay.combo.type,
    } : null,
    passes: g.passes,
    outOrder: g.outOrder.slice(),
    handResult: g.handResult,
    again: Array.from(room.again),
    startingIn: room.startingAt ? Math.max(0, room.startingAt + 3000 - Date.now()) : 0,
  };
}

function broadcast(room) {
  room.players.forEach((p, i) => {
    if (p && p.connected && p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(stateFor(room, i)));
    }
  });
}

function sendError(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'error', msg: msg }));
}

// 向房间内所有在线玩家广播一条消息（聊天/语音状态等）
function broadcastMsg(room, obj) {
  const s = JSON.stringify(obj);
  room.players.forEach((p) => {
    if (p && p.connected && p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(s);
  });
}

// 某座位语音关闭时通知其他人关闭对应的 PeerConnection
function broadcastVoiceOff(room, seat) {
  broadcastMsg(room, { t: 'voice-state', seat: seat, on: false });
}

// ---------------- 回合计时 ----------------
function clearTurnTimer(room) {
  if (room.turnTimeout) { clearTimeout(room.turnTimeout); room.turnTimeout = null; }
  room.turnDeadline = 0;
}

function armTurnTimer(room) {
  clearTurnTimer(room);
  const g = room.game;
  if (g.phase !== 'playing' || g.turn < 0) return;
  const p = room.players[g.turn];
  const seconds = p && !p.connected ? DISCONNECTED_TURN_SECONDS : TURN_SECONDS;
  room.turnDeadline = Date.now() + seconds * 1000;
  room.turnTimeout = setTimeout(() => {
    const seat = g.turn;
    log(room, `座位 ${seat} 超时，自动处理`);
    const r = g.timeoutAction(seat);
    if (!r.ok) log(room, `自动处理失败：${r.reason}`);
    afterGameAction(room);
  }, seconds * 1000);
}

// 每次出牌/过牌/超时后：重设计时、检查是否需要广播
function afterGameAction(room) {
  const g = room.game;
  if (g.phase === 'playing') armTurnTimer(room);
  else clearTurnTimer(room);
  if (g.phase === 'handOver' && g.handResult) {
    log(room, `第 ${g.handNo} 局结束：${{ shuang: '双扣', dan: '单扣', ping: '平扣' }[g.handResult.type]}，比分 [${g.scores.join(', ')}]`);
  }
  broadcast(room);
}

// ---------------- 开局倒计时 ----------------
function maybeStartCountdown(room) {
  const g = room.game;
  if (g.phase !== 'lobby') return;
  if (allSeated(room) && allConnected(room) && allReady(room) && !room.startingTimeout) {
    room.startingAt = Date.now();
    log(room, '4 人齐且都已准备，3 秒后开局');
    broadcast(room);
    room.startingTimeout = setTimeout(() => {
      room.startingTimeout = null;
      room.startingAt = 0;
      if (g.phase === 'lobby' && allSeated(room) && allConnected(room) && allReady(room)) {
        startHand(room);
      } else {
        broadcast(room);
      }
    }, 3000);
  }
}

function cancelCountdown(room) {
  if (room.startingTimeout) {
    clearTimeout(room.startingTimeout);
    room.startingTimeout = null;
    room.startingAt = 0;
  }
}

function startHand(room) {
  const g = room.game;
  room.again.clear();
  g.startHand(g.nextLeader());
  log(room, `第 ${g.handNo} 局开始，座位 ${g.turn} 领出`);
  armTurnTimer(room);
  broadcast(room);
}

// ---------------- 玩家离开/断线 ----------------
function removePlayer(room, seat, reason) {
  const p = room.players[seat];
  if (!p) return;
  log(room, `座位 ${seat} 离开：${reason}`);
  if (p.voiceOn) broadcastVoiceOff(room, seat);
  room.players[seat] = null;
  room.again.delete(seat);
  const t = room.removeTimers.get(seat);
  if (t) { clearTimeout(t); room.removeTimers.delete(seat); }
  cancelCountdown(room);
  const g = room.game;
  if (g.phase !== 'lobby') {
    // 进行中离席：本局作废回大厅，总分保留
    clearTurnTimer(room);
    g.abortHand();
    room.players.forEach((pp) => { if (pp) pp.ready = false; });
    log(room, '有人离席，本局作废，回大厅');
  }
  if (seatCount(room) === 0) {
    rooms.delete(room.code);
    log(room, '房间已空，删除');
    return;
  }
  broadcast(room);
}

function onDisconnect(room, seat) {
  const p = room.players[seat];
  if (!p) return;
  p.connected = false;
  p.ws = null;
  if (p.voiceOn) { p.voiceOn = false; broadcastVoiceOff(room, seat); }
  log(room, `座位 ${seat} 断线，留座 15 分钟`);
  cancelCountdown(room);
  // 若正轮到他，缩短回合计时
  if (room.game.phase === 'playing' && room.game.turn === seat) armTurnTimer(room);
  const timer = setTimeout(() => {
    room.removeTimers.delete(seat);
    removePlayer(room, seat, '断线超时');
  }, SEAT_HOLD_MS);
  room.removeTimers.set(seat, timer);
  broadcast(room);
}

// ---------------- 消息处理 ----------------
function validName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  const len = [...n].length;
  if (len < 2 || len > 8) return null;
  return n;
}

function handleMessage(ws, msg) {
  let data;
  try { data = JSON.parse(msg); } catch (e) { sendError(ws, '消息格式错误'); return; }
  if (!data || typeof data.t !== 'string') { sendError(ws, '消息格式错误'); return; }

  try {
    switch (data.t) {
      case 'create': {
        const name = validName(data.name);
        if (!name) { sendError(ws, '昵称 2–8 个字'); return; }
        const room = createRoom();
        room.players[0] = { name: name, ws: ws, connected: true, ready: false, voiceOn: false, micOn: true };
        ws._room = room; ws._seat = 0;
        log(room, `座位 0 创建房间`);
        ws.send(JSON.stringify(stateFor(room, 0)));
        break;
      }
      case 'join': {
        const name = validName(data.name);
        const code = typeof data.code === 'string' ? data.code.trim().toUpperCase() : '';
        if (!name) { sendError(ws, '昵称 2–8 个字'); return; }
        const room = rooms.get(code);
        if (!room) { sendError(ws, '房间不存在（代码错误或已解散）'); return; }
        // 断线重连：同名座位
        const oldSeat = room.players.findIndex((p) => p && p.name === name && !p.connected);
        if (oldSeat !== -1) {
          const p = room.players[oldSeat];
          p.ws = ws; p.connected = true;
          const timer = room.removeTimers.get(oldSeat);
          if (timer) { clearTimeout(timer); room.removeTimers.delete(oldSeat); }
          ws._room = room; ws._seat = oldSeat;
          log(room, `座位 ${oldSeat} 断线重连`);
          if (room.game.phase === 'playing' && room.game.turn === oldSeat) armTurnTimer(room);
          maybeStartCountdown(room);
          broadcast(room);
          return;
        }
        if (room.players.some((p) => p && p.name === name)) { sendError(ws, '这个昵称已有人用，换一个'); return; }
        const seat = room.players.findIndex((p) => !p);
        if (seat === -1) { sendError(ws, '房间已满'); return; }
        if (room.game.phase !== 'lobby') { sendError(ws, '游戏进行中，不能加入'); return; }
        room.players[seat] = { name: name, ws: ws, connected: true, ready: false, voiceOn: false, micOn: true };
        ws._room = room; ws._seat = seat;
        log(room, `座位 ${seat} 加入`);
        broadcast(room);
        break;
      }
      case 'chat': {
        const room = ws._room;
        if (!room || ws._seat === undefined) return;
        const p = room.players[ws._seat];
        if (!p) return;
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        if (!text || text.length > 200) return;
        const entry = { seat: ws._seat, name: p.name, text: text, time: Date.now() };
        // 只实时广播，不保存
        broadcastMsg(room, Object.assign({ t: 'chat' }, entry));
        break;
      }
      case 'voice': {
        const room = ws._room;
        if (!room || ws._seat === undefined) return;
        const p = room.players[ws._seat];
        if (!p) return;
        p.voiceOn = data.on === true;
        if (typeof data.mic === 'boolean') p.micOn = data.mic;
        broadcastMsg(room, { t: 'voice-state', seat: ws._seat, on: p.voiceOn, mic: p.micOn });
        broadcast(room);
        break;
      }
      case 'rtc-offer':
      case 'rtc-answer':
      case 'rtc-ice': {
        // WebRTC 信令：只在同房间内点对点转发
        const room = ws._room;
        if (!room || ws._seat === undefined) return;
        const to = data.to;
        if (typeof to !== 'number' || to < 0 || to > 3 || to === ws._seat) return;
        const target = room.players[to];
        if (!target || !target.connected || !target.ws || target.ws.readyState !== WebSocket.OPEN) return;
        const fwd = { t: data.t, from: ws._seat };
        if (data.t === 'rtc-ice') fwd.candidate = data.candidate || null;
        else fwd.sdp = data.sdp;
        if (data.t !== 'rtc-ice' && (!fwd.sdp || typeof fwd.sdp !== 'object')) return;
        target.ws.send(JSON.stringify(fwd));
        break;
      }
      case 'seat': {
        const room = ws._room;
        if (!room || ws._seat === undefined) return;
        const target = data.seat;
        if (room.game.phase !== 'lobby') { sendError(ws, '游戏中不能换座'); return; }
        if (typeof target !== 'number' || target < 0 || target > 3) return;
        if (room.players[target]) { sendError(ws, '这个座位有人了'); return; }
        room.players[target] = room.players[ws._seat];
        room.players[ws._seat] = null;
        ws._seat = target;
        cancelCountdown(room);
        broadcast(room);
        break;
      }
      case 'ready': {
        const room = ws._room;
        if (!room || ws._seat === undefined) return;
        const p = room.players[ws._seat];
        if (!p || room.game.phase !== 'lobby') return;
        p.ready = !p.ready;
        if (!p.ready) cancelCountdown(room);
        else maybeStartCountdown(room);
        broadcast(room);
        break;
      }
      case 'play': {
        const room = ws._room;
        if (!room || ws._seat === undefined) return;
        const cards = Array.isArray(data.cards) ? data.cards.filter((c) => Number.isInteger(c)) : [];
        const r = room.game.play(ws._seat, cards);
        if (!r.ok) { sendError(ws, r.reason); return; }
        afterGameAction(room);
        break;
      }
      case 'pass': {
        const room = ws._room;
        if (!room || ws._seat === undefined) return;
        const r = room.game.pass(ws._seat);
        if (!r.ok) { sendError(ws, r.reason); return; }
        afterGameAction(room);
        break;
      }
      case 'again': {
        const room = ws._room;
        if (!room || ws._seat === undefined) return;
        const g = room.game;
        if (g.phase !== 'handOver') return;
        room.again.add(ws._seat);
        if (room.again.size === 4 && allSeated(room) && allConnected(room)) {
          startHand(room);
        } else {
          broadcast(room);
        }
        break;
      }
      case 'leave': {
        const room = ws._room;
        if (!room || ws._seat === undefined) return;
        const seat = ws._seat;
        ws._room = null; ws._seat = undefined;
        removePlayer(room, seat, '主动离开');
        try { ws.close(); } catch (e) { /* ignore */ }
        break;
      }
      case 'ping': {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'pong' }));
        break;
      }
      default:
        sendError(ws, '未知消息');
    }
  } catch (e) {
    console.error('处理消息异常：', e);
    sendError(ws, '服务器处理出错');
  }
}

wss.on('connection', (ws) => {
  ws._room = null;
  ws._seat = undefined;
  ws.on('message', (msg) => handleMessage(ws, msg));
  ws.on('close', () => {
    const room = ws._room;
    if (room && ws._seat !== undefined && room.players[ws._seat] && room.players[ws._seat].ws === ws) {
      onDisconnect(room, ws._seat);
    }
  });
  ws.on('error', () => { /* close 事件会处理 */ });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`温州双扣服务器运行在 http://0.0.0.0:${PORT}`);
  });
}

module.exports = { server: server, wss: wss, rooms: rooms };
