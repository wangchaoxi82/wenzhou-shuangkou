// 服务器集成测试：启动真实服务器，4 个 ws 客户端建房/加入/准备/打完一整局，
// 并验证聊天、WebRTC 信令转发、断线重连与非法消息处理。
// 运行：node test/server.test.js
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const SK = require('../public/shared');
const { server } = require('../server');

const PORT = 18711;
const BASE = `ws://127.0.0.1:${PORT}`;
const TIMEOUT = 120000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 带消息日志与等待器的测试客户端
class Client {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.waiters = [];
    this.ws = null;
    this.seat = -1;
    this.code = null;
    this.actedKey = null;
    this.bot = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(BASE);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw); } catch (e) { return; }
        this.msgs.push(m);
        if (m.t === 'state') {
          this.seat = m.mySeat;
          this.code = m.code;
          this.lastState = m;
          if (this.bot) this.maybeAct(m);
        }
        const done = [];
        this.waiters.forEach((w, i) => {
          if (w.pred(m)) { done.push(i); w.resolve(m); }
        });
        done.reverse().forEach((i) => this.waiters.splice(i, 1));
      });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  waitFor(pred, ms = 10000) {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待超时：${this.name}`)), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }
  waitForState(pred, ms = 30000) {
    return this.waitFor((m) => m.t === 'state' && pred(m), ms);
  }
  close() { try { this.ws.close(); } catch (e) {} }

  // 机器人：轮到自己时随机出合法牌（跟牌 30% 概率过）
  maybeAct(s) {
    if (s.phase !== 'playing' || s.turn !== s.mySeat) return;
    const me = s.seats[s.mySeat];
    if (me.out) return;
    const key = s.handNo + ':' + s.turn + ':' + (s.currentPlay ? s.currentPlay.seat + '/' + s.currentPlay.cards.join(',') : 'lead') + ':' + s.hand.length;
    if (key === this.actedKey) return;
    this.actedKey = key;
    const cur = s.currentPlay ? SK.detect(s.currentPlay.cards) : null;
    const plays = SK.legalPlays(s.hand, cur);
    setTimeout(() => {
      if (!cur) {
        const pick = plays[Math.floor(Math.random() * plays.length)];
        this.send({ t: 'play', cards: pick.cards });
      } else if (plays.length === 0 || Math.random() < 0.3) {
        this.send({ t: 'pass' });
      } else {
        const pick = plays[Math.floor(Math.random() * plays.length)];
        this.send({ t: 'play', cards: pick.cards });
      }
    }, 5);
  }
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${path}`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  console.log('== 服务器集成测试（端口 ' + PORT + '）==');
  const clients = [];
  try {
    // 1. HTTP 检查
    const health = await get('/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).ok, true);
    const home = await get('/');
    assert.equal(home.status, 200);
    assert.ok(home.body.includes('温州双扣'));
    const shared = await get('/shared.js');
    assert.equal(shared.status, 200);
    const voiceJs = await get('/voice.js');
    assert.equal(voiceJs.status, 200);
    console.log('  ok - HTTP：/health、首页、shared.js、voice.js 均 200');

    // 2. 建房 + 加入
    const names = ['阿牛', '阿花', '阿土', '阿水'];
    for (let i = 0; i < 4; i++) {
      const c = new Client(names[i]);
      await c.connect();
      clients.push(c);
    }
    clients[0].send({ t: 'create', name: names[0] });
    const created = await clients[0].waitForState((s) => s.code);
    const code = created.code;
    assert.equal(code.length, 4);
    for (let i = 1; i < 4; i++) {
      clients[i].send({ t: 'join', code: code, name: names[i] });
      await clients[i].waitForState((s) => s.mySeat === i);
    }
    console.log('  ok - 建房 + 3 人加入，房间代码 ' + code);

    // 2b. 昵称校验：1 个字被拒，重名被拒
    const probe = new Client('探');
    clients.push(probe);
    await probe.connect();
    probe.send({ t: 'join', code: code, name: '牛' });
    const errShort = await probe.waitFor((x) => x.t === 'error');
    assert.ok(errShort.msg.includes('2–8'));
    probe.send({ t: 'join', code: code, name: '阿牛' });
    const errDup = await probe.waitFor((x) => x.t === 'error' && x.msg.includes('已有人用'));
    assert.ok(errDup.msg.includes('换一个'));
    console.log('  ok - 昵称校验：1 个字被拒，重名被拒并提示换一个');

    // 3. 聊天广播
    clients[0].send({ t: 'chat', text: '大家好' });
    for (let i = 0; i < 4; i++) {
      const m = await clients[i].waitFor((x) => x.t === 'chat' && x.text === '大家好');
      assert.equal(m.name, '阿牛');
      assert.equal(m.seat, 0);
    }
    console.log('  ok - 聊天广播到 4 人');

    // 4. WebRTC 信令转发（offer/answer/ICE），发给自己与非法座位被丢弃
    clients[0].send({ t: 'rtc-offer', to: 1, sdp: { type: 'offer', sdp: 'fake-offer' } });
    const offer = await clients[1].waitFor((x) => x.t === 'rtc-offer');
    assert.equal(offer.from, 0);
    assert.equal(offer.sdp.sdp, 'fake-offer');
    clients[1].send({ t: 'rtc-answer', to: 0, sdp: { type: 'answer', sdp: 'fake-answer' } });
    const answer = await clients[0].waitFor((x) => x.t === 'rtc-answer');
    assert.equal(answer.from, 1);
    clients[0].send({ t: 'rtc-ice', to: 1, candidate: { candidate: 'cand' } });
    const ice = await clients[1].waitFor((x) => x.t === 'rtc-ice');
    assert.equal(ice.candidate.candidate, 'cand');
    const before = clients[0].msgs.length;
    clients[0].send({ t: 'rtc-offer', to: 0, sdp: { type: 'offer', sdp: 'self' } }); // 发给自己
    clients[0].send({ t: 'rtc-offer', to: 9, sdp: { type: 'offer', sdp: 'bad' } }); // 非法座位
    await sleep(300);
    assert.equal(clients[0].msgs.length, before); // 无转发
    console.log('  ok - WebRTC 信令点对点转发，非法目标被丢弃');

    // 5. 语音状态广播
    clients[2].send({ t: 'voice', on: true });
    const vs = await clients[0].waitFor((x) => x.t === 'voice-state' && x.seat === 2);
    assert.equal(vs.on, true);
    clients[2].send({ t: 'voice', on: false });
    await clients[0].waitFor((x) => x.t === 'voice-state' && x.seat === 2 && x.on === false);
    console.log('  ok - 语音状态广播');

    // 6. 非法消息不崩服务器
    clients[0].ws.send('{不是 json');
    clients[0].send({ t: 'play', cards: 'not-an-array' });
    clients[0].send({ t: 'nonsense' });
    await sleep(300);
    const still = await get('/health');
    assert.equal(still.status, 200);
    console.log('  ok - 非法消息被拒绝，服务器正常');

    // 7. 准备 → 3 秒倒计时 → 开局，打完一整局
    clients.forEach((c) => { c.bot = true; });
    clients.forEach((c) => c.send({ t: 'ready' }));
    const started = await clients[0].waitForState((s) => s.phase === 'playing', 15000);
    assert.equal(started.hand.length, 27);
    console.log('  ok - 4 人准备后开局，每人 27 张');
    const over = await clients[0].waitForState((s) => s.phase === 'handOver' && s.handResult, TIMEOUT);
    const res = over.handResult;
    assert.ok(['shuang', 'dan', 'ping'].includes(res.type));
    assert.equal(res.delta.reduce((a, b) => a + b, 0), 0);
    console.log(`  ok - 一局打完：${{ shuang: '双扣', dan: '单扣', ping: '平扣' }[res.type]}，分数和为 0，比分 [${res.scores.join(', ')}]`);

    // 8. 再来一局
    clients.forEach((c) => c.send({ t: 'again' }));
    const hand2 = await clients[0].waitForState((s) => s.phase === 'playing' && s.handNo === 2, 15000);
    assert.equal(hand2.hand.length, 27);
    console.log('  ok - 4 人点“再来一局”，第 2 局开始');

    // 9. 断线重连：关闭一个客户端再以同名同房间代码重连，座位恢复
    const leaver = clients[3];
    leaver.bot = false;
    leaver.close();
    await sleep(500);
    const back = new Client(names[3]);
    clients.push(back);
    await back.connect();
    back.send({ t: 'join', code: code, name: names[3] });
    const rejoined = await back.waitForState((s) => s.mySeat === 3 && s.seats[3].connected);
    assert.equal(rejoined.phase, 'playing');
    console.log('  ok - 断线重连恢复座位');

    console.log('\n服务器集成测试全部通过');
  } finally {
    clients.forEach((c) => c.close());
    await sleep(300);
    server.close();
    process.exit(0); // 定时器（回合计时/留座）会拖住进程，测试结束直接退出
  }
})().catch((e) => { console.error('集成测试失败：', e); process.exit(1); });
