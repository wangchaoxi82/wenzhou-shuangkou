// 单元测试：牌型逻辑（shared.js）+ 回合流程（game.js）
// 运行：node test/logic.test.js
const assert = require('node:assert/strict');
const SK = require('../public/shared');
const { Game } = require('../game');

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}

// ---- 造牌辅助 ----
// C(点数, 花色, 副)：普通牌 id；SJ/BJ：大小王
function C(rank, suit, deck) { return (deck || 0) * 54 + suit * 13 + (rank - 3); }
function SJ(deck) { return (deck || 0) * 54 + 52; }
function BJ(deck) { return (deck || 0) * 54 + 53; }
// rankSet(点数, 张数)：取 count 张该点数的牌（先用第 0 副 4 花色，再用第 1 副）
function rankSet(rank, count) {
  const out = [];
  for (let d = 0; d < 2 && out.length < count; d++)
    for (let s = 0; s < 4 && out.length < count; s++) out.push(C(rank, s, d));
  if (out.length !== count) throw new Error('rankSet 造牌不足 rank=' + rank + ' count=' + count);
  return out;
}
function bombOf(rank, count) { return rankSet(rank, count); }
function lianzha(ranks, groupSize) {
  let out = [];
  ranks.forEach((r) => { out = out.concat(rankSet(r, groupSize)); });
  return out;
}

console.log('== 牌型识别 ==');

t('单张/对子/三张基本判定', () => {
  assert.equal(SK.detect([C(3, 0)]).type, 'single');
  assert.equal(SK.detect([C(3, 0), C(3, 1)]).type, 'pair');
  assert.equal(SK.detect([C(3, 0), C(3, 1), C(3, 2)]).type, 'triple');
  assert.equal(SK.detect([C(3, 0), C(4, 0)]), null);
  assert.equal(SK.detect([C(3, 0), C(3, 1), C(4, 0)]), null);
});

t('万能牌补对子/三张', () => {
  const p = SK.detect([C(5, 0), BJ(0)]);
  assert.equal(p.type, 'pair'); assert.equal(p.rank, 5); assert.equal(p.pure, false);
  const p2 = SK.detect([BJ(0), BJ(1)]);
  assert.equal(p2.type, 'pair'); assert.equal(p2.rank, 17); // 对大王
  const tr = SK.detect([C(9, 0), C(9, 1), BJ(0)]);
  assert.equal(tr.type, 'triple'); assert.equal(tr.rank, 9);
  const tr2 = SK.detect([C(9, 0), BJ(0), BJ(1)]);
  assert.equal(tr2.type, 'triple'); assert.equal(tr2.rank, 9);
});

t('顺子判定与万能补位', () => {
  const s = SK.detect([C(3, 0), C(4, 0), C(5, 0), C(6, 0), C(7, 0)]);
  assert.equal(s.type, 'straight'); assert.equal(s.top, 7);
  const s2 = SK.detect([C(3, 0), C(4, 0), C(6, 0), C(7, 0), BJ(0)]); // 大王补 5
  assert.equal(s2.type, 'straight'); assert.equal(s2.top, 7); assert.equal(s2.pure, false);
  // 2 不能进顺子
  assert.equal(SK.detect([C(10, 0), C(11, 0), C(12, 0), C(13, 0), C(14, 0), C(15, 0)]), null);
  assert.equal(SK.detect([C(13, 0), C(14, 0), C(15, 0), C(3, 0), C(4, 0)]), null);
  // 小王不能进顺子
  assert.equal(SK.detect([C(10, 0), C(11, 0), C(12, 0), C(13, 0), SJ(0)]), null);
  // 4 张不成顺子
  assert.equal(SK.detect([C(3, 0), C(4, 0), C(5, 0), C(6, 0)]), null);
});

