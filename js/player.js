/* ============================================================================
 *  Silent Step — модуль SS.Player
 *  Глухой герой: движение, стойки, шум шагов по таблице баланса, броски
 *  камней, ямы и выход с уровня.
 *
 *  Ввод читает через [QUERY] SS.Core.input, карту — через SS.Level.*,
 *  наружу говорит только событиями шины.
 * ==========================================================================*/
(function (global) {
  'use strict';

  const SS = (global.SS = global.SS || {});
  if (SS.Player && SS.Player.__loaded) { return; }

  /* ==========================================================================
   * 1. ПАРАМЕТРЫ
   * ========================================================================*/
  const DEFAULTS = {
    radius: 0.30,                 // м — половина «толщины» героя для коллизий

    speed: {
      walk: 1.9,                  // м/с — обычный шаг
      run: 3.6,                   // м/с — бег
      crouchMul: 0.5,             // присед: ×0.5 скорость по таблице
      carefulMul: 0.55,           // осторожный шаг
      prone: 0.62                 // м/с — ползком
    },

    // длина шага в метрах: чем длиннее, тем реже шум
    stride: { walk: 0.75, run: 1.0, crouch: 0.6, prone: 0.95 },

    // модификаторы шума из таблицы баланса
    noise: {
      crouch: -2,                 // присед −2
      careful: -1,                // осторожный шаг −1
      run: 8,                     // бег — не тише 8
      fall: 10,                   // падение
      proneSilent: ['moss', 'grass'],   // ползком шум 0 только здесь
      proneOther: -4,             // на прочих поверхностях ползком: база −4
      surfaces: {                 // запасная таблица, если Level.noiseAt нет
        moss: 1, grass: 2, tallgrass: 3, wood: 5, leaves: 6, gravel: 6, water: 7, metal: 8
      },
      max: 10
    },

    throwing: { range: 8, level: 5, maxStones: 5, startStones: 2, cooldown: 0.6, pickupRadius: 0.9 },

    colors: {
      body: '#cfe8ff', bodyCrouch: '#9ec8e8', bodyProne: '#7fa8c4',
      face: '#e9f4ff', shadow: 'rgba(0,0,0,0.55)', stone: '#8d99a6'
    }
  };

  if (!SS.Config) { SS.Config = {}; }
  if (SS.Config && typeof SS.Config === 'object' && !SS.Config.player) { SS.Config.player = DEFAULTS; }

  function readPath(obj, path) {
    if (!obj) { return undefined; }
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      if (cur === null || typeof cur !== 'object' || !(parts[i] in cur)) { return undefined; }
      cur = cur[parts[i]];
    }
    return cur;
  }
  function cfg(path) {
    if (SS.Config) {
      if (typeof SS.Config.get === 'function') {
        try { const v = SS.Config.get('player.' + path); if (v !== undefined && v !== null) { return v; } }
        catch (e) { /* игнорируем */ }
      }
      const v2 = readPath(SS.Config, 'player.' + path);
      if (v2 !== undefined && v2 !== null) { return v2; }
    }
    return readPath(DEFAULTS, path);
  }

  let P = null;
  function snapshotConfig() {
    P = {
      radius: cfg('radius'),
      speed: cfg('speed'),
      stride: cfg('stride'),
      noise: cfg('noise'),
      throwing: cfg('throwing'),
      colors: cfg('colors')
    };
  }
  snapshotConfig();

  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));

  /* ==========================================================================
   * 2. СОСТОЯНИЕ
   * ========================================================================*/
  const S = {
    x: 48, y: 48,
    fx: 1, fy: 0,          // направление взгляда (для броска)
    stance: 'stand',
    speed: 0,
    strideAcc: 0,
    surface: null,
    stones: 0,
    throwCd: 0,
    alive: true,
    stepFlash: 0,
    stones3d: []           // летящие камни: { x, y, tx, ty, t, life }
  };

  const rnd = () => (SS.Core && typeof SS.Core.rand === 'function' ? SS.Core.rand() : Math.random());

  /* ==========================================================================
   * 3. КАРТА И КОЛЛИЗИИ
   * ========================================================================*/

  function solid(x, y) {
    return (SS.Level && typeof SS.Level.isSolid === 'function') ? SS.Level.isSolid(x, y) : false;
  }

  // Проверка четырёх точек «тела» — герой не проходит углами сквозь стены
  function blocked(x, y) {
    const r = P.radius;
    return solid(x - r, y - r) || solid(x + r, y - r) || solid(x - r, y + r) || solid(x + r, y + r);
  }

  function surfaceAt(x, y) {
    return (SS.Level && typeof SS.Level.surfaceAt === 'function') ? SS.Level.surfaceAt(x, y) : 'grass';
  }

  // Базовый шум тайла: у Level он точный (ветхость досок), иначе своя таблица
  function baseNoise(x, y) {
    if (SS.Level && typeof SS.Level.noiseAt === 'function') {
      const v = SS.Level.noiseAt(x, y);
      if (typeof v === 'number' && v > 0) { return v; }
    }
    return P.noise.surfaces[surfaceAt(x, y)] || 3;
  }

  /* ==========================================================================
   * 4. ШУМ ШАГА
   * ========================================================================*/
  function stepNoise(careful, running) {
    const N = P.noise;
    const surf = S.surface || surfaceAt(S.x, S.y);
    let lvl = baseNoise(S.x, S.y);

    if (S.stance === 'prone') {
      lvl = (N.proneSilent.indexOf(surf) >= 0) ? 0 : Math.max(0, lvl + N.proneOther);
    } else {
      if (S.stance === 'crouch') { lvl += N.crouch; }
      if (careful) { lvl += N.careful; }
      if (running) { lvl = Math.max(lvl, N.run); }
    }
    return clamp(lvl, 0, N.max);
  }

  /* ==========================================================================
   * 5. ШАГ СИМУЛЯЦИИ
   * ========================================================================*/

  function onTick(p) {
    if (!p || !S.alive) { return; }
    const dt = p.dt || 0;
    const inp = (SS.Core && SS.Core.input) ? SS.Core.input : null;

    // --- смена стойки ---
    if (inp) {
      if (inp.crouchPressed) { S.stance = (S.stance === 'crouch') ? 'stand' : 'crouch'; }
      if (inp.pronePressed) { S.stance = (S.stance === 'prone') ? 'stand' : 'prone'; }
    }

    // --- скорость по стойке ---
    const SP = P.speed;
    const running = !!(inp && inp.run) && S.stance === 'stand';
    const careful = !!(inp && inp.careful) && S.stance !== 'prone';
    let speed;
    if (S.stance === 'prone') { speed = SP.prone; }
    else if (S.stance === 'crouch') { speed = SP.walk * SP.crouchMul; }
    else { speed = running ? SP.run : SP.walk; }
    if (careful) { speed *= SP.carefulMul; }

    // --- перемещение с раздельными осями (скольжение вдоль стен) ---
    let mx = inp ? inp.mx : 0, my = inp ? inp.my : 0;
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    const moving = (Math.abs(mx) + Math.abs(my)) > 0.01;

    if (moving) {
      S.fx = mx; S.fy = my;
      const nx = S.x + mx * speed * dt;
      if (!blocked(nx, S.y)) { S.x = nx; }
      const ny = S.y + my * speed * dt;
      if (!blocked(S.x, ny)) { S.y = ny; }
      S.speed = speed * Math.min(1, len || 1);
    } else {
      S.speed = 0;
    }

    // --- поверхность под ногами ---
    const surf = surfaceAt(S.x, S.y);
    if (surf !== S.surface) {
      S.surface = surf;
      SS.bus.emit('player:surface', { surface: surf });
    }

    // --- шаги и их шум ---
    if (moving) {
      const strideLen = (S.stance === 'prone') ? P.stride.prone
                      : (S.stance === 'crouch') ? P.stride.crouch
                      : (running ? P.stride.run : P.stride.walk);
      S.strideAcc += S.speed * dt;
      if (S.strideAcc >= strideLen) {
        S.strideAcc = 0;
        const lvl = stepNoise(careful, running);
        if (lvl > 0) {
          S.stepFlash = 0.18;
          SS.bus.emit('noise:emit', { level: lvl, x: S.x, y: S.y, source: 'step' });
        }
      }
    } else {
      S.strideAcc = 0;
    }

    // --- яма: мгновенная смерть с грохотом 10 ---
    if (SS.Level && typeof SS.Level.isPit === 'function' && SS.Level.isPit(S.x, S.y)) {
      S.alive = false;
      SS.bus.emit('noise:emit', { level: P.noise.fall, x: S.x, y: S.y, source: 'env' });
      SS.bus.emit('game:over', { cause: 'fall' });
      return;
    }

    // --- подбор камней ---
    if (SS.Level && SS.Level.stones) {
      const list = SS.Level.stones;
      for (let i = 0; i < list.length; i++) {
        const st = list[i];
        if (st.taken) { continue; }
        if (Math.hypot(st.x - S.x, st.y - S.y) <= P.throwing.pickupRadius && S.stones < P.throwing.maxStones) {
          st.taken = true;
          S.stones++;
        }
      }
    }

    // --- бросок ---
    if (S.throwCd > 0) { S.throwCd -= dt; }
    if (inp && inp.throwPressed && S.stones > 0 && S.throwCd <= 0) { throwStone(); }
    updateStones(dt);

    // --- выход с уровня ---
    if (SS.Level && typeof SS.Level.isExit === 'function' && SS.Level.isExit(S.x, S.y)) {
      SS.bus.emit('level:exit', { index: SS.Level.index });
    }

    if (S.stepFlash > 0) { S.stepFlash -= dt; }

    SS.bus.emit('player:move', { x: S.x, y: S.y, stance: S.stance, speed: S.speed });
  }

  /* ==========================================================================
   * 6. КАМНИ
   * ========================================================================*/

  function throwStone() {
    const T = P.throwing;
    S.stones--;
    S.throwCd = T.cooldown;

    // камень летит по направлению взгляда и останавливается у первой стены
    const len = Math.hypot(S.fx, S.fy) || 1;
    const dx = S.fx / len, dy = S.fy / len;
    let tx = S.x, ty = S.y;
    const steps = Math.ceil(T.range * 4);
    for (let i = 1; i <= steps; i++) {
      const nx = S.x + dx * (T.range * i / steps);
      const ny = S.y + dy * (T.range * i / steps);
      if (solid(nx, ny)) { break; }
      tx = nx; ty = ny;
    }
    S.stones3d.push({ x0: S.x, y0: S.y, x: S.x, y: S.y, tx: tx, ty: ty, t: 0, life: 0.45 });
  }

  function updateStones(dt) {
    for (let i = S.stones3d.length - 1; i >= 0; i--) {
      const st = S.stones3d[i];
      st.t += dt;
      const k = Math.min(1, st.t / st.life);
      st.x = st.x0 + (st.tx - st.x0) * k;
      st.y = st.y0 + (st.ty - st.y0) * k;
      if (k >= 1) {
        S.stones3d.splice(i, 1);
        SS.bus.emit('item:thrown', { type: 'камень', x: st.tx, y: st.ty });
        SS.bus.emit('noise:emit', { level: P.throwing.level, x: st.tx, y: st.ty, source: 'item' });
      }
    }
  }

  /* ==========================================================================
   * 7. ОТРИСОВКА
   * ========================================================================*/

  function onRender(p) {
    if (!p || !p.ctx) { return; }
    const ctx = p.ctx, cam = p.cam || { x: 48, y: 48, zoom: 1 };
    const ppm = 32 * (cam.zoom || 1);
    const cv = ctx.canvas;
    let sx = 1;
    if (typeof ctx.getTransform === 'function') {
      try { const t = ctx.getTransform(); if (t && t.a) { sx = Math.abs(t.a); } } catch (e) { sx = 1; }
    }
    const vw = cv ? cv.width / sx : 1280;
    const vh = cv ? cv.height / sx : 720;
    const ox = vw / 2 - cam.x * ppm, oy = vh / 2 - cam.y * ppm;
    const px = ox + S.x * ppm, py = oy + S.y * ppm;
    const C = P.colors;

    ctx.save();

    // летящие камни
    ctx.fillStyle = C.stone;
    for (let i = 0; i < S.stones3d.length; i++) {
      const st = S.stones3d[i];
      ctx.beginPath();
      ctx.arc(ox + st.x * ppm, oy + st.y * ppm, Math.max(2, ppm * 0.12), 0, Math.PI * 2);
      ctx.fill();
    }

    // тень
    ctx.fillStyle = C.shadow;
    ctx.beginPath();
    ctx.ellipse(px, py + ppm * 0.12, ppm * 0.34, ppm * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();

    // тело: стоя — круг, присед — меньше, ползком — вытянутый овал
    const dir = Math.atan2(S.fy, S.fx);
    if (S.stance === 'prone') {
      ctx.fillStyle = C.bodyProne;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(dir);
      ctx.beginPath();
      ctx.ellipse(0, 0, ppm * 0.42, ppm * 0.20, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = (S.stance === 'crouch') ? C.bodyCrouch : C.body;
      ctx.beginPath();
      ctx.arc(px, py, ppm * (S.stance === 'crouch' ? 0.24 : 0.30), 0, Math.PI * 2);
      ctx.fill();
    }

    // направление взгляда
    ctx.strokeStyle = C.face;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(dir) * ppm * 0.46, py + Math.sin(dir) * ppm * 0.46);
    ctx.stroke();

    // вспышка на шаге — визуальный отклик вместо звука
    if (S.stepFlash > 0) {
      ctx.globalAlpha = clamp(S.stepFlash / 0.18, 0, 1) * 0.5;
      ctx.strokeStyle = C.body;
      ctx.beginPath();
      ctx.arc(px, py, ppm * 0.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // счётчик камней рядом с героем
    if (S.stones > 0) {
      ctx.fillStyle = C.stone;
      for (let i = 0; i < S.stones; i++) {
        ctx.beginPath();
        ctx.arc(px - ppm * 0.5 + i * ppm * 0.16, py - ppm * 0.55, ppm * 0.06, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  /* ==========================================================================
   * 8. ЖИЗНЕННЫЙ ЦИКЛ
   * ========================================================================*/

  function respawn() {
    snapshotConfig();
    const sp = (SS.Level && SS.Level.spawn) ? SS.Level.spawn : { x: 48, y: 48 };
    S.x = sp.x; S.y = sp.y;
    S.fx = 1; S.fy = 0;
    S.stance = 'stand';
    S.speed = 0;
    S.strideAcc = 0;
    S.surface = null;
    S.stones = P.throwing.startStones;
    S.stones3d.length = 0;
    S.throwCd = 0;
    S.alive = true;
    S.stepFlash = 0;
    SS.bus.emit('player:move', { x: S.x, y: S.y, stance: S.stance, speed: 0 });
    SS.bus.emit('player:surface', { surface: surfaceAt(S.x, S.y) });
  }

  function onOver() { S.alive = false; }

  let bound = false;
  function bindBus() {
    if (bound) { return true; }
    if (!SS.bus || typeof SS.bus.on !== 'function') { return false; }
    SS.bus.on('game:start', respawn);
    SS.bus.on('level:loaded', respawn);
    SS.bus.on('game:tick', onTick);
    SS.bus.on('game:render', onRender);
    SS.bus.on('game:over', onOver);
    bound = true;
    return true;
  }
  function waitForBus() {
    if (bindBus()) { return; }
    const timer = setInterval(() => { if (bindBus()) { clearInterval(timer); } }, 40);
    setTimeout(() => clearInterval(timer), 15000);
  }
  waitForBus();

  SS.Player = {
    __loaded: true,
    version: '1.0.0',
    get x() { return S.x; },
    get y() { return S.y; },
    get stance() { return S.stance; },
    get stones() { return S.stones; },
    reloadConfig: snapshotConfig,
    debugState() { return S; },
    _bind: waitForBus
  };

})(typeof window !== 'undefined' ? window : globalThis);
