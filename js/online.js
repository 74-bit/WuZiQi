/*
 * 联机对战
 *
 * WebRTC 的 DTLS 指纹由浏览器随机生成、无法压缩，一条完整的连接信息
 * 最少也要 100 字节上下，塞进 5 个字符是物理上做不到的。
 * 所以这里借一个免费的公共 MQTT broker 当"碰头点"：
 * 5 位房号只是房间名，真正的 offer/answer 由 broker 转发。
 *
 * 流程（双方都先订阅、再发布，配合 retained 消息避免抢跑）：
 *   房主  订阅 xxx/a -> 生成 offer -> retained 发布到 xxx/o
 *   加入方 订阅 xxx/o -> 收到 retained 的 offer -> 应答 -> retained 发布到 xxx/a
 *   房主  收到 answer -> setRemoteDescription -> 数据通道建立
 *
 * MQTT 客户端是自己写的：只用到 CONNECT / SUBSCRIBE / PUBLISH(QoS0) / PING，
 * 为此引一个上百 KB 的 CDN 库不划算，而且 CDN 在部分网络下并不好访问。
 */
(function (global) {
  'use strict';

  /* ---- 房号：5 位，字母表去掉了 0/O/1/I 这些容易看混的字符 ---- */
  var CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  var CODE_LEN = 5;

  function makeRoomCode() {
    var buf = new Uint8Array(CODE_LEN);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(buf);
    } else {
      for (var k = 0; k < CODE_LEN; k++) buf[k] = Math.floor(Math.random() * 256);
    }
    var s = '';
    for (var i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET.charAt(buf[i] % CODE_ALPHABET.length);
    return s;
  }

  /*
   * 中文输入法下很容易打出全角的字母数字，先折半角再过滤，
   * 否则用户输入"ＡＢＣ１２"会被整段丢掉、看起来像没反应。
   * 全角 Ａ-Ｚ ａ-ｚ ０-９ 各自与半角相差 0xFEE0。
   */
  function toHalfWidth(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xFF01 && c <= 0xFF5E) out += String.fromCharCode(c - 0xFEE0);
      else if (c === 0x3000) out += ' ';
      else out += s.charAt(i);
    }
    return out;
  }

  function normalizeCode(s) {
    return toHalfWidth(String(s == null ? '' : s))
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, '')
      .slice(0, CODE_LEN);
  }

  function topicOf(room, kind) {
    return 'gomoku/v1/' + room + '/' + kind;
  }

  /* ================= 极简 MQTT 3.1.1 ================= */

  /* 剩余长度用 7 位一组的变长整数 */
  function encodeLength(n) {
    var out = [];
    do {
      var b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      out.push(b);
    } while (n > 0);
    return out;
  }

  function utf8Bytes(str) {
    return Array.prototype.slice.call(new TextEncoder().encode(str));
  }

  function u16(n) { return [(n >> 8) & 255, n & 255]; }

  function buildConnect(clientId, keepalive) {
    var id = utf8Bytes(clientId);
    var body = []
      .concat([0, 4], utf8Bytes('MQTT'))    /* 协议名 */
      .concat([4, 0x02])                    /* 版本 3.1.1 + clean session */
      .concat(u16(keepalive || 30))
      .concat(u16(id.length), id);
    return new Uint8Array([0x10].concat(encodeLength(body.length), body));
  }

  function buildSubscribe(packetId, topic) {
    var t = utf8Bytes(topic);
    var body = [].concat(u16(packetId), u16(t.length), t, [0]);   /* QoS 0 */
    return new Uint8Array([0x82].concat(encodeLength(body.length), body));
  }

  function buildPublish(topic, payload, retain) {
    var t = utf8Bytes(topic);
    var p = utf8Bytes(payload == null ? '' : payload);
    var body = [].concat(u16(t.length), t, p);
    return new Uint8Array([0x30 | (retain ? 1 : 0)].concat(encodeLength(body.length), body));
  }

  var PINGREQ = new Uint8Array([0xC0, 0x00]);

  /*
   * 从字节流里切出完整的数据包。
   * WebSocket 不保证一条消息就是一个 MQTT 包，可能粘包也可能拆包，
   * 所以返回 [本轮解析出的包, 剩下的半个包]。
   */
  function decodePackets(data) {
    var packets = [];
    var i = 0;
    while (i < data.length) {
      var start = i;
      var head = data[i];
      var type = head >> 4;
      var flags = head & 15;      /* PUBLISH 的 retain 就是最低位 */
      i++;
      var mult = 1, len = 0, b;
      do {
        if (i >= data.length) return [packets, data.slice(start)];
        b = data[i++];
        len += (b & 127) * mult;
        mult *= 128;
      } while (b & 128);
      if (i + len > data.length) return [packets, data.slice(start)];
      packets.push({ type: type, flags: flags, body: data.slice(i, i + len) });
      i += len;
    }
    return [packets, new Uint8Array(0)];
  }

  function parsePublish(body) {
    var tlen = (body[0] << 8) | body[1];
    var topic = new TextDecoder().decode(body.slice(2, 2 + tlen));
    var payload = new TextDecoder().decode(body.slice(2 + tlen));
    return { topic: topic, payload: payload };
  }

  var BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/'
  ];

  /* 自建 broker 时用 ?broker=ws://host:port 覆盖；多个用逗号分隔 */
  try {
    if (global.location && global.location.search) {
      var m = /[?&]broker=([^&]+)/.exec(global.location.search);
      if (m) {
        var custom = decodeURIComponent(m[1]).split(',').map(function (s) { return s.trim(); })
          .filter(function (s) { return s; });
        if (custom.length) BROKERS = custom;
      }
    }
  } catch (e) { /* 忽略 */ }

  function bindClient(ws, initialLeftover) {
    var handlers = { message: null, close: null };
    var leftover = initialLeftover || new Uint8Array(0);
    var subId = 1;

    var client = {
      onMessage: function (fn) { handlers.message = fn; },
      onClose: function (fn) { handlers.close = fn; },
      subscribe: function (topic) { ws.send(buildSubscribe(subId++, topic)); },
      publish: function (topic, payload, retain) { ws.send(buildPublish(topic, payload, retain)); }
    };

    ws.onmessage = function (ev) {
      var data = new Uint8Array(ev.data);
      var merged = new Uint8Array(leftover.length + data.length);
      merged.set(leftover);
      merged.set(data, leftover.length);
      var res = decodePackets(merged);
      leftover = res[1];
      for (var k = 0; k < res[0].length; k++) {
        if (res[0][k].type === 3 && handlers.message) {   /* PUBLISH */
          var m = parsePublish(res[0][k].body);
          handlers.message(m.topic, m.payload);
        }
        /* CONNACK / SUBACK / PINGRESP 不需要额外处理 */
      }
    };
    ws.onclose = function () { clearInterval(pingTimer); if (handlers.close) handlers.close(); };
    ws.onerror = function () { /* 之后必然触发 onclose */ };

    var pingTimer = setInterval(function () {
      if (ws.readyState === 1) ws.send(PINGREQ);
    }, 25000);

    client.stop = function () {
      clearInterval(pingTimer);
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try { ws.close(); } catch (e) { /* 忽略 */ }
    };
    return client;
  }

  function connectBroker(url, clientId) {
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket(url); } catch (e) { reject(new Error('无法建立连接')); return; }
      ws.binaryType = 'arraybuffer';

      var done = false;
      var leftover = new Uint8Array(0);
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { ws.close(); } catch (e) { /* 忽略 */ }
        reject(new Error('握手超时'));
      }, 6000);

      ws.onopen = function () { ws.send(buildConnect(clientId, 30)); };
      ws.onerror = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error('连接失败'));
      };
      ws.onmessage = function (ev) {
        if (done) return;
        var data = new Uint8Array(ev.data);
        var merged = new Uint8Array(leftover.length + data.length);
        merged.set(leftover);
        merged.set(data, leftover.length);
        var res = decodePackets(merged);
        leftover = res[1];
        for (var k = 0; k < res[0].length; k++) {
          if (res[0][k].type === 2) {      /* CONNACK */
            done = true;
            clearTimeout(timer);
            ws.onerror = null;
            resolve(bindClient(ws, leftover));
            return;
          }
        }
      };
    });
  }

  /* 依次试几个公共 broker，第一个握手成功就用它 */
  function connectAnyBroker(clientId) {
    var idx = 0;
    function attempt() {
      if (idx >= BROKERS.length) {
        return Promise.reject(new Error('连不上公共中转服务器，请检查网络'));
      }
      return connectBroker(BROKERS[idx++], clientId).catch(attempt);
    }
    return attempt();
  }

  /* ================= WebRTC ================= */

  function waitIceComplete(peer) {
    return new Promise(function (resolve) {
      if (peer.iceGatheringState === 'complete') return resolve();
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        peer.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
      function onChange() {
        if (peer.iceGatheringState === 'complete') finish();
      }
      peer.addEventListener('icegatheringstatechange', onChange);
      setTimeout(finish, 4000);
    });
  }

  function createSession() {
    var pc = null;
    var dc = null;
    var mqtt = null;
    var room = '';
    var isHost = false;
    var joinTimer = null;
    var joinSettle = null;
    var handlers = {};
    var selfId = 'gm' + Math.random().toString(36).slice(2, 10);

    function emit(name, arg) {
      var h = handlers[name];
      if (h) h(arg);
    }
    function on(name, fn) { handlers[name] = fn; }

    function createPeer() {
      var peer = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      });
      peer.addEventListener('connectionstatechange', function () {
        var st = peer.connectionState;
        if (st === 'failed') emit('close', '连接失败（双方可能都在严格 NAT 后面）');
        else if (st === 'disconnected') emit('close', '连接已断开');
      });
      return peer;
    }

    function bindChannel(channel) {
      dc = channel;
      dc.addEventListener('open', function () {
        clearRetained();
        emit('open');
      });
      dc.addEventListener('close', function () { emit('close', '对方已断开'); });
      dc.addEventListener('message', function (e) {
        var msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        emit('message', msg);
      });
    }

    /* 连上之后把中转上留下的 retained 消息清掉，别给 broker 留垃圾。
       顺带也让同一个房号不会被后来的人误接。 */
    function clearRetained() {
      if (!mqtt) return;
      try {
        mqtt.publish(topicOf(room, 'o'), '', true);
        mqtt.publish(topicOf(room, 'a'), '', true);
      } catch (e) { /* 忽略 */ }
    }

    function teardown() {
      if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }
      joinSettle = null;
      if (dc) { try { dc.close(); } catch (e) { /* 忽略 */ } dc = null; }
      if (pc) { try { pc.close(); } catch (e) { /* 忽略 */ } pc = null; }
      if (mqtt) { try { mqtt.stop(); } catch (e) { /* 忽略 */ } mqtt = null; }
      room = '';
      isHost = false;
    }

    function onBrokerMessage(topic, payload) {
      var msg;
      try { msg = JSON.parse(payload); } catch (e) { return; }
      if (!msg || !msg.type || !msg.sdp) return;

      if (isHost) {
        if (topic !== topicOf(room, 'a')) return;
        if (!pc || pc.currentRemoteDescription) return;
        pc.setRemoteDescription({ type: msg.type, sdp: msg.sdp })
          .catch(function (e) { emit('close', '连接失败：' + e.message); });
        return;
      }

      if (topic !== topicOf(room, 'o')) return;
      if (pc) return;                       /* 已经应答过了 */
      if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }

      pc = createPeer();
      pc.addEventListener('datachannel', function (e) { bindChannel(e.channel); });
      pc.setRemoteDescription({ type: msg.type, sdp: msg.sdp })
        .then(function () { return pc.createAnswer(); })
        .then(function (answer) { return pc.setLocalDescription(answer); })
        .then(function () { return waitIceComplete(pc); })
        .then(function () {
          mqtt.publish(topicOf(room, 'a'),
            JSON.stringify({ type: pc.localDescription.type, sdp: pc.localDescription.sdp }), true);
          if (joinSettle) { joinSettle.resolve(); joinSettle = null; }
        })
        .catch(function (e) {
          if (joinSettle) { joinSettle.reject(e); joinSettle = null; }
          emit('close', '应答失败：' + e.message);
        });
    }

    function openBroker() {
      return connectAnyBroker(selfId).then(function (c) {
        mqtt = c;
        mqtt.onMessage(onBrokerMessage);
        mqtt.onClose(function () { emit('close', '与中转服务器的连接断开'); });
        return c;
      });
    }

    /* 房主：返回 5 位房号，之后静候对方接入 */
    function host() {
      teardown();
      isHost = true;
      room = makeRoomCode();
      return openBroker().then(function (c) {
        c.subscribe(topicOf(room, 'a'));
        pc = createPeer();
        bindChannel(pc.createDataChannel('gomoku', { ordered: true }));
        return pc.createOffer();
      }).then(function (offer) {
        return pc.setLocalDescription(offer);
      }).then(function () {
        return waitIceComplete(pc);
      }).then(function () {
        mqtt.publish(topicOf(room, 'o'),
          JSON.stringify({ type: pc.localDescription.type, sdp: pc.localDescription.sdp }), true);
        return room;
      });
    }

    /* 加入方：拿房号换连接 */
    function join(code) {
      teardown();
      isHost = false;
      room = normalizeCode(code);
      if (room.length !== CODE_LEN) {
        return Promise.reject(new Error('房号应该是 ' + CODE_LEN + ' 位'));
      }
      return openBroker().then(function (c) {
        c.subscribe(topicOf(room, 'o'));
        return new Promise(function (resolve, reject) {
          joinSettle = { resolve: resolve, reject: reject };
          /* 房间里没人（没有 retained 的 offer）就别一直等 */
          joinTimer = setTimeout(function () {
            joinTimer = null;
            joinSettle = null;
            reject(new Error('房间里没人，或者房号不对'));
          }, 12000);
        });
      });
    }

    function send(msg) {
      if (!dc || dc.readyState !== 'open') return false;
      try { dc.send(JSON.stringify(msg)); return true; } catch (e) { return false; }
    }

    function isOpen() { return !!dc && dc.readyState === 'open'; }

    return {
      on: on,
      host: host,
      join: join,
      send: send,
      isOpen: isOpen,
      close: teardown
    };
  }

  var shared = createSession();
  shared.createSession = createSession;
  shared.makeRoomCode = makeRoomCode;
  shared.normalizeCode = normalizeCode;
  shared.topicOf = topicOf;
  shared.brokers = BROKERS.slice();

  /* 导出给测试：MQTT 这层是纯函数，可以脱离浏览器验证 */
  shared.mqtt = {
    encodeLength: encodeLength,
    buildConnect: buildConnect,
    buildSubscribe: buildSubscribe,
    buildPublish: buildPublish,
    decodePackets: decodePackets,
    parsePublish: parsePublish
  };

  global.GomokuOnline = shared;
})(window);