t('连对判定与万能补位', () => {
  const ld = SK.detect([C(3, 0), C(3, 1), C(4, 0), C(4, 1), C(5, 0), C(5, 1)]);
  assert.equal(ld.type, 'liandui'); assert.equal(ld.pairs, 3); assert.equal(ld.top, 5);
  const ld2 = SK.detect([C(3, 0), C(3, 1), C(4, 0), C(4, 1), C(5, 0), BJ(0)]); // 大王补一对 5
  assert.equal(ld2.type, 'liandui'); assert.equal(ld2.top, 5);
  // 2 组不成连对
  assert.equal(SK.detect([C(3, 0), C(3, 1), C(4, 0), C(4, 1)]), null);
  // 含 2 不成连对
  assert.equal(SK.detect([C(13, 0), C(13, 1), C(14, 0), C(14, 1), C(15, 0), C(15, 1)]), null);
});

t('连三张判定与万能补位', () => {
  const l = SK.detect(lianzha([5, 6, 7], 3));
  assert.equal(l.type, 'liansanzhang'); assert.equal(l.groups, 3); assert.equal(l.top, 7);
  const l2 = SK.detect(rankSet(5, 3).concat(rankSet(6, 3)).concat(rankSet(7, 2)).concat([BJ(0)]));
  assert.equal(l2.type, 'liansanzhang'); assert.equal(l2.top, 7); assert.equal(l2.pure, false);
  // 2 组不成连三张
  assert.equal(SK.detect(rankSet(5, 3).concat(rankSet(6, 3))), null);
  // 含 2 不成连三张
  assert.equal(SK.detect(rankSet(13, 3).concat(rankSet(14, 3)).concat(rankSet(15, 3))), null);
});

t('炸弹判定（2 可作炸弹点数，万能可补）', () => {
  const b = SK.detect(bombOf(3, 4));
  assert.equal(b.type, 'bomb'); assert.equal(b.rank, 3); assert.equal(b.lines, 4);
  assert.equal(SK.detect(bombOf(15, 4)).type, 'bomb'); // 2222
  assert.equal(SK.detect(bombOf(3, 7)).lines, 7); // 7 张炸 = 7 线
  assert.equal(SK.detect(bombOf(3, 8)).lines, 8); // 8 张炸 = 8 线
  const bw = SK.detect(rankSet(3, 3).concat([BJ(0)]));
  assert.equal(bw.type, 'bomb'); assert.equal(bw.rank, 3); assert.equal(bw.pure, false);
});

t('连炸有效情形', () => {
  const z1 = SK.detect(lianzha([3, 4, 5], 4));
  assert.equal(z1.type, 'lianzha'); assert.equal(z1.groups, 3); assert.equal(z1.groupSize, 4);
  assert.equal(z1.lines, 7); assert.equal(z1.top, 5);
  const z2 = SK.detect(lianzha([3, 4, 5], 5)); // 3 连 5 条
  assert.equal(z2.type, 'lianzha'); assert.equal(z2.lines, 8);
  const z3 = SK.detect(lianzha([3, 4, 5, 6], 4)); // 4 连 4 条
  assert.equal(z3.type, 'lianzha'); assert.equal(z3.lines, 8);
  const z4 = SK.detect(rankSet(3, 3).concat([BJ(0)]).concat(rankSet(4, 4)).concat(rankSet(5, 4))); // 万能补
  assert.equal(z4.type, 'lianzha'); assert.equal(z4.pure, false); assert.equal(z4.lines, 7);
});

t('连炸无效情形', () => {
  assert.equal(SK.detect(lianzha([3, 4], 4)), null); // 只有 2 组
  // 混搭张数 5+4+4
  assert.equal(SK.detect(rankSet(5, 5).concat(rankSet(4, 4)).concat(rankSet(3, 4))), null);
  // 含 2：AAAA+2222+3333
  assert.equal(SK.detect(rankSet(14, 4).concat(rankSet(15, 4)).concat(rankSet(3, 4))), null);
  // KKKK+AAAA+2222
  assert.equal(SK.detect(rankSet(13, 4).concat(rankSet(14, 4)).concat(rankSet(15, 4))), null);
  // 不连着：3333+5555+6666
  assert.equal(SK.detect(rankSet(3, 4).concat(rankSet(5, 4)).concat(rankSet(6, 4))), null);
});

