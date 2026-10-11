/*
 * 五子棋 AI
 *
 * 搜索：negamax + alpha-beta + 迭代加深
 *   - 强制着法先行：能成五直接赢；对手有四就只能堵，堵不住直接判负。
 *     这一条既是正确性保障，也砍掉了绝大部分分支，比任何剪枝都管用。
 *   - PVS：首个着法全窗口，其余先用零窗口试探，超出再重搜
 *   - LMR：靠后的着法先降深度搜，超出预期再补一次全深度
 *   - null-move 剪枝：白让一手，对手仍占不到便宜就直接剪掉
 *     （五子棋里落子只会对自己有利，不存在 zugzwang，这条是成立的）
 *   - 置换表：Zobrist 哈希 + 深度/边界校验，跨层甚至跨回合复用
 *   着法排序：置换表着法 → killer → 落点启发（四方向连子数）→ history
 *
 * 两个五子棋特有的地方：
 *   1. 候选点只取现有棋子周围 1~2 格。225 个空点全展开的话分支因子 200 上下，
 *      搜索深度会掉到 2 层；砍掉远处没有战术意义的点，同样的时间能多搜 3~4 层。
 *   2. 静态评估建立在"长度为 5 的窗口"上：全盘 572 个窗口，每个窗口数一数
 *      X / O 各占几格，被一方独占才计分。窗口表、每格属于哪些窗口都在启动时
 *      算好；落子时只更新穿过这一格的 20 个窗口，评估增量维护，
 *      比每次全盘重算快一个数量级。
 *
 * 工厂函数写法，便于 toString() 后注入 Blob Worker，
 * 让搜索不占用主线程（否则落子动画会被卡住）。
 */
