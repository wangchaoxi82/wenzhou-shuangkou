// 对已部署服务器的联机实测：4 个 WS 机器人建房、准备、打完一整局。
// 用法：node test/live-test.js https://<host>   （http 会自动换成 ws，https 换成 wss）
const WebSocket = require('ws');
const SK = require('../public/shared');

const base = process.argv[2];
if (!base) { console.error('用法：node test/live-test.js https://<host>'); process.exit(2); }
const wsUrl = base.replace(/^http/, 'ws').replace(/\/$/, '');
const NAMES = ['阿牛', '阿花', '阿土', '阿水'];
const TIMEOUT_MS = 5 * 60 * 1000;

const clients = [];
let roomCode = null;
let finished = false;
let playedCount = 0;

function log(...a) { console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a); }

function connect(i) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const c = { ws, seat: -1, actedKey: '', hand: [], done: false, lastState: null, retries: 0 };
    clients[i] = c;
    ws.on('open', () => {
      if (i === 0) ws.send(JSON.stringify({ t: 'create', name: NAMES[0] }));
      else ws.send(JSON.stringify({ t: 'join', name: NAMES[i], code: roomCode }));
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (msg.t === 'error') {
        log(`玩家${i} 收到错误：${msg.msg}`);
        // 出牌被拒时用最新状态重试一次（避免 actedKey 锁死导致 60 秒超时）
        if (c.lastState && c.retries < 3) {
          c.retries++;
          c.actedKey = '';
          setTimeout(() => act(c, c.lastState), 300);
        }
        return;
      }
      if (msg.t !== 'state') return;
      c.lastState = msg;
      c.retries = 0;
      if (c.seat === -1) c.seat = msg.mySeat;
      if (i === 0 && !roomCode && msg.code) {
        roomCode = msg.code;
        log('房间代码', roomCode);
        resolve();
      }
      if (msg.phase === 'lobby' && msg.seats && msg.seats[c.seat] && !msg.seats[c.seat].ready) {
        ws.send(JSON.stringify({ t: 'ready' }));
        return;
      }
      if (msg.phase === 'playing') {
        c.hand = msg.hand || [];
        if (msg.turn === c.seat) {
          const key = msg.handNo + '|' + msg.turn + '|' +
            (msg.currentPlay ? msg.currentPlay.cards.join(',') : 'lead') + '|' + c.hand.length;
          if (key === c.actedKey) return;
          c.actedKey = key;
          setTimeout(() => act(c, msg), 200 + Math.random() * 300);
        }
      }
      if (msg.phase === 'handOver' && msg.handResult && !finished) {
        finished = true;
        const r = msg.handResult;
        log(`第 ${msg.handNo} 局结束：${{ shuang: '双扣', dan: '单扣', ping: '平扣' }[r.type]}，名次`, r.places, '比分', r.scores, '共出牌', playedCount, '次');
        log('联机实测通过');
        cleanup(0);
      }
    });
    ws.on('error', (e) => { log(`玩家${i} WS 错误：`, e.message); reject(e); });
    ws.on('close', () => { if (!finished) { log(`玩家${i} 连接关闭`); } });
    if (i !== 0) setTimeout(resolve, 1500); // 加入方不等 state 也算连上
  });
}

function act(c, msg) {
  if (finished) return;
  // 服务器 state 只发 currentPlay.cards，不发完整 combo，需本地重算
  const current = msg.currentPlay ? SK.detect(msg.currentPlay.cards) : null;
  const plays = SK.legalPlays(c.hand, current);
  if (!current) {
    // 首攻：随机出
    const p = plays[Math.floor(Math.random() * plays.length)];
    playedCount++;
    c.ws.send(JSON.stringify({ t: 'play', cards: p.cards }));
  } else if (plays.length === 0 || Math.random() < 0.3) {
    c.ws.send(JSON.stringify({ t: 'pass' }));
  } else {
    const p = plays[Math.floor(Math.random() * plays.length)];
    playedCount++;
    c.ws.send(JSON.stringify({ t: 'play', cards: p.cards }));
  }
}

function cleanup(code) {
  clients.forEach((c) => { try { c.ws.close(); } catch (e) { /* ignore */ } });
  setTimeout(() => process.exit(code), 500);
}

(async () => {
  const timer = setTimeout(() => {
    log('超时：5 分钟内未打完一局');
    cleanup(1);
  }, TIMEOUT_MS);
  await connect(0);
  for (let i = 1; i < 4; i++) { await connect(i); await new Promise((r) => setTimeout(r, 500)); }
  log('4 人已连接，等待开局…');
})();
