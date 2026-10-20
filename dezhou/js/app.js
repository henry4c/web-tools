/* =====================================================================
 * 德州扑克 · 界面逻辑
 *   - 开局设置（机器人数量 / 每个机器人的水平与性格 / 盲注 / 筹码）
 *   - 牌桌渲染、行动按钮、加注滑条、快捷键
 *   - 机器人行动调度（带“思考”延迟，可调节速度）
 *   - 结算面板、牌局日志、战绩统计
 * ===================================================================== */
(function () {
  'use strict';

  var Eng = window.Holdem;
  var GameMod = window.HoldemGame;
  var AI = window.HoldemAI;

  var $ = function (id) { return document.getElementById(id); };
  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 隐私模式下忽略 */ }
    }
  };

  /* ---------------- 对战记录（localStorage 持久化） ---------------- */
  var RECORDS_KEY = 'holdem.records.v1';
  var RECORDS_MAX = 500;          // 最多保存 500 条，避免占满存储

  function loadRecords() {
    var list = store.get(RECORDS_KEY, []);
    if (!Array.isArray(list)) return [];
    return list.filter(function (r) {
      return r && typeof r.id === 'number' && typeof r.handNo === 'number';
    });
  }
  function saveRecords(list) {
    try {
      localStorage.setItem(RECORDS_KEY, JSON.stringify(list));
    } catch (e) {
      // 存储空间不足：只保留最近 100 条再试一次
      try { localStorage.setItem(RECORDS_KEY, JSON.stringify(list.slice(-100))); } catch (e2) { /* 忽略 */ }
    }
  }
  /* 把一手的结果写进对战记录 */
  function pushRecord(game, me, sum) {
    var levels = [];
    game.players.forEach(function (p) {
      if (p.isHuman) return;
      var lv = AI.LEVELS[p.level] || AI.LEVELS[2];
      var st = STYLE_NAMES[p.style] || '';
      levels.push(lv.name + (st ? '/' + st : ''));
    });
    var rec = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      time: Date.now(),
      handNo: game.handNo,
      blinds: game.sb + '/' + game.bb,
      players: game.players.length,
      opponents: levels,
      hole: me.hole.slice(),
      board: game.board.slice(),
      handName: me.folded ? '弃牌' : (me.handName || ''),
      folded: !!me.folded,
      showdown: !!sum.showdown,
      result: me.folded ? 'fold' : (me.won > 0 ? 'win' : 'lose'),
      committed: me.totalBet,
      won: me.won,
      net: me.net,
      chipsAfter: me.chips,
      totalPot: sum.totalPot,
      winners: sum.pots.map(function (r) { return r.winners.join('、'); }).join('；'),
    };
    S.records.push(rec);
    if (S.records.length > RECORDS_MAX) S.records = S.records.slice(-RECORDS_MAX);
    saveRecords(S.records);
  }
  /* 根据记录重算统计（删除记录后也能得到正确汇总） */
  function statsFromRecords() {
    var st = { hands: S.records.length, net: 0, wins: 0, showdowns: 0 };
    S.records.forEach(function (r) {
      st.net += r.net || 0;
      if (r.result === 'win') st.wins++;
      if (r.showdown) st.showdowns++;
    });
    return st;
  }

  function recalcStats() {
    S.stats = statsFromRecords();
    S.stats.net = S.records.reduce(function (a, r) { return a + (r.net || 0); }, 0);
    return S.stats;
  }

  var LEVEL_NAMES = AI.LEVELS.map(function (l) { return l.name; });
  var STYLE_NAMES = AI.STYLES.map(function (s) { return s.name; });
  var STREET_CN = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌' };

  var PLAYER_NAMES = ['老王', '小林', '阿杰', 'Hunter', 'Momo', '铁塔', 'Coco', '阿甘'];
  var AVATAR_EMOJI = ['🧑‍💼', '👩‍🎤', '🧔', '👨‍🦱', '👩‍🦰', '🧓', '👨‍🦲', '👩‍🎓'];

  /* ---------------- 状态 ---------------- */
  var S = {
    game: null,
    settings: null,
    busy: false,          // 动画 / 等机器人
    handOver: false,
    raiseOpen: false,
    timers: [],
    stats: { hands: 0, net: 0, wins: 0, showdowns: 0 },
    records: [],          // 对战记录（每手一条，持久化在 localStorage）
    historyTab: 'summary',
    lastEquity: null,
    eqToken: 0,
    seats: [],
    seatEls: [],
    buttons: [],
    highlight: null,
    logSeen: 0,
    autoNext: false,
  };

  var DEFAULT_SETTINGS = {
    bots: 3,
    levels: [2, 2, 2, 2, 2, 2, 2, 2],     // 每个对手的水平（0~4）
    styles: [1, 1, 1, 1, 1, 1, 1, 1],     // 每个对手的性格（0 紧 / 1 均 / 2 激）
    level: 2,                              // “统一设置”时使用的水平
    style: 1,
    sb: 10,
    bb: 20,
    buyIn: 2000,
    speed: 1,                              // 机器人思考速度 0.5 / 1 / 2
    showEquity: true,                      // 是否显示胜率
  };

  function loadSettings() {
    var saved = store.get('holdem.settings.v2', null);
    var s = {};
    for (var k in DEFAULT_SETTINGS) s[k] = DEFAULT_SETTINGS[k];
    if (saved && typeof saved === 'object') {
      for (var k2 in DEFAULT_SETTINGS) {
        if (saved[k2] === undefined) continue;
        if (k2 === 'levels' || k2 === 'styles') {
          if (Array.isArray(saved[k2]) && saved[k2].length === 8) s[k2] = saved[k2].slice();
        } else if (typeof saved[k2] === typeof DEFAULT_SETTINGS[k2]) {
          s[k2] = saved[k2];
        }
      }
    }
    return s;
  }

  /* ---------------- 工具 ---------------- */
  function later(fn, ms) {
    var id = setTimeout(function () {
      S.timers = S.timers.filter(function (x) { return x !== id; });
      fn();
    }, ms);
    S.timers.push(id);
    return id;
  }
  function clearTimers() {
    S.timers.forEach(clearTimeout);
    S.timers = [];
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function fmt(n) {
    if (n === null || n === undefined || isNaN(n)) return '0';
    return Math.round(n).toLocaleString('zh-CN');
  }
  function shortFmt(n) {
    n = Math.round(n);
    if (n >= 10000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k';
    return String(n);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function cardEl(card, opts) {
    opts = opts || {};
    if (card === null || card === undefined) return el('div', 'card placeholder');
    var suit = Eng.SUIT_CHAR[Eng.suitOf(card)];
    var red = suit === 'h' || suit === 'd';
    var c = el('div', 'card suit-' + suit + (red ? ' red' : '') + (opts.win ? ' win' : '') + (opts.small ? ' small' : ''));
    c.appendChild(el('div', 'rank', Eng.RANKS[Eng.rankOf(card) - 2]));
    c.appendChild(el('div', 'pip', Eng.SUIT_SYMBOL[suit]));
    if (!opts.noCenter) c.appendChild(el('div', 'center', Eng.SUIT_SYMBOL[suit]));
    if (opts.badge) c.appendChild(el('div', 'badge', opts.badge));
    return c;
  }
  function cardBack() { return el('div', 'card back'); }

  /* ---------------- 设置面板 ---------------- */
  function buildSetupUI() {
    // 机器人数量
    var botSeg = $('botCountSeg');
    botSeg.innerHTML = '';
    for (var n = 1; n <= 8; n++) {
      (function (num) {
        var b = el('button', 'seg-item');
        b.type = 'button';
        b.appendChild(el('span', 'seg-main', num + ' 个'));
        b.appendChild(el('small', null, (num + 1) + ' 人桌'));
        b.dataset.v = num;
        b.addEventListener('click', function () {
          S.settings.bots = num;
          if (S.settings.customLevels && S.settings.levels.length < num) {
            while (S.settings.levels.length < num) S.settings.levels.push(S.settings.level);
          }
          syncSetupUI();
        });
        botSeg.appendChild(b);
      })(n);
    }

    // 统一水平 / 统一性格
    var lvSeg = $('botLevelSeg');
    lvSeg.innerHTML = '';
    AI.LEVELS.forEach(function (lv, i) {
      var b = el('button', 'seg-item');
      b.type = 'button';
      b.appendChild(el('span', 'seg-main', lv.name));
      b.appendChild(el('small', null, lv.desc));
      b.dataset.v = i;
      b.addEventListener('click', function () {
        S.settings.level = i;
        if (!S.settings.customLevels) {
          for (var k = 0; k < 8; k++) S.settings.levels[k] = i;
        } else {
          // 只在未逐个自定义时同步；这里明确表示“全部改成这个水平”
          for (var k2 = 0; k2 < 8; k2++) S.settings.levels[k2] = i;
          S.settings.customLevels = false;
        }
        syncSetupUI();
      });
      lvSeg.appendChild(b);
    });

    var stSeg = $('botStyleSeg');
    stSeg.innerHTML = '';
    AI.STYLES.forEach(function (st, i) {
      var b = el('button', 'seg-item');
      b.type = 'button';
      b.appendChild(el('span', 'seg-main', st.name));
      b.appendChild(el('small', null, st.desc));
      b.dataset.v = i;
      b.addEventListener('click', function () {
        S.settings.style = i;
        for (var k = 0; k < 8; k++) S.settings.styles[k] = i;
        S.settings.customStyles = false;
        syncSetupUI();
      });
      stSeg.appendChild(b);
    });

    // 筹码
    var stackSeg = $('stackSeg');
    stackSeg.innerHTML = '';
    [1000, 2000, 5000, 10000].forEach(function (v) {
      var b = el('button', 'seg-item');
      b.type = 'button';
      b.appendChild(el('span', 'seg-main', fmt(v)));
      b.appendChild(el('small', null, (v / 20) + ' 个大盲'));
      b.dataset.v = v;
      b.addEventListener('click', function () { S.settings.buyIn = v; syncSetupUI(); });
      stackSeg.appendChild(b);
    });

    // 速度
    var speedSeg = $('speedSeg');
    speedSeg.innerHTML = '';
    [{ v: 0.5, t: '慢' }, { v: 1, t: '正常' }, { v: 2, t: '快' }, { v: 4, t: '极快' }].forEach(function (o) {
      var b = el('button', 'seg-item');
      b.type = 'button';
      b.textContent = o.t;
      b.dataset.v = o.v;
      b.addEventListener('click', function () { S.settings.speed = o.v; syncSetupUI(); });
      speedSeg.appendChild(b);
    });

    $('inpSB').addEventListener('input', readBlinds);
    $('inpBB').addEventListener('input', readBlinds);
    $('btnStart').addEventListener('click', startGame);
    $('btnSetupClose').addEventListener('click', function () {
      if (S.game) hideModal('setupModal');
    });
    $('btnSettings').addEventListener('click', openSetup);
    $('btnRules').addEventListener('click', showModal('rulesModal'));
    $('btnRulesClose').addEventListener('click', hideModal('rulesModal'));
    $('btnStats').addEventListener('click', function () { showStats('summary'); });
    // 面板里的 tab（用事件委托，避免元素重建后失效）
    $('statsModal').addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== this && !(t.classList && t.classList.contains('tab'))) t = t.parentNode;
      if (t && t !== this && t.dataset && t.dataset.tab) showStats(t.dataset.tab);
    });
    $('btnStatsClose').addEventListener('click', hideModal('statsModal'));
    $('chkEquity').addEventListener('change', function () {
      S.settings.showEquity = $('chkEquity').checked;
      store.set('holdem.settings.v2', S.settings);
      renderEquity();
    });
  }

  function readBlinds() {
    var sb = parseInt($('inpSB').value, 10);
    var bb = parseInt($('inpBB').value, 10);
    if (!isFinite(sb) || sb < 1) sb = 1;
    if (!isFinite(bb) || bb <= sb) bb = sb * 2;
    S.settings.sb = sb;
    S.settings.bb = bb;
    syncSetupUI(true);
  }

  function syncSetupUI(keepInputs) {
    var s = S.settings;
    var lvSet = {};
    for (var k = 0; k < s.bots; k++) lvSet[s.levels[k]] = true;
    var onlyOneLevel = Object.keys(lvSet).length === 1;
    var stSet = {};
    for (var k2 = 0; k2 < s.bots; k2++) stSet[s.styles[k2]] = true;
    var onlyOneStyle = Object.keys(stSet).length === 1;

    $('botCountSeg').querySelectorAll('.seg-item').forEach(function (b) {
      b.classList.toggle('on', +b.dataset.v === s.bots);
    });
    $('botLevelSeg').querySelectorAll('.seg-item').forEach(function (b) {
      b.classList.toggle('on', onlyOneLevel && +b.dataset.v === Number(Object.keys(lvSet)[0]));
    });
    $('botStyleSeg').querySelectorAll('.seg-item').forEach(function (b) {
      b.classList.toggle('on', onlyOneStyle && +b.dataset.v === Number(Object.keys(stSet)[0]));
    });
    $('stackSeg').querySelectorAll('.seg-item').forEach(function (b) {
      b.classList.toggle('on', +b.dataset.v === s.buyIn);
    });
    $('speedSeg').querySelectorAll('.seg-item').forEach(function (b) {
      b.classList.toggle('on', +b.dataset.v === s.speed);
    });
    if (!keepInputs) {
      $('inpSB').value = s.sb;
      $('inpBB').value = s.bb;
    }
    buildBotList();
    var note = '共 ' + (s.bots + 1) + ' 人桌 · 盲注 ' + s.sb + '/' + s.bb + ' · 每人 ' + fmt(s.buyIn);
    $('setupNote').textContent = note;
  }

  /* 每个机器人的水平/性格逐个设置 */
  function buildBotList() {
    var wrap = $('botList');
    wrap.innerHTML = '';
    for (var i = 0; i < S.settings.bots; i++) {
      (function (idx) {
        var row = el('div', 'bot-row');
        var av = el('div', 'bot-av', AVATAR_EMOJI[idx % AVATAR_EMOJI.length]);
        row.appendChild(av);
        row.appendChild(el('div', 'bot-name', PLAYER_NAMES[idx % PLAYER_NAMES.length]));

        var sel = document.createElement('select');
        sel.className = 'bot-select';
        AI.LEVELS.forEach(function (lv, li) {
          var o = document.createElement('option');
          o.value = li;
          o.textContent = lv.name;
          if (S.settings.levels[idx] === li) o.selected = true;
          sel.appendChild(o);
        });
        sel.addEventListener('change', function () {
          S.settings.levels[idx] = +sel.value;
          S.settings.customLevels = true;
          syncSetupUI(true);
        });
        row.appendChild(sel);

        var sel2 = document.createElement('select');
        sel2.className = 'bot-select';
        AI.STYLES.forEach(function (st, si) {
          var o = document.createElement('option');
          o.value = si;
          o.textContent = st.name;
          if (S.settings.styles[idx] === si) o.selected = true;
          sel2.appendChild(o);
        });
        sel2.addEventListener('change', function () {
          S.settings.styles[idx] = +sel2.value;
          S.settings.customStyles = true;
        });
        row.appendChild(sel2);
        wrap.appendChild(row);
      })(i);
    }
    if (S.settings.bots === 1) {
      var tip = el('div', 'bot-tip', '提示：单挑时你在庄位先行动，翻牌后后行动。');
      wrap.appendChild(tip);
    }
  }

  function showModal(id) {
    $(id).classList.add('on');
    document.body.classList.add('modal-open');
  }
  function hideModal(id) {
    $(id).classList.remove('on');
    if (!document.querySelector('.modal.on')) document.body.classList.remove('modal-open');
  }

  function openSetup() {
    if (S.game) {
      $('setupTitle').textContent = '重新开局';
      $('btnStart').textContent = '开始新对局（当前进度会清空）';
      $('btnSetupClose').style.display = 'flex';
    } else {
      $('setupTitle').textContent = '新牌局';
      $('btnStart').textContent = '开始对局';
      $('btnSetupClose').style.display = 'none';
    }
    syncSetupUI();
    showModal('setupModal');
  }

  /* ---------------- 开始对局 ---------------- */
  function startGame() {
    clearTimers();
    S.busy = false;
    S.handOver = false;
    S.raiseOpen = false;
    S.handsSession = 0;
    recalcStats();
    S.lastEquity = null;
    S.highlight = null;
    S.logSeen = 0;
    hideModal('resultOverlay');
    hideModal('setupModal');
    hideModal('rulesModal');
    store.set('holdem.settings.v2', S.settings);

    var s = S.settings;
    var seats = [{ id: 0, name: '你', isHuman: true, chips: s.buyIn, level: 0, style: 1 }];
    for (var i = 0; i < s.bots; i++) {
      seats.push({
        id: i + 1,
        name: PLAYER_NAMES[i % PLAYER_NAMES.length],
        isHuman: false,
        chips: s.buyIn,
        level: s.levels[i],
        style: s.styles[i],
      });
    }
    var game = new GameMod.Game({ sb: s.sb, bb: s.bb, startChips: s.buyIn, seats: seats, dealer: 0 });
    S.game = game;
    S.dealerStart = 0;

    buildTable();
    renderAll(true);
    $('logList').innerHTML = '';
    S.logSeen = 0;
    flushLog();
    later(step, 500);
  }

  /* ---------------- 牌桌与座位 ---------------- */
  function buildTable() {
    var game = S.game;
    var wrap = $('seats');
    wrap.innerHTML = '';
    S.seatEls = [];
    var humans = game.players.length;

    // 以“你”为底部中央：把座位按相对“你”的顺序重排到桌边
    var meIdx = game.players.findIndex(function (p) { return p.isHuman; });
    var ids = [];
    for (var k = 0; k < humans; k++) ids.push((meIdx + k) % humans);

    var layout = seatLayout(humans);
    ids.forEach(function (seatIdx, pos) {
      var p = game.players[seatIdx];
      var xy = layout[pos];
      var seat = createSeatDOM(p, seatIdx, xy.x, xy.y, p.isHuman);
      // y 坐标大的在上半桌（远离我），下注气泡显示在座位下方；反之在上方
      seat.root.classList.add(xy.y <= 50 ? 'top' : 'bottom');
      if (xy.y <= 12) seat.root.classList.add('top-1');
      S.seatEls.push(seat);
    });
    applyLayout();
  }

  /* 返回按“从你（底部）开始顺时针”排列的坐标 */
  function seatLayout(n) {
    var spots = [];
    // 9 人桌理想位置（百分比，椭圆排布）
    var ELLIPSE = [
      { x: 50, y: 92 },   // 0 = 你（底部）
      { x: 20, y: 84 },
      { x: 6, y: 60 },
      { x: 10, y: 30 },
      { x: 28, y: 10 },
      { x: 50, y: 6 },
      { x: 72, y: 10 },
      { x: 90, y: 30 },
      { x: 94, y: 60 },
      { x: 80, y: 84 },
    ];
    // 按人数从 ELLIPSE 中挑选，保证均匀
    var picks = {
      2: [0, 5],
      3: [0, 3, 6],
      4: [0, 2, 5, 8],
      5: [0, 2, 4, 6, 8],
      6: [0, 1, 3, 5, 7, 9],
      7: [0, 1, 3, 5, 6, 7, 9],
      8: [0, 1, 2, 4, 6, 7, 8, 9],
      9: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    }[n] || [0, 5];
    picks.forEach(function (idx) { spots.push(ELLIPSE[idx]); });
    return spots;
  }

  function createSeatDOM(p, seatIdx, x, y, isMe) {
    var root = el('div', 'seat' + (isMe ? ' is-me' : ''));
    root.dataset.seat = seatIdx;
    root.style.left = x + '%';
    root.style.top = y + '%';

    var inner = el('div', 'seat-inner');

    var hole = el('div', 'seat-hole');
    var info = el('div', 'seat-info');
    var head = el('div', 'seat-head');
    var avatar = el('div', 'avatar', isMe ? '😎' : AVATAR_EMOJI[(seatIdx - 1) % AVATAR_EMOJI.length]);
    var nameWrap = el('div', 'name-wrap');
    var nm = el('div', 'seat-name', p.name);
    nameWrap.appendChild(nm);
    if (!isMe) {
      var lv = AI.LEVELS[p.level] || AI.LEVELS[2];
      var tag = el('div', 'seat-tag lv-' + p.level, lv.name);
      nameWrap.appendChild(tag);
    }
    head.appendChild(avatar);
    head.appendChild(nameWrap);
    info.appendChild(head);
    var chips = el('div', 'seat-chips', fmt(p.chips));
    info.appendChild(chips);

    inner.appendChild(hole);
    inner.appendChild(info);

    var act = el('div', 'seat-action');
    var bet = el('div', 'bet-bubble');
    var dealer = el('div', 'dealer-btn', 'D');
    var timer = el('div', 'turn-timer');

    root.appendChild(inner);
    root.appendChild(act);
    root.appendChild(bet);
    root.appendChild(dealer);
    root.appendChild(timer);
    $('seats').appendChild(root);

    return {
      root: root, inner: inner, holeEl: hole, actionEl: act, betEl: bet, dealerEl: dealer,
      chipsEl: chips, seatIdx: seatIdx, p: p, lastHoleSig: null,
    };
  }

  function applyLayout() {
    S.seatEls.forEach(function (s) {
      var left = parseFloat(s.root.style.left);
      s.root.classList.remove('edge-left', 'edge-right');
      if (left < 15) s.root.classList.add('edge-left');
      else if (left > 85) s.root.classList.add('edge-right');
    });
  }

  /* ---------------- 渲染 ---------------- */
  function renderAll(force) {
    var game = S.game;
    if (!game) return;
    var me = human();
    if (!me) return;
    $('statHand').textContent = '第 ' + game.handNo + ' 手';
    $('statBlinds').textContent = '盲注 ' + game.sb + '/' + game.bb;
    $('statMyChips').textContent = '我的筹码 ' + fmt(me.chips);
    $('statNet').textContent = '净收益 ' + (S.stats.net >= 0 ? '+' : '') + fmt(S.stats.net);
    $('statNet').className = 'info-chip ' + (S.stats.net > 0 ? 'pos' : (S.stats.net < 0 ? 'neg' : ''));
    $('statHands').textContent = '已打 ' + S.stats.hands + ' 手';
    $('potValue').textContent = fmt(game.pot);
    $('streetBadge').textContent = STREET_CN[game.street] || '';

    renderBoard(force);
    renderSeats(force);
    renderHandPanel(force);
    renderActions();
    renderEquity();
    flushLog();
  }

  function human() {
    if (!S.game) return null;
    return S.game.players.find(function (p) { return p.isHuman; }) || null;
  }

  function renderBoard(force) {
    var game = S.game;
    var boardEl = $('board');
    var hl = S.highlight || [];
    for (var i = 0; i < 5; i++) {
      var card = i < game.board.length ? game.board[i] : null;
      var slot = boardEl.children[i];
      if (!slot) {
        slot = el('div', 'board-slot');
        boardEl.appendChild(slot);
      }
      var sig = card === null ? 'empty' : card + '|' + (hl.indexOf(card) >= 0 ? 1 : 0);
      if (!force && slot.dataset.sig === sig) continue;
      slot.dataset.sig = sig;
      slot.innerHTML = '';
      slot.appendChild(cardEl(card, { win: card !== null && hl.indexOf(card) >= 0 }));
    }
  }

  function renderSeats(force) {
    var game = S.game;
    var cur = game.state === 'betting' ? game.players[game.toAct] : null;
    S.seatEls.forEach(function (seat) {
      var p = seat.p;
      var idx = game.players.indexOf(p);
      var isMe = p.isHuman;
      var isTurn = cur === p;
      seat.root.classList.toggle('is-turn', isTurn);
      seat.root.classList.toggle('is-folded', p.folded && game.state === 'betting');
      seat.root.classList.toggle('is-winner', p.won > 0 && game.state === 'showdown');
      seat.root.classList.toggle('is-out', p.chips <= 0 && game.state !== 'showdown');
      seat.chipsEl.textContent = fmt(p.chips);
      seat.chipsEl.classList.toggle('low', p.chips < game.bb * 10);

      var isDealer = idx === game.dealer;
      if (seat.dealerEl.dataset.on !== String(isDealer)) {
        seat.dealerEl.dataset.on = String(isDealer);
        seat.dealerEl.style.display = isDealer ? 'grid' : 'none';
      }

      // 底牌
      var showCards = isMe || (game.state === 'showdown' && !p.folded);
      var sig;
      if (p.hole.length === 0) sig = 'none';
      else if (showCards) sig = 'h:' + p.hole.join(',');
      else sig = 'b:' + p.hole.length;
      if (force || seat.lastHoleSig !== sig) {
        seat.lastHoleSig = sig;
        seat.holeEl.innerHTML = '';
        if (p.hole.length) {
          p.hole.forEach(function (c) {
            if (showCards) {
              var hl = S.highlight || [];
              seat.holeEl.appendChild(cardEl(c, { win: hl.indexOf(c) >= 0 }));
            } else {
              seat.holeEl.appendChild(cardBack());
            }
          });
        }
      }

      // 行动标签
      var label = '';
      if (game.state === 'betting') {
        if (p.lastAction) label = p.lastAction;
      } else if (game.state === 'showdown' && !p.folded) {
        label = p.handName || '';
      }
      if (p.allIn && game.state === 'betting') label = '全下';
      seat.actionEl.textContent = label;
      seat.actionEl.className = 'seat-action'
        + (label ? ' on' : '')
        + (label === '弃牌' ? ' fold' : '')
        + (label === '过牌' ? ' check' : '')
        + (label === '跟注' ? ' call' : '')
        + (label === '加注' || label === '下注' ? ' raise' : '')
        + (label === '全下' ? ' allin' : '');

      // 下注气泡
      var betTxt = '';
      if (p.bet > 0) betTxt = fmt(p.bet);
      else if (game.state === 'showdown' && p.won > 0) betTxt = '+' + fmt(p.won);
      if (force || seat.betEl.textContent !== betTxt) {
        seat.betEl.textContent = betTxt;
        seat.betEl.classList.toggle('on', !!betTxt);
        seat.betEl.classList.toggle('win', game.state === 'showdown' && p.won > 0);
      }
    });
  }

  function renderHandPanel(force) {
    var game = S.game;
    if (!game) return;
    var me = human();
    if (!me) return;
    var wrap = $('myCards');
    var hl = S.highlight || [];
    var sig = me.hole.join(',') + '|' + hl.join(',');
    if (force || wrap.dataset.sig !== sig) {
      wrap.dataset.sig = sig;
      wrap.innerHTML = '';
      if (me.hole.length === 0) {
        wrap.appendChild(cardEl(null));
        wrap.appendChild(cardEl(null));
      } else {
        me.hole.forEach(function (c) { wrap.appendChild(cardEl(c, { win: hl.indexOf(c) >= 0, noCenter: true })); });
      }
    }
    var st = $('handStrength');
    if (game.state === 'showdown') {
      st.textContent = me.folded ? '你已弃牌' : ('你的牌型：' + (me.handName || '—'));
    } else if (me.folded) {
      st.textContent = '你已弃牌，等待本手结束';
    } else if (!me.hole.length) {
      st.textContent = '等待发牌…';
    } else if (game.board.length) {
      var ev = Eng.evaluate(me.hole.concat(game.board));
      st.textContent = '当前牌型：' + Eng.describeHand(ev);
    } else {
      st.textContent = '起手牌：' + describeHole(me.hole);
    }
  }

  function describeHole(hole) {
    var r1 = Eng.rankOf(hole[0]), r2 = Eng.rankOf(hole[1]);
    var hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    var suited = Eng.suitOf(hole[0]) === Eng.suitOf(hole[1]);
    var n1 = Eng.RANKS[hi - 2], n2 = Eng.RANKS[lo - 2];
    if (hi === lo) return '对 ' + n1;
    return n1 + n2 + (suited ? ' 同花' : ' 不同花');
  }

  function renderEquity() {
    var fill = $('eqBarFill');
    var label = $('eqText');
    var chip = $('statWinrate');
    if (!S.settings.showEquity) {
      fill.style.width = '0%';
      label.textContent = '胜率显示已关闭';
      chip.textContent = '胜率 —';
      return;
    }
    var me = S.game ? human() : null;
    var eq = S.lastEquity;
    if (!me || me.folded || eq === null || eq === undefined) {
      fill.style.width = '0%';
      label.textContent = me && me.folded ? '已弃牌' : (S.game && S.game.state === 'showdown' ? '本手结束' : '—');
      chip.textContent = '胜率 —';
      return;
    }
    var pct = Math.round(eq * 100);
    fill.style.width = pct + '%';
    fill.className = 'eqbar-fill ' + (pct >= 65 ? 'good' : (pct >= 40 ? 'mid' : 'bad'));
    var opps = S.game.players.filter(function (p) { return !p.isHuman && !p.folded; }).length;
    label.textContent = pct + '%（对 ' + opps + ' 名随机手牌）';
    chip.textContent = '胜率 ' + pct + '%';
  }

  /* 行动按钮 */
  function renderActions() {
    var game = S.game;
    if (!game) return;
    var me = human();
    var acting = !S.busy && game.state === 'betting' && game.players[game.toAct] === me && !S.handOver;
    var opt = acting ? game.options(me) : null;

    var turnLabel = $('turnLabel');
    var subLabel = $('toCallLabel');
    if (acting && opt) {
      turnLabel.textContent = '轮到你行动';
      turnLabel.className = 'turn-label mine';
      if (opt.toCall > 0) {
        var needEq = Math.round(opt.toCall / (opt.pot + opt.toCall) * 100);
        subLabel.textContent = '跟注 ' + fmt(opt.toCall) + ' · 底池 ' + fmt(opt.pot) + ' · 需要胜率 ' + needEq + '%';
      } else {
        subLabel.textContent = '无人下注 · 可过牌或下注 · 底池 ' + fmt(opt.pot);
      }
    } else if (game.state === 'betting') {
      var who = game.players[game.toAct];
      turnLabel.textContent = who ? who.name + ' 行动中…' : '等待中';
      turnLabel.className = 'turn-label';
      subLabel.textContent = '底池 ' + fmt(game.pot);
    } else if (game.state === 'showdown') {
      turnLabel.textContent = '本手结束';
      turnLabel.className = 'turn-label';
      subLabel.textContent = '';
    } else {
      turnLabel.textContent = '牌局进行中';
      turnLabel.className = 'turn-label';
      subLabel.textContent = '';
    }

    var show = !!acting;
    $('btnFold').disabled = !show;
    $('btnCheck').disabled = !show;
    $('btnCall').disabled = !show;
    $('btnRaise').disabled = !show;
    $('btnAllin').disabled = !show;

    $('btnFold').classList.toggle('hidden', !(show && opt && !opt.canCheck));
    $('btnCheck').classList.toggle('hidden', !(show && opt && opt.canCheck));
    $('btnCall').classList.toggle('hidden', !(show && opt && opt.canCall));

    if (opt) {
      if (opt.canCall) {
        var label = opt.canCallAllIn ? '跟注全下 ' + fmt(me.chips) : '跟注 ' + fmt(opt.toCall);
        $('btnCall').innerHTML = escapeHtml(label) + '<kbd>K</kbd>';
      } else {
        $('btnCall').innerHTML = '跟注<kbd>K</kbd>';
      }
      var raiseLabel = opt.isBet ? '下注' : '加注';
      if (opt.canRaise) {
        $('btnRaise').innerHTML = escapeHtml(raiseLabel) + '<kbd>R</kbd>';
      }
      $('btnAllin').innerHTML = '全下 ' + shortFmt(opt.maxTo) + '<kbd>A</kbd>';
      $('btnAllin').classList.toggle('hidden', !(show && opt.canRaise));
    }

    var canOpen = show && opt && opt.canRaise;
    if (!canOpen) S.raiseOpen = false;
    $('raiseRow').classList.toggle('on', !!(canOpen && S.raiseOpen));
    if (canOpen && S.raiseOpen) setupSlider(opt);
  }

  /* ---------------- 加注滑条 ---------------- */
  var sliderOpt = null;
  function setupSlider(opt) {
    var slider = $('raiseSlider');
    var min = Math.max(1, Math.floor(opt.minTo));
    var max = Math.max(min, Math.floor(opt.maxTo));
    if (sliderOpt !== opt) {
      sliderOpt = opt;
      slider.min = min;
      slider.max = max;
      slider.step = sliderStep(max - min);
      slider.value = Math.floor((min + max) / 2);
    } else {
      slider.min = min;
      slider.max = max;
      slider.step = sliderStep(max - min);
      if (+slider.value < min) slider.value = min;
      if (+slider.value > max) slider.value = max;
    }
    var v = +slider.value;
    $('raiseAmount').textContent = fmt(v);
    $('raiseOf').textContent = '/ ' + fmt(max) + ' · ' + potPctText(opt, v);
    $('btnConfirmRaise').textContent = (opt.isBet ? '确认下注 ' : '确认加注到 ') + fmt(v);
  }
  /* 下注额相对“加注后底池”的比例：更符合玩家的直观感受 */
  function potPctText(opt, v) {
    var add = v - (opt.currentBet || 0) - 0;
    var callPart = opt.isBet ? 0 : opt.toCall;
    var potAfter = opt.pot + callPart + Math.max(0, add);
    if (potAfter <= 0) return '—';
    var pct = Math.round(Math.max(0, add) / potAfter * 100);
    return pct + '% 底池';
  }

  function sliderStep(range) {
    if (range <= 50) return 1;
    if (range <= 500) return 5;
    if (range <= 5000) return 25;
    return 100;
  }

  function setRaiseValue(amount) {
    var opt = gameOpt();
    if (!opt) return;
    var v = Math.max(opt.minTo, Math.min(opt.maxTo, amount));
    $('raiseSlider').value = v;
    setupSlider(opt);
    $('raiseSlider').value = v;
    $('raiseAmount').textContent = fmt(v);
    $('btnConfirmRaise').textContent = (opt.isBet ? '确认下注 ' : '确认加注到 ') + fmt(v);
  }

  function quickRaise(frac) {
    var opt = gameOpt();
    if (!opt) return;
    var target;
    if (frac === 'allin') {
      target = opt.maxTo;
    } else if (frac === 'min') {
      target = opt.minTo;
    } else if (opt.isBet) {
      target = Math.floor(opt.pot * frac);
    } else {
      target = opt.toCall + Math.floor((opt.pot + opt.toCall) * frac);
    }
    setRaiseValue(target);
  }

  function gameOpt() {
    var game = S.game;
    if (!game || game.state !== 'betting') return null;
    var me = human();
    if (!me || game.players[game.toAct] !== me) return null;
    return game.options(me);
  }

  /* ---------------- 我的操作 ---------------- */
  function humanAction(type, amount) {
    var game = S.game;
    if (!game || S.busy || game.state !== 'betting') return;
    var me = human();
    if (game.players[game.toAct] !== me) return;
    S.raiseOpen = false;
    sliderOpt = null;
    try {
      game.doAction(me, type, amount);
    } catch (e) {
      console.warn(e);
      return;
    }
    renderAll();
    later(step, 350);
  }

  /* ---------------- 机器人调度 ---------------- */
  function step() {
    var game = S.game;
    if (!game) return;
    if (game.state === 'showdown') { onHandOver(); return; }
    if (game.state !== 'betting') return;
    var cur = game.players[game.toAct];
    if (!cur) return;
    if (cur.isHuman) {
      S.busy = false;
      renderAll();
      computeEquity();
      return;
    }
    S.busy = true;
    renderAll();
    var speed = S.settings.speed || 1;
    var delay = (520 + Math.random() * 480) / speed;
    later(function () {
      var g = S.game;
      if (!g || g.state !== 'betting') { S.busy = false; return; }
      var p = g.players[g.toAct];
      if (!p || p.isHuman) { S.busy = false; later(step, 50); return; }
      var d = null;
      try {
        d = AI.decide({ game: g, player: p, level: p.level, style: p.style, rng: Math.random });
      } catch (e) {
        console.warn('AI 决策出错', e);
      }
      try {
        if (!d) {
          var o = g.options(p);
          g.doAction(p, o && o.canCheck ? 'check' : 'fold');
        } else if (d.type === 'raise') {
          g.doAction(p, 'raise', d.amount);
        } else {
          g.doAction(p, d.type);
        }
      } catch (e) {
        console.warn('AI 动作出错', e);
        try {
          var o2 = g.options(p);
          if (o2) g.doAction(p, o2.canCheck ? 'check' : 'fold');
        } catch (e2) { /* 忽略 */ }
      }
      S.busy = false;
      renderAll();
      later(step, 220 / speed);
    }, delay);
  }

  /* 胜率异步计算，避免卡顿 */
  function computeEquity() {
    var game = S.game;
    var me = human();
    if (!game || !me || !me.hole.length || me.folded || !S.settings.showEquity) {
      S.lastEquity = null;
      renderEquity();
      return;
    }
    var token = ++S.eqToken;
    var hole = me.hole.slice();
    var board = game.board.slice();
    var trials = board.length === 0 ? 220 : (board.length === 3 ? 360 : 420);
    var rng = Eng.mulberry32(((Math.random() * 1e9) >>> 0) ^ game.handNo);
    later(function () {
      if (token !== S.eqToken || !S.game) return;
      var eq = Eng.equity(hole, board, trials, rng, function () { return token !== S.eqToken; });
      if (token !== S.eqToken) return;
      S.lastEquity = eq;
      renderEquity();
    }, 20);
  }

  /* ---------------- 日志 ---------------- */
  function flushLog() {
    var game = S.game;
    if (!game) return;
    var list = $('logList');
    if (S.logSeen === 0) list.innerHTML = '';
    var fresh = game.history.slice(S.logSeen);
    S.logSeen = game.history.length;
    fresh.forEach(function (h) {
      var cls = 'log-entry' + (h.win ? ' win' : '') + (h.divider ? ' divider' : '') + (h.board ? ' board' : '');
      var div = el('div', cls);
      div.textContent = h.text;
      list.appendChild(div);
    });
    while (list.children.length > 80) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
  }

  /* ---------------- 结算 ---------------- */
  function onHandOver() {
    var game = S.game;
    if (!game || !game.resultSummary || S.handOver) return;
    S.handOver = true;
    S.busy = false;
    S.lastEquity = null;
    var me = human();
    // 写入对战记录（持久化），统计从记录汇总
    pushRecord(game, me, game.resultSummary);
    S.handsSession = (S.handsSession || 0) + 1;
    recalcStats();

    // 高亮赢家的最佳 5 张
    S.highlight = pickHighlight(game);
    renderAll();

    var sum = game.resultSummary;
    var overlay = $('resultOverlay');
    var card = $('resultCard');
    card.classList.toggle('win', me.won > 0 && !me.folded);
    card.classList.toggle('lose', me.won <= 0 || me.folded);

    var title = me.folded ? '你已弃牌' : (me.won > 0 ? (sum.showdown ? '🎉 摊牌获胜' : '🎉 你赢得底池') : '本手结束');
    $('rcTitle').textContent = title;
    $('rcSub').textContent = '第 ' + game.handNo + ' 手 · ' + (STREET_CN[game.street] || '') + ' · 底池 ' + fmt(sum.totalPot);

    var bd = $('rcBoard');
    bd.innerHTML = '';
    game.board.forEach(function (c) { bd.appendChild(cardEl(c, { win: (S.highlight || []).indexOf(c) >= 0 })); });

    var pots = $('rcPots');
    pots.innerHTML = '';
    // 亮牌
    var showdownLines = [];
    game.players.forEach(function (p) {
      if (p.folded || !p.hole.length) return;
      showdownLines.push({ name: p.name, hand: p.handName, hole: p.hole.slice(), won: p.won });
    });
    if (sum.showdown && showdownLines.length) {
      var sec = el('div', 'rc-section');
      sec.appendChild(el('div', 'rc-section-title', '亮牌'));
      showdownLines.forEach(function (line) {
        var row = el('div', 'rc-player' + (line.won > 0 ? ' won' : ''));
        row.appendChild(el('span', 'rc-pname', line.name));
        var cs = el('span', 'rc-cards');
        line.hole.forEach(function (c) { cs.appendChild(cardEl(c, { small: true, noCenter: true })); });
        row.appendChild(cs);
        row.appendChild(el('span', 'rc-hand', line.hand || ''));
        if (line.won > 0) row.appendChild(el('span', 'rc-won', '+' + fmt(line.won)));
        sec.appendChild(row);
      });
      pots.appendChild(sec);
    }
    // 底池分配
    var sec2 = el('div', 'rc-section');
    sec2.appendChild(el('div', 'rc-section-title', '底池分配'));
    sum.pots.forEach(function (r) {
      var row = el('div', 'rc-pot');
      row.appendChild(el('span', 'rc-label', r.label + ' · ' + r.winners.join('、') + (r.split ? '（平分）' : '')));
      row.appendChild(el('span', 'rc-amt', '+' + fmt(r.amount)));
      sec2.appendChild(row);
    });
    pots.appendChild(sec2);

    var netRow = el('div', 'rc-net ' + (me.net >= 0 ? 'pos' : 'neg'));
    netRow.appendChild(el('span', null, '你本手净收益'));
    netRow.appendChild(el('span', null, (me.net >= 0 ? '+' : '') + fmt(me.net)));
    pots.appendChild(netRow);

    // 破产提示
    if (me.chips <= 0) {
      $('rcTitle').textContent = me.won > 0 ? '🎉 你赢得底池' : '你筹码输光了';
      $('rcSub').textContent += ' · 下一手会自动补充筹码';
    }
    showModal('resultOverlay');
    if (S.autoNext) later(nextHand, 1200);
  }

  function pickHighlight(game) {
    var best = -1, bestPlayer = null;
    game.players.forEach(function (p) {
      if (p.folded || p.handScore == null) return;
      if (p.handScore > best) { best = p.handScore; bestPlayer = p; }
    });
    if (!bestPlayer) return [];
    return Eng.evaluate(bestPlayer.hole.concat(game.board)).cards;
  }

  function nextHand() {
    var game = S.game;
    if (!game) return;
    hideModal('resultOverlay');
    S.handOver = false;
    S.highlight = null;
    S.lastEquity = null;
    var s = S.settings;
    // 破产处理：机器人自动补码，保证牌局继续；玩家也会补码
    var rebuys = [];
    game.players.forEach(function (p, i) {
      if (p.chips < game.bb * 5) {
        var add = s.buyIn - p.chips;
        if (add > 0) rebuys.push({ seatIndex: i, amount: add });
      }
    });
    if (rebuys.length) {
      var mine = rebuys.some(function (r) { return game.players[r.seatIndex].isHuman; });
      if (mine) toast('你已补充 ' + fmt(s.buyIn) + ' 筹码');
    }
    var alive = game.players.filter(function (p) {
      var add = 0;
      for (var i = 0; i < rebuys.length; i++) if (game.players[rebuys[i].seatIndex] === p) add += rebuys[i].amount;
      return p.chips + add > 0;
    });
    if (alive.length < 2) {
      rebuys = game.players.map(function (p, i) { return { seatIndex: i, amount: Math.max(0, s.buyIn - p.chips) }; });
    }
    game.newHand(rebuys);
    S.busy = false;
    renderAll(true);
    later(step, 420);
  }

  function rebuy() {
    var me = human();
    if (!me || !S.game) return;
    if (S.game.state === 'betting' && !me.folded && S.game.players[S.game.toAct] === me) {
      toast('请先完成本手，再补码');
      return;
    }
    me.chips += S.settings.buyIn;
    S.game.log('你补充了 ' + fmt(S.settings.buyIn) + ' 筹码');
    renderAll();
    toast('已补充 ' + fmt(S.settings.buyIn) + ' 筹码，当前 ' + fmt(me.chips));
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toastBox');
    if (!t) {
      t = el('div', 'toast');
      t.id = 'toastBox';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2400);
  }

  /* ---------------- 战绩 / 对战记录面板 ---------------- */
  function showStats(tab) {
    if (tab) S.historyTab = tab;
    recalcStats();
    $('historyCount').textContent = String(S.records.length);
    document.querySelectorAll('.stats-tabs .tab').forEach(function (b) {
      b.classList.toggle('on', b.dataset.tab === S.historyTab);
    });
    var summaryOn = S.historyTab === 'summary';
    $('statsBody').style.display = summaryOn ? '' : 'none';
    $('historyBody').style.display = summaryOn ? 'none' : '';
    renderSummary();
    renderHistory();
    showModal('statsModal');
  }

  function renderSummary() {
    var s = S.stats;
    var me = human();
    var avg = S.records.length ? S.records.reduce(function (a, r) { return a + (r.net || 0); }, 0) / S.records.length : 0;
    var rows = [
      ['已打手数（含历史记录）', S.records.length],
      ['赢下的手数', s.wins],
      ['胜率（赢手 / 总手数）', S.records.length ? Math.round(s.wins / S.records.length * 100) + '%' : '—'],
      ['累计净收益', (s.net >= 0 ? '+' : '') + fmt(s.net)],
      ['每手平均收益', S.records.length ? (avg >= 0 ? '+' : '') + avg.toFixed(1) : '—'],
      ['当前筹码', me ? fmt(me.chips) : '—'],
    ];
    var box = $('statsBody');
    box.innerHTML = '';
    rows.forEach(function (r) {
      var row = el('div', 'stat-row');
      row.appendChild(el('span', null, r[0]));
      row.appendChild(el('b', null, String(r[1])));
      box.appendChild(row);
    });
    if (!S.game) return;
    var oppSec = el('div', 'stat-opps');
    oppSec.appendChild(el('div', 'rc-section-title', '本桌对手'));
    S.game.players.forEach(function (p) {
      if (p.isHuman) return;
      var lv = AI.LEVELS[p.level] || AI.LEVELS[2];
      var row = el('div', 'stat-row');
      row.appendChild(el('span', null, p.name + '（' + lv.name + ' · ' + (STYLE_NAMES[p.style] || '') + '）'));
      row.appendChild(el('b', null, fmt(p.chips)));
      oppSec.appendChild(row);
    });
    box.appendChild(oppSec);
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    function p2(n) { return n < 10 ? '0' + n : String(n); }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  function renderHistory() {
    var box = $('historyBody');
    box.innerHTML = '';
    // 顶部操作栏
    var bar = el('div', 'history-bar');
    bar.appendChild(el('span', 'history-total', '共 ' + S.records.length + ' 条 · 累计净收益 ' +
      (S.stats.net >= 0 ? '+' : '') + fmt(S.stats.net)));
    var clearBtn = el('button', 'btn ghost danger', '全部删除');
    clearBtn.type = 'button';
    clearBtn.disabled = S.records.length === 0;
    clearBtn.addEventListener('click', clearAllRecords);
    bar.appendChild(clearBtn);
    box.appendChild(bar);

    if (!S.records.length) {
      box.appendChild(el('div', 'history-empty', '还没有对战记录。打完一手后会自动保存在本地浏览器里。'));
      return;
    }
    var list = el('div', 'history-list');
    // 最新的在最上面
    for (var i = S.records.length - 1; i >= 0; i--) {
      list.appendChild(historyRow(S.records[i], i));
    }
    box.appendChild(list);
  }

  function historyRow(rec, idx) {
    var row = el('div', 'history-row ' + rec.result);
    var head = el('div', 'hr-head');
    var tag = el('span', 'hr-tag ' + rec.result,
      rec.result === 'win' ? '胜' : (rec.result === 'fold' ? '弃牌' : '负'));
    head.appendChild(tag);
    head.appendChild(el('span', 'hr-title', '第 ' + rec.handNo + ' 手 · ' + rec.players + ' 人 · 盲注 ' + rec.blinds));
    head.appendChild(el('span', 'hr-time', fmtTime(rec.time)));
    row.appendChild(head);

    var main = el('div', 'hr-main');
    var cards = el('span', 'hr-cards');
    (rec.hole || []).forEach(function (c) { cards.appendChild(cardEl(c, { small: true, noCenter: true })); });
    main.appendChild(cards);
    var info = el('span', 'hr-info');
    info.appendChild(el('b', null, rec.handName || '—'));
    var delta = rec.net >= 0 ? '+' + fmt(rec.net) : fmt(rec.net);
    var deltaEl = el('span', 'hr-delta ' + (rec.net > 0 ? 'pos' : (rec.net < 0 ? 'neg' : '')), '净 ' + delta);
    info.appendChild(deltaEl);
    info.appendChild(el('span', 'hr-sub',
      '投入 ' + fmt(rec.committed) + ' · 底池 ' + fmt(rec.totalPot) + ' · 结余 ' + fmt(rec.chipsAfter) +
      (rec.winners ? ' · 赢家 ' + rec.winners : '')));
    main.appendChild(info);
    row.appendChild(main);

    if (rec.board && rec.board.length) {
      var boardRow = el('div', 'hr-board');
      boardRow.appendChild(el('span', 'hr-board-label', '公共牌'));
      rec.board.forEach(function (c) { boardRow.appendChild(cardEl(c, { small: true, noCenter: true })); });
      row.appendChild(boardRow);
    }
    if (rec.opponents && rec.opponents.length) {
      row.appendChild(el('div', 'hr-opps', '对手：' + rec.opponents.join('、')));
    }

    var del = el('button', 'hr-del', '×');
    del.type = 'button';
    del.title = '删除这条记录';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      deleteRecord(rec.id);
    });
    row.appendChild(del);
    void idx;
    return row;
  }

  function deleteRecord(id) {
    S.records = S.records.filter(function (r) { return r.id !== id; });
    saveRecords(S.records);
    recalcStats();
    $('historyCount').textContent = String(S.records.length);
    renderHistory();
    renderSummary();
    toast('已删除这条记录');
  }

  function clearAllRecords() {
    if (!S.records.length) return;
    if (!window.confirm('确定删除全部 ' + S.records.length + ' 条对战记录吗？删除后无法恢复。')) return;
    S.records = [];
    saveRecords(S.records);
    recalcStats();
    $('historyCount').textContent = '0';
    renderHistory();
    renderSummary();
    toast('已清空全部对战记录');
  }

  /* ---------------- 事件 ---------------- */
  function bindEvents() {
    $('btnFold').addEventListener('click', function () { humanAction('fold'); });
    $('btnCheck').addEventListener('click', function () { humanAction('check'); });
    $('btnCall').addEventListener('click', function () { humanAction('call'); });
    $('btnAllin').addEventListener('click', function () { humanAction('raise', Infinity); });
    $('btnRaise').addEventListener('click', function () {
      var opt = gameOpt();
      if (!opt) return;
      S.raiseOpen = !S.raiseOpen;
      sliderOpt = null;
      renderActions();
      if (S.raiseOpen) quickRaise(0.5);
    });
    $('btnConfirmRaise').addEventListener('click', function () {
      var opt = gameOpt();
      if (!opt) return;
      var v = +$('raiseSlider').value;
      humanAction('raise', Math.max(opt.minTo, v));
    });
    $('raiseSlider').addEventListener('input', function () {
      var opt = gameOpt();
      if (!opt) return;
      var v = +$('raiseSlider').value;
      $('raiseAmount').textContent = fmt(v);
      $('raiseOf').textContent = '/ ' + fmt(opt.maxTo) + ' · ' + potPctText(opt, v);
      $('btnConfirmRaise').textContent = (opt.isBet ? '确认下注 ' : '确认加注到 ') + fmt(v);
    });
    document.querySelectorAll('.chip-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var f = b.dataset.frac;
        quickRaise(f === 'allin' || f === 'min' ? f : parseFloat(f));
      });
    });
    $('btnNextHand').addEventListener('click', nextHand);
    $('btnRebuy').addEventListener('click', rebuy);
    $('btnShowHand').addEventListener('click', function () {
      hideModal('resultOverlay');
    });
    var autoChk = $('chkAutoNext');
    if (autoChk) {
      autoChk.addEventListener('change', function () {
        S.autoNext = autoChk.checked;
        if (S.autoNext && S.handOver) later(nextHand, 400);
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      var k = e.key.toLowerCase();
      // 有弹窗时只处理 Esc 和“下一手”
      if (document.querySelector('.modal.on')) {
        if (k === 'escape') {
          document.querySelectorAll('.modal.on').forEach(function (m) {
            if (m.id === 'setupModal' && !S.game) return;
            hideModal(m.id);
          });
          return;
        }
        if (S.handOver && (k === ' ' || k === 'enter')) {
          e.preventDefault();
          nextHand();
          return;
        }
        return;
      }
      if (S.handOver && (k === ' ' || k === 'enter')) { e.preventDefault(); nextHand(); return; }
      if (k === 'escape') {
        if (S.raiseOpen) { S.raiseOpen = false; renderActions(); }
        return;
      }
      if (S.busy) return;
      var opt = gameOpt();
      if (!opt) return;
      if (k === 'f') humanAction('fold');
      else if (k === 'c') { if (opt.canCheck) humanAction('check'); }
      else if (k === 'k') humanAction('call');
      else if (k === 'a') humanAction('raise', Infinity);
      else if (k === 'r') {
        if (S.raiseOpen) { S.raiseOpen = false; renderActions(); }
        else {
          S.raiseOpen = true;
          sliderOpt = null;
          renderActions();
          quickRaise(0.5);
        }
      } else if (k === 'm') { S.raiseOpen && quickRaise('min'); }
      else if ('1234'.indexOf(k) >= 0 && S.raiseOpen) {
        var map = { '1': 0.5, '2': 0.75, '3': 1, '4': 'allin' };
        quickRaise(map[k]);
      } else if (k === 'enter' && S.raiseOpen) {
        e.preventDefault();
        $('btnConfirmRaise').click();
      }
    });

    document.querySelectorAll('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) {
        if (e.target !== m) return;
        if (m.id === 'setupModal' && !S.game) return;
        if (m.id === 'resultOverlay') { hideModal('resultOverlay'); return; }
        hideModal(m.id);
      });
    });

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (!S.game) return;
        applyLayout();
        renderAll(true);
      }, 120);
    });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    S.settings = loadSettings();
    S.records = loadRecords();
    buildSetupUI();
    bindEvents();
    $('chkEquity').checked = S.settings.showEquity;
    syncSetupUI();
    openSetup();
    renderEquity();
    window.__holdem = { S: S, Eng: Eng, Game: GameMod, AI: AI };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
