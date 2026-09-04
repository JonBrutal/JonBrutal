/* ============================================================================
 *  Silent Step — модуль SS.Level
 *  Карта 96×96 тайлов (1 тайл = 1 м), поверхности, коллизии, окклюзия,
 *  отрисовка мира и пять уровней.
 *
 *  Контрактные [QUERY]: surfaceAt, isSolid, occlusion, randomPointNear.
 *  Сверх контракта (см. ЗАПРОС К КОНТРАКТУ): load/count/spawn/exit/hint/name,
 *  noiseAt, isPit, isExit — нужны ядру и персонажам для потока уровней.
 * ==========================================================================*/
(function (global) {
  'use strict';

  const SS = (global.SS = global.SS || {});
  if (SS.Level && SS.Level.__loaded) { return; }

  /* ==========================================================================
   * 1. ПАРАМЕТРЫ
   * ========================================================================*/
  const DEFAULTS = {
    tiles: 96,
    pixelsPerMeter: 32,

    // Таблица баланса поверхностей: [мин. шум, макс. шум]
    noise: {
      moss: [1, 1], grass: [2, 2], tallgrass: [3, 3], wood: [4, 7],
      leaves: [6, 6], gravel: [6, 6], water: [7, 7], metal: [8, 8]
    },

    // Ослабление шума при прохождении препятствия
    occlusion: { wall: -3, bush: -1, sampleStep: 0.7, cap: -12 },

    // Яркость палитры прямо пропорциональна шуму поверхности: тихое — тёмное
    // и холодное, громкое — светлое и тёплое. Игрок читает опасность глазами,
    // а не памятью на названия.
    colors: {
      moss:      ['#132b24', '#18352c'],   // шум 1
      grass:     ['#26331f', '#2e3d26'],   // шум 2
      tallgrass: ['#2c3b22', '#35462a'],   // шум 3
      wood:      ['#4b3925', '#57432d'],   // шум 4–7
      leaves:    ['#5a4020', '#674a27'],   // шум 6
      gravel:    ['#4a4c52', '#55575e'],   // шум 6
      water:     ['#1c3d5a', '#234a6c'],   // шум 7
      metal:     ['#5b6a78', '#697a89'],   // шум 8
      wall:      ['#0a0e12', '#111820'],
      wallEdge:  '#2c3d47',
      pit:       '#03060a',
      bush:      '#3f5f45',
      exit:      '#7fe6b0'
    }
  };

  if (!SS.Config) { SS.Config = {}; }
  if (SS.Config && typeof SS.Config === 'object' && !SS.Config.level) { SS.Config.level = DEFAULTS; }

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
          const v = SS.Config.get('level.' + path);
          if (v !== undefined && v !== null) { return v; }
        } catch (e) { /* игнорируем */ }
      }
      const v2 = readPath(SS.Config, 'level.' + path);
      if (v2 !== undefined && v2 !== null) { return v2; }
    }
    return readPath(DEFAULTS, path);
  }

  let P = null;
  function snapshotConfig() {
    P = {
      N: cfg('tiles'),
      ppm: cfg('pixelsPerMeter'),
      noise: cfg('noise'),
      occ: cfg('occlusion'),
      colors: cfg('colors')
    };
  }
  snapshotConfig();

  /* ==========================================================================
   * 2. ОПИСАНИЯ ПЯТИ УРОВНЕЙ
   *    r: [x, y, w, h] в тайлах. Порядок применения:
   *    base → paint → scatter → walls → open → bushes → pits → exit.
   * ========================================================================*/
  const LEVELS = [
    /* ---------------------------------------------------------------- 1 --*/
    {
      name: 'ПРОСЕКА',
      hint: 'Мох тише травы. Присед — вдвое тише. Сухие листья тебя выдадут.',
      seed: 101,
      base: 'grass',
      paint: [
        // моховая тропа с запада на восток
        { path: [[4, 48], [22, 44], [38, 53], [56, 46], [74, 51], [92, 48]], w: 4, s: 'moss' },
        // гравийная просека поперёк — её придётся переходить тихо
        { r: [43, 8, 7, 80], s: 'gravel' },
        // ручей
        { r: [8, 70, 80, 3], s: 'water' },
        { r: [26, 12, 14, 10], s: 'tallgrass' },
        { r: [62, 62, 18, 14], s: 'tallgrass' }
      ],
      scatter: [{ s: 'leaves', count: 30, size: [3, 7], area: [10, 14, 76, 66] }],
      walls: [
        [16, 20, 4, 4], [30, 34, 3, 6], [52, 24, 5, 3], [66, 36, 4, 4],
        [24, 60, 6, 3], [58, 14, 3, 8], [78, 26, 4, 6], [36, 74, 8, 3], [70, 78, 6, 4]
      ],
      open: [],
      bushes: [
        [12, 40, 6, 4], [28, 48, 5, 5], [46, 56, 4, 6], [60, 40, 6, 4],
        [80, 44, 5, 6], [20, 28, 4, 4], [68, 20, 5, 4]
      ],
      pits: [],
      spawn: { x: 6, y: 48 },
      exit: [90, 42, 5, 12],
      monster: { x: 62, y: 48, patrol: [[62, 30], [76, 50], [56, 66], [40, 46], [56, 34]] },
      stones: [[10, 46], [30, 50], [52, 44], [72, 52]]
    },

    /* ---------------------------------------------------------------- 2 --*/
    {
      name: 'ЛЕСОПИЛКА',
      hint: 'Гравий громкий. Ветхие доски скрипят сильнее новых. Металл — приговор.',
      seed: 202,
      base: 'gravel',
      paint: [
        { r: [2, 2, 92, 14], s: 'grass' },
        { r: [2, 78, 92, 16], s: 'grass' },
        { path: [[6, 86], [20, 76], [34, 70], [34, 40], [52, 30], [72, 24], [90, 10]], w: 3, s: 'moss' },
        // цеха
        { r: [12, 20, 22, 18], s: 'wood' },
        { r: [46, 44, 24, 20], s: 'wood' },
        { r: [62, 12, 22, 16], s: 'wood' },
        // рельсы и настилы
        { r: [36, 22, 6, 46], s: 'metal' },
        { r: [70, 30, 18, 4], s: 'metal' },
        { r: [14, 52, 18, 4], s: 'metal' }
      ],
      scatter: [
        { s: 'leaves', count: 14, size: [2, 5], area: [4, 66, 88, 24] },
        { s: 'wood', count: 10, size: [2, 4], area: [8, 16, 80, 60] }
      ],
      walls: [
        [12, 20, 22, 1], [12, 37, 22, 1], [12, 20, 1, 18], [33, 20, 1, 18],
        [46, 44, 24, 1], [46, 63, 24, 1], [46, 44, 1, 20], [69, 44, 1, 20],
        [62, 12, 22, 1], [62, 27, 22, 1], [62, 12, 1, 16], [83, 12, 1, 16],
        [40, 70, 30, 2], [20, 60, 2, 14], [76, 46, 2, 22], [8, 40, 14, 2]
      ],
      open: [
        [20, 37, 4, 2], [33, 26, 2, 4], [54, 44, 4, 2], [69, 54, 2, 4],
        [70, 27, 4, 2], [62, 18, 2, 4], [52, 70, 5, 3], [20, 66, 3, 4]
      ],
      bushes: [[4, 60, 6, 8], [86, 60, 6, 10], [40, 84, 8, 5], [86, 36, 5, 6]],
      pits: [[38, 44, 3, 8], [56, 66, 5, 3]],
      spawn: { x: 6, y: 88 },
      exit: [89, 4, 6, 9],
      monster: { x: 44, y: 60, patrol: [[30, 66], [30, 30], [58, 36], [78, 40], [60, 74]] },
      stones: [[10, 80], [32, 62], [50, 36], [74, 20]]
    },

    /* ---------------------------------------------------------------- 3 --*/
    {
      name: 'БОЛОТО',
      hint: 'Вода выдаёт с головой. Прыгай по кочкам. Трясина не прощает.',
      seed: 303,
      base: 'tallgrass',
      paint: [
        { r: [2, 16, 92, 10], s: 'water' },
        { r: [2, 40, 92, 12], s: 'water' },
        { r: [2, 66, 92, 10], s: 'water' },
        // кочки: единственная тихая дорога с юга на север
        { path: [[48, 92], [44, 78], [50, 70], [46, 60], [52, 50], [44, 42], [50, 30], [46, 20], [48, 4]], w: 3, s: 'moss' },
        { r: [10, 28, 16, 10], s: 'grass' },
        { r: [66, 54, 18, 10], s: 'grass' },
        { r: [22, 54, 12, 8], s: 'moss' },
        { r: [62, 28, 12, 8], s: 'moss' }
      ],
      scatter: [{ s: 'leaves', count: 12, size: [2, 4], area: [6, 26, 84, 50] }],
      walls: [
        [14, 44, 6, 3], [30, 20, 4, 4], [60, 68, 5, 3], [76, 34, 4, 5],
        [24, 74, 6, 3], [70, 12, 5, 4], [36, 60, 3, 6], [58, 44, 3, 5]
      ],
      open: [],
      bushes: [
        [40, 84, 6, 5], [52, 62, 6, 5], [38, 34, 6, 5], [54, 22, 6, 5],
        [16, 58, 6, 6], [74, 62, 6, 6], [20, 34, 5, 5]
      ],
      pits: [[12, 46, 8, 4], [70, 44, 10, 4], [28, 68, 8, 4], [58, 18, 8, 4], [82, 70, 8, 5]],
      spawn: { x: 48, y: 92 },
      exit: [44, 2, 9, 5],
      monster: { x: 48, y: 56, patrol: [[34, 62], [62, 58], [64, 32], [36, 30], [48, 46]] },
      stones: [[46, 88], [50, 66], [44, 46], [48, 26]]
    },

    /* ---------------------------------------------------------------- 4 --*/
    {
      name: 'АНГАР',
      hint: 'На металле спасает только ползком. Помни: он бежит быстрее тебя.',
      seed: 404,
      base: 'gravel',
      paint: [
        { r: [2, 2, 92, 12], s: 'grass' },
        { r: [2, 82, 92, 12], s: 'grass' },
        { r: [16, 18, 64, 60], s: 'metal' },
        // деревянные мостки поперёк ангара — тихая нить через металл
        { r: [30, 18, 4, 60], s: 'wood' },
        { r: [16, 46, 64, 4], s: 'wood' },
        { r: [62, 18, 4, 60], s: 'wood' },
        { path: [[6, 84], [12, 70], [16, 56]], w: 3, s: 'moss' },
        { path: [[80, 40], [88, 26], [90, 10]], w: 3, s: 'moss' }
      ],
      scatter: [{ s: 'gravel', count: 16, size: [2, 4], area: [18, 20, 60, 56] }],
      walls: [
        [16, 17, 64, 1], [16, 78, 64, 1], [15, 17, 1, 62], [80, 17, 1, 62],
        [22, 26, 2, 16], [40, 22, 2, 18], [48, 34, 16, 2], [24, 56, 14, 2],
        [44, 56, 2, 18], [54, 62, 14, 2], [68, 24, 2, 20], [34, 66, 8, 2]
      ],
      open: [
        [16, 54, 1, 4], [80, 38, 1, 4], [30, 17, 4, 1], [62, 78, 4, 1],
        [56, 34, 4, 2], [30, 56, 4, 2], [44, 68, 2, 4]
      ],
      bushes: [[4, 60, 6, 8], [86, 60, 6, 8], [40, 86, 10, 5], [6, 20, 6, 8]],
      pits: [[36, 30, 4, 6], [56, 50, 5, 5], [26, 68, 5, 4]],
      spawn: { x: 6, y: 86 },
      exit: [88, 3, 7, 8],
      monster: { x: 48, y: 48, patrol: [[24, 24], [72, 26], [72, 72], [24, 72], [46, 48]] },
      stones: [[8, 78], [18, 52], [32, 40], [64, 60]]
    },

    /* ---------------------------------------------------------------- 5 --*/
    {
      name: 'ДОМ',
      hint: 'Дом дышит вместе с тобой. Он уже внутри. Иди к чердачной лестнице.',
      seed: 505,
      base: 'leaves',
      paint: [
        { r: [2, 2, 92, 92], s: 'leaves' },
        { path: [[48, 94], [48, 84], [46, 80]], w: 4, s: 'moss' },
        { r: [18, 18, 60, 62], s: 'wood' },
        { r: [24, 24, 12, 12], s: 'wood' },
        { r: [40, 68, 16, 10], s: 'gravel' },
        { r: [60, 24, 14, 12], s: 'metal' },
        { r: [4, 40, 12, 16], s: 'tallgrass' },
        { r: [80, 40, 12, 16], s: 'tallgrass' }
      ],
      scatter: [
        { s: 'leaves', count: 10, size: [2, 4], area: [20, 20, 56, 56] },
        { s: 'moss', count: 8, size: [2, 3], area: [20, 20, 56, 56] }
      ],
      walls: [
        [18, 17, 60, 2], [18, 79, 60, 2], [17, 17, 2, 64], [77, 17, 2, 64],
        [38, 19, 2, 24], [56, 19, 2, 18], [19, 42, 22, 2], [40, 44, 2, 20],
        [56, 44, 22, 2], [19, 62, 20, 2], [56, 62, 22, 2], [40, 62, 2, 18],
        [24, 24, 1, 12], [24, 24, 12, 1]
      ],
      open: [
        [46, 79, 6, 2], [38, 30, 2, 4], [56, 28, 2, 4], [28, 42, 4, 2],
        [40, 52, 2, 4], [64, 44, 4, 2], [30, 62, 4, 2], [64, 62, 4, 2],
        [40, 70, 2, 4], [24, 30, 1, 4]
      ],
      bushes: [[8, 20, 6, 8], [84, 20, 6, 8], [8, 70, 8, 8], [82, 70, 8, 8]],
      pits: [[44, 48, 6, 6], [26, 70, 6, 5], [62, 50, 5, 6]],
      spawn: { x: 48, y: 92 },
      exit: [45, 20, 7, 5],
      monster: { x: 32, y: 76, patrol: [[30, 76], [28, 30], [66, 30], [66, 70], [48, 56]] },
      stones: [[46, 86], [34, 56], [60, 40], [30, 34]]
    }
  ];

  /* ==========================================================================
   * 3. ПОСТРОЕНИЕ КАРТЫ
   * ========================================================================*/

  const SURF = ['moss', 'grass', 'tallgrass', 'leaves', 'gravel', 'wood', 'metal', 'water'];
  const SURF_ID = {};
  SURF.forEach((s, i) => { SURF_ID[s] = i; });

  const F_SOLID = 1, F_BUSH = 2, F_PIT = 4, F_EXIT = 8;

  const M = {
    index: -1,
    spec: null,
    surf: null,     // Uint8Array — индекс поверхности
    flags: null,    // Uint8Array — признаки тайла
    noise: null,    // Uint8Array — базовый шум тайла (учитывает ветхость досок)
    tint: null,     // Uint8Array — детерминированная вариация цвета
    name: '', hint: '',
    spawn: { x: 48, y: 48 },
    exitRect: [0, 0, 0, 0],
    monsterSpawn: { x: 48, y: 48 },
    waypoints: [],
    stones: []
  };

  // локальный ГПСЧ уровня: карта должна быть одинаковой при каждом заходе
  let lrng = 1;
  function lrand() {
    lrng |= 0; lrng = (lrng + 0x6D2B79F5) | 0;
    let t = Math.imul(lrng ^ (lrng >>> 15), 1 | lrng);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const idx = (tx, ty) => ty * P.N + tx;
  const inside = (tx, ty) => tx >= 0 && ty >= 0 && tx < P.N && ty < P.N;

  function noiseForSurface(s) {
    const range = P.noise[s] || [0, 0];
    if (range[0] === range[1]) { return range[0]; }
    // ветхость досок: детерминированный разброс внутри диапазона
    return Math.round(range[0] + lrand() * (range[1] - range[0]));
  }

  function setTile(tx, ty, s) {
    if (!inside(tx, ty)) { return; }
    const i = idx(tx, ty);
    M.surf[i] = SURF_ID[s];
    M.noise[i] = noiseForSurface(s);
  }

  function paintRect(r, s) {
    for (let y = r[1]; y < r[1] + r[3]; y++) {
      for (let x = r[0]; x < r[0] + r[2]; x++) { setTile(x, y, s); }
    }
  }

  function paintPath(points, w, s) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2);
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const cx = Math.round(a[0] + (b[0] - a[0]) * t);
        const cy = Math.round(a[1] + (b[1] - a[1]) * t);
        const h = Math.floor(w / 2);
        for (let dy = -h; dy <= h; dy++) {
          for (let dx = -h; dx <= h; dx++) { setTile(cx + dx, cy + dy, s); }
        }
      }
    }
  }

  function flagRect(r, flag, on) {
    for (let y = r[1]; y < r[1] + r[3]; y++) {
      for (let x = r[0]; x < r[0] + r[2]; x++) {
        if (!inside(x, y)) { continue; }
        const i = idx(x, y);
        if (on) { M.flags[i] |= flag; } else { M.flags[i] &= ~flag; }
      }
    }
  }

  function build(spec) {
    const N = P.N;
    const total = N * N;
    M.surf = new Uint8Array(total);
    M.flags = new Uint8Array(total);
    M.noise = new Uint8Array(total);
    M.tint = new Uint8Array(total);
    lrng = spec.seed >>> 0;

    // основа
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) { setTile(x, y, spec.base); }
    }
    for (let i = 0; i < total; i++) { M.tint[i] = Math.floor(lrand() * 255); }

    // прямоугольники и тропы
    (spec.paint || []).forEach(p => {
      if (p.path) { paintPath(p.path, p.w || 3, p.s); } else { paintRect(p.r, p.s); }
    });

    // пятна
    (spec.scatter || []).forEach(sc => {
      for (let i = 0; i < sc.count; i++) {
        const w = Math.round(sc.size[0] + lrand() * (sc.size[1] - sc.size[0]));
        const h = Math.round(sc.size[0] + lrand() * (sc.size[1] - sc.size[0]));
        const x = Math.round(sc.area[0] + lrand() * (sc.area[2] - w));
        const y = Math.round(sc.area[1] + lrand() * (sc.area[3] - h));
        paintRect([x, y, w, h], sc.s);
      }
    });

    // стены и проёмы
    (spec.walls || []).forEach(r => flagRect(r, F_SOLID, true));
    (spec.open || []).forEach(r => flagRect(r, F_SOLID, false));

    // граница мира
    flagRect([0, 0, N, 2], F_SOLID, true);
    flagRect([0, N - 2, N, 2], F_SOLID, true);
    flagRect([0, 0, 2, N], F_SOLID, true);
    flagRect([N - 2, 0, 2, N], F_SOLID, true);

    // кусты: не сплошные, но глушат звук и прячут
    (spec.bushes || []).forEach(r => {
      flagRect(r, F_BUSH, true);
      paintRect(r, 'tallgrass');
    });

    // ямы и выход
    (spec.pits || []).forEach(r => flagRect(r, F_PIT, true));
    flagRect(spec.exit, F_EXIT, true);
    flagRect(spec.exit, F_SOLID, false);
    flagRect(spec.exit, F_PIT, false);

    // Точка входа: всегда проходима и всегда тихая — игрок не должен начинать
    // уровень стоя на сухих листьях, ещё не поняв, где он.
    const sx = Math.floor(spec.spawn.x), sy = Math.floor(spec.spawn.y);
    flagRect([sx - 2, sy - 2, 5, 5], F_SOLID, false);
    flagRect([sx - 2, sy - 2, 5, 5], F_PIT, false);
    paintRect([sx - 2, sy - 2, 5, 5], 'moss');

    M.spec = spec;
    M.name = spec.name;
    M.hint = spec.hint;
    M.spawn = { x: spec.spawn.x + 0.5, y: spec.spawn.y + 0.5 };
    M.exitRect = spec.exit;
    M.monsterSpawn = { x: spec.monster.x + 0.5, y: spec.monster.y + 0.5 };
    M.waypoints = (spec.monster.patrol || []).map(p => ({ x: p[0] + 0.5, y: p[1] + 0.5 }));
    M.stones = (spec.stones || []).map(p => ({ x: p[0] + 0.5, y: p[1] + 0.5, taken: false }));
  }

  function load(index) {
    snapshotConfig();
    const i = Math.max(0, Math.min(LEVELS.length - 1, index | 0));
    M.index = i;
    build(LEVELS[i]);
  }

  /* ==========================================================================
   * 4. КОНТРАКТНЫЕ [QUERY]
   * ========================================================================*/

  function surfaceAt(x, y) {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (!M.surf || !inside(tx, ty)) { return 'grass'; }
    return SURF[M.surf[idx(tx, ty)]];
  }

  function isSolid(x, y) {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (!M.flags || !inside(tx, ty)) { return true; }
    return (M.flags[idx(tx, ty)] & F_SOLID) !== 0;
  }

  function isPit(x, y) {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (!M.flags || !inside(tx, ty)) { return false; }
    return (M.flags[idx(tx, ty)] & F_PIT) !== 0;
  }

  function isExit(x, y) {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (!M.flags || !inside(tx, ty)) { return false; }
    return (M.flags[idx(tx, ty)] & F_EXIT) !== 0;
  }

  function isBush(x, y) {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (!M.flags || !inside(tx, ty)) { return false; }
    return (M.flags[idx(tx, ty)] & F_BUSH) !== 0;
  }

  // Точный базовый шум тайла: для досок учитывает их ветхость (4..7)
  function noiseAt(x, y) {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (!M.noise || !inside(tx, ty)) { return 0; }
    return M.noise[idx(tx, ty)];
  }

  /**
   * Суммарное ослабление шума по лучу: стена −3, куст −1.
   * Считаем ЗА ПРЕПЯТСТВИЕ, а не за тайл: стена в два тайта толщиной и куст
   * шириной в пять тайлов — это одна стена и один куст. Иначе широкий куст
   * глушил бы звук как пять стен и монстр переставал слышать что угодно.
   */
  function occlusion(ax, ay, bx, by) {
    if (!M.flags) { return 0; }
    const O = P.occ;
    const dx = bx - ax, dy = by - ay;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) { return 0; }
    const steps = Math.ceil(dist / O.sampleStep);
    let sum = 0, lastIdx = -1, prevKind = 0;   // 0 — пусто, 1 — стена, 2 — куст
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const tx = Math.floor(ax + dx * t), ty = Math.floor(ay + dy * t);
      if (!inside(tx, ty)) { break; }
      const id = idx(tx, ty);
      if (id === lastIdx) { continue; }   // один и тот же тайл не считаем дважды
      lastIdx = id;
      const f = M.flags[id];
      const kind = (f & F_SOLID) ? 1 : ((f & F_BUSH) ? 2 : 0);
      if (kind !== 0 && kind !== prevKind) {   // вошли в новое препятствие
        sum += (kind === 1) ? O.wall : O.bush;
        if (sum <= O.cap) { return O.cap; }
      }
      prevKind = kind;
    }
    return sum;
  }

  // Проходимая точка в кольце [minR, maxR] вокруг (x, y)
  function randomPointNear(x, y, minR, maxR) {
    const rnd = (SS.Core && typeof SS.Core.rand === 'function') ? SS.Core.rand : Math.random;
    const lo = Math.min(minR, maxR), hi = Math.max(minR, maxR);
    for (let i = 0; i < 40; i++) {
      const a = rnd() * Math.PI * 2;
      const r = lo + rnd() * (hi - lo);
      const nx = x + Math.cos(a) * r, ny = y + Math.sin(a) * r;
      if (!inside(Math.floor(nx), Math.floor(ny))) { continue; }
      if (isSolid(nx, ny) || isPit(nx, ny)) { continue; }
      return { x: nx, y: ny };
    }
    return { x: x, y: y };
  }

  /* ==========================================================================
   * 5. ОТРИСОВКА МИРА (свой слой, самый нижний)
   * ========================================================================*/

  function onRender(p) {
    if (!p || !p.ctx || !M.surf) { return; }
    const ctx = p.ctx, cam = p.cam || { x: 48, y: 48, zoom: 1 };
    const z = cam.zoom || 1;
    const ppm = P.ppm * z;
    const cv = ctx.canvas;
    let sx = 1;
    if (typeof ctx.getTransform === 'function') {
      try { const t = ctx.getTransform(); if (t && t.a) { sx = Math.abs(t.a); } } catch (e) { sx = 1; }
    }
    const vw = cv ? cv.width / sx : 1280;
    const vh = cv ? cv.height / sx : 720;

    const originX = vw / 2 - cam.x * ppm;
    const originY = vh / 2 - cam.y * ppm;

    const tx0 = Math.max(0, Math.floor(cam.x - vw / (2 * ppm)) - 1);
    const ty0 = Math.max(0, Math.floor(cam.y - vh / (2 * ppm)) - 1);
    const tx1 = Math.min(P.N - 1, Math.ceil(cam.x + vw / (2 * ppm)) + 1);
    const ty1 = Math.min(P.N - 1, Math.ceil(cam.y + vh / (2 * ppm)) + 1);

    const C = P.colors;
    const size = Math.ceil(ppm) + 1;

    ctx.save();
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const i = idx(tx, ty);
        const f = M.flags[i];
        const px = Math.floor(originX + tx * ppm);
        const py = Math.floor(originY + ty * ppm);

        if (f & F_PIT) {
          ctx.fillStyle = C.pit;
          ctx.fillRect(px, py, size, size);
          continue;
        }

        const pal = (f & F_SOLID) ? C.wall : C[SURF[M.surf[i]]];
        ctx.fillStyle = (M.tint[i] & 1) ? pal[1] : pal[0];
        ctx.fillRect(px, py, size, size);

        if (f & F_SOLID) {
          // светлая кромка сверху — стена читается как объём
          ctx.fillStyle = C.wallEdge;
          ctx.globalAlpha = 0.35;
          ctx.fillRect(px, py, size, Math.max(1, ppm * 0.12));
          ctx.globalAlpha = 1;
        } else if (f & F_BUSH) {
          // куст: три точки, глушит звук и прячет
          ctx.fillStyle = C.bush;
          ctx.globalAlpha = 0.75;
          const q = ppm * 0.22;
          ctx.fillRect(px + ppm * 0.18, py + ppm * 0.22, q, q);
          ctx.fillRect(px + ppm * 0.55, py + ppm * 0.35, q, q);
          ctx.fillRect(px + ppm * 0.32, py + ppm * 0.62, q, q);
          ctx.globalAlpha = 1;
        } else if (f & F_EXIT) {
          const t = (SS.Core && SS.Core.time) || 0;
          ctx.globalAlpha = 0.25 + 0.15 * Math.sin(t * 3 + tx + ty);
          ctx.fillStyle = C.exit;
          ctx.fillRect(px, py, size, size);
          ctx.globalAlpha = 1;
        }
      }
    }

    // рамка выхода, чтобы цель читалась издалека
    const ex = M.exitRect;
    ctx.strokeStyle = C.exit;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 2;
    ctx.strokeRect(originX + ex[0] * ppm, originY + ex[1] * ppm, ex[2] * ppm, ex[3] * ppm);
    ctx.globalAlpha = 1;

    // камни, которые ещё можно подобрать
    ctx.fillStyle = '#8d99a6';
    for (let i = 0; i < M.stones.length; i++) {
      const s = M.stones[i];
      if (s.taken) { continue; }
      ctx.beginPath();
      ctx.arc(originX + s.x * ppm, originY + s.y * ppm, Math.max(2, ppm * 0.14), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ==========================================================================
   * 6. ПОДПИСКА И ПУБЛИЧНЫЙ СЛОТ
   * ========================================================================*/

  let bound = false;
  function bindBus() {
    if (bound) { return true; }
    if (!SS.bus || typeof SS.bus.on !== 'function') { return false; }
    SS.bus.on('game:render', onRender);
    bound = true;
    return true;
  }
  function waitForBus() {
    if (bindBus()) { return; }
    const timer = setInterval(() => { if (bindBus()) { clearInterval(timer); } }, 40);
    setTimeout(() => clearInterval(timer), 15000);
  }
  waitForBus();

  SS.Level = {
    __loaded: true,
    version: '1.0.0',
    // контракт
    surfaceAt: surfaceAt,
    isSolid: isSolid,
    occlusion: occlusion,
    randomPointNear: randomPointNear,
    // поток уровней и данные для персонажей
    load: load,
    count: LEVELS.length,
    noiseAt: noiseAt,
    isPit: isPit,
    isExit: isExit,
    isBush: isBush,
    get index() { return M.index; },
    get name() { return M.name; },
    get hint() { return M.hint; },
    get spawn() { return M.spawn; },
    get monsterSpawn() { return M.monsterSpawn; },
    get waypoints() { return M.waypoints; },
    get stones() { return M.stones; },
    reloadConfig: snapshotConfig,
    debugState() { return M; },
    _bind: waitForBus
  };

})(typeof window !== 'undefined' ? window : globalThis);
