/*
 * 联机模块测试
 * 覆盖两块纯逻辑：房号生成/规范化，以及自写的极简 MQTT 编解码。
 * 不碰 WebSocket 和 RTCPeerConnection，所以能在 bun 里直接跑。
 * 运行：bun test/online.js
 */
const fs = require('fs');
const path = require('path');

const g = { TextEncoder, TextDecoder };
new Function('window', fs.readFileSync(path.join(__dirname, '../js/online.js'), 'utf8'))(g);
const NET = g.GomokuOnline;
const M = NET.mqtt;

let pass = true;
const check = (name, cond, extra) => {
  if (!cond) pass = false;
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + (extra || '')}`);
};

/* ---------- 1. 房号 ---------- */
console.log('房号：');
const codes = new Set();
for (let i = 0; i < 3000; i++) codes.add(NET.makeRoomCode());
check('长度恒为 5', [...codes].every(c => c.length === 5));
check('只用无歧义字符', [...codes].every(c => /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$/.test(c)),
  [...codes].find(c => !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$/.test(c)));
check('不含 0/O/1/I', [...codes].every(c => !/[0O1I]/.test(c)));
check('3000 次几乎不重复（随机性够）', codes.size > 2990, `实际 ${codes.size} 个不同`);

check('规范化：转大写', NET.normalizeCode('abcde') === 'ABCDE');
check('规范化：剔除非字母数字', NET.normalizeCode(' a b-c d ' ) === 'ABCD');
check('规范化：只取前 5 位', NET.normalizeCode('ABCDEFGH') === 'ABCDE');
check('规范化：空值安全', NET.normalizeCode(null) === '' && NET.normalizeCode(undefined) === '');
/* 中文输入法常打出全角，不能整段丢掉 */
check('规范化：全角字母折半角', NET.normalizeCode('ＡＢＣＤＥ') === 'ABCDE');
check('规范化：全角数字折半角', NET.normalizeCode('１２３４５') === '12345');
check('规范化：全角小写也能用', NET.normalizeCode('ａｂｃ２３') === 'ABC23');
check('规范化：全角空格被忽略', NET.normalizeCode('ＡＢ　ＣＤ') === 'ABCD');

check('主题名带房号与角色',
  NET.topicOf('ABC23', 'o') === 'gomoku/v1/ABC23/o' &&
  NET.topicOf('ABC23', 'a') === 'gomoku/v1/ABC23/a');

/* ---------- 2. MQTT 剩余长度变长整数 ---------- */
console.log('\nMQTT 剩余长度编码：');
const cases = [[0, [0]], [127, [127]], [128, [0x80, 1]], [16383, [0xFF, 0x7F]], [16384, [0x80, 0x80, 1]]];
check('边界值编码正确', cases.every(([n, exp]) => JSON.stringify(M.encodeLength(n)) === JSON.stringify(exp)),
  cases.map(([n]) => n + '->' + M.encodeLength(n).join(',')).join('  '));

/* ---------- 3. 组包 ---------- */
console.log('\nMQTT 组包：');
const connect = M.buildConnect('gm123456', 30);
check('CONNECT 报文类型为 1', (connect[0] >> 4) === 1);
check('CONNECT 含协议名 MQTT', new TextDecoder().decode(connect).indexOf('MQTT') > 0);

const sub = M.buildSubscribe(1, 'gomoku/v1/ABC23/o');
check('SUBSCRIBE 报文类型为 8 且低两位为 0b10', (sub[0] >> 4) === 8 && (sub[0] & 3) === 2);

const pub = M.buildPublish('gomoku/v1/ABC23/o', '{"a":1}', true);
check('PUBLISH 报文类型为 3', (pub[0] >> 4) === 3);
check('retain 位置位', (pub[0] & 1) === 1);
const pubNoRetain = M.buildPublish('t', 'x', false);
check('不保留时 retain 位为 0', (pubNoRetain[0] & 1) === 0);

/* ---------- 4. 解包：自己组的包自己必须能解回来 ---------- */
console.log('\nMQTT 解包：');
function feed(bytes) {
  const res = M.decodePackets(bytes);
  return { packets: res[0], rest: res[1] };
}

let r = feed(pub);
check('单个 PUBLISH 能解出', r.packets.length === 1 && r.rest.length === 0);
check('解出的头里带 retain 标志', r.packets[0].flags === 1);
check('不保留时标志为 0', feed(pubNoRetain).packets[0].flags === 0);
let p = M.parsePublish(r.packets[0].body);
check('解出的主题正确', p.topic === 'gomoku/v1/ABC23/o', p.topic);
check('解出的载荷正确', p.payload === '{"a":1}', p.payload);

/* 粘包：两个包拼在一起 */
const two = new Uint8Array(pub.length + pubNoRetain.length);
two.set(pub); two.set(pubNoRetain, pub.length);
r = feed(two);
check('粘包能解出两个', r.packets.length === 2 && r.rest.length === 0);
check('粘包内容分别正确',
  M.parsePublish(r.packets[0].body).topic === 'gomoku/v1/ABC23/o' &&
  M.parsePublish(r.packets[1].body).payload === 'x');

/* 拆包：从中间切断，先出半个包 */
const half = pub.slice(0, 6);
const restBytes = pub.slice(6);
r = feed(half);
check('半个包时不产出结果，且原样留作残留', r.packets.length === 0 && r.rest.length === 6);
const merged = new Uint8Array(r.rest.length + restBytes.length);
merged.set(r.rest); merged.set(restBytes, r.rest.length);
r = feed(merged);
check('补齐后能解出完整包', r.packets.length === 1 && M.parsePublish(r.packets[0].body).payload === '{"a":1}');

/* 三个包逐字节喂进去，应恰好解出三个 */
const three = new Uint8Array(pub.length * 3);
three.set(pub); three.set(pub, pub.length); three.set(pub, pub.length * 2);
let leftover = new Uint8Array(0);
let got = 0;
for (let i = 0; i < three.length; i++) {
  const m = new Uint8Array(leftover.length + 1);
  m.set(leftover); m[i - leftover.length >= 0 ? 0 : 0] = 0;
  // 逐字节喂：把新字节接在残留后面
  const merged2 = new Uint8Array(leftover.length + 1);
  merged2.set(leftover);
  merged2[leftover.length] = three[i];
  const rr = M.decodePackets(merged2);
  got += rr[0].length;
  leftover = rr[1];
}
check('逐字节喂 3 个包也能全部解出', got === 3, `解出 ${got} 个`);

/* 空载荷（清除 retained 用的就是空载荷） */
const emptyPub = M.buildPublish('gomoku/v1/ABC23/o', '', true);
const ep = M.parsePublish(M.decodePackets(emptyPub)[0][0].body);
check('空载荷能正常编解码（用于清除 retained）', ep.topic === 'gomoku/v1/ABC23/o' && ep.payload === '');

/* 中文载荷不能乱码 */
const zh = M.buildPublish('t/中文', '你好，开始吧', false);
const zp = M.parsePublish(M.decodePackets(zh)[0][0].body);
check('UTF-8 主题与载荷往返正确', zp.topic === 't/中文' && zp.payload === '你好，开始吧',
  zp.topic + ' / ' + zp.payload);

/* ---------- 5. 配置 ---------- */
console.log('\n配置：');
check('至少配置了一个公共 broker', NET.brokers.length >= 1, NET.brokers.join(', '));
check('全部使用 wss', NET.brokers.every(u => u.indexOf('wss://') === 0));

console.log(pass ? '\n全部通过 ✓' : '\n存在失败项 ✗');
process.exit(pass ? 0 : 1);
