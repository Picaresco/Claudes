// ── «Workflow»: dónde va cada cosa del mapa ──────────────────────────
// Puro (sin DOM): del mapa que devuelve el modelo (ya comprobado en workflow.js) salen las
// posiciones de bloques, módulos, flechas y etiquetas, en unidades del lienzo.
//   - Columnas fijas por tipo de bloque, de izquierda a derecha: persona, interfaz, núcleo,
//     procesos y datos. Las vacías no se dibujan. Los servicios de internet van en una banda
//     arriba, sobre el bloque con el que más hablan.
//   - Cada bloque mide lo que sus módulos: una columna de tarjetas hasta 2, dos a partir de 3,
//     con un pasillo entre columnas por el que van las conexiones internas, cada una por su carril.
//   - Flechas entre columnas contiguas, de borde a borde; entre columnas alejadas o dentro de
//     la misma columna, por un carril de abajo, para no cruzar por encima de otros bloques.
//     Los puntos de salida de cada lado se reparten para que no se monten.
//   - Lo que va dentro de un bloque tiene su fila reservada, así nada pisa a nada: «Empieza aquí»
//     bajo el título; al pie, la insignia de datos sensibles y la regla del bloque. El resumen
//     (vista general) se centra en lo que queda entre medias (body).

export const CARD_W = 210;
export const CARD_H = 116;
// Entre las piezas de un bloque: un pasillo ancho entre columnas, donde cada conexión interna
// lleva su propio carril, y aire entre filas.
const IN_X = 120; // pasillo entre columnas de piezas (hasta 6 carriles bien separados)
const IN_Y = 34; // entre filas de piezas
const SIDE = 64; // pasillo a la derecha de un bloque de una columna con conexiones internas
// Las flechas que van por debajo de los bloques: carriles separados en alto y sus tramos
// verticales separados en ancho, para poder seguir cada una con la vista.
const LANE_GAP = 40;
const LANE_STEP = 26;
const PAD = 18; // borde del bloque
const HEAD = 66; // título del bloque
const START_ROW = 52; // fila de «Empieza aquí», bajo el título
const BADGE_ROW = 54; // fila de la insignia «datos sensibles», al pie
const RULE_ROW = 48; // fila de cada regla del bloque, al pie (cabe una etiqueta de dos renglones)
const BADGE_H = 40; // grandes: se tienen que leer en la vista general
export const START_W = 184;
export const BADGE_W = 212;
const sensitive = (m) => (m.notas || []).some((t) => String(t).startsWith('🛡'));
const COL_GAP = 190; // entre columnas, como poco: sitio para las etiquetas de las flechas
const MAX_GAP = 380; // y como mucho, aunque una etiqueta pida más (entonces se queda más pequeña)
// Las etiquetas de las flechas guardan su tamaño en pantalla: de lejos crecen, hasta 2,2 veces
// su tamaño en el lienzo (ui/workflow.js, apply). Cada hueco entre columnas mide lo que pide su
// etiqueta más ancha a ese tamaño, así no se mete en los bloques de al lado.
const V_GAP = 90; // entre bloques de una columna
const MARGIN = 40;
const BAND = 190; // banda de internet
const EXT_W = 250;
const EXT_H = 96;
const PER_COLUMN = 2; // bloques por columna como mucho: el mapa queda ancho, como la pantalla
const COLUMN = { persona: 0, interfaz: 1, nucleo: 2, proceso: 3, datos: 4 };

export const CHIP_MAX = 2.2;
// Quita el signo del principio («✕», «🔑», «↻», «🛡», «⇢»): las que llevan icono lo dibujan aparte.
export const unmark = (text) => String(text).trim().replace(/^(✕|🔑|↻|🛡|⇢)\uFE0F?\s*/u, '');
const ICON_KINDS = new Set(['credencial', 'fondo']);

// Tamaño de la etiqueta de una flecha en el lienzo: en dos renglones si es larga.
export function chipSize(kind, text) {
  const icon = ICON_KINDS.has(kind) ? 18 : 0;
  const shown = icon ? unmark(text) : String(text);
  const lines = [...shown].length > 15 ? wrap(shown, 15, 2) : [shown];
  const w = Math.max(40, Math.max(...lines.map((l) => [...l].length)) * 8.4 + 24 + icon);
  return { lines, w, h: lines.length * 18 + 10, icon };
}

