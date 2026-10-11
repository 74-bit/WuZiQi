/*
 * 用来做联机自测的最小 MQTT broker（只跑在本机，不对外）。
 *
 * 支持 CONNECT / SUBSCRIBE / PUBLISH(QoS0) / PINGREQ，以及 retained 消息——
 * 联机碰头正是靠 retained：加入方晚于房主订阅，也得能收到那条 offer。
 *
 * 运行：bun test/mqtt-broker.js [端口]
 * 然后打开 index.html?broker=ws://localhost:9001
 *
 * 说明：这里复用了 js/online.js 的编解码函数。报文格式本身已由
 * test/online.js 按 MQTT 规范逐字节校验过，所以这个 broker 主要用来验证
 * "订阅、retained、消息路由"这些流程层面的东西。
 */
const fs = require('fs');
const path = require('path');

const g = { TextEncoder, TextDecoder };
new Function('window', fs.readFileSync(path.join(__dirname, '../js/online.js'), 'utf8'))(g);
const M = g.XiangqiOnline.mqtt;

const PORT = Number(process.argv[2]) || 9001;

const clients = new Set();
const retained = new Map();      // topic -> payload 字符串
const stats = { connect: 0, subscribe: 0, publish: 0, delivered: 0 };

function send(ws, bytes) {
  try { ws.send(bytes); } catch (e) { /* 客户端可能已断开 */ }
}

function suback(packetId) {
  return new Uint8Array([0x90, 0x03, (packetId >> 8) & 255, packetId & 255, 0x00]);
}

function handle(ws, bytes) {
  const res = M.decodePackets(bytes);
  ws.leftover = res[1];

  for (const pkt of res[0]) {
    if (pkt.type === 1) {                       // CONNECT
      stats.connect++;
      ws.topics = ws.topics || new Set();
      send(ws, new Uint8Array([0x20, 0x02, 0x00, 0x00]));   // CONNACK 接受
    } else if (pkt.type === 8) {                // SUBSCRIBE
      const packetId = (pkt.body[0] << 8) | pkt.body[1];
      const tlen = (pkt.body[2] << 8) | pkt.body[3];
      const topic = new TextDecoder().decode(pkt.body.slice(4, 4 + tlen));
      ws.topics = ws.topics || new Set();
      ws.topics.add(topic);
      stats.subscribe++;
      send(ws, suback(packetId));

      /* 把该主题上留存的最后一条消息补发给新订阅者 */
      if (retained.has(topic)) {
        const payload = retained.get(topic);
        if (payload !== '') {
          send(ws, M.buildPublish(topic, payload, false));
          stats.delivered++;
        }
      }
    } else if (pkt.type === 3) {                // PUBLISH
      stats.publish++;
      const p = M.parsePublish(pkt.body);
      const isRetain = (pkt.flags & 1) === 1;
      if (isRetain) {
        if (p.payload === '') retained.delete(p.topic);
        else retained.set(p.topic, p.payload);
      }
      for (const other of clients) {
        if (other === ws) continue;
        if (other.topics && other.topics.has(p.topic)) {
          send(other, M.buildPublish(p.topic, p.payload, false));
          stats.delivered++;
        }
      }
    } else if (pkt.type === 12) {               // PINGREQ
      send(ws, new Uint8Array([0xD0, 0x00]));
    }
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(req, srv) {
    if (srv.upgrade(req)) return undefined;
    return new Response('xiangqi mqtt broker\n' + JSON.stringify(stats), {
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  },
  websocket: {
    open(ws) { ws.topics = new Set(); clients.add(ws); },
    message(ws, data) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      const merged = new Uint8Array((ws.leftover ? ws.leftover.length : 0) + bytes.length);
      if (ws.leftover) merged.set(ws.leftover);
      merged.set(bytes, ws.leftover ? ws.leftover.length : 0);
      try { handle(ws, merged); } catch (e) { console.error('解析失败', e); }
    },
    close(ws) { clients.delete(ws); },
    drain(ws) { /* 不处理背压 */ }
  }
});

console.log('MQTT broker 已启动: ws://127.0.0.1:' + server.port);
console.log('打开 index.html?broker=ws://127.0.0.1:' + server.port + ' 即可用本地中转测试');

process.on('SIGTERM', () => { server.stop(); process.exit(0); });
