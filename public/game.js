/**
 * game.js — 游戏主控制器
 * 负责：游戏循环、WebSocket接收、状态管理、得分系统
 */

'use strict';

// 等待 DOM 和依赖加载完成
window.addEventListener('DOMContentLoaded', () => {
  const { Fruit, FruitHalf, JuiceParticle, SlashTrail, lineCircleIntersect } = window.Physics;

  // ─── Canvas & 渲染器 ─────────────────────────────────────────
  const canvas = document.getElementById('game-canvas');
  const renderer = new window.Renderer(canvas);

  // ─── 游戏状态 ────────────────────────────────────────────────
  const GameState = { WAITING: 0, PLAYING: 1, GAMEOVER: 2 };

  const game = {
    state: GameState.WAITING,
    score: 0,
    highScore: parseInt(localStorage.getItem('fruitNinja_highScore') || '0'),
    lives: 3,
    combo: 0,
    comboTimer: null,
    comboTimeout: 2500,    // 连击重置时间 ms
    lastFrameTime: 0,

    // 实体列表
    fruits: [],
    halves: [],
    particles: [],
    trails: [],
    floatingTexts: [],

    // 水果生成
    spawnTimer: 0,
    spawnInterval: 2.2,   // 初始生成间隔（秒）
    difficultyTimer: 0,
    minSpawnInterval: 0.8,

    // 控制器连接状态
    controllerConnected: false,

    // 当前切割光标位置（手机数据驱动）
    cursor: { x: -100, y: -100, active: false, activeTimer: 0 },

    // 切割轨迹点缓冲
    trailBuffer: [],
    lastSlashTime: 0,
  };

  // ─── WebSocket 连接 ──────────────────────────────────────────
  let ws = null;

  function connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}`;
    console.log('[Game WS] 连接到:', url);
    setWsStatus('⏳ 连接服务器...', false);

    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('[Game WS] 已连接到服务器');
      ws.send(JSON.stringify({ type: 'register', role: 'game' }));
      setWsStatus('🖥️ 服务器已连接', true);
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        handleMessage(msg);
      } catch (e) {
        console.warn('[Game WS] 消息解析失败:', e);
      }
    };

    ws.onclose = () => {
      console.log('[Game WS] 断开，3s 后重连...');
      setWsStatus('❌ 断线 — 重连中...', false);
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (e) => { console.error('[Game WS] 错误:', e); };
  }

  function setWsStatus(text, ok) {
    document.dispatchEvent(new CustomEvent('ws-status', { detail: { text, ok } }));
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'controller_connected':
        game.controllerConnected = true;
        console.log('[Game] 控制器已连接');
        // 如果在等待状态，自动开始游戏
        if (game.state === GameState.WAITING) startGame();
        break;

      case 'controller_disconnected':
        game.controllerConnected = false;
        console.log('[Game] 控制器断开');
        break;

      case 'gyro':
        // 原始陀螺仪数据：更新光标位置（通过 beta/gamma 角度映射到屏幕坐标）
        updateCursorFromGyro(msg);
        // 游戏中：在本端从原始加速度流检测挥砍（与 calibrate.html 同一管线）
        if (game.state === GameState.PLAYING) detectSlash(msg);
        break;

      case 'gesture':
        // 控制器自带的劈砍事件：仅用于等待/结束时挥动开始游戏。
        // 游戏进行中的切割改由 detectSlash（gyro 流）负责，避免双重触发与信号不一致。
        if (msg.gesture === 'slash' && game.state !== GameState.PLAYING) startGame();
        break;
    }
  }

  // ─── 陀螺仪映射到光标 ────────────────────────────────────────
  function updateCursorFromGyro(msg) {
    const W = canvas.width;
    const H = canvas.height;

    // gamma: 左右倾斜 (-90° ~ 90°) → X 轴
    // beta:  前后倾斜 (-180° ~ 180°) 使用 (-45° ~ 45°) 范围 → Y 轴
    const gammaClamp = Math.max(-60, Math.min(60, msg.gamma || 0));
    const betaClamp  = Math.max(-45, Math.min(45, (msg.beta || 0) - 45)); // 偏移：竖持时 beta≈45°

    game.cursor.x = W / 2 + (gammaClamp / 60) * (W / 2) * 0.85;
    game.cursor.y = H / 2 + (betaClamp  / 45) * (H / 2) * 0.85;
    game.cursor.x = Math.max(0, Math.min(W, game.cursor.x));
    game.cursor.y = Math.max(0, Math.min(H, game.cursor.y));
  }

  // ─── 挥砍方向 8 分类（质心来自 calibrate.html v3 数据）──────────
  // 机身→屏幕是非线性关系（不同方向换姿态），故不用线性映射，改最近质心分类：
  // 把手机线性加速度单位向量与 8 个标定质心比余弦相似度，归到最像的方向。
  // c=质心(机身系加速度均值)，deg=该方向在屏幕上的角度(x右 y下)。
  // ⚠️ 与握姿绑定：换握法需用 calibrate.html 重新标定后替换这些质心。
  const SLASH_DIRS = [
    { c:[ 0.550, -2.053, -7.677], deg:-90  }, // 12 上
    { c:[-5.710, -2.333, -3.063], deg:-45  }, // 1:30 右上
    { c:[-5.437,  0.503,  1.207], deg:  0  }, // 3 右
    { c:[-2.113,  4.090,  2.147], deg: 45  }, // 4:30 右下
    { c:[ 0.237,  4.640,  1.720], deg: 90  }, // 6 下
    { c:[ 1.867,  3.853, -0.230], deg:135  }, // 7:30 左下
    { c:[ 0.610,  2.773, -2.820], deg:180  }, // 9 左
    { c:[ 1.183,  1.043, -6.053], deg:-135 }, // 10:30 左上
  ].map(d => {                                 // 预归一化质心
    const n = Math.hypot(d.c[0], d.c[1], d.c[2]) || 1;
    return { u:[d.c[0]/n, d.c[1]/n, d.c[2]/n], deg:d.deg };
  });

  // 把机身系线性加速度向量分类到最近的方向，返回切割线朝向（弧度）
  function classifyDir(x, y, z) {
    const n = Math.hypot(x, y, z);
    if (n < 1e-3) return 0;
    const a = [x/n, y/n, z/n];
    let best = -Infinity, bestDeg = 0;
    for (const d of SLASH_DIRS) {
      const dot = a[0]*d.u[0] + a[1]*d.u[1] + a[2]*d.u[2];
      if (dot > best) { best = dot; bestDeg = d.deg; }
    }
    return bestDeg * Math.PI / 180;
  }

  // 切割不应期（ms）：过滤劈砍后手部回弹造成的二次剑痕。比控制器冷却(280ms)更长。
  const SLASH_REFRACTORY_MS = 350;

  // ─── 本端挥砍识别（复刻 calibrate.html 的信号管线）─────────────
  // 直接处理控制器发来的原始加速度流：实时低通估计重力 → 扣除得线性加速度 →
  // 检测挥动 → 取起始方向分类。这样实战信号与标定质心严格一致。
  const GRAV_ALPHA = 0.85;     // 重力低通系数（与 calibrate 一致）
  const ONSET_THR  = 4;        // 挥动起始阈值
  const ONSET_WIN  = 90;       // 起始方向取这段窗口平均（ms）
  const SWING_THR  = 13;       // 确认一次挥动的幅值阈值
  const REARM_THR  = 3;        // 回落到此以下才重新武装（迟滞）
  const BUF_MS     = 220;      // 滚动缓冲时长
  const slashDet = { g: null, buf: [], armed: true };

  function detectSlash(msg) {
    if (typeof msg.ax !== 'number') return;
    const raw = [msg.ax, msg.ay, msg.az];

    // 低通估计重力（始终跟随当前姿态，避免固定基线的残余重力偏置）
    if (!slashDet.g) slashDet.g = raw.slice();
    else for (let i = 0; i < 3; i++) slashDet.g[i] = GRAV_ALPHA*slashDet.g[i] + (1-GRAV_ALPHA)*raw[i];

    const l = [raw[0]-slashDet.g[0], raw[1]-slashDet.g[1], raw[2]-slashDet.g[2]];
    const m = Math.hypot(l[0], l[1], l[2]);
    const t = msg.t || Date.now();

    slashDet.buf.push({ t, l, m });
    while (slashDet.buf.length && t - slashDet.buf[0].t > BUF_MS) slashDet.buf.shift();

    const now = Date.now();
    // 迟滞重新武装：幅值回落且过了不应期
    if (!slashDet.armed && m < REARM_THR && now - game.lastSlashTime > SLASH_REFRACTORY_MS) {
      slashDet.armed = true;
    }
    if (!slashDet.armed) return;
    if (m <= SWING_THR || now - game.lastSlashTime < SLASH_REFRACTORY_MS) return;

    // 确认一次挥动 → 取起始方向（缓冲里第一个越过 ONSET_THR 的样本起 ONSET_WIN 内平均）
    slashDet.armed = false;
    let oi = slashDet.buf.findIndex(s => s.m >= ONSET_THR); if (oi < 0) oi = 0;
    const t0 = slashDet.buf[oi].t;
    let ox=0, oy=0, oz=0, nc=0;
    for (const s of slashDet.buf) { if (s.t>=t0 && s.t<=t0+ONSET_WIN) { ox+=s.l[0]; oy+=s.l[1]; oz+=s.l[2]; nc++; } }
    if (nc > 0) { ox/=nc; oy/=nc; oz/=nc; }

    doSlash(classifyDir(ox, oy, oz), Math.min(m/18, 3));
  }

  // ─── 执行一次切割（朝向已定）──────────────────────────────────
  function doSlash(angleRad, speed) {
    const W = canvas.width, H = canvas.height;
    // 剑痕贯穿整屏：长度取屏幕对角线的 2.5 倍，过光标后必然横跨全屏（屏外部分由画布裁剪）
    const length = Math.hypot(W, H) * 2.5;
    const cx = game.cursor.x, cy = game.cursor.y;
    const x1 = cx - Math.cos(angleRad) * length / 2;
    const y1 = cy - Math.sin(angleRad) * length / 2;
    const x2 = cx + Math.cos(angleRad) * length / 2;
    const y2 = cy + Math.sin(angleRad) * length / 2;

    game.cursor.active = true;
    game.cursor.activeTimer = 0.4;

    game.trails.push(new SlashTrail([{ x: x1, y: y1 }, { x: x2, y: y2 }]));

    let slicedCount = 0;
    for (const fruit of game.fruits) {
      if (!fruit.alive || fruit.sliced) continue;
      if (lineCircleIntersect(x1, y1, x2, y2, fruit.x, fruit.y, fruit.radius)) {
        sliceFruit(fruit, angleRad * 180 / Math.PI, speed);
        slicedCount++;
      }
    }

    if (slicedCount > 0) {
      clearTimeout(game.comboTimer);
      game.combo += slicedCount;
      game.comboTimer = setTimeout(() => { game.combo = 0; }, game.comboTimeout);

      const baseScore = 100 * slicedCount;
      const comboBonus = game.combo >= 2 ? Math.floor(baseScore * (game.combo - 1) * 0.5) : 0;
      const speedBonus = Math.floor(baseScore * Math.min(2, speed) * 0.3);
      const total = baseScore + comboBonus + speedBonus;

      game.score += total;
      if (game.score > game.highScore) {
        game.highScore = game.score;
        localStorage.setItem('fruitNinja_highScore', game.highScore);
      }

      spawnFloatingText(`+${total}`, cx, cy - 40, '#fbbf24', 32 + game.combo * 3);
      if (game.combo >= 3) spawnFloatingText(`🔥 ${game.combo}x`, cx, cy - 90, '#f87171', 28);

      sendFeedback({ subtype: 'score', score: total });
      if (game.combo >= 3) sendFeedback({ subtype: 'combo', count: game.combo });
    }

    game.lastSlashTime = Date.now();
  }

  // ─── 鼠标/触摸调试入口：用屏幕拖拽方向直接切割 ────────────────
  function handleSlashGesture(msg) {
    if (game.state !== GameState.PLAYING) { startGame(); return; }
    if (Date.now() - game.lastSlashTime < SLASH_REFRACTORY_MS) return;
    doSlash((msg.angle || 0) * Math.PI / 180, msg.speed || 1);
  }

  // ─── 切割水果 ────────────────────────────────────────────────
  function sliceFruit(fruit, slashAngle, speed) {
    fruit.sliced = true;
    fruit.alive = false;

    // 创建两个半片
    const halfL = new FruitHalf(fruit, 'left');
    const halfR = new FruitHalf(fruit, 'right');
    game.halves.push(halfL, halfR);

    // 果汁粒子
    const particleCount = 8 + Math.floor(speed * 4);
    for (let i = 0; i < particleCount; i++) {
      game.particles.push(new JuiceParticle(fruit.x, fruit.y, fruit.colors.juice));
    }

    // 音效占位（可扩展 Web Audio API）
    playSliceSound(speed);
  }

  // ─── 音效（Web Audio API） ────────────────────────────────────
  let audioCtx = null;
  function playSliceSound(speed) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.setValueAtTime(220 + speed * 80, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(110, audioCtx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
      osc.type = 'sawtooth';
      osc.start();
      osc.stop(audioCtx.currentTime + 0.2);
    } catch (e) {}
  }

  // ─── 水果生成 ────────────────────────────────────────────────
  function spawnFruit() {
    const count = Math.random() < 0.3 ? 2 : 1; // 30% 概率同时飞出 2 个
    for (let i = 0; i < count; i++) {
      game.fruits.push(new Fruit(canvas));
    }
  }

  // ─── 飘字 ────────────────────────────────────────────────────
  function spawnFloatingText(text, x, y, color, size = 28) {
    game.floatingTexts.push({
      text, x, y, color, size,
      vy: -80, alpha: 1, age: 0, life: 1.2, alive: true,
    });
  }

  // ─── 发送反馈给控制器 ─────────────────────────────────────────
  function sendFeedback(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'feedback', ...data }));
    }
  }

  // ─── 游戏开始 ────────────────────────────────────────────────
  function startGame() {
    game.state = GameState.PLAYING;
    game.score = 0;
    game.lives = 3;
    game.combo = 0;
    game.spawnTimer = 0;
    game.spawnInterval = 2.2;
    game.difficultyTimer = 0;
    game.fruits = [];
    game.halves = [];
    game.particles = [];
    game.trails = [];
    game.floatingTexts = [];
    // 重置挥砍识别器，避免上一局/连接残留状态
    slashDet.g = null; slashDet.buf = []; slashDet.armed = true;
    game.lastSlashTime = 0;
    console.log('[Game] 游戏开始！');
  }

  // ─── 游戏结束 ────────────────────────────────────────────────
  function gameOver() {
    game.state = GameState.GAMEOVER;
    if (game.score > game.highScore) {
      game.highScore = game.score;
      localStorage.setItem('fruitNinja_highScore', game.highScore);
    }
    console.log(`[Game] 游戏结束！得分: ${game.score}`);
  }

  // ─── 主游戏循环 ──────────────────────────────────────────────
  function gameLoop(timestamp) {
    const dt = Math.min((timestamp - (game.lastFrameTime || timestamp)) / 1000, 0.05);
    game.lastFrameTime = timestamp;

    // 渲染
    renderer.clear();
    renderer.drawBackground(timestamp / 1000);

    if (game.state === GameState.WAITING) {
      // 等待界面：生成装饰水果在背景飞
      game.spawnTimer += dt;
      if (game.spawnTimer >= 1.8) {
        game.spawnTimer = 0;
        game.fruits.push(new Fruit(canvas));
      }
      updateEntities(dt);
      // 清理落出屏幕的装饰水果（无生命值扣除）
      game.fruits = game.fruits.filter(f => !f.isOffScreen(canvas));
      game.halves = game.halves.filter(h => h.alive && !h.isOffScreen(canvas));
      game.particles = game.particles.filter(p => p.alive);
      game.trails = game.trails.filter(t => t.alive);
      drawEntities();
      renderer.drawStartScreen(game.controllerConnected);

    } else if (game.state === GameState.PLAYING) {
      // ── 难度递增
      game.difficultyTimer += dt;
      if (game.difficultyTimer > 20) { // 每 20 秒提升难度
        game.difficultyTimer = 0;
        game.spawnInterval = Math.max(game.minSpawnInterval, game.spawnInterval - 0.15);
      }

      // ── 水果生成
      game.spawnTimer += dt;
      if (game.spawnTimer >= game.spawnInterval) {
        game.spawnTimer = 0;
        spawnFruit();
      }

      // ── 更新实体
      updateEntities(dt);

      // ── 检查水果是否落出屏幕（扣生命）
      for (const fruit of game.fruits) {
        if (fruit.alive && !fruit.sliced && fruit.isOffScreen(canvas)) {
          fruit.alive = false;
          game.lives--;
          game.combo = 0;
          spawnFloatingText('💔', fruit.x, canvas.height - 60, '#f87171', 36);
          if (game.lives <= 0) {
            gameOver();
            break;
          }
        }
      }

      // ── 清理死亡实体
      cleanupEntities();

      drawEntities();

      renderer.drawHUD(game.score, game.combo, game.lives, game.controllerConnected);

    } else if (game.state === GameState.GAMEOVER) {
      drawEntities();
      renderer.drawGameOver(game.score, game.highScore);
    }

    // 光标
    if (game.cursor.active) {
      renderer.drawLiveCursor(game.cursor.x, game.cursor.y, 25, true);
      game.cursor.activeTimer -= dt;
      if (game.cursor.activeTimer <= 0) game.cursor.active = false;
    } else {
      renderer.drawLiveCursor(game.cursor.x, game.cursor.y, 15, false);
    }

    requestAnimationFrame(gameLoop);
  }

  function updateEntities(dt) {
    for (const f of game.fruits) f.update(dt);
    for (const h of game.halves) h.update(dt);
    for (const p of game.particles) p.update(dt);
    for (const t of game.trails) t.update(dt);
    for (const ft of game.floatingTexts) {
      ft.age += dt;
      ft.y += ft.vy * dt;
      ft.alpha = Math.max(0, 1 - ft.age / ft.life);
      if (ft.alpha <= 0) ft.alive = false;
    }
    // 光标
    if (game.cursor.activeTimer > 0) game.cursor.activeTimer -= dt;
  }

  function drawEntities() {
    // 绘制顺序：轨迹 → 水果 → 半片 → 粒子 → 飘字
    for (const t of game.trails) renderer.drawSlashTrail(t);
    for (const f of game.fruits) renderer.drawFruit(f);
    for (const h of game.halves) renderer.drawFruitHalf(h);
    for (const p of game.particles) renderer.drawParticle(p);
    renderer.drawFloatingTexts(game.floatingTexts);
  }

  function cleanupEntities() {
    // 修复：sliced 水果 alive=false 且位置不变，若不加 sliced 条件则永不离屏，
    // 导致数组无限积累。这里改为：只保留 alive=true 且未出屏的水果。
    game.fruits       = game.fruits.filter(f => f.alive && !f.isOffScreen(canvas));
    game.halves       = game.halves.filter(h => h.alive && !h.isOffScreen(canvas));
    game.particles    = game.particles.filter(p => p.alive);
    game.trails       = game.trails.filter(t => t.alive);
    game.floatingTexts = game.floatingTexts.filter(t => t.alive);
  }

  // ─── 键盘 / 鼠标调试支持 ────────────────────────────────────
  // （开发时可用鼠标模拟切割）
  let mouseDown = false;
  let mousePath = [];

  canvas.addEventListener('mousedown', (e) => {
    mouseDown = true;
    mousePath = [{ x: e.clientX, y: e.clientY }];
  });

  canvas.addEventListener('mousemove', (e) => {
    game.cursor.x = e.clientX;
    game.cursor.y = e.clientY;
    if (mouseDown) {
      mousePath.push({ x: e.clientX, y: e.clientY });
    }
  });

  canvas.addEventListener('mouseup', (e) => {
    if (mouseDown && mousePath.length >= 2) {
      const first = mousePath[0];
      const last  = mousePath[mousePath.length - 1];
      const dx = last.x - first.x;
      const dy = last.y - first.y;
      const speed = Math.sqrt(dx*dx + dy*dy) / 200;
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;
      handleSlashGesture({ angle, speed, gesture: 'slash' });
    }
    mouseDown = false;
    mousePath = [];
  });

  // 触摸支持（平板/手机直接访问游戏页）
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.touches[0];
    game.cursor.x = t.clientX;
    game.cursor.y = t.clientY;
    mousePath = [{ x: t.clientX, y: t.clientY }];
    mouseDown = true;
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const t = e.touches[0];
    game.cursor.x = t.clientX;
    game.cursor.y = t.clientY;
    if (mouseDown) mousePath.push({ x: t.clientX, y: t.clientY });
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (mouseDown && mousePath.length >= 2) {
      const first = mousePath[0];
      const last  = mousePath[mousePath.length - 1];
      const dx = last.x - first.x;
      const dy = last.y - first.y;
      const speed = Math.sqrt(dx*dx + dy*dy) / 150;
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;
      handleSlashGesture({ angle, speed, gesture: 'slash' });
    }
    mouseDown = false;
  }, { passive: false });

  // ─── 启动 ────────────────────────────────────────────────────
  connectWebSocket();
  requestAnimationFrame(gameLoop);
  console.log('🍉 游戏引擎已启动');
});