t('三王炸弹判定（优先于三张）', () => {
  const s1 = SK.detect([BJ(0), BJ(1), SJ(0)]);
  assert.equal(s1.type, 'sanwang'); assert.equal(s1.lines, 6);
  const s2 = SK.detect([BJ(0), SJ(0), SJ(1)]);
  assert.equal(s2.type, 'sanwang'); assert.equal(s2.lines, 6);
  // 两张小王 + 一张大王不是“三张小王”
  assert.notEqual(s1.type, 'triple');
});

t('天王炸判定', () => {
  const tw = SK.detect([BJ(0), BJ(1), SJ(0), SJ(1)]);
  assert.equal(tw.type, 'tianwang'); assert.equal(tw.lines, 7);
  // 2 大王 + 2 小王不是炸弹
  assert.notEqual(tw.type, 'bomb');
});

console.log('== 牌型比较 ==');

t('同型比较：单/对/三/顺子/连对/连三张', () => {
  assert.equal(SK.beats(SK.detect([C(15, 0)]), SK.detect([C(14, 0)])), true); // 2 > A
  assert.equal(SK.beats(SK.detect([C(14, 0)]), SK.detect([C(15, 0)])), false);
  assert.equal(SK.beats(SK.detect([C(13, 0), C(13, 1)]), SK.detect([C(12, 0), C(12, 1)])), true);
  // 顺子长度不同不能压
  const s5 = SK.detect([C(3, 0), C(4, 0), C(5, 0), C(6, 0), C(7, 0)]);
  const s6 = SK.detect([C(3, 0), C(4, 0), C(5, 0), C(6, 0), C(7, 0), C(8, 0)]);
  assert.equal(SK.beats(s6, s5), false);
  assert.equal(SK.beats(s5, s6), false);
  const s5b = SK.detect([C(4, 0), C(5, 0), C(6, 0), C(7, 0), C(8, 0)]);
  assert.equal(SK.beats(s5b, s5), true); // 同长比顶
  // 连对组数不同不能压
  const ld3 = SK.detect(lianzha([3, 4, 5], 2));
  const ld4 = SK.detect(lianzha([3, 4, 5, 6], 2));
  assert.equal(SK.beats(ld4, ld3), false);
  // 连三张组数不同不能压，同组比顶
  const lsz3 = SK.detect(lianzha([5, 6, 7], 3));
  const lsz4 = SK.detect(lianzha([5, 6, 7, 8], 3));
  const lsz3b = SK.detect(lianzha([6, 7, 8], 3));
  assert.equal(SK.beats(lsz4, lsz3), false);
  assert.equal(SK.beats(lsz3b, lsz3), true);
  assert.equal(SK.beats(lsz3, lsz3b), false);
});

t('炸弹压非炸弹，非炸弹压不了炸弹', () => {
  const b = SK.detect(bombOf(3, 4));
  const s = SK.detect([C(10, 0), C(11, 0), C(12, 0), C(13, 0), C(14, 0)]);
  assert.equal(SK.beats(b, s), true);
  assert.equal(SK.beats(s, b), false);
  const lsz = SK.detect(lianzha([5, 6, 7], 3));
  assert.equal(SK.beats(b, lsz), true);
  assert.equal(SK.beats(lsz, b), false);
});

t('线系统：3连4条 vs 7张炸 → 连炸赢（同7线，张数多）', () => {
  const lz = SK.detect(lianzha([3, 4, 5], 4)); // 7 线 12 张
  const b7 = SK.detect(bombOf(3, 7)); // 7 线 7 张
  assert.equal(SK.beats(lz, b7), true);
  assert.equal(SK.beats(b7, lz), false);
});

