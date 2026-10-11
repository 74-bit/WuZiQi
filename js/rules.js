/*
 * 五子棋规则引擎
 *
 * 外观是井字棋：15×15 个格子，双方轮流往格子里画 X / O，不落在交叉点上。
 * 规则是五子棋：横、竖、撇、捺任意方向先连成 5 个的获胜。
 *
 * 棋盘：15×15 = 225 个格子，index = row * 15 + col
 *   row 0  = 画面最上一行，row 14 = 最下一行
 *   col 0  = 画面最左一列，col 14 = 最右一列
 * 格子编码：1 = X（先手），-1 = O（后手），0 = 空格
 *
 * 写成具名工厂函数而不是匿名 IIFE，是为了能把源码 toString() 出来、
 * 塞进 Blob 里当 Worker 用（file:// 下没法 importScripts 本地脚本，
 * 也没法 fetch 源码）。main 线程和 Worker 都调用同一个工厂。
 */
function GomokuRules(global) {
  'use strict';

  var N = 15;
  var CELLS = N * N;
  var X = 1, O = -1;
  var NEED = 5;                 /* 连成几个算赢 */

  /* 四个方向：横、竖、撇、捺。反方向靠 sgn 取负得到，不必重复列 */
  var DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

  function idx(r, c) { return r * N + c; }
  function rowOf(i) { return (i / N) | 0; }
  function colOf(i) { return i % N; }
  function inBoard(r, c) { return r >= 0 && r < N && c >= 0 && c < N; }
  function sideOf(p) { return p > 0 ? X : (p < 0 ? O : 0); }
  function opponent(side) { return -side; }

  function createBoard() { return new Int8Array(CELLS); }
  function cloneBoard(bd) { return Int8Array.from(bd); }

  /* 落子 / 撤子。五子棋没有吃子，所以不需要返回被吃的东西 */
  function place(bd, m, side) { bd[m] = side; }
  function remove(bd, m) { bd[m] = 0; }

  /*
   * 刚下在 m 的这颗子是否连成了五。
   * 只看穿过 m 的四条线（每条线往两边数），比全盘扫描快得多——
   * 搜索里每生成一个着法都要判一次。
   */
  function wins(bd, m) {
    var p = bd[m];
    if (p === 0) return false;
    var r = (m / N) | 0, c = m % N;
    for (var d = 0; d < 4; d++) {
      var dr = DIRS[d][0], dc = DIRS[d][1];
      var n = 1;
      for (var s = -1; s <= 1; s += 2) {
        var nr = r + dr * s, nc = c + dc * s;
        while (inBoard(nr, nc) && bd[nr * N + nc] === p) {
          n++;
          nr += dr * s;
          nc += dc * s;
        }
      }
      if (n >= NEED) return true;
    }
    return false;
  }

  /* 穿过 m 的最长连子数（不要求成五，给评分面板和测试用） */
  function runLength(bd, m) {
    var p = bd[m];
    if (p === 0) return 0;
    var r = (m / N) | 0, c = m % N;
    var best = 1;
    for (var d = 0; d < 4; d++) {
      var dr = DIRS[d][0], dc = DIRS[d][1];
      var n = 1;
      for (var s = -1; s <= 1; s += 2) {
        var nr = r + dr * s, nc = c + dc * s;
        while (inBoard(nr, nc) && bd[nr * N + nc] === p) {
          n++;
          nr += dr * s;
          nc += dc * s;
        }
      }
      if (n > best) best = n;
    }
    return best;
  }

  /*
   * 刚下在 m 的这颗子连成的那一串格子（成五时返回，否则返回 null）。
   * 长连（六子以上）整串都返回——自由规则下长连同样算赢。
   */
  function winningLine(bd, m) {
    var p = bd[m];
    if (p === 0) return null;
    var r = (m / N) | 0, c = m % N;
    for (var d = 0; d < 4; d++) {
      var dr = DIRS[d][0], dc = DIRS[d][1];
      var line = [m];
      for (var s = -1; s <= 1; s += 2) {
        var nr = r + dr * s, nc = c + dc * s;
        while (inBoard(nr, nc) && bd[nr * N + nc] === p) {
          line.push(nr * N + nc);
          nr += dr * s;
          nc += dc * s;
        }
      }
      if (line.length >= NEED) {
        line.sort(function (a, b) { return a - b; });
        return line;
      }
    }
    return null;
  }

  /*
   * 全盘所有"下在这里就能成五"的空点。
   * 这是五子棋里最关键的战术信息：
   *   非空       —— 该方下一步就能赢
   *   长度 ≥ 2   —— 双四，对方只能堵一个，已经挡不住了
   *
   * 能成五的点必定紧挨着自己的一颗子（一条 5 连里除它以外还有 4 颗，
   * 5 格里塞 4 颗子，必然有一颗与它相邻），所以先按邻子筛一遍再试。
   */
  function winPoints(bd, side) {
    var out = [];
    for (var m = 0; m < CELLS; m++) {
      if (bd[m] !== 0) continue;
      var r = (m / N) | 0, c = m % N;
      var near = false;
      for (var dr = -1; dr <= 1 && !near; dr++) {
        for (var dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          var nr = r + dr, nc = c + dc;
          if (inBoard(nr, nc) && bd[nr * N + nc] === side) { near = true; break; }
        }
      }
      if (!near) continue;
      bd[m] = side;
      if (wins(bd, m)) out.push(m);
      bd[m] = 0;
    }
    return out;
  }

  /*
   * 候选点：任何棋子周围 radius 格以内的空点。
   * 225 个格子全展开的话分支因子是 200 上下，搜索根本深不下去；
   * 而离现有棋子 3 格开外的落点没有任何战术意义，砍掉不影响棋力。
   *   radius = 2 —— 覆盖各种"跳"的形状（活三的延伸、跳四的补点）
   *   radius = 1 —— 只留紧贴棋子的点，深层的强制着法序列够用了
   * 空盘时返回天元。
   */
  var seen = new Int32Array(CELLS);
  var seenGen = 0;

  function genCandidates(bd, radius, out) {
    out = out || [];
    out.length = 0;
    var gen = ++seenGen;
    var stones = 0;
    for (var i = 0; i < CELLS; i++) {
      if (bd[i] === 0) continue;
      stones++;
      var r = (i / N) | 0, c = i % N;
      for (var dr = -radius; dr <= radius; dr++) {
        for (var dc = -radius; dc <= radius; dc++) {
          var nr = r + dr, nc = c + dc;
          if (!inBoard(nr, nc)) continue;
          var j = nr * N + nc;
          if (bd[j] !== 0 || seen[j] === gen) continue;
          seen[j] = gen;
          out.push(j);
        }
      }
    }
    if (stones === 0) out.push(idx((N - 1) >> 1, (N - 1) >> 1));
    return out;
  }

  /* 全部空点。联机收到着法时用它校验，也是"还有没有地方下"的判据 */
  function genMoves(bd, out) {
    out = out || [];
    out.length = 0;
    for (var i = 0; i < CELLS; i++) if (bd[i] === 0) out.push(i);
    return out;
  }

  function isFull(bd) {
    for (var i = 0; i < CELLS; i++) if (bd[i] === 0) return false;
    return true;
  }

  function countStones(bd, side) {
    var n = 0;
    for (var i = 0; i < CELLS; i++) if (bd[i] === side) n++;
    return n;
  }

  /* 该方最长的一串连子。评分面板用它代替"吃子数" */
  function longestRun(bd, side) {
    var best = 0;
    for (var m = 0; m < CELLS; m++) {
      if (bd[m] !== side) continue;
      var r = (m / N) | 0, c = m % N;
      for (var d = 0; d < 4; d++) {
        var dr = DIRS[d][0], dc = DIRS[d][1];
        /* 只从这一串的起点开始数，免得同一串被重复统计 */
        var pr = r - dr, pc = c - dc;
        if (inBoard(pr, pc) && bd[pr * N + pc] === side) continue;
        var n = 0, nr = r, nc = c;
        while (inBoard(nr, nc) && bd[nr * N + nc] === side) {
          n++;
          nr += dr;
          nc += dc;
        }
        if (n > best) best = n;
      }
    }
    return best;
  }

  /*
   * 局面状态。last 是最后一手的格子编号（开局传 -1）：
   *   'win'   最后一手连成了五
   *   'draw'  棋盘下满且没人成五
   *   'ok'    继续下
   */
  function status(bd, last) {
    if (last >= 0 && wins(bd, last)) return 'win';
    return isFull(bd) ? 'draw' : 'ok';
  }

  /* 棋子外观字符 */
  function cellChar(p) { return p > 0 ? 'X' : (p < 0 ? 'O' : ''); }

  /* ---- 文本互转：测试和调试用 ---- */
  function fromText(text) {
    var bd = createBoard();
    var lines = String(text).split('\n');
    for (var r = 0; r < N && r < lines.length; r++) {
      var line = lines[r];
      for (var c = 0; c < N && c < line.length; c++) {
        var ch = line.charAt(c);
        if (ch === 'X' || ch === 'x') bd[r * N + c] = X;
        else if (ch === 'O' || ch === 'o') bd[r * N + c] = O;
      }
    }
    return bd;
  }

  function toText(bd) {
    var out = [];
    for (var r = 0; r < N; r++) {
      var line = '';
      for (var c = 0; c < N; c++) {
        var p = bd[r * N + c];
        line += p === 0 ? '.' : (p > 0 ? 'X' : 'O');
      }
      out.push(line);
    }
    return out.join('\n');
  }

  global.Gomoku = {
    N: N, CELLS: CELLS, X: X, O: O, NEED: NEED, DIRS: DIRS,
    idx: idx, rowOf: rowOf, colOf: colOf, inBoard: inBoard,
    sideOf: sideOf, opponent: opponent,
    createBoard: createBoard, cloneBoard: cloneBoard,
    place: place, remove: remove,
    wins: wins, runLength: runLength, winningLine: winningLine,
    winPoints: winPoints, genCandidates: genCandidates, genMoves: genMoves,
    isFull: isFull, countStones: countStones, longestRun: longestRun,
    status: status, cellChar: cellChar,
    fromText: fromText, toText: toText
  };
}

/* 主线程直接装载；Worker 里由 bootstrap 调 GomokuRules(self) */
if (typeof window !== 'undefined') GomokuRules(window);
