/* =====================================================================
 * 牌型评估测试：  node verify.js
 * ===================================================================== */
const H = require('./engine.js');

const parse = (s) => s.trim().split(/\s+/).map(H.parseCard);
const ev = (s) => H.evaluate(parse(s));
const cmp = (a, b) => Math.sign(ev(a).score - ev(b).score);

let fail = 0;
function ok(cond, msg, extra) {
  if (!cond) fail++;
  console.log((cond ? '✔' : '✘') + ' ' + msg + (extra !== undefined && !cond ? '  → 实际: ' + extra : ''));
}
function eq(got, want, msg) { ok(got === want, msg, got); }

/* ---------- 解析 ---------- */
eq(parse('As Ks 9h 2c').map(H.cardStr).join(' '), 'A♠ K♠ 9♥ 2♣', 'parseCard / cardStr 互转');

/* ---------- 基本牌型 ---------- */
eq(H.describeHand(ev('As Ks Qs Js Ts')), '皇家同花顺', '皇家同花顺');
eq(H.describeHand(ev('9h 8h 7h 6h 5h')), '9 高同花顺', '同花顺');
eq(H.describeHand(ev('Ah 2h 3h 4h 5h')), '5 高同花顺', 'A2345 同花顺');
eq(H.describeHand(ev('Ah 2h 3h 4h 5h Kc Qd')), '5 高同花顺', '7 张里找出 A2345 同花顺');
eq(H.describeHand(ev('Ah As Ad Ac Kd')), 'A 四条', '四条');
eq(ev('5s 5d 5c 5h 2s 3d 4c').kickers.join(','), '5,4', '四条踢脚取最大');
eq(H.describeHand(ev('Kh Ks Kd 2c 2d')), 'K 带 2 葫芦', '葫芦');
eq(H.describeHand(ev('Kh Ks Kd Qc Qd Qh 2d')), 'K 带 Q 葫芦', '两条三条取最大葫芦');
eq(H.describeHand(ev('Ah Jh 9h 6h 3h Kd')), 'A 高同花', '同花');
eq(ev('As Ks 9s 8s 4s 2s Qh').kickers.join(','), '14,13,9,8,4', '同花取最大 5 张');
eq(H.describeHand(ev('9h 8d 7c 6s 5h')), '9 高顺子', '顺子');
eq(H.describeHand(ev('Ah 2d 3c 4s 5h')), '5 高顺子', 'A2345 顺子');
eq(H.describeHand(ev('Qh Qd Qc 9s 4h')), 'Q 三条', '三条');
eq(ev('Qh Qd Qc 9c 4h Ks 2d').kickers.join(','), '12,13,9', '三条踢脚取剩余最大两张');
eq(H.describeHand(ev('Kh Kd 9c 9s 4h')), 'K 和 9 两对', '两对');
eq(ev('Kc Kh Qs Qh 9c 9h 3d').kickers.join(','), '13,12,9', '三对取最大两对 + 最大踢脚');
eq(H.describeHand(ev('Jh Jd 9c 8s 4h')), 'J 一对', '一对');
eq(H.describeHand(ev('Ah Kd 9c 8s 4h')), 'A 高牌', '高牌');
eq(ev('6d 8h Ks Kc 8d Qh Qd').kickers.join(','), '13,12,8', '两对踢脚正确');
ok(
  JSON.stringify(ev('6d 8h Ks Kc 8d Qh Qd').cards.map((c) => H.rankOf(c)).sort((a, b) => b - a)) === JSON.stringify([13, 13, 12, 12, 8]),
  '最佳 5 张的点数正确',
  ev('6d 8h Ks Kc 8d Qh Qd').cards.map(H.cardStr).join(' ')
);
eq(H.describeHand(ev('2h 3h 4h Ks Qs Js Ts 5h')), 'K 高牌', '同花顺需要同一花色：KQJT 是黑桃、2345 是红桃，各自都不是 5 张同花');
eq(H.describeHand(ev('2h 3h 4h 5h Ah Ks Qs')), '5 高同花顺', '红桃 2345A 是同花顺（同时黑桃只有 3 张）');
eq(H.describeHand(ev('Ah Ad Ks Kd Qc Qh Js')), 'A 和 K 两对', '两对 + 三条时按两对比较（牌型优先）');