t('线系统：7张炸 vs 天王炸 → 7张炸赢（同7线，张数多；天王无特殊优待）', () => {
  const tw = SK.detect([BJ(0), BJ(1), SJ(0), SJ(1)]);
  const b7 = SK.detect(bombOf(3, 7));
  assert.equal(SK.beats(b7, tw), true);
  assert.equal(SK.beats(tw, b7), false);
  // 3 连 4 条（12 张）也大于天王（4 张）
  const lz = SK.detect(lianzha([3, 4, 5], 4));
  assert.equal(SK.beats(lz, tw), true);
  assert.equal(SK.beats(tw, lz), false);
});

t('线系统：三王 vs 6张炸 → 6张炸赢（同6线，张数多；三王是6线里最小）', () => {
  const sw = SK.detect([BJ(0), BJ(1), SJ(0)]);
  const b6 = SK.detect(bombOf(3, 6));
  assert.equal(SK.beats(b6, sw), true);
  assert.equal(SK.beats(sw, b6), false);
  // 三王大于 5 张炸（6 线 > 5 线）
  const b5 = SK.detect(bombOf(3, 5));
  assert.equal(SK.beats(sw, b5), true);
});

t('线系统：8张炸 vs 天王 → 8张炸赢（8线 > 7线）', () => {
  const tw = SK.detect([BJ(0), BJ(1), SJ(0), SJ(1)]);
  const b8 = SK.detect(bombOf(3, 8));
  assert.equal(SK.beats(b8, tw), true);
  assert.equal(SK.beats(tw, b8), false);
});

t('线系统：连炸 vs 单炸按线比', () => {
  const lz = SK.detect(lianzha([3, 4, 5], 4)); // 7 线
  const b6 = SK.detect(bombOf(3, 6)); // 6 线
  const b8 = SK.detect(bombOf(3, 8)); // 8 线
  assert.equal(SK.beats(lz, b6), true); // 7 > 6
  assert.equal(SK.beats(lz, b8), false); // 7 < 8
  assert.equal(SK.beats(b8, lz), true);
});

t('线系统：同线同张数比最大点数', () => {
  // 4 连 5 条到 K vs 5 连 4 条到 A：同 9 线 20 张，顶 A 大
  const a = SK.detect(lianzha([10, 11, 12, 13], 5));
  const b = SK.detect(lianzha([10, 11, 12, 13, 14], 4));
  assert.equal(a.lines, 9); assert.equal(b.lines, 9);
  assert.equal(SK.beats(b, a), true);
  assert.equal(SK.beats(a, b), false);
  // 4 连 4 条 vs 3 连 5 条：同 8 线，16 张 > 15 张
  const c = SK.detect(lianzha([3, 4, 5, 6], 4));
  const d = SK.detect(lianzha([3, 4, 5], 5));
  assert.equal(SK.beats(c, d), true);
  assert.equal(SK.beats(d, c), false);
});

t('线系统：同线同张数同点数，纯牌胜含万能牌', () => {
  const pure = SK.detect(bombOf(3, 7));
  const wild = SK.detect(rankSet(3, 6).concat([BJ(0)]));
  assert.equal(SK.beats(pure, wild), true);
  assert.equal(SK.beats(wild, pure), false);
  // 完全相同的两手不能互压
  const pure2 = SK.detect(bombOf(3, 7));
  assert.equal(SK.beats(pure, pure2), false);
});

console.log('== 合法出牌枚举与提示 ==');

