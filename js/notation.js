/*
 * 五子棋记谱
 *
 * 五子棋不像象棋那样有"炮二平五"式的着法名——每个着法就是"下在哪个格子"，
 * 所以标准记法就是坐标：列用字母 A~O（自左向右），行用数字 1~15（自下向上）。
 * 天元（正中央）写作 H8，也常直接叫"天元"。
 */
(function (global) {
  'use strict';

  var GM = global.Gomoku;
  var FILES = 'ABCDEFGHIJKLMNO';      /* 15 列，含 I —— 五子棋惯例不跳过它 */

  /* 格子编号 -> 坐标，例如 112 -> "H8" */
  function toCoord(m) {
    if (m === null || m === undefined || m < 0) return '??';
    return FILES.charAt(GM.colOf(m)) + (GM.N - GM.rowOf(m));
  }

  /* 坐标 -> 格子编号，解析不了返回 -1 */
  function fromCoord(text) {
    var s = String(text == null ? '' : text).trim().toUpperCase();
    var m = /^([A-O])(1[0-5]|[1-9])$/.exec(s);
    if (!m) return -1;
    return GM.idx(GM.N - Number(m[2]), FILES.indexOf(m[1]));
  }

  /* 几个有名字的点，鼠标悬停时给个提示 */
  var NAMED = {};
  NAMED[GM.idx(7, 7)] = '天元';

  function pointName(m) { return NAMED[m] || ''; }

  global.GomokuNotation = {
    toCoord: toCoord,
    fromCoord: fromCoord,
    pointName: pointName
  };
})(window);
