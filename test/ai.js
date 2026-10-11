/*
 * AI 测试
 *   1. 增量维护的成五点 / 静态评估，和"从零算一遍"的版本必须逐位一致
 *      —— 这两块是搜索的地基，一旦算错，棋力会莫名其妙地掉而看不出原因
 *   2. 战术：该赢的赢，该堵的堵
 *   3. 搜索速度、着法合法性、自我对弈
 * 运行：bun test/ai.js
 */
const fs = require('fs');
const path = require('path');

const g = {};
const load = (f) => new Function('window', fs.readFileSync(path.join(__dirname, '../js', f), 'utf8'))(g);
load('rules.js');
load('ai.js');

const GM = g.Gomoku;
const AI = g.GomokuAI;
const N = GM.N, X = GM.X, O = GM.O;

let pass = true;
const check = (name, cond, extra) => {
  if (!cond) pass = false;
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + (extra === undefined ? '' : extra)}`);
};
const coord = (m) => m < 0 ? '无' : (String.fromCharCode(65 + (m % N)) + (N - ((m / N) | 0)));

/* 随机局面：随机撒子，保证没人已经成五 */
function randomBoard(stones) {
  const bd = GM.createBoard();
  let placed = 0, guard = 0;
  while (placed < stones && guard++ < 4000) {
    const m = Math.floor(Math.random() * GM.CELLS);
    if (bd[m] !== 0) continue;
    const side = (placed % 2 === 0) ? X : O;
    bd[m] = side;
    if (GM.wins(bd, m)) { bd[m] = 0; continue; }
    /* 落子顺序决定轮次，避免出现"某一方多下一手"的怪局面 */
    placed++;
  }
  return bd;
}

/* ---------- 1. 增量状态 vs 从零重算 ---------- */
console.log('增量维护的正确性（随机局面逐个对照）：');
{
  let wpMismatch = 0, evMismatch = 0, cases = 0;
  for (let t = 0; t < 400; t++) {
    const bd = randomBoard(Math.floor(Math.random() * 40));
    for (const side of [X, O]) {
      cases++;
      const fast = AI.winPointsFast(bd, side).slice().sort((a, b) => a - b);
      const slow = GM.winPoints(bd, side).slice().sort((a, b) => a - b);
      if (fast.length !== slow.length || fast.some((v, i) => v !== slow[i])) {
        wpMismatch++;
        if (wpMismatch === 1) console.log('   成五点不一致:', JSON.stringify(fast), JSON.stringify(slow));
      }
    }
    const inc = AI.scoreBoard(bd);
    const full = AI.evaluate(bd, X);
    if (inc !== full) {
      evMismatch++;
      if (evMismatch === 1) console.log(`   评分不一致: 增量 ${inc} / 重算 ${full}`);
    }
  }
  check(`成五点：${cases} 次对照全部一致`, wpMismatch === 0, `${wpMismatch} 次不一致`);
  check('静态评估：400 个局面全部一致', evMismatch === 0, `${evMismatch} 次不一致`);
  check('评估双方视角互为相反数', (() => {
    for (let t = 0; t < 50; t++) {
      const bd = randomBoard(12);
      if (AI.evaluate(bd, X) !== -AI.evaluate(bd, O)) return false;
    }
    return true;
  })());
}

/* 评估要给中心更高的权重：同样一条三，摆在天元附近应当比摆在边上值钱 */
{
  const mid = GM.createBoard();
  mid[GM.idx(7, 6)] = X; mid[GM.idx(7, 7)] = X; mid[GM.idx(7, 8)] = X;
  const edge = GM.createBoard();
  edge[GM.idx(0, 3)] = X; edge[GM.idx(0, 4)] = X; edge[GM.idx(0, 5)] = X;
  check('中路的三比边上的三值钱',
    AI.evaluate(mid, X) > AI.evaluate(edge, X),
    `${AI.evaluate(mid, X)} vs ${AI.evaluate(edge, X)}`);
  check('一条活三有明显正分', AI.evaluate(mid, X) > 400, AI.evaluate(mid, X));
  check('一个四的分远高于一个三', (() => {
    const four = GM.createBoard();
    four[GM.idx(7, 4)] = X; four[GM.idx(7, 5)] = X; four[GM.idx(7, 6)] = X; four[GM.idx(7, 7)] = X;
    return AI.evaluate(four, X) > AI.evaluate(mid, X) * 2;
  })());
}

/* ---------- 2. 战术 ---------- */
console.log('\n战术：');

/* 2.1 自己能成五就成五 */
{
  const bd = GM.createBoard();
  for (let c = 2; c <= 5; c++) bd[GM.idx(7, c)] = X;   /* X 冲四，右端 (7,6) 成五 */
  bd[GM.idx(7, 1)] = O;                                 /* 左端被堵 */
  bd[GM.idx(0, 0)] = O;
  const m = AI.search(bd, X, 4, 2000, 0);
  check('有成五点就落子成五', m === GM.idx(7, 6), `走了 ${coord(m)}`);
}

/* 2.2 对手冲四必须堵 */
{
  const bd = GM.createBoard();
  for (let c = 2; c <= 5; c++) bd[GM.idx(7, c)] = O;
  bd[GM.idx(7, 1)] = X;                                 /* 左端已堵，只剩 (7,6) */
  bd[GM.idx(0, 0)] = X; bd[GM.idx(0, 1)] = X;
  const m = AI.search(bd, X, 4, 2000, 0);
  check('对手冲四时堵住唯一的成五点', m === GM.idx(7, 6), `走了 ${coord(m)}`);
}

/* 2.3 对手跳四（X X _ X X）也要堵在空档 */
{
  const bd = GM.createBoard();
  bd[GM.idx(5, 3)] = O; bd[GM.idx(5, 4)] = O; bd[GM.idx(5, 6)] = O; bd[GM.idx(5, 7)] = O;
  bd[GM.idx(0, 0)] = X; bd[GM.idx(0, 2)] = X;
  const m = AI.search(bd, X, 4, 2000, 0);
  check('对手跳四时堵空档', m === GM.idx(5, 5), `走了 ${coord(m)}`);
}

/* 2.4 对手活三要挡（挡哪头都行，但不能不理） */
{
  const bd = GM.createBoard();
  bd[GM.idx(7, 6)] = O; bd[GM.idx(7, 7)] = O; bd[GM.idx(7, 8)] = O;
  bd[GM.idx(10, 10)] = X; bd[GM.idx(11, 11)] = X;       /* X 自己也有点东西，免得它乱走 */
  const m = AI.search(bd, X, 4, 3000, 0);
  const good = [GM.idx(7, 5), GM.idx(7, 9), GM.idx(7, 4), GM.idx(7, 10)];
  check('对手活三时做出应对', good.indexOf(m) >= 0, `走了 ${coord(m)}`);
}

/* 2.5 自己能成五时不去堵对手（先赢再说） */
{
  const bd = GM.createBoard();
  for (let c = 2; c <= 5; c++) bd[GM.idx(3, c)] = X;    /* X 的冲四 */
  for (let c = 2; c <= 5; c++) bd[GM.idx(9, c)] = O;    /* O 的冲四 */
  bd[GM.idx(3, 1)] = O; bd[GM.idx(9, 1)] = X;
  const m = AI.search(bd, X, 4, 2000, 0);
  check('有杀先杀，不去补防', m === GM.idx(3, 6), `走了 ${coord(m)}`);
}

/* 2.6 对手双四挡不住时，不返回非法着法就好 */
{
  const bd = GM.createBoard();
  bd[GM.idx(4, 4)] = O; bd[GM.idx(4, 5)] = O; bd[GM.idx(4, 6)] = O; bd[GM.idx(4, 7)] = O;
  bd[GM.idx(8, 4)] = O; bd[GM.idx(8, 5)] = O; bd[GM.idx(8, 6)] = O; bd[GM.idx(8, 7)] = O;
  bd[GM.idx(0, 0)] = X;
  const m = AI.search(bd, X, 4, 2000, 0);
  check('双四局面下仍然给出合法着法', m >= 0 && bd[m] === 0, `走了 ${coord(m)}`);
}

/* ---------- 3. 搜索的通用性质 ---------- */
console.log('\n搜索：');
{
  const bd = GM.createBoard();
  bd[GM.idx(7, 7)] = X;

  const t0 = Date.now();
  const m = AI.search(bd, O, 4, 3000, 0);
  const dt = Date.now() - t0;
  check('返回的是空点', m >= 0 && m < GM.CELLS && bd[m] === 0, `走了 ${coord(m)}`);
  check('4 层搜索在 3 秒内完成', dt < 3000, `${dt}ms`);
  console.log(`   深度 ${AI.lastInfo().depth} · ${AI.lastInfo().nodes} 结点 · ${dt}ms`);

  /* 空盘：只有天元可下 */
  const empty = GM.createBoard();
  const m0 = AI.search(empty, X, 4, 1000, 0);
  check('空盘落在天元', m0 === GM.idx(7, 7), `走了 ${coord(m0)}`);

  /* 下满的棋盘：没有着法可给 */
  const full = GM.createBoard();
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) full[GM.idx(r, c)] = ((r + c) % 2 ? X : O);
  check('棋盘下满时返回 null', AI.search(full, X, 2, 500, 0) === null);
}

/* ---------- 4. 三档难度的耗时 ----------
 * 这里的参数和 js/game.js 里的 DIFFICULTY 保持一致，改一边记得改另一边。
 */
console.log('\n各档耗时（中局 16 子，10 次取平均）：');
{
  const TIERS = [['简单', 2, 600, 500], ['普通', 6, 2000, 0], ['困难', 14, 6000, 0]];
  for (const [name, depth, time, margin] of TIERS) {
    let sumDepth = 0, sumNodes = 0, sumTime = 0, worst = 0, over = 0;
    const rounds = 10;
    for (let i = 0; i < rounds; i++) {
      const bd = randomBoard(16);
      const side = i % 2 ? O : X;
      const t0 = Date.now();
      AI.search(bd, side, depth, time, margin);
      const dt = Date.now() - t0;
      sumDepth += AI.lastInfo().depth;
      sumNodes += AI.lastInfo().nodes;
      sumTime += dt;
      if (dt > worst) worst = dt;
      if (dt > time + 1500) over++;     /* 时间检查每 512 个结点才做一次，允许一点超出 */
    }
    console.log(`   ${name}: 平均深度 ${(sumDepth / rounds).toFixed(1)} · ` +
      `${(sumNodes / rounds / 1000).toFixed(0)}k 结点 · 平均 ${(sumTime / rounds).toFixed(0)}ms · 最慢 ${worst}ms`);
    check(`${name}档在自己预算内收手`, over === 0, `${over}/${rounds} 次超时`);
  }
}

/* ---------- 5. 开局库 ---------- */
console.log('\n开局库：');
{
  const legal = GM.genMoves(GM.createBoard(), []);
  const m0 = AI.bookMove([], legal);
  check('第一手落在天元', m0 === GM.idx(7, 7), coord(m0));

  let allLegal = true;
  for (const line of [[], [GM.idx(7, 7)], [GM.idx(7, 7), GM.idx(6, 6)]]) {
    const bd = GM.createBoard();
    let side = X;
    for (const mv of line) { bd[mv] = side; side = -side; }
    const mv = AI.bookMove(line, GM.genMoves(bd, []));
    if (mv >= 0 && bd[mv] !== 0) allLegal = false;
  }
  check('库里给出的着法都落在空点上', allLegal);

  check('走完库里的线之后查不到着法（返回 -1）', (() => {
    const played = [GM.idx(7, 7), GM.idx(6, 6), GM.idx(7, 8), GM.idx(8, 7), GM.idx(7, 6),
      GM.idx(6, 7), GM.idx(8, 8), GM.idx(6, 8), GM.idx(8, 6), GM.idx(5, 5), GM.idx(9, 9)];
    return AI.bookMove(played, GM.genMoves(GM.createBoard(), [])) === -1;
  })());
}

/* ---------- 6. 自我对弈 ---------- */
console.log('\n自我对弈（普通档，最多 120 手）：');
{
  const bd = GM.createBoard();
  let side = X, moves = 0, illegal = 0, winner = 0;
  const t0 = Date.now();

  while (moves < 120) {
    const m = AI.search(bd, side, 4, 400, 0);
    if (m === null) break;
    if (m < 0 || m >= GM.CELLS || bd[m] !== 0) { illegal++; break; }
    bd[m] = side;
    moves++;
    if (GM.wins(bd, m)) { winner = side; break; }
    side = -side;
  }

  const dt = Date.now() - t0;
  check('全程没有非法着法', illegal === 0, `${illegal} 次`);
  check('对局能自然收束（分出胜负或走满）', winner !== 0 || moves >= 120 || GM.isFull(bd),
    `走了 ${moves} 手`);
  console.log(`   ${moves} 手，${winner === X ? 'X 胜' : winner === O ? 'O 胜' : '未分胜负'}，共 ${(dt / 1000).toFixed(1)}s`);
  if (winner !== 0) {
    check('胜方确实连成了五', GM.longestRun(bd, winner) >= 5,
      `最长 ${GM.longestRun(bd, winner)} 连`);
  }
}

console.log('\n' + (pass ? '全部通过' : '存在失败项'));
process.exit(pass ? 0 : 1);
