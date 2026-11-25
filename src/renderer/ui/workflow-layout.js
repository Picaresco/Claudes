// ── «Workflow»: dónde va cada cosa del mapa ──────────────────────────
// Puro (sin DOM): del mapa que devuelve el modelo (ya comprobado en workflow.js) salen las
// posiciones de bloques, módulos, flechas y etiquetas, en unidades del lienzo.
//   - Columnas fijas por tipo de bloque, de izquierda a derecha: persona, interfaz, núcleo,
//     procesos y datos. Las vacías no se dibujan. Los servicios de internet van en una banda
//     arriba, sobre el bloque con el que más hablan.
//   - Cada bloque mide lo que sus módulos: una columna de tarjetas hasta 4, dos a partir de 5.
//   - Flechas entre columnas contiguas, de borde a borde; entre columnas alejadas o dentro de
//     la misma columna, por un carril de abajo, para no cruzar por encima de otros bloques.
//     Los puntos de salida de cada lado se reparten para que no se monten.

export const CARD_W = 210;
export const CARD_H = 116;
const GAP = 12; // entre tarjetas
const PAD = 18; // borde del bloque
const HEAD = 66; // título del bloque
const COL_GAP = 190; // entre columnas: sitio para las etiquetas de las flechas
const V_GAP = 90; // entre bloques de una columna
const MARGIN = 40;
const BAND = 190; // banda de internet
const EXT_W = 250;
const EXT_H = 96;
const PER_COLUMN = 2; // bloques por columna como mucho: el mapa queda ancho, como la pantalla
const COLUMN = { persona: 0, interfaz: 1, nucleo: 2, proceso: 3, datos: 4 };

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
    const foot = 22 + rulesOf(b.id).length * 34;
    const w = n ? cols * CARD_W + (cols - 1) * GAP + PAD * 2 : (b.tipo === 'persona' ? 220 : 260);
    const h = Math.max(n ? HEAD + rows * (CARD_H + GAP) - GAP + foot : 200, 200);
    boxes.set(b.id, { ...b, w, h, cols, n });
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
  let x = MARGIN;
  let tallest = 0;
  cols.forEach((col, i) => {
    col.index = i;
    col.w = Math.max(...col.blocks.map((b) => b.w));
    col.x = x;
    col.h = col.blocks.reduce((s, b) => s + b.h, 0) + (col.blocks.length - 1) * V_GAP;
    tallest = Math.max(tallest, col.h);
    x += col.w + COL_GAP;
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
  let W = x - COL_GAP + MARGIN;

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
      cards.push({ ...m, x: b.x + PAD + c * (CARD_W + GAP), y: b.y + HEAD + r * (CARD_H + GAP), w: CARD_W, h: CARD_H, c });
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
      const gutter = col.x + col.w + 28 + (gutters[a.col] = (gutters[a.col] || 0) + 1) * 10;
      return { f, i, type: 'gutter', gutter, ends: [{ box: a, side: 'right' }, { box: b, side: 'right' }] };
    }
    // Columnas alejadas: sale por el lado que mira al otro, baja por el hueco entre columnas
    // hasta un carril bajo todos los bloques y sube por el hueco junto al destino.
    const lane = bottom + 46 + lanes.length * 26;
    lanes.push(lane);
    const right = a.col < b.col;
    const g1 = right ? cols[a.col].x + cols[a.col].w + 30 + lanes.length * 6 : cols[a.col].x - 30 - lanes.length * 6;
    const g2 = right ? cols[b.col].x - 30 - lanes.length * 6 : cols[b.col].x + cols[b.col].w + 30 + lanes.length * 6;
    return { f, i, type: 'lane', lane, g1, g2, ends: [{ box: a, side: right ? 'right' : 'left' }, { box: b, side: right ? 'left' : 'right' }] };
  });
  const far = Math.max(0, ...routes.map((r) => r.gutter || Math.max(r.g1 || 0, r.g2 || 0)));
  if (far + MARGIN > W) W = far + MARGIN;
  // Puntos de cada lado, ordenados según dónde está el otro extremo.
  const sides = new Map();
  for (const r of routes) {
    r.ends.forEach((end, k) => {
      const other = r.ends[1 - k].box;
      const key = `${end.box.id}|${end.side}`;
      if (!sides.has(key)) sides.set(key, []);
      sides.get(key).push({ end, sortKey: end.side === 'left' || end.side === 'right' ? other.y + other.h / 2 : other.x + other.w / 2 });
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
    if (r.type === 'side') {
      const [s, t] = r.leftFirst ? [p, q] : [q, p];
      const dx = (t.x - s.x) / 2;
      d = `M${s.x} ${s.y}C${s.x + dx} ${s.y} ${t.x - dx} ${t.y} ${t.x} ${t.y}`;
      at = [(s.x + t.x) / 2, (s.y + t.y) / 2];
    } else if (r.type === 'stack') {
      const [s, t] = r.upFirst ? [p, q] : [q, p];
      d = `M${s.x} ${s.y}C${s.x} ${(s.y + t.y) / 2} ${t.x} ${(s.y + t.y) / 2} ${t.x} ${t.y}`;
      at = [(s.x + t.x) / 2, (s.y + t.y) / 2];
    } else if (r.type === 'up') {
      const [s, t] = r.fromOuter ? [q, p] : [p, q];
      const my = (s.y + t.y) / 2;
      d = `M${s.x} ${s.y}C${s.x} ${my} ${t.x} ${my} ${t.x} ${t.y}`;
      at = [(s.x + t.x) / 2, my];
    } else if (r.type === 'gutter') {
      d = `M${p.x} ${p.y}H${r.gutter}V${q.y}H${q.x}`;
      at = [r.gutter, (p.y + q.y) / 2];
    } else {
      d = `M${p.x} ${p.y}H${r.g1}V${r.lane}H${r.g2}V${q.y}H${q.x}`;
      at = [(r.g1 + r.g2) / 2, r.lane];
    }
    return { d, at, kind: r.f.tipo, text: r.f.texto, bi: r.f.doble, de: r.f.de, a: r.f.a };
  });

  // Flechas entre módulos de un mismo bloque.
  const byId = new Map(cards.map((c) => [c.id, c]));
  const inner = map.internas.map((f) => {
    const a = byId.get(f.de);
    const b = byId.get(f.a);
    if (!a || !b) return null;
    let d;
    if (a.c !== b.c) {
      const [s, t] = a.x < b.x ? [{ x: a.x + a.w, y: a.y + a.h / 2 }, { x: b.x, y: b.y + b.h / 2 }] : [{ x: a.x, y: a.y + a.h / 2 }, { x: b.x + b.w, y: b.y + b.h / 2 }];
      const dx = (t.x - s.x) / 2;
      d = `M${s.x} ${s.y}C${s.x + dx} ${s.y} ${t.x - dx} ${t.y} ${t.x} ${t.y}`;
    } else if (Math.abs(a.y - b.y) <= CARD_H + GAP) {
      const [s, t] = a.y < b.y ? [{ x: a.x + a.w / 2, y: a.y + a.h }, { x: b.x + b.w / 2, y: b.y }] : [{ x: a.x + a.w / 2, y: a.y }, { x: b.x + b.w / 2, y: b.y + b.h }];
      d = `M${s.x} ${s.y}L${t.x} ${t.y}`;
    } else {
      // Misma columna, no contiguas: por el borde de fuera de la columna.
      const left = a.c === 0;
      const sx = left ? a.x : a.x + a.w;
      const tx = left ? b.x : b.x + b.w;
      const bulge = left ? -12 : 12;
      d = `M${sx} ${a.y + a.h / 2}C${sx + bulge} ${a.y + a.h / 2} ${tx + bulge} ${b.y + b.h / 2} ${tx} ${b.y + b.h / 2}`;
    }
    return { d, kind: f.tipo, bloque: a.bloque };
  }).filter(Boolean);

  // Reglas de cada bloque: etiquetas al pie.
  const pills = [];
  for (const b of blocks) {
    rulesOf(b.id).forEach((r, k, rs) => pills.push({ text: r.texto, at: [b.x + b.w / 2, b.y + b.h - 20 - (rs.length - 1 - k) * 34], bloque: b.id }));
  }

  const H = (lanes.length ? lanes[lanes.length - 1] + 30 : bottom + 40) + MARGIN / 2;
  return { W, H, band: extBoxes.length ? BAND : 0, blocks, ext: extBoxes, cards, arrows, inner, pills };
}
