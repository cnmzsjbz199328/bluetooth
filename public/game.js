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
        break;

      case 'gesture':
        // 劈砍手势
        if (msg.gesture === 'slash') {
          handleSlashGesture(msg);
        }
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

  // ─── 劈砍手势处理 ────────────────────────────────────────────
  function handleSlashGesture(msg) {
    if (game.state === GameState.GAMEOVER) {
      // 游戏结束后挥动重新开始
      startGame();
      return;
    }
    if (game.state === GameState.WAITING) {
      startGame();
      return;
    }

    const now = Date.now();
    const W = canvas.width;
    const H = canvas.height;

    // 根据手势角度计算切割线段
    // angle 是加速度方向角度 (-180° ~ 180°)
    const angleRad = (msg.angle || 0) * Math.PI / 180;
    const length = Math.min(W, H) * 0.5;

    const cx = game.cursor.x;
    const cy = game.cursor.y;
    const x1 = cx - Math.cos(angleRad) * length / 2;
    const y1 = cy - Math.sin(angleRad) * length / 2;
    const x2 = cx + Math.cos(angleRad) * length / 2;
    const y2 = cy + Math.sin(angleRad) * length / 2;

    // 激活光标
    game.cursor.active = true;
    game.cursor.activeTimer = 0.4;

    // 创建切割轨迹
    const trail = new SlashTrail([{ x: x1, y: y1 }, { x: x2, y: y2 }]);
    game.trails.push(trail);

    // 检测碰撞
    let slicedCount = 0;
    for (const fruit of game.fruits) {
      if (!fruit.alive || fruit.sliced) continue;

      if (lineCircleIntersect(x1, y1, x2, y2, fruit.x, fruit.y, fruit.radius)) {
        sliceFruit(fruit, msg.angle || 0, msg.speed || 1);
        slicedCount++;
      }
    }

    if (slicedCount > 0) {
      // 连击处理
      clearTimeout(game.comboTimer);
      game.combo += slicedCount;
      game.comboTimer = setTimeout(() => { game.combo = 0; }, game.comboTimeout);

      const baseScore = 100 * slicedCount;
      const comboBonus = game.combo >= 2 ? Math.floor(baseScore * (game.combo - 1) * 0.5) : 0;
      const speedBonus = Math.floor(baseScore * Math.min(2, msg.speed || 1) * 0.3);
      const total = baseScore + comboBonus + speedBonus;

      game.score += total;
      if (game.score > game.highScore) {
        game.highScore = game.score;
        localStorage.setItem('fruitNinja_highScore', game.highScore);
      }

      // 飘字
      spawnFloatingText(`+${total}`, cx, cy - 40, '#fbbf24', 32 + game.combo * 3);
      if (game.combo >= 3) {
        spawnFloatingText(`🔥 ${game.combo}x`, cx, cy - 90, '#f87171', 28);
      }

      // 发送反馈给控制器
      sendFeedback({ subtype: 'score', score: total });
      if (game.combo >= 3) sendFeedback({ subtype: 'combo', count: game.combo });
    }

    game.lastSlashTime = now;
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
