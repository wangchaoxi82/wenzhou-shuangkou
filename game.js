// 双扣单桌游戏状态机（Node 端，与 WebSocket 房间解耦，可直接单元测试）
// 座位 0..3，0 与 2 一队，1 与 3 一队。
const SK = require('./public/shared');

const SCORE = { shuang: 3, dan: 2, ping: 1 }; // 双扣/单扣/平扣

class Game {
  constructor() {
    this.scores = [0, 0, 0, 0];
    this.handNo = 0;
    this.lastHand = null; // {type, first}
    this.abortHand();
  }

  // 回到大厅状态（保留总分与上一局信息）
  abortHand() {
    this.phase = 'lobby'; // lobby | playing | handOver
    this.hands = [[], [], [], []];
    this.turn = -1;
    this.currentPlay = null; // {seat, cards, combo}
    this.passes = 0;
    this.outOrder = [];
    this.places = {}; // seat -> 1..4（双扣提前结束时只记 1、2 名）
    this.handResult = null;
  }

  isOut(seat) { return this.outOrder.indexOf(seat) !== -1; }
  activeSeats() { return [0, 1, 2, 3].filter((s) => !this.isOut(s)); }

  nextActive(from) {
    for (let i = 1; i <= 4; i++) {
      const s = (from + i) % 4;
      if (!this.isOut(s)) return s;
    }
    return -1;
  }

  nextLeader() {
    if (!this.lastHand) return Math.floor(Math.random() * 4);
    if (this.lastHand.type === 'shuang') return Math.floor(Math.random() * 4);
    return this.lastHand.first; // 单扣/平扣：上一局第一名领出
  }

  startHand(leaderSeat) {
    const deck = SK.shuffle(SK.createDeck());
    this.hands = [0, 1, 2, 3].map((i) => SK.sortHand(deck.slice(i * 27, i * 27 + 27)));
    this.phase = 'playing';
    this.handNo += 1;
    this.turn = leaderSeat;
    this.currentPlay = null;
    this.passes = 0;
    this.outOrder = [];
    this.places = {};
    this.handResult = null;
  }

  // 测试用：直接设定手牌与轮次（跳过发牌）
  _setTestHands(hands, turn) {
    this.hands = hands.map((h) => SK.sortHand(h.slice()));
    this.phase = 'playing';
    this.handNo += 1;
    this.turn = turn;
    this.currentPlay = null;
    this.passes = 0;
    this.outOrder = [];
    this.places = {};
    this.handResult = null;
  }

  legalPlaysFor(seat) {
    return SK.legalPlays(this.hands[seat], this.currentPlay ? this.currentPlay.combo : null);
  }

  play(seat, cardIds) {
    if (this.phase !== 'playing') return { ok: false, reason: '现在不能出牌' };
    if (seat !== this.turn) return { ok: false, reason: '还没轮到你' };
    if (!Array.isArray(cardIds) || cardIds.length === 0) return { ok: false, reason: '请选择要出的牌' };
    const set = new Set(cardIds);
    if (set.size !== cardIds.length) return { ok: false, reason: '牌有重复' };
    const hand = this.hands[seat];
    if (!cardIds.every((id) => hand.indexOf(id) !== -1)) return { ok: false, reason: '手里没有这些牌' };
    const combo = SK.detect(cardIds);
    if (!combo) return { ok: false, reason: '不是合法牌型' };
    if (this.currentPlay && !SK.beats(combo, this.currentPlay.combo)) {
      return { ok: false, reason: '压不过上家（' + this.currentPlay.combo.desc + '）' };
    }
    this.hands[seat] = hand.filter((id) => !set.has(id));
    this.currentPlay = { seat: seat, cards: cardIds.slice(), combo: combo };
    this.passes = 0;

    if (this.hands[seat].length === 0) {
      this.outOrder.push(seat);
      this.places[seat] = this.outOrder.length;
      // 双扣：前两名是同队（第 2 个出完时队友已出完）→ 立即结束，无需分第三、四名
      const partner = (seat + 2) % 4;
      if (this.outOrder.length === 2 && this.isOut(partner)) {
        this.endHand('shuang');
        return { ok: true };
      }
      // 3 人出完 → 结束，剩余一人为第 4 名（第一名队友第 3 为单扣，第 4 为平扣）
      if (this.outOrder.length === 3) {
        const last = this.activeSeats()[0];
        this.places[last] = 4;
        this.outOrder.push(last);
        this.endHand('rest');
        return { ok: true };
      }
    }
    this.turn = this.nextActive(seat);
    return { ok: true };
  }

  pass(seat) {
    if (this.phase !== 'playing') return { ok: false, reason: '现在不能过牌' };
    if (seat !== this.turn) return { ok: false, reason: '还没轮到你' };
    if (!this.currentPlay) return { ok: false, reason: '首攻不能过' };
    this.passes += 1;
    // 需要过的圈数 = 除出牌者外的在场人数（出牌者若已出完，则在场者全过才算一圈）
    const ownerActive = !this.isOut(this.currentPlay.seat);
    const needed = this.activeSeats().length - (ownerActive ? 1 : 0);
    if (this.passes >= needed) {
      const lastSeat = this.currentPlay.seat;
      this.currentPlay = null;
      this.passes = 0;
      if (!this.isOut(lastSeat)) {
        this.turn = lastSeat; // 出牌者还在场，继续领出
      } else {
        // 接风：出牌者已出完且无人压过，队友接风领出
        const partner = (lastSeat + 2) % 4;
        this.turn = !this.isOut(partner) ? partner : this.nextActive(lastSeat);
      }
    } else {
      this.turn = this.nextActive(seat);
    }
    return { ok: true };
  }

  // 超时自动处理：首攻出最小单张，跟牌则过
  timeoutAction(seat) {
    if (this.phase !== 'playing' || seat !== this.turn) return { ok: false, reason: '不是该玩家回合' };
    if (!this.currentPlay) {
      const card = SK.lowestSingle(this.hands[seat]);
      if (card === null) return { ok: false, reason: '无牌可出' };
      return this.play(seat, [card]);
    }
    return this.pass(seat);
  }

  endHand(kind) {
    const first = Number(Object.keys(this.places).find((s) => this.places[s] === 1));
    let type;
    if (kind === 'shuang') {
      type = 'shuang';
    } else {
      const partnerPlace = this.places[(first + 2) % 4];
      type = partnerPlace === 3 ? 'dan' : 'ping';
    }
    const pts = SCORE[type];
    const delta = [0, 0, 0, 0];
    for (let s = 0; s < 4; s++) {
      const win = (s % 2) === (first % 2);
      delta[s] = win ? pts : -pts;
      this.scores[s] += delta[s];
    }
    this.phase = 'handOver';
    this.handResult = {
      type: type,
      first: first,
      places: Object.assign({}, this.places),
      delta: delta,
      outOrder: this.outOrder.slice(),
      scores: this.scores.slice(),
    };
    this.lastHand = { type: type, first: first };
    this.currentPlay = null;
    this.turn = -1;
  }
}

module.exports = { Game: Game, SCORE: SCORE };
