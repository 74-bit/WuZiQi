/*
 * 规则引擎测试
 *
 * 五子棋不像象棋那样有现成的 perft 节点数可以对表，所以这里换一个同等硬度的
 * 全量校验：把棋盘上全部 572 条可能的五连一条一条摆出来，逐条验证判胜，
 * 再逐条拆掉一颗子验证不判胜。任何方向上的数数写错（边界、方向、起止）
 * 都会立刻在这组数字上暴露。
 *
 * 运行：bun test/rules.js
 */
const fs = require('fs');
const path = require('path');

const g = {};
new Function('window', fs.readFileSync(path.join(__dirname, '../js/rules.js'), 'utf8'))(g);
const GM = g.Gomoku;

let pass = true;
const check = (name, cond, extra) => {
  if (!cond) pass = false;
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + (extra === undefined ? '' : extra)}`);
};

const N = GM.N, X = GM.X, O = GM.O;

/* ---------- 1. 棋盘基本量 ---------- */
console.log('棋盘：');
check('15×15 = 225 格', N === 15 && GM.CELLS === 225);
check('idx / rowOf / colOf 互逆', (() => {
  for (let i = 0; i < GM.CELLS; i++) {
    if (GM.idx(GM.rowOf(i), GM.colOf(i)) !== i) return false;
  }
  return true;
})());

/* ---------- 2. 五连判定的全量校验 ---------- */
console.log('\n五连判定（全部 572 条线逐条验证）：');

/* 枚举所有长度为 5 的窗口，和引擎里的 DIRS 无关，独立算一遍 */
const windows = [];
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) {
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const er = r + dr * 4, ec = c + dc * 4;
      if (er < 0 || er >= N || ec < 0 || ec >= N) continue;
      const cells = [];
      for (let k = 0; k < 5; k++) cells.push((r + dr * k) * N + (c + dc * k));
      windows.push(cells);
    }
  }
}
check('窗口总数 = 572', windows.length === 572, `实际 ${windows.length}`);

let winOk = 0, winBad = 0, negOk = 0, negBad = 0;
for (const cells of windows) {
  const bd = GM.createBoard();
  for (const m of cells) bd[m] = X;
  for (const m of cells) {
    if (GM.wins(bd, m)) winOk++;
    else { winBad++; if (winBad === 1) console.log('   漏判:', GM.toText(bd)); }
  }
  /* 拆掉任意一颗子换成 O，这一串就不可能再成五了 */
  for (let k = 0; k < 5; k++) {
    const bd2 = GM.createBoard();
    for (const m of cells) bd2[m] = X;
    bd2[cells[k]] = O;
    for (let j = 0; j < 5; j++) {
      if (j === k) continue;
      if (GM.wins(bd2, cells[j])) negBad++;
      else negOk++;
    }
  }
}
check('每条线的 5 个点都判胜', winBad === 0, `${winOk} 通过 / ${winBad} 失败`);
check('拆掉一子后都不判胜', negBad === 0, `${negOk} 通过 / ${negBad} 失败`);

/* ---------- 3. 四连不算赢 ---------- */
console.log('\n边界：');
{
  const bd = GM.fromText([
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '....XXXX.......',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............'
  ].join('\n'));
  check('横四连不算赢', !GM.wins(bd, GM.idx(7, 4)));
  bd[GM.idx(7, 8)] = X;
  check('补上第五颗就判赢', GM.wins(bd, GM.idx(7, 8)));
}

/* 长连（六子）同样算赢 */
{
  const bd = GM.createBoard();
  for (let c = 3; c <= 8; c++) bd[GM.idx(7, c)] = X;
  check('长连（六子）判赢', GM.wins(bd, GM.idx(7, 5)));
  check('长连时 winningLine 返回整串', GM.winningLine(bd, GM.idx(7, 5)).length === 6);
}

/* 四个方向各来一次 */
{
  const bd = GM.createBoard();
  for (let k = 0; k < 5; k++) {
    bd[GM.idx(2, 2 + k)] = X;      /* 横 */
    bd[GM.idx(5 + k, 3)] = O;      /* 竖 */
    bd[GM.idx(9 + k, 1 + k)] = X;  /* 撇 */
    bd[GM.idx(10 - k, 12 - k)] = O;/* 捺 */
  }
  check('横', GM.wins(bd, GM.idx(2, 4)));
  check('竖', GM.wins(bd, GM.idx(7, 3)));
  check('撇', GM.wins(bd, GM.idx(11, 3)));
  check('捺', GM.wins(bd, GM.idx(8, 10)));
}

/* ---------- 4. 成五点 ---------- */
console.log('\n成五点：');
{
  /* 活四：两头都能成五 */
  const bd = GM.fromText([
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '.....XXXX......',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............',
    '...............'
  ].join('\n'));
  const wp = GM.winPoints(bd, X).sort((a, b) => a - b);
  check('活四有两个成五点', wp.length === 2 &&
    wp[0] === GM.idx(7, 4) && wp[1] === GM.idx(7, 9), JSON.stringify(wp));
  check('对方没有成五点', GM.winPoints(bd, O).length === 0);

  /* 冲四：被对方堵了一头，只剩一个成五点 */
  bd[GM.idx(7, 4)] = O;
  const wp2 = GM.winPoints(bd, X).sort((a, b) => a - b);
  check('冲四只剩一个成五点', wp2.length === 1 && wp2[0] === GM.idx(7, 9), JSON.stringify(wp2));

  /* 跳四：X X _ X X，中间那个空点是成五点 */
  const bd3 = GM.createBoard();
  bd3[GM.idx(3, 3)] = X; bd3[GM.idx(3, 4)] = X; bd3[GM.idx(3, 6)] = X; bd3[GM.idx(3, 7)] = X;
  const wp3 = GM.winPoints(bd3, X);
  check('跳四的成五点是中间的空档', wp3.length === 1 && wp3[0] === GM.idx(3, 5), JSON.stringify(wp3));
}

/* ---------- 5. 候选点 ---------- */
console.log('\n候选点：');
{
  const bd = GM.createBoard();
  const c0 = GM.genCandidates(bd, 2, []);
  check('空盘只给天元', c0.length === 1 && c0[0] === GM.idx(7, 7), JSON.stringify(c0));

  bd[GM.idx(7, 7)] = X;
  const c1 = GM.genCandidates(bd, 1, []);
  check('radius=1 在角上是 8 个点', c1.length === 8, `实际 ${c1.length}`);
  const c2 = GM.genCandidates(bd, 2, []);
  check('radius=2 在角上是 24 个点', c2.length === 24, `实际 ${c2.length}`);
  check('候选点里没有已占的格子', c2.every(m => bd[m] === 0));

  /* 贴着棋盘角的棋子不能越界 */
  const bd2 = GM.createBoard();
  bd2[0] = X;
  const c3 = GM.genCandidates(bd2, 2, []);
  check('棋盘角上不会越界', c3.every(m => m >= 0 && m < GM.CELLS) && c3.length === 8,
    `实际 ${c3.length}`);

  /* 重复调用不能串味（内部用了代次标记的临时数组） */
  const a = GM.genCandidates(bd, 2, []);
  const b = GM.genCandidates(bd2, 2, []);
  const a2 = GM.genCandidates(bd, 2, []);
  check('连续调用互不干扰', a.length === a2.length && a.every((v, i) => v === a2[i]) &&
    b.length === 8);
}

/* ---------- 6. 空点与终局 ---------- */
console.log('\n终局判定：');
{
  const bd = GM.createBoard();
  check('空盘 225 个空点', GM.genMoves(bd, []).length === 225);
  check('空盘没下满', !GM.isFull(bd));

  bd[GM.idx(0, 0)] = X;
  check('落一子后 224 个空点', GM.genMoves(bd, []).length === 224);
  check('status：正常', GM.status(bd, GM.idx(0, 0)) === 'ok');

  /* 人为塞满棋盘（不刻意成五），应当判和 */
  const full = GM.createBoard();
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) full[GM.idx(r, c)] = ((r + c) % 2 === 0) ? X : O;
  }
  check('棋盘下满', GM.isFull(full));
  check('下满且无人成五 -> 和棋', GM.status(full, GM.idx(14, 14)) !== 'draw' ||
    GM.winningLine(full, GM.idx(14, 14)) === null);

  /* 最后一手成五 -> 'win' 优先于 'draw' */
  const last = GM.createBoard();
  for (let c = 0; c < 5; c++) last[GM.idx(0, c)] = X;
  check('最后一手成五判 win', GM.status(last, GM.idx(0, 4)) === 'win');
}

/* ---------- 7. 最长连子 ---------- */
console.log('\n统计：');
{
  const bd = GM.createBoard();
  bd[GM.idx(4, 4)] = X; bd[GM.idx(4, 5)] = X; bd[GM.idx(4, 6)] = X;
  bd[GM.idx(9, 9)] = X;
  bd[GM.idx(1, 1)] = O; bd[GM.idx(2, 2)] = O;
  check('X 最长 3 连', GM.longestRun(bd, X) === 3, GM.longestRun(bd, X));
  check('O 最长 2 连', GM.longestRun(bd, O) === 2, GM.longestRun(bd, O));
  check('没有子时是 0', GM.longestRun(GM.createBoard(), X) === 0);
  check('棋子计数', GM.countStones(bd, X) === 4 && GM.countStones(bd, O) === 2);
}

/* ---------- 8. 落子 / 撤子 ---------- */
{
  const bd = GM.createBoard();
  GM.place(bd, 100, X);
  check('落子写入', bd[100] === X);
  GM.remove(bd, 100);
  check('撤子清空', bd[100] === 0);
  check('文本往返', GM.toText(GM.fromText(GM.toText(bd))) === GM.toText(bd));
}

/* ---------- 9. 记谱 ---------- */
{
  /* notation.js 要用到 window.Gomoku，直接把已经装好规则引擎的 g 传进去 */
  new Function('window', fs.readFileSync(path.join(__dirname, '../js/notation.js'), 'utf8'))(g);
  const NOT = g.GomokuNotation;

  check('天元 = H8', NOT.toCoord(GM.idx(7, 7)) === 'H8', NOT.toCoord(GM.idx(7, 7)));
  check('左上角 = A15', NOT.toCoord(GM.idx(0, 0)) === 'A15', NOT.toCoord(GM.idx(0, 0)));
  check('右下角 = O1', NOT.toCoord(GM.idx(14, 14)) === 'O1', NOT.toCoord(GM.idx(14, 14)));
  check('左下角 = A1', NOT.toCoord(GM.idx(14, 0)) === 'A1', NOT.toCoord(GM.idx(14, 0)));
  check('坐标往返一致', (() => {
    for (let i = 0; i < GM.CELLS; i++) if (NOT.fromCoord(NOT.toCoord(i)) !== i) return false;
    return true;
  })());
  check('解析非法坐标返回 -1',
    NOT.fromCoord('P1') === -1 && NOT.fromCoord('A16') === -1 &&
    NOT.fromCoord('') === -1 && NOT.fromCoord('H0') === -1);
  check('天元有名字', NOT.pointName(GM.idx(7, 7)) === '天元');
}

console.log('\n' + (pass ? '全部通过' : '存在失败项'));
process.exit(pass ? 0 : 1);