t('legalPlays 枚举含炸弹/连炸/三王/天王', () => {
  // 手牌：3333 4444 5555 + 2 大王 + 2 小王 + 单张 6
  const hand = rankSet(3, 4).concat(rankSet(4, 4)).concat(rankSet(5, 4))
    .concat([BJ(0), BJ(1), SJ(0), SJ(1), C(6, 0)]);
  const plays = SK.legalPlays(hand, null);
  const types = new Set(plays.map((p) => p.combo.type));
  assert.ok(types.has('lianzha'), '应含连炸');
  assert.ok(types.has('bomb'), '应含炸弹');
  assert.ok(types.has('sanwang'), '应含三王');
  assert.ok(types.has('tianwang'), '应含天王');
  // 跟单张 5 时只能出大于 5 的单张或炸弹类
  const cur = SK.detect([C(5, 0)]);
  const follow = SK.legalPlays(hand, cur);
  assert.ok(follow.length > 0);
  assert.ok(follow.every((p) => SK.beats(p.combo, cur)));
  assert.ok(follow.some((p) => p.combo.type === 'single' && p.combo.rank === 6));
});

t('hintPlay 给出最小可压牌', () => {
  const hand = rankSet(3, 2).concat(rankSet(6, 1)).concat(rankSet(9, 1)).concat(rankSet(13, 4));
  const hint = SK.hintPlay(hand, SK.detect([C(5, 0)]));
  assert.ok(hint);
  assert.equal(hint.combo.type, 'single');
  assert.equal(hint.combo.rank, 6); // 最小大于 5 的单张
  // 无牌可压时返回 null
  const hand2 = rankSet(3, 2).concat(rankSet(4, 1));
  assert.equal(SK.hintPlay(hand2, SK.detect([C(15, 0)])), null);
  // 首攻提示最小单张
  const hint3 = SK.hintPlay(hand, null);
  assert.equal(hint3.combo.type, 'single');
  assert.equal(hint3.combo.rank, 3);
});

console.log('== 回合流程（game.js）==');

t('发牌：每人 27 张，共 108 张不重复', () => {
  const g = new Game();
  g.startHand(0);
  assert.equal(g.phase, 'playing');
  const all = [].concat(...g.hands);
  assert.equal(all.length, 108);
  assert.equal(new Set(all).size, 108);
  assert.ok(g.hands.every((h) => h.length === 27));
});

t('接风：出完者无人压过，队友领出', () => {
  const g = new Game();
  g._setTestHands([[C(3, 0)], [C(4, 0)], [C(5, 0)], [C(6, 0)]], 0);
  assert.equal(g.play(0, [C(3, 0)]).ok, true); // 0 出完
  assert.equal(g.pass(1).ok, true); // 1 手里 4 能压但选择过
  assert.equal(g.pass(2).ok, true);
  assert.equal(g.pass(3).ok, true);
  assert.equal(g.turn, 2); // 0 的队友 2 接风
});

t('正常轮转：出牌者未出完，一圈过后继续领出', () => {
  const g = new Game();
  g._setTestHands([[C(3, 0), C(7, 0)], [C(4, 0)], [C(5, 0)], [C(6, 0)]], 0);
  assert.equal(g.play(0, [C(3, 0)]).ok, true);
  assert.equal(g.pass(1).ok, true);
  assert.equal(g.pass(2).ok, true);
  assert.equal(g.pass(3).ok, true);
  assert.equal(g.turn, 0);
});

t('单扣计分：第一名队友第三，+2/−2', () => {
  const g = new Game();
  g._setTestHands([[C(3, 0)], [C(4, 0)], [C(5, 0)], [C(6, 0)]], 0);
  g.play(0, [C(3, 0)]); // 0 第一
  g.play(1, [C(4, 0)]); // 1 第二（压过 3）
  g.play(2, [C(5, 0)]); // 2 第三 → 3 人出完结束
  assert.equal(g.phase, 'handOver');
  assert.equal(g.handResult.type, 'dan');
  assert.deepEqual(g.handResult.delta, [2, -2, 2, -2]);
  assert.deepEqual(g.scores, [2, -2, 2, -2]);
  assert.deepEqual(g.handResult.places, { 0: 1, 1: 2, 2: 3, 3: 4 });
});

