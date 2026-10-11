/* 界面与对局控制 */
(function () {
  'use strict';

  var GM = window.Gomoku;
  var AI = window.GomokuAI;
  var NOT = window.GomokuNotation;
  var NET = window.GomokuOnline;

  var X = 1, O = -1;
  var N = GM.N, CELLS = GM.CELLS;

  /* 棋盘坐标系（SVG viewBox 单位）：15×15 个格子，每格 56，四周留白 30 */
  var VB_W = 900, VB_H = 900, PAD = 30, STEP = 56;
  var ANIM_MS = 220;   /* 与 CSS 里 .piece 的 transition 时长保持一致 */

  /*
   * maxDepth 只是上限，实际层数由时间预算和"下一层搜不搜得完"共同决定。
   * margin 是"简单"档专属的随机余量：分值落在最优解这个范围内的着法里随机挑一个，
   * 所以它下得不算太差，但每盘都不一样。
   */
  var DIFFICULTY = {
    easy: { depth: 2, time: 600, margin: 500 },
    normal: { depth: 12, time: 2000, margin: 0 },
    hard: { depth: 16, time: 6000, margin: 0 }
  };

  /* ---- DOM ---- */
  var boardWrap = document.getElementById('boardWrap');
  var boardEl = document.getElementById('board');
  var svgEl = document.getElementById('boardSvg');
  var pieceLayer = document.getElementById('pieceLayer');
  var hintLayer = document.getElementById('hintLayer');
  var statusEl = document.getElementById('status');
  var turnDotEl = document.getElementById('turnDot');
  var engineInfoEl = document.getElementById('engineInfo');
  var moveListEl = document.getElementById('moveList');
  var pveGroup = document.getElementById('pveGroup');
  var sideGroup = document.getElementById('sideGroup');
  var onlineGroup = document.getElementById('onlineGroup');
  var netGroup = document.getElementById('netGroup');
  var undoBtn = document.getElementById('undoBtn');
  var evalFillEl = document.getElementById('evalFill');
  var evalXTxtEl = document.getElementById('evalXTxt');
  var evalOTxtEl = document.getElementById('evalOTxt');
  var evalScoreEl = document.getElementById('evalScore');
  var evalCanvasEl = document.getElementById('evalCanvas');
  var scoreGroup = document.getElementById('scoreGroup');
  var scoreBodyEl = document.getElementById('scoreBody');
  var chatGroup = document.getElementById('chatGroup');
  var chatTitleEl = document.getElementById('chatTitle');
  var chatListEl = document.getElementById('chatList');
  var chatInputEl = document.getElementById('chatInput');

  /* ---- 对局状态 ---- */
  var board, turn, history, mode, aiSide, difficulty;
  var gameOver, lastMove, thinking, resultText, winner;
  var pieceEls = new Array(CELLS).fill(null);
  var geo = { cell: 44, pad: 30, size: 36 };
  var netSide = 0;         /* 联机时我方执子 */
  var netRole = '';        /* 'host' | 'guest'，决定谁执 X */
  var netRoom = '';        /* 已创建、正在等人加入的房号 */
  var lastAiInfo = null;
  var flipped = false;     /* 是否把棋盘转 180° */
  var hoverCell = -1;      /* 鼠标悬停的格子，用来画半透明的落子预览 */
  var blockPoints = [];    /* 对手已经有四时，必须堵的那几个点 */
  var winNowPoints = [];   /* 自己已经有四时，这一步就能成五的点 */
  var winLine = [];        /* 终局五连的那几个格子 */
  var playableMoves = [];  /* 当前所有空点。联机收到着法时用它校验 */

  /*
   * evals[k] = 走完第 k 步之后、以 X 视角的局面评分。
   * evals[0] 是开局。相邻两项之差就是这一步的损失，用于算胜率和终局评分。
   */
  var evals = [];
  var evalGen = 0;         /* 悔棋/重开后自增，用来丢弃迟到的旧评估 */
  var evalInFlight = 0;    /* 在算的评估个数，用来防止队列积压 */
  var EVAL_DEPTH = 4;      /* 评估用的固定深度：够看清战术，又不会拖慢电脑思考 */
  var EVAL_TIME = 1500;    /* 只是兜底上限，正常情况下 4 层几百毫秒就搜完了 */

  /* ---- 音效：用 WebAudio 现场合成，不依赖任何音频文件 ---- */
  var audioCtx = null;
  var soundOn = true;

  function audio() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { audioCtx = new AC(); } catch (e) { return null; }
    }
    if (audioCtx.state === 'suspended') {
      try { audioCtx.resume(); } catch (e) { /* 忽略 */ }
    }
    return audioCtx;
  }

  /* 带包络的音；freq 滑向 slideTo 会有一点"笔尖划过纸面"的味道 */
  function tone(freq, dur, type, vol, delay, slideTo) {
    var ctx = audio();
    if (!ctx) return;
    var t0 = ctx.currentTime + (delay || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'triangle';
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol || 0.18, t0 + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  function playSound(kind) {
    if (!soundOn) return;
    switch (kind) {
      case 'place':
        tone(560, 0.07, 'sine', 0.16, 0, 300);
        break;
      case 'threat':
        /* 对方下出四：和象棋里的"将军"是同一个位置，给同一种警示音 */
        tone(680, 0.1, 'square', 0.11);
        tone(920, 0.13, 'square', 0.11, 0.11);
        break;
      case 'win':
        [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.22, 'triangle', 0.15, i * 0.11); });
        break;
      case 'lose':
        [440, 370, 294, 220].forEach(function (f, i) { tone(f, 0.26, 'triangle', 0.14, i * 0.13); });
        break;
      case 'draw':
        [440, 440].forEach(function (f, i) { tone(f, 0.24, 'triangle', 0.13, i * 0.18); });
        break;
    }
  }

  /* ---- 设置持久化：记住棋力、执子、音效、翻转 ---- */
  var STORE_KEY = 'gomoku.settings.v1';

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (s.difficulty && DIFFICULTY[s.difficulty]) difficulty = s.difficulty;
      if (s.aiSide === 1 || s.aiSide === -1) aiSide = s.aiSide;
      if (typeof s.soundOn === 'boolean') soundOn = s.soundOn;
      if (typeof s.flipped === 'boolean') flipped = s.flipped;
    } catch (e) { /* 隐私模式或 file:// 下可能不可用，忽略即可 */ }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        difficulty: difficulty, aiSide: aiSide, soundOn: soundOn, flipped: flipped
      }));
    } catch (e) { /* 忽略 */ }
  }

  /* ---- 坐标换算 ---- */
  /* 翻转时只在这里做一次行列对调，其余代码仍按逻辑坐标思考 */
  function dispRC(m) {
    var r = (m / N) | 0, c = m % N;
    return flipped ? [N - 1 - r, N - 1 - c] : [r, c];
  }

  /* 格子中心在棋盘里的百分比位置，提示层用它定位 */
  function pctX(c) { return ((PAD + STEP * (c + 0.5)) / VB_W * 100) + '%'; }
  function pctY(r) { return ((PAD + STEP * (r + 0.5)) / VB_H * 100) + '%'; }

  /* 棋子的左上角位置：格子中心再减去半个棋子 */
  function translateFor(m) {
    var d = dispRC(m);
    var x = geo.pad + geo.cell * (d[1] + 0.5) - geo.size / 2;
    var y = geo.pad + geo.cell * (d[0] + 0.5) - geo.size / 2;
    return 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
  }

  /* ---- 绘制棋盘 ----
   * 井字棋的样子：一个方方正正的格网，外框略粗、内线很细，不画任何棋子位标记。
   * 外框和棋盘本身都带圆角。两个半径都按 viewBox 单位给，再由 layout() 按实际
   * 尺寸换算成像素，这样棋盘缩小时两层圆角始终同心，不会一个大一个小。
   */
  var FRAME_R = 18;      /* 外框圆角（viewBox 单位） */
  var BOARD_R = 48;      /* 棋盘本身的圆角（viewBox 单位） */

  function buildBoard() {
    var X0 = PAD, Y0 = PAD, X1 = PAD + STEP * N, Y1 = PAD + STEP * N;
    var p = [];

    for (var i = 1; i < N; i++) {
      var x = PAD + STEP * i;
      p.push('<line x1="' + x + '" y1="' + Y0 + '" x2="' + x + '" y2="' + Y1 + '"/>');
      p.push('<line x1="' + X0 + '" y1="' + x + '" x2="' + X1 + '" y2="' + x + '"/>');
    }
    p.push('<rect class="board-frame" x="' + X0 + '" y="' + Y0 +
      '" width="' + (X1 - X0) + '" height="' + (Y1 - Y0) + '" rx="' + FRAME_R + '"/>');

    svgEl.innerHTML = '<g class="grid">' + p.join('') + '</g>';
  }

  /* ---- 棋子元素 ----
   * 井字棋的棋子就是两笔叉和一个圈，用 SVG 画，缩放时不会糊。
   * pathLength="100" 把两条线的总长归一到 100，这样描边动画的
   * dasharray / dashoffset 对所有形状都是同一套数字。
   */
  function pieceSvg(side) {
    if (side === X) {
      return '<svg viewBox="0 0 100 100" aria-hidden="true">' +
        '<path class="stroke" pathLength="100" d="M23 23 L77 77 M77 23 L23 77"/></svg>';
    }
    return '<svg viewBox="0 0 100 100" aria-hidden="true">' +
      '<circle class="stroke" pathLength="100" cx="50" cy="50" r="28"/></svg>';
  }

  function createPieceEl(piece) {
    var el = document.createElement('div');
    el.className = 'piece ' + (piece > 0 ? 'x' : 'o') + ' enter';
    el.dataset.code = String(piece);
    el.innerHTML = pieceSvg(piece);
    return el;
  }

  function placeEl(el, m) {
    el.dataset.sq = String(m);
    el.style.transform = translateFor(m);
  }

  function clearPieces() {
    for (var i = 0; i < CELLS; i++) {
      if (pieceEls[i]) { pieceEls[i].remove(); pieceEls[i] = null; }
    }
    pieceLayer.innerHTML = '';
  }

  /*
   * 让 DOM 与 board 数组同步。
   * 五子棋的棋子落下去就不动了，所以这儿比象棋那版简单得多：
   * 对得上就留着，对不上就淡出，缺的补一个。
   */
  function syncPieces() {
    var keep = new Array(CELLS).fill(null);
    var orphans = [];
    var sq, el;

    for (sq = 0; sq < CELLS; sq++) {
      el = pieceEls[sq];
      if (!el) continue;
      var p = board[sq];
      if (p !== 0 && el.dataset.code === String(p)) keep[sq] = el;
      else orphans.push(el);
    }

    for (sq = 0; sq < CELLS; sq++) {
      var piece = board[sq];
      if (piece === 0 || keep[sq]) continue;
      keep[sq] = createPieceEl(piece);
      placeEl(keep[sq], sq);
      pieceLayer.appendChild(keep[sq]);
    }

    for (var i = 0; i < orphans.length; i++) {
      (function (dead) {
        dead.classList.add('captured');
        setTimeout(function () { dead.remove(); }, ANIM_MS + 60);
      })(orphans[i]);
    }

    pieceEls = keep;
  }

  /* ---- 提示层 ---- */
  function renderHints() {
    /* 首次 layout() 发生在 newGame() 之前，那时还没有局面可画 */
    if (!board) return;
    hintLayer.innerHTML = '';
    var frag = document.createDocumentFragment();

    function marker(m, cls) {
      var d = dispRC(m);
      var el = document.createElement('div');
      el.className = 'mark ' + cls;
      el.style.left = pctX(d[1]);
      el.style.top = pctY(d[0]);
      frag.appendChild(el);
      return el;
    }

    /* 五连的那几个格子：终局后一直亮着 */
    for (var w = 0; w < winLine.length; w++) marker(winLine[w], 'win');

    if (lastMove !== null) marker(lastMove, 'last');

    /*
     * 眼前的死活：自己有成五点就镶金边，对手有成五点就画红圈，
     * 相当于象棋里的"我可以将死"和"我被将军"。
     */
    if (!gameOver) {
    }

    /* 鼠标悬停时先给一个半透明的落子预览，点下去之前就知道会画在哪儿 */
    if (!gameOver && hoverCell >= 0 && board[hoverCell] === 0 && canIOperate()) {
      var g = marker(hoverCell, 'ghost ' + (turn === X ? 'x' : 'o'));
      g.innerHTML = pieceSvg(turn);
    }

    hintLayer.appendChild(frag);
  }

  /* ---- 着法列表 ---- */
  function moveCell(ply) {
    var h = history[ply];
    if (!h) return '<span class="m"></span>';
    var side = h.side === X ? 'x' : 'o';
    var badge = '';
    var b = moveBadge(moveLosses()[ply + 1]);
    if (b) {
      badge = '<i class="badge ' + b.cls + '" title="' + b.title + '">' + b.mark + '</i>';
    }
    return '<span class="m ' + side + '" title="' + (h.side === X ? 'X 方' : 'O 方') +
      '第 ' + (ply + 1) + ' 手">' + h.san + badge + '</span>';
  }

  function renderMoveList() {
    var html = '';
    for (var i = 0; i < history.length; i += 2) {
      html += '<div class="mv"><span class="no">' + (i / 2 + 1) + '.</span>' +
        moveCell(i) + moveCell(i + 1) + '</div>';
    }
    moveListEl.innerHTML = html || '<div class="mv empty">尚未落子</div>';
    moveListEl.scrollTop = moveListEl.scrollHeight;
  }

  /* 棋谱文本，用于复制/分享 */
  function gameRecord() {
    var out = [];
    for (var i = 0; i < history.length; i += 2) {
      var line = (i / 2 + 1) + '. ' + history[i].san;
      if (history[i + 1]) line += '  ' + history[i + 1].san;
      out.push(line);
    }
    var result = gameOver ? resultText : '（未结束）';
    return '五子棋对局记录（15×15，X 先行）\n' + out.join('\n') + '\n结果：' + result;
  }

  /* ---- 胜率换算 ---- */
  var MATE_SCORE = 30000;

  /*
   * 评分差 -> 胜率。logistic 换算，1000 分（大约一个"活三"的分量）到约 91%。
   * 未分胜负时夹在 2%~98%，避免出现"100% 必胜"这种过度自信的显示。
   */
  var WINRATE_K = 1000;

  function winRate(score) {
    if (score > MATE_SCORE - 1000) return 1;
    if (score < -MATE_SCORE + 1000) return 0;
    var p = 1 / (1 + Math.pow(10, -score / WINRATE_K));
    return Math.min(0.98, Math.max(0.02, p));
  }

  /* 把评分差写成两位小数的"优势值"。100 分大致相当于一条活二 */
  function formatScore(score) {
    if (score > MATE_SCORE - 1000) return '五连';
    if (score < -MATE_SCORE + 1000) return '被五连';
    var v = score / 100;
    return (v > 0 ? '+' : '') + v.toFixed(1);
  }

  /* 取最近一个已算出的评估。正常情况下就是当前步，积压时退而用上一个已知值 */
  function latestEval() {
    for (var k = Math.min(history.length, evals.length - 1); k >= 0; k--) {
      if (typeof evals[k] === 'number') return evals[k];
    }
    return null;
  }

  function renderEvalBar() {
    var cur = latestEval();
    if (cur === null) return;   /* 一个都还没算出来就先保持原样 */
    var pr = winRate(cur);
    var xPct = Math.round(pr * 100);
    evalFillEl.style.width = (pr * 100).toFixed(1) + '%';
    evalXTxtEl.textContent = xPct + '%';
    evalOTxtEl.textContent = (100 - xPct) + '%';
    evalScoreEl.textContent = formatScore(cur);
    evalScoreEl.className = 'eval-score ' + (cur > 60 ? 'x' : (cur < -60 ? 'o' : ''));
  }

  /*
   * 每一步的损失（该方视角，只取非负）。返回数组，索引 = 手序号，
   * 因为评估是异步来的，算不出的位置是 null。
   */
  function moveLosses() {
    var arr = new Array(history.length + 1);
    for (var k = 0; k <= history.length; k++) arr[k] = null;
    for (k = 1; k <= history.length; k++) {
      var before = evals[k - 1], after = evals[k];
      if (typeof before !== 'number' || typeof after !== 'number') continue;
      arr[k] = Math.max(0, (before - after) * history[k - 1].side);
    }
    return arr;
  }

  /*
   * 着法质量分级，阈值按五子棋的评分量级来定（一条活三大约 500 分，
   * 一个四大约 2200 分）。只标问题手，不标好棋：没有"引擎首选着法"作对照时，
   * 优势局面下几乎每步都"没损失"，标出来全是噪声。
   */
  function moveBadge(loss) {
    if (loss === null) return null;
    if (loss >= 1200) return { mark: '??', cls: 'blunder', title: '漏着' };
    if (loss >= 450) return { mark: '?', cls: 'mistake', title: '失误' };
    if (loss >= 150) return { mark: '?!', cls: 'inaccuracy', title: '疑问手' };
    return null;
  }

  /* ---- 评估曲线：把整盘的胜率变化画出来 ---- */
  function renderEvalGraph() {
    var cv = evalCanvasEl;
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;

    var dpr = window.devicePixelRatio || 1;
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }

    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var n = evals.length - 1;
    var maxPly = Math.max(24, n);          /* 太短时先按满格画，免得几步就撑满 */
    var xOf = function (k) { return (k / maxPly) * w; };
    var yOf = function (k) { return h - winRate(evals[k]) * h; };

    /* 已知的点：允许中间有空洞（评估被丢弃时），画成折线即可 */
    var pts = [];
    for (var k = 0; k <= n; k++) {
      if (typeof evals[k] === 'number') pts.push([xOf(k), yOf(k)]);
    }
    if (pts.length < 2) {
      ctx.fillStyle = 'rgba(28,28,30,.34)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('落几手后这里会显示胜率走势', w / 2, h / 2 + 3);
      return;
    }

    /* 曲线下方填 X 色，上方填 O 色。底色是浅灰，所以用低饱和的半透明填充 */
    function fillArea(color, fromBottom) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], fromBottom ? h : 0);
      for (var i = 0; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.lineTo(pts[pts.length - 1][0], fromBottom ? h : 0);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
    fillArea('rgba(229,72,77,.20)', true);
    fillArea('rgba(58,123,213,.16)', false);

    /* 中线 */
    ctx.strokeStyle = 'rgba(28,28,30,.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    /* 曲线 */
    var i;
    ctx.strokeStyle = 'rgba(28,28,30,.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();

    /* 失误点：一眼看出哪几步崩了 */
    var losses = moveLosses();
    for (k = 1; k <= n; k++) {
      if (losses[k] === null || losses[k] < 900) continue;
      ctx.beginPath();
      ctx.arc(xOf(k), yOf(k), 2.6, 0, Math.PI * 2);
      ctx.fillStyle = '#e5a50a';
      ctx.fill();
    }
  }

  /* ---- 终局评分 ----
   * 满分 100，由两部分构成：
   *   结果分 0~50：胜 50，和 25，负 0
   *   质量分 0~50：由平均每手损失(ACPL)换算，50 * exp(-ACPL / 400)
   * 每手损失 = 落子前局面对该方而言的价值 - 落子后的价值，只取非负部分。
   * 下出最优着法时损失约为 0，失误越大越高。
   * 除数 400 是按五子棋的评分量级标定的：一条活三约 500 分，
   * 也就是"随手放掉一条活三"大约扣掉质量分的 71%。
   */
  function scoreFor(side) {
    var sum = 0, n = 0, moves = 0;
    var blunder = 0, blunderPly = 0;

    for (var k = 1; k <= history.length; k++) {
      var h = history[k - 1];
      if (h.side !== side) continue;
      moves++;
      var before = evals[k - 1], after = evals[k];
      if (typeof before !== 'number' || typeof after !== 'number') continue;
      var loss = Math.max(0, (before - after) * side);
      sum += loss;
      n++;
      if (loss > blunder) { blunder = loss; blunderPly = k; }
    }

    var acpl = n ? sum / n : 0;
    var quality = Math.round(50 * Math.exp(-acpl / 400));
    quality = Math.max(0, Math.min(50, quality));
    var result = (winner === side) ? 50 : (winner === 0 && gameOver ? 25 : 0);
    var longest = board ? GM.longestRun(board, side) : 0;

    return {
      result: result,
      quality: quality,
      total: result + quality,
      grade: gradeOf(result + quality),
      acpl: acpl,
      blunder: blunder,
      blunderPly: blunderPly,
      longest: longest,
      moves: moves
    };
  }

  function gradeOf(total) {
    if (total >= 85) return 'S · 神级';
    if (total >= 70) return 'A · 优秀';
    if (total >= 55) return 'B · 良好';
    if (total >= 40) return 'C · 一般';
    return 'D · 待提高';
  }

  function renderScore() {
    if (!gameOver) { scoreGroup.hidden = true; scoreBodyEl.innerHTML = ''; return; }
    scoreGroup.hidden = false;

    /* 人机对战只给玩家打分；双人/联机两边都给 */
    var sides = (mode === 'pve') ? [-aiSide] : [X, O];
    var html = '<div class="score-result">' + resultText + '</div>';

    for (var i = 0; i < sides.length; i++) {
      var s = sides[i];
      var r = scoreFor(s);
      var label = (mode === 'pve') ? '你' : (s === X ? 'X 方' : 'O 方');
      html +=
        '<div class="score-card ' + (s === X ? 'x' : 'o') + '">' +
          '<div class="score-head">' +
            '<span class="score-side">' + label + '</span>' +
            '<span class="score-total">' + r.total + '<small>分</small></span>' +
          '</div>' +
          '<div class="score-grade">' + r.grade + '</div>' +
          '<div class="score-rows">' +
            '<div><span>结果分</span><b>' + r.result + ' / 50</b></div>' +
            '<div><span>质量分</span><b>' + r.quality + ' / 50</b></div>' +
            '<div><span>平均每手损失</span><b>' + Math.round(r.acpl) + '</b></div>' +
            '<div><span>最大失误</span><b>' + Math.round(r.blunder) +
              (r.blunderPly ? '（第 ' + r.blunderPly + ' 手）' : '') + '</b></div>' +
            '<div><span>最长连子</span><b>' + (r.longest ? r.longest + ' 连' : '—') + '</b></div>' +
          '</div>' +
        '</div>';
    }
    scoreBodyEl.innerHTML = html;
  }

  /* ================= 聊天 =================
   * 只有联机模式才有对话面板，人机和双人都不显示。
   */
  var chatLog = [];
  var CHAT_MAX = 120;
  var lastChatSentAt = 0;

  function renderChat() {
    var html = '';
    for (var i = 0; i < chatLog.length; i++) {
      var m = chatLog[i];
      if (m.who === 'sys') {
        html += '<div class="chat-sys"></div>';
      } else {
        html += '<div class="chat-msg ' + m.who + '"><div class="chat-bubble"></div></div>';
      }
    }
    chatListEl.innerHTML = html;

    /* 文本用 textContent 写，避免任何注入 */
    var nodes = chatListEl.children;
    for (i = 0; i < chatLog.length; i++) {
      var target = chatLog[i].who === 'sys' ? nodes[i] : nodes[i].firstChild;
      target.textContent = chatLog[i].text;
    }
    chatListEl.scrollTop = chatListEl.scrollHeight;
  }

  function addChat(who, text) {
    if (!text) return;
    text = String(text).slice(0, 200);
    chatLog.push({ who: who, text: text });
    if (chatLog.length > CHAT_MAX) chatLog.splice(0, chatLog.length - CHAT_MAX);
    renderChat();
  }

  function sendChat() {
    if (mode !== 'online') return;

    var text = chatInputEl.value.trim();
    if (!text) return;

    var now = Date.now();
    if (now - lastChatSentAt < 400) return;   /* 手滑连点就别重复发了 */
    lastChatSentAt = now;
    chatInputEl.value = '';

    if (!NET.isOpen()) {
      addChat('sys', '尚未连接，消息没有发出去');
      return;
    }
    if (NET.send({ t: 'chat', text: text })) addChat('me', text);
    else addChat('sys', '发送失败');
  }

  function updateChatVisibility() {
    chatGroup.hidden = (mode !== 'online');
  }

  function resetChat() {
    chatLog = [];
    renderChat();
  }

  /* ---- 状态栏 ---- */
  function sideName(s) {
    if (mode === 'pve') return s === aiSide ? '电脑' : '你';
    return s === X ? 'X 方' : 'O 方';
  }

  function updateStatus() {
    var cls = '';
    var text;

    if (gameOver) {
      text = resultText;
      cls = 'over';
    } else if (thinking) {
      text = '电脑思考中…';
      cls = 'think';
    } else if (mode === 'online') {
      if (!netSide) {
        text = netRoom
          ? '等待对方加入 · 房号 ' + netRoom
          : '未连接 · 请在右侧创建或加入房间';
      } else if (winNowPoints.length) {
        text = turn === netSide ? '你已成四，直接五连！' : '对方已成四，拦不住了…';
        cls = turn === netSide ? 'good' : 'alert';
      } else {
        text = (turn === netSide) ? '轮到你落子' : '等待对方落子';
        if (blockPoints.length) {
          text = '对方有四！' + (turn === netSide ? '轮到你，必须堵' : '');
          cls = 'alert';
        }
      }
    } else if (winNowPoints.length) {
      text = sideName(turn) + '已成四，这一步就能五连！';
      cls = 'good';
    } else if (blockPoints.length) {
      /* 对手下出了四：下一步就能成五，必须堵 */
      text = sideName(-turn) + '有四了！必须堵住否则下一手就五连';
      cls = 'alert';
    } else {
      text = '轮到' + sideName(turn) + '落子';
    }

    /* 人机模式下点明这一步轮到谁；死活提示里已经点了名，就不重复 */
    if (mode === 'pve' && !gameOver && !thinking && !cls) {
      text += turn === aiSide ? '（电脑）' : '（你）';
    }

    statusEl.textContent = text;
    statusEl.className = 'status-text ' + cls;
    turnDotEl.className = 'turn-dot ' + (gameOver ? 'over' : (turn === X ? 'x' : 'o'));

    /* 引擎信息：让电脑到底挖了多深看得见 */
    if (mode === 'pve' && lastAiInfo && !thinking) {
      engineInfoEl.hidden = false;
      engineInfoEl.textContent = lastAiInfo.book
        ? '电脑：开局库'
        : '电脑：深度 ' + lastAiInfo.depth +
          ' · ' + (lastAiInfo.nodes / 1000).toFixed(0) + 'k 结点' +
          ' · ' + (lastAiInfo.time / 1000).toFixed(1) + 's';
    } else {
      engineInfoEl.hidden = true;
    }

    undoBtn.disabled = thinking || history.length === 0 || mode === 'online';
  }

  /* ---- 落子 ---- */
  function applyMove(m, fromRemote) {
    var ply = history.length;
    var mover = turn;                     /* 走这一步的是谁，下面 turn 要翻转 */
    var san = NOT.toCoord(m);

    if (mode === 'online' && !fromRemote) {
      NET.send({ t: 'move', ply: ply, m: m });
    }

    GM.place(board, m, mover);
    history.push({ move: m, side: mover, san: san });

    lastMove = m;
    turn = -turn;
    refreshMoves();

    /* 连成五直接终局 */
    if (GM.wins(board, m)) {
      gameOver = true;
      winner = mover;
      winLine = GM.winningLine(board, m) || [];
      resultText = sideName(mover) + '五连获胜 · 第 ' + history.length + ' 手';
      evals[history.length] = mover === X ? MATE_SCORE : -MATE_SCORE;
    }

    /* 这一手有没有做出四（对手下一步就输），用来决定放哪种音效 */
    var madeFour = !gameOver && GM.winPoints(board, mover).length > 0;

    checkGameEnd();
    refreshThreats();
    syncPieces();
    /*
     * 先把对局流程推进下去（含触发电脑落子），再做其余绘制。
     * 否则绘制里任何一处抛异常，都会让对局停在"轮到电脑"却永远不动。
     */
    if (mode === 'pve') maybeAIMove();
    renderHints();
    renderMoveList();
    updateStatus();
    renderScore();
    renderEvalGraph();
    /* 终局后胜负已定，再评估没有意义还会覆盖掉终局分 */
    if (!gameOver) requestEval();

    if (gameOver) {
      if (winner === 0) playSound('draw');
      else if (mode === 'pvp') playSound('win');
      else playSound(winner === humanSide() ? 'win' : 'lose');
    } else if (madeFour) {
      playSound('threat');
    } else {
      playSound('place');
    }
  }

  /* 人机/联机模式下"玩家"执哪边；双人两边都是人，返回 0 */
  function humanSide() {
    if (mode === 'pve') return -aiSide;
    if (mode === 'online') return netSide;
    return 0;
  }

  function refreshMoves() {
    playableMoves = GM.genMoves(board, []);
  }

  /*
   * 重新算一遍"轮走这一方"眼前的死活：
   *   winNowPoints —— 自己已经有四，这一步就能成五
   *   blockPoints  —— 对手已经有四，这一步必须堵（自己没杀时才提示堵）
   * 两者互斥，因为有杀先杀。
   */
  function refreshThreats() {
    if (gameOver || !board) {
      blockPoints = [];
      winNowPoints = [];
      return;
    }
    winNowPoints = GM.winPoints(board, turn);
    blockPoints = winNowPoints.length ? [] : GM.winPoints(board, -turn);
  }

  function checkGameEnd() {
    if (gameOver) return true;
    if (!GM.isFull(board)) return false;

    gameOver = true;
    winner = 0;                       /* 和棋 */
    resultText = '平局 · 棋盘下满，谁都没连成五';
    evals[history.length] = 0;
    return true;
  }

  /* ---- AI 执行：优先放 Worker，起不来就退回主线程 ---- */
  var engineWorker = null;
  var workerSeq = 0;
  var workerPending = {};

  /*
   * file:// 下既不能 importScripts 本地脚本也不能 fetch 源码，
   * 所以把两个工厂函数的源码 toString() 出来拼成一个 Blob 当 Worker 用。
   */
  function buildWorkerSource() {
    return [
      GomokuRules.toString(),
      GomokuAIEngine.toString(),
      'GomokuRules(self);',
      'GomokuAIEngine(self);',
      'self.onmessage = function (e) {',
      '  var d = e.data;',
      '  /* kind="eval" 只是要一个局面评分：谁走下一步就以谁的视角搜，主线程再折算回 X 视角 */',
      '  if (d.kind === "eval") {',
      '    self.GomokuAI.search(d.board, d.side, d.depth, d.time, 0);',
      '    self.postMessage({ id: d.id, info: self.GomokuAI.lastInfo() });',
      '    return;',
      '  }',
      '  var m = self.GomokuAI.search(d.board, d.side, d.depth, d.time, d.margin);',
      '  self.postMessage({ id: d.id, move: m, info: self.GomokuAI.lastInfo() });',
      '};'
    ].join('\n');
  }

  function runOnMainThread(req, cb) {
    cb(AI.search(req.board, req.side, req.depth, req.time, req.margin), AI.lastInfo());
  }

  function initEngineWorker() {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' ||
        typeof URL === 'undefined' || !URL.createObjectURL) return null;
    try {
      var url = URL.createObjectURL(new Blob([buildWorkerSource()], { type: 'application/javascript' }));
      var w = new Worker(url);
      w.onmessage = function (e) {
        var job = workerPending[e.data.id];
        if (!job) return;
        delete workerPending[e.data.id];
        clearTimeout(job.timer);
        job.cb(e.data.move, e.data.info);
      };
      w.onerror = function () {
        /* Worker 挂了就把在等的活儿全部转回主线程，别让对局卡死 */
        var pending = workerPending;
        workerPending = {};
        engineWorker = null;
        Object.keys(pending).forEach(function (id) {
          clearTimeout(pending[id].timer);
          pending[id].fallback();
        });
      };
      return w;
    } catch (err) {
      return null;
    }
  }

  /* 往 Worker 投一个任务；Worker 不可用或超时就交给 fallback */
  function postJob(msg, cb, fallback) {
    if (!engineWorker) { fallback(); return; }
    var id = ++workerSeq;
    var timer = setTimeout(function () {
      if (!workerPending[id]) return;
      delete workerPending[id];
      engineWorker = null;
      fallback();
    }, msg.time + 5000);
    workerPending[id] = { cb: cb, timer: timer, fallback: fallback };
    msg.id = id;
    engineWorker.postMessage(msg);
  }

  /* 按给定参数搜索"当前走子方"的最佳着法 */
  function requestSearch(cfg, cb) {
    var req = {
      board: Int8Array.from(board),
      side: turn,
      depth: cfg.depth,
      time: cfg.time,
      margin: cfg.margin || 0
    };
    postJob(
      { board: req.board, side: req.side, depth: req.depth, time: req.time, margin: req.margin },
      cb,
      function () { runOnMainThread(req, cb); }
    );
  }

  function requestMove(cb) {
    requestSearch(DIFFICULTY[difficulty], cb);
  }

  /* 认输（联机模式有独立按钮，走网络同步） */
  function resign() {
    if (gameOver || mode === 'online') return;
    gameOver = true;
    if (mode === 'pve') {
      winner = aiSide;
      resultText = '你认输了 · 电脑胜';
    } else {
      winner = -turn;
      resultText = sideName(turn) + '认输 · ' + sideName(-turn) + '胜';
    }
    refreshThreats();
    renderHints();
    updateStatus();
    renderScore();
    playSound('lose');
  }

  /*
   * 落完一手就评估一次当前局面，用于胜率条和终局评分。
   * 评估固定用 EVAL_DEPTH 层搜索（比分差稳定），跑在 Worker 里不占主线程。
   * 注意以"下一步该谁走"的视角去搜、再折算回 X 视角：
   * 五子棋里先手权很值钱，固定让 X 先搜会让胜率条出现锯齿。
   */
  function requestEval() {
    if (!board) return;
    var ply = history.length;
    var gen = evalGen;
    var side = turn;

    /*
     * 评估是"每手一个"的，正常对局节奏下 Worker 完全跟得上。
     * 但如果有人狂点（或脚本连走），队列会堆到几十个，
     * 这时就主动丢中间的，宁可评分少几个采样点，也不让胜率条一直显示旧值。
     */
    if (evalInFlight > 3 && ply > 1) return;
    evalInFlight++;

    var snapshot = Int8Array.from(board);

    postJob(
      { kind: 'eval', board: snapshot, side: side, depth: EVAL_DEPTH, time: EVAL_TIME },
      function (move, info) { onEval(gen, ply, info && info.score, side); },
      function () { onEval(gen, ply, AI.evaluate(snapshot, side), side); }
    );
  }

  function onEval(gen, ply, score, side) {
    evalInFlight = Math.max(0, evalInFlight - 1);
    /* 悔棋/重开之后才回来的旧结果直接丢掉，别污染新对局 */
    if (gen !== evalGen) return;
    if (typeof score !== 'number' || !isFinite(score)) return;
    evals[ply] = side === X ? score : -score;   /* 统一存成 X 视角 */
    renderEvalBar();
    renderEvalGraph();
    renderMoveList();         /* 失误标记要等评估回来才知道，得重画一遍 */
    renderScore();            /* 终局评分依赖最后一手之后的评估，算完要补画一次 */
  }

  function maybeAIMove() {
    if (mode !== 'pve' || gameOver || turn !== aiSide) return;
    thinking = true;
    updateStatus();
    /* 先让人的着法画出来，再让电脑"开始想" */
    setTimeout(runAI, ANIM_MS);
  }

  function runAI() {
    if (gameOver || turn !== aiSide) { thinking = false; updateStatus(); return; }

    /* 开局阶段先查库：下得更像人，也不会每盘都走成同一个样子 */
    if (difficulty !== 'easy') {
      var played = history.map(function (h) { return h.move; });
      var bm = AI.bookMove(played, playableMoves);
      if (bm >= 0) {
        thinking = false;
        lastAiInfo = { book: true };
        applyMove(bm);
        return;
      }
    }

    requestMove(function (m, info) {
      thinking = false;
      if (gameOver) { updateStatus(); return; }
      if (m === null || m === undefined || m < 0) {
        /* 无处可下 = 棋盘满了 */
        refreshMoves();
        checkGameEnd();
        updateStatus();
        return;
      }
      lastAiInfo = info;
      applyMove(m);
    });
  }

  /* ---- 交互 ---- */
  function canIOperate() {
    if (gameOver || thinking) return false;
    if (mode === 'pve' && turn === aiSide) return false;
    if (mode === 'online' && turn !== netSide) return false;
    return true;
  }

  /* 点格子就是落子。五子棋没有"先选中再走"，下在格子里，一下就是一手 */
  function onCellClick(m) {
    if (!canIOperate()) return;
    if (m < 0 || m >= CELLS) return;
    if (board[m] !== 0) return;
    hoverCell = -1;
    applyMove(m);
  }

  function cellFromEvent(ev) {
    var rect = boardEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;
    var px = (ev.clientX - rect.left) / rect.width * VB_W;
    var py = (ev.clientY - rect.top) / rect.height * VB_H;
    var c = Math.floor((px - PAD) / STEP);
    var r = Math.floor((py - PAD) / STEP);
    if (r < 0 || r >= N || c < 0 || c >= N) return -1;
    /* 显示坐标反算回逻辑坐标 */
    if (flipped) { r = N - 1 - r; c = N - 1 - c; }
    return r * N + c;
  }

  /* ---- 尺寸自适应 ---- */
  var NARROW_QUERY = '(max-width: 860px)';
  var narrowQuery = window.matchMedia(NARROW_QUERY);

  function layout() {
    document.documentElement.classList.toggle('is-narrow', narrowQuery.matches);

    var aw = boardWrap.clientWidth;
    var ah = boardWrap.clientHeight;
    if (!aw || !ah) return;

    var w = Math.min(aw, ah);      /* 正方形棋盘，取短边 */
    w = Math.floor(w);
    boardEl.style.width = w + 'px';
    boardEl.style.height = w + 'px';

    var scale = w / VB_W;
    geo.cell = STEP * scale;
    geo.pad = PAD * scale;
    geo.size = geo.cell * 0.82;
    boardEl.style.setProperty('--piece', geo.size.toFixed(2) + 'px');
    boardEl.style.setProperty('--cs', geo.cell.toFixed(2) + 'px');
    /* 圆角和 SVG 里的外框圆角同步缩放，两层才对得齐 */
    boardEl.style.borderRadius = (BOARD_R * scale).toFixed(1) + 'px';

    /* 重排时先关掉过渡再摆位，否则棋子会从旧位置飞过来 */
    pieceLayer.classList.add('no-anim');
    for (var m = 0; m < CELLS; m++) {
      if (pieceEls[m]) pieceEls[m].style.transform = translateFor(m);
    }
    void boardEl.offsetHeight;
    pieceLayer.classList.remove('no-anim');
    renderHints();
  }

  /* ---- 悔棋 ---- */
  function undoOne() {
    var h = history.pop();
    if (!h) return false;
    GM.remove(board, h.move);
    turn = h.side;
    return true;
  }

  function undo() {
    if (thinking || history.length === 0 || mode === 'online') return;
    gameOver = false;
    resultText = '';
    winLine = [];
    undoOne();
    if (mode === 'pve' && turn === aiSide && history.length > 0) undoOne();

    lastMove = history.length ? history[history.length - 1].move : null;
    winner = 0;
    refreshMoves();
    refreshThreats();

    evalGen++;
    evals.length = history.length + 1;   /* 丢掉被悔掉的那些手的评估 */
    /*
     * 只调 syncPieces 就够了：对不上的棋子会淡出，缺的会补上。
     * 不要先 clearPieces——那会把整盘棋子重建一遍，全都重放一次落子动画。
     */
    syncPieces();
    renderHints();
    renderMoveList();
    updateStatus();
    renderScore();
    renderEvalBar();
    renderEvalGraph();
    requestEval();

    if (mode === 'pve' && turn === aiSide && !gameOver) maybeAIMove();
  }

  /* ---- 开局 ---- */
  function newGame() {
    board = GM.createBoard();
    turn = X;                     /* 井字棋的规矩：X 先手 */
    history = [];
    gameOver = false;
    resultText = '';
    lastMove = null;
    thinking = false;
    lastAiInfo = null;
    winner = 0;
    hoverCell = -1;
    winLine = [];
    refreshMoves();
    refreshThreats();

    evalGen++;
    evalInFlight = 0;
    evals = [];
    resetChat();
    updateChatVisibility();
    clearPieces();
    syncPieces();
    renderHints();
    renderMoveList();
    updateStatus();
    renderScore();
    renderEvalBar();
    renderEvalGraph();
    requestEval();

    maybeAIMove();
  }

  /* ================= 联机 ================= */

  function setNetStatus(text, cls) {
    var el = document.getElementById('onlineStatus');
    el.textContent = text || '';
    el.className = 'online-status ' + (cls || '');
  }

  function copyText(text, btn, okMsg) {
    if (btn) flashButton(btn, '已复制');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        setNetStatus(okMsg, 'ok');
      }, function () {
        setNetStatus('复制失败，请手动选中复制', 'err');
      });
      return;
    }
    setNetStatus('这个浏览器不支持自动复制，请手动选中', 'err');
  }

  function showOnlineStep(which) {
    document.getElementById('onlineIntro').hidden = which !== 'intro';
    document.getElementById('onlineHostFlow').hidden = which !== 'host';
    document.getElementById('onlineGuestFlow').hidden = which !== 'guest';
  }

  function startOnlineGame(side) {
    netSide = side;
    netGroup.hidden = false;
    onlineGroup.hidden = true;
    document.getElementById('netSideLabel').textContent =
      '你执' + (side === X ? 'X（先手）' : 'O（后手）');
    newGame();
    addChat('sys', '已连接，开始对局');
  }

  function setupOnline() {
    var roomCodeEl = document.getElementById('roomCode');
    var roomInputEl = document.getElementById('roomInput');

    document.getElementById('hostBtn').addEventListener('click', function () {
      netRole = 'host';
      showOnlineStep('host');
      roomCodeEl.textContent = '·····';
      setNetStatus('正在连接中转服务器…', 'busy');
      NET.host().then(function (code) {
        roomCodeEl.textContent = code;
        netRoom = code;
        updateStatus();
        setNetStatus('房号已生成，等对方输入后会自动接上。', 'ok');
      }).catch(function (e) {
        setNetStatus('创建失败：' + e.message, 'err');
      });
    });

    document.getElementById('copyRoomBtn').addEventListener('click', function () {
      var code = roomCodeEl.textContent.trim();
      if (!/^[0-9A-Z]{5}$/.test(code)) { setNetStatus('还没有房号', 'err'); return; }
      copyText(code, this, '已复制');
    });

    document.getElementById('joinBtn').addEventListener('click', function () {
      netRole = 'guest';
      showOnlineStep('guest');
      setNetStatus('输入 5 位房号后点「连接」。');
      setTimeout(function () { roomInputEl.focus(); }, 60);
    });

    /* 只保留合法字符并大写，省得用户输入全角或小写 */
    roomInputEl.addEventListener('input', function () {
      var v = NET.normalizeCode(roomInputEl.value);
      if (v !== roomInputEl.value) roomInputEl.value = v;
    });
    roomInputEl.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); doJoin(); }
    });

    function doJoin() {
      var code = NET.normalizeCode(roomInputEl.value);
      roomInputEl.value = code;
      if (code.length !== 5) { setNetStatus('房号是 5 位，请检查一下', 'err'); return; }
      setNetStatus('正在连接…', 'busy');
      NET.join(code).then(function () {
        setNetStatus('已应答，正在建立直连…', 'busy');
      }).catch(function (e) {
        setNetStatus('加入失败：' + e.message, 'err');
      });
    }
    document.getElementById('joinRoomBtn').addEventListener('click', doJoin);

    document.getElementById('netResignBtn').addEventListener('click', function () {
      if (gameOver) return;
      NET.send({ t: 'resign' });
      gameOver = true;
      winner = -netSide;
      resultText = '你认输了 · ' + (netSide === X ? 'O' : 'X') + ' 方胜';
      refreshThreats();
      renderHints();
      updateStatus();
      renderScore();
      playSound('lose');
    });

    document.getElementById('rematchBtn').addEventListener('click', function () {
      NET.send({ t: 'rematch' });
      startOnlineGame(-netSide);
    });

    NET.on('open', function () {
      setNetStatus('已连接，对局开始。', 'ok');
      /* 房主执 X 先手，加入方执 O */
      startOnlineGame(netRole === 'guest' ? O : X);
    });

    NET.on('close', function (reason) {
      if (mode !== 'online') return;
      addChat('sys', '连接已断开：' + reason);
      setNetStatus('连接中断：' + reason, 'err');
      netGroup.hidden = true;
      onlineGroup.hidden = false;
      showOnlineStep('intro');
      netSide = 0;
      netRoom = '';
    });

    NET.on('message', function (msg) {
      if (!msg || !msg.t) return;
      if (msg.t === 'move') {
        if (gameOver) return;
        if (msg.ply !== history.length) {
          setNetStatus('手数对不上，双方局面可能已经不一致', 'err');
          return;
        }
        if (turn === netSide) return;
        /* 用本地规则再验一遍，防止对方乱发或数据损坏 */
        if (playableMoves.indexOf(msg.m) < 0) {
          setNetStatus('收到一个不可能的着法，已忽略', 'err');
          return;
        }
        applyMove(msg.m, true);
      } else if (msg.t === 'chat') {
        addChat('them', msg.text);
      } else if (msg.t === 'resign') {
        gameOver = true;
        winner = netSide;
        resultText = '对方认输 · 你赢了';
        refreshThreats();
        renderHints();
        updateStatus();
        renderScore();
      } else if (msg.t === 'rematch') {
        startOnlineGame(-netSide);
      }
    });
  }

  /* 按钮上短暂显示一句反馈，避免额外弹窗 */
  function flashButton(btn, text) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = text;
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(function () {
      btn.textContent = btn.dataset.label;
    }, 1400);
  }

  /* ---- 控件绑定 ---- */
  function bindControls() {
    document.querySelectorAll('.mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (thinking) return;
        mode = btn.dataset.mode;
        document.querySelectorAll('.mode-btn').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        pveGroup.hidden = (mode !== 'pve');
        sideGroup.hidden = (mode !== 'pve');
        onlineGroup.hidden = (mode !== 'online');
        netGroup.hidden = true;

        if (mode === 'online') {
          NET.close();
          netSide = 0;
          netRoom = '';
          showOnlineStep('intro');
          setNetStatus('创建房间后把房号发给朋友；或输入朋友的房号加入。');
        }
        /* 换模式等于换了个对手，旧的对话记录不该留着 */
        resetChat();
        updateChatVisibility();
        newGame();
      });
    });

    /* 三档难度按钮 */
    var diffBtns = document.querySelectorAll('[data-diff]');
    diffBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (thinking) return;
        difficulty = btn.dataset.diff;
        diffBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
        saveSettings();
      });
    });

    document.querySelectorAll('#sideSeg button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (thinking) return;
        aiSide = -Number(btn.dataset.side);
        document.querySelectorAll('#sideSeg button').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        saveSettings();
        newGame();
      });
    });

    document.getElementById('flipBtn').addEventListener('click', function () {
      flipped = !flipped;
      this.classList.toggle('on', flipped);
      buildBoard();
      layout();
      renderHints();
      saveSettings();
    });

    document.getElementById('soundBtn').addEventListener('click', function () {
      soundOn = !soundOn;
      this.classList.toggle('on', soundOn);
      this.textContent = soundOn ? '音效 开' : '音效 关';
      if (soundOn) playSound('place');
      saveSettings();
    });

    document.getElementById('resignBtn').addEventListener('click', resign);

    document.getElementById('chatSend').addEventListener('click', sendChat);
    chatInputEl.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); sendChat(); }
    });

    document.getElementById('copyRecordBtn').addEventListener('click', function () {
      if (!history.length) { flashButton(this, '还没落子'); return; }
      var text = gameRecord();
      var self = this;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          flashButton(self, '已复制');
        }, function () { flashButton(self, '复制失败'); });
      } else {
        flashButton(this, '复制失败');
      }
    });

    undoBtn.addEventListener('click', undo);
    document.getElementById('restartBtn').addEventListener('click', function () {
      if (thinking) return;
      if (mode === 'online') {
        if (!NET.isOpen()) { setNetStatus('还没有连接', 'err'); return; }
        NET.send({ t: 'rematch' });
        startOnlineGame(-netSide);
        return;
      }
      newGame();
    });

    boardEl.addEventListener('click', function (ev) {
      var m = cellFromEvent(ev);
      if (m >= 0) onCellClick(m);
    });

    /* 悬停时给一个半透明的落子预览。只在格子变了才重画，免得跟着鼠标狂刷 */
    boardEl.addEventListener('mousemove', function (ev) {
      var m = cellFromEvent(ev);
      if (m === hoverCell) return;
      hoverCell = m;
      renderHints();
    });
    boardEl.addEventListener('mouseleave', function () {
      if (hoverCell < 0) return;
      hoverCell = -1;
      renderHints();
    });

    /* 快捷键。在输入框里打字时不拦截 */
    document.addEventListener('keydown', function (ev) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      var tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      switch (ev.key.toLowerCase()) {
        case 'u':
          if (!undoBtn.disabled) { undo(); ev.preventDefault(); }
          break;
        case 'f':
          document.getElementById('flipBtn').click(); ev.preventDefault();
          break;
        case 'n':
          if (!thinking) { document.getElementById('restartBtn').click(); ev.preventDefault(); }
          break;
        case 'escape':
          hoverCell = -1; renderHints();
          break;
      }
    });

    setupOnline();

    window.addEventListener('resize', layout);
    if (narrowQuery.addEventListener) narrowQuery.addEventListener('change', layout);
    if (window.ResizeObserver) new ResizeObserver(layout).observe(boardWrap);
  }

  /* ---- 启动 ---- */
  mode = 'pve';
  aiSide = O;              /* 默认玩家执 X 先手 */
  difficulty = 'normal';
  loadSettings();

  engineWorker = initEngineWorker();

  buildBoard();
  bindControls();
  syncSettingsUI();
  layout();
  newGame();

  /* 面板宽度变化会影响曲线图的画布尺寸 */
  window.addEventListener('resize', function () { renderEvalGraph(); });

  function syncSettingsUI() {
    document.querySelectorAll('[data-diff]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.diff === difficulty);
    });
    document.querySelectorAll('#sideSeg button').forEach(function (b) {
      b.classList.toggle('active', Number(b.dataset.side) === -aiSide);
    });
    document.getElementById('flipBtn').classList.toggle('on', flipped);
    document.getElementById('soundBtn').classList.toggle('on', soundOn);
    document.getElementById('soundBtn').textContent = soundOn ? '音效 开' : '音效 关';
  }
})();
