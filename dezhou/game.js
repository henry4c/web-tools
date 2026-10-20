/* =====================================================================
 * 牌局状态机 —— 无限注德州扑克
 * ---------------------------------------------------------------------
 * 座位按数组索引“顺时针”排列（0 → 1 → … → n-1 → 0），
 * 行动顺序也是索引递增；庄家按钮每手向后移动一位。
 *   单挑：庄家 = 小盲，翻牌前先行动，翻牌后后行动
 *   3 人以上：庄家下家小盲、再下家大盲，大盲下家翻牌前先行动
 * 客户端可通过 view() 拿到“能公开的信息 + 自己的底牌”。
 * ===================================================================== */
(function () {
  var H = (typeof require === 'function' && typeof module === 'object' && module.exports)
    ? require('./engine.js')
    : (typeof window !== 'undefined' ? window.Holdem : null);

  var STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown'];
  var STREET_CN = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌' };

  function idxOf(list, p) { for (var i = 0; i < list.length; i++) if (list[i] === p) return i; return -1; }

  class Game {
    /**
     * opts: { sb, bb, startChips, seats:[{id,name,isHuman,chips,style}], dealer }
     */
    constructor(opts) {
      opts = opts || {};
      this.sb = opts.sb || 10;
      this.bb = opts.bb || this.sb * 2;
      var start = opts.startChips || 2000;
      this.seats = (opts.seats || []).map(function (s, i) {
        return {
          id: s.id != null ? s.id : i,
          name: s.name,
          isHuman: !!s.isHuman,
          style: s.style != null ? s.style : 1,
          chips: s.chips != null ? s.chips : start,
          hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, acted: false,
          lastAction: null, lastAmount: 0, handName: '', handScore: null,
          net: 0, won: 0, out: false, startingChips: s.chips != null ? s.chips : start,
        };
      });
      this.players = this.seats;
      if (this.players.length < 2) throw new Error('至少需要 2 名玩家');
      this.startChips = start;
      this.dealer = opts.dealer != null ? ((opts.dealer % this.players.length) + this.players.length) % this.players.length : 0;
      this.handNo = 0;
      this.state = 'idle';
      this.history = [];
      this.newHand(null);
    }

    /* ---------------- 基础查询 ---------------- */
    n() { return this.players.length; }
    actives() { return this.players.filter(function (p) { return !p.folded; }); }
    acting() { return this.state === 'betting' ? this.players[this.toAct] : null; }
    actor() { return this.acting(); }
    indexOf(p) { return this.players.indexOf(p); }

    log(text, extra) {
      var e = Object.assign({ seq: this.history.length, text: text, street: this.street }, extra || {});
      this.history.push(e);
      if (this.history.length > 400) this.history.splice(0, this.history.length - 400);
      return e;
    }

    /* 从 start 开始（含）的座位索引序列 */
    orderFrom(start) {
      var out = [];
      for (var k = 0; k < this.n(); k++) out.push((start + k) % this.n());
      return out;
    }

    /* 从座位 after 之后找下一个“有筹码、且不在此前的 out 列表里”的座位 */
    nextSeat(after, out, allowEmpty) {
      out = out || [];
      for (var k = 1; k <= this.n(); k++) {
        var s = (after + k) % this.n();
        if (out.indexOf(s) >= 0) continue;
        if (allowEmpty || this.players[s].chips > 0) return s;
      }
      for (var k2 = 1; k2 <= this.n(); k2++) {
        var s2 = (after + k2) % this.n();
        if (out.indexOf(s2) < 0) return s2;
      }
      return after;
    }

    /* 下一手开始时需要参与的座位（有筹码的） */
    activeSeats() {
      var self = this;
      var list = this.players.map(function (p, i) { return i; }).filter(function (i) { return self.players[i].chips > 0; });
      return list;
    }

    /* ---------------- 开新的一手 ----------------
     * rebuyList: 可选，[{seatIndex, amount}] 在发牌前补充筹码（破产自动买入）
     */
    newHand(rebuyList) {
      if (rebuyList) {
        for (var r = 0; r < rebuyList.length; r++) {
          var rb = rebuyList[r];
          var pl = this.players[rb.seatIndex];
          if (pl && rb.amount > 0) pl.chips += rb.amount;
        }
      }
      var self = this;
      var alive = this.activeSeats();
      if (alive.length < 2) {
        this.state = 'over';
        return this;
      }
      // 庄家按钮：真正开下一手时才向后移动一位（跳过没有筹码的人）
      this.handNo++;
      if (this.handNo > 1) {
        var broke = [];
        var bi;
        for (bi = 0; bi < this.players.length; bi++) {
          if (this.players[bi].chips <= 0) broke.push(bi);
        }
        this.dealer = this.nextSeat(this.dealer, broke);
      } else if (this.players[this.dealer].chips <= 0) {
        var broke2 = [];
        var bj;
        for (bj = 0; bj < this.players.length; bj++) {
          if (this.players[bj].chips <= 0) broke2.push(bj);
        }
        this.dealer = this.nextSeat(this.dealer, broke2);
      }
      this.deck = H.shuffle(H.makeDeck(), Math.random);
      this.board = [];
      this.pot = 0;
      this.street = 'preflop';
      this.state = 'betting';
      this.results = null;
      this.resultSummary = null;
      this.totalPotAtEnd = 0;
      this.currentBet = 0;
      this.minRaise = this.bb;
      this.lastRaiseSize = this.bb;
      this.streetAggressor = null;
      this.uncalledReturn = 0;

      this.players.forEach(function (p) {
        p.hole = []; p.bet = 0; p.totalBet = 0; p.folded = false; p.allIn = false; p.acted = false;
        p.lastAction = null; p.lastAmount = 0; p.handName = ''; p.handScore = null;
        p.net = 0; p.won = 0; p.startingChips = p.chips;
        p.out = p.chips <= 0;
      });

      this.log('第 ' + this.handNo + ' 手 · 庄家 ' + this.players[this.dealer].name, { divider: true });

      // 发牌：从庄家下家开始，每人两张
      var order = this.orderFrom((this.dealer + 1) % this.n()).filter(function (i) { return self.players[i].chips > 0; });
      for (var round = 0; round < 2; round++) {
        for (var o = 0; o < order.length; o++) this.players[order[o]].hole.push(this.deck.pop());
      }

      // 盲注
      var n = this.n();
      var inHand = [];
      for (var k = 0; k < n; k++) if (this.players[(this.dealer + 1 + k) % n].chips > 0) inHand.push((this.dealer + 1 + k) % n);
      var sbSeat, bbSeat;
      if (inHand.length === 2) {
        sbSeat = this.dealer;                        // 单挑：庄家下小盲
        bbSeat = this.nextSeat(this.dealer, [this.dealer]);
      } else {
        sbSeat = inHand[0];
        bbSeat = inHand[1];
      }
      this.sbSeat = sbSeat;
      this.bbSeat = bbSeat;
      this.postBlind(sbSeat, this.sb, '小盲');
      this.postBlind(bbSeat, this.bb, '大盲');
      this.currentBet = Math.max(this.sb, this.bb);
      this.minRaise = this.bb;
      this.lastRaiseSize = this.bb;
      this.streetAggressor = null;

      // 翻牌前：大盲下家先行动；单挑时小盲（庄家）先行动
      if (inHand.length === 2) {
        this.toAct = (sbSeat + 1) % n;   // 单挑：小盲（庄家）先行动
      } else {
        // 大盲下家（UTG）先行动；若该座位已无筹码，继续往后找
        this.toAct = bbSeat;
        for (var sk = 0; sk < n; sk++) {
          this.toAct = (this.toAct + 1) % n;
          if (!this.players[this.toAct].allIn) break;
        }
      }
      // 盲注下完可能有人直接被盲注全下：若“下一个行动者”无法行动，走一遍推进
      var startSeat = this.toAct;
      var canStart = this.players[startSeat] && !this.players[startSeat].allIn && !this.players[startSeat].folded;
      if (!canStart) this.advance(true);
      return this;
    }

    postBlind(seat, amount, label) {
      var p = this.players[seat];
      var paid = this.commit(p, amount);
      p.lastAction = label;
      p.lastAmount = paid;
      this.log(p.name + ' ' + label + ' ' + paid);
      return paid;
    }

    commit(p, amount) {
      var wanted = Math.floor(amount);
      if (!(wanted > 0)) wanted = 0;
      var paid = Math.min(wanted, p.chips);
      p.chips = p.chips - paid;
      p.bet = p.bet + paid;
      p.totalBet = p.totalBet + paid;
      var potSum = 0;
      for (var pi2 = 0; pi2 < this.players.length; pi2++) potSum += this.players[pi2].totalBet;
      this.pot = potSum;   // 底池始终等于所有人本手投入之和
      if (p.chips <= 0) {
        p.chips = 0;
        p.allIn = true;
      }
      return paid;
    }

    /* 当前行动者可选的操作 */
    options(p) {
      if (!p || this.state !== 'betting' || this.players[this.toAct] !== p || p.folded || p.allIn) return null;
      var toCall = this.currentBet - p.bet;
      if (toCall < 0) toCall = 0;
      if (toCall > p.chips) toCall = p.chips;
      var canCheck = toCall === 0;
      var maxTo = p.bet + p.chips;
      var canRaise = maxTo > this.currentBet;
      var isBet = this.currentBet === 0;
      var minTo = isBet ? Math.min(this.bb, maxTo) : this.currentBet + this.lastRaiseSize;
      if (minTo > maxTo) minTo = maxTo;
      return {
        toCall: toCall, canCheck: canCheck, canCall: toCall > 0, canCallAllIn: toCall >= p.chips,
        canRaise: canRaise, minTo: minTo, maxTo: maxTo, isBet: isBet,
        pot: this.pot, currentBet: this.currentBet, callPutsAllIn: toCall >= p.chips,
      };
    }

    /* ---------------- 执行动作 ---------------- */
    doAction(p, type, amount) {
      if (this.state !== 'betting') return this;   // 牌局已结束（例如全下结算），忽略迟到的动作
      if (!p || this.players[this.toAct] !== p) throw new Error('还没轮到这个玩家');
      var opt = this.options(p);
      if (!opt) throw new Error('该玩家无法行动');
      var actType = type;
      if (actType === 'allin') actType = 'raise';
      if (actType === 'fold' && opt.canCheck) actType = 'check';

      if (actType === 'fold') {
        p.folded = true;
        p.acted = true;
        p.lastAction = '弃牌';
        p.lastAmount = 0;
        this.log(p.name + ' 弃牌');
        actType = 'done';
      }

      if (actType === 'check') {
        if (opt.canCheck) {
          p.acted = true;
          p.lastAction = '过牌';
          p.lastAmount = 0;
          this.log(p.name + ' 过牌');
          actType = 'done';
        } else {
          actType = 'call';
        }
      }

      if (actType === 'call') {
        var needAmt = this.currentBet - p.bet;
        var paid = this.commit(p, needAmt);
        p.acted = true;
        p.lastAmount = paid;
        if (paid === 0) {
          p.lastAction = '过牌';
          this.log(p.name + ' 过牌');
        } else if (p.allIn) {
          p.lastAction = '全下';
          this.log(p.name + ' 全下跟注 ' + paid);
        } else {
          p.lastAction = '跟注';
          this.log(p.name + ' 跟注 ' + paid);
        }
        actType = 'done';
      }

      if (actType === 'raise') {
        if (!opt.canRaise) {
          // 没得加注就当作跟注（跟注也做不了时才会走到这里）
          var callPaid = this.commit(p, this.currentBet - p.bet);
          p.acted = true;
          p.lastAmount = callPaid;
          p.lastAction = callPaid > 0 ? '跟注' : '过牌';
          this.log(p.name + ' ' + (callPaid > 0 ? '跟注 ' + callPaid : '过牌'));
        } else {
          var target = amount;
          if (target === Infinity || target === null || target === undefined) target = opt.maxTo;
          target = Math.round(target);
          if (target < opt.minTo) target = opt.minTo;
          if (target > opt.maxTo) target = opt.maxTo;
          this.commit(p, target - p.bet);
          var newBet = p.bet;
          var delta = newBet - this.currentBet;
          if (delta > 0) {
            this.currentBet = newBet;
            if (delta >= this.lastRaiseSize - 1e-9) {
              this.lastRaiseSize = delta;
              this.minRaise = delta;
              this.reopenAction(p);
            }
          }
          p.acted = true;
          p.lastAmount = newBet;
          p.lastAction = p.allIn ? '全下' : (opt.isBet ? '下注' : '加注');
          this.log(p.name + ' ' + (opt.isBet ? '下注 ' : '加注到 ') + newBet + (p.allIn ? '（全下）' : ''));
        }
        actType = 'done';
      }

      if (actType !== 'done') throw new Error('未知动作: ' + type);

      this.advance();
      return this;
    }

    /* 完整加注后，重新打开其他玩家（未弃牌、未全下）的行动权 */
    reopenAction(fullRaise) {
      for (var i = 0; i < this.players.length; i++) {
        var q = this.players[i];
        if (q === fullRaise) continue;
        if (q.folded || q.allIn) continue;
        q.acted = false;
      }
    }

    /* 供 UI/测试使用：一次执行并返回日志快照 */
    play(p, type, amount) {
      this.doAction(p, type, amount);
      return this.log ? this.history.slice() : [];
    }

    /* 还需要行动的人：未弃牌、未全下，且（本街还没行动过，或下注额不足） */
    pendingActors() {
      var cur = this.currentBet;
      return this.players.filter(function (p) {
        return !p.folded && !p.allIn && (!p.acted || p.bet < cur);
      });
    }

    /* 一次行动之后的推进 ---------------------------------------------
     * 规则要点：
     *  1. 只要还有“能行动的人”可能需要跟注/过牌，就必须继续问他们；
     *  2. 只有在“没有人能再行动”或“本街所有人都已行动且注额已平”时才结束本街；
     *  3. 结束时先把无人跟注的多余筹码退回，再发牌/结算。
     */
    advance() {
      var i;
      var alive = 0;
      var canAct = 0;
      var pending = 0;
      for (i = 0; i < this.players.length; i++) {
        var p = this.players[i];
        if (p.folded) continue;
        alive++;
        if (!p.allIn) {
          canAct++;
          if (!p.acted || p.bet < this.currentBet) pending++;
        }
      }
      if (alive <= 1) { this.finishHand(); return this; }

      // 还有需要行动的人 → 交给下一个
      if (pending > 0) {
        var seat = this.findNextSeat();
        if (seat >= 0) { this.toAct = seat; return this; }
      }

      // 本街结束：先把“本街还没出牌的人”视为过牌（已跟平的情况下），再结束
      for (i = 0; i < this.players.length; i++) {
        var q = this.players[i];
        if (q.folded || q.allIn) continue;
        if (!q.acted || q.bet < this.currentBet) pending++;
      }
      this.endStreet();
      return this;
    }

    /* 从当前行动者之后找下一个需要行动的人，-1 表示没有 */
    findNextSeat() {
      var target = this.currentBet;
      var total = this.players.length;
      var base = this.toAct;
      for (var step = 1; step <= total; step++) {
        var idx = (base + step) % total;
        var p = this.players[idx];
        if (p.folded || p.allIn) continue;
        if (p.acted && p.bet >= target) continue;
        return idx;
      }
      return -1;
    }

    /* 本街结束 ------------------------------------------------------- */
    endStreet() {
      if (this.state !== 'betting') return this;
      // 注意：这里不能退款——本街结束后仍可能有人需要跟注全下
      var i;
      for (i = 0; i < this.players.length; i++) {
        this.players[i].bet = 0;
        this.players[i].acted = false;
      }
      this.currentBet = 0;
      this.lastRaiseSize = this.bb;
      this.minRaise = this.bb;
      this.streetAggressor = null;

      var alive = 0;
      var canAct = 0;
      for (i = 0; i < this.players.length; i++) {
        if (this.players[i].folded) continue;
        alive++;
        if (!this.players[i].allIn) canAct++;
      }
      if (alive <= 1) { this.finishHand(); return this; }
      var si = STREETS.indexOf(this.street);
      if (si >= 3 || canAct <= 1) {
        this.dealRemaining();
        this.finishHand();
        return this;
      }
      this.dealNextStreet();
      this.toAct = this.firstToActPostflop();
      return this;
    }

    dealNextStreet() {
      this.deck.pop();                                  // 烧牌
      if (this.street === 'preflop') {
        this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
        this.street = 'flop';
      } else if (this.street === 'flop') {
        this.board.push(this.deck.pop());
        this.street = 'turn';
      } else {
        this.board.push(this.deck.pop());
        this.street = 'river';
      }
      this.log('【' + STREET_CN[this.street] + '】' + this.board.map(H.cardStr).join(' '), { board: true, cards: this.board.slice() });
    }

    dealRemaining() {
      var guard = 0;
      while (this.board.length < 5 && guard++ < 6) this.dealNextStreet();
    }

    /* 翻牌后的第一个行动者：庄家下家开始，跳过已弃牌 / 已全下的人 */
    firstToActPostflop() {
      var total = this.players.length;
      for (var step = 1; step <= total; step++) {
        var idx = (this.dealer + step) % total;
        if (this.players[idx].folded) continue;
        if (this.players[idx].allIn) continue;
        return idx;
      }
      return this.dealer;
    }

    evaluateAll() {
      var evs = {};
      for (var i = 0; i < this.players.length; i++) {
        var p = this.players[i];
        if (p.folded || p.hole.length < 2) continue;
        var ev = H.evaluate(p.hole.concat(this.board));
        p.handName = H.describeHand(ev);
        p.handScore = ev.score;
        evs[i] = ev;
      }
      return evs;
    }

    finishHand() {
      var self = this;
      if (this.state === 'showdown') return this;
      this.returnUncalled();
      var tbTotal = 0;
      var tbi;
      for (tbi = 0; tbi < this.players.length; tbi++) tbTotal += this.players[tbi].totalBet;
      this.dealRemaining();

      var evs = this.evaluateAll();
      var n = this.players.length;
      var i, j;

      // 1) 按“未弃牌者”的投入额分层（弃牌者的钱按层分摊，不参与比牌资格）
      var distinct = [];
      var tmpList = this.players.map(function (q) { return q.folded ? 0 : q.totalBet; });
      for (i = 0; i < n; i++) {
        var amount = tmpList[i];
        if (amount <= 0) continue;
        var found = false;
        for (j = 0; j < distinct.length; j++) {
          if (distinct[j] === amount) found = true;
        }
        if (!found) distinct.push(amount);
      }
      distinct.sort(function (a, b) { return a - b; });
      if (distinct.length === 0) distinct.push(0);
      var levels = distinct;

      // 2) 按层切池：每一层的钱 = 每人 min(投入, 该层额度) 之和 - 上一层已累计的金额之和
      var payouts = new Array(n).fill(0);
      var pots = [];
      var prevCappedSum = 0;
      for (i = 0; i < levels.length; i++) {
        var lvl = levels[i];
        var cappedSum = 0;
        for (j = 0; j < n; j++) {
          var capHere = Math.min(this.players[j].totalBet, lvl);
          cappedSum += capHere;
        }
        // 已弃牌者的投入按“被没收”处理：并入主池（只有未弃牌者能拿）
        var potAmount = cappedSum - prevCappedSum;
        var eligible = [];
        for (j = 0; j < n; j++) {
          if (this.players[j].totalBet >= lvl && !this.players[j].folded) eligible.push(j);
        }
        if (potAmount > 0) pots.push({ level: lvl, amount: potAmount, eligible: eligible });
        prevCappedSum = cappedSum;
      }


      var totalPot = 0;
      for (i = 0; i < pots.length; i++) totalPot += pots[i].amount;
      if (pots.length > 0 && totalPot !== tbTotal) {
        // 极端边界（如被盲注卡住的全下）兜底：让底池与所有人投入对齐
        pots[0].amount += tbTotal - totalPot;
      }
      totalPot = 0;
      for (i = 0; i < pots.length; i++) totalPot += pots[i].amount;
      this.totalPotAtEnd = totalPot;

      // 保险：底池与各层金额统一以总投入为准
      this.totalPotAtEnd = tbTotal;
      this.pot = tbTotal;

      // 3) 每个池比牌，赢家平分（余数按庄家下家顺序）
      //    注意：主池里“已弃牌者被没收的钱”要单独并入金额，所以这里用 pots 原数组逐个结算
      var results = [];
      for (i = 0; i < pots.length; i++) {
        var layerPot = pots[i];
        if (layerPot.eligible.length === 0) continue;
        var bestScore = -1;
        for (j = 0; j < layerPot.eligible.length; j++) {
          var seat = layerPot.eligible[j];
          var sc = evs[seat] ? evs[seat].score : -1;
          if (sc > bestScore) bestScore = sc;
        }
        var winnerList = [];
        for (j = 0; j < layerPot.eligible.length; j++) {
          var wseat = layerPot.eligible[j];
          if ((evs[wseat] ? evs[wseat].score : -1) === bestScore) winnerList.push(wseat);
        }
        winnerList.sort(function (a, b) {
          return ((a - self.dealer + n) % n) - ((b - self.dealer + n) % n);
        });
        var each = Math.floor(layerPot.amount / winnerList.length);
        var rem = layerPot.amount - each * winnerList.length;
        for (j = 0; j < winnerList.length; j++) payouts[winnerList[j]] += each;
        for (j = 0; j < rem; j++) payouts[winnerList[j % winnerList.length]] += 1;
        results.push({ amount: layerPot.amount, winners: winnerList, share: each });
      }

      // 4) 展示用：合并连续、由同一批人赢下的池
      var display = [];
      for (i = 0; i < results.length; i++) {
        var r = results[i];
        var tail = display.length ? display[display.length - 1] : null;
        var same = false;
        if (tail && tail.winnerIdxs.length === r.winners.length) {
          same = true;
          for (j = 0; j < r.winners.length; j++) {
            if (tail.winnerIdxs.indexOf(r.winners[j]) < 0) same = false;
          }
        }
        if (same) {
          tail.amount += r.amount;
          tail.merged = (tail.merged || 1) + 1;
        } else {
          display.push({ amount: r.amount, winnerIdxs: r.winners.slice() });
        }
      }
      for (i = 0; i < display.length; i++) {
        var d = display[i];
        d.names = [];
        for (j = 0; j < d.winnerIdxs.length; j++) d.names.push(this.players[d.winnerIdxs[j]].name);
        if (d.merged) d.label = (i === 0 ? '主池 + 边池' : '边池') + '（合并 ' + d.merged + ' 个）';
        else if (display.length === 1) d.label = '底池';
        else if (i === 0) d.label = '主池';
        else d.label = '边池' + (i === display.length - 1 ? '' : ' ' + i);
      }

      // 5) 落账
      for (i = 0; i < n; i++) {
        this.players[i].chips += payouts[i];
        this.players[i].won = payouts[i];
        this.players[i].net = payouts[i] - this.players[i].totalBet;
      }


      var aliveCount = 0;
      for (i = 0; i < n; i++) if (!this.players[i].folded) aliveCount++;
      this.state = 'showdown';
      this.street = 'showdown';
      this.resultSummary = {
        pots: display.map(function (d) {
          return {
            amount: d.amount,
            winners: d.names,
            winnerIdxs: d.winnerIdxs,
            label: d.label,
            split: d.winnerIdxs.length > 1,
          };
        }),
        payouts: payouts,
        showdown: aliveCount > 1,
        board: this.board.slice(),
        totalPot: totalPot,
        uncalledReturn: this.uncalledReturn,
      };

      for (i = 0; i < this.resultSummary.pots.length; i++) {
        var pr = this.resultSummary.pots[i];
        this.log('『' + pr.winners.join('、') + '』赢得 ' + pr.amount + (this.resultSummary.pots.length > 1 ? '（' + pr.label + '）' : ''), { win: true });
      }
      return this;
    }

    returnUncalled() {
      // 找出未弃牌玩家中投入最高的那位
      var i;
      var topIdx = -1;
      var topBet = -1;
      for (i = 0; i < this.players.length; i++) {
        var p = this.players[i];
        if (p.folded) continue;
        if (p.totalBet > topBet) {
          topBet = p.totalBet;
          topIdx = i;
        }
      }
      if (topIdx < 0) return;

      // 其余未弃牌者中的最高投入（没有任何其他人可跟 → 无需退回，全部视为已跟）
      var secondBet = 0;
      var others = 0;
      for (i = 0; i < this.players.length; i++) {
        var q = this.players[i];
        if (i === topIdx) continue;
        if (q.folded) continue;
        others++;
        if (q.totalBet > secondBet) secondBet = q.totalBet;
      }
      if (others === 0) return;
      var diff = topBet - secondBet;
      if (diff <= 0) return;

      var refund = this.players[topIdx];
      refund.chips = refund.chips + diff;
      refund.totalBet = refund.totalBet - diff;
      refund.bet = refund.bet - diff;
      this.pot = this.pot - diff;
      this.uncalledReturn = this.uncalledReturn + diff;
      this.log('退回 ' + refund.name + ' 未跟注的 ' + diff);
    }

    view(seatIndex) {
      var self = this;
      return {
        handNo: this.handNo, street: this.street, state: this.state, board: this.board.slice(), pot: this.pot,
        toAct: this.state === 'betting' ? this.toAct : -1,
        dealer: this.dealer, sb: this.sb, bb: this.bb, sbSeat: this.sbSeat, bbSeat: this.bbSeat,
        players: this.players.map(function (p, i) {
          return {
            seat: i, name: p.name, isHuman: p.isHuman, chips: p.chips, bet: p.bet, totalBet: p.totalBet,
            folded: p.folded, allIn: p.allIn, lastAction: p.lastAction, lastAmount: p.lastAmount,
            hole: (i === seatIndex || self.state === 'showdown') ? p.hole.slice() : [],
            holeCount: p.hole.length, handName: self.state === 'showdown' ? p.handName : '',
            won: p.won, net: p.net,
          };
        }),
      };
    }
  }

  var api = { Game: Game, STREETS: STREETS, STREET_CN: STREET_CN };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HoldemGame = api;
})();
