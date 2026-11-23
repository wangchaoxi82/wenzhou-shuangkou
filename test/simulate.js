// 模拟测试：4 个机器人随机出合法牌，打满 N 局不断言崩溃
// 运行：node test/simulate.js [局数，默认 200]
const assert = require('node:assert/strict');
const SK = require('../public/shared');
const { Game } = require('../game');

const HANDS = parseInt(process.argv[2], 10) || 200;
const MAX_TURNS_PER_HAND = 2000;

function botMove(g, seat) {
  const plays = g.legalPlaysFor(seat);
  const leading = !g.currentPlay;
  if (!leading) {
    // 跟牌：30% 概率直接过，否则随机选一手可压牌；无牌可压则过
    if (plays.length === 0 || Math.random() < 0.3) return g.pass(seat);
    const pick = plays[Math.floor(Math.random() * plays.length)];
    return g.play(seat, pick.cards);
  }
  // 首攻：随机选一手（偏向小牌：80% 概率取按提示排序前 5 里的一手）
  if (plays.length === 0) throw new Error('首攻无合法出牌（不应发生）');
  const sorted = plays.slice().sort((a, b) => {
    const ca = a.combo, cb = b.combo;
    const bombA = SK.isBombType(ca.type) ? 1 : 0, bombB = SK.isBombType(cb.type) ? 1 : 0;
    if (bombA !== bombB) return bombA - bombB;
    return (ca.top || ca.rank) - (cb.top || cb.rank);
  });
  const pool = Math.random() < 0.8 ? sorted.slice(0, Math.min(5, sorted.length)) : sorted;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return g.play(seat, pick.cards);
}

const t0 = Date.now();
const stats = { shuang: 0, dan: 0, ping: 0, totalTurns: 0, maxTurns: 0, bombs: 0, lianzha: 0, tianwang: 0, sanwang: 0 };
const scores = [0, 0, 0, 0];

for (let h = 0; h < HANDS; h++) {
  const g = new Game();
  g.scores = scores.slice();
  g.startHand(g.nextLeader());
  let turns = 0;
  while (g.phase === 'playing') {
    if (++turns > MAX_TURNS_PER_HAND) throw new Error(`第 ${h + 1} 局超过 ${MAX_TURNS_PER_HAND} 轮未结束，疑似死循环`);
    const seat = g.turn;
    const before = g.currentPlay;
    const r = botMove(g, seat);
    assert.equal(r.ok, true, `第 ${h + 1} 局 seat ${seat} 出牌失败：${r.reason}`);
    if (g.currentPlay && g.currentPlay !== before) {
      const t = g.currentPlay.combo.type;
      if (t === 'bomb') stats.bombs++;
      if (t === 'lianzha') stats.lianzha++;
      if (t === 'tianwang') stats.tianwang++;
      if (t === 'sanwang') stats.sanwang++;
    }
  }
  // 断言：每局结束，分数和为 0，名次一致
  const res = g.handResult;
  assert.ok(res, `第 ${h + 1} 局无结算结果`);
  assert.equal(res.delta.reduce((a, b) => a + b, 0), 0, `第 ${h + 1} 局分数和不为 0`);
  const placeCount = Object.keys(res.places).length;
  if (res.type === 'shuang') {
    assert.equal(placeCount, 2, `第 ${h + 1} 局双扣应只定 1、2 名`);
    const winners = Object.keys(res.places).map(Number);
    assert.equal(winners[0] % 2, winners[1] % 2, `第 ${h + 1} 局双扣两名应为同队`);
  } else {
    assert.equal(placeCount, 4, `第 ${h + 1} 局${res.type}应定 4 个名次`);
  }
  stats[res.type]++;
  stats.totalTurns += turns;
  stats.maxTurns = Math.max(stats.maxTurns, turns);
  for (let s = 0; s < 4; s++) scores[s] = g.scores[s];
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`模拟完成：${HANDS} 局，${secs} 秒`);
console.log(`  双扣 ${stats.shuang} 局，单扣 ${stats.dan} 局，平扣 ${stats.ping} 局`);
console.log(`  平均每局 ${Math.round(stats.totalTurns / HANDS)} 轮，最长一局 ${stats.maxTurns} 轮`);
console.log(`  炸弹 ${stats.bombs} 次，连炸 ${stats.lianzha} 次，三王 ${stats.sanwang} 次，天王 ${stats.tianwang} 次`);
console.log(`  ${HANDS} 局后总分：[${scores.join(', ')}]（和=${scores.reduce((a, b) => a + b, 0)}）`);
console.log('模拟测试通过，无崩溃、无死循环、分数守恒');
