// Minimal dependency-free PDF writer: turns report data into a real A4 PDF
// (built-in Helvetica fonts, WinAnsi text) that the browser can download.
// No external libraries, so it works offline and passes the strict CSP.
// Layout mirrors the on-screen Sales Reports page.

import { money, fmtDateTime, fmtDayLabel } from './ui.js';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
const ROW_H = 20;
const HEAD_H = 18;
const PAD = 6;

// Character widths (1/1000 em) for WinAnsi chars 32-126.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
];
const HELV_B = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611,
  556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389,
  280, 389, 584,
];

// Palette, matching the on-screen report (Tailwind stone scale).
const INK = '0.11 0.098 0.09'; // #1c1917 (stone-900)
const GRAY = '0.471 0.443 0.424'; // #78716c (stone-500)
const LIGHT = '0.659 0.635 0.62'; // #a8a29e (stone-400)
const RED = '0.725 0.11 0.11'; // #b91c1c (red-700)
const BORDER = '0.961 0.961 0.957'; // #f5f5f4 (stone-100, row rules)
const RULE = '0.906 0.898 0.894'; // #e7e5e4 (stone-200, box borders)
// Brand accents (red scale, like the app).
const RED_BG = '0.996 0.949 0.949'; // #fef2f2 (red-50, table head + totals fill)
const RED_RULE = '0.996 0.792 0.792'; // #fecaca (red-200, rule under table heads)
const RED_DARK = '0.6 0.106 0.106'; // #991b1b (red-800, table head / totals text)

const PUNCT = {
  '\u2018': '\u0091',
  '\u2019': '\u0092',
  '\u201C': '\u0093',
  '\u201D': '\u0094',
  '\u2022': '\u0095',
  '\u2013': '\u0096',
  '\u2014': '\u0097',
  '\u20AC': '\u0080',
  '\u2026': '\u0085',
};

/** Map a UI string to WinAnsi bytes (the peso sign becomes "PHP "). */
function toWinAnsi(value) {
  let str = String(value == null ? '' : value).replace(/\u20B1/g, 'PHP ');
  str = str.replace(/[\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u20AC\u2026]/g, (ch) => PUNCT[ch] || ch);
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code < 32 || (code >= 127 && code < 160)) out += ' ';
    else if (code <= 0xff) out += ch;
    else out += '?';
  }
  return out;
}

