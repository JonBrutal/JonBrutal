/* ============================================================================
 *  Silent Step — модуль SS.Core
 *  Шина событий, конфиг, канвас, камера, ввод, ГПСЧ, цикл с фиксированным
 *  шагом 1/60 и поток уровней.
 *
 *  ВНИМАНИЕ ВЛАДЕЛЬЦУ СЛОТА: это минимальная реализация ядра, написанная,
 *  чтобы персонажи и уровни запускались и проверялись. Контракт соблюдён
 *  полностью, файл можно заменить целиком — остальные модули не заметят.
 * ==========================================================================*/
(function (global) {
  'use strict';

  const SS = (global.SS = global.SS || {});
  if (SS.Core && SS.Core.__loaded) { return; }

  /* ==========================================================================
   * 1. ШИНА СОБЫТИЙ
   * ========================================================================*/
  if (!SS.bus) {
    const map = new Map();
    SS.bus = {
      on(evt, fn) {
        if (typeof fn !== 'function') { return; }
        if (!map.has(evt)) { map.set(evt, []); }
        map.get(evt).push(fn);
      },
      off(evt, fn) {
        const arr = map.get(evt);
        if (!arr) { return; }
        const i = arr.indexOf(fn);
        if (i >= 0) { arr.splice(i, 1); }
      },
      emit(evt, payload) {
        const arr = map.get(evt);
        if (!arr) { return; }
        // копия: подписчик может отписаться прямо в обработчике
        const list = arr.slice();
        for (let i = 0; i < list.length; i++) {
          try { list[i](payload); } catch (e) { console.error('[bus] ' + evt, e); }
        }
      }
    };
  }

  /* ==========================================================================
   * 2. КОНФИГ
   *    HUD и Panic кладут сюда свои неймспейсы ещё до появления Core,
   *    поэтому существующий объект не затираем — только дополняем.
   * ========================================================================*/
  const CORE_DEFAULTS = {
    step: 1 / 60,
    maxFrameTime: 0.25,
    pixelsPerMeter: 32,
    world: { tiles: 96 },
    viewport: { w: 1280, h: 720 },
    camera: { follow: 8, clampToWorld: true },
    seed: 20260904,
    keys: {
      up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
      run: ['ShiftLeft', 'ShiftRight'],
      careful: ['ControlLeft', 'ControlRight'],
      crouch: ['KeyC'], prone: ['KeyX'],
      throw: ['KeyF'], use: ['KeyE'],
      hold: ['Space'], restart: ['KeyR']
    },
    touch: { stickR: 62, btnR: 34, margin: 30, dead: 0.16 },
    ui: {
      font: '600 15px "Trebuchet MS", "Segoe UI", system-ui, sans-serif',
      fontBig: '700 34px "Trebuchet MS", "Segoe UI", system-ui, sans-serif',
      fontSmall: '500 12px "Trebuchet MS", "Segoe UI", system-ui, sans-serif',
      ink: '#e6eef6', dim: '#7b8794', danger: '#ff4d5e', ok: '#7fe6b0'
    }
  };

  if (!SS.Config) { SS.Config = {}; }
  if (!SS.Config.core) { SS.Config.core = CORE_DEFAULTS; }

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

  // [QUERY] SS.Config.get('core.step') и т.п. для всех модулей
  if (typeof SS.Config.get !== 'function') {
    SS.Config.get = function (path) { return readPath(SS.Config, path); };
  }
  // Регистрация значений по умолчанию модулем-владельцем неймспейса
  if (typeof SS.Config.defaults !== 'function') {
    SS.Config.defaults = function (ns, obj) {
      if (!ns || typeof obj !== 'object') { return; }
      if (!SS.Config[ns]) { SS.Config[ns] = obj; return; }
      const dst = SS.Config[ns];
      for (const k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k) && dst[k] === undefined) { dst[k] = obj[k]; }
      }
    };
  }

  const C = () => SS.Config.core || CORE_DEFAULTS;

  /* ==========================================================================
   * 3. ГПСЧ (детерминированный, mulberry32)
   * ========================================================================*/
  let rngState = C().seed >>> 0;
  function rand() {
    rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function reseed(s) { rngState = (s >>> 0) || 1; }

  /* ==========================================================================
   * 4. КАНВАС И КАМЕРА
   * ========================================================================*/
  const S = {
    canvas: null, ctx: null, dpr: 1,
    time: 0, acc: 0, last: 0, raf: 0,
    running: false, over: false, won: false, overCause: null,
    level: 0,
    cam: { x: 48, y: 48, zoom: 1 },
    player: { x: 48, y: 48 },
    hintT: 0, hintText: ''
  };

  function makeCanvas() {
    let cv = document.getElementById('ss-canvas');
    if (!cv) {
      cv = document.createElement('canvas');
      cv.id = 'ss-canvas';
      (document.body || document.documentElement).appendChild(cv);
    }
    cv.style.display = 'block';
    cv.style.margin = '0 auto';
    cv.style.background = '#05080a';
    cv.style.touchAction = 'none';
    cv.tabIndex = 0;
    S.canvas = cv;
    S.ctx = cv.getContext('2d');
    resize();
    global.addEventListener('resize', resize);
    return cv;
  }

  function resize() {
    if (!S.canvas) { return; }
    const vp = C().viewport;
    const dpr = Math.min(2, global.devicePixelRatio || 1);
    S.dpr = dpr;
    S.canvas.width = Math.round(vp.w * dpr);
    S.canvas.height = Math.round(vp.h * dpr);
    // вписываем в окно, сохраняя пропорции
    const availW = (global.innerWidth || vp.w);
    const availH = (global.innerHeight || vp.h);
    const k = Math.min(availW / vp.w, availH / vp.h);
    S.canvas.style.width = Math.floor(vp.w * k) + 'px';
    S.canvas.style.height = Math.floor(vp.h * k) + 'px';
    S.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ==========================================================================
   * 5. ВВОД
   *    [QUERY] SS.Core.input — состояние на текущий кадр.
   *    Дополнительно шлём 'input:action' { action, phase } для удержаний.
   * ========================================================================*/
  const input = {
    mx: 0, my: 0,           // −1..1, направление движения
    run: false, careful: false,
    crouchPressed: false, pronePressed: false,   // фронты нажатий (снимаются Player)
    throwPressed: false, usePressed: false,
    hold: false,            // удержание (QTE дыхания)
    touch: false
  };

  const down = Object.create(null);

  function keyIn(group, code) {
    const list = C().keys[group] || [];
    return list.indexOf(code) >= 0;
  }

  function onKeyDown(e) {
    if (down[e.code]) { return; }
    down[e.code] = true;
    if (keyIn('crouch', e.code)) { input.crouchPressed = true; }
    if (keyIn('prone', e.code)) { input.pronePressed = true; }
    if (keyIn('throw', e.code)) { input.throwPressed = true; }
    if (keyIn('use', e.code)) { input.usePressed = true; }
    if (keyIn('hold', e.code)) { input.hold = true; SS.bus.emit('input:action', { action: 'hold', phase: 'down' }); e.preventDefault(); }
    if (keyIn('restart', e.code) && (S.over || S.won)) { restart(); }
    if (keyIn('up', e.code) || keyIn('down', e.code) || keyIn('left', e.code) || keyIn('right', e.code)) { e.preventDefault(); }
  }

  function onKeyUp(e) {
    down[e.code] = false;
    if (keyIn('hold', e.code)) { input.hold = false; SS.bus.emit('input:action', { action: 'hold', phase: 'up' }); }
  }

  function readKeys() {
    let x = 0, y = 0;
    const k = C().keys;
    for (let i = 0; i < k.up.length; i++) { if (down[k.up[i]]) { y -= 1; break; } }
    for (let i = 0; i < k.down.length; i++) { if (down[k.down[i]]) { y += 1; break; } }
    for (let i = 0; i < k.left.length; i++) { if (down[k.left[i]]) { x -= 1; break; } }
    for (let i = 0; i < k.right.length; i++) { if (down[k.right[i]]) { x += 1; break; } }
    let run = false, careful = false;
    for (let i = 0; i < k.run.length; i++) { if (down[k.run[i]]) { run = true; } }
    for (let i = 0; i < k.careful.length; i++) { if (down[k.careful[i]]) { careful = true; } }
    if (!input.touch) {
      const len = Math.hypot(x, y);
      input.mx = len ? x / len : 0;
      input.my = len ? y / len : 0;
      input.run = run;
      input.careful = careful;
    }
  }

  /* --- сенсорный ввод: стик слева, кнопки справа ------------------------- */
  const touchUI = { stick: null, btns: [], pointers: new Map() };

  function layoutTouch() {
    const vp = C().viewport, t = C().touch;
    touchUI.stick = { x: t.margin + t.stickR + 20, y: vp.h - t.margin - t.stickR - 20, r: t.stickR };
    const bx = vp.w - t.margin - t.btnR - 10;
    const by = vp.h - t.margin - t.btnR - 20;
    touchUI.btns = [
      { id: 'crouch', x: bx, y: by, r: t.btnR, label: 'ПРИС' },
      { id: 'prone',  x: bx - t.btnR * 2.4, y: by, r: t.btnR, label: 'ЛЕЖА' },
      { id: 'throw',  x: bx, y: by - t.btnR * 2.4, r: t.btnR, label: 'БРОС' },
      { id: 'run',    x: bx - t.btnR * 2.4, y: by - t.btnR * 2.4, r: t.btnR, label: 'БЕГ' }
    ];
  }

  function toLogical(e) {
    const r = S.canvas.getBoundingClientRect();
    const vp = C().viewport;
    return { x: (e.clientX - r.left) * (vp.w / r.width), y: (e.clientY - r.top) * (vp.h / r.height) };
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse') { return; }
    input.touch = true;
    const p = toLogical(e);
    const st = touchUI.stick;
    if (Math.hypot(p.x - st.x, p.y - st.y) <= st.r * 1.6) {
      touchUI.pointers.set(e.pointerId, { kind: 'stick' });
      updateStick(p);
      return;
    }
    for (let i = 0; i < touchUI.btns.length; i++) {
      const b = touchUI.btns[i];
      if (Math.hypot(p.x - b.x, p.y - b.y) <= b.r * 1.15) {
        touchUI.pointers.set(e.pointerId, { kind: 'btn', id: b.id });
        if (b.id === 'crouch') { input.crouchPressed = true; }
        if (b.id === 'prone') { input.pronePressed = true; }
        if (b.id === 'throw') { input.throwPressed = true; }
        if (b.id === 'run') { input.run = true; }
        return;
      }
    }
    // свободное касание = удержание дыхания в QTE
    touchUI.pointers.set(e.pointerId, { kind: 'hold' });
    input.hold = true;
    SS.bus.emit('input:action', { action: 'hold', phase: 'down' });
    if (S.over || S.won) { restart(); }
  }

  function onPointerMove(e) {
    const rec = touchUI.pointers.get(e.pointerId);
    if (!rec || rec.kind !== 'stick') { return; }
    updateStick(toLogical(e));
  }

  function updateStick(p) {
    const st = touchUI.stick, t = C().touch;
    let dx = (p.x - st.x) / st.r, dy = (p.y - st.y) / st.r;
    const len = Math.hypot(dx, dy);
    if (len < t.dead) { input.mx = 0; input.my = 0; return; }
    const k = Math.min(1, len);
    input.mx = (dx / len) * k;
    input.my = (dy / len) * k;
    input.careful = k < 0.55;      // слабое отклонение стика = осторожный шаг
  }

  function onPointerUp(e) {
    const rec = touchUI.pointers.get(e.pointerId);
    if (!rec) { return; }
    touchUI.pointers.delete(e.pointerId);
    if (rec.kind === 'stick') { input.mx = 0; input.my = 0; input.careful = false; }
    if (rec.kind === 'hold') { input.hold = false; SS.bus.emit('input:action', { action: 'hold', phase: 'up' }); }
    if (rec.kind === 'btn' && rec.id === 'run') { input.run = false; }
  }

  function bindInput() {
    global.addEventListener('keydown', onKeyDown, { passive: false });
    global.addEventListener('keyup', onKeyUp);
    global.addEventListener('blur', () => {
      for (const code in down) { down[code] = false; }
      input.mx = input.my = 0; input.run = input.careful = input.hold = false;
    });
    if (S.canvas) {
      S.canvas.addEventListener('pointerdown', onPointerDown);
      S.canvas.addEventListener('pointermove', onPointerMove);
      S.canvas.addEventListener('pointerup', onPointerUp);
      S.canvas.addEventListener('pointercancel', onPointerUp);
      S.canvas.addEventListener('pointerleave', onPointerUp);
      S.canvas.addEventListener('contextmenu', e => e.preventDefault());
    }
    layoutTouch();
  }

  /* ==========================================================================
   * 6. ПОТОК УРОВНЕЙ
   * ========================================================================*/

  function levelCount() {
    return (SS.Level && typeof SS.Level.count === 'number') ? SS.Level.count : 1;
  }

  function loadLevel(index) {
    S.level = index;
    S.over = false; S.won = false; S.overCause = null;
    reseed(C().seed + index * 7919);
    if (SS.Level && typeof SS.Level.load === 'function') {
      SS.Level.load(index);
      const sp = SS.Level.spawn || { x: 48, y: 48 };
      S.player.x = sp.x; S.player.y = sp.y;
      S.cam.x = sp.x; S.cam.y = sp.y;
      S.hintText = SS.Level.hint || '';
      S.hintT = S.hintText ? 7 : 0;
      SS.bus.emit('level:loaded', { index: index, name: SS.Level.name || ('УРОВЕНЬ ' + (index + 1)) });
    }
  }

  function onLevelExit() {
    if (S.over || S.won) { return; }
    if (S.level + 1 < levelCount()) {
      loadLevel(S.level + 1);
    } else {
      S.won = true;
      SS.bus.emit('game:win', {});
    }
  }

  function onGameOver(p) {
    if (S.over) { return; }
    S.over = true;
    S.overCause = (p && p.cause) || 'monster';
  }

  function restart() {
    // счётчик времени партии не сбрасываем: это одно прохождение
    loadLevel(S.level);
    SS.bus.emit('game:start', {});
  }

  /* ==========================================================================
   * 7. ЦИКЛ
   * ========================================================================*/

  function updateCamera(dt) {
    const cf = C().camera;
    const vp = C().viewport, ppm = C().pixelsPerMeter;
    const k = 1 - Math.exp(-cf.follow * dt);
    S.cam.x += (S.player.x - S.cam.x) * k;
    S.cam.y += (S.player.y - S.cam.y) * k;
    if (cf.clampToWorld) {
      const halfW = vp.w / (2 * ppm), halfH = vp.h / (2 * ppm);
      const N = C().world.tiles;
      S.cam.x = Math.max(halfW, Math.min(N - halfW, S.cam.x));
      S.cam.y = Math.max(halfH, Math.min(N - halfH, S.cam.y));
    }
  }

  function frame(now) {
    S.raf = global.requestAnimationFrame(frame);
    const dt = Math.min(C().maxFrameTime, (now - S.last) / 1000);
    S.last = now;
    const STEP = C().step;
    S.acc += dt;

    let guard = 8;   // защита от «спирали смерти» после сворачивания вкладки
    while (S.acc >= STEP && guard-- > 0) {
      S.acc -= STEP;
      readKeys();
      if (!S.over && !S.won) {
        S.time += STEP;
        SS.Core.time = S.time;
        SS.bus.emit('game:tick', { dt: STEP, time: S.time });
        updateCamera(STEP);
      }
      if (S.hintT > 0) { S.hintT -= STEP; }
      // фронты нажатий живут ровно один шаг симуляции
      input.crouchPressed = false;
      input.pronePressed = false;
      input.throwPressed = false;
      input.usePressed = false;
    }
    if (guard <= 0) { S.acc = 0; }

    const ctx = S.ctx;
    const vp = C().viewport;
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.fillStyle = '#05080a';
    ctx.fillRect(0, 0, vp.w, vp.h);

    SS.bus.emit('game:render', { ctx: ctx, cam: S.cam });

    drawTouchUI(ctx, vp);
    drawFlowUI(ctx, vp);
  }

  /* --- экранный слой самого ядра: тач-кнопки, подсказка, финал ----------- */
  function drawTouchUI(ctx, vp) {
    if (!input.touch) { return; }
    const st = touchUI.stick;
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = C().ui.ink;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(st.x + input.mx * st.r * 0.6, st.y + input.my * st.r * 0.6, st.r * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = C().ui.ink;
    ctx.fill();
    for (let i = 0; i < touchUI.btns.length; i++) {
      const b = touchUI.btns[i];
      ctx.globalAlpha = 0.3;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 0.6;
      ctx.font = C().ui.fontSmall;
      ctx.textAlign = 'center';
      ctx.fillStyle = C().ui.ink;
      ctx.fillText(b.label, b.x, b.y + 4);
    }
    ctx.restore();
  }

  function centerText(ctx, str, x, y, color, font) {
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillText(str, x + 1, y + 1);
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  function drawFlowUI(ctx, vp) {
    const ui = C().ui;
    ctx.save();
    if (S.hintT > 0 && !S.over && !S.won) {
      ctx.globalAlpha = Math.min(1, S.hintT / 1.5);
      const name = (SS.Level && SS.Level.name) ? SS.Level.name : '';
      centerText(ctx, (S.level + 1) + '. ' + name, vp.w / 2, 96, ui.ink, ui.fontBig);
      centerText(ctx, S.hintText, vp.w / 2, 126, ui.dim, ui.font);
      ctx.globalAlpha = 1;
    }
    if (S.over) {
      ctx.fillStyle = 'rgba(6,2,4,0.72)';
      ctx.fillRect(0, 0, vp.w, vp.h);
      centerText(ctx, S.overCause === 'fall' ? 'ТЫ СОРВАЛСЯ' : 'ЭХО НАШЁЛ ТЕБЯ',
                 vp.w / 2, vp.h / 2 - 6, ui.danger, ui.fontBig);
      centerText(ctx, input.touch ? 'КОСНИСЬ ЭКРАНА — ЗАНОВО' : 'R — ЗАНОВО',
                 vp.w / 2, vp.h / 2 + 28, ui.dim, ui.font);
    }
    if (S.won) {
      ctx.fillStyle = 'rgba(2,8,6,0.75)';
      ctx.fillRect(0, 0, vp.w, vp.h);
      centerText(ctx, 'ТИШИНА', vp.w / 2, vp.h / 2 - 10, ui.ok, ui.fontBig);
      const mm = Math.floor(S.time / 60), ss = Math.floor(S.time % 60);
      centerText(ctx, 'пять уровней пройдены за ' + mm + ' мин ' + ss + ' с',
                 vp.w / 2, vp.h / 2 + 26, ui.dim, ui.font);
    }
    ctx.restore();
  }

  /* ==========================================================================
   * 8. СТАРТ
   * ========================================================================*/

  function start() {
    if (S.running) { return; }
    S.running = true;
    makeCanvas();
    bindInput();
    SS.bus.on('level:exit', onLevelExit);
    SS.bus.on('game:over', onGameOver);
    SS.bus.on('player:move', (p) => { if (p) { S.player.x = p.x; S.player.y = p.y; } });
    loadLevel(0);
    SS.bus.emit('game:start', {});
    S.last = global.performance ? performance.now() : Date.now();
    S.raf = global.requestAnimationFrame(frame);
    if (S.canvas && S.canvas.focus) { S.canvas.focus(); }
  }

  /* ==========================================================================
   * 9. ПУБЛИЧНЫЙ СЛОТ
   * ========================================================================*/

  SS.Core = {
    __loaded: true,
    version: '1.0.0',
    time: 0,
    rand: rand,
    reseed: reseed,
    input: input,                 // [QUERY] состояние ввода на текущий шаг
    start: start,
    restart: restart,
    levelIndex() { return S.level; },
    isOver() { return S.over || S.won; },
    canvas() { return S.canvas; },
    camera() { return S.cam; },
    debugState() { return S; }
  };

  // автозапуск после загрузки всех модулей
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(start, 0));
    } else {
      setTimeout(start, 0);
    }
  }

})(typeof window !== 'undefined' ? window : globalThis);
