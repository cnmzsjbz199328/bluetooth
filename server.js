/**
 * server.js — 切西瓜游戏局域网服务器
 * 
 * 功能：
 *   - HTTPS 静态文件服务（用于手机端 WSS 连接）
 *   - WebSocket 服务（中继手机陀螺仪数据到游戏页面）
 *   - 支持 HTTP 降级模式（开发调试用）
 * 
 * 运行：node server.js
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const os = require('os');

// ─── 配置 ──────────────────────────────────────────────────────────────────
const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'cert');

// ─── MIME 类型 ─────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.pem':  'application/x-pem-file',
};

// ─── 获取本机局域网 IP ─────────────────────────────────────────────────────
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

// ─── 请求处理器 ────────────────────────────────────────────────────────────
function requestHandler(req, res) {
  const urlPath = req.url.split('?')[0];

  // 特殊路由：提供证书下载（方便手机安装信任）
  if (urlPath === '/cert' || urlPath === '/cert.pem') {
    const certPath = path.join(CERT_DIR, 'cert.pem');
    if (fs.existsSync(certPath)) {
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename=fruit-game-cert.pem'
      });
      fs.createReadStream(certPath).pipe(res);
      return;
    }
  }

  // 静态文件服务
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'game.html' : urlPath);
  const ext = path.extname(filePath);

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ─── 创建服务器 ────────────────────────────────────────────────────────────
let server;
const certPath = path.join(CERT_DIR, 'cert.pem');
const keyPath  = path.join(CERT_DIR, 'key.pem');
const httpMode = fs.existsSync(path.join(CERT_DIR, '.http-mode'));

if (!httpMode && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  // HTTPS 模式（推荐：手机访问 wss://）
  const sslOptions = {
    cert: fs.readFileSync(certPath),
    key:  fs.readFileSync(keyPath),
  };
  server = https.createServer(sslOptions, requestHandler);
  console.log('🔒 HTTPS 模式启动');
} else {
  // HTTP 降级模式（仅用于开发调试）
  server = http.createServer(requestHandler);
  console.log('⚠️  HTTP 模式启动（手机端 WSS 连接将不可用，仅限本地调试）');
}

// ─── WebSocket 服务 ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// 客户端角色注册表
const clients = {
  game: new Set(),       // 电脑游戏页面
  controller: new Set(), // 手机控制页面
};

// 连接统计
let totalConnections = 0;

wss.on('connection', (ws, req) => {
  totalConnections++;
  const id = totalConnections;
  const ip = req.socket.remoteAddress;
  let role = 'unknown';

  console.log(`\n🔌 [${id}] 新连接来自 ${ip}`);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // 角色注册
      if (msg.type === 'register') {
        role = msg.role; // 'game' | 'controller'
        clients[role]?.add(ws);
        console.log(`📋 [${id}] 注册为 ${role}，当前 game:${clients.game.size} controller:${clients.controller.size}`);

        // 通知游戏页面控制器已连接
        if (role === 'controller') {
          broadcast('game', { type: 'controller_connected', id });
          // 通知控制器游戏端状态
          ws.send(JSON.stringify({
            type: 'status',
            gameConnected: clients.game.size > 0,
          }));
        }
        if (role === 'game') {
          broadcast('controller', { type: 'game_connected' });
        }
        return;
      }

      // 陀螺仪数据转发：controller → game
      if (msg.type === 'gyro' || msg.type === 'gesture') {
        broadcast('game', msg);
        return;
      }

      // 游戏事件反馈：game → controller（震动、得分等）
      if (msg.type === 'feedback') {
        broadcast('controller', msg);
        return;
      }

      // 心跳
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
        return;
      }

    } catch (e) {
      console.warn(`⚠️  [${id}] 消息解析失败:`, e.message);
    }
  });

  ws.on('close', () => {
    clients.game.delete(ws);
    clients.controller.delete(ws);
    console.log(`❌ [${id}] 断开连接 (role: ${role})`);

    if (role === 'controller') {
      broadcast('game', { type: 'controller_disconnected' });
    }
    if (role === 'game') {
      broadcast('controller', { type: 'game_disconnected' });
    }
  });

  ws.on('error', (err) => {
    console.error(`💥 [${id}] WebSocket 错误:`, err.message);
  });
});

/**
 * 广播消息给指定角色的所有客户端
 */
function broadcast(role, data) {
  const targets = clients[role];
  if (!targets || targets.size === 0) return;

  const payload = JSON.stringify(data);
  for (const client of targets) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

// ─── 启动服务器 ────────────────────────────────────────────────────────────
// Cloudflare 控制器页面地址（修改为你实际的 Pages 域名）
const CLOUDFLARE_URL = 'https://bluetooth-72w.pages.dev';

server.listen(PORT, '0.0.0.0', () => {
  const localIPs = getLocalIPs();
  const protocol   = server instanceof https.Server ? 'https' : 'http';
  const wsProtocol = server instanceof https.Server ? 'wss'   : 'ws';
  const line = '─'.repeat(54);

  console.log('\n🍉 切西瓜游戏服务器已启动！');
  console.log(line);

  // ── 电脑端游戏页面 ──────────────────────────────────────
  console.log('📺 游戏页面（电脑 Chrome 打开）:');
  console.log(`   ${protocol}://localhost:${PORT}/game.html`);
  console.log('');

  // ── 手机控制器（带 IP 预填的完整链接）──────────────────
  console.log('📱 手机控制器（直接点击/扫码，IP 已预填）:');
  localIPs.forEach(ip => {
    const controllerURL = `${CLOUDFLARE_URL}/?ip=${ip}&port=${PORT}`;
    console.log(`   ${controllerURL}`);
  });
  console.log('');

  // ── 证书安装（首次使用）────────────────────────────────
  if (protocol === 'https') {
    console.log('📜 手机安装证书（仅首次，之后无需重复）:');
    localIPs.forEach(ip => {
      console.log(`   ${protocol}://${ip}:${PORT}/cert`);
    });
    console.log('');
  }

  console.log(line);
  console.log('💡 提示：将控制器链接发送到手机（微信/AirDrop 等），');
  console.log('   打开后 IP 自动填好，点「连接并开始」即可！');
  console.log(line);
});