function pdfString(str) {
  return str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function encodeLatin1(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

function charWidth(code, bold) {
  if (code >= 32 && code <= 126) return (bold ? HELV_B : HELV)[code - 32];
  return 556;
}

function measure(str, size, bold) {
  let total = 0;
  for (let i = 0; i < str.length; i += 1) total += charWidth(str.charCodeAt(i), bold);
  return (total / 1000) * size;
}

/** Truncate with an ellipsis when text would overflow its column. */
function fit(str, maxW, size, bold) {
  if (measure(str, size, bold) <= maxW) return str;
  let out = str;
  while (out.length > 1 && measure(out + '\u0085', size, bold) > maxW) out = out.slice(0, -1);
  return out + '\u0085';
}

const num = (value) => String(Math.round(value * 100) / 100);

/** zlib inflate / deflate through the web compression streams API. */
async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------------------
// Logo embedding: decode /images/logo.png, split RGB + alpha, re-compress both
// as FlateDecode streams for the PDF image XObject.
// ---------------------------------------------------------------------------

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterRow(filter, row, prev, bpp) {
  const len = row.length;
  if (filter === 1) {
    for (let i = bpp; i < len; i += 1) row[i] = (row[i] + row[i - bpp]) & 0xff;
  } else if (filter === 2) {
    for (let i = 0; i < len; i += 1) row[i] = (row[i] + prev[i]) & 0xff;
  } else if (filter === 3) {
    for (let i = 0; i < len; i += 1) {
      const left = i >= bpp ? row[i - bpp] : 0;
      row[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xff;
    }
  } else if (filter === 4) {
    for (let i = 0; i < len; i += 1) {
      const a = i >= bpp ? row[i - bpp] : 0;
      row[i] = (row[i] + paeth(a, prev[i], i >= bpp ? prev[i - bpp] : 0)) & 0xff;
    }
  }
}

/** Decode an 8-bit RGB/RGBA PNG into raw pixels. Returns null when unsupported. */
async function decodePng(bytes) {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  let pos = 8;
  while (pos + 12 <= bytes.length) {
    const len = view.getUint32(pos);
    if (pos + 12 + len > bytes.length) break;
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const start = pos + 8;
    if (type === 'IHDR') {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      bitDepth = bytes[start + 8];
      colorType = bytes[start + 9];
      if (bytes[start + 12] !== 0) return null; // interlaced: skip the logo
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(start, start + len));
    } else if (type === 'IEND') {
      break;
    }
    pos = start + len + 4;
  }
  if (!width || !height || bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || !idat.length) return null;

  const channels = colorType === 6 ? 4 : 3;
  const zlib = new Uint8Array(idat.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of idat) {
    zlib.set(chunk, offset);
    offset += chunk.length;
  }
  const raw = await inflate(zlib);

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    unfilterRow(raw[y * (stride + 1)], row, prev, channels);
    prev = row;
  }

  const rgb = new Uint8Array(width * height * 3);
  const alpha = colorType === 6 ? new Uint8Array(width * height) : null;
  // raw still holds one filter byte per row, so pixels must be read row by row.
  for (let y = 0, p = 0, a = 0; y < height; y += 1) {
    let o = y * (stride + 1) + 1;
    for (let x = 0; x < width; x += 1, o += channels) {
      rgb[p++] = raw[o];
      rgb[p++] = raw[o + 1];
      rgb[p++] = raw[o + 2];
      if (alpha) alpha[a++] = raw[o + 3];
    }
  }
  return { width, height, rgb, alpha };
}

let logoPromise = null;

/** Decode the shop logo once; the result feeds Pdf.image(). Null when unavailable. */
function loadLogoImage() {
  if (!logoPromise) {
    logoPromise = (async () => {
      try {
        if (typeof DecompressionStream !== 'function' || typeof CompressionStream !== 'function') return null;
        const res = await fetch('/images/logo.png');
        if (!res.ok) return null;
        const parsed = await decodePng(new Uint8Array(await res.arrayBuffer()));
        if (!parsed) return null;
        return {
          width: parsed.width,
          height: parsed.height,
          rgb: await deflate(parsed.rgb),
          alpha: parsed.alpha ? await deflate(parsed.alpha) : null,
        };
      } catch {
        // Any problem with the logo must never break the report itself.
        return null;
      }
    })();
  }
  return logoPromise;
}

/** Page content builder: tracks a y cursor (distance from the page top). */
class Pdf {
  constructor() {
    this.pages = [];
    this.ops = [];
    this.images = [];
    this.y = MARGIN;
  }

  newPage() {
    if (this.ops.length) this.pages.push(this.ops);
    this.ops = [];
    this.y = MARGIN;
  }

  /** Start a new page when `height` points no longer fit above the bottom margin. */
  ensure(height) {
    if (PAGE_H - this.y - height >= MARGIN) return;
    this.newPage();
  }

  /** `baseline` is measured from the page top; align: left (x), right (x), center (x). */
  text(str, x, baseline, { size = 10, bold = false, color = INK, align = 'left', maxW = 0, charSpace = 0, shrink = false } = {}) {
    str = toWinAnsi(str);
    if (maxW > 0) {
      if (shrink) {
        // Never clip figures: reduce the font until the value fits instead.
        const raw = measure(str, size, bold);
        if (raw > maxW) size = Math.max(6.5, Math.floor((size * maxW * 100) / raw) / 100);
      } else {
        str = fit(str, maxW, size, bold);
      }
    }
    const pad = charSpace * Math.max(0, str.length - 1);
    let xx = x;
    if (align === 'right') xx = x - measure(str, size, bold) - pad;
    else if (align === 'center') xx = x - (measure(str, size, bold) + pad) / 2;
    this.ops.push(
      `${color} rg BT ${bold ? '/F2' : '/F1'} ${num(size)} Tf ${charSpace ? `${num(charSpace)} Tc ` : ''}1 0 0 1 ${num(
        xx
      )} ${num(PAGE_H - baseline)} Tm (${pdfString(str)}) Tj${charSpace ? ' 0 Tc' : ''} ET`
    );
  }

  rect(x, yTop, w, h, { fill = null, stroke = null, lineWidth = 1 } = {}) {
    const y = PAGE_H - yTop - h;
    if (fill) this.ops.push(`${fill} rg ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`);
    if (stroke) this.ops.push(`${stroke} RG ${num(lineWidth)} w ${num(x)} ${num(y)} ${num(w)} ${num(h)} re S`);
  }

  line(x1, yTop1, x2, yTop2, { color = BORDER, lineWidth = 1 } = {}) {
    this.ops.push(
      `${color} RG ${num(lineWidth)} w ${num(x1)} ${num(PAGE_H - yTop1)} m ${num(x2)} ${num(PAGE_H - yTop2)} l S`
    );
  }

  /** Draw an image (see loadLogoImage) scaled to w x h with its top at yTop. */
  image(image, x, yTop, w, h) {
    if (!this.images.includes(image)) this.images.push(image);
    const name = `/Im${this.images.indexOf(image) + 1}`;
    this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(PAGE_H - yTop - h)} cm ${name} Do Q`);
  }
}

// ---------------------------------------------------------------------------
// Table primitives (colEdges/drawTableHead/drawRow/table/twoColTables)
// ---------------------------------------------------------------------------

/** spec: { x, width, cols: [{ label, align, frac }] } */
function colEdges(spec) {
  const edges = [];
  let acc = 0;
  for (const col of spec.cols) {
    edges.push({ start: acc, end: acc + col.frac * spec.width });
    acc += col.frac * spec.width;
  }
  return edges;
}

function drawTableHead(doc, spec, edges) {
  doc.ensure(HEAD_H);
  const top = doc.y;
  doc.rect(spec.x, top, spec.width, HEAD_H, { fill: RED_BG });
  spec.cols.forEach((col, i) => {
    const cx = col.align === 'right' ? spec.x + edges[i].end - PAD : spec.x + edges[i].start + PAD;
    doc.text(col.label.toUpperCase(), cx, top + 12, { size: 8, bold: true, color: RED_DARK, align: col.align, charSpace: 0.4 });
  });
  doc.line(spec.x, top + HEAD_H, spec.x + spec.width, top + HEAD_H, { color: RED_RULE });
  doc.y = top + HEAD_H;
}

function drawRow(doc, spec, edges, row, top) {
  if (row.fill) doc.rect(spec.x, top, spec.width, ROW_H, { fill: row.fill });
  if (row.span) {
    // Single cell across the whole table (empty-state rows, centered like the page).
    const centered = row.align === 'center';
    doc.text(row.cells[0], centered ? spec.x + spec.width / 2 : spec.x + PAD, top + 13, {
      size: 9.5,
      color: GRAY,
      align: centered ? 'center' : 'left',
      maxW: spec.width - PAD * 2,
    });
  } else if (row.merge2) {
    // First cell spans columns 1-2 (the bold "All items" total row on the page).
    doc.text(row.cells[0], spec.x + PAD, top + 13, {
      size: 9.5,
      bold: !!row.bold,
      color: row.color || INK,
      maxW: edges[1].end - edges[0].start - PAD * 2,
    });
    row.cells.slice(1).forEach((cell, i) => {
      const col = spec.cols[i + 2];
      const cx = col.align === 'right' ? spec.x + edges[i + 2].end - PAD : spec.x + edges[i + 2].start + PAD;
      doc.text(cell, cx, top + 13, {
        size: 9.5,
        bold: !!row.bold,
        color: row.color || INK,
        align: col.align,
        maxW: col.frac * spec.width - PAD * 2,
        // Figures shrink instead of being cut off.
        shrink: col.align === 'right',
      });
    });
  } else {
    row.cells.forEach((cell, i) => {
      const col = spec.cols[i];
      const cx = col.align === 'right' ? spec.x + edges[i].end - PAD : spec.x + edges[i].start + PAD;
      doc.text(cell, cx, top + 13, {
        size: 9.5,
        bold: !!row.bold,
        color: row.color || INK,
        align: col.align,
        maxW: col.frac * spec.width - PAD * 2,
        // Figures shrink instead of being cut off.
        shrink: col.align === 'right',
      });
    });
  }
  doc.line(spec.x, top + ROW_H, spec.x + spec.width, top + ROW_H, { color: BORDER });
}

/** Full-width or fixed-width table that repeats its header on page breaks. */
function table(doc, spec) {
  spec.x = spec.x ?? MARGIN;
  spec.width = spec.width ?? CONTENT_W;
  const edges = colEdges(spec);
  drawTableHead(doc, spec, edges);
  for (const row of spec.rows) {
    if (PAGE_H - doc.y - ROW_H < MARGIN) {
      doc.newPage();
      drawTableHead(doc, spec, edges);
    }
    drawRow(doc, spec, edges, row, doc.y);
    doc.y += ROW_H;
  }
  doc.y += 8;
}

/** Two tables drawn side by side, kept in lockstep across page breaks. */
function twoColTables(doc, left, right) {
  const gap = 18;
  const colW = (CONTENT_W - gap) / 2;
  const specs = [
    { ...left, x: MARGIN, width: colW },
    { ...right, x: MARGIN + colW + gap, width: colW },
  ];
  specs.forEach((spec) => {
    spec.edges = colEdges(spec);
  });

  const maxRows = Math.max(...specs.map((spec) => spec.rows.length));
  const totalH = 16 + HEAD_H + maxRows * ROW_H;
  if (totalH <= PAGE_H - MARGIN * 2) doc.ensure(totalH);

  // Section titles, then the first header of every table that has rows.
  let titled = false;
  for (const spec of specs) {
    if (spec.rows.length) {
      doc.text(spec.title.toUpperCase(), spec.x, doc.y + 10, { size: 9.5, bold: true, color: RED, charSpace: 0.5, maxW: spec.width });
      titled = true;
    }
  }
  if (titled) doc.y += 16;
  for (const spec of specs) {
    if (spec.rows.length) drawTableHead(doc, spec, spec.edges);
  }

  for (let i = 0; i < maxRows; i += 1) {
    if (PAGE_H - doc.y - ROW_H < MARGIN) {
      doc.newPage();
      // Only tables with rows left repeat their header.
      for (const spec of specs) {
        if (i < spec.rows.length) drawTableHead(doc, spec, spec.edges);
      }
    }
    const top = doc.y;
    for (const spec of specs) {
      const row = spec.rows[i];
      if (row) drawRow(doc, spec, spec.edges, row, top);
    }
    doc.y = top + ROW_H;
  }
  doc.y += 8;
}

// ---------------------------------------------------------------------------
// Report layout
// ---------------------------------------------------------------------------

/** Row of bordered summary boxes (label, value, sub) laid out evenly. */
function summaryBoxes(doc, boxes) {
  const gap = 8;
  const boxH = 58;
  const boxW = (CONTENT_W - gap * (boxes.length - 1)) / boxes.length;
  doc.ensure(boxH + 12);
  const top = doc.y;
  boxes.forEach((box, i) => {
    const x = MARGIN + i * (boxW + gap);
    doc.rect(x, top, boxW, boxH, { stroke: RULE });
    doc.text(box.label.toUpperCase(), x + 10, top + 15, {
      size: 7.5,
      bold: true,
      color: RED,
      charSpace: 0.4,
      maxW: boxW - 20,
    });
    doc.text(box.value, x + 10, top + 36, { size: 13.5, bold: true, maxW: boxW - 20, shrink: true });
    if (box.sub) doc.text(box.sub, x + 10, top + 50, { size: 7.5, color: GRAY, maxW: boxW - 20 });
  });
  doc.y = top + boxH + 12;
}

function heading(doc, text) {
  doc.ensure(HEAD_H + 26);
  doc.text(text.toUpperCase(), MARGIN, doc.y + 10, { size: 9.5, bold: true, color: RED, charSpace: 0.5, maxW: CONTENT_W });
  doc.y += 18;
}

/** Word-wrapped paragraph at the cursor. */
function wrap(doc, str, x, width, opts) {
  const words = toWinAnsi(str).split(/\s+/).filter(Boolean);
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && measure(candidate, opts.size, false) > width) {
      doc.text(line, x, doc.y + 10, opts);
      doc.y += 11;
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    doc.text(line, x, doc.y + 10, opts);
    doc.y += 11;
  }
}

/** Range label like the page header: "Nov 14, 2026" / "Nov 8, 2026 to Nov 14, 2026". */
function rangeText(range) {
  if (!range) return '';
  if (range.from === range.to) return `${fmtDayLabel(range.from)}, ${range.from.slice(0, 4)}`;
  return `${fmtDayLabel(range.from)}, ${range.from.slice(0, 4)} to ${fmtDayLabel(range.to)}, ${range.to.slice(0, 4)}`;
}

const dateCell = (dateStr) => `${fmtDayLabel(dateStr)}, ${dateStr.slice(0, 4)}`;

/** Build the report as a PDF Blob - same content and look as the on-screen page. */
export async function salesReportPdfBlob(data, settings) {
  const s = settings || {};
  const sum = data.summary || {};
  const doc = new Pdf();
  const RIGHT = MARGIN + CONTENT_W;

  // Header: logo + shop details left, report title block right.
  const top = MARGIN;
  let textX = MARGIN;
  const logo = await loadLogoImage();
  if (logo) {
    const h = 40;
    const w = Math.round((logo.width / logo.height) * h * 10) / 10;
    doc.image(logo, MARGIN, top, w, h);
    textX = MARGIN + w + 10;
  }
  doc.text('Kuya E', textX, top + 17, { size: 16, bold: true, maxW: RIGHT - textX - 170 });
  const contact = [s.address, s.phone].filter(Boolean).join(' | ');
  if (contact) doc.text(contact, textX, top + 31, { size: 9, color: GRAY, maxW: RIGHT - textX - 170 });
  doc.text('SALES REPORT', RIGHT, top + 12, { size: 12, bold: true, color: RED, align: 'right', charSpace: 0.6, maxW: 170 });
  doc.text(rangeText(data.range), RIGHT, top + 26, { size: 9.5, color: GRAY, align: 'right', maxW: 220 });
  doc.text(`Generated ${fmtDateTime(data.generatedAt)}`, RIGHT, top + 38, { size: 8, color: LIGHT, align: 'right', maxW: 220 });
  doc.line(MARGIN, top + 48, RIGHT, top + 48, { color: RED, lineWidth: 1.5 });
  doc.y = top + 62;

  // Summary boxes
  const paidCount =
    sum.paidCount != null ? sum.paidCount : (sum.cashCount || 0) + (sum.onlineCount || 0) + (sum.otherPaidCount || 0);
  summaryBoxes(doc, [
    { label: 'Gross Sales', value: money(sum.grossCents), sub: `${sum.ordersCount} orders` },
    { label: 'Collected', value: money(sum.paidCents), sub: `${paidCount} paid orders` },
    {
      label: 'Uncollected',
      value: money(sum.unpaidCents),
      sub: sum.unpaidCount != null ? `${sum.unpaidCount} unpaid orders` : 'unpaid orders',
    },
  ]);
  summaryBoxes(doc, [
    { label: 'Cash', value: money(sum.cashCents), sub: `${sum.cashCount} orders` },
    { label: 'Online', value: money(sum.onlineCents), sub: `${sum.onlineCount} orders` },
    {
      label: 'Dine In',
      value: money(data.orderTypes ? data.orderTypes.dineIn.totalCents : 0),
      sub: `${data.orderTypes ? data.orderTypes.dineIn.count : 0} orders`,
    },
    {
      label: 'Take Out',
      value: money(data.orderTypes ? data.orderTypes.takeOut.totalCents : 0),
      sub: `${data.orderTypes ? data.orderTypes.takeOut.count : 0} orders`,
    },
  ]);

  // Daily breakdown beside top items (like the page's two-column grid)
  const dailyRows = (data.daily || []).map((d) => ({
    cells: [dateCell(d.date), String(d.ordersCount), money(d.grossCents), money(d.paidCents)],
  }));
  const itemRows = (data.topItems || []).map((item, index) => ({
    cells: [String(index + 1), item.name, String(item.quantity), money(item.salesCents)],
  }));
  if (sum.itemsSold) {
    itemRows.push({
      bold: true,
      fill: RED_BG,
      color: RED_DARK,
      merge2: true,
      cells: ['All items', String(sum.itemsSold), money(sum.itemsCents != null ? sum.itemsCents : sum.grossCents)],
    });
  }
  twoColTables(
    doc,
    {
      title: 'Daily Breakdown',
      cols: [
        { label: 'Date', align: 'left', frac: 0.3 },
        { label: 'Orders', align: 'right', frac: 0.14 },
        { label: 'Gross', align: 'right', frac: 0.28 },
        { label: 'Collected', align: 'right', frac: 0.28 },
      ],
      rows: dailyRows.length ? dailyRows : [{ span: true, align: 'center', cells: ['No orders in this period.'] }],
    },
    {
      title: 'Top Items',
      cols: [
        { label: '#', align: 'left', frac: 0.1 },
        { label: 'Item', align: 'left', frac: 0.42 },
        { label: 'Qty', align: 'right', frac: 0.2 },
        { label: 'Sales', align: 'right', frac: 0.28 },
      ],
      rows: itemRows.length ? itemRows : [{ span: true, align: 'center', cells: ['No items sold.'] }],
    }
  );

  // Staff performance (full width, like the page)
  const staffRows = (data.staff || []).map((member) => ({
    cells: [member.name, String(member.ordersCount), money(member.salesCents)],
  }));
  heading(doc, 'Staff Performance');
  table(doc, {
    cols: [
      { label: 'Staff', align: 'left', frac: 0.44 },
      { label: 'Orders', align: 'right', frac: 0.26 },
      { label: 'Sales', align: 'right', frac: 0.3 },
    ],
    rows: staffRows.length ? staffRows : [{ span: true, align: 'center', cells: ['No data.'] }],
  });

  // Footnote: only the note that changes how the numbers should be read.
  doc.y += 6;
  doc.ensure(26);
  wrap(
    doc,
    `Cancelled orders are excluded from sales totals (${sum.cancelledCount} cancelled, ${money(
      sum.cancelledCents
    )}).`,
    MARGIN,
    CONTENT_W,
    { size: 8.5, color: GRAY }
  );

  return serialize(doc, `Sales Report ${rangeText(data.range)}`, doc.images);
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Assemble the PDF as bytes: strings are WinAnsi (1 char = 1 byte), image
 * streams are already-compressed byte arrays. Object order: 1 catalog,
 * 2 pages, 3-4 fonts, 5 info, then image XObjects, then pages + contents.
 */
function serialize(doc, title, images) {
  const activePages = [...doc.pages];
  if (doc.ops.length) activePages.push(doc.ops);
  const pages = activePages.filter((ops) => ops.length);
  if (!pages.length) pages.push(['']);

  const objects = [];
  const add = (header, stream) => objects.push({ header, stream: stream || null });

  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(null); // placeholder: pages tree, filled once the page numbers are known
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  add(`<< /Title (${pdfString(toWinAnsi(title))}) /Producer (Kuya E POS) >>`);

  const imageRefs = [];
  for (const image of images) {
    let smaskNum = null;
    if (image.alpha) {
      smaskNum = objects.length + 1;
      add(
        `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.alpha.length} >>`,
        image.alpha
      );
    }
    imageRefs.push(objects.length + 1);
    const smaskEntry = smaskNum ? ` /SMask ${smaskNum} 0 R` : '';
    add(
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smaskEntry} /Length ${image.rgb.length} >>`,
      image.rgb
    );
  }

  const firstPageNum = objects.length + 1;
  const kids = pages.map((_, i) => `${firstPageNum + i * 2} 0 R`).join(' ');
  objects[1].header = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;

  const xobjects = imageRefs.map((ref, i) => `/Im${i + 1} ${ref} 0 R`).join(' ');
  const resources = `/Font << /F1 3 0 R /F2 4 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ''}`;

  pages.forEach((ops, i) => {
    const content = ops.join('\n');
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << ${resources} >> /Contents ${
        firstPageNum + i * 2 + 1
      } 0 R >>`
    );
    add(`<< /Length ${content.length} >>`, encodeLatin1(content));
  });

  const chunks = [];
  let offset = 0;
  const offsets = [];
  const write = (str) => {
    const bytes = encodeLatin1(str);
    chunks.push(bytes);
    offset += bytes.length;
  };
  const writeBytes = (bytes) => {
    chunks.push(bytes);
    offset += bytes.length;
  };

  write('%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n');
  objects.forEach((object, i) => {
    offsets.push(offset);
    write(`${i + 1} 0 obj\n${object.header}\n`);
    if (object.stream) {
      write('stream\n');
      writeBytes(object.stream);
      write('\nendstream\n');
    }
    write('endobj\n');
  });

  const xrefStart = offset;
  write(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const objectOffset of offsets) write(`${String(objectOffset).padStart(10, '0')} 00000 n \n`);
  write(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const out = new Uint8Array(offset);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return new Blob([out], { type: 'application/pdf' });
}