t('平扣计分：第一名队友第四，+1/−1', () => {
  const g = new Game();
  g._setTestHands([[C(3, 0)], [C(4, 0)], [C(5, 0)], [C(6, 0)]], 0);
  g.play(0, [C(3, 0)]); // 0 第一
  g.play(1, [C(4, 0)]); // 1 第二
  g.pass(2); // 2 过（手里 5 能压但选择过）
  g.play(3, [C(6, 0)]); // 3 第三 → 结束，2 第四
  assert.equal(g.handResult.type, 'ping');
  assert.deepEqual(g.handResult.delta, [1, -1, 1, -1]);
});

t('双扣立即结束：同队两人出完，不等第三、四名，+3/−3', () => {
  const g = new Game();
  g._setTestHands([[C(3, 0)], [C(4, 0)], [C(5, 0)], [C(6, 0)]], 0);
  g.play(0, [C(3, 0)]); // 0 第一
  g.pass(1);
  g.play(2, [C(5, 0)]); // 2 第二，且是 0 的队友 → 立即双扣
  assert.equal(g.phase, 'handOver');
  assert.equal(g.handResult.type, 'shuang');
  assert.deepEqual(g.handResult.delta, [3, -3, 3, -3]);
  assert.deepEqual(g.handResult.places, { 0: 1, 2: 2 }); // 3、4 名未定
  assert.equal(g.handResult.places[1], undefined);
});

t('下一局领出：单扣/平扣由上一局第一名领出，双扣随机', () => {
  const g = new Game();
  g._setTestHands([[C(3, 0)], [C(4, 0)], [C(5, 0)], [C(6, 0)]], 0);
  g.play(0, [C(3, 0)]); g.play(1, [C(4, 0)]); g.play(2, [C(5, 0)]);
  assert.equal(g.nextLeader(), 0); // 单扣，第一名 0 领出
  const g2 = new Game();
  g2._setTestHands([[C(3, 0)], [C(4, 0)], [C(5, 0)], [C(6, 0)]], 0);
  g2.play(0, [C(3, 0)]); g2.pass(1); g2.play(2, [C(5, 0)]);
  const leader = g2.nextLeader();
  assert.ok(leader >= 0 && leader <= 3); // 双扣随机
});

t('超时自动：首攻出最小单张，跟牌自动过', () => {
  const g = new Game();
  g._setTestHands([[C(3, 0), C(9, 0)], [C(4, 0)], [C(5, 0)], [C(6, 0)]], 0);
  g.timeoutAction(0);
  assert.equal(g.hands[0].length, 1); // 出了 3
  assert.equal(g.hands[0][0], C(9, 0));
  assert.equal(g.currentPlay.combo.rank, 3);
  g.timeoutAction(1); // 跟牌自动过
  assert.equal(g.turn, 2);
});

t('非法出牌被拒绝并给出原因', () => {
  const g = new Game();
  g._setTestHands([[C(3, 0), C(4, 0)], [C(5, 0)], [C(6, 0)], [C(7, 0)]], 0);
  assert.equal(g.play(1, [C(5, 0)]).ok, false); // 没轮到
  assert.equal(g.play(0, [C(3, 0), C(4, 0)]).ok, false); // 不是合法牌型
  assert.equal(g.play(0, [C(9, 0)]).ok, false); // 手里没有
  assert.equal(g.pass(0).ok, false); // 首攻不能过
  assert.equal(g.play(0, [C(3, 0)]).ok, true);
  assert.equal(g.play(1, [C(5, 0)]).ok, true); // 5 压 3
  assert.equal(g.play(2, [C(6, 0)]).ok, true);
  assert.equal(g.play(3, [C(7, 0)]).ok, true);
});

console.log(`\n全部通过：${passed} 个测试`);