/* ---------- 牌型大小比较 ---------- */
eq(cmp('9h 8d 7c 6s 5h 2c 3c', 'Ah Jh 9h 6h 3h 2d 4d'), -1, '同花 > 顺子');
eq(cmp('Kh Ks Kd 2c 2d', 'Ah Jh 9h 6h 3h'), 1, '葫芦 > 同花');
eq(cmp('Ks Kd 9c 9s 4h', 'Ks Kd 9c 9s 5h'), -1, '两对比较踢脚');
eq(cmp('As 2d 3c 4s 5h', 'Ah Kd Qc Js 9h'), 1, 'A2345 顺子 > A 高牌');
eq(cmp('Ah Kd Qc Js Th', 'Ad Kc Qd Jd Th'), 0, '同牌力平局');
eq(cmp('2s 2d 3c 4s 5h 6c 7c', 'As Ad 3c 4s 5h 6c 6d'), 1, '2345 67 → 7 高顺子 胜 AA/66 两对');
eq(cmp('2s 2d 2c 4s 5h 6c 7c', 'As Ad Ac 4s 5h 6c 7d'), -1, '葫芦比三条点数：222 输 AAA');
eq(cmp('Ah Kh Qh Jh Th', 'As Ks Qs Js 9s'), 1, '皇家同花顺 > 9 高同花顺');
eq(cmp('6d 8h Ks Kc 8d Qh Qd', '6d 8h Ks Kc 8d Qh Jd'), 1, '两对 + 踢脚比较');

/* ---------- 随机暴力校验：7 张 = 最佳 5 张 ---------- */
function bruteBest(cards) {
  let best = -1;
  for (let a = 0; a < cards.length; a++)
    for (let b = a + 1; b < cards.length; b++)
      for (let c = b + 1; c < cards.length; c++)
        for (let d = c + 1; d < cards.length; d++)
          for (let e = d + 1; e < cards.length; e++) {
            const s = H.evaluate([cards[a], cards[b], cards[c], cards[d], cards[e]]).score;
            if (s > best) best = s;
          }
  return best;
}
{
  const rng = H.mulberry32(20240501);
  let bad = 0;
  let sample = '';
  for (let t = 0; t < 30000; t++) {
    const seven = H.shuffle(H.makeDeck(), rng).slice(0, 7);
    if (H.evaluate(seven).score !== bruteBest(seven)) {
      bad++;
      if (!sample) sample = seven.map(H.cardStr).join(' ');
    }
  }
  ok(bad === 0, '30000 副随机 7 张 = 暴力枚举最佳 5 张', bad + ' 处不一致 ' + sample);
}

/* ---------- 胜率模拟 ---------- */
{
  const rng = H.mulberry32(7);
  const aa = H.equity(parse('As Ah'), [], 2000, rng);
  ok(aa > 0.80 && aa < 0.90, 'AA 对随机手牌胜率约 85%（' + (aa * 100).toFixed(1) + '%）', aa);
  const r72 = H.equity(parse('7s 2d'), [], 2000, rng);
  ok(r72 < 0.40, '72o 胜率 < 40%（' + (r72 * 100).toFixed(1) + '%）', r72);
  const royal = H.equity(parse('As Ks'), parse('Qs Js Ts 2h 3d'), 500, rng);
  eq(royal, 1, '皇家同花顺 → 胜率 100%');
}

console.log(fail === 0 ? '\n全部通过 ✅' : '\n失败 ' + fail + ' 项 ❌');
process.exit(fail ? 1 : 0);
