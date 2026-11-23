// 语音信令单元测试：用 mock RTCPeerConnection 验证 offer/answer/ICE 转发逻辑
// 运行：node test/voice.test.js
// 注意：真实通话需真人实测（无麦克风环境无法自动化测试音频）。
const assert = require('node:assert/strict');
const VoiceChat = require('../public/voice');

let passed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ok - ' + name); });
}

// ---- mock RTCPeerConnection ----
class MockPC {
  constructor(config) {
    this.config = config;
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
    this.tracks = [];
    this.candidates = [];
    this.closed = false;
    this.onicecandidate = null;
    this.ontrack = null;
    this.iceConnectionState = 'new';
    this.connectionState = 'new';
    this.oniceconnectionstatechange = null;
    this.onconnectionstatechange = null;
    this.offerOptions = [];
  }
  getSenders() { return this.tracks.map((tr) => ({ track: tr })); }
  addTrack(track) { this.tracks.push(track); }
  createOffer(options) { this.offerOptions.push(options || {}); return Promise.resolve({ type: 'offer', sdp: 'mock-offer' }); }
  createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'mock-answer' }); }
  setLocalDescription(d) {
    this.localDescription = d;
    if (d.type === 'offer') this.signalingState = 'have-local-offer';
    else if (d.type === 'answer') this.signalingState = 'stable';
    else if (d.type === 'rollback') this.signalingState = 'stable';
    return Promise.resolve();
  }
  setRemoteDescription(d) {
    this.remoteDescription = d;
    if (d.type === 'offer') this.signalingState = 'have-remote-offer';
    else if (d.type === 'answer') this.signalingState = 'stable';
    return Promise.resolve();
  }
  addIceCandidate(c) { this.candidates.push(c); return Promise.resolve(); }
  close() { this.closed = true; }
}

// mock 麦克风流
function mockStream() {
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  return {
    _track: track,
    getTracks() { return [track]; },
    getAudioTracks() { return [track]; },
  };
}

function makeVC(mySeat) {
  const sent = [];
  const pcs = [];
  const states = [];
  const vc = new VoiceChat({
    mySeat,
    send: (m) => sent.push(m),
    createPC: (config) => { const pc = new MockPC(config); pcs.push(pc); return pc; },
    getUserMedia: () => Promise.resolve(mockStream()),
    onTrack: () => {},
    onPeerClosed: () => {},
    onConnectionState: (seat, st) => states.push([seat, st]),
  });
  return { vc, sent, pcs, states };
}

