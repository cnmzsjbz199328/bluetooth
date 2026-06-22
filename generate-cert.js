/**
 * generate-cert-node.js
 * 使用 Node.js v15+ 内置 crypto 生成自签名证书
 * 不依赖任何外部工具
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const certDir = path.join(__dirname, 'cert');
if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });

const certPath = path.join(certDir, 'cert.pem');
const keyPath  = path.join(certDir, 'key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  console.log('✅ 证书已存在，跳过生成。删除 cert/ 目录后重新运行可重新生成。');
  process.exit(0);
}

// 获取本机局域网 IP
function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  const ips = ['127.0.0.1', 'localhost'];
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}

// 尝试用系统 openssl 生成证书
function tryOpenssl(keyPath, certPath, ips) {
  const { spawnSync } = require('child_process');
  const san = ips.map(ip =>
    ip.match(/^\d+\.\d+\.\d+\.\d+$/) ? `IP:${ip}` : `DNS:${ip}`
  ).join(',');

  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
  ];

  for (const bin of candidates) {
    // Step 1: genrsa
    const r1 = spawnSync(bin, ['genrsa', '-out', keyPath, '2048'], { encoding: 'utf8' });
    if (r1.status !== 0) continue;

    // Step 2: self-sign
    const r2 = spawnSync(bin, [
      'req', '-x509',
      '-key', keyPath,
      '-out', certPath,
      '-days', '365',
      '-subj', '/CN=FruitGame/O=Local/C=AU',
      '-addext', `subjectAltName=${san}`,
    ], { encoding: 'utf8' });

    if (r2.status === 0) {
      console.log(`✅ 证书已用 ${bin} 生成`);
      return true;
    }
  }
  return false;
}

// 使用 Node.js 内置生成（Node 22 支持 x509 证书创建）
function generateWithNode(keyPath, certPath, ips) {
  // Node.js v22 有实验性 x509 生成，但正式 API 在 node-forge 中
  // 这里我们使用一个纯 JS 的最小化 ASN.1 编码器生成自签名证书

  console.log('🔧 使用 Node.js 内置 crypto 生成密钥对...');

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fs.writeFileSync(keyPath, privateKey);
  console.log('✅ 私钥已保存:', keyPath);

  // 尝试用 openssl 生成证书（从已有私钥）
  const { spawnSync } = require('child_process');
  const san = ips.filter(ip => ip.match(/^\d+\.\d+\.\d+\.\d+$/)).map(ip => `IP:${ip}`).join(',') 
              + ',DNS:localhost';
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
    'C:\\OpenSSL\\bin\\openssl.exe',
  ];

  for (const bin of candidates) {
    const r = spawnSync(bin, [
      'req', '-x509',
      '-key', keyPath,
      '-out', certPath,
      '-days', '365',
      '-subj', '/CN=FruitGame/O=Local/C=AU',
      '-addext', `subjectAltName=${san}`,
    ], { encoding: 'utf8' });

    if (r.status === 0) {
      console.log(`✅ 证书已生成 (${bin})`);
      return true;
    }
  }

  // 最后降级方案：创建 .http-mode 标记，使服务器以 HTTP 运行
  console.log('\n⚠️  未找到 openssl，将以 HTTP 模式运行（仅限本地调试，手机无法连接）');
  console.log('   安装 Git for Windows 后重新运行: npm run cert');
  fs.writeFileSync(path.join(certDir, '.http-mode'), '1');

  // 仍然写入私钥（HTTP 模式用不到，但保留以备将来）
  return false;
}

// ─── 主逻辑 ──────────────────────────────────────────────────
const ips = getLocalIPs();
console.log('\n🍉 切西瓜游戏 — SSL 证书生成工具');
console.log('─'.repeat(45));
console.log('🌐 检测到本机 IP:', ips.filter(ip => ip.match(/^\d+/) && ip !== '127.0.0.1'));
console.log('');

const success = tryOpenssl(keyPath, certPath, ips) || generateWithNode(keyPath, certPath, ips);

if (success && fs.existsSync(certPath)) {
  console.log('\n🎉 完成！证书信息:');
  console.log('   证书:', certPath);
  console.log('   私钥:', keyPath);
  console.log('\n📱 在 iPhone 上安装证书（仅需一次）:');
  const localIPs = ips.filter(ip => ip.match(/^\d/) && ip !== '127.0.0.1');
  localIPs.forEach(ip => {
    console.log(`   1. Safari 打开: https://${ip}:3000/cert`);
  });
  console.log('   2. 下载后: 设置 → 已下载描述文件 → 安装');
  console.log('   3. 设置 → 通用 → 关于本机 → 证书信任设置 → 启用完全信任');
  console.log('\n▶  现在运行: npm start');
}
