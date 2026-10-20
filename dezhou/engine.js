/* =====================================================================
 * Hold'em Engine —— 牌型评估 / 洗牌 / 随机数 / 胜率（浏览器 + Node 通用）
 * ---------------------------------------------------------------------
 * 牌：0..51 整数   rank = (card >> 2) + 2  (2..14)   suit = card & 3
 * 评估：5~7 张取最佳 5 张，返回 { cat, catName, score, kickers, cards }
 *   score = 牌型级别 * 1e8 + 按 16 进制拼接的关键点数（数值比较即可）
 * 同分判定由调用方用 score 比较，完全相同即平分底池。
 * ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Holdem = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SUIT_CHAR = ['s', 'h', 'd', 'c'];
  var SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
  var RANKS = '23456789TJQKA';
  var CATEGORY_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

  function rankOf(card) { return (card >> 2) + 2; }
  function suitOf(card) { return card & 3; }
  function cardStr(card) { return RANKS[rankOf(card) - 2] + SUIT_SYMBOL[SUIT_CHAR[suitOf(card)]]; }
  function cardCode(card) { return RANKS[rankOf(card) - 2] + SUIT_CHAR[suitOf(card)]; }
  function parseCard(str) {
    str = String(str).trim();
    var r = RANKS.indexOf(str.charAt(0).toUpperCase());
    var s = SUIT_CHAR.indexOf(str.charAt(1).toLowerCase());
    if (r < 0 || s < 0) return -1;
    return r * 4 + s;
  }
  function makeDeck() { var d = []; for (var i = 0; i < 52; i++) d.push(i); return d; }
  function shuffle(arr, rng) {
    rng = rng || Math.random;
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /* ------------------------------------------------------------------
   * 手牌评估
   * ------------------------------------------------------------------ */
  function hexScore(ranks) {
    var v = 0;
    for (var i = 0; i < ranks.length; i++) v = v * 16 + ranks[i];
    return v;
  }
  function makeResult(cat, kickers, cards) {
    return {
      cat: cat,
      catName: CATEGORY_NAMES[cat],
      score: cat * 100000000 + hexScore(kickers),
      kickers: kickers,
      cards: cards
    };
  }

  function evaluate(input) {
    var n = input.length;
    var cnt = new Array(15).fill(0);
    var sCnt = [0, 0, 0, 0];
    var sCards = [[], [], [], []];
    var rankCards = [];
    for (var r0 = 2; r0 <= 14; r0++) rankCards[r0] = [];
    for (var i = 0; i < n; i++) {
      var c = input[i];
      var rr = rankOf(c);
      cnt[rr]++;
      var s = suitOf(c);
      sCnt[s]++;
      sCards[s].push(c);
      rankCards[rr].push(c);
    }

    // 同花花色
    var fs = -1;
    for (var s1 = 0; s1 < 4; s1++) if (sCnt[s1] >= 5) fs = s1;

    // ---------- 同花顺 ----------
    if (fs >= 0) {
      var have = new Array(15).fill(false);
      var sc = sCards[fs];
      for (var a = 0; a < sc.length; a++) have[rankOf(sc[a])] = true;
      var top = 0;
      for (var hi = 14; hi >= 5; hi--) {
        if (have[hi] && have[hi - 1] && have[hi - 2] && have[hi - 3] && have[hi - 4]) { top = hi; break; }
      }
      if (top === 0 && have[14] && have[2] && have[3] && have[4] && have[5]) top = 5;
      if (top > 0) {
        var seq = top === 5 ? [5, 4, 3, 2, 14] : [top, top - 1, top - 2, top - 3, top - 4];
        var usedS = [];
        for (var b = 0; b < seq.length; b++) {
          for (var d = 0; d < sc.length; d++) {
            if (rankOf(sc[d]) === seq[b]) { usedS.push(sc[d]); break; }
          }
        }
        return makeResult(8, [top], usedS);
      }
    }

    // ---------- 统计各点数出现次数 ----------
    var quads = [], trips = [], pairs = [], singles = [];
    for (var r1 = 14; r1 >= 2; r1--) {
      var cc = cnt[r1];
      if (cc === 4) quads.push(r1);
      else if (cc === 3) trips.push(r1);
      else if (cc === 2) pairs.push(r1);
      else if (cc === 1) singles.push(r1);
    }

    // ---------- 四条 ----------
    if (quads.length > 0) {
      var q = quads[0];
      // 踢脚：除四条外最大的点数
      var k = 0;
      for (var rq = 14; rq >= 2; rq--) {
        if (rq === q) continue;
        if (cnt[rq] > 0) { k = rq; break; }
      }
      var usedQ = rankCards[q].slice(0, 4);
      if (k > 0) usedQ.push(rankCards[k][0]);
      return makeResult(7, [q, k], usedQ);
    }

    // ---------- 葫芦 ----------
    if (trips.length > 0 && (trips.length > 1 || pairs.length > 0)) {
      var t = trips[0];
      var p = trips.length > 1 ? trips[1] : pairs[0];
      var usedF = rankCards[t].slice(0, 3).concat(rankCards[p].slice(0, 2));
      return makeResult(6, [t, p], usedF);
    }

    // ---------- 同花 ----------
    if (fs >= 0) {
      var sf = sCards[fs].slice();
      sf.sort(function (x, y) { return rankOf(y) - rankOf(x); });
      var top5 = [];
      for (var e = 0; e < 5; e++) top5.push(rankOf(sf[e]));
      return makeResult(5, top5, sf.slice(0, 5));
    }

    // ---------- 顺子 ----------
    var straightTop = 0;
    for (var h2 = 14; h2 >= 5; h2--) {
      if (cnt[h2] && cnt[h2 - 1] && cnt[h2 - 2] && cnt[h2 - 3] && cnt[h2 - 4]) { straightTop = h2; break; }
    }
    if (straightTop === 0 && cnt[14] && cnt[2] && cnt[3] && cnt[4] && cnt[5]) straightTop = 5;
    if (straightTop > 0) {
      var sseq = straightTop === 5 ? [5, 4, 3, 2, 14] : [straightTop, straightTop - 1, straightTop - 2, straightTop - 3, straightTop - 4];
      var usedT = [];
      for (var f = 0; f < sseq.length; f++) usedT.push(rankCards[sseq[f]][0]);
      return makeResult(4, [straightTop], usedT);
    }

    // ---------- 三条 ----------
    if (trips.length > 0) {
      var t3 = trips[0];
      // 踢脚：所有剩余点数里最大的两张（三条之外可能还有对子，也要参与比较）
      var ks3 = [];
      for (var r3 = 14; r3 >= 2 && ks3.length < 2; r3--) {
        if (r3 === t3) continue;
        if (cnt[r3] > 0) ks3.push(r3);
      }
      var used3 = rankCards[t3].slice(0, 3);
      for (var g = 0; g < ks3.length; g++) used3.push(rankCards[ks3[g]][0]);
      while (ks3.length < 2) ks3.push(0);
      return makeResult(3, [t3, ks3[0], ks3[1]], used3);
    }

    // ---------- 两对 ----------
    if (pairs.length > 1) {
      var hi2 = pairs[0], lo2 = pairs[1];
      // 踢脚：从高到低扫描所有点数，取第一个不属于这两对的点数
      var kk = 0;
      for (var rk = 14; rk >= 2; rk--) {
        if (rk === hi2 || rk === lo2) continue;
        if (cnt[rk] > 0) { kk = rk; break; }
      }
      var used2 = rankCards[hi2].slice(0, 2).concat(rankCards[lo2].slice(0, 2));
      if (kk > 0) used2.push(rankCards[kk][0]);
      return makeResult(2, [hi2, lo2, kk], used2);
    }

    // ---------- 一对 ----------
    if (pairs.length === 1) {
      var pp = pairs[0];
      var kick3 = singles.slice(0, 3);
      var used1 = rankCards[pp].slice(0, 2);
      for (var m = 0; m < kick3.length; m++) used1.push(rankCards[kick3[m]][0]);
      while (kick3.length < 3) kick3.push(0);
      return makeResult(1, [pp, kick3[0], kick3[1], kick3[2]], used1);
    }

    // ---------- 高牌 ----------
    var kick5 = singles.slice(0, 5);
    var usedH = [];
    for (var z = 0; z < kick5.length; z++) usedH.push(rankCards[kick5[z]][0]);
    while (kick5.length < 5) kick5.push(0);
    return makeResult(0, kick5, usedH);
  }

  /* ---------------- 文案 ---------------- */
  function rn(r) { return (r >= 2 && r <= 14) ? RANKS[r - 2] : '?'; }
  function describeHand(ev) {
    var k = ev.kickers;
    if (ev.cat === 8) return k[0] === 14 ? '皇家同花顺' : rn(k[0]) + ' 高同花顺';
    if (ev.cat === 7) return rn(k[0]) + ' 四条';
    if (ev.cat === 6) return rn(k[0]) + ' 带 ' + rn(k[1]) + ' 葫芦';
    if (ev.cat === 5) return rn(k[0]) + ' 高同花';
    if (ev.cat === 4) return rn(k[0]) + ' 高顺子';
    if (ev.cat === 3) return rn(k[0]) + ' 三条';
    if (ev.cat === 2) return rn(k[0]) + ' 和 ' + rn(k[1]) + ' 两对';
    if (ev.cat === 1) return rn(k[0]) + ' 一对';
    return rn(k[0]) + ' 高牌';
  }

  /* ---------------- 可复现随机 ---------------- */
  function hashSeed(str) {
    var h = 1779033703 ^ String(str).length;
    str = String(str);
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- 胜率（蒙特卡洛，对随机手牌） ---------------- */
  function equity(hole, board, trials, rng, shouldAbort) {
    rng = rng || Math.random;
    trials = trials || 400;
    var dead = new Array(52).fill(false);
    for (var i = 0; i < hole.length; i++) dead[hole[i]] = true;
    for (var j = 0; j < board.length; j++) dead[board[j]] = true;
    var pool = [];
    for (var c = 0; c < 52; c++) if (!dead[c]) pool.push(c);
    var need = 5 - board.length;
    var win = 0, tie = 0, done = 0;
    for (var t = 0; t < trials; t++) {
      if (shouldAbort && (t & 31) === 0 && shouldAbort()) break;
      var p = pool.slice();
      var picked = [];
      for (var m = 0; m < need + 2; m++) {
        var ii = Math.floor(rng() * p.length);
        picked.push(p[ii]);
        p[ii] = p[p.length - 1];
        p.pop();
      }
      var full = board.concat(picked.slice(0, need));
      var mine = evaluate(hole.concat(full)).score;
      var theirs = evaluate(picked.slice(need, need + 2).concat(full)).score;
      if (mine > theirs) win++;
      else if (mine === theirs) tie++;
      done++;
    }
    return done > 0 ? (win + tie / 2) / done : 0;
  }

  return {
    SUIT_CHAR: SUIT_CHAR, SUIT_SYMBOL: SUIT_SYMBOL, RANKS: RANKS, CATEGORY_NAMES: CATEGORY_NAMES,
    rankOf: rankOf, suitOf: suitOf, cardStr: cardStr, cardCode: cardCode, parseCard: parseCard,
    makeDeck: makeDeck, shuffle: shuffle, evaluate: evaluate, describeHand: describeHand,
    hashSeed: hashSeed, mulberry32: mulberry32, equity: equity
  };
});