(async () => {
  console.log('== 语音信令（mock RTCPeerConnection）==');

  await t('start() 请求麦克风并保存本地流', async () => {
    const { vc } = makeVC(0);
    const stream = await vc.start();
    assert.ok(stream);
    assert.equal(vc.started, true);
    assert.equal(vc.localStream, stream);
  });

  await t('createOffer 发送 rtc-offer 且带上 sdp', async () => {
    const { vc, sent, pcs } = makeVC(0);
    await vc.start();
    await vc.createOffer(1);
    assert.equal(pcs.length, 1);
    assert.equal(pcs[0].signalingState, 'have-local-offer');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].t, 'rtc-offer');
    assert.equal(sent[0].to, 1);
    assert.equal(sent[0].sdp.type, 'offer');
  });

  await t('handleOffer 设置远端描述并回 rtc-answer', async () => {
    const { vc, sent, pcs } = makeVC(1);
    await vc.start();
    await vc.handleOffer(0, { type: 'offer', sdp: 'remote-offer' });
    assert.equal(pcs.length, 1);
    assert.equal(pcs[0].remoteDescription.sdp, 'remote-offer');
    assert.equal(pcs[0].signalingState, 'stable');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].t, 'rtc-answer');
    assert.equal(sent[0].to, 0);
    assert.equal(sent[0].sdp.type, 'answer');
  });

  await t('handleAnswer 设置远端描述；过期的 answer 被忽略', async () => {
    const { vc, pcs } = makeVC(0);
    await vc.start();
    await vc.createOffer(1);
    await vc.handleAnswer(1, { type: 'answer', sdp: 'remote-answer' });
    assert.equal(pcs[0].remoteDescription.sdp, 'remote-answer');
    assert.equal(pcs[0].signalingState, 'stable');
    // 再来一个 answer（已 stable）应被忽略，不抛错
    await vc.handleAnswer(1, { type: 'answer', sdp: 'stale' });
    assert.equal(pcs[0].remoteDescription.sdp, 'remote-answer');
    // 没有对应 peer 的 answer 直接忽略
    await vc.handleAnswer(3, { type: 'answer', sdp: 'x' });
  });

  await t('handleIce 转给对应 PeerConnection；无 peer 时忽略', async () => {
    const { vc, pcs } = makeVC(0);
    await vc.start();
    await vc.createOffer(1);
    await vc.handleAnswer(1, { type: 'answer', sdp: 'remote-answer' });
    await vc.handleIce(1, { candidate: 'cand1' });
    assert.equal(pcs[0].candidates.length, 1);
    assert.equal(pcs[0].candidates[0].candidate, 'cand1');
    await vc.handleIce(2, { candidate: 'x' }); // 无 peer，不抛错
    await vc.handleIce(1, null); // 空 candidate（结束标记）忽略
    assert.equal(pcs[0].candidates.length, 1);
  });

  await t('ICE 候选通过 onicecandidate 发出', async () => {
    const { vc, sent, pcs } = makeVC(0);
    await vc.start();
    const pc = vc.ensurePeer(2);
    pc.onicecandidate({ candidate: { candidate: 'host-cand' } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].t, 'rtc-ice');
    assert.equal(sent[0].to, 2);
    assert.equal(sent[0].candidate.candidate, 'host-cand');
    pc.onicecandidate({ candidate: null }); // 收集结束发 null
    assert.equal(sent[1].candidate, null);
  });

  await t('setMuted 开关麦克风 track；stop 关闭连接并停麦克风', async () => {
    const { vc, pcs } = makeVC(0);
    const stream = await vc.start();
    await vc.createOffer(1);
    assert.equal(vc.setMuted(true), true);
    assert.equal(stream._track.enabled, false);
    assert.equal(vc.setMuted(false), false);
    assert.equal(stream._track.enabled, true);
    vc.stop();
    assert.equal(pcs[0].closed, true);
    assert.equal(stream._track.stopped, true);
    assert.equal(vc.started, false);
    assert.equal(vc.peers.size, 0);
  });

  await t('closePeer 关闭指定连接并触发 onPeerClosed', async () => {
    let closedSeat = -1;
    const { vc, pcs } = makeVC(0);
    vc.onPeerClosed = (s) => { closedSeat = s; };
    await vc.start();
    vc.ensurePeer(1);
    vc.ensurePeer(2);
    assert.equal(vc.peers.size, 2);
    vc.closePeer(1);
    assert.equal(pcs[0].closed, true);
    assert.equal(pcs[1].closed, false);
    assert.equal(closedSeat, 1);
    assert.equal(vc.peers.size, 1);
    vc.closePeer(1); // 重复关闭不抛错
  });

  await t('双向同时发起（glare）：小座位号优先，大座位号回滚接受', async () => {
    // 我是 2 号，向 1 号发了 offer（pending）；1 号的 offer 到了（1 < 2）→ 回滚并接受
    const { vc, sent, pcs } = makeVC(2);
    await vc.start();
    await vc.createOffer(1);
    assert.equal(pcs[0].signalingState, 'have-local-offer');
    await vc.handleOffer(1, { type: 'offer', sdp: 'from-1' });
    assert.equal(pcs[0].remoteDescription.sdp, 'from-1');
    assert.equal(sent[sent.length - 1].t, 'rtc-answer'); // 回了 answer
    assert.equal(sent[sent.length - 1].to, 1);
  });

  await t('双向同时发起（glare）：大座位号的 offer 被忽略', async () => {
    // 我是 0 号，向 1 号发了 offer（pending）；1 号的 offer 到了（1 > 0）→ 忽略
    const { vc, sent, pcs } = makeVC(0);
    await vc.start();
    await vc.createOffer(1);
    await vc.handleOffer(1, { type: 'offer', sdp: 'from-1' });
    assert.equal(pcs[0].remoteDescription, null); // 没接受
    assert.equal(sent.length, 1); // 只发过自己的 offer，没回 answer
  });

  await t('ICE 服务器配置含多个 STUN + TURN（含 TCP 与 TLS 变体）', () => {
    const ice = VoiceChat.DEFAULT_ICE;
    assert.ok(ice.filter((s) => String(s.urls).startsWith('stun:')).length >= 4);
    const turns = ice.filter((s) => String(s.urls).startsWith('turn'));
    assert.ok(turns.length >= 2);
    assert.ok(turns.some((s) => String(s.urls).includes('transport=tcp')));
    assert.ok(turns.some((s) => String(s.urls).startsWith('turns:')));
    assert.ok(turns.every((s) => s.username === 'openrelayproject'));
  });

  await t('远端描述未就绪时 ICE 候选暂存，收到 answer 后补加', async () => {
    const { vc, pcs } = makeVC(0);
    await vc.start();
    await vc.createOffer(1);
    // 此时 remoteDescription 还是 null（answer 没到），候选应暂存而非直接加上
    await vc.handleIce(1, { candidate: 'early-cand' });
    assert.equal(pcs[0].candidates.length, 0);
    await vc.handleAnswer(1, { type: 'answer', sdp: 'remote-answer' });
    assert.equal(pcs[0].candidates.length, 1);
    assert.equal(pcs[0].candidates[0].candidate, 'early-cand');
  });

  await t('ICE 连接失败时小座位号方发起一次 ICE 重启', async () => {
    const { vc, sent, pcs, states } = makeVC(0);
    await vc.start();
    await vc.createOffer(1);
    await vc.handleAnswer(1, { type: 'answer', sdp: 'remote-answer' });
    const before = sent.length;
    pcs[0].iceConnectionState = 'failed';
    pcs[0].oniceconnectionstatechange();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(states[states.length - 1], [1, 'failed']);
    assert.equal(sent.length, before + 1); // 多发了一个 offer
    assert.equal(sent[sent.length - 1].t, 'rtc-offer');
    assert.equal(pcs[0].offerOptions[pcs[0].offerOptions.length - 1].iceRestart, true);
    // 再失败一次不再重启
    pcs[0].oniceconnectionstatechange();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(sent.length, before + 1);
  });

  await t('ICE 连接失败时大座位号方不主动重启（等对方）', async () => {
    const { vc, sent, pcs } = makeVC(2);
    await vc.start();
    await vc.handleOffer(1, { type: 'offer', sdp: 'from-1' });
    const before = sent.length;
    pcs[0].iceConnectionState = 'failed';
    pcs[0].oniceconnectionstatechange();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(sent.length, before);
  });

  console.log(`\n全部通过：${passed} 个测试`);
  console.log('注：真实语音通话需真人实测（本环境无麦克风，无法自动化测试音频）。');
})().catch((e) => { console.error(e); process.exit(1); });
