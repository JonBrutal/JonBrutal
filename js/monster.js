/* ============================================================================
 *  Silent Step — модуль SS.Monster
 *  «Эхо»: слепой охотник, живущий только слухом.
 *  FSM: PATROL → ALERT (шум>4, замирает 3–5 с) → SEARCH (обыск 8 м, 20 с)
 *       → CHASE (шум>7 или игрок ближе 5 м) → KILL (контакт).
 *
 *  Слышит только через 'noise:heard'. Позицию игрока использует ТОЛЬКО
 *  в радиусе чутья (5 м) — за его пределами монстр слеп и глух к движению.
 * ==========================================================================*/
(function (global) {
  'use strict';

  const SS = (global.SS = global.SS || {});
  if (SS.Monster && SS.Monster.__loaded) { return; }

  /* ==========================================================================
   * 1. ПАРАМЕТРЫ (таблица баланса)
   * ========================================================================*/
  const DEFAULTS = {
    thresholds: { alert: 4, attack: 7 },

    speed: { patrol: 1.5, chase: 6.0, search: 2.2 },   // м/с

    reaction: 0.8,               // с — задержка реакции на звук
    memory: 60,                  // с — память о звуке
    alertFreeze: [3, 5],         // с — замирание в ALERT
    search: { radius: 8, time: 20, pointTime: 3.5 },
    senseRadius: 5,              // м — на этом расстоянии чует жертву без звука
    killRadius: 0.6,             // м — контакт = смерть
    chaseMemory: 4.5,            // с — сколько гонится без новых звуков

    hearRadius: { calm: 30, hot: 50 },   // что показывать HUD как радиус слуха

    body: { r: 0.55 },
    colors: {
      body: '#1a1013', edge: '#3a2028',
      calm: '#4a5a66', alert: '#ffc857', search: '#ff9d5c', chase: '#ff4d5e'
    },
    stuck: { time: 0.7, detour: 6 }
  };

  if (!SS.Config) { SS.Config = {}; }
  if (SS.Config && typeof SS.Config === 'object' && !SS.Config.monster) { SS.Config.monster = DEFAULTS; }

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
        try { const v = SS.Config.get('monster.' + path); if (v !== undefined && v !== null) { return v; } }
        catch (e) { /* игнорируем */ }
      }
      const v2 = readPath(SS.Config, 'monster.' + path);
      if (v2 !== undefined && v2 !== null) { return v2; }
    }
    return readPath(DEFAULTS, path);
  }

  let P = null;
  function snapshotConfig() {
    P = {
      th: cfg('thresholds'), speed: cfg('speed'), reaction: cfg('reaction'),
      memory: cfg('memory'), alertFreeze: cfg('alertFreeze'), search: cfg('search'),
      senseRadius: cfg('senseRadius'), killRadius: cfg('killRadius'),
      chaseMemory: cfg('chaseMemory'), hearRadius: cfg('hearRadius'),
      body: cfg('body'), colors: cfg('colors'), stuck: cfg('stuck')
    };
  }
  snapshotConfig();

  const rnd = () => (SS.Core && typeof SS.Core.rand === 'function' ? SS.Core.rand() : Math.random());
  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));

  /* ==========================================================================
   * 2. СОСТОЯНИЕ
   * ========================================================================*/
  const S = {
    x: 48, y: 48,
    fx: 1, fy: 0,
    state: 'PATROL',
    stateT: 0,
    alive: true,

    wp: 0,                    // индекс точки патруля
    target: null,             // { x, y } куда идём
    lastNoise: null,          // { x, y, level, time } — память о звуке
    pending: [],              // звуки, ждущие задержки реакции

    freezeT: 0,               // остаток замирания в ALERT
    searchT: 0,               // остаток обыска
    pointT: 0,                // остаток стояния у точки обыска
    chaseT: 0,                // сколько гонится без новых звуков

    stuckT: 0, lastX: 48, lastY: 48,
    player: { x: 48, y: 48, known: false, dist: Infinity },

    pulse: 0
  };

  /* ==========================================================================
   * 3. ПЕРЕХОДЫ FSM
   * ========================================================================*/

  function setState(to) {
    if (S.state === to) { return; }
    const from = S.state;
    S.state = to;
    S.stateT = 0;
    SS.bus.emit('monster:state', { from: from, to: to, x: S.x, y: S.y });
  }

  function hearRadius() {
    return (S.state === 'CHASE' || S.state === 'SEARCH') ? P.hearRadius.hot : P.hearRadius.calm;
  }

  // Звук дошёл: кладём в очередь, применим через задержку реакции
  function onHeard(p) {
    if (!p || !S.alive) { return; }
    const eff = (typeof p.effective === 'number') ? p.effective : p.level;
    if (!(eff > P.th.alert)) { return; }             // тише порога тревоги — не реагирует
    S.pending.push({ x: p.x, y: p.y, level: eff, at: now() + P.reaction });
  }

  function now() { return (SS.Core && typeof SS.Core.time === 'number') ? SS.Core.time : S.stateT; }

  function applyPending() {
    const t = now();
    for (let i = S.pending.length - 1; i >= 0; i--) {
      const n = S.pending[i];
      if (n.at > t) { continue; }
      S.pending.splice(i, 1);
      S.lastNoise = { x: n.x, y: n.y, level: n.level, time: t };
      if (n.level > P.th.attack) {
        // громкий звук — сразу в погоню на его источник
        S.target = { x: n.x, y: n.y };
        S.chaseT = 0;
        setState('CHASE');
      } else if (S.state === 'PATROL' || S.state === 'ALERT') {
        S.target = { x: n.x, y: n.y };
        S.freezeT = P.alertFreeze[0] + rnd() * (P.alertFreeze[1] - P.alertFreeze[0]);
        setState('ALERT');
      } else if (S.state === 'SEARCH') {
        // новый звук во время обыска — переносим обыск туда
        S.target = { x: n.x, y: n.y };
        S.searchT = P.search.time;
        S.pointT = 0;
      }
    }
  }

  /* ==========================================================================
   * 4. ДВИЖЕНИЕ
   * ========================================================================*/

  function solid(x, y) {
    return (SS.Level && typeof SS.Level.isSolid === 'function') ? SS.Level.isSolid(x, y) : false;
  }
  function pit(x, y) {
    return (SS.Level && typeof SS.Level.isPit === 'function') ? SS.Level.isPit(x, y) : false;
  }
  function blocked(x, y) {
    const r = P.body.r * 0.8;
    return solid(x - r, y - r) || solid(x + r, y - r) || solid(x - r, y + r) || solid(x + r, y + r) || pit(x, y);
  }

  // Идём к цели, скользя вдоль стен; если застряли — берём обходную точку
  function moveTo(tx, ty, speed, dt) {
    const dx = tx - S.x, dy = ty - S.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.05) { return true; }
    const nx = dx / d, ny = dy / d;
    S.fx = nx; S.fy = ny;

    const stepX = S.x + nx * speed * dt;
    const stepY = S.y + ny * speed * dt;
    let moved = false;
    if (!blocked(stepX, S.y)) { S.x = stepX; moved = true; }
    if (!blocked(S.x, stepY)) { S.y = stepY; moved = true; }

    // застревание у угла: пробуем обойти перпендикулярно
    if (!moved) {
      const px = -ny, py = nx;
      const side = (rnd() < 0.5) ? 1 : -1;
      const ax = S.x + px * side * speed * dt, ay = S.y + py * side * speed * dt;
      if (!blocked(ax, ay)) { S.x = ax; S.y = ay; }
    }
    return d < 0.6;
  }

  function nextWaypoint() {
    const wps = (SS.Level && SS.Level.waypoints) ? SS.Level.waypoints : [];
    if (!wps.length) { return null; }
    S.wp = (S.wp + 1) % wps.length;
    return { x: wps[S.wp].x, y: wps[S.wp].y };
  }

  function searchPoint() {
    const c = S.lastNoise || S.target || { x: S.x, y: S.y };
    if (SS.Level && typeof SS.Level.randomPointNear === 'function') {
      return SS.Level.randomPointNear(c.x, c.y, 1, P.search.radius);
    }
    return { x: c.x, y: c.y };
  }

  /* ==========================================================================
   * 5. ШАГ СИМУЛЯЦИИ
   * ========================================================================*/

  function onTick(p) {
    if (!p || !S.alive) { return; }
    const dt = p.dt || 0;
    S.stateT += dt;
    S.pulse += dt;

    applyPending();

    // память о звуке живёт 60 с
    if (S.lastNoise && now() - S.lastNoise.time > P.memory) { S.lastNoise = null; }

    // чутьё вблизи: жертву слышно по дыханию, даже если она стоит
    if (S.player.known) {
      S.player.dist = Math.hypot(S.player.x - S.x, S.player.y - S.y);
      if (S.player.dist <= P.senseRadius && S.state !== 'KILL') {
        S.target = { x: S.player.x, y: S.player.y };
        S.chaseT = 0;
        setState('CHASE');
      }
      if (S.player.dist <= P.killRadius) {
        setState('KILL');
        SS.bus.emit('game:over', { cause: 'monster' });
        S.alive = false;
        return;
      }
    }

    switch (S.state) {
      case 'PATROL': {
        if (!S.target) { S.target = nextWaypoint() || { x: S.x, y: S.y }; }
        if (moveTo(S.target.x, S.target.y, P.speed.patrol, dt)) { S.target = nextWaypoint(); }
        break;
      }
      case 'ALERT': {
        // замирает и «вслушивается», повернувшись к источнику
        S.freezeT -= dt;
        if (S.target) {
          const dx = S.target.x - S.x, dy = S.target.y - S.y;
          const d = Math.hypot(dx, dy) || 1;
          S.fx = dx / d; S.fy = dy / d;
        }
        if (S.freezeT <= 0) {
          S.searchT = P.search.time;
          S.pointT = 0;
          setState('SEARCH');
        }
        break;
      }
      case 'SEARCH': {
        S.searchT -= dt;
        if (S.searchT <= 0) {
          S.target = nextWaypoint();
          setState('PATROL');
          break;
        }
        S.pointT -= dt;
        if (!S.target || S.pointT <= 0) {
          S.target = searchPoint();
          S.pointT = P.search.pointTime;
        }
        if (moveTo(S.target.x, S.target.y, P.speed.search, dt)) { S.pointT = 0; }
        break;
      }
      case 'CHASE': {
        S.chaseT += dt;
        // в упор идёт на саму жертву, иначе — на последний звук
        const goal = (S.player.known && S.player.dist <= P.senseRadius)
          ? { x: S.player.x, y: S.player.y }
          : (S.target || S.lastNoise || { x: S.x, y: S.y });
        const reached = moveTo(goal.x, goal.y, P.speed.chase, dt);
        if (reached || S.chaseT > P.chaseMemory) {
          if (S.player.known && S.player.dist <= P.senseRadius) {
            S.chaseT = 0;                      // жертва рядом — не отпускаем
          } else {
            S.searchT = P.search.time;
            S.pointT = 0;
            setState('SEARCH');
          }
        }
        break;
      }
      default: break;
    }

    // страховка от застревания геометрией
    if (Math.hypot(S.x - S.lastX, S.y - S.lastY) < 0.02) {
      S.stuckT += dt;
      if (S.stuckT > P.stuck.time) {
        S.stuckT = 0;
        if (SS.Level && typeof SS.Level.randomPointNear === 'function') {
          S.target = SS.Level.randomPointNear(S.x, S.y, 2, P.stuck.detour);
        }
      }
    } else {
      S.stuckT = 0;
    }
    S.lastX = S.x; S.lastY = S.y;

    SS.bus.emit('monster:pos', { x: S.x, y: S.y, hearRadius: hearRadius() });
  }

  function onPlayerMove(p) {
    if (!p) { return; }
    S.player.x = p.x; S.player.y = p.y; S.player.known = true;
  }

  /* ==========================================================================
   * 6. ОТРИСОВКА
   * ========================================================================*/

  function stateColor() {
    const C = P.colors;
    if (S.state === 'CHASE' || S.state === 'KILL') { return C.chase; }
    if (S.state === 'SEARCH') { return C.search; }
    if (S.state === 'ALERT') { return C.alert; }
    return C.calm;
  }

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
    const r = P.body.r * ppm;
    const C = P.colors;
    const col = stateColor();

    ctx.save();

    // тень
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.ellipse(px, py + r * 0.25, r * 1.05, r * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();

    // «слуховые» усики: пульсируют тем чаще, чем горячее состояние
    const rate = (S.state === 'CHASE') ? 9 : (S.state === 'PATROL' ? 2 : 4.5);
    const puls = 0.5 + 0.5 * Math.sin(S.pulse * rate);
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.35 + 0.35 * puls;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + S.pulse * 0.4;
      const len = r * (1.3 + 0.5 * puls);
      ctx.beginPath();
      ctx.moveTo(px + Math.cos(a) * r * 0.8, py + Math.sin(a) * r * 0.8);
      ctx.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // тело: слепая клякса без глаз
    const g = ctx.createRadialGradient(px, py, r * 0.2, px, py, r);
    g.addColorStop(0, C.edge);
    g.addColorStop(1, C.body);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.8;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // «раструб» уха в сторону последнего звука
    const dir = Math.atan2(S.fy, S.fx);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, r * 1.5, dir - 0.35, dir + 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  /* ==========================================================================
   * 7. ЖИЗНЕННЫЙ ЦИКЛ
   * ========================================================================*/

  function respawn() {
    snapshotConfig();
    const sp = (SS.Level && SS.Level.monsterSpawn) ? SS.Level.monsterSpawn : { x: 48, y: 48 };
    S.x = sp.x; S.y = sp.y;
    S.lastX = S.x; S.lastY = S.y;
    S.state = 'PATROL';
    S.stateT = 0;
    S.wp = 0;
    S.target = null;
    S.lastNoise = null;
    S.pending.length = 0;
    S.freezeT = S.searchT = S.pointT = S.chaseT = S.stuckT = 0;
    S.alive = true;
    S.player.known = false;
    S.player.dist = Infinity;
    SS.bus.emit('monster:state', { from: null, to: 'PATROL', x: S.x, y: S.y });
    SS.bus.emit('monster:pos', { x: S.x, y: S.y, hearRadius: hearRadius() });
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
    SS.bus.on('noise:heard', onHeard);
    SS.bus.on('player:move', onPlayerMove);
    bound = true;
    return true;
  }
  function waitForBus() {
    if (bindBus()) { return; }
    const timer = setInterval(() => { if (bindBus()) { clearInterval(timer); } }, 40);
    setTimeout(() => clearInterval(timer), 15000);
  }
  waitForBus();

  SS.Monster = {
    __loaded: true,
    version: '1.0.0',
    get x() { return S.x; },
    get y() { return S.y; },
    get state() { return S.state; },
    reloadConfig: snapshotConfig,
    debugState() { return S; },
    _bind: waitForBus
  };

})(typeof window !== 'undefined' ? window : globalThis);
