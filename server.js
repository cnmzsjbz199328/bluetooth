/**
 * server.js — 切西瓜游戏局域网服务器
 *
 * 功能：
 *   - HTTP 静态文件服务（Cloudflare Tunnel 负责 HTTPS，本地无需证书）
 *   - WebSocket 服务（中继手机陀螺仪数据到游戏页面）
 *   - 自动启动 cloudflared 隧道，获取公开 WSS 地址
 *   - 启动后打印带 IP 预填的控制器链接，发给手机直接用
 *
 * 运行：node server.js
 */

'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const { spawn, execSync } = require('child_process');
const { WebSocketServer } = require('ws');
const os     = require('os');

// ─── 配置 ──────────────────────────────────────────────────────────────────
const PORT           = 3000;
const PUBLIC_DIR     = path.join(__dirname, 'public');
const CERT_DIR       = path.join(__dirname, 'cert');
const CLOUDFLARE_URL = 'https://bluetooth-72w.pages.dev';  // Cloudflare Pages 控制器地址
const CF_BIN         = path.join(__dirname, 'cloudflared.exe'); // Windows 可执行文件

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
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}

// ─── 请求处理器 ────────────────────────────────────────────────────────────
function requestHandler(req, res) {
  const urlPath = req.url.split('?')[0];

  // 提供证书下载（HTTPS 模式备用）
  if (urlPath === '/cert' || urlPath === '/cert.pem') {
    const certPath = path.join(CERT_DIR, 'cert.pem');
    if (fs.existsSync(certPath)) {
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename=fruit-game-cert.pem',
      });
      fs.createReadStream(certPath).pipe(res);
      return;
    }
  }

  // 静态文件服务
  const filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'game.html' : urlPath);
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

// ─── 创建服务器（优先 HTTPS，降级 HTTP） ────────────────────────────────────
const certPath = path.join(CERT_DIR, 'cert.pem');
const keyPath  = path.join(CERT_DIR, 'key.pem');
const hasSSL   = fs.existsSync(certPath) && fs.existsSync(keyPath)
                 && !fs.existsSync(path.join(CERT_DIR, '.http-mode'));

let server;
if (hasSSL) {
  server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, requestHandler);
  console.log('🔒 HTTPS 模式（本地访问用，隧道另开）');
} else {
  server = http.createServer(requestHandler);
  console.log('🌐 HTTP 模式（由 Cloudflare Tunnel 提供 HTTPS）');
}

// ─── WebSocket 服务 ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const clients = { game: new Set(), controller: new Set() };
let totalConnections = 0;

wss.on('connection', (ws, req) => {
  totalConnections++;
  const id = totalConnections;
  const ip = req.socket.remoteAddress;
  let role = 'unknown';

  console.log(`🔌 [${id}] 新连接来自 ${ip}`);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'register') {
        role = msg.role;
        clients[role]?.add(ws);
        console.log(`📋 [${id}] 注册为 ${role}，当前 game:${clients.game.size} controller:${clients.controller.size}`);
        if (role === 'controller') {
          broadcast('game', { type: 'controller_connected', id });
          ws.send(JSON.stringify({ type: 'status', gameConnected: clients.game.size > 0 }));
        }
        if (role === 'game') broadcast('controller', { type: 'game_connected' });
        return;
      }

      if (msg.type === 'gyro' || msg.type === 'gesture') { broadcast('game', msg); return; }
      if (msg.type === 'feedback')                        { broadcast('controller', msg); return; }
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); return; }

    } catch (e) {
      console.warn(`⚠️  [${id}] 解析失败:`, e.message);
    }
  });

  ws.on('close', () => {
    clients.game.delete(ws);
    clients.controller.delete(ws);
    console.log(`❌ [${id}] 断开 (role: ${role})`);
    if (role === 'controller') broadcast('game', { type: 'controller_disconnected' });
    if (role === 'game')       broadcast('controller', { type: 'game_disconnected' });
  });

  ws.on('error', (err) => console.error(`💥 [${id}] 错误:`, err.message));
});

function broadcast(role, data) {
  const targets = clients[role];
  if (!targets || targets.size === 0) return;
  const payload = JSON.stringify(data);
  for (const client of targets) {
    if (client.readyState === 1) client.send(payload);
  }
}

// ─── Cloudflare Tunnel 自动启动 ────────────────────────────────────────────
/**
 * 启动 cloudflared 快速隧道，解析出公开 URL，然后打印手机控制器链接。
 * 支持：
 *   1. 本地的 cloudflared.exe（项目目录）
 *   2. 系统 PATH 中的 cloudflared
 */
