/* ============================================================================
 *  Silent Step — модуль SS.HUD
 *  Виброметр, волны шума, индикаторы стойки / поверхности / микрофона,
 *  «чутьё» (направление на монстра).
 *
 *  Владелец слота SS.HUD. С другими модулями общается ТОЛЬКО через SS.bus
 *  и разрешённые [QUERY]-функции (SS.Level.*, SS.Config.get, SS.Core.time/rand).
 *  Рисует исключительно в обработчике 'game:render' и только в свой слой.
 * ==========================================================================*/
(function (global) {
  'use strict';

  const SS = (global.SS = global.SS || {});
  if (SS.HUD && SS.HUD.__loaded) { return; }   // защита от двойного подключения

  /* ==========================================================================
   * 1. ПАРАМЕТРЫ МОДУЛЯ
   *    Все числа живут здесь и публикуются в SS.Config.hud.
   *    Чтение всегда идёт через cfg() → сначала SS.Config, потом DEFAULTS.
   * ========================================================================*/
  const DEFAULTS = {
    enabled: true,

    // В каких единицах приходят координаты мира из событий и [QUERY]-функций.
    // 'm'  — метры (тайл = 1 м), 'px' — мировые пиксели (1 м = 32 px).
    worldUnit: 'm',
    pixelsPerMeter: 32,
    viewport: { w: 1280, h: 720 },

    // Пороги из таблицы баланса
    thresholds: { alert: 4, attack: 7, max: 10 },

    // Виброметр — вертикальный столбик слева
    vibro: {
      x: 40, top: 132, w: 30, h: 402,
      rise: 26,          // скорость подъёма стрелки, ед/с
      fall: 3.4,         // спад «сырого» уровня, ед/с
      peakHold: 0.7,     // сколько держится метка пика, с
      peakFall: 2.4,     // скорость сползания метки пика, ед/с
      ownRadius: 2.2,    // м: шум ближе этого к игроку считается «своим»
      heardHold: 1.4     // с: сколько горит метка «монстр услышал»
    },

    // Волны шума в мире
    waves: {
      speed: 22,         // м/с — скорость роста кольца (условная, не звук)
      life: 2.4,         // с — время жизни кольца
      maxAlive: 56,
      rays: 24,          // лучей для учёта преград (0 — ровная окружность)
      raysMinLevel: 3,   // тише этого — не тратим occlusion, рисуем круг
      radiusPerLevel: 7.5, // м на единицу шума ниже порога тревоги (4 → 30 м)
      radiusMid: 30,     // м: слышимость шума 4..6
      radiusHigh: 50,    // м: слышимость шума 7+
      lineWidth: 2,
      fillAlpha: 0.04,
      sourceDot: 3.5
    },

    // «Чутьё»: глухой герой не слышит монстра, но чувствует его вблизи
    sense: {
      radius: 11,        // м — с какого расстояния появляется засветка края
      edgeWidth: 56,     // px — толщина засветки
      showHearRing: true // рисовать радиус слуха монстра, когда игрок внутри
    },

    // Панель микрофона
    mic: { barW: 214, barH: 10, threshold: 0.35, blowFlash: 0.55, silence: 1.2 },

    // Общая раскладка панелей
    panel: {
      margin: 40, lineH: 21, padX: 12, padY: 10,
      width: 268,
      bg: 'rgba(7,11,15,0.60)',
      edge: 'rgba(150,190,210,0.16)'
    },

    colors: {
      ink: '#e6eef6', dim: '#7b8794', deep: '#0a0f14',
      calm: '#4fd1a5', warn: '#ffc857', danger: '#ff4d5e',
      step: '#7fd4ff', mic: '#ffa25c', item: '#c9a7ff', env: '#9affc9',
      heard: '#ff4d5e'
    },

    // Таблица баланса поверхностей: [мин, макс] шума
    surfaces: {
      moss: [1, 1], grass: [2, 2], tallgrass: [3, 3], wood: [4, 7],
      leaves: [6, 6], gravel: [6, 6], water: [7, 7], metal: [8, 8]
    },
    surfaceNames: {
      moss: 'МОХ', grass: 'ТРАВА', tallgrass: 'ВЫСОКАЯ ТРАВА', wood: 'ДОСКИ',
      leaves: 'СУХИЕ ЛИСТЬЯ', gravel: 'ГРАВИЙ', water: 'ВОДА', metal: 'МЕТАЛЛ'
    },
    stanceNames:  { stand: 'СТОЯ', crouch: 'ПРИСЕД', prone: 'ПОЛЗКОМ' },
    stanceHints:  {
      stand:  'полный шум',
      crouch: '−2 шума · ×0.5 скорость',
      prone:  'шум 0 · только мох и трава'
    },
    sourceNames:  { step: 'шаг', mic: 'микрофон', item: 'предмет', env: 'окружение' },

    fonts: {
      small: '500 12px "Trebuchet MS", "Segoe UI", system-ui, sans-serif',
      main:  '600 14px "Trebuchet MS", "Segoe UI", system-ui, sans-serif',
      big:   '700 19px "Trebuchet MS", "Segoe UI", system-ui, sans-serif'
    }
  };

  /* ==========================================================================
   * 2. МОСТИК К SS.Config
   * ========================================================================*/

  // Публикуем свои параметры в общий Config, не затирая чужое и уже заданное.
  if (!SS.Config) { SS.Config = {}; }        // только пустой контейнер, не заглушка
  if (SS.Config && typeof SS.Config === 'object' && !SS.Config.hud) {
    SS.Config.hud = DEFAULTS;
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

  // cfg('vibro.rise') → SS.Config.get('hud.vibro.rise') → SS.Config.hud... → DEFAULTS
  function cfg(path) {
    if (SS.Config) {
      if (typeof SS.Config.get === 'function') {
        try {
          const v = SS.Config.get('hud.' + path);
          if (v !== undefined && v !== null) { return v; }
        } catch (e) { /* чужой модуль не должен ронять HUD */ }
      }
      const v2 = readPath(SS.Config, 'hud.' + path);
      if (v2 !== undefined && v2 !== null) { return v2; }
    }
    return readPath(DEFAULTS, path);
  }

  // Порог микрофона живёт в чужом неймспейсе — читаем через тот же [QUERY].
  function micThreshold() {
    if (SS.Config && typeof SS.Config.get === 'function') {
      try {
        const v = SS.Config.get('mic.threshold');
        if (typeof v === 'number') { return v; }
      } catch (e) { /* нет — берём своё значение */ }
    }
    return cfg('mic.threshold');
  }

  // Снимок параметров: обновляется на 'game:start' и по HUD.reloadConfig()
  let P = null;
  function snapshotConfig() {
    P = {
      enabled: cfg('enabled'),
      worldUnit: cfg('worldUnit'),
      ppm: cfg('pixelsPerMeter'),
      viewport: cfg('viewport'),
      th: cfg('thresholds'),
      vibro: cfg('vibro'),
      waves: cfg('waves'),
      sense: cfg('sense'),
      mic: cfg('mic'),
      panel: cfg('panel'),
      colors: cfg('colors'),
      surfaces: cfg('surfaces'),
      surfaceNames: cfg('surfaceNames'),
      stanceNames: cfg('stanceNames'),
      stanceHints: cfg('stanceHints'),
      sourceNames: cfg('sourceNames'),
      fonts: cfg('fonts')
    };
  }
  snapshotConfig();

  /* ==========================================================================
   * 3. ЕДИНИЦЫ И ГЕОМЕТРИЯ
   * ========================================================================*/

  const toM      = (v) => (P.worldUnit === 'px' ? v / P.ppm : v);       // мир → метры
  const fromM    = (v) => (P.worldUnit === 'px' ? v * P.ppm : v);       // метры → мир
  const worldPx  = (v) => (P.worldUnit === 'px' ? v : v * P.ppm);       // мир → мировые пиксели

  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));

  function distM(ax, ay, bx, by) {
    const dx = toM(bx - ax), dy = toM(by - ay);
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Логический размер вьюпорта: учитываем DPR-масштаб, если Core его выставил.
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
    const w = c.width / (sx || 1);
    const h = c.height / (sy || 1);
    return { w: w > 0 ? w : P.viewport.w, h: h > 0 ? h : P.viewport.h };
  }

  /**
   * Мир → экран. Поддерживает три формы камеры (см. ЗАПРОС К КОНТРАКТУ):
   *   cam.toScreen(x, y)          — если Core даёт готовую функцию;
   *   { left, top, zoom }         — камера задана левым верхним углом;
   *   { x, y, zoom }              — камера задана центром (значение по умолчанию).
   */
  function worldToScreen(cam, wx, wy, view) {
    if (cam && typeof cam.toScreen === 'function') {
      const p = cam.toScreen(wx, wy);
      if (p && typeof p.x === 'number') { return p; }
    }
    const z = (cam && (cam.zoom || cam.scale)) || 1;
    const px = worldPx(wx), py = worldPx(wy);
    if (cam && cam.left !== undefined && cam.top !== undefined) {
      return { x: (px - worldPx(cam.left)) * z, y: (py - worldPx(cam.top)) * z };
    }
    const cx = worldPx((cam && cam.x) || 0);
    const cy = worldPx((cam && cam.y) || 0);
    return { x: (px - cx) * z + view.w / 2, y: (py - cy) * z + view.h / 2 };
  }

  // Экранная длина отрезка в метрах
  function metersToScreen(cam, meters) {
    const z = (cam && (cam.zoom || cam.scale)) || 1;
    return worldPx(fromM(meters)) * z;
  }

  /* ==========================================================================
   * 4. СОСТОЯНИЕ МОДУЛЯ
   * ========================================================================*/

  const S = {
    started: false,
    over: false,
    visible: true,
    time: 0,

    // игрок
    player: { x: 0, y: 0, known: false, stance: 'stand', speed: 0, surface: null },

    // виброметр
    vRaw: 0,          // «сырой» уровень собственного шума (мгновенный, затухает)
    vShown: 0,        // сглаженное значение стрелки
    vPeak: 0,         // метка пика
    vPeakT: 0,
    vSource: null,    // источник последнего собственного шума
    heardT: 0,        // таймер метки «монстр услышал»
    heardEff: 0,

    // волны
    waves: [],

    // микрофон
    mic: { rms: 0, shown: 0, mapped: null, denied: false, active: false, silence: 99, blow: 0 },

    // монстр (только для «чутья» и рамки опасности)
    monster: { x: 0, y: 0, known: false, hearRadius: 0, state: null, dist: 999 },

    // всплывающая подпись о брошенном предмете
    toast: { text: '', t: 0 }
  };

  const rnd = () => (SS.Core && typeof SS.Core.rand === 'function' ? SS.Core.rand() : Math.random());

  /* ==========================================================================
   * 5. РАСЧЁТ СЛЫШИМОСТИ (таблица баланса)
   * ========================================================================*/

  // Радиус, на котором шум данного уровня ещё различим (без учёта преград)
  function audibleRadiusM(level) {
    const w = P.waves, th = P.th;
    if (level >= th.attack) { return w.radiusHigh; }         // 7+ → 50 м
    if (level >= th.alert)  { return w.radiusMid; }          // 4..6 → 30 м
    return Math.max(0, level) * w.radiusPerLevel;            // ниже порога — линейно
  }

  /**
   * Для каждого луча считаем, докуда доходит шум с учётом преград.
   * SS.Level.occlusion возвращает суммарное ослабление (стена −3, куст −1),
   * поэтому берём модуль и вычитаем из уровня.
   */
  function computeReach(x, y, level, maxR) {
    const rays = P.waves.rays | 0;
    if (!rays || level < P.waves.raysMinLevel) { return null; }
    if (!SS.Level || typeof SS.Level.occlusion !== 'function') { return null; }
    const out = new Float32Array(rays);
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2;
      const ex = x + Math.cos(a) * fromM(maxR);
      const ey = y + Math.sin(a) * fromM(maxR);
      let att = 0;
      try { att = Math.abs(SS.Level.occlusion(x, y, ex, ey) || 0); } catch (e) { att = 0; }
      out[i] = clamp(audibleRadiusM(level - att), 0, maxR);
    }
    return out;
  }

  function addWave(level, x, y, source) {
    const w = P.waves;
    if (!(level > 0)) { return null; }
    const maxR = audibleRadiusM(level);
    if (maxR <= 0.5) { return null; }
    const wave = {
      x: x, y: y, level: level, source: source || 'env',
      t: 0, life: w.life, maxR: maxR,
      reach: computeReach(x, y, level, maxR),
      heard: false, heardEff: 0
    };
    S.waves.push(wave);
    if (S.waves.length > w.maxAlive) { S.waves.splice(0, S.waves.length - w.maxAlive); }
    return wave;
  }

  /* ==========================================================================
   * 6. ОБРАБОТЧИКИ ШИНЫ
   * ========================================================================*/

  function onStart() {
    snapshotConfig();
    S.started = true;
    S.over = false;
    S.time = 0;
    S.waves.length = 0;
    S.vRaw = S.vShown = S.vPeak = S.vPeakT = 0;
    S.heardT = 0;
    S.toast.t = 0;
    S.mic.denied = false;
    S.mic.active = false;
  }

  function onOver(p) {
    S.over = true;
    S.toast.text = (p && p.cause === 'fall') ? 'ПАДЕНИЕ' : 'ЭХО НАШЁЛ ТЕБЯ';
    S.toast.t = 3;
  }

  function onTick(p) {
    if (!p) { return; }
    const dt = p.dt || 0;
    S.time = (typeof p.time === 'number') ? p.time : (S.time + dt);
    if (S.over) { return; }

    const V = P.vibro;

    // затухание «сырого» уровня и сглаживание стрелки
    S.vRaw = Math.max(0, S.vRaw - V.fall * dt);
    const speed = (S.vShown < S.vRaw) ? V.rise : V.fall * 1.6;
    const diff = S.vRaw - S.vShown;
    const step = speed * dt;
    S.vShown += (Math.abs(diff) <= step) ? diff : Math.sign(diff) * step;

    // метка пика
    if (S.vShown >= S.vPeak) { S.vPeak = S.vShown; S.vPeakT = V.peakHold; }
    else if (S.vPeakT > 0) { S.vPeakT -= dt; }
    else { S.vPeak = Math.max(S.vShown, S.vPeak - V.peakFall * dt); }

    if (S.heardT > 0) { S.heardT -= dt; }
    if (S.toast.t > 0) { S.toast.t -= dt; }

    // микрофон: плавная полоска и «тишина»
    S.mic.shown += (S.mic.rms - S.mic.shown) * Math.min(1, dt * 12);
    S.mic.silence += dt;
    if (S.mic.silence > P.mic.silence) { S.mic.mapped = null; }
    if (S.mic.blow > 0) { S.mic.blow -= dt; }

    // волны
    for (let i = S.waves.length - 1; i >= 0; i--) {
      const w = S.waves[i];
      w.t += dt;
      if (w.t >= w.life) { S.waves.splice(i, 1); }
    }

    // дистанция до монстра для «чутья»
    if (S.monster.known && S.player.known) {
      S.monster.dist = distM(S.player.x, S.player.y, S.monster.x, S.monster.y);
    }
  }

  function onPlayerMove(p) {
    if (!p) { return; }
    S.player.x = p.x; S.player.y = p.y; S.player.known = true;
    if (p.stance) { S.player.stance = p.stance; }
    if (typeof p.speed === 'number') { S.player.speed = p.speed; }
    // если поверхность ещё не приходила событием — спросим у уровня напрямую
    if (!S.player.surface && SS.Level && typeof SS.Level.surfaceAt === 'function') {
      try { S.player.surface = SS.Level.surfaceAt(p.x, p.y); } catch (e) { /* уровень не готов */ }
    }
  }

  function onSurface(p) { if (p && p.surface) { S.player.surface = p.surface; } }

  function onNoiseEmit(p) {
    if (!p || typeof p.level !== 'number') { return; }
    addWave(p.level, p.x, p.y, p.source);
    // «свой» ли это шум — по расстоянию до игрока
    const own = !S.player.known || distM(S.player.x, S.player.y, p.x, p.y) <= P.vibro.ownRadius;
    if (own && p.level > S.vRaw) {
      S.vRaw = p.level;
      S.vSource = p.source || 'env';
    }
  }

  function onNoiseHeard(p) {
    if (!p) { return; }
    const eff = (typeof p.effective === 'number') ? p.effective : p.level;
    if (!(eff > 0)) { return; }
    // помечаем ближайшую свежую волну как «дошедшую»
    let best = null, bestD = Infinity;
    for (let i = S.waves.length - 1; i >= 0; i--) {
      const w = S.waves[i];
      if (w.t > 0.35) { continue; }
      const d = distM(w.x, w.y, p.x, p.y);
      if (d < bestD) { bestD = d; best = w; }
    }
    if (best && bestD < 2.5) { best.heard = true; best.heardEff = eff; }
    if (eff >= P.th.alert) { S.heardT = P.vibro.heardHold; S.heardEff = eff; }
  }

  function onMicLevel(p) {
    if (!p) { return; }
    S.mic.rms = (typeof p.rms === 'number') ? p.rms : 0;
    S.mic.active = true;
    S.mic.silence = 0;
    S.mic.mapped = (typeof p.mapped === 'number') ? p.mapped : null;
  }

  function onMicBlow() { S.mic.blow = P.mic.blowFlash; }
  function onMicDenied() { S.mic.denied = true; S.mic.active = false; }

  function onMonsterPos(p) {
    if (!p) { return; }
    S.monster.x = p.x; S.monster.y = p.y; S.monster.known = true;
    if (typeof p.hearRadius === 'number') { S.monster.hearRadius = p.hearRadius; }
  }

  function onMonsterState(p) {
    if (!p) { return; }
    S.monster.state = p.to || null;
    if (typeof p.x === 'number') { S.monster.x = p.x; S.monster.y = p.y; S.monster.known = true; }
  }

  function onItemThrown(p) {
    if (!p) { return; }
    const name = p.type ? String(p.type).toUpperCase() : 'ПРЕДМЕТ';
    S.toast.text = 'БРОШЕНО: ' + name;
    S.toast.t = 1.8;
  }

  /* ==========================================================================
   * 7. РИСОВАНИЕ
   * ========================================================================*/

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
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
    ctx.font = font || P.fonts.main;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillText(str, x + 1, y + 1);
    ctx.fillStyle = color || P.colors.ink;
    ctx.fillText(str, x, y);
  }

  // Цвет по уровню шума: спокойный → тревога → атака
  function levelColor(level) {
    const c = P.colors, th = P.th;
    if (level >= th.attack) { return c.danger; }
    if (level >= th.alert)  { return c.warn; }
    return c.calm;
  }

  function sourceColor(src) {
    const c = P.colors;
    return c[src] || c.env;
  }

  /* --- 7.1 Волны шума (мировой слой) ------------------------------------- */

  // Открытые сектора волны: направления, куда шум ещё доходит на радиусе rNow.
  // Возвращает массив пар [начальный угол, конечный угол] в радианах.
  function openSectors(wave, rNow) {
    if (!wave.reach) { return [[0, Math.PI * 2]]; }
    const n = wave.reach.length;
    const seg = (Math.PI * 2) / n;
    const runs = [];
    let start = -1;
    for (let j = 0; j <= n; j++) {
      const idx = j % n;
      const open = (j < n) && (wave.reach[idx] >= rNow - 0.05);
      if (open && start < 0) { start = idx; }
      if (!open && start >= 0) { runs.push([start * seg, j * seg]); start = -1; }
    }
    // сектор, замкнувшийся через ноль
    if (start >= 0) { runs.push([start * seg, n * seg]); }
    if (runs.length === 1 && runs[0][1] - runs[0][0] >= Math.PI * 2 - 1e-6) {
      return [[0, Math.PI * 2]];
    }
    return runs;
  }

  function drawWaves(ctx, cam, view) {
    const W = P.waves;
    for (let i = 0; i < S.waves.length; i++) {
      const w = S.waves[i];
      const k = w.t / w.life;                       // 0..1 — прогресс жизни
      const rNow = Math.min(w.maxR, W.speed * w.t); // текущий радиус, м
      if (rNow <= 0.2) { continue; }
      const alpha = Math.pow(1 - k, 1.6);
      const col = w.heard ? P.colors.heard : sourceColor(w.source);
      const p0 = worldToScreen(cam, w.x, w.y, view);
      const rPx = metersToScreen(cam, rNow);

      // грубый отсев за пределами экрана
      if (p0.x + rPx < -80 || p0.x - rPx > view.w + 80 ||
          p0.y + rPx < -80 || p0.y - rPx > view.h + 80) { continue; }

      const runs = openSectors(w, rNow);

      ctx.save();
      ctx.lineWidth = W.lineWidth * (w.heard ? 1.6 : 1);
      ctx.strokeStyle = col;
      ctx.fillStyle = col;

      // заливка сектора — еле заметная подсветка «дошло сюда»
      ctx.globalAlpha = alpha * W.fillAlpha;
      for (let r = 0; r < runs.length; r++) {
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.arc(p0.x, p0.y, rPx, runs[r][0], runs[r][1]);
        ctx.closePath();
        ctx.fill();
      }

      // сам фронт волны: за стенами дуга просто обрывается
      ctx.globalAlpha = alpha;
      for (let r = 0; r < runs.length; r++) {
        ctx.beginPath();
        ctx.arc(p0.x, p0.y, rPx, runs[r][0], runs[r][1]);
        ctx.stroke();
      }

      // точка источника
      ctx.globalAlpha = alpha * 0.9;
      ctx.beginPath();
      ctx.arc(p0.x, p0.y, W.sourceDot, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /* --- 7.2 Кольцо слуха монстра (мировой слой) --------------------------- */
  function drawHearRing(ctx, cam, view) {
    if (!P.sense.showHearRing) { return; }
    if (!S.monster.known || !S.player.known) { return; }
    const rM = toM(S.monster.hearRadius);
    if (!(rM > 0)) { return; }
    if (S.monster.dist > rM) { return; }            // рисуем, только когда игрок внутри
    const p = worldToScreen(cam, S.monster.x, S.monster.y, view);
    const r = metersToScreen(cam, rM);
    ctx.save();
    ctx.globalAlpha = 0.20 + 0.10 * Math.sin(S.time * 3);
    ctx.strokeStyle = P.colors.danger;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 10]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /* --- 7.3 Виброметр (экранный слой) ------------------------------------- */
  function drawVibro(ctx, view) {
    const V = P.vibro, C = P.colors, th = P.th;
    const x = V.x, w = V.w;
    const top = V.top;
    const h = Math.min(V.h, view.h - top - 150);
    const bottom = top + h;
    const unit = h / th.max;

    ctx.save();

    // корпус
    ctx.globalAlpha = 0.9;
    roundRect(ctx, x - 6, top - 26, w + 12, h + 46, 8);
    ctx.fillStyle = P.panel.bg;
    ctx.fill();
    ctx.strokeStyle = P.panel.edge;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;

    text(ctx, 'ВИБРО', x - 2, top - 10, C.dim, P.fonts.small);

    // шкала-фон
    roundRect(ctx, x, top, w, h, 5);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fill();

    // заливка снизу вверх
    const lvl = clamp(S.vShown, 0, th.max);
    const fh = lvl * unit;
    if (fh > 0.5) {
      const g = ctx.createLinearGradient(0, bottom, 0, top);
      g.addColorStop(0, C.calm);
      g.addColorStop(clamp(th.alert / th.max, 0, 1), C.warn);
      g.addColorStop(1, C.danger);
      ctx.save();
      roundRect(ctx, x, bottom - fh, w, fh, 5);
      ctx.clip();
      ctx.fillStyle = g;
      ctx.fillRect(x, top, w, h);
      ctx.restore();
    }

    // деления по единицам
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1;
    for (let i = 1; i < th.max; i++) {
      const yy = Math.round(bottom - i * unit) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, yy);
      ctx.lineTo(x + w * ((i % 5 === 0) ? 1 : 0.45), yy);
      ctx.stroke();
    }

    // пороги тревоги и атаки
    const marks = [
      { v: th.alert,  col: C.warn,   label: 'СЛЫШИТ' },
      { v: th.attack, col: C.danger, label: 'БЕЖИТ' }
    ];
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      const yy = Math.round(bottom - m.v * unit) + 0.5;
      ctx.strokeStyle = m.col;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 5, yy);
      ctx.lineTo(x + w + 5, yy);
      ctx.stroke();
      ctx.globalAlpha = 1;
      text(ctx, m.label, x + w + 10, yy + 4, m.col, P.fonts.small);
    }

    // метка пика
    if (S.vPeak > 0.15) {
      const yy = Math.round(bottom - clamp(S.vPeak, 0, th.max) * unit) + 0.5;
      ctx.strokeStyle = C.ink;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, yy);
      ctx.lineTo(x + w, yy);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // числовое значение и источник
    const col = levelColor(lvl);
    text(ctx, lvl.toFixed(1), x + w / 2, bottom + 18, col, P.fonts.big, 'center');
    if (lvl > 0.2 && S.vSource) {
      text(ctx, P.sourceNames[S.vSource] || S.vSource, x + w + 10, bottom + 18, C.dim, P.fonts.small);
    }

    // «монстр услышал» — красная рамка вокруг виброметра
    if (S.heardT > 0) {
      const a = clamp(S.heardT / P.vibro.heardHold, 0, 1);
      ctx.globalAlpha = a * (0.6 + 0.4 * Math.sin(S.time * 18));
      ctx.strokeStyle = C.heard;
      ctx.lineWidth = 2;
      roundRect(ctx, x - 7, top - 27, w + 14, h + 48, 9);
      ctx.stroke();
      ctx.globalAlpha = 1;
      text(ctx, 'УСЛЫШАНО ' + S.heardEff.toFixed(1), x - 6, top - 34, C.heard, P.fonts.small);
    }

    ctx.restore();
  }

  /* --- 7.4 Панель индикаторов (экранный слой) ---------------------------- */
  function drawPanel(ctx, view) {
    const PN = P.panel, C = P.colors;
    const lineH = PN.lineH;
    const w = PN.width;
    const h = lineH * 3 + PN.padY * 2 + 18;
    const x = PN.margin;
    const y = view.h - PN.margin - h;

    ctx.save();
    ctx.globalAlpha = 0.92;
    roundRect(ctx, x, y, w, h, 8);
    ctx.fillStyle = PN.bg;
    ctx.fill();
    ctx.strokeStyle = PN.edge;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;

    let ly = y + PN.padY + 14;
    const lx = x + PN.padX;

    // стойка
    const st = S.player.stance || 'stand';
    text(ctx, 'СТОЙКА', lx, ly, C.dim, P.fonts.small);
    text(ctx, P.stanceNames[st] || st, lx + 74, ly, C.ink, P.fonts.main);
    text(ctx, P.stanceHints[st] || '', lx + 74, ly + 14, C.dim, P.fonts.small);
    ly += lineH + 12;

    // поверхность
    const sf = S.player.surface;
    text(ctx, 'ПОД НОГАМИ', lx, ly, C.dim, P.fonts.small);
    if (sf) {
      const range = P.surfaces[sf] || [0, 0];
      const nm = P.surfaceNames[sf] || String(sf).toUpperCase();
      const noiseStr = (range[0] === range[1]) ? String(range[0]) : (range[0] + '–' + range[1]);
      text(ctx, nm, lx + 88, ly, levelColor(range[1]), P.fonts.main);
      text(ctx, 'шум ' + noiseStr, lx + 88, ly + 14, C.dim, P.fonts.small);
    } else {
      text(ctx, '—', lx + 88, ly, C.dim, P.fonts.main);
    }
    ly += lineH + 12;

    // микрофон
    text(ctx, 'МИКРОФОН', lx, ly, C.dim, P.fonts.small);
    const bx = lx + 88, by = ly - 9, bw = Math.min(P.mic.barW, w - (bx - x) - PN.padX), bh = P.mic.barH;
    if (S.mic.denied || !S.mic.active) {
      text(ctx, S.mic.denied ? 'ВЫКЛ — вместо него QTE' : 'ожидание доступа…',
           bx, ly, S.mic.denied ? C.warn : C.dim, P.fonts.small);
    } else {
      roundRect(ctx, bx, by, bw, bh, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fill();
      const thr = clamp(micThreshold(), 0.01, 1);
      const fill = clamp(S.mic.shown, 0, 1);
      ctx.save();
      roundRect(ctx, bx, by, bw * fill, bh, 3);
      ctx.clip();
      const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      g.addColorStop(0, C.calm);
      g.addColorStop(clamp(thr, 0, 1), C.warn);
      g.addColorStop(1, C.danger);
      ctx.fillStyle = g;
      ctx.fillRect(bx, by, bw, bh);
      ctx.restore();
      // отметка порога
      const tx = Math.round(bx + bw * thr) + 0.5;
      ctx.strokeStyle = C.ink;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tx, by - 2);
      ctx.lineTo(tx, by + bh + 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const info = (S.mic.mapped !== null && S.mic.mapped !== undefined)
        ? ('шум ' + Number(S.mic.mapped).toFixed(1))
        : 'тихо';
      text(ctx, info, bx, ly + 16, (S.mic.mapped !== null && S.mic.mapped !== undefined) ? C.warn : C.dim, P.fonts.small);
      // вспышка на выдох
      if (S.mic.blow > 0) {
        ctx.globalAlpha = clamp(S.mic.blow / P.mic.blowFlash, 0, 1);
        text(ctx, 'ВЫДОХ', bx + bw - 4, ly + 16, C.mic, P.fonts.small, 'right');
        ctx.globalAlpha = 1;
      }
    }

    ctx.restore();
  }

  /* --- 7.5 Часы и всплывающая подпись ------------------------------------ */
  function drawTop(ctx, view) {
    const C = P.colors;
    const t = (SS.Core && typeof SS.Core.time === 'number') ? SS.Core.time : S.time;
    const mm = Math.floor(t / 60), ss = Math.floor(t % 60);
    const str = (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
    text(ctx, str, view.w - P.panel.margin, P.panel.margin + 4, C.dim, P.fonts.main, 'right');

    if (S.toast.t > 0) {
      ctx.save();
      ctx.globalAlpha = clamp(S.toast.t, 0, 1);
      text(ctx, S.toast.text, view.w / 2, P.panel.margin + 6, C.ink, P.fonts.main, 'center');
      ctx.restore();
    }
  }

  /* --- 7.6 «Чутьё»: засветка края экрана в сторону монстра ---------------- */
  function drawSense(ctx, view) {
    if (!S.monster.known || !S.player.known) { return; }
    const R = P.sense.radius;
    const d = S.monster.dist;
    if (d > R) { return; }
    const k = clamp(1 - d / R, 0, 1);
    const ang = Math.atan2(toM(S.monster.y - S.player.y), toM(S.monster.x - S.player.x));

    ctx.save();
    // общая пульсирующая виньетка опасности
    const pulse = 0.75 + 0.25 * Math.sin(S.time * (4 + 6 * k));
    ctx.globalAlpha = 0.55 * k * pulse;

    // направленная засветка: клин от центра экрана к краю
    const cx = view.w / 2, cy = view.h / 2;
    const far = Math.sqrt(cx * cx + cy * cy) + P.sense.edgeWidth;
    const g = ctx.createRadialGradient(cx, cy, far * 0.45, cx, cy, far);
    g.addColorStop(0, 'rgba(255,77,94,0)');
    g.addColorStop(1, P.colors.danger);
    ctx.fillStyle = g;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, far, ang - 0.75, ang + 0.75);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* --- 7.7 Общий обработчик отрисовки ------------------------------------ */
  function onRender(p) {
    if (!p || !p.ctx || !P.enabled || !S.visible) { return; }
    const ctx = p.ctx;
    const cam = p.cam || null;
    const view = viewSize(ctx);

    ctx.save();
    ctx.globalAlpha = S.over ? 0.35 : 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // мировой слой
    drawWaves(ctx, cam, view);
    drawHearRing(ctx, cam, view);

    // экранный слой
    drawSense(ctx, view);
    drawVibro(ctx, view);
    drawPanel(ctx, view);
    drawTop(ctx, view);

    ctx.restore();
  }

  /* ==========================================================================
   * 8. ПОДПИСКА НА ШИНУ (устойчиво к порядку загрузки модулей)
   * ========================================================================*/

  const HANDLERS = {
    'game:start':    onStart,
    'game:tick':     onTick,
    'game:render':   onRender,
    'game:over':     onOver,
    'noise:emit':    onNoiseEmit,
    'noise:heard':   onNoiseHeard,
    'player:move':   onPlayerMove,
    'player:surface': onSurface,
    'mic:level':     onMicLevel,
    'mic:blow':      onMicBlow,
    'mic:denied':    onMicDenied,
    'monster:pos':   onMonsterPos,
    'monster:state': onMonsterState,
    'item:thrown':   onItemThrown
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

  /* ==========================================================================
   * 9. ПУБЛИЧНЫЙ СЛОТ
   * ========================================================================*/

  SS.HUD = {
    __loaded: true,
    version: '1.0.0',
    // повторно прочитать SS.Config (для отладки баланса на лету)
    reloadConfig: snapshotConfig,
    setVisible(v) { S.visible = !!v; },
    isVisible() { return S.visible; },
    // только для чтения из отладчика
    debugState() { return S; },
    _bind: waitForBus
  };

  /* ==========================================================================
   * --- DEV STUB ---
   * Мини-окружение для проверки HUD и Panic в изоляции.
   * Включается ТОЛЬКО если настоящий SS.Core не загружен.
   * В боевой сборке (Core присутствует) блок не выполняется.
   * ========================================================================*/
  if (!SS.Core) {
    (function devStub() {
      // --- шина ---
      if (!SS.bus) {
        const map = new Map();
        SS.bus = {
          on(e, f) { if (!map.has(e)) { map.set(e, []); } map.get(e).push(f); },
          off(e, f) { const a = map.get(e); if (a) { const i = a.indexOf(f); if (i >= 0) { a.splice(i, 1); } } },
          emit(e, p) { const a = map.get(e); if (!a) { return; } for (let i = 0; i < a.length; i++) { try { a[i](p); } catch (err) { console.error(e, err); } } }
        };
      }

      // --- канвас ---
      const cv = document.createElement('canvas');
      cv.width = 1280; cv.height = 720;
      cv.style.cssText = 'display:block;margin:0 auto;background:#070b0e;max-width:100%;touch-action:none';
      cv.tabIndex = 0;
      const mount = () => { (document.body || document.documentElement).appendChild(cv); };
      if (document.body) { mount(); } else { document.addEventListener('DOMContentLoaded', mount); }
      const ctx = cv.getContext('2d');

      // --- ГПСЧ ---
      let seed = 1337;
      const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

      // --- уровень ---
      const WALLS = [
        { x: 18, y: 14, w: 14, h: 2 }, { x: 18, y: 14, w: 2, h: 12 },
        { x: 40, y: 30, w: 2, h: 18 }, { x: 26, y: 44, w: 20, h: 2 },
        { x: 56, y: 20, w: 2, h: 22 }
      ];
      const inWall = (x, y) => WALLS.some(w => x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h);
      if (!SS.Level) {
        const KINDS = ['moss', 'grass', 'tallgrass', 'leaves', 'gravel', 'wood', 'metal', 'water'];
        SS.Level = {
          surfaceAt(x, y) {
            const i = (Math.floor(x / 7) * 3 + Math.floor(y / 5) * 5) % KINDS.length;
            return KINDS[(i + KINDS.length) % KINDS.length];
          },
          isSolid: inWall,
          occlusion(ax, ay, bx, by) {
            let att = 0;
            const steps = 28;
            for (let i = 1; i <= steps; i++) {
              const t = i / steps;
              if (inWall(ax + (bx - ax) * t, ay + (by - ay) * t)) { att -= 3; break; }
            }
            return att;
          },
          randomPointNear(x, y, minR, maxR) {
            for (let i = 0; i < 24; i++) {
              const a = rand() * Math.PI * 2, r = minR + rand() * (maxR - minR);
              const nx = x + Math.cos(a) * r, ny = y + Math.sin(a) * r;
              if (!inWall(nx, ny)) { return { x: nx, y: ny }; }
            }
            return { x: x, y: y };
          }
        };
      }

      // --- ввод для тестового игрока ---
      const keys = Object.create(null);
      addEventListener('keydown', e => { keys[e.code] = true; });
      addEventListener('keyup', e => { keys[e.code] = false; });

      // --- состояние теста ---
      const pl = { x: 30, y: 30, stance: 'stand', surface: null, stepT: 0 };
      const mo = { x: 48, y: 34, state: 'PATROL', t: 0, hearRadius: 30 };
      let micDenied = false, micT = 0;
      addEventListener('keydown', e => {
        if (e.code === 'KeyC') { pl.stance = pl.stance === 'crouch' ? 'stand' : 'crouch'; }
        if (e.code === 'KeyX') { pl.stance = pl.stance === 'prone' ? 'stand' : 'prone'; }
        if (e.code === 'KeyM' && !micDenied) { micDenied = true; SS.bus.emit('mic:denied', {}); }
        if (e.code === 'KeyT') { SS.bus.emit('item:thrown', { type: 'камень', x: pl.x + 6, y: pl.y });
                                 SS.bus.emit('noise:emit', { level: 5, x: pl.x + 6, y: pl.y, source: 'item' }); }
      });

      const SURF_NOISE = { moss: 1, grass: 2, tallgrass: 3, wood: 5, leaves: 6, gravel: 6, water: 7, metal: 8 };

      function stubTick(dt) {
        // движение игрока
        let dx = 0, dy = 0;
        if (keys.KeyW || keys.ArrowUp) { dy -= 1; }
        if (keys.KeyS || keys.ArrowDown) { dy += 1; }
        if (keys.KeyA || keys.ArrowLeft) { dx -= 1; }
        if (keys.KeyD || keys.ArrowRight) { dx += 1; }
        const run = !!keys.ShiftLeft && pl.stance === 'stand';
        let sp = pl.stance === 'prone' ? 0.6 : (pl.stance === 'crouch' ? 1.1 : (run ? 3.4 : 2.0));
        const len = Math.hypot(dx, dy) || 1;
        if (dx || dy) {
          const nx = pl.x + (dx / len) * sp * dt, ny = pl.y + (dy / len) * sp * dt;
          if (!inWall(nx, ny)) { pl.x = nx; pl.y = ny; }
        } else { sp = 0; }
        SS.bus.emit('player:move', { x: pl.x, y: pl.y, stance: pl.stance, speed: sp });

        const surf = SS.Level.surfaceAt(pl.x, pl.y);
        if (surf !== pl.surface) { pl.surface = surf; SS.bus.emit('player:surface', { surface: surf }); }

        // шаги
        if (sp > 0.05) {
          pl.stepT -= dt * sp;
          if (pl.stepT <= 0) {
            pl.stepT = 0.9;
            let lvl = SURF_NOISE[surf] || 3;
            if (pl.stance === 'crouch') { lvl -= 2; }
            if (pl.stance === 'prone') { lvl = 0; }
            if (run) { lvl = Math.max(lvl, 8); }
            lvl = Math.max(0, lvl);
            if (lvl > 0) {
              SS.bus.emit('noise:emit', { level: lvl, x: pl.x, y: pl.y, source: 'step' });
              const att = Math.abs(SS.Level.occlusion(pl.x, pl.y, mo.x, mo.y));
              const d = Math.hypot(mo.x - pl.x, mo.y - pl.y);
              const eff = lvl - att - d * 0.12;
              if (eff > 0) { SS.bus.emit('noise:heard', { level: lvl, effective: eff, x: pl.x, y: pl.y, source: 'step' }); }
            }
          }
        }

        // монстр ходит по кругу и меняет состояние
        mo.t += dt;
        mo.x = 44 + Math.cos(mo.t * 0.25) * 12;
        mo.y = 34 + Math.sin(mo.t * 0.25) * 9;
        SS.bus.emit('monster:pos', { x: mo.x, y: mo.y, hearRadius: mo.hearRadius });
        const want = (Math.hypot(mo.x - pl.x, mo.y - pl.y) < 5) ? 'CHASE'
                   : (Math.floor(mo.t / 12) % 2 ? 'SEARCH' : 'PATROL');
        if (want !== mo.state) {
          SS.bus.emit('monster:state', { from: mo.state, to: want, x: mo.x, y: mo.y });
          mo.state = want;
        }

        // микрофон
        if (!micDenied) {
          micT += dt;
          const rms = Math.max(0, 0.12 + Math.sin(micT * 0.7) * 0.28 + (rand() - 0.5) * 0.05);
          const thr = 0.35;
          SS.bus.emit('mic:level', { rms: rms, mapped: rms > thr ? Math.min(9, rms * 12) : null });
          if (rms > 0.55 && rand() < 0.02) { SS.bus.emit('mic:blow', {}); }
        }
      }

      // --- фон и «мир» для наглядности ---
      function stubRender(cam) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#070b0e';
        ctx.fillRect(0, 0, cv.width, cv.height);
        const PPM = 32, cx = cv.width / 2, cy = cv.height / 2;
        const sx = (wx) => (wx - cam.x) * PPM + cx;
        const sy = (wy) => (wy - cam.y) * PPM + cy;
        // сетка
        ctx.strokeStyle = 'rgba(120,160,180,0.06)';
        ctx.lineWidth = 1;
        for (let i = -22; i <= 22; i++) {
          const gx = Math.round(sx(Math.round(cam.x) + i)) + 0.5;
          ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, cv.height); ctx.stroke();
          const gy = Math.round(sy(Math.round(cam.y) + i)) + 0.5;
          ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(cv.width, gy); ctx.stroke();
        }
        // стены
        ctx.fillStyle = 'rgba(150,180,200,0.18)';
        WALLS.forEach(w => ctx.fillRect(sx(w.x), sy(w.y), w.w * PPM, w.h * PPM));
        // игрок и монстр
        ctx.fillStyle = '#cfe8ff';
        ctx.beginPath(); ctx.arc(sx(pl.x), sy(pl.y), 8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ff4d5e';
        ctx.beginPath(); ctx.arc(sx(mo.x), sy(mo.y), 10, 0, Math.PI * 2); ctx.fill();
        // подсказка
        ctx.font = '500 12px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(180,200,215,0.5)';
        ctx.textAlign = 'right';
        ctx.fillText('WASD — идти · Shift — бег · C — присед · X — ползком · T — бросок · M — отказать микрофону · Пробел — QTE',
                     cv.width - 40, cv.height - 14);
        ctx.textAlign = 'left';
      }

      // --- цикл с фиксированным шагом ---
      const STEP = 1 / 60;
      let acc = 0, last = performance.now(), gameTime = 0;
      SS.Core = { time: 0, rand: rand, __stub: true };
      function frame(now) {
        acc += Math.min(0.25, (now - last) / 1000);
        last = now;
        while (acc >= STEP) {
          acc -= STEP;
          gameTime += STEP;
          SS.Core.time = gameTime;
          stubTick(STEP);
          SS.bus.emit('game:tick', { dt: STEP, time: gameTime });
        }
        const cam = { x: pl.x, y: pl.y, zoom: 1 };
        stubRender(cam);
        SS.bus.emit('game:render', { ctx: ctx, cam: cam });
        requestAnimationFrame(frame);
      }
      // старт после загрузки всех модулей
      setTimeout(() => {
        SS.bus.emit('game:start', {});
        requestAnimationFrame(frame);
      }, 0);
    })();
  }

})(typeof window !== 'undefined' ? window : globalThis);
