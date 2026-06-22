/**
 * renderer.js — Canvas 渲染引擎
 * 负责所有视觉元素的绘制：水果、切痕、粒子、UI
 */

'use strict';

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.canvas.width  = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  // ─── 清屏 ───────────────────────────────────────────────────
  clear() {
    const ctx = this.ctx;
    // 带残影效果的清屏（拖尾感）
    ctx.fillStyle = 'rgba(8, 8, 15, 0.85)';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // ─── 背景 ───────────────────────────────────────────────────
  drawBackground(time) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    // 动态渐变背景
    const grad = ctx.createRadialGradient(
      W * 0.5, H * 0.3, 0,
      W * 0.5, H * 0.3, H * 0.8
    );
    grad.addColorStop(0, 'rgba(20, 35, 20, 0.3)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 地面光晕
    const groundGrad = ctx.createLinearGradient(0, H - 80, 0, H);
    groundGrad.addColorStop(0, 'rgba(0,0,0,0)');
    groundGrad.addColorStop(1, 'rgba(0,0,0,0.4)');
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, H - 80, W, 80);
  }

  // ─── 水果绘制 ───────────────────────────────────────────────
  drawFruit(fruit) {
    if (!fruit.alive || fruit.sliced) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.translate(fruit.x, fruit.y);
    ctx.rotate(fruit.angle);

    // 外圆（果皮）
    ctx.beginPath();
    ctx.arc(0, 0, fruit.radius, 0, Math.PI * 2);
    const outerGrad = ctx.createRadialGradient(-fruit.radius * 0.3, -fruit.radius * 0.3, 0, 0, 0, fruit.radius);
    outerGrad.addColorStop(0, lighten(fruit.colors.outer, 40));
    outerGrad.addColorStop(1, fruit.colors.outer);
    ctx.fillStyle = outerGrad;
    ctx.fill();

    // 高光
    ctx.beginPath();
    ctx.arc(-fruit.radius * 0.25, -fruit.radius * 0.25, fruit.radius * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fill();

    // Emoji 标签（居中显示水果符号）
    ctx.font = `${fruit.radius * 1.3}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fruit.emoji, 0, 0);

    // 阴影光晕
    ctx.shadowColor = fruit.colors.juice;
    ctx.shadowBlur = 15;
    ctx.beginPath();
    ctx.arc(0, 0, fruit.radius, 0, Math.PI * 2);
    ctx.strokeStyle = fruit.colors.juice + '44';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.restore();
  }

  // ─── 水果半片 ───────────────────────────────────────────────
  drawFruitHalf(half) {
    if (!half.alive) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.globalAlpha = half.alpha;
    ctx.translate(half.x, half.y);
    ctx.rotate(half.angle);

    // 剪切路径（半圆）
    ctx.beginPath();
    if (half.side === 'left') {
      ctx.arc(0, 0, half.radius, Math.PI / 2, Math.PI * 3 / 2);
    } else {
      ctx.arc(0, 0, half.radius, -Math.PI / 2, Math.PI / 2);
    }
    ctx.closePath();
    ctx.clip();

    // 果皮
    ctx.beginPath();
    ctx.arc(0, 0, half.radius, 0, Math.PI * 2);
    ctx.fillStyle = half.colors.outer;
    ctx.fill();

    // 果肉（内部颜色）
    const innerGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, half.radius * 0.85);
    innerGrad.addColorStop(0, half.colors.inner);
    innerGrad.addColorStop(1, half.colors.outer);
    ctx.beginPath();
    ctx.arc(0, 0, half.radius * 0.85, 0, Math.PI * 2);
    ctx.fillStyle = innerGrad;
    ctx.fill();

    // 截面线（果肉横截面）
    ctx.fillStyle = half.colors.inner;
    ctx.fillRect(half.side === 'left' ? -2 : 0, -half.radius, 2, half.radius * 2);

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ─── 果汁粒子 ───────────────────────────────────────────────
  drawParticle(p) {
    if (!p.alive) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = p.alpha;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ─── 切痕轨迹 ───────────────────────────────────────────────
  drawSlashTrail(trail) {
    if (!trail.alive || trail.points.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = trail.alpha;
    ctx.strokeStyle = 'rgba(255, 255, 220, 0.95)';
    ctx.lineWidth = 4 * trail.alpha + 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(255,255,200,0.8)';
    ctx.shadowBlur = 12;

    ctx.beginPath();
    ctx.moveTo(trail.points[0].x, trail.points[0].y);
    for (let i = 1; i < trail.points.length; i++) {
      ctx.lineTo(trail.points[i].x, trail.points[i].y);
    }
    ctx.stroke();

    // 高光核心线
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5 * trail.alpha;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(trail.points[0].x, trail.points[0].y);
    for (let i = 1; i < trail.points.length; i++) {
      ctx.lineTo(trail.points[i].x, trail.points[i].y);
    }
    ctx.stroke();

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ─── 实时切割线（接收手机数据时显示） ──────────────────────
  drawLiveCursor(x, y, radius = 20, active = false) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = active ? 'rgba(255,255,100,0.9)' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = active ? 3 : 1.5;
    if (active) {
      ctx.shadowColor = 'rgba(255,255,100,0.6)';
      ctx.shadowBlur = 20;
    }
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ─── HUD（分数、生命值等） ──────────────────────────────────
  drawHUD(score, combo, lives, controllerConnected) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    // 分数
    ctx.save();
    ctx.font = 'bold 42px Outfit, system-ui';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(74,222,128,0.5)';
    ctx.shadowBlur = 15;
    ctx.textAlign = 'left';
    ctx.fillText(score.toLocaleString(), 24, 60);
    ctx.restore();

    // 分数标签
    ctx.save();
    ctx.font = '14px Outfit, system-ui';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'left';
    ctx.fillText('SCORE', 24, 82);
    ctx.restore();

    // 生命值（❤️）
    const heartX = W - 24;
    for (let i = 0; i < 3; i++) {
      ctx.save();
      ctx.font = '26px serif';
      ctx.textAlign = 'right';
      ctx.globalAlpha = i < lives ? 1 : 0.2;
      ctx.fillText('❤️', heartX - i * 36, 52);
      ctx.restore();
    }

    // 连击
    if (combo >= 2) {
      ctx.save();
      ctx.font = `bold ${Math.min(60, 28 + combo * 4)}px Outfit, system-ui`;
      ctx.fillStyle = `hsl(${30 + combo * 5}, 100%, 60%)`;
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 20;
      ctx.textAlign = 'center';
      ctx.fillText(`🔥 ${combo}x COMBO`, W / 2, 60);
      ctx.restore();
    }

    // 控制器连接状态
    ctx.save();
    ctx.font = '13px Outfit, system-ui';
    ctx.textAlign = 'right';
    ctx.fillStyle = controllerConnected ? 'rgba(74,222,128,0.8)' : 'rgba(248,113,113,0.8)';
    ctx.fillText(controllerConnected ? '📱 已连接' : '📱 等待手机...', W - 12, H - 20);
    ctx.restore();
  }

  // ─── 游戏开始屏幕 ───────────────────────────────────────────
  drawStartScreen(controllerConnected) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    // 半透明遮罩
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, W, H);

    // 标题
    ctx.font = `bold ${Math.min(80, W * 0.12)}px Outfit, system-ui`;
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(74,222,128,0.7)';
    ctx.shadowBlur = 30;
    ctx.textAlign = 'center';
    ctx.fillText('🍉 切西瓜！', W / 2, H * 0.35);
    ctx.shadowBlur = 0;

    ctx.font = `${Math.min(22, W * 0.035)}px Outfit, system-ui`;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('Gyroscope Fruit Ninja', W / 2, H * 0.35 + 50);

    // 连接状态
    ctx.font = `bold 20px Outfit, system-ui`;
    if (controllerConnected) {
      ctx.fillStyle = '#4ade80';
      ctx.fillText('📱 手机已连接 — 挥动手机开始！', W / 2, H * 0.55);
    } else {
      ctx.fillStyle = '#fbbf24';
      ctx.fillText('📱 请用手机打开控制器页面...', W / 2, H * 0.55);
    }

    // 底部提示
    ctx.font = '16px Outfit, system-ui';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText('服务器地址见终端输出', W / 2, H * 0.7);

    ctx.restore();
  }

  // ─── 游戏结束屏幕 ───────────────────────────────────────────
  drawGameOver(score, highScore) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(0, 0, W, H);

    ctx.font = 'bold 72px Outfit, system-ui';
    ctx.fillStyle = '#f87171';
    ctx.shadowColor = 'rgba(248,113,113,0.6)';
    ctx.shadowBlur = 30;
    ctx.textAlign = 'center';
    ctx.fillText('GAME OVER', W / 2, H * 0.35);

    ctx.shadowBlur = 0;
    ctx.font = 'bold 36px Outfit, system-ui';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`得分: ${score.toLocaleString()}`, W / 2, H * 0.48);

    if (score === highScore && score > 0) {
      ctx.font = 'bold 24px Outfit, system-ui';
      ctx.fillStyle = '#fbbf24';
      ctx.shadowColor = 'rgba(251,191,36,0.5)';
      ctx.shadowBlur = 15;
      ctx.fillText('🏆 新纪录！', W / 2, H * 0.57);
    }

    ctx.shadowBlur = 0;
    ctx.font = '18px Outfit, system-ui';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText('挥动手机重新开始', W / 2, H * 0.68);

    ctx.restore();
  }

  // ─── 飘字特效（得分/连击反馈） ─────────────────────────────
  drawFloatingTexts(texts) {
    const ctx = this.ctx;
    for (const t of texts) {
      if (!t.alive) continue;
      ctx.save();
      ctx.globalAlpha = t.alpha;
      ctx.font = `bold ${t.size}px Outfit, system-ui`;
      ctx.fillStyle = t.color;
      ctx.shadowColor = t.color;
      ctx.shadowBlur = 10;
      ctx.textAlign = 'center';
      ctx.fillText(t.text, t.x, t.y);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }
}

// ─── 工具：颜色加亮 ───────────────────────────────────────────
function lighten(hex, amount = 20) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, (num >> 16) + amount);
  const g = Math.min(255, ((num >> 8) & 0xff) + amount);
  const b = Math.min(255, (num & 0xff) + amount);
  return `rgb(${r},${g},${b})`;
}

window.Renderer = Renderer;
