/* =====================================================================
 * 机器人 AI —— 五档水平 × 三种性格
 * ---------------------------------------------------------------------
 * 决定“水平”的因素：
 *   1. 起手牌门槛：低水平玩太松，高水平按位置收紧
 *   2. 胜率估算：新手靠粗糙的牌力打分；中高级用蒙特卡洛模拟
 *   3. 底池赔率：新手几乎不看，职业严格按赔率+隐含赔率决策
 *   4. 位置：高档位会按位置调整开池/跟注范围
 *   5. 下注尺度：价值下注、诈唬、半诈唬的比例与大小
 *   6. 情绪参数：新手波动大、容易跟注过多；职业几乎不受随机影响
 * ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.HoldemAI = factory(root.Holdem);
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  const LEVELS = [
    {
      key: 'rookie', name: '新手', desc: '只凭牌面大小，很少看赔率',
      trials: 0, openNeed: 0.60, callNeed: 0.42, aggr: 0.55, bluff: 0.02, random: 0.22, pos: 0,
      toughness: 0.35, potOddsWeight: 0.15, multiDiscount: 0.02,
    },
    {
      key: 'casual', name: '休闲', desc: '有点概念，打得比较随意',
      trials: 160, openNeed: 0.54, callNeed: 0.45, aggr: 0.8, bluff: 0.05, random: 0.13, pos: 0.4,
      toughness: 0.55, potOddsWeight: 0.45, multiDiscount: 0.035,
    },
    {
      key: 'solid', name: '中级', desc: '算胜率、按底池赔率跟注',
      trials: 320, openNeed: 0.49, callNeed: 0.47, aggr: 1.0, bluff: 0.09, random: 0.06, pos: 0.75,
      toughness: 0.75, potOddsWeight: 0.75, multiDiscount: 0.05,
    },
    {
      key: 'pro', name: '高手', desc: '看位置、多人底池折扣、会价值下注和诈唬',
      trials: 520, openNeed: 0.45, callNeed: 0.49, aggr: 1.15, bluff: 0.13, random: 0.03, pos: 1,
      toughness: 0.88, potOddsWeight: 0.95, multiDiscount: 0.055,
    },
    {
      key: 'master', name: '职业', desc: '精确胜率、尺度合理、价值与诈唬平衡',
      trials: 760, openNeed: 0.42, callNeed: 0.50, aggr: 1.25, bluff: 0.16, random: 0.012, pos: 1.15,
      toughness: 1, potOddsWeight: 1.05, multiDiscount: 0.06,
    },
  ];

  const STYLES = [
    { key: 'tight', name: '紧手', needAdd: 0.06, aggrMul: 0.85, bluffMul: 0.6, desc: '只玩强牌' },
    { key: 'balanced', name: '均衡', needAdd: 0, aggrMul: 1, bluffMul: 1, desc: '攻守平衡' },
    { key: 'aggressive', name: '激进', needAdd: -0.05, aggrMul: 1.2, bluffMul: 1.6, desc: '爱加注施压' },
  ];

  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* 起手牌强度：用 Chen 公式给 169 种起手牌打分，再按排名映射到 0~1 */
  function chenScore(a, b, suited) {
    var hi = Math.max(a, b), lo = Math.min(a, b);
    var pts = hi === 14 ? 10 : hi === 13 ? 8 : hi === 12 ? 7 : hi === 11 ? 6 : hi / 2;
    if (hi === lo) pts = Math.max(pts * 2, 5);
    if (suited) pts += 2;
    var gap = hi - lo - 1;
    if (hi !== lo) {
      if (gap === 1) pts -= 1;
      else if (gap === 2) pts -= 2;
      else if (gap === 3) pts -= 4;
      else if (gap >= 4) pts -= 5;
      if (gap <= 1 && hi < 12) pts += 1;
    }
    return pts;
  }

  var ALL_STARTING = (function () {
    var list = [];
    for (var a = 2; a <= 14; a++) {
      for (var b = 2; b <= 14; b++) {
        list.push(chenScore(a, b, false));
        if (a !== b) list.push(chenScore(a, b, true));
      }
    }
    return list;
  })();

  function preflopStrength(hole) {
    var r1 = H.rankOf(hole[0]), r2 = H.rankOf(hole[1]);
    var suited = H.suitOf(hole[0]) === H.suitOf(hole[1]);
    var score = chenScore(r1, r2, suited);
    var better = 0;
    for (var i = 0; i < ALL_STARTING.length; i++) if (ALL_STARTING[i] > score) better++;
    var pct = 1 - better / ALL_STARTING.length;   // 击败百分之多少的起手牌
    return clamp(0.12 + pct * 0.88, 0.1, 1);
  }

  /* 翻后：用蒙特卡洛估算对随机对手的胜率 */
  function equityOf(ctx) {
    const { game, player, rng } = ctx;
    const lvl = LEVELS[ctx.level] || LEVELS[2];
    if (game.board.length === 0) return preflopStrength(player.hole);
    const trials = lvl.trials || 120;
    return H.equity(player.hole, game.board, trials, rng);
  }

  /* 计算加到目标注额的可读尺度 */
  function raiseTo(opt, frac, rng) {
    if (frac >= 5) return { type: 'raise', amount: opt.maxTo };
    let base, target;
    if (opt.isBet) {
      base = opt.pot > 0 ? opt.pot : opt.pot + opt.toCall;
      target = Math.max(opt.minTo, Math.floor(base * frac));
    } else {
      base = opt.pot + opt.toCall;
      target = opt.toCall + Math.floor(base * frac);
    }
    if (target < opt.minTo) target = opt.minTo;
    if (target > opt.maxTo) target = opt.maxTo;
    if (target >= opt.maxTo * 0.92) target = opt.maxTo;  // 接近全下就直接全下
    if (rng) target = Math.round(target / 10) * 10 || target;
    return { type: 'raise', amount: Math.max(opt.minTo, Math.min(target, opt.maxTo)) };
  }

  /**
   * 单人决策。返回 { type: 'fold'|'check'|'call'|'raise', amount? }
   * ctx = { game, player, level, style, rng }
   */
  function decide(ctx) {
    const game = ctx.game;
    const player = ctx.player;
    const rng = ctx.rng || Math.random;
    const lvl = LEVELS[ctx.level] || LEVELS[2];
    const style = STYLES[ctx.style] || STYLES[1];
    const opt = game.options(player);
    if (!opt) return null;

    const preflop = game.board.length === 0;
    const toCall = opt.toCall;
    const pot = opt.pot;
    const opponents = Math.max(1, game.players.filter(function (p) { return p !== player && !p.folded; }).length);

    // ---------- 1. 牌力（0~1） ----------
    let strength = equityOf(ctx);
    if (preflop) {
      // 翻前的多人折价更明显；高档位理解得更准
      strength -= Math.min(0.22, (opponents - 1) * lvl.multiDiscount);
    } else {
      strength -= Math.min(0.18, (opponents - 1) * lvl.multiDiscount);
    }
    // 位置：越靠后越有利（低档位不会用）
    const seat = game.players.indexOf(player);
    const n = game.players.length;
    const seatsBehind = (n - 1 - ((seat - game.dealer + n) % n));
    const inPosition = seatsBehind <= Math.floor(n / 2);
    if (inPosition) strength += 0.03 * lvl.pos;
    // 随机扰动：新手最不稳
    strength += (rng() - 0.5) * lvl.random * 0.4;
    strength = clamp(strength, 0, 1);

    const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
    const stack = player.chips + player.bet;
    const effStack = stack > 0 ? stack : 1;
    const callRatio = toCall / effStack;
    const committed = player.totalBet > 0 ? player.totalBet / (player.totalBet + player.chips) : 0;

    const need = (preflop ? lvl.openNeed : lvl.callNeed) + (style.needAdd || 0);
    const aggr = lvl.aggr * (style.aggrMul || 1);
    const bluffChance = lvl.bluff * (style.bluffMul || 1);

    // 用于“是否跟得上赔率”的判定：低档位几乎忽略赔率，高档位严格
    const requiredEq = potOdds * (0.35 + lvl.potOddsWeight * 0.65) + need * (1 - lvl.toughness) * 0.6;

    const boardCount = game.board.length;
    const street = game.street;

    // ================= 无人下注：过牌 / 下注 =================
    if (toCall === 0) {
      const sizes = preflop ? [0.75, 1.0, 1.3] : [0.33, 0.5, 0.66, 0.85, 1.1];
      const size = pick(rng, sizes);
      // 价值下注概率随牌力平滑上升
      let betChance = 0;
      if (strength >= 0.82) betChance = 0.9;
      else if (strength >= 0.72) betChance = 0.68;
      else if (strength >= 0.62) betChance = 0.4;
      else if (strength >= 0.52) betChance = 0.18;
      betChance *= aggr;
      // 顶对以上的强牌在小注池里更愿意施压
      if (betChance > 0 && opt.canRaise && rng() < betChance) return raiseTo(opt, size, rng);
      // 诈唬：翻后单挑更常见；低档位几乎不诈唬
      const bluffBoost = preflop ? 0.5 : (boardCount === 3 ? 1.2 : 0.9);
      if (opt.canRaise && rng() < bluffChance * (opponents === 1 ? 1.5 : 0.6) * bluffBoost) {
        return raiseTo(opt, pick(rng, [0.5, 0.66, 0.9]), rng);
      }
      return { type: 'check' };
    }

    // ================= 面对下注 =================
    // 全下压力：跟注金额相对筹码很大时，门槛提高（高档位更愿意在胜率足够时跟）
    let pressure = 0;
    if (callRatio > 0.4) pressure = (callRatio - 0.4) * (0.55 - lvl.toughness * 0.35);
    if (preflop && callRatio > 0.25) pressure += (callRatio - 0.25) * 0.2 * (1 - lvl.toughness * 0.5);

    const strong = strength >= Math.max(0.72, requiredEq + 0.22);
    const decent = strength >= Math.max(need, requiredEq + 0.04) - pressure;

    // 1) 极强牌：加注（有时只跟注设陷阱，高档位更会这么做）
    if (strength >= 0.84) {
      const raiseChance = (0.55 + 0.35 * lvl.toughness) * aggr;
      if (opt.canRaise && rng() < raiseChance) {
        const size = preflop ? pick(rng, [1.0, 1.3, 5]) : pick(rng, [0.6, 0.9, 1.3, 5]);
        return raiseTo(opt, size, rng);
      }
      return { type: 'call' };
    }
    // 2) 强牌：中等概率加注
    if (strong) {
      if (opt.canRaise && rng() < 0.42 * aggr && !(preflop && callRatio > 0.5)) {
        return raiseTo(opt, pick(rng, preflop ? [0.9, 1.2] : [0.5, 0.8, 1.1]), rng);
      }
      return { type: 'call' };
    }
    // 3) 中等牌：能打平赔率就跟，否则按水平决定弃牌
    if (decent) {
      if (opt.canRaise && rng() < 0.08 * aggr && strength > 0.62 && !preflop) return raiseTo(opt, 0.6, rng);
      return { type: 'call' };
    }
    // 4) 边缘牌：新手爱跟，职业严格按赔率
    const leak = (1 - lvl.toughness) * 0.6;           // 水平低的“跟注漏洞”
    const implied = committed * 0.12 + 0.04;           // 已经投入越多越不舍得弃
    const edge = strength - (requiredEq - implied) + leak;
    if (edge > 0 && rng() < 0.35 + leak) {
      return { type: 'call' };
    }
    // 5) 诈唬性加注（半诈唬，翻后为主）
    if (opt.canRaise && !preflop && rng() < bluffChance * 0.45 * lvl.toughness && toCall < pot * 0.8) {
      return raiseTo(opt, pick(rng, [0.7, 1.0]), rng);
    }
    // 6) 免费过牌时永远不弃牌
    if (opt.canCheck) return { type: 'check' };
    return { type: 'fold' };
  }

  var api = {
    LEVELS: LEVELS,
    STYLES: STYLES,
    decide: decide,
    preflopStrength: preflopStrength,
    equityOf: equityOf,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.HoldemAI = api;
  }
  return api;
});
