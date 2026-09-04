/* ============================================================================
 *  Silent Step — модуль SS.Audio
 *  Звук для ИГРОКА, а не для персонажа.
 *
 *  Главное правило модуля: герой глухой, поэтому звук не имеет права сообщать
 *  игроку ничего о мире, чего не знает герой. Ни шагов, ни рычания монстра,
 *  ни «онрядом». Звучит только тело героя (сердце, дыхание) и интерфейс.
 *  Всё синтезируется Web Audio — ни одного внешнего ассета.
 * ==========================================================================*/
(function (global) {
  'use strict';

  const SS = (global.SS = global.SS || {});
  if (SS.Audio && SS.Audio.__loaded) { return; }

  /* ==========================================================================
   * 1. ПАРАМЕТРЫ
   * ========================================================================*/
  const DEFAULTS = {
    enabled: true,
    muted: false,
    master: 0.5,

    // Ровный подкожный гул: громкость и «мутность» ведёт паника
    drone: {
      gain: [0.035, 0.14],        // при панике 0 и 100
      freq: 46,                   // Гц — основа
      detune: 7,                  // Гц — второй генератор, даёт биения
      cutoff: [220, 900],         // Гц — срез фильтра при панике 0 и 100
      attack: 1.2
    },

    // Сердце: единственный «датчик» страха, который слышит игрок
    heart: {
      bpm: [58, 148],             // при панике 0 и 100
      from: 12,                   // ниже этой паники сердце не слышно
      gain: [0.0, 0.55],
      freq: 52,
      decay: 0.16,
      second: { delay: 0.20, gain: 0.55 }
    },

    // Интерфейсные метки
    cues: {
      qteOpen:  { freq: 660, gain: 0.10, dur: 0.10 },
      qteOk:    { gain: 0.22, dur: 0.9 },     // выдох: шум через фильтр
      qteFail:  { freq: 150, gain: 0.30, dur: 0.45 },
      level:    { freq: 110, gain: 0.20, dur: 1.6 },
      death:    { freq: 70,  gain: 0.45, dur: 2.2 },
      win:      { gain: 0.22, dur: 3.0, chord: [196, 261.6, 392] }
    },

    gestureEvents: ['pointerdown', 'keydown', 'touchstart'],
    muteKeys: ['KeyM']
  };

  if (!SS.Config) { SS.Config = {}; }
  if (SS.Config && typeof SS.Config === 'object' && !SS.Config.audio) { SS.Config.audio = DEFAULTS; }

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
        try { const v = SS.Config.get('audio.' + path); if (v !== undefined && v !== null) { return v; } }
        catch (e) { /* игнорируем */ }
      }
      const v2 = readPath(SS.Config, 'audio.' + path);
      if (v2 !== undefined && v2 !== null) { return v2; }
    }
    return readPath(DEFAULTS, path);
  }

  let P = null;
  function snapshotConfig() {
    P = {
      enabled: cfg('enabled'), muted: cfg('muted'), master: cfg('master'),
      drone: cfg('drone'), heart: cfg('heart'), cues: cfg('cues'),
      gestureEvents: cfg('gestureEvents'), muteKeys: cfg('muteKeys')
    };
  }
  snapshotConfig();

  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ==========================================================================
   * 2. СОСТОЯНИЕ И ГРАФ
   * ========================================================================*/
  const S = {
    ctx: null, master: null, comp: null,
    droneA: null, droneB: null, droneGain: null, droneFilter: null,
    noiseBuf: null,
    panic: 0,
    beatAcc: 0,
    started: false, muted: false, gestureBound: false, dead: false
  };

  function ensureContext() {
    if (S.ctx) {
      if (S.ctx.state === 'suspended' && S.ctx.resume) { S.ctx.resume(); }
      return true;
    }
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC || !P.enabled) { return false; }

    const ctx = new AC();
    S.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = S.muted ? 0 : P.master;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 8;
    comp.connect(ctx.destination);
    master.connect(comp);
    S.master = master;
    S.comp = comp;

    // буфер розоватого шума — для выдоха и удара
    const len = Math.floor(ctx.sampleRate * 1.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    S.noiseBuf = buf;

    startDrone();
    return true;
  }

  function startDrone() {
    const ctx = S.ctx, D = P.drone;
    const g = ctx.createGain();
    g.gain.value = 0;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = D.cutoff[0];
    f.Q.value = 0.8;

    const a = ctx.createOscillator();
    a.type = 'sine';
    a.frequency.value = D.freq;
    const b = ctx.createOscillator();
    b.type = 'triangle';
    b.frequency.value = D.freq + D.detune;

    a.connect(f); b.connect(f);
    f.connect(g); g.connect(S.master);
    a.start(); b.start();

    g.gain.setTargetAtTime(D.gain[0], ctx.currentTime, D.attack);
    S.droneA = a; S.droneB = b; S.droneGain = g; S.droneFilter = f;
  }

  /* ==========================================================================
   * 3. ЭЛЕМЕНТАРНЫЕ ЗВУКИ
   * ========================================================================*/

  function tone(freq, dur, gain, type, glideTo) {
    if (!S.ctx) { return; }
    const ctx = S.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) { o.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), t + dur); }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t + Math.min(0.03, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(S.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function noise(dur, gain, cutoff, sweepTo) {
    if (!S.ctx || !S.noiseBuf) { return; }
    const ctx = S.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = S.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(cutoff, t);
    if (sweepTo) { f.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + dur); }
    f.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t + dur * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(S.master);
    src.start(t); src.stop(t + dur + 0.05);
  }

  // Удар сердца: два толчка, как настоящий
  function heartbeat(strength) {
    const H = P.heart;
    const g = lerp(H.gain[0], H.gain[1], strength);
    if (g <= 0.001) { return; }
    tone(H.freq, H.decay, g, 'sine', H.freq * 0.6);
    const ctx = S.ctx;
    if (!ctx) { return; }
    setTimeout(() => tone(H.freq * 0.92, H.decay * 0.8, g * H.second.gain, 'sine', H.freq * 0.55),
               H.second.delay * 1000);
  }

  /* ==========================================================================
   * 4. РЕАКЦИЯ НА ИГРУ
   *    Обрати внимание: подписки на monster:*, noise:* и player:* здесь НЕТ
   *    и быть не должно — иначе игрок услышит то, чего не слышит герой.
   * ========================================================================*/

  function onPanic(p) {
    if (!p) { return; }
    S.panic = clamp(p.value || 0, 0, 100);
  }

  function onTick(p) {
    if (!p || !S.ctx || S.muted || S.dead) { return; }
    const dt = p.dt || 0;
    const k = S.panic / 100;
    const ctx = S.ctx;

    // гул тянется за паникой
    const D = P.drone;
    S.droneGain.gain.setTargetAtTime(lerp(D.gain[0], D.gain[1], k), ctx.currentTime, 0.35);
    S.droneFilter.frequency.setTargetAtTime(lerp(D.cutoff[0], D.cutoff[1], k), ctx.currentTime, 0.35);

    // сердце
    const H = P.heart;
    if (S.panic >= H.from) {
      const bpm = lerp(H.bpm[0], H.bpm[1], k);
      S.beatAcc += dt;
      if (S.beatAcc >= 60 / bpm) {
        S.beatAcc = 0;
        heartbeat(clamp((S.panic - H.from) / (100 - H.from), 0, 1));
      }
    } else {
      S.beatAcc = 0;
    }
  }

  function onQte() { const c = P.cues.qteOpen; tone(c.freq, c.dur, c.gain, 'triangle', c.freq * 1.6); }

  // Успех QTE слышен как спокойный выдох, провал — как глухой удар в груди.
  // Только по явному исходу: скачок паники сам по себе озвучиванию не подлежит,
  // иначе игрок услышит, что монстр перешёл в погоню.
  function onQteEnd(p) {
    const c = P.cues;
    if (!p) { return; }
    if (p.ok) { noise(c.qteOk.dur, c.qteOk.gain, 900, 220); }
    else { tone(c.qteFail.freq, c.qteFail.dur, c.qteFail.gain, 'sine', 60); }
  }

  function onLevel() {
    const c = P.cues.level;
    S.dead = false;
    tone(c.freq, c.dur, c.gain, 'sine', c.freq * 0.5);
    noise(c.dur * 0.6, c.gain * 0.4, 300, 120);
  }

  function onOver() {
    const c = P.cues.death;
    S.dead = true;
    tone(c.freq, c.dur, c.gain, 'sawtooth', 28);
    noise(0.5, 0.35, 500, 80);
    if (S.droneGain && S.ctx) { S.droneGain.gain.setTargetAtTime(0.0001, S.ctx.currentTime, 0.5); }
  }

  function onWin() {
    const c = P.cues.win;
    S.dead = true;
    if (S.droneGain && S.ctx) { S.droneGain.gain.setTargetAtTime(0.0001, S.ctx.currentTime, 1.2); }
    c.chord.forEach((f, i) => setTimeout(() => tone(f, c.dur, c.gain, 'sine'), i * 260));
  }

  function onStart() {
    snapshotConfig();
    S.dead = false;
    S.panic = 0;
    S.beatAcc = 0;
    if (!ensureContext()) { bindGesture(); }
  }

  /* ==========================================================================
   * 5. ЖЕСТ И ВЫКЛЮЧЕНИЕ ЗВУКА
   * ========================================================================*/

  function bindGesture() {
    if (S.gestureBound || typeof global.addEventListener !== 'function') { return; }
    S.gestureBound = true;
    const once = () => {
      (P.gestureEvents || []).forEach(e => global.removeEventListener(e, once, true));
      ensureContext();
    };
    (P.gestureEvents || []).forEach(e => global.addEventListener(e, once, true));
  }

  function setMuted(v) {
    S.muted = !!v;
    if (S.master && S.ctx) {
      S.master.gain.setTargetAtTime(S.muted ? 0.0001 : P.master, S.ctx.currentTime, 0.05);
    }
    return S.muted;
  }

  function bindMuteKey() {
    if (typeof global.addEventListener !== 'function') { return; }
    global.addEventListener('keydown', e => {
      if ((P.muteKeys || []).indexOf(e.code) >= 0) { setMuted(!S.muted); }
    });
  }

  /* ==========================================================================
   * 6. ПОДПИСКА И ПУБЛИЧНЫЙ СЛОТ
   * ========================================================================*/

  let bound = false;
  function bindBus() {
    if (bound) { return true; }
    if (!SS.bus || typeof SS.bus.on !== 'function') { return false; }
    SS.bus.on('game:start', onStart);
    SS.bus.on('game:tick', onTick);
    SS.bus.on('game:over', onOver);
    SS.bus.on('game:win', onWin);
    SS.bus.on('level:loaded', onLevel);
    SS.bus.on('panic:qte', onQte);
    SS.bus.on('panic:qte:end', onQteEnd);
    SS.bus.on('panic:change', onPanic);
    bound = true;
    return true;
  }
  function waitForBus() {
    if (bindBus()) { return; }
    const timer = setInterval(() => { if (bindBus()) { clearInterval(timer); } }, 40);
    setTimeout(() => clearInterval(timer), 15000);
  }
  waitForBus();
  bindGesture();
  bindMuteKey();

  SS.Audio = {
    __loaded: true,
    version: '1.0.0',
    setMuted: setMuted,
    isMuted() { return S.muted; },
    setMaster(v) {
      P.master = clamp(v, 0, 1);
      if (S.master && S.ctx) { S.master.gain.setTargetAtTime(S.muted ? 0.0001 : P.master, S.ctx.currentTime, 0.05); }
    },
    getState() { return S.ctx ? S.ctx.state : 'none'; },
    reloadConfig: snapshotConfig,
    debugState() { return S; },
    _bind: waitForBus
  };

})(typeof window !== 'undefined' ? window : globalThis);
