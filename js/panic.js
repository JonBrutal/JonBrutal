/* ============================================================================
 *  Silent Step — модуль SS.Panic
 *  Паника 0..100 и дыхательные QTE.
 *
 *  Смысл механики: страх заставляет героя дышать тяжелее, а тяжёлое дыхание —
 *  это шум, который слышит «Эхо». Паника растёт от близости монстра, бега и
 *  собственного громкого шума; падает в покое и в низких стойках.
 *  На пике открывается QTE «задержи дыхание»: успех сбрасывает панику,
 *  провал — кашель (шум 6 по таблице баланса) прямо под носом у монстра.
 *  Если игрок отказал в доступе к микрофону, QTE идут чаще — они заменяют
 *  микрофонный канал.
 *
 *  Владелец слота SS.Panic. Общение — только через SS.bus и [QUERY]-функции.
 *  Рисует только в 'game:render' и только свой слой (виньетка, полоса, QTE).
 * ==========================================================================*/
(function (global) {
  'use strict';

  const SS = (global.SS = global.SS || {});
  if (SS.Panic && SS.Panic.__loaded) { return; }   // защита от двойного подключения

  /* ==========================================================================
   * 1. ПАРАМЕТРЫ МОДУЛЯ (публикуются в SS.Config.panic)
   * ========================================================================*/
  const DEFAULTS = {
    enabled: true,

    worldUnit: 'm',          // как и в HUD: единицы координат мира
    pixelsPerMeter: 32,
    viewport: { w: 1280, h: 720 },

    start: 0,                // стартовое значение паники
    max: 100,
    emitStep: 1,             // на сколько должна измениться паника для 'panic:change'

    // спад в покое, ед/с, и множители спада по стойкам
    decay: 3.2,
    stanceCalm: { stand: 1.0, crouch: 1.25, prone: 1.6 },

    // рост от близости монстра
    fear: {
      radius: 16,            // м — дальше этого монстр на панику не влияет
      gain: 16,              // ед/с в упор
      byState: { IDLE: 0.4, PATROL: 0.5, ALERT: 1.0, SEARCH: 1.25, CHASE: 2.4, KILL: 3.0 }
    },

    // рост от бега
    run: { speed: 2.6, gain: 5 },

    // рост от собственного громкого шума
    loudNoise: { level: 7, add: 8, ownRadius: 2.2 },

    // тяжёлое дыхание превращается в шум
    breath: {
      from: 55,              // с какой паники герой начинает шуметь дыханием
      levelMin: 1, levelMax: 5,
      intervalMax: 2.8, intervalMin: 1.0,
      jitter: 0.25,
      source: 'env'
    },

    // QTE «задержи дыхание»
    qte: {
      threshold: 80,         // паника, при которой открывается окно
      thresholdNoMic: 65,    // если микрофон отключён — QTE идут чаще
      window: 2.4,           // с — окно на спокойной панике
      windowMin: 1.4,        // с — окно на панике 100
      hold: 0.85,            // с — сколько надо удерживать на спокойной панике
      holdMax: 1.35,         // с — сколько надо удерживать на панике 100
      relief: 34,            // сколько снимает успех
      penalty: 13,           // сколько добавляет провал
      coughLevel: 6,         // шум кашля по таблице баланса
      cooldownOk: 8,
      cooldownFail: 3.5,
      blowFails: true,       // реальный выдох в микрофон во время QTE = провал
      keys: ['Space']        // e.code клавиш удержания
    },

    // модуль сам слушает клавиатуру/тач, пока Core не присылает 'input:action'
    selfInput: true,

    ui: {
      barW: 320, barH: 10, bottom: 46,
      ringR: 86, ringY: 0.62,      // ringY — доля высоты экрана
      vignette: 0.55,              // максимальная непрозрачность виньетки
      shake: 3.5,                  // px — дрожание собственных элементов
      flash: 0.9,                  // с — вспышка результата QTE
      fonts: {
        small: '500 12px "Trebuchet MS", "Segoe UI", system-ui, sans-serif',
        main:  '600 14px "Trebuchet MS", "Segoe UI", system-ui, sans-serif',
        big:   '700 22px "Trebuchet MS", "Segoe UI", system-ui, sans-serif'
      },
      colors: {
        ink: '#e6eef6', dim: '#7b8794',
        calm: '#4fd1a5', warn: '#ffc857', danger: '#ff4d5e', ok: '#7fe6b0'
      },
      textIdle: 'ДЫХАНИЕ',
      textQte: 'ЗАДЕРЖИ ДЫХАНИЕ',
      hintKey: 'ДЕРЖИ ПРОБЕЛ',
      hintTouch: 'ДЕРЖИ ПАЛЕЦ НА ЭКРАНЕ',
      textOk: 'ВЫДОХ… ТИХО',
      textFail: 'КАШЕЛЬ'
    }
  };

  /* ==========================================================================
   * 2. МОСТИК К SS.Config
   * ========================================================================*/

  if (!SS.Config) { SS.Config = {}; }            // только контейнер, не заглушка
  if (SS.Config && typeof SS.Config === 'object' && !SS.Config.panic) {
    SS.Config.panic = DEFAULTS;
  }

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
        try {
          const v = SS.Config.get('panic.' + path);
          if (v !== undefined && v !== null) { return v; }
        } catch (e) { /* чужой модуль не должен ронять панику */ }
      }
      const v2 = readPath(SS.Config, 'panic.' + path);
      if (v2 !== undefined && v2 !== null) { return v2; }
    }
    return readPath(DEFAULTS, path);
  }

  let P = null;
  function snapshotConfig() {
    P = {
      enabled: cfg('enabled'),
      worldUnit: cfg('worldUnit'),
      ppm: cfg('pixelsPerMeter'),
      viewport: cfg('viewport'),
      start: cfg('start'),
      max: cfg('max'),
      emitStep: cfg('emitStep'),
      decay: cfg('decay'),
      stanceCalm: cfg('stanceCalm'),
      fear: cfg('fear'),
      run: cfg('run'),
      loud: cfg('loudNoise'),
      breath: cfg('breath'),
      qte: cfg('qte'),
      selfInput: cfg('selfInput'),
      ui: cfg('ui')
    };
  }
  snapshotConfig();

  /* ==========================================================================
   * 3. УТИЛИТЫ
   * ========================================================================*/

  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
  const lerp  = (a, b, t) => a + (b - a) * t;
  const toM   = (v) => (P.worldUnit === 'px' ? v / P.ppm : v);
  const rnd   = () => (SS.Core && typeof SS.Core.rand === 'function' ? SS.Core.rand() : Math.random());

  function distM(ax, ay, bx, by) {
    const dx = toM(bx - ax), dy = toM(by - ay);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function viewSize(ctx) {
    const c = ctx && ctx.canvas;
    if (!c) { return { w: P.viewport.w, h: P.viewport.h }; }
    let sx = 1, sy = 1;
    if (typeof ctx.getTransform === 'function') {
      try {
        const t = ctx.getTransform();
        if (t && t.a) { sx = Math.abs(t.a); }
        if (t && t.d) { sy = Math.abs(t.d); }
      } catch (e) { sx = 1; sy = 1; }
    }
    const w = c.width / (sx || 1), h = c.height / (sy || 1);
    return { w: w > 0 ? w : P.viewport.w, h: h > 0 ? h : P.viewport.h };
  }

  function emit(evt, payload) {
    if (SS.bus && typeof SS.bus.emit === 'function') {
      try { SS.bus.emit(evt, payload); } catch (e) { console.error('[SS.Panic] ' + evt, e); }
    }
  }

  /* ==========================================================================
   * 4. СОСТОЯНИЕ
   * ========================================================================*/

  const S = {
    started: false,
    over: false,
    time: 0,

    value: 0,
    lastEmitted: -999,

    player: { x: 0, y: 0, known: false, stance: 'stand', speed: 0 },
    monster: { x: 0, y: 0, known: false, state: null, dist: Infinity },
    micDenied: false,

    breathT: 0,

    qte: { active: false, t: 0, window: 0, need: 0, held: 0, holding: false, opened: 0 },
    cooldown: 0,
    flash: { t: 0, ok: false },

    // вход
    inputHeld: false,
    boundCanvas: null,
    touchUsed: false
  };

  /* ==========================================================================
   * 5. ЛОГИКА ПАНИКИ
   * ========================================================================*/

  function setValue(v) {
    S.value = clamp(v, 0, P.max);
    if (Math.abs(S.value - S.lastEmitted) >= P.emitStep ||
        (S.value === 0 && S.lastEmitted !== 0) ||
        (S.value === P.max && S.lastEmitted !== P.max)) {
      S.lastEmitted = S.value;
      emit('panic:change', { value: S.value });
    }
  }

  // Множитель страха от состояния монстра
  function stateFactor() {
    const map = P.fear.byState || {};
    const st = S.monster.state;
    if (st && map[st] !== undefined) { return map[st]; }
    return map.PATROL !== undefined ? map.PATROL : 1;
  }

  // Порог открытия QTE: без микрофона — ниже, чтобы QTE его заменяли
  function qteThreshold() {
    return S.micDenied ? P.qte.thresholdNoMic : P.qte.threshold;
  }

  function updatePanic(dt) {
    // спад в покое, стойка успокаивает
    const calm = (P.stanceCalm && P.stanceCalm[S.player.stance]) || 1;
    let delta = -P.decay * calm;

    // близость монстра
    if (S.monster.known && S.player.known) {
      S.monster.dist = distM(S.player.x, S.player.y, S.monster.x, S.monster.y);
      if (S.monster.dist < P.fear.radius) {
        const k = 1 - S.monster.dist / P.fear.radius;
        delta += P.fear.gain * k * stateFactor();
      }
    }

    // бег
    if (S.player.speed > P.run.speed) { delta += P.run.gain; }

    setValue(S.value + delta * dt);
  }

  function updateBreath(dt) {
    const B = P.breath;
    if (S.value < B.from) { S.breathT = 0; return; }
    const k = clamp((S.value - B.from) / Math.max(1, P.max - B.from), 0, 1);
    S.breathT -= dt;
    if (S.breathT > 0) { return; }
    const interval = lerp(B.intervalMax, B.intervalMin, k);
    S.breathT = interval * (1 - B.jitter * 0.5 + rnd() * B.jitter);
    const level = lerp(B.levelMin, B.levelMax, k);
    if (level > 0.4 && S.player.known) {
      emit('noise:emit', { level: level, x: S.player.x, y: S.player.y, source: B.source });
    }
  }

  function startQte() {
    const Q = P.qte;
    const k = clamp((S.value - qteThreshold()) / Math.max(1, P.max - qteThreshold()), 0, 1);
    S.qte.active = true;
    S.qte.t = 0;
    S.qte.window = lerp(Q.window, Q.windowMin, k);
    S.qte.need = lerp(Q.hold, Q.holdMax, k);
    S.qte.held = 0;
    S.qte.holding = false;
    S.qte.opened = S.time;
    emit('panic:qte', { window: S.qte.window });
  }

  function finishQte(ok) {
    const Q = P.qte;
    S.qte.active = false;
    S.qte.holding = false;
    S.flash.t = P.ui.flash;
    S.flash.ok = ok;
    if (ok) {
      S.cooldown = Q.cooldownOk;
      setValue(S.value - Q.relief);
    } else {
      S.cooldown = Q.cooldownFail;
      setValue(S.value + Q.penalty);
      // провал = кашель: шум 6 в точке игрока
      if (S.player.known) {
        emit('noise:emit', { level: Q.coughLevel, x: S.player.x, y: S.player.y, source: 'env' });
      }
    }
  }

  function updateQte(dt) {
    if (S.cooldown > 0) { S.cooldown -= dt; }

    if (!S.qte.active) {
      if (S.cooldown <= 0 && S.value >= qteThreshold()) { startQte(); }
      return;
    }

    S.qte.t += dt;
    if (S.inputHeld) {
      S.qte.holding = true;
      S.qte.held += dt;
    } else {
      S.qte.holding = false;
    }

    if (S.qte.held >= S.qte.need) { finishQte(true); return; }
    if (S.qte.t >= S.qte.window) { finishQte(false); }
  }

  /* ==========================================================================
   * 6. ОБРАБОТЧИКИ ШИНЫ
   * ========================================================================*/

  function onStart() {
    snapshotConfig();
    S.started = true;
    S.over = false;
    S.time = 0;
    S.value = P.start;
    S.lastEmitted = -999;
    S.breathT = 0;
    S.cooldown = 0;
    S.qte.active = false;
    S.flash.t = 0;
    S.inputHeld = false;
    setValue(P.start);
  }

  function onOver() {
    S.over = true;
    S.qte.active = false;
    S.inputHeld = false;
  }

  function onTick(p) {
    if (!p) { return; }
    const dt = p.dt || 0;
    S.time = (typeof p.time === 'number') ? p.time : (S.time + dt);
    if (!P.enabled || S.over) { return; }
    if (S.flash.t > 0) { S.flash.t -= dt; }
    updatePanic(dt);
    updateBreath(dt);
    updateQte(dt);
  }

  function onPlayerMove(p) {
    if (!p) { return; }
    S.player.x = p.x; S.player.y = p.y; S.player.known = true;
    if (p.stance) { S.player.stance = p.stance; }
    if (typeof p.speed === 'number') { S.player.speed = p.speed; }
  }

  function onMonsterPos(p) {
    if (!p) { return; }
    S.monster.x = p.x; S.monster.y = p.y; S.monster.known = true;
  }

  function onMonsterState(p) {
    if (!p) { return; }
    S.monster.state = p.to || null;
    if (typeof p.x === 'number') { S.monster.x = p.x; S.monster.y = p.y; S.monster.known = true; }
    // резкая смена на погоню — мгновенный всплеск
    if (p.to === 'CHASE') { setValue(S.value + 10); }
  }

  function onNoiseEmit(p) {
    if (!p || typeof p.level !== 'number') { return; }
    if (p.source === P.breath.source && S.qte.active) { return; }  // своё дыхание не пугает
    if (!S.player.known) { return; }
    if (distM(S.player.x, S.player.y, p.x, p.y) > P.loud.ownRadius) { return; }
    if (p.level >= P.loud.level) { setValue(S.value + P.loud.add); }
  }

  function onMicDenied() { S.micDenied = true; }

  function onMicBlow() {
    // выдохнул в микрофон во время задержки дыхания — провал
    if (P.qte.blowFails && S.qte.active) { finishQte(false); }
  }

  // Необязательное событие от Core (см. ЗАПРОС К КОНТРАКТУ)
  function onInputAction(p) {
    if (!p || p.action !== 'hold') { return; }
    S.inputHeld = (p.phase === 'down');
  }

  /* ==========================================================================
   * 7. ВВОД ДЛЯ QTE
   *    Пока в контракте нет события ввода, модуль сам слушает клавишу и тач,
   *    но реагирует ТОЛЬКО во время активного QTE, чтобы не мешать Core.
   * ========================================================================*/

  function keyMatches(e) {
    const keys = P.qte.keys || [];
    return keys.indexOf(e.code) >= 0 || (keys.indexOf('Space') >= 0 && e.key === ' ');
  }

  function onKeyDown(e) {
    if (!P.selfInput || !S.qte.active) { return; }
    if (!keyMatches(e)) { return; }
    S.inputHeld = true;
    S.touchUsed = false;
    e.preventDefault();
  }

  function onKeyUp(e) {
    if (!P.selfInput) { return; }
    if (!keyMatches(e)) { return; }
    S.inputHeld = false;
  }

  function onPointerDown(e) {
    if (!P.selfInput || !S.qte.active) { return; }
    S.inputHeld = true;
    S.touchUsed = (e.pointerType === 'touch' || e.pointerType === 'pen');
  }

  function onPointerUp() {
    if (!P.selfInput) { return; }
    S.inputHeld = false;
  }

  function bindInput(canvas) {
    if (!P.selfInput || typeof global.addEventListener !== 'function') { return; }
    if (!S.boundCanvas) {
      global.addEventListener('keydown', onKeyDown, { passive: false });
      global.addEventListener('keyup', onKeyUp);
      global.addEventListener('blur', onPointerUp);
    }
    if (canvas && canvas !== S.boundCanvas && typeof canvas.addEventListener === 'function') {
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerUp);
      canvas.addEventListener('pointerleave', onPointerUp);
      S.boundCanvas = canvas;
    } else if (!S.boundCanvas) {
      S.boundCanvas = true;   // клавиатура привязана, канваса ещё нет
    }
  }

  /* ==========================================================================
   * 8. РИСОВАНИЕ (собственный слой)
   * ========================================================================*/

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function text(ctx, str, x, y, color, font, align) {
    ctx.font = font || P.ui.fonts.main;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillText(str, x + 1, y + 1);
    ctx.fillStyle = color || P.ui.colors.ink;
    ctx.fillText(str, x, y);
  }

  // Двойной удар сердца: частота растёт вместе с паникой
  function heartbeat(t, k) {
    const bpm = lerp(62, 152, k);
    const ph = (t * bpm / 60) % 1;
    return Math.exp(-ph * 13) + 0.55 * Math.exp(-Math.abs(ph - 0.24) * 17);
  }

  function panicColor(k) {
    const C = P.ui.colors;
    if (k > 0.75) { return C.danger; }
    if (k > 0.45) { return C.warn; }
    return C.calm;
  }

  function drawVignette(ctx, view, k, beat) {
    if (k <= 0.02) { return; }
    const cx = view.w / 2, cy = view.h / 2;
    const far = Math.sqrt(cx * cx + cy * cy);
    const g = ctx.createRadialGradient(cx, cy, far * (0.62 - 0.22 * k), cx, cy, far);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, k > 0.6 ? 'rgba(40,0,6,1)' : 'rgba(0,0,0,1)');
    ctx.save();
    ctx.globalAlpha = clamp(P.ui.vignette * k * (0.82 + 0.18 * beat), 0, 1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, view.w, view.h);
    ctx.restore();
  }

  function drawBar(ctx, view, k, beat) {
    const U = P.ui;
    const w = U.barW, h = U.barH;
    const x = Math.round(view.w / 2 - w / 2);
    const y = Math.round(view.h - U.bottom);
    const jitter = (k > 0.6) ? (rnd() - 0.5) * U.shake * (k - 0.6) * 2.5 : 0;

    ctx.save();
    ctx.translate(jitter, 0);

    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = 'rgba(7,11,15,0.72)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(150,190,210,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (k > 0.001) {
      ctx.save();
      roundRect(ctx, x, y, w * k, h, h / 2);
      ctx.clip();
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, U.colors.calm);
      g.addColorStop(0.55, U.colors.warn);
      g.addColorStop(1, U.colors.danger);
      ctx.fillStyle = g;
      ctx.globalAlpha = 0.85 + 0.15 * beat;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }

    // отметка порога QTE
    const thr = qteThreshold() / P.max;
    const tx = Math.round(x + w * thr) + 0.5;
    ctx.strokeStyle = U.colors.ink;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(tx, y - 3);
    ctx.lineTo(tx, y + h + 3);
    ctx.stroke();
    ctx.globalAlpha = 1;

    text(ctx, U.textIdle, x, y - 8, U.colors.dim, U.fonts.small);
    text(ctx, Math.round(S.value) + '%', x + w, y - 8, panicColor(k), U.fonts.small, 'right');

    ctx.restore();
  }

  function drawQte(ctx, view) {
    const U = P.ui, Q = S.qte;
    const cx = view.w / 2;
    const cy = view.h * U.ringY;
    const R = U.ringR;

    ctx.save();

    // затемнение вокруг кольца, чтобы взгляд шёл в центр
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, view.w, view.h);
    ctx.globalAlpha = 1;

    // фон кольца
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // остаток окна — внешняя дуга, тает по часовой
    const left = clamp(1 - Q.t / Math.max(0.001, Q.window), 0, 1);
    ctx.lineWidth = 10;
    ctx.strokeStyle = left > 0.35 ? U.colors.warn : U.colors.danger;
    ctx.beginPath();
    ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
    ctx.stroke();

    // прогресс удержания — внутренняя дуга
    const hold = clamp(Q.held / Math.max(0.001, Q.need), 0, 1);
    ctx.lineWidth = 6;
    ctx.strokeStyle = U.colors.ok;
    ctx.beginPath();
    ctx.arc(cx, cy, R - 14, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * hold);
    ctx.stroke();

    // сердцевина
    ctx.globalAlpha = Q.holding ? 0.85 : 0.4 + 0.2 * Math.sin(S.time * 10);
    ctx.fillStyle = Q.holding ? U.colors.ok : U.colors.ink;
    ctx.beginPath();
    ctx.arc(cx, cy, 12 + (Q.holding ? 4 : 0), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    text(ctx, U.textQte, cx, cy - R - 22, U.colors.ink, U.fonts.big, 'center');
    const hint = S.touchUsed ? U.hintTouch : (U.hintKey + ' / ДЕРЖИ ПАЛЕЦ');
    text(ctx, hint, cx, cy + R + 26, U.colors.dim, U.fonts.main, 'center');
    text(ctx, (Math.max(0, Q.window - Q.t)).toFixed(1) + ' с', cx, cy + R + 46, U.colors.dim, U.fonts.small, 'center');

    ctx.restore();
  }

  function drawFlash(ctx, view) {
    const U = P.ui;
    const a = clamp(S.flash.t / U.flash, 0, 1);
    if (a <= 0) { return; }
    const cx = view.w / 2, cy = view.h * U.ringY;
    ctx.save();
    ctx.globalAlpha = a;
    text(ctx, S.flash.ok ? U.textOk : U.textFail, cx, cy,
         S.flash.ok ? U.colors.ok : U.colors.danger, U.fonts.big, 'center');
    if (!S.flash.ok) {
      ctx.globalAlpha = a * 0.28;
      ctx.fillStyle = U.colors.danger;
      ctx.fillRect(0, 0, view.w, view.h);
    }
    ctx.restore();
  }

  function onRender(p) {
    if (!p || !p.ctx || !P.enabled) { return; }
    const ctx = p.ctx;
    const view = viewSize(ctx);

    // канвас узнаём отсюда — Core владеет им, мы только вешаем свой тач-обработчик
    if (ctx.canvas && S.boundCanvas !== ctx.canvas) { bindInput(ctx.canvas); }

    const k = clamp(S.value / P.max, 0, 1);
    const beat = heartbeat(S.time, k);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    drawVignette(ctx, view, k, beat);
    drawBar(ctx, view, k, beat);
    if (S.qte.active) { drawQte(ctx, view); }
    drawFlash(ctx, view);

    ctx.restore();
  }

  /* ==========================================================================
   * 9. ПОДПИСКА НА ШИНУ
   * ========================================================================*/

  const HANDLERS = {
    'game:start':    onStart,
    'game:tick':     onTick,
    'game:render':   onRender,
    'game:over':     onOver,
    'player:move':   onPlayerMove,
    'monster:pos':   onMonsterPos,
    'monster:state': onMonsterState,
    'noise:emit':    onNoiseEmit,
    'mic:denied':    onMicDenied,
    'mic:blow':      onMicBlow,
    'input:action':  onInputAction
  };

  let bound = false;
  function bindBus() {
    if (bound) { return true; }
    if (!SS.bus || typeof SS.bus.on !== 'function') { return false; }
    for (const key in HANDLERS) {
      if (Object.prototype.hasOwnProperty.call(HANDLERS, key)) { SS.bus.on(key, HANDLERS[key]); }
    }
    bound = true;
    return true;
  }
  function waitForBus() {
    if (bindBus()) { return; }
    const timer = setInterval(() => { if (bindBus()) { clearInterval(timer); } }, 40);
    setTimeout(() => clearInterval(timer), 15000);
  }
  waitForBus();
  bindInput(null);   // клавиатуру вешаем сразу, канвас — в первом кадре

  /* ==========================================================================
   * 10. ПУБЛИЧНЫЙ СЛОТ
   * ========================================================================*/

  SS.Panic = {
    __loaded: true,
    version: '1.0.0',
    reloadConfig: snapshotConfig,
    // Чтение значения для отладки; штатный канал — событие 'panic:change'
    getValue() { return S.value; },
    isQteActive() { return S.qte.active; },
    // Ручное добавление паники (для скриптовых сцен): add(15)
    add(v) { if (typeof v === 'number') { setValue(S.value + v); } },
    debugState() { return S; },
    _bind: waitForBus
  };

  /* ==========================================================================
   * --- DEV STUB ---
   * Если настоящего Core нет, тестовое окружение поднимает hud.js
   * (там же шина, канвас, цикл, уровень и фейковые игрок/монстр/микрофон).
   * Здесь остаётся только страховка на случай запуска panic.js в одиночку.
   * ========================================================================*/
  if (!SS.Core) {
    if (!SS.bus) {
      const map = new Map();
      SS.bus = {
        on(e, f) { if (!map.has(e)) { map.set(e, []); } map.get(e).push(f); },
        off(e, f) { const a = map.get(e); if (a) { const i = a.indexOf(f); if (i >= 0) { a.splice(i, 1); } } },
        emit(e, p) { const a = map.get(e); if (!a) { return; } for (let i = 0; i < a.length; i++) { try { a[i](p); } catch (err) { console.error(e, err); } } }
      };
      bindBus();
      console.warn('[SS.Panic] DEV STUB: нет ни Core, ни hud.js — подключите js/hud.js для полноценной песочницы.');
    }
  }

})(typeof window !== 'undefined' ? window : globalThis);
