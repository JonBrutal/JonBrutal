/* ============================================================================
 *  Silent Step — модуль SS.Mic
 *  Реальный микрофон игрока. Считает RMS, переводит его в игровой шум по
 *  таблице баланса и подмешивает к шуму героя: кашлянул в комнате — «Эхо»
 *  услышал в игре.
 *
 *  Наружу: 'mic:level' { rms, mapped }, 'mic:blow' {}, 'mic:denied' {},
 *  и 'noise:emit' с source 'mic' в точке игрока.
 * ==========================================================================*/
(function (global) {
  'use strict';

  const SS = (global.SS = global.SS || {});
  if (SS.Mic && SS.Mic.__loaded) { return; }

  /* ==========================================================================
   * 1. ПАРАМЕТРЫ
   * ========================================================================*/
  const DEFAULTS = {
    enabled: true,

    // Пороги RMS из таблицы баланса
    mode: 'normal',                       // 'hardcore' | 'normal' | 'off'
    modes: { hardcore: 0.15, normal: 0.35, off: Infinity },
    threshold: 0.35,                      // копия порога текущего режима — её читает HUD

    // Перевод RMS в игровой шум 0..10.
    // На пороге — тихая речь (4), на максимуме — крик (9).
    mapping: { atThreshold: 4, atFull: 9, full: 0.85, max: 10 },

    // Как часто громкость игрока превращается в шум в мире
    emit: { interval: 0.25, minLevel: 4 },

    // Распознавание выдоха: много низких частот и заметная громкость
    blow: { lowRatio: 0.62, rms: 0.10, hold: 0.12, cooldown: 1.2, level: 5 },

    analyser: { fftSize: 1024, smoothing: 0.2, lowHz: 250 },

    // Микрофон включается только по жесту пользователя — так требуют браузеры
    gestureEvents: ['pointerdown', 'keydown', 'touchstart']
  };

  if (!SS.Config) { SS.Config = {}; }
  if (SS.Config && typeof SS.Config === 'object' && !SS.Config.mic) { SS.Config.mic = DEFAULTS; }

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
        try { const v = SS.Config.get('mic.' + path); if (v !== undefined && v !== null) { return v; } }
        catch (e) { /* игнорируем */ }
      }
      const v2 = readPath(SS.Config, 'mic.' + path);
      if (v2 !== undefined && v2 !== null) { return v2; }
    }
    return readPath(DEFAULTS, path);
  }

  let P = null;
  function snapshotConfig() {
    P = {
      enabled: cfg('enabled'),
      mode: cfg('mode'),
      modes: cfg('modes'),
      mapping: cfg('mapping'),
      emit: cfg('emit'),
      blow: cfg('blow'),
      analyser: cfg('analyser'),
      gestureEvents: cfg('gestureEvents')
    };
    P.threshold = thresholdFor(P.mode);
    // порог публикуем в конфиг: HUD рисует по нему отметку на полосе
    if (SS.Config && SS.Config.mic) { SS.Config.mic.threshold = P.threshold; }
  }

  function thresholdFor(mode) {
    const m = cfg('modes') || DEFAULTS.modes;
    const v = m[mode];
    return (typeof v === 'number') ? v : DEFAULTS.modes.normal;
  }

  snapshotConfig();

  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));

  /* ==========================================================================
   * 2. СОСТОЯНИЕ
   * ========================================================================*/
  const S = {
    state: 'idle',          // idle | asking | live | denied | unsupported
    ctxA: null, stream: null, analyser: null,
    timeBuf: null, freqBuf: null,
    rms: 0, smooth: 0,
    emitAcc: 0, emitPeak: 0,
    blowT: 0, blowCd: 0,
    player: { x: 48, y: 48, known: false },
    gestureBound: false
  };

  /* ==========================================================================
   * 3. ЗАПУСК ЗАХВАТА
   * ========================================================================*/

  function unsupported() {
    S.state = 'unsupported';
    if (SS.bus) { SS.bus.emit('mic:denied', {}); }
  }

  function deny(err) {
    S.state = 'denied';
    if (err) { console.warn('[SS.Mic] доступ к микрофону не получен:', err && err.name ? err.name : err); }
    if (SS.bus) { SS.bus.emit('mic:denied', {}); }
  }

  function request() {
    if (!P.enabled || P.mode === 'off') { deny('mode:off'); return Promise.resolve(false); }
    if (S.state === 'live' || S.state === 'asking') { return Promise.resolve(S.state === 'live'); }

    const md = global.navigator && global.navigator.mediaDevices;
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!md || typeof md.getUserMedia !== 'function' || !AC) { unsupported(); return Promise.resolve(false); }

    S.state = 'asking';
    return md.getUserMedia({
      audio: {
        // обработку выключаем: нам нужна сырая громкость, а не «красивый» голос
        echoCancellation: false, noiseSuppression: false, autoGainControl: false
      }, video: false
    }).then(stream => {
      S.stream = stream;
      S.ctxA = new AC();
      const src = S.ctxA.createMediaStreamSource(stream);
      const an = S.ctxA.createAnalyser();
      an.fftSize = P.analyser.fftSize;
      an.smoothingTimeConstant = P.analyser.smoothing;
      src.connect(an);                    // в динамики НЕ выводим — обратной связи не будет
      S.analyser = an;
      S.timeBuf = new Float32Array(an.fftSize);
      S.freqBuf = new Uint8Array(an.frequencyBinCount);
      S.state = 'live';
      if (S.ctxA.state === 'suspended' && S.ctxA.resume) { S.ctxA.resume(); }
      return true;
    }).catch(err => { deny(err); return false; });
  }

  // Браузер даёт микрофон только после жеста игрока
  function bindGesture() {
    if (S.gestureBound || typeof global.addEventListener !== 'function') { return; }
    S.gestureBound = true;
    const once = () => {
      (P.gestureEvents || []).forEach(evt => global.removeEventListener(evt, once, true));
      request();
    };
    (P.gestureEvents || []).forEach(evt => global.addEventListener(evt, once, true));
  }

  function stop() {
    if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
    if (S.ctxA && S.ctxA.close) { try { S.ctxA.close(); } catch (e) { /* уже закрыт */ } }
    S.ctxA = null; S.analyser = null;
    if (S.state === 'live') { S.state = 'idle'; }
  }

  /* ==========================================================================
   * 4. ИЗМЕРЕНИЕ
   * ========================================================================*/

  function readRms() {
    const an = S.analyser;
    if (!an) { return 0; }
    if (typeof an.getFloatTimeDomainData === 'function') {
      an.getFloatTimeDomainData(S.timeBuf);
      let sum = 0;
      for (let i = 0; i < S.timeBuf.length; i++) { sum += S.timeBuf[i] * S.timeBuf[i]; }
      return Math.sqrt(sum / S.timeBuf.length);
    }
    // запасной путь для старых браузеров
    an.getByteTimeDomainData(S.freqBuf);
    let sum = 0;
    for (let i = 0; i < S.freqBuf.length; i++) {
      const v = (S.freqBuf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / S.freqBuf.length);
  }

  // Доля энергии ниже lowHz: у выдоха в микрофон она заметно выше, чем у речи
  function lowRatio() {
    const an = S.analyser;
    if (!an || !S.ctxA) { return 0; }
    an.getByteFrequencyData(S.freqBuf);
    const binHz = S.ctxA.sampleRate / an.fftSize;
    const lowBins = Math.max(1, Math.round(P.analyser.lowHz / binHz));
    let low = 0, all = 0;
    for (let i = 1; i < S.freqBuf.length; i++) {
      all += S.freqBuf[i];
      if (i <= lowBins) { low += S.freqBuf[i]; }
    }
    return all > 0 ? low / all : 0;
  }

  // RMS → игровой шум: на пороге тихая речь (4), на максимуме крик (9)
  function mapLevel(rms) {
    const M = P.mapping;
    if (rms < P.threshold) { return null; }
    const k = clamp((rms - P.threshold) / Math.max(0.001, M.full - P.threshold), 0, 1);
    return clamp(M.atThreshold + (M.atFull - M.atThreshold) * k, 0, M.max);
  }

  /* ==========================================================================
   * 5. ШАГ СИМУЛЯЦИИ
   * ========================================================================*/

  function onTick(p) {
    if (!p || !P.enabled) { return; }
    const dt = p.dt || 0;

    if (S.blowCd > 0) { S.blowCd -= dt; }

    if (S.state !== 'live') { return; }

    S.rms = readRms();
    S.smooth += (S.rms - S.smooth) * Math.min(1, dt * 18);
    const mapped = mapLevel(S.rms);

    SS.bus.emit('mic:level', { rms: S.rms, mapped: mapped });

    // выдох: низкие частоты держатся достаточно долго
    if (S.rms > P.blow.rms && lowRatio() > P.blow.lowRatio) {
      S.blowT += dt;
      if (S.blowT >= P.blow.hold && S.blowCd <= 0) {
        S.blowT = 0;
        S.blowCd = P.blow.cooldown;
        SS.bus.emit('mic:blow', {});
        if (S.player.known) {
          SS.bus.emit('noise:emit', { level: P.blow.level, x: S.player.x, y: S.player.y, source: 'mic' });
        }
      }
    } else {
      S.blowT = 0;
    }

    // громкость превращается в шум в мире — пачками, а не каждый кадр
    if (mapped !== null && mapped > S.emitPeak) { S.emitPeak = mapped; }
    S.emitAcc += dt;
    if (S.emitAcc >= P.emit.interval) {
      S.emitAcc = 0;
      if (S.emitPeak >= P.emit.minLevel && S.player.known) {
        SS.bus.emit('noise:emit', { level: S.emitPeak, x: S.player.x, y: S.player.y, source: 'mic' });
      }
      S.emitPeak = 0;
    }
  }

  function onPlayerMove(p) {
    if (!p) { return; }
    S.player.x = p.x; S.player.y = p.y; S.player.known = true;
  }

  function onStart() {
    snapshotConfig();
    if (!P.enabled || P.mode === 'off') { deny('mode:off'); return; }
    // если разрешение уже выдано, захват поднимется сразу; иначе ждём жеста
    request().then(ok => { if (!ok && S.state !== 'denied' && S.state !== 'unsupported') { bindGesture(); } });
    bindGesture();
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

  SS.Mic = {
    __loaded: true,
    version: '1.0.0',
    request: request,
    stop: stop,
    // 'hardcore' 0.15 · 'normal' 0.35 · 'off' — вместо микрофона работают QTE
    setMode(mode) {
      if (!P.modes[mode]) { return false; }
      if (SS.Config && SS.Config.mic) { SS.Config.mic.mode = mode; }
      snapshotConfig();
      if (mode === 'off') { stop(); deny('mode:off'); }
      else if (S.state !== 'live') { request(); }
      return true;
    },
    getMode() { return P.mode; },
    getThreshold() { return P.threshold; },
    getState() { return S.state; },
    getRms() { return S.rms; },
    reloadConfig: snapshotConfig,
    debugState() { return S; },
    _bind: waitForBus
  };

})(typeof window !== 'undefined' ? window : globalThis);