// Parte un texto en renglones de `max` caracteres, como mucho `lines` renglones.
export function wrap(text, max = 22, lines = 3) {
  const out = [];
  let cur = '';
  for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
    if (cur && `${cur} ${word}`.length > max) { out.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
    if (out.length === lines) break;
  }
  if (cur && out.length < lines) out.push(cur);
  if (out.length === lines && out.join(' ').length < String(text || '').trim().length) out[lines - 1] = `${out[lines - 1].replace(/[.,;:]?$/, '')}…`;
  return out;
}

export function layoutMap(map) {
  const own = map.bloques.filter((b) => b.tipo !== 'externo');
  const ext = map.bloques.filter((b) => b.tipo === 'externo');
  const modsOf = (id) => map.modulos.filter((m) => m.bloque === id);
  const rulesOf = (id) => map.reglas.filter((r) => r.bloque === id);

  // Tamaño de cada bloque.
  const boxes = new Map();
  for (const b of own) {
    const n = modsOf(b.id).length;
    const cols = n >= 3 ? 2 : 1;
    const rows = Math.ceil(n / cols);
    const sens = modsOf(b.id).some(sensitive);
    const extraTop = b.inicio ? START_ROW : 0;
    const foot = 22 + rulesOf(b.id).length * RULE_ROW + (sens ? BADGE_ROW : 0);
    // Una sola columna con conexiones internas: su pasillo, a la derecha.
    const side = cols === 1 && map.internas.some((f) => modsOf(b.id).some((m) => m.id === f.de)) ? SIDE : 0;
    const w = n ? cols * CARD_W + (cols - 1) * IN_X + PAD * 2 + side : (b.tipo === 'persona' ? 220 : 260);
    // Sin piezas: sitio para el resumen (unos 120) entre el título y lo del pie.
    const h = Math.max(n ? HEAD + extraTop + rows * (CARD_H + IN_Y) - IN_Y + foot : 70 + extraTop + 120 + foot - 22, 200);
    boxes.set(b.id, { ...b, w, h, cols, n, side, extraTop, foot, sensible: sens });
  }

  // Columnas por tipo (sin las vacías), con dos bloques como mucho en cada una.
  const byType = new Map();
  for (const b of own) {
    const c = COLUMN[b.tipo] ?? 2;
    if (!byType.has(c)) byType.set(c, []);
    byType.get(c).push(boxes.get(b.id));
  }
  const cols = [];
  for (const type of [...byType.keys()].sort((a, b) => a - b)) {
    const list = byType.get(type);
    for (let i = 0; i < list.length; i += PER_COLUMN) cols.push({ type, blocks: list.slice(i, i + PER_COLUMN) });
  }
  const top = ext.length ? BAND + 30 : MARGIN;
  // El hueco tras cada columna: el que pida la etiqueta más ancha que va de ella a la siguiente.
  const colOf = new Map();
  cols.forEach((col, i) => col.blocks.forEach((b) => colOf.set(b.id, i)));
  const gaps = cols.map(() => COL_GAP);
  for (const f of map.flechas) {
    const a = colOf.get(f.de);
    const b = colOf.get(f.a);
    if (a === undefined || b === undefined || Math.abs(a - b) !== 1 || !f.texto) continue;
    const i = Math.min(a, b);
    gaps[i] = Math.max(gaps[i], Math.min(MAX_GAP, chipSize(f.tipo, f.texto).w * CHIP_MAX + 24));
  }
  let x = MARGIN;
  let tallest = 0;
  cols.forEach((col, i) => {
    col.index = i;
    col.w = Math.max(...col.blocks.map((b) => b.w));
    col.x = x;
    col.gap = gaps[i];
    col.h = col.blocks.reduce((s, b) => s + b.h, 0) + (col.blocks.length - 1) * V_GAP;
    tallest = Math.max(tallest, col.h);
    x += col.w + gaps[i];
  });
  for (const col of cols) {
    let y = top + (tallest - col.h) / 2;
    for (const b of col.blocks) {
      b.x = col.x + (col.w - b.w) / 2;
      b.y = y;
      b.col = col.index;
      b.row = col.blocks.indexOf(b);
      y += b.h + V_GAP;
    }
  }
  let W = x - (cols.length ? gaps[cols.length - 1] : 0) + MARGIN;

  // Servicios de internet, sobre el bloque con el que más hablan.
  const blocks = [...boxes.values()];
  const extBoxes = ext.map((e) => {
    const peers = map.flechas.filter((f) => f.de === e.id || f.a === e.id).map((f) => boxes.get(f.de === e.id ? f.a : f.de)).filter(Boolean);
    const want = peers.length ? peers.reduce((s, b) => s + b.x + b.w / 2, 0) / peers.length : W / 2;
    return { ...e, w: EXT_W, h: EXT_H, want, y: 40, ext: true };
  }).sort((a, b) => a.want - b.want);
  let minX = MARGIN;
  for (const e of extBoxes) { e.x = Math.max(minX, e.want - EXT_W / 2); minX = e.x + EXT_W + 40; }
  if (extBoxes.length && minX - 40 + MARGIN > W) W = minX - 40 + MARGIN;
  const all = new Map([...blocks, ...extBoxes].map((b) => [b.id, b]));

  // Tarjetas de los módulos.
  const cards = [];
  for (const b of blocks) {
    modsOf(b.id).forEach((m, i) => {
      const c = i % b.cols;
      const r = Math.floor(i / b.cols);
      cards.push({ ...m, x: b.x + PAD + c * (CARD_W + IN_X), y: b.y + HEAD + b.extraTop + r * (CARD_H + IN_Y), w: CARD_W, h: CARD_H, c, r, i });
    });
  }

  // Flechas entre bloques: primero el recorrido, luego se reparten los puntos de cada lado.
  const bottom = top + tallest;
  const lanes = [];
  const gutters = {};
  const routes = map.flechas.map((f, i) => {
    const a = all.get(f.de);
    const b = all.get(f.a);
    if (a.ext || b.ext) {
      const [inner, outer] = a.ext ? [b, a] : [a, b];
      return { f, i, type: 'up', ends: [{ box: inner, side: 'top' }, { box: outer, side: 'bottom' }], fromOuter: Boolean(a.ext) };
    }
    if (Math.abs(a.col - b.col) === 1) {
      const [l, r] = a.col < b.col ? [a, b] : [b, a];
      return { f, i, type: 'side', ends: [{ box: l, side: 'right' }, { box: r, side: 'left' }], leftFirst: a === l };
    }
    if (a.col === b.col && Math.abs(a.row - b.row) === 1) {
      const [u, d] = a.row < b.row ? [a, b] : [b, a];
      return { f, i, type: 'stack', ends: [{ box: u, side: 'bottom' }, { box: d, side: 'top' }], upFirst: a === u };
    }
    if (a.col === b.col) {
      // Misma columna con otro bloque en medio: por el hueco de la derecha de la columna.
      const col = cols[a.col];
      const gutter = col.x + col.w + 4 + (gutters[a.col] = (gutters[a.col] || 0) + 1) * LANE_STEP;
      return { f, i, type: 'gutter', gutter, ends: [{ box: a, side: 'right' }, { box: b, side: 'right' }] };
    }
    // Columnas alejadas: sale por el lado que mira al otro, baja por el hueco entre columnas
    // hasta un carril bajo todos los bloques y sube por el hueco junto al destino.
    const k = lanes.length;
    const lane = bottom + 50 + k * LANE_GAP;
    lanes.push(lane);
    return { f, i, type: 'lane', lane, k, right: a.col < b.col, ends: [{ box: a, side: a.col < b.col ? 'right' : 'left' }, { box: b, side: a.col < b.col ? 'left' : 'right' }] };
  });
  // Los tramos verticales de los carriles, bien separados y encajados unos dentro de otros: el
  // carril más hondo baja más pegado a su bloque, así ninguno cruza a otro.
  for (const r of routes) {
    if (r.type !== 'lane') continue;
    const [a, b] = r.ends.map((e) => e.box);
    const off = 24 + (lanes.length - 1 - r.k) * LANE_STEP;
    r.g1 = r.right ? cols[a.col].x + cols[a.col].w + off : cols[a.col].x - off;
    r.g2 = r.right ? cols[b.col].x - off : cols[b.col].x + cols[b.col].w + off;
  }
  const far = Math.max(0, ...routes.map((r) => r.gutter || Math.max(r.g1 || 0, r.g2 || 0)));
  if (far + MARGIN > W) W = far + MARGIN;
  // Puntos de cada lado, ordenados según dónde está el otro extremo.
  const sides = new Map();
  for (const r of routes) {
    r.ends.forEach((end, k) => {
      const other = r.ends[1 - k].box;
      const key = `${end.box.id}|${end.side}`;
      if (!sides.has(key)) sides.set(key, []);
      // Los carriles de abajo salen por la parte baja del lado, el más hondo el último: así su
      // tramo horizontal no cruza el vertical de otro.
      const sortKey = r.type === 'lane' ? 1e6 + r.k : end.side === 'left' || end.side === 'right' ? other.y + other.h / 2 : other.x + other.w / 2;
      sides.get(key).push({ end, sortKey });
    });
  }
  for (const [, items] of sides) {
    items.sort((p, q) => p.sortKey - q.sortKey);
    items.forEach(({ end }, k) => {
      const box = end.box;
      const n = items.length;
      if (end.side === 'left' || end.side === 'right') {
        const y0 = box.y + (box.ext ? 10 : Math.min(HEAD, box.h / 3));
        const y1 = box.y + box.h - 20;
        end.x = end.side === 'left' ? box.x : box.x + box.w;
        end.y = y0 + ((k + 1) * (y1 - y0)) / (n + 1);
      } else {
        const x0 = box.x + 16;
        const x1 = box.x + box.w - 16;
        end.x = x0 + ((k + 1) * (x1 - x0)) / (n + 1);
        end.y = end.side === 'top' ? box.y : box.y + box.h;
      }
    });
  }
  const arrows = routes.map((r) => {
    const [p, q] = r.ends;
    let d;
    let at;
    // room: lo que puede ocupar su etiqueta sin meterse en los bloques (ancho, alto).
    let room = [Infinity, Infinity];
    if (r.type === 'side') {
      const [s, t] = r.leftFirst ? [p, q] : [q, p];
      const dx = (t.x - s.x) / 2;
      d = `M${s.x} ${s.y}C${s.x + dx} ${s.y} ${t.x - dx} ${t.y} ${t.x} ${t.y}`;
      at = [(s.x + t.x) / 2, (s.y + t.y) / 2];
      room = [Math.abs(t.x - s.x) - 16, Infinity];
    } else if (r.type === 'stack') {
      const [s, t] = r.upFirst ? [p, q] : [q, p];
      d = `M${s.x} ${s.y}C${s.x} ${(s.y + t.y) / 2} ${t.x} ${(s.y + t.y) / 2} ${t.x} ${t.y}`;
      at = [(s.x + t.x) / 2, (s.y + t.y) / 2];
      room = [Infinity, Math.abs(t.y - s.y) - 8];
    } else if (r.type === 'up') {
      const [s, t] = r.fromOuter ? [q, p] : [p, q];
      const my = (s.y + t.y) / 2;
      d = `M${s.x} ${s.y}C${s.x} ${my} ${t.x} ${my} ${t.x} ${t.y}`;
      at = [(s.x + t.x) / 2, my];
      room = [Infinity, Math.abs(t.y - s.y) - 8];
    } else if (r.type === 'gutter') {
      d = `M${p.x} ${p.y}H${r.gutter}V${q.y}H${q.x}`;
      at = [r.gutter, (p.y + q.y) / 2];
    } else {
      d = `M${p.x} ${p.y}H${r.g1}V${r.lane}H${r.g2}V${q.y}H${q.x}`;
      at = [(r.g1 + r.g2) / 2, r.lane];
    }
    return { d, at, room, kind: r.f.tipo, text: r.f.texto, bi: r.f.doble, de: r.f.de, a: r.f.a };
  });

  // Flechas entre piezas de un mismo bloque. Entre vecinas de arriba y abajo, recta por el aire
  // entre filas; las demás, por el pasillo del bloque, cada una por su carril y en ángulo recto,
  // saliendo y entrando por el lado de la tarjeta que da al pasillo. Los puntos de cada lado de
  // una tarjeta se reparten, así no se pisan ni las líneas ni las puntas.
  const byId = new Map(cards.map((c) => [c.id, c]));
  const innerRoutes = map.internas.map((f) => ({ f, a: byId.get(f.de), b: byId.get(f.a) })).filter((r) => r.a && r.b);
  const lanesIn = new Map(); // bloque → carriles usados
  const portsIn = new Map(); // tarjeta|lado → puntos
  // Los que dan al pasillo se reparten por fila, contando las dos columnas juntas: así dos tramos
  // horizontales del pasillo nunca van a la misma altura (salvo los dos extremos de una misma
  // flecha entre piezas de la misma fila, que van rectos de lado a lado).
  const keyOf = (card, side) => (side === 'left' || side === 'right' ? `${card.bloque}|fila${card.r}` : `${card.id}|${side}`);
  const port = (card, side, r) => {
    const key = keyOf(card, side);
    if (!portsIn.has(key)) portsIn.set(key, []);
    if (!portsIn.get(key).includes(r)) portsIn.get(key).push(r);
  };
  for (const r of innerRoutes) {
    const { a, b } = r;
    if (a.c === b.c && Math.abs(a.r - b.r) === 1) {
      r.type = 'near';
      port(a, a.r < b.r ? 'bottom' : 'top', r);
    } else {
      r.type = 'lane';
      r.lane = lanesIn.get(a.bloque) || 0;
      lanesIn.set(a.bloque, r.lane + 1);
      r.sideA = a.c === 0 ? 'right' : 'left';
      r.sideB = b.c === 0 ? 'right' : 'left';
      port(a, r.sideA, r);
      port(b, r.sideB, r);
    }
  }
  const at = (card, side, r) => {
    const list = portsIn.get(keyOf(card, side));
    const k = list.indexOf(r);
    if (side === 'bottom' || side === 'top') return { x: card.x + card.w / 2 + (k - (list.length - 1) / 2) * 18, y: side === 'bottom' ? card.y + card.h : card.y };
    return { x: side === 'right' ? card.x + card.w : card.x, y: card.y + 26 + ((k + 1) * (card.h - 36)) / (list.length + 1) };
  };
  const inner = innerRoutes.map((r) => {
    const { a, b } = r;
    let d;
    if (r.type === 'near') {
      const s = at(a, a.r < b.r ? 'bottom' : 'top', r);
      d = `M${s.x} ${s.y}V${a.r < b.r ? b.y : b.y + b.h}`;
    } else {
      const blk = boxes.get(a.bloque);
      const x0 = blk.x + PAD + CARD_W; // el pasillo empieza tras la primera columna
      const width = blk.cols === 2 ? IN_X : blk.side;
      const n = lanesIn.get(a.bloque);
      const lane = x0 + ((r.lane + 1) * width) / (n + 1);
      const s = at(a, r.sideA, r);
      const t = at(b, r.sideB, r);
      d = `M${s.x} ${s.y}H${lane}V${t.y}H${t.x}`;
    }
    return { d, kind: r.f.tipo, bloque: a.bloque, de: r.f.de, a: r.f.a };
  });

  // Lo de dentro de cada bloque, en sus filas: reglas al pie (la última abajo del todo), encima la
  // insignia de datos sensibles y, bajo el título, «Empieza aquí». Y el hueco del resumen (body).
  const pills = [];
  const badges = [];
  for (const b of blocks) {
    const rs = rulesOf(b.id);
    rs.forEach((r, k) => pills.push({ text: r.texto, at: [b.x + b.w / 2, b.y + b.h - 12 - RULE_ROW / 2 - (rs.length - 1 - k) * RULE_ROW], bloque: b.id }));
    if (b.sensible) badges.push({ kind: 'sensible', bloque: b.id, x: b.x + (b.w - BADGE_W) / 2, y: b.y + b.h - 12 - rs.length * RULE_ROW - (BADGE_ROW + BADGE_H) / 2, w: BADGE_W, h: BADGE_H });
    if (b.inicio) badges.push({ kind: 'inicio', bloque: b.id, x: b.x + 18, y: b.y + HEAD - 4, w: Math.min(START_W, b.w - 36), h: BADGE_H });
    b.body = [b.y + 70 + b.extraTop, b.y + b.h - Math.max(14, b.foot - 8)];
  }

  const H = (lanes.length ? lanes[lanes.length - 1] + 30 : bottom + 40) + MARGIN / 2;
  return { W, H, band: extBoxes.length ? BAND : 0, blocks, ext: extBoxes, cards, arrows, inner, pills, badges };
}