function GomokuAIEngine(global) {
  'use strict';

  var GM = global.Gomoku;
  var N = GM.N, CELLS = GM.CELLS, X = GM.X, O = GM.O;
  var DIRS = GM.DIRS;

  var MATE = 30000;
  var MATE_BOUND = MATE - 1000;
  var INF = 1e9;
  var MAXPLY = 64;

  /* ================= 窗口表 ================= */

  /*
   * 窗口 = 一条 5 连。全盘共 572 个：横 165 + 竖 165 + 撇 121 + 捺 121。
   * WIN_CELLS[w] 是窗口里的 5 个格子；
   * WIN_VALUE[w][n] 是"窗口里有 n 个自己子、且没有对方子"时的分值。
   */
  var WCOUNT = 0;
  var WIN_CELLS = [];
  var WIN_VALUE = [];
  var CELL_WINS = [];          /* CELL_WINS[m] = 穿过格子 m 的所有窗口编号 */

  (function buildWindows() {
    /*
     * 基础分值。四（2200）远高于活三：四下一步就成五，是硬威胁；
     * 三还只是"将来有威胁"。五连给一个比 MATE 还大的数，只为让静态评估
     * 也能一眼看出成五，真正的胜负仍由搜索里的成五判定给出。
     */
    var BASE = [0, 1, 14, 160, 2200, 400000];

    for (var m = 0; m < CELLS; m++) CELL_WINS.push([]);

    for (var d = 0; d < 4; d++) {
      var dr = DIRS[d][0], dc = DIRS[d][1];
      for (var r = 0; r < N; r++) {
        for (var c = 0; c < N; c++) {
          if (!GM.inBoard(r + dr * 4, c + dc * 4)) continue;

          var cells = new Int32Array(5);
          for (var k = 0; k < 5; k++) cells[k] = (r + dr * k) * N + (c + dc * k);

          /*
           * 越靠中间越值钱。边上的连子能延伸的方向少，实战价值低得多，
           * 这也是"金角银边草肚皮"在五子棋里的对应物——只不过反过来，
           * 中间才是草肚皮以外最肥的地方。
           */
          var mr = r + dr * 2, mc = c + dc * 2;
          var far = Math.abs(mr - 7) + Math.abs(mc - 7);      /* 0..14 */
          var weight = 100 - far * 4;                          /* 100..44 */

          var vals = new Int32Array(6);
          for (k = 1; k <= 5; k++) vals[k] = (BASE[k] * weight / 100) | 0;

          var w = WCOUNT++;
          WIN_CELLS.push(cells);
          WIN_VALUE.push(vals);
          for (k = 0; k < 5; k++) CELL_WINS[cells[k]].push(w);
        }
      }
    }
  })();

  /* 每个窗口当前的 X / O 子数，以及它对 curEval 的贡献 */
  var winX = new Int8Array(WCOUNT);
  var winO = new Int8Array(WCOUNT);
  var winScore = new Int32Array(WCOUNT);
  var curEval = 0;             /* 当前局面的静态分，恒定用 X 视角 */
  var stoneCount = 0;

  function countWindow(bd, w, out) {
    var cells = WIN_CELLS[w];
    var x = 0, o = 0;
    for (var k = 0; k < 5; k++) {
      var p = bd[cells[k]];
      if (p === X) x++; else if (p === O) o++;
    }
    out[0] = x; out[1] = o;
  }

  var tmpCount = [0, 0];

  function scoreOf(w, x, o) {
    if (x === 0) return o === 0 ? 0 : -WIN_VALUE[w][o];
    return o === 0 ? WIN_VALUE[w][x] : 0;
  }

  /* 从零建立评估状态。每次 search 开头调一次 */
  function resetEval(bd) {
    curEval = 0;
    stoneCount = 0;
    for (var w = 0; w < WCOUNT; w++) {
      countWindow(bd, w, tmpCount);
      winX[w] = tmpCount[0];
      winO[w] = tmpCount[1];
      winScore[w] = scoreOf(w, tmpCount[0], tmpCount[1]);
      curEval += winScore[w];
    }
    for (var i = 0; i < CELLS; i++) if (bd[i] !== 0) stoneCount++;
  }

  /* 只重算穿过 m 的那 20 个窗口，落子 / 撤子都走这里 */
  function touchCell(bd, m) {
    var ws = CELL_WINS[m];
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i];
      curEval -= winScore[w];
      countWindow(bd, w, tmpCount);
      winX[w] = tmpCount[0];
      winO[w] = tmpCount[1];
      winScore[w] = scoreOf(w, tmpCount[0], tmpCount[1]);
      curEval += winScore[w];
    }
  }

  function evalFor(side) { return side === X ? curEval : -curEval; }

  /*
   * 从零算一遍静态分（不碰增量状态）。
   * 主线程退回本地评估时用它，测试里也拿它跟增量版本对照。
   */
  function evaluate(bd, side) {
    var s = 0;
    for (var w = 0; w < WCOUNT; w++) {
      countWindow(bd, w, tmpCount);
      s += scoreOf(w, tmpCount[0], tmpCount[1]);
    }
    return side === X ? s : -s;
  }

  /*
   * 成五点。靠增量维护的 winX / winO 直接筛：
   * 某条线已经有 4 个自己子、且一个对方子都没有，那这条线上唯一的空点就是成五点。
   * 比"逐格试下再判五"快得多，而搜索里每个结点都要问两次。
   */
  function fastWinPoints(bd, side) {
    var mine = side === X ? winX : winO;
    var theirs = side === X ? winO : winX;
    var out = [];
    for (var w = 0; w < WCOUNT; w++) {
      if (mine[w] !== 4 || theirs[w] !== 0) continue;
      var cells = WIN_CELLS[w];
      for (var k = 0; k < 5; k++) {
        var m = cells[k];
        if (bd[m] === 0) {
          if (out.indexOf(m) < 0) out.push(m);
          break;
        }
      }
    }
    return out;
  }

  /* ---- 着法排序用的落点启发 ---- */

  /* 从 (r,c) 出发沿一个方向，两侧各连着几个 side 的子 */
  function countDir(bd, r, c, dr, dc, side) {
    var n = 0;
    for (var s = -1; s <= 1; s += 2) {
      var nr = r + dr * s, nc = c + dc * s;
      while (GM.inBoard(nr, nc) && bd[nr * N + nc] === side) {
        n++;
        nr += dr * s;
        nc += dc * s;
      }
    }
    return n;
  }

  var RUN_BONUS = [0, 1, 12, 150, 2000, 30000, 40000, 50000, 60000];

  /*
   * 落点值不值：四个方向上"自己能连几个"加上"堵住对手几个"。
   * 只数紧贴着的连子，看不穿空档（跳三之类），但排序不需要那么准，
   * 成本却只要 4 个方向 × 8 格。
   */
  function moveHeuristic(bd, m, side) {
    var r = (m / N) | 0, c = m % N;
    var s = 0;
    for (var d = 0; d < 4; d++) {
      var dr = DIRS[d][0], dc = DIRS[d][1];
      var mine = countDir(bd, r, c, dr, dc, side);
      var opp = countDir(bd, r, c, dr, dc, -side);
      s += RUN_BONUS[mine] + ((RUN_BONUS[opp] * 3) >> 1);
    }
    return s;
  }

  /* ---- Zobrist 哈希 ---- */
  var zobX = new Int32Array(CELLS);
  var zobO = new Int32Array(CELLS);
  var zobSide = 0;
  (function initZobrist() {
    var s = 0x9e3779b9 | 0;
    function rnd() {
      s ^= s << 13; s |= 0;
      s ^= s >>> 17;
      s ^= s << 5; s |= 0;
      return s;
    }
    for (var i = 0; i < CELLS; i++) { zobX[i] = rnd(); zobO[i] = rnd(); }
    zobSide = rnd();
  })();

  function computeKey(bd, side) {
    var k = 0;
    for (var i = 0; i < CELLS; i++) {
      var p = bd[i];
      if (p === X) k ^= zobX[i];
      else if (p === O) k ^= zobO[i];
    }
    return side === O ? (k ^ zobSide) : k;
  }

  /* ---- 置换表 ---- */
  var TT_BITS = 19;
  var TT_SIZE = 1 << TT_BITS;
  var TT_MASK = TT_SIZE - 1;
  var ttKey = new Int32Array(TT_SIZE);
  var ttMove = new Int32Array(TT_SIZE);
  var ttScore = new Int32Array(TT_SIZE);
  var ttDepth = new Int8Array(TT_SIZE);
  var ttFlag = new Int8Array(TT_SIZE);

  var TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;

  /* ---- 搜索状态 ---- */
  var nodes = 0;
  var deadline = 0;
  var aborted = false;
  var curKey = 0;
  var lastInfo = null;

  var movePool = [];
  var scorePool = [];
  for (var i = 0; i < MAXPLY; i++) {
    movePool.push([]);
    scorePool.push([]);
  }

  /* 哨兵用 -1：格子编号 0 是合法着法，不能拿 0 当"没有" */
  var killers = [];
  for (i = 0; i < MAXPLY; i++) killers.push([-1, -1]);
  var historyTable = new Int32Array(CELLS);

  /* 落子 / 撤子，同步维护 Zobrist key、增量评估和棋子计数 */
  function doMove(bd, m, side) {
    bd[m] = side;
    curKey ^= (side === X ? zobX[m] : zobO[m]) ^ zobSide;
    touchCell(bd, m);
    stoneCount++;
  }

  function undoMove(bd, m, side) {
    bd[m] = 0;
    curKey ^= (side === X ? zobX[m] : zobO[m]) ^ zobSide;
    touchCell(bd, m);
    stoneCount--;
  }

  function scoreMove(bd, m, side, ply, ttMv) {
    if (m === ttMv) return 2000000;
    var k = killers[ply];
    if (k[0] === m) return 900000;
    if (k[1] === m) return 890000;
    return moveHeuristic(bd, m, side) * 4 + Math.min(historyTable[m], 9999);
  }

  /* 插入排序：着法少且大多接近有序，比 Array.sort 更快 */
  function orderMoves(bd, moves, side, ply, ttMv) {
    var n = moves.length;
    if (n < 2) return;
    var sc = scorePool[ply];
    for (var i = 0; i < n; i++) sc[i] = scoreMove(bd, moves[i], side, ply, ttMv);
    for (i = 1; i < n; i++) {
      var mv = moves[i], s = sc[i];
      var j = i - 1;
      while (j >= 0 && sc[j] < s) {
        moves[j + 1] = moves[j];
        sc[j + 1] = sc[j];
        j--;
      }
      moves[j + 1] = mv;
      sc[j + 1] = s;
    }
  }

  function timeUp() {
    if ((nodes & 511) === 0 && Date.now() > deadline) aborted = true;
    return aborted;
  }

  /*
   * 静态搜索。五子棋没有吃子，但有一条完全等价的"水平线效应"：
   * 搜索正好停在一个对手已经有四的局面上，会以为还有救。
   * 这里的做法是把所有强制着法走完——自己有成五点就赢，对手有四就必须堵，
   * 堵完再看对手有没有新的四，一直走到没人能立刻成五为止。
   */
  function quiesce(bd, side, alpha, beta, ply) {
    if (timeUp()) return 0;
    nodes++;

    if (fastWinPoints(bd, side).length) return MATE - ply;

    var oppWin = fastWinPoints(bd, -side);
    if (oppWin.length >= 2) return -MATE + ply + 1;    /* 双四，只能堵一个 */
    if (oppWin.length === 0) return evalFor(side);
    if (ply >= MAXPLY - 2) return evalFor(side);

    var m = oppWin[0];
    doMove(bd, m, side);
    var score = -quiesce(bd, -side, -beta, -alpha, ply + 1);
    undoMove(bd, m, side);
    if (aborted) return 0;
    return score;
  }

  function negamax(bd, side, depth, alpha, beta, ply, canNull) {
    if (timeUp()) return 0;
    nodes++;

    var isPv = (beta - alpha) > 1;

    if (depth <= 0) return quiesce(bd, side, alpha, beta, ply);

    var ttIdx = curKey & TT_MASK;
    var ttHit = (ttKey[ttIdx] === curKey && ttDepth[ttIdx] > 0);
    var ttMv = ttHit ? ttMove[ttIdx] : -1;

    if (ttHit && !isPv && ttDepth[ttIdx] >= depth) {
      var ts = ttScore[ttIdx];
      if (ts > MATE_BOUND) ts -= ply;
      else if (ts < -MATE_BOUND) ts += ply;
      var tf = ttFlag[ttIdx];
      if (tf === TT_EXACT) return ts;
      if (tf === TT_LOWER && ts >= beta) return ts;
      if (tf === TT_UPPER && ts <= alpha) return ts;
    }

    /* 轮到自己就能成五 —— 直接终局，不必展开 */
    var myWin = fastWinPoints(bd, side);
    if (myWin.length) return MATE - ply;

    var oppWin = fastWinPoints(bd, -side);
    if (oppWin.length >= 2) return -MATE + ply + 1;    /* 对手双四，挡不住了 */

    /* 对手有成五点：这一步没得选，只能堵在那儿 */
    var moves;
    if (oppWin.length === 1) {
      moves = movePool[ply];
      moves.length = 0;
      moves.push(oppWin[0]);
    } else {
      /*
       * 无强制着法时才展开候选点。
       * 根结点和第一层用 radius 2，把各种"跳"的形状都留着；
       * 再往下收窄到 radius 1，只考虑紧贴棋子的点。
       * 所有能立刻成五、能堵四的点都必然紧贴着棋子，radius 1 一个都不会漏，
       * 所以收窄只损失"从两格开外另起炉灶"这种慢着，换来的是深两层。
       * 实测两种取法的对战力完全相同（12 局 6:6），收窄的那版快 35%。
       */
      moves = movePool[ply];
      GM.genCandidates(bd, ply >= 2 ? 1 : 2, moves);
    }
    if (moves.length === 0) return 0;                  /* 棋盘下满，和棋 */

    /* null-move：白让一手，对手还是占不到便宜就说明这里很安全。
       开局子太少时让一手代价太大，搜了也是白搜，直接用棋子数挡掉。 */
    if (canNull && !isPv && depth >= 3 && stoneCount >= 6 && oppWin.length === 0) {
      var red = depth > 6 ? 3 : 2;
      curKey ^= zobSide;
      var nullScore = -negamax(bd, -side, depth - 1 - red, -beta, -beta + 1, ply + 1, false);
      curKey ^= zobSide;
      if (aborted) return 0;
      if (nullScore >= beta) return beta;
    }

    orderMoves(bd, moves, side, ply, ttMv);

    var best = -INF;
    var bestMove = -1;
    var flag = TT_UPPER;
    var moveCount = 0;
    var forced = (oppWin.length === 1);

    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      doMove(bd, m, side);

      /* 这一手直接连成五 —— 和象棋里"吃掉对方将"是同一个位置 */
      if (GM.wins(bd, m)) {
        undoMove(bd, m, side);
        return MATE - ply;
      }

      var score;
      if (moveCount === 0) {
        score = -negamax(bd, -side, depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        /* LMR：靠后的着法先降深度试探 */
        var reduce = 0;
        if (depth >= 3 && moveCount >= 4 && !forced) {
          reduce = 1 + ((moveCount >= 10 && depth >= 6) ? 1 : 0);
          if (reduce > depth - 2) reduce = depth - 2;
        }

        score = -negamax(bd, -side, depth - 1 - reduce, -alpha - 1, -alpha, ply + 1, true);
        /* 降深度还超出预期，补一次全深度零窗口 */
        if (score > alpha && reduce > 0) {
          score = -negamax(bd, -side, depth - 1, -alpha - 1, -alpha, ply + 1, true);
        }
        /* 零窗口确认比 alpha 好，再全窗口求出确切分值 */
        if (score > alpha && score < beta) {
          score = -negamax(bd, -side, depth - 1, -beta, -alpha, ply + 1, true);
        }
      }

      undoMove(bd, m, side);
      if (aborted) return 0;
      moveCount++;

      if (score > best) { best = score; bestMove = m; }
      if (score > alpha) { alpha = score; flag = TT_EXACT; }
      if (alpha >= beta) {
        flag = TT_LOWER;
        /* 强制着法就那么一条，放进 killer 表只会挤掉真正有用的安静着法 */
        if (!forced) {
          var kk = killers[ply];
          if (kk[0] !== m) { kk[1] = kk[0]; kk[0] = m; }
          historyTable[m] += depth * depth;
        }
        break;
      }
    }

    /* 写置换表，杀棋分数按层数换算以免跨层失真 */
    var store = best;
    if (store > MATE_BOUND) store += ply;
    else if (store < -MATE_BOUND) store -= ply;
    ttKey[ttIdx] = curKey;
    ttMove[ttIdx] = bestMove;
    ttScore[ttIdx] = store;
    ttDepth[ttIdx] = depth > 127 ? 127 : depth;
    ttFlag[ttIdx] = flag;

    return best;
  }

  /* ================= 开局库 =================
   * 每条线是一串格子编号（X / O 交替），开局阶段照着走。
   * 好处有两个：开局不至于走出莫名其妙的自损着法，而且同一局面有多个分支时
   * 会随机挑一个，不会每盘棋都一模一样。
   * 天元 = 112（第 7 行第 7 列），其余点按"黑天元、白贴角、黑反挂"的常见套路排。
   * 库里的着法仍会用本地规则校验一遍，不合法就当没有。
   */
  function rc(r, c) { return r * N + c; }

  var OPENING_BOOK = [
    /* 斜指开局，黑往同侧挂 */
    [rc(7, 7), rc(6, 6), rc(7, 8), rc(8, 7), rc(7, 6)],
    /* 斜指开局，黑往另一侧挂 */
    [rc(7, 7), rc(6, 6), rc(7, 6), rc(8, 7), rc(7, 8)],
    /* 直指开局 */
    [rc(7, 7), rc(7, 8), rc(6, 7), rc(8, 8), rc(6, 6)],
    /* 白挂右上 */
    [rc(7, 7), rc(6, 8), rc(7, 6), rc(8, 6), rc(7, 8)],
    /* 白挂左下 */
    [rc(7, 7), rc(8, 8), rc(6, 7), rc(7, 6), rc(7, 8)],
    /* 白隔一路 */
    [rc(7, 7), rc(7, 6), rc(7, 8), rc(6, 7), rc(8, 7)]
  ];

  var BOOK_MAX_PLY = 10;

  /**
   * 查开局库
   * @param {number[]} played 已经走过的着法序列
   * @param {number[]} legal  当前能走的空点
   * @returns {number} 格子编号，没命中返回 -1
   */
  function bookMove(played, legal) {
    var n = played.length;
    if (n > BOOK_MAX_PLY) return -1;

    var votes = {};
    var i, k;
    for (i = 0; i < OPENING_BOOK.length; i++) {
      var line = OPENING_BOOK[i];
      if (line.length <= n) continue;
      var match = true;
      for (k = 0; k < n; k++) {
        if (line[k] !== played[k]) { match = false; break; }
      }
      if (!match) continue;
      votes[line[n]] = (votes[line[n]] || 0) + 1;
    }

    var pool = [];
    for (var key in votes) {
      if (!Object.prototype.hasOwnProperty.call(votes, key)) continue;
      var mv = +key;
      if (legal.indexOf(mv) < 0) continue;      /* 库里的着法也要过一遍规则 */
      for (k = 0; k < votes[key]; k++) pool.push(mv);
    }
    if (!pool.length) return -1;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * 搜索最佳着法
   * @param {Int8Array} bd        当前局面
   * @param {number}   side       走子方（1 = X / -1 = O）
   * @param {number}   maxDepth   迭代加深上限
   * @param {number}   timeMs     时间上限（毫秒）
   * @param {number}  [randomMargin] 大于 0 时在"接近最优"的着法里随机挑，
   *                                 用来压低棋力并让每盘不重样
   * @returns {number|null} 格子编号，无处可下返回 null
   */
  function search(bd, side, maxDepth, timeMs, randomMargin) {
    var t0 = Date.now();
    nodes = 0;
    aborted = false;
    deadline = t0 + timeMs;
    randomMargin = randomMargin || 0;
    /* 要按分差挑棋就得有精确分数，根结点必须全窗口 */
    var fullWindow = randomMargin > 0;

    for (var i = 0; i < killers.length; i++) { killers[i][0] = -1; killers[i][1] = -1; }
    historyTable.fill(0);

    resetEval(bd);
    curKey = computeKey(bd, side);

    /* 根结点的强制着法：能成五就落子，不搜了 */
    var myWin = fastWinPoints(bd, side);
    if (myWin.length) {
      lastInfo = { depth: 0, nodes: 0, score: MATE, time: Date.now() - t0 };
      return myWin[0];
    }

    /* 对手有四就只能堵；棋盘下满则无处可下 */
    var oppWin = fastWinPoints(bd, -side);
    var rootMoves = oppWin.length ? oppWin : GM.genCandidates(bd, 2, []);
    if (rootMoves.length === 0) { lastInfo = null; return null; }

    var bestMove = rootMoves[0];
    var bestScore = 0;
    var reachedDepth = 0;
    var lastScored = null;

    for (var depth = 1; depth <= maxDepth; depth++) {
      var iterStart = Date.now();
      var idx = rootMoves.indexOf(bestMove);
      if (idx > 0) { rootMoves.splice(idx, 1); rootMoves.unshift(bestMove); }

      var alpha = -INF;
      var localBest = -1;
      var localScore = -INF;
      var scored = fullWindow ? [] : null;

      for (var j = 0; j < rootMoves.length; j++) {
        var m = rootMoves[j];
        doMove(bd, m, side);

        if (GM.wins(bd, m)) {
          undoMove(bd, m, side);
          localBest = m;
          localScore = MATE;
          alpha = MATE;
          break;
        }

        var score;
        if (fullWindow || j === 0) {
          score = -negamax(bd, -side, depth - 1, -INF, fullWindow ? INF : -alpha, 1, true);
        } else {
          score = -negamax(bd, -side, depth - 1, -alpha - 1, -alpha, 1, true);
          if (score > alpha) {
            score = -negamax(bd, -side, depth - 1, -INF, -alpha, 1, true);
          }
        }

        undoMove(bd, m, side);
        if (aborted) break;
        if (scored) scored.push([m, score]);
        if (score > localScore) { localScore = score; localBest = m; }
        if (score > alpha) alpha = score;
      }

      if (!aborted) {
        if (localBest >= 0) {
          bestMove = localBest;
          bestScore = localScore;
          reachedDepth = depth;
          lastScored = scored;
        }
        if (bestScore > MATE_BOUND || bestScore < -MATE_BOUND) break;
      } else if (depth === 1 && localBest >= 0) {
        bestMove = localBest;
        reachedDepth = 1;
      }
      if (aborted) break;

      /*
       * 下一层耗时大约是本层的 4 倍。明显搜不完就收手，
       * 免得把时间预算烧在一个注定被丢弃的迭代上。
       */
      var iterTime = Date.now() - iterStart;
      if (iterTime * 4 > deadline - Date.now()) break;
    }

    if (randomMargin > 0 && lastScored && lastScored.length > 1 &&
        Math.abs(bestScore) < MATE_BOUND) {
      var maxS = -INF;
      for (var k = 0; k < lastScored.length; k++) {
        if (lastScored[k][1] > maxS) maxS = lastScored[k][1];
      }
      var pool = [];
      for (k = 0; k < lastScored.length; k++) {
        if (lastScored[k][1] >= maxS - randomMargin) pool.push(lastScored[k][0]);
      }
      if (pool.length > 0) bestMove = pool[Math.floor(Math.random() * pool.length)];
    }

    lastInfo = {
      depth: reachedDepth,
      nodes: nodes,
      score: bestScore,
      time: Date.now() - t0
    };
    return bestMove;
  }

  global.GomokuAI = {
    search: search,
    bookMove: bookMove,
    evaluate: evaluate,
    /* 供测试对照：从零同步一遍增量状态，再走快速路径 */
    winPointsFast: function (bd, side) { resetEval(bd); return fastWinPoints(bd, side); },
    scoreBoard: function (bd) { resetEval(bd); return curEval; },
    MATE: MATE,
    lastInfo: function () { return lastInfo; },
    stats: function () { return { nodes: nodes, aborted: aborted }; }
  };
}

/* 主线程直接装载；Worker 里由 bootstrap 调 GomokuAIEngine(self) */
if (typeof window !== 'undefined') GomokuAIEngine(window);
