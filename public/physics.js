/**
 * physics.js — 水果物理模拟引擎
 * 负责：抛物线轨迹、重力、碰撞检测、切割算法
 */

'use strict';

// ─── 常量 ─────────────────────────────────────────────────────
const GRAVITY = 1800;      // px/s² （模拟重力）
const MIN_RADIUS = 35;
const MAX_RADIUS = 60;

// ─── 水果类 ───────────────────────────────────────────────────
class Fruit {
  constructor(canvas) {
    const W = canvas.width;
    const H = canvas.height;
    this.id = Math.random().toString(36).slice(2);

    // 从底部随机位置飞出
    this.x = W * (0.15 + Math.random() * 0.7);
    this.y = H + MAX_RADIUS;
    this.radius = MIN_RADIUS + Math.random() * (MAX_RADIUS - MIN_RADIUS);

    // 初速度：向上 + 随机横向
    const upSpeed = H * (1.5 + Math.random() * 0.8); // px/s
    const horizSpeed = (Math.random() - 0.5) * W * 0.8;
    this.vx = horizSpeed;
    this.vy = -upSpeed;

    // 旋转
    this.angle = Math.random() * Math.PI * 2;
    this.angularVel = (Math.random() - 0.5) * 4;

    // 水果类型
    const types = ['🍉', '🍊', '🍎', '🍇', '🍋', '🥭', '🍓', '🍑', '🥝', '🍌'];
    const weights = [3, 2, 2, 2, 1, 2, 2, 1, 2, 1]; // 西瓜出现频率更高
    this.emoji = weightedRandom(types, weights);

    // 颜色（用于切割效果）
    const colorMap = {
      '🍉': { outer: '#2d8c3e', inner: '#e83d3d', juice: '#ff6b6b' },
      '🍊': { outer: '#e07b39', inner: '#ffb347', juice: '#ffa500' },
      '🍎': { outer: '#c0392b', inner: '#ff6b6b', juice: '#ff4444' },
      '🍇': { outer: '#6c3483', inner: '#a569bd', juice: '#9b59b6' },
      '🍋': { outer: '#d4ac0d', inner: '#f9e79f', juice: '#f1c40f' },
      '🥭': { outer: '#ca6f1e', inner: '#f39c12', juice: '#e67e22' },
      '🍓': { outer: '#922b21', inner: '#e74c3c', juice: '#ff4757' },
      '🍑': { outer: '#e59866', inner: '#f8c471', juice: '#f5b041' },
      '🥝': { outer: '#1e8449', inner: '#a9dfbf', juice: '#27ae60' },
      '🍌': { outer: '#d4ac0d', inner: '#f9e79f', juice: '#f1c40f' },
    };
    this.colors = colorMap[this.emoji] || colorMap['🍉'];

    this.alive = true;
    this.sliced = false;
    this.age = 0;

    // 切割后的两个半片
    this.halves = null;
  }

  update(dt) {
    if (!this.alive) return;
    this.age += dt;
    this.vy += GRAVITY * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.angle += this.angularVel * dt;
  }

  isOffScreen(canvas) {
    return this.y > canvas.height + this.radius * 2;
  }
}

// ─── 水果碎片（切割后） ───────────────────────────────────────
class FruitHalf {
  constructor(parent, side) {
    this.x = parent.x;
    this.y = parent.y;
    this.radius = parent.radius;
    this.emoji = parent.emoji;
    this.colors = parent.colors;
    this.side = side; // 'left' | 'right'

    // 切割后的飞散速度
    const spread = 150 + Math.random() * 100;
    this.vx = parent.vx + (side === 'left' ? -spread : spread);
    this.vy = parent.vy - 100 - Math.random() * 200;
    this.angularVel = (side === 'left' ? -1 : 1) * (3 + Math.random() * 5);
    this.angle = parent.angle;
    this.alpha = 1;
    this.age = 0;
    this.alive = true;
  }

  update(dt) {
    if (!this.alive) return;
    this.age += dt;
    this.vy += GRAVITY * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.angle += this.angularVel * dt;
    // 切半后 1.5 秒内渐隐
    if (this.age > 0.8) {
      this.alpha = Math.max(0, 1 - (this.age - 0.8) / 0.7);
    }
    if (this.alpha <= 0) this.alive = false;
  }

  isOffScreen(canvas) {
    return this.y > canvas.height + this.radius * 2;
  }
}

// ─── 粒子（果汁飞溅） ─────────────────────────────────────────
class JuiceParticle {
  constructor(x, y, color) {
    this.x = x;
    this.y = y;
    const angle = Math.random() * Math.PI * 2;
    const speed = 80 + Math.random() * 300;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed - 200;
    this.radius = 3 + Math.random() * 6;
    this.color = color;
    this.alpha = 1;
    this.age = 0;
    this.life = 0.6 + Math.random() * 0.4;
    this.alive = true;
  }

  update(dt) {
    if (!this.alive) return;
    this.age += dt;
    this.vy += GRAVITY * 0.3 * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.alpha = Math.max(0, 1 - this.age / this.life);
    if (this.alpha <= 0) this.alive = false;
  }
}

// ─── 切痕 ─────────────────────────────────────────────────────
class SlashTrail {
  constructor(points, color = 'rgba(255,255,255,0.9)') {
    this.points = points;
    this.color = color;
    this.alpha = 1;
    this.age = 0;
    this.life = 0.5;
    this.alive = true;
  }

  update(dt) {
    this.age += dt;
    this.alpha = Math.max(0, 1 - this.age / this.life);
    if (this.alpha <= 0) this.alive = false;
  }
}

// ─── 碰撞检测 ─────────────────────────────────────────────────

/**
 * 检测线段是否与圆相交
 * @param {number} x1,y1 - 线段起点
 * @param {number} x2,y2 - 线段终点
 * @param {number} cx,cy - 圆心
 * @param {number} r - 圆半径
 * @returns {boolean}
 */
function lineCircleIntersect(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const fx = x1 - cx;
  const fy = y1 - cy;

  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;

  let discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return false;

  discriminant = Math.sqrt(discriminant);
  const t1 = (-b - discriminant) / (2 * a);
  const t2 = (-b + discriminant) / (2 * a);

  return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1);
}

/**
 * 计算切割角度（从线段方向）
 */
function getSlashAngle(x1, y1, x2, y2) {
  return Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
}

// ─── 工具函数 ─────────────────────────────────────────────────
function weightedRandom(items, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[0];
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ─── 导出 ─────────────────────────────────────────────────────
window.Physics = {
  Fruit, FruitHalf, JuiceParticle, SlashTrail,
  lineCircleIntersect, getSlashAngle, weightedRandom, clamp,
};
