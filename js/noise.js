/* ============================================================================
 *  Silent Step — модуль SS.Noise
 *  Регистрация шума и затухание: превращает 'noise:emit' в 'noise:heard'
 *  для монстра по таблице баланса.
 *
 *  ВНИМАНИЕ ВЛАДЕЛЬЦУ СЛОТА: минимальная реализация, чтобы слепой монстр
 *  вообще что-то слышал. Контракт соблюдён, файл заменяем целиком.
 * ==========================================================================*/
(function (global) {
  'use strict';

  const SS = (global.SS = global.SS || {});
  if (SS.Noise && SS.Noise.__loaded) { return; }

  const DEFAULTS = {
    thresholds: { alert: 4, attack: 7 },
    radius: { perLevel: 7.5, mid: 30, high: 50, openField: 10 },
    minEffective: 0.5
  };

  if (!SS.Config) { SS.Config = {}; }
  if (SS.Config && typeof SS.Config === 'object' && !SS.Config.noise) { SS.Config.noise = DEFAULTS; }

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
        try { const v = SS.Config.get('noise.' + path); if (v !== undefined && v !== null) { return v; } }
        catch (e) { /* игнорируем */ }
      }
      const v2 = readPath(SS.Config, 'noise.' + path);
      if (v2 !== undefined && v2 !== null) { return v2; }
    }
    return readPath(DEFAULTS, path);
  }

  let P = null;
  function snapshotConfig() {
    P = { th: cfg('thresholds'), radius: cfg('radius'), minEffective: cfg('minEffective') };
  }
  snapshotConfig();

  const listener = { x: 48, y: 48, known: false };

  // Радиус слышимости по таблице: 4–6 → 30 м, 7+ → 50 м, тише — линейно
  function audibleRadius(level) {
    const R = P.radius;
    if (level >= P.th.attack) { return R.high; }
    if (level >= P.th.alert) { return R.mid; }
    return Math.max(0, level) * R.perLevel;
  }

  function onEmit(p) {
    if (!p || typeof p.level !== 'number' || !listener.known) { return; }

    let att = 0;
    if (SS.Level && typeof SS.Level.occlusion === 'function') {
      try { att = Math.abs(SS.Level.occlusion(p.x, p.y, listener.x, listener.y) || 0); }
      catch (e) { att = 0; }
    }

    const effective = p.level - att;
    if (effective < P.minEffective) { return; }

    // на открытом поле (ни одной преграды по лучу) звук берёт дальше
    const radius = audibleRadius(effective) + (att === 0 ? P.radius.openField : 0);
    const dist = Math.hypot(listener.x - p.x, listener.y - p.y);
    if (dist > radius) { return; }

    SS.bus.emit('noise:heard', {
      level: p.level,
      effective: effective,
      x: p.x, y: p.y,
      source: p.source || 'env'
    });
  }

  function onMonsterPos(p) {
    if (!p) { return; }
    listener.x = p.x; listener.y = p.y; listener.known = true;
  }

  let bound = false;
  function bindBus() {
    if (bound) { return true; }
    if (!SS.bus || typeof SS.bus.on !== 'function') { return false; }
    SS.bus.on('noise:emit', onEmit);
    SS.bus.on('monster:pos', onMonsterPos);
    SS.bus.on('game:start', snapshotConfig);
    bound = true;
    return true;
  }
  function waitForBus() {
    if (bindBus()) { return; }
    const timer = setInterval(() => { if (bindBus()) { clearInterval(timer); } }, 40);
    setTimeout(() => clearInterval(timer), 15000);
  }
  waitForBus();

  SS.Noise = {
    __loaded: true,
    version: '1.0.0',
    audibleRadius: audibleRadius,
    reloadConfig: snapshotConfig,
    _bind: waitForBus
  };

})(typeof window !== 'undefined' ? window : globalThis);
