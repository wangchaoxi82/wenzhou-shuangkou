// 温州百变双扣 — 共享牌型逻辑（Node 与浏览器共用，UMD）
// 牌用 id 表示：0..107，两副牌。每副 54 张：
//   id%54: 0..51 为普通牌：花色 = floor(id/13) (0♠ 1♥ 2♣ 3♦)，点数 = id%13 + 3 (3..15，15=2)
//   52 = 小王 SJ，53 = 大王 BJ
// 点数 rank：3..13=3..K，14=A，15=2，16=小王，17=大王（百变：大王是万能牌）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShuangKou = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SUITS = ['♠', '♥', '♣', '♦'];
  var RANK_NAMES = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' };
  var TYPE_NAMES = {
    single: '单张', pair: '对子', triple: '三张', straight: '顺子',
    liandui: '连对', liansanzhang: '连三张', bomb: '炸弹', lianzha: '连炸',
    sanwang: '三王炸弹', tianwang: '天王炸',
  };

  function rankName(r) { return RANK_NAMES[r] || String(r); }

  // id -> {id, rank, suit}，suit: 0..3 普通牌，-1 王
  function cardOf(id) {
    var n = id % 54;
    if (n === 52) return { id: id, rank: 16, suit: -1 };
    if (n === 53) return { id: id, rank: 17, suit: -1 };
    return { id: id, rank: (n % 13) + 3, suit: Math.floor(n / 13) };
  }

  function isRed(card) { return card.suit === 1 || card.suit === 3 || card.rank === 17; }

  function cardLabel(id) {
    var c = cardOf(id);
    if (c.rank === 16) return '小王';
    if (c.rank === 17) return '大王';
    return rankName(c.rank) + SUITS[c.suit];
  }

  function createDeck() {
    var d = [];
    for (var i = 0; i < 108; i++) d.push(i);
    return d;
  }

  function shuffle(deck) {
    for (var i = deck.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  }

  // 按点数从大到小排序（同点按花色）
  function sortHand(ids) {
    return ids.slice().sort(function (a, b) {
      var ca = cardOf(a), cb = cardOf(b);
      if (cb.rank !== ca.rank) return cb.rank - ca.rank;
      return cb.suit - ca.suit;
    });
  }

  function groupByRank(ids) {
    var g = {}; // rank -> [ids]
    var wilds = [];
    ids.forEach(function (id) {
      var c = cardOf(id);
      if (c.rank === 17) wilds.push(id);
      else { (g[c.rank] = g[c.rank] || []).push(id); }
    });
    return { groups: g, wilds: wilds };
  }

  // ---------- 牌型识别 ----------
  // 返回 combo 或 null：
  // {type, rank, top, size, pairs, groups, groupSize, lines, pure, wilds, cards, desc}
  // rank：单/对/三/炸弹的主点数；top：顺子/连对/连三张/连炸的最高点数
  // lines：炸弹类牌型的“线”数（X张炸=X线；连炸=组数+组大小；三王=6；天王=7），非炸弹为 0
  function detect(ids) {
    if (!ids || ids.length === 0) return null;
    var cards = ids.map(cardOf);
    var n = cards.length;
    var wilds = 0, nonWild = [];
    cards.forEach(function (c) { if (c.rank === 17) wilds++; else nonWild.push(c); });
    var counts = {};
    nonWild.forEach(function (c) { counts[c.rank] = (counts[c.rank] || 0) + 1; });
    var ranks = Object.keys(counts).map(Number);

    function mk(type, extra) {
      var lines = 0;
      if (type === 'bomb') lines = n;
      else if (type === 'lianzha') lines = extra.groups + extra.groupSize;
      else if (type === 'sanwang') lines = 6;
      else if (type === 'tianwang') lines = 7;
      var combo = {
        type: type, rank: extra.rank || 0, top: extra.top || extra.rank || 0,
        size: n, pairs: extra.pairs || 0, groups: extra.groups || 0,
        groupSize: extra.groupSize || 0, lines: lines,
        pure: wilds === 0, wilds: wilds, cards: ids.slice(),
      };
      combo.desc = describe(combo);
      return combo;
    }

    // 天王炸：恰好 4 张，2 大王 + 2 小王（必须是原牌，不能用万能牌凑）
    if (n === 4 && wilds === 2 && counts[16] === 2) {
      return mk('tianwang', { rank: 17 });
    }

    if (n === 1) return mk('single', { rank: cards[0].rank });

    if (n === 2) {
      if (wilds === 2) return mk('pair', { rank: 17 }); // 两张大王 = 对大王
      if (wilds === 1) return mk('pair', { rank: nonWild[0].rank });
      if (ranks.length === 1) return mk('pair', { rank: ranks[0] });
      return null;
    }

    if (n === 3) {
      // 三王炸弹：任意 3 张司令（2大1小或1大2小），优先于三张
      if (wilds + (counts[16] || 0) === 3) return mk('sanwang', { rank: 17 });
      // 三张同点；或 2 同点 + 1 万能；或 1 张 + 2 万能（均为 ranks.length===1）
      if (ranks.length === 1) return mk('triple', { rank: ranks[0] });
      return null;
    }

    // n >= 4：炸弹 / 连炸 / 连三张 / 顺子 / 连对（互斥，顺序无妨）
    // 炸弹：非万能牌全同点（点数可为 3..2、小王）
    if (ranks.length === 1) {
      return mk('bomb', { rank: ranks[0] });
    }
    // 全是万能牌且 n>=4 不可能（只有 2 张大王），无需处理

    // 连炸：k 组 × 每组 g 张，k>=3，g>=4，同组等大，点数 3..A 连续
    var lz = detectLianzha(counts, ranks, wilds, n);
    if (lz) return mk('lianzha', lz);

    // 连三张：k 组 × 每组 3 张，k>=3，点数 3..A 连续
    if (n >= 9 && n % 3 === 0) {
      var lsz = detectLiansanzhang(counts, ranks, wilds, n / 3);
      if (lsz) return mk('liansanzhang', lsz);
    }

    // 顺子：n>=5，每点至多 1 张，点数 3..A
    if (n >= 5 && n <= 12) {
      var st = detectStraight(counts, ranks, wilds, n);
      if (st) return mk('straight', st);
    }

    // 连对：n 偶数，k=n/2>=3 对，每点至多 2 张，点数 3..A
    if (n >= 6 && n % 2 === 0) {
      var ld = detectLiandui(counts, ranks, wilds, n / 2);
      if (ld) return mk('liandui', ld);
    }

    return null;
  }

  // 连炸：返回最优解 {groups, groupSize, top}，按 组大小>组数>最高点 选最优
  function detectLianzha(counts, ranks, wilds, n) {
    var best = null;
    for (var g = 4; g <= 8; g++) {
      if (n % g !== 0) continue;
      var k = n / g;
      if (k < 3 || k > 12) continue;
      for (var s = 3; s + k - 1 <= 14; s++) {
        var ok = true, natural = 0;
        for (var r = 0; r < ranks.length; r++) {
          var rank = ranks[r];
          if (rank < s || rank > s + k - 1 || counts[rank] > g) { ok = false; break; }
          natural += counts[rank];
        }
        if (!ok) continue;
        if (natural + wilds !== n) continue;
        var cand = { groups: k, groupSize: g, top: s + k - 1, rank: s + k - 1 };
        if (!best || cand.groupSize > best.groupSize ||
          (cand.groupSize === best.groupSize && cand.groups > best.groups) ||
          (cand.groupSize === best.groupSize && cand.groups === best.groups && cand.top > best.top)) {
          best = cand;
        }
      }
    }
    return best;
  }

  // 连三张：返回最高点最大的解 {groups, top, rank}
  function detectLiansanzhang(counts, ranks, wilds, k) {
    if (k < 3 || k > 12) return null;
    var best = null;
    for (var s = 3; s + k - 1 <= 14; s++) {
      var ok = true;
      for (var i = 0; i < ranks.length; i++) {
        var rank = ranks[i];
        if (rank < s || rank > s + k - 1 || counts[rank] > 3) { ok = false; break; }
      }
      if (!ok) continue;
      var top = s + k - 1;
      if (!best || top > best.top) best = { groups: k, top: top, rank: top };
    }
    return best;
  }

  // 顺子：返回最高点最大的解 {top, rank}
  function detectStraight(counts, ranks, wilds, n) {
    var best = null;
    for (var s = 3; s + n - 1 <= 14; s++) {
      var ok = true;
      for (var i = 0; i < ranks.length; i++) {
        var rank = ranks[i];
        if (rank < s || rank > s + n - 1 || counts[rank] > 1) { ok = false; break; }
      }
      if (!ok) continue;
      var top = s + n - 1;
      if (!best || top > best.top) best = { top: top, rank: top };
    }
    return best;
  }

  // 连对：返回最高点最大的解 {pairs, top, rank}
  function detectLiandui(counts, ranks, wilds, k) {
    var best = null;
    for (var s = 3; s + k - 1 <= 14; s++) {
      var ok = true;
      for (var i = 0; i < ranks.length; i++) {
        var rank = ranks[i];
        if (rank < s || rank > s + k - 1 || counts[rank] > 2) { ok = false; break; }
      }
      if (!ok) continue;
      var top = s + k - 1;
      if (!best || top > best.top) best = { pairs: k, top: top, rank: top };
    }
    return best;
  }

  function describe(combo) {
    switch (combo.type) {
      case 'single': return '单张' + rankName(combo.rank);
      case 'pair': return '对' + rankName(combo.rank);
      case 'triple': return '三个' + rankName(combo.rank);
      case 'straight': return '顺子到' + rankName(combo.top);
      case 'liandui': return combo.pairs + '连对到' + rankName(combo.top);
      case 'liansanzhang': return combo.groups + '连三张到' + rankName(combo.top);
      case 'bomb': return combo.size + '张炸·' + rankName(combo.rank) + '（' + combo.lines + '线）';
      case 'lianzha': return combo.groups + '组' + combo.groupSize + '连炸到' + rankName(combo.top) + '（' + combo.lines + '线）';
      case 'sanwang': return '三王炸弹（6线）';
      case 'tianwang': return '天王炸（7线）';
      default: return '未知';
    }
  }

  function isBombType(type) { return type === 'bomb' || type === 'lianzha' || type === 'sanwang' || type === 'tianwang'; }

  // 炸弹类比较（线系统，rio 当地规则）：
  // 1. 线高者大；2. 同线：张数多的赢；3. 同线同张数：比最大点数；4. 再相同：纯牌胜于含万能牌。
  // 天王炸（7 线 4 张）没有任何特殊优待：7 线内 3 连 4 条（12 张）> 7 张炸（7 张）> 天王（4 张）。
  // 三王（6 线 3 张）是 6 线里最小的，与“张数多者赢”一致，无需特殊处理。
  function bombBeats(a, b) {
    if (a.lines !== b.lines) return a.lines > b.lines;
    if (a.size !== b.size) return a.size > b.size;
    var ar = a.type === 'lianzha' ? a.top : a.rank;
    var br = b.type === 'lianzha' ? b.top : b.rank;
    if (ar !== br) return ar > br;
    return a.pure && !b.pure;
  }

  // a 能否压过 b（b 为 null 表示首攻，任何合法牌型都可出）
  function beats(a, b) {
    if (!a) return false;
    if (!b) return true;
    var aBomb = isBombType(a.type), bBomb = isBombType(b.type);
    if (aBomb && !bBomb) return true;
    if (bBomb && !aBomb) return false;
    if (aBomb && bBomb) return bombBeats(a, b);
    if (a.type !== b.type) return false;
    switch (a.type) {
      case 'single': case 'pair': case 'triple':
        return a.rank > b.rank;
      case 'straight':
        return a.size === b.size && a.top > b.top;
      case 'liandui':
        return a.pairs === b.pairs && a.top > b.top;
      case 'liansanzhang':
        return a.groups === b.groups && a.top > b.top;
      default:
        return false;
    }
  }

  // ---------- 合法出牌枚举（机器人/提示用） ----------
  // 返回 [{cards, combo}]，每种（牌型，形状，点数）取万能牌用量最少的一种出法
  function legalPlays(handIds, current) {
    var gb = groupByRank(handIds);
    var groups = gb.groups, wilds = gb.wilds;
    var out = [];
    var seen = {}; // 去重：同一组牌只保留一次

    function push(cards) {
      var combo = detect(cards);
      if (!combo) return;
      var key = sortHand(cards).join(',');
      if (seen[key]) return;
      seen[key] = true;
      if (beats(combo, current)) out.push({ cards: cards.slice(), combo: combo });
    }

    // 取某点数的 k 张原牌（不足返回 null）
    function take(rank, k) {
      var g = groups[rank] || [];
      return g.length >= k ? g.slice(0, k) : null;
    }

    // 单张：每个点数 1 张 + 大王单张
    Object.keys(groups).forEach(function (r) { push([groups[r][0]]); });
    if (wilds.length) push([wilds[0]]);

    // 对子：2 原牌；1 原牌 + 1 万能；2 万能
    Object.keys(groups).forEach(function (r) {
      var t = take(+r, 2); if (t) push(t);
      if (groups[r].length === 1 && wilds.length >= 1) push([groups[r][0], wilds[0]]);
    });
    if (wilds.length >= 2) push(wilds.slice(0, 2));

    // 三张：3 原牌；2+1 万能；1+2 万能
    Object.keys(groups).forEach(function (r) {
      var t3 = take(+r, 3); if (t3) push(t3);
      if (groups[r].length === 2 && wilds.length >= 1) push(groups[r].slice(0, 2).concat(wilds[0]));
      if (groups[r].length === 1 && wilds.length >= 2) push([groups[r][0]].concat(wilds.slice(0, 2)));
    });

    // 顺子：长度 5..12，起点 3..(14-len+1)
    for (var len = 5; len <= 12; len++) {
      for (var s = 3; s + len - 1 <= 14; s++) {
        var cards = [], need = 0, ok = true;
        for (var r = s; r < s + len; r++) {
          if ((groups[r] || []).length >= 1) cards.push(groups[r][0]);
          else need++;
        }
        if (need > wilds.length) continue;
        push(cards.concat(wilds.slice(0, need)));
      }
    }

    // 连对：k=3..12 对
    for (var k = 3; k <= 12; k++) {
      for (var s2 = 3; s2 + k - 1 <= 14; s2++) {
        var cards2 = [], need2 = 0;
        for (var r2 = s2; r2 < s2 + k; r2++) {
          var have = (groups[r2] || []).length;
          if (have >= 2) cards2.push(groups[r2][0], groups[r2][1]);
          else if (have === 1) { cards2.push(groups[r2][0]); need2 += 1; }
          else need2 += 2;
        }
        if (need2 > wilds.length) continue;
        push(cards2.concat(wilds.slice(0, need2)));
      }
    }

    // 炸弹：点数 3..2、小王，4..8 张（原牌多于所需时只取一部分）
    for (var br = 3; br <= 16; br++) {
      var haveB = (groups[br] || []).length;
      for (var sz = 4; sz <= 8; sz++) {
        var useNat = Math.min(haveB, sz);
        var needB = sz - useNat;
        if (needB < 0 || needB > wilds.length) continue;
        push((groups[br] || []).slice(0, useNat).concat(wilds.slice(0, needB)));
      }
    }

    // 连炸：组大小 g=4..8，组数 k>=3（某点原牌多于 g 时只取 g 张）
    for (var g = 4; g <= 8; g++) {
      for (var kk = 3; kk <= 12; kk++) {
        if (kk * g > handIds.length) break;
        for (var s3 = 3; s3 + kk - 1 <= 14; s3++) {
          var cards3 = [], need3 = 0;
          for (var r3 = s3; r3 < s3 + kk; r3++) {
            var have3 = (groups[r3] || []).length;
            var use3 = Math.min(have3, g);
            cards3 = cards3.concat((groups[r3] || []).slice(0, use3));
            need3 += g - use3;
          }
          if (need3 > wilds.length) continue;
          push(cards3.concat(wilds.slice(0, need3)));
        }
      }
    }

    // 连三张：k=3..12 组（某点原牌多于 3 张时只取 3 张）
    for (var k3 = 3; k3 <= 12; k3++) {
      if (k3 * 3 > handIds.length) break;
      for (var s4 = 3; s4 + k3 - 1 <= 14; s4++) {
        var cards4 = [], need4 = 0;
        for (var r4 = s4; r4 < s4 + k3; r4++) {
          var have4 = (groups[r4] || []).length;
          var use4 = Math.min(have4, 3);
          cards4 = cards4.concat((groups[r4] || []).slice(0, use4));
          need4 += 3 - use4;
        }
        if (need4 > wilds.length) continue;
        push(cards4.concat(wilds.slice(0, need4)));
      }
    }

    // 天王炸：2 大王 + 2 小王
    if (wilds.length >= 2 && (groups[16] || []).length >= 2) {
      push(wilds.slice(0, 2).concat(groups[16].slice(0, 2)));
    }

    return out;
  }

  // 提示：能压过 current 的最小出牌（首攻时为最小可出牌）；没有则返回 null（建议 pass）
  function hintPlay(handIds, current) {
    var plays = legalPlays(handIds, current);
    if (plays.length === 0) return null;
    function cost(p) {
      var c = p.combo;
      // 炸弹类：线越低越先出；天王最珍贵，额外加价
      if (c.type === 'tianwang') return 60000 + 7000 + 5000 + c.size * 10 + c.wilds * 50;
      if (isBombType(c.type)) return 60000 + c.lines * 1000 + c.size * 10 + c.wilds * 50;
      var base = 0;
      if (c.type === 'liansanzhang') base = 40000;
      else if (c.type === 'liandui') base = 30000;
      else if (c.type === 'straight') base = 20000;
      else if (c.type === 'triple') base = 10000;
      else if (c.type === 'pair') base = 5000;
      else base = 0;
      return base + (c.top || c.rank) * 10 + c.wilds * 50 + c.size;
    }
    plays.sort(function (a, b) { return cost(a) - cost(b); });
    return plays[0];
  }

  // 最小的单张（超时自动出牌用）：点数最小的一张牌
  function lowestSingle(handIds) {
    if (!handIds.length) return null;
    var sorted = handIds.slice().sort(function (a, b) {
      var ca = cardOf(a), cb = cardOf(b);
      return ca.rank - cb.rank;
    });
    return sorted[0];
  }

  return {
    SUITS: SUITS, RANK_NAMES: RANK_NAMES, TYPE_NAMES: TYPE_NAMES,
    rankName: rankName, cardOf: cardOf, isRed: isRed, cardLabel: cardLabel,
    createDeck: createDeck, shuffle: shuffle, sortHand: sortHand,
    detect: detect, beats: beats, bombBeats: bombBeats, describe: describe, isBombType: isBombType,
    legalPlays: legalPlays, hintPlay: hintPlay, lowestSingle: lowestSingle,
    groupByRank: groupByRank,
  };
});
