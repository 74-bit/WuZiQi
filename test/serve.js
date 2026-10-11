/*
 * 静态文件服务，把项目根目录托管到 http://127.0.0.1:8080
 *
 * 用途：
 *   1. 本机自测联机（file:// 被视为安全上下文，会拦掉 ws:// 中转，
 *      换成 http:// 就没这个限制）
 *   2. 局域网内给别人玩：bun test/serve.js 0.0.0.0 8080
 *
 * 运行：bun test/serve.js [host] [port]
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const HOST = process.argv[2] || '127.0.0.1';
const PORT = Number(process.argv[3]) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch(req) {
    let rel = decodeURIComponent(new URL(req.url).pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    /* 只允许访问项目目录内的文件 */
    const full = path.normalize(path.join(ROOT, rel));
    if (!full.startsWith(ROOT)) return new Response('禁止访问', { status: 403 });
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      return new Response('找不到 ' + rel, { status: 404 });
    }
    return new Response(Bun.file(full), {
      headers: {
        'content-type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store'
      }
    });
  }
});

console.log('静态服务已启动: http://' + HOST + ':' + server.port);
if (HOST === '0.0.0.0') {
  console.log('局域网内可用 http://<你的IP>:' + server.port + ' 访问');
}