function startCloudflaredTunnel(localPort, callback) {
  // 寻找 cloudflared 可执行文件
  let cfBin = null;
  const candidates = [
    CF_BIN,                              // 项目目录
    'cloudflared',                        // 系统 PATH
    'C:\\cloudflared\\cloudflared.exe',
  ];

  for (const bin of candidates) {
    try {
      if (bin === 'cloudflared') {
        execSync('cloudflared --version', { stdio: 'pipe' });
        cfBin = bin;
      } else if (fs.existsSync(bin)) {
        cfBin = bin;
      }
      if (cfBin) break;
    } catch (_) {}
  }

  if (!cfBin) {
    callback(new Error('未找到 cloudflared'), null);
    return null;
  }

  console.log(`\n🚇 启动 Cloudflare Tunnel (${cfBin})...`);

  // --url 参数：隧道指向本地服务器
  const localURL = hasSSL ? `https://localhost:${localPort}` : `http://localhost:${localPort}`;
  const cfArgs   = hasSSL
    ? ['tunnel', '--url', localURL, '--no-tls-verify']
    : ['tunnel', '--url', localURL];

  const cf = spawn(cfBin, cfArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  let tunnelURL = null;
  let resolved  = false;

  // cloudflared 把隧道 URL 打印到 stderr
  const onData = (data) => {
    const text = data.toString();
    // 匹配 https://xxx.trycloudflare.com 或 https://xxx.cfargotunnel.com
    const match = text.match(/https:\/\/[a-z0-9-]+\.(trycloudflare\.com|cfargotunnel\.com)/i);
    if (match && !resolved) {
      resolved  = true;
      tunnelURL = match[0];
      callback(null, tunnelURL);
    }
  };

  cf.stdout.on('data', onData);
  cf.stderr.on('data', onData);

  cf.on('exit', (code) => {
    if (!resolved) callback(new Error(`cloudflared 退出，code=${code}`), null);
  });

  // 30 秒超时
  setTimeout(() => {
    if (!resolved) {
      resolved = true;
      cf.kill();
      callback(new Error('获取隧道 URL 超时（30s）'), null);
    }
  }, 30000);

  return cf;
}

// ─── 打印启动信息 ──────────────────────────────────────────────────────────
function printStartupInfo(tunnelURL) {
  const localIPs = getLocalIPs();
  const protocol = hasSSL ? 'https' : 'http';
  const line = '─'.repeat(60);

  console.log('\n🍉 切西瓜游戏服务器已启动！');
  console.log(line);

  // 游戏页面（电脑本地访问）
  console.log('📺 游戏页面（电脑 Chrome 打开）:');
  console.log(`   ${protocol}://localhost:${PORT}/game.html`);
  console.log('');

  if (tunnelURL) {
    // ── 隧道模式：无需证书，手机直连 ──────────────────────────
    // 把 https:// 替换为 wss://
    const wssURL = tunnelURL.replace(/^https?:\/\//, 'wss://');

    console.log('📱 手机控制器链接（直接发给手机，无需安装证书！）:');
    console.log(`   ${CLOUDFLARE_URL}/?ip_tunnel=${encodeURIComponent(wssURL)}`);
    console.log('');
    console.log('   或者手动填写 WebSocket 地址:');
    console.log(`   ${wssURL}`);
    console.log('');
    console.log('✅ 连接方式：Cloudflare Tunnel（无证书烦恼）');
  } else {
    // ── 降级：显示本地 IP，需装证书 ────────────────────────────
    console.log('📱 手机控制器（需先安装证书）:');
    localIPs.forEach(ip => {
      console.log(`   ${CLOUDFLARE_URL}/?ip=${ip}&port=${PORT}`);
    });
    console.log('');
    if (protocol === 'https') {
      console.log('📜 手机安装证书（仅首次）:');
      localIPs.forEach(ip => {
        console.log(`   ${protocol}://${ip}:${PORT}/cert`);
      });
      console.log('');
    }
    console.log('⚠️  Cloudflare Tunnel 未启动（见上方错误），使用本地直连模式');
  }

  console.log(line);
  console.log('💡 将上方链接通过微信/AirDrop 发送到手机，打开即可游戏！');
  console.log(line + '\n');
}

// ─── 启动服务器 ────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🍉 切西瓜游戏服务器已启动！');

  // 先打印基础信息
  const localIPs = getLocalIPs();
  console.log(`📺 游戏页面: ${hasSSL ? 'https' : 'http'}://localhost:${PORT}/game.html`);
  console.log('🚇 正在建立 Cloudflare Tunnel，请稍候...\n');

  // 启动 cloudflared 隧道
  startCloudflaredTunnel(PORT, (err, tunnelURL) => {
    if (err) {
      console.warn('⚠️  Cloudflare Tunnel 失败:', err.message);
      console.log('   将使用本地直连模式（需在 iPhone 上安装证书）\n');
      printStartupInfo(null);
    } else {
      console.log(`✅ 隧道已建立: ${tunnelURL}\n`);
      printStartupInfo(tunnelURL);
    }
  });
});
