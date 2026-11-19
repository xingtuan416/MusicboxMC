import { $, state } from './state.js';
import { colorOf, displayBlockName } from './blocks.js';
import { create } from './dom.js';
import {
  cellRangeForView,
  cellForScale,
  clampView,
  DETAIL_MIN_CELL,
  dustSizes,
  GUTTER,
  noteBlockSizes,
  repeaterSizes,
  RULER,
  scaleForCell,
  tilesForView,
  viewGeometry,
  visibleCells,
} from './previewGeometry.js';

/**
 * Cell size in CSS pixels, the same for every song.
 *
 * Above DETAIL_MIN_CELL and BADGE_MIN_CELL so note names and the block badge are drawn;
 * big enough that one block is readable without leaning in.
 */
const READABLE_CELL = 28;

/** Background of the gutter and ruler. */
const HEAD_BG = '#e9e7e2';
/** The result the view was last fitted to, so a new one re-fits instead of scrolling. */
let fittedFor = null;
/** The preview the legend was last built from. */
let legendFor = null;
/** Smallest canvas to draw, so a collapsed panel cannot produce a zero-sized one. */
const MIN_CANVAS_WIDTH = 320;
const MIN_CANVAS_HEIGHT = 200;

/** One colour per region, used for the track stripe in the gutter. */
const REGION_COLORS = ['#c97962', '#c29a65', '#879b79', '#ad8971', '#c58f9c', '#7d9690', '#aa9161'];

/**
 * How many tiles of cell art stay in memory.
 *
 * A viewport is about eight tiles at the default cell size, so sixteen holds what is on
 * screen plus a little scroll room. Tiles hold nothing that cannot be redrawn from the
 * preview data, so the cache only has to be big enough to make a drag cheap.
 */
const TILE_LIMIT = 16;

/** Oldest first: the first key is the one to drop. */
const tileCache = new Map();
/** Which preview and which zoom the cache was built for. */
let tileOwner = null;
let tileSignature = '';
/** Counters for previewDiagnostics, which the interface check reads. */
let tileBuilds = 0;
let lastDrawMs = 0;

/**
 * Non-empty cell counts, cached per preview result.
 *
 * The counts never change for a preview, and counting a 2000 x 800 grid on every frame
 * costs more than drawing the visible part of it.
 */
const previewCountCache = new WeakMap();

function previewCounts(preview) {
  let counts = previewCountCache.get(preview);
  if (counts) return counts;
  counts = { wire: 0, base: 0, notes: 0 };
  for (const cell of preview.wireCells) if (cell) counts.wire += 1;
  for (const cell of preview.baseCells) if (cell) counts.base += 1;
  for (const cell of preview.noteCells) if (cell) counts.notes += 1;
  previewCountCache.set(preview, counts);
  return counts;
}

/** Which region a Z row belongs to (regions share the preview's coordinate space). */
function regionOfRow(res, z) {
  for (let i = 0; i < res.regions.length; i++) {
    const r = res.regions[i];
    if (z >= r.position.z && z < r.position.z + r.size.z) return i;
  }
  return -1;
}

/** Set an element's text only when it actually changes, so a drag does not touch the DOM. */
function setText(element, text) {
  if (element && element.textContent !== text) element.textContent = text;
}

/** Draw one line of text centred on (cx, cy). */
function label(ctx, text, cx, cy, color, font) {
  ctx.fillStyle = color;
  ctx.font = font;
  ctx.fillText(text, cx - ctx.measureText(text).width / 2, cy);
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function fillRoundedRect(ctx, x, y, width, height, radius, fill, stroke) {
  roundedRect(ctx, x, y, width, height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

/**
 * A hard one-pixel lip under a block instead of a blurred drop shadow.
 *
 * The shadow used to be a real shadowBlur per block, which is the most expensive call in
 * the whole pass and has to be repeated for every cell of every tile. The lip reads the
 * same at these sizes and costs one fill.
 */
function drawTileLip(ctx, x, y, width, height, radius) {
  fillRoundedRect(ctx, x, y + 1, width, height, radius, 'rgba(75, 61, 49, 0.13)');
}

/** The Z row with the most note blocks; usually the main line of a track. */
function mainRowOf(preview) {
  const width = preview.size.x;
  if (!width) return 0;
  let bestRow = 0;
  let bestCount = 0;
  for (let row = 0; row < preview.size.z; row += 1) {
    let count = 0;
    for (let col = 0; col < width; col += 1) {
      if (preview.noteCells[row * width + col]) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      bestRow = row;
    }
  }
  return bestRow;
}

/**
 * Draw the blocks of one rectangle of the grid.
 *
 * px and pz map a cell to whatever coordinate system is being drawn in, so the same code
 * fills a cached tile (which uses cell space) and would still fill the canvas directly.
 */
function drawCells(ctx, options) {
  const { preview, x, z, gx0, gz0, gx1, gz1, cell, gap, detail, showNotes, showGrid, px, pz } = options;

  // Base blocks: a faint wash so the material underneath is still readable.
  for (let gz = gz0; gz < gz1; gz += 1) {
    for (let gx = gx0; gx < gx1; gx += 1) {
      const base = preview.baseCells[gz * x + gx];
      if (!base) continue;
      ctx.globalAlpha = base.includes('command_block') ? 1 : 0.22;
      ctx.fillStyle = colorOf(base, preview);
      ctx.fillRect(px(gx), pz(gz), cell, cell);
      ctx.globalAlpha = 1;
      if (base.includes('command_block') && detail) {
        const kind =
          base === 'minecraft:repeating_command_block' ? 'R' : base === 'minecraft:command_block' ? 'I' : 'C';
        label(ctx, kind, px(gx) + cell / 2, pz(gz) + cell / 2, '#ffffff', 'bold 11px system-ui');
      }
    }
  }

  // Dust: light node cards joined by connector lines, rather than a thick red line that
  // is impossible to trace.
  const wireAt = (gx, gz) =>
    gx >= 0 && gx < x && gz >= 0 && gz < z
      ? preview.wireCells[gz * x + gx] === 'minecraft:redstone_wire'
      : false;
  const linkAt = (gx, gz) => {
    if (gx < 0 || gx >= x || gz < 0 || gz >= z) return false;
    const b = preview.wireCells[gz * x + gx] || preview.noteCells[gz * x + gx];
    return (
      b === 'minecraft:redstone_wire' ||
      b === 'minecraft:repeater' ||
      b === 'minecraft:note_block' ||
      b === 'minecraft:stone'
    );
  };
  const linkDirections = (gx, gz) => ({
    left: linkAt(gx - 1, gz),
    right: linkAt(gx + 1, gz),
    up: linkAt(gx, gz - 1),
    down: linkAt(gx, gz + 1),
  });
  const dustPlain = dustSizes(cell, false);
  const dustBranch = dustSizes(cell, true);
  ctx.strokeStyle = '#c74e4a';
  ctx.lineWidth = dustPlain.stroke;
  ctx.lineCap = 'round';
  for (let gz = gz0; gz < gz1; gz += 1) {
    for (let gx = gx0; gx < gx1; gx += 1) {
      if (!wireAt(gx, gz)) continue;
      if (!detail) {
        ctx.fillStyle = '#c74e4a';
        ctx.fillRect(px(gx), pz(gz), cell - gap, cell - gap);
        continue;
      }
      const cx = px(gx) + cell / 2;
      const cy = pz(gz) + cell / 2;
      const directions = linkDirections(gx, gz);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      if (directions.right) ctx.lineTo(px(gx + 1) + cell / 2, cy);
      if (directions.left) {
        ctx.moveTo(cx, cy);
        ctx.lineTo(px(gx - 1) + cell / 2, cy);
      }
      if (directions.up) {
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx, pz(gz - 1) + cell / 2);
      }
      if (directions.down) {
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx, pz(gz + 1) + cell / 2);
      }
      ctx.stroke();

      const degree = Object.values(directions).filter(Boolean).length;
      const node = degree > 2 ? dustBranch : dustPlain;
      ctx.fillStyle = '#fff8f5';
      ctx.beginPath();
      ctx.arc(cx, cy, node.haloRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#bf4744';
      ctx.beginPath();
      ctx.arc(cx, cy, node.nodeRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Repeaters: drawn as a clear input -> delay -> output module so direction and delay
  // setting are readable at a glance.
  for (let gz = gz0; gz < gz1; gz += 1) {
    for (let gx = gx0; gx < gx1; gx += 1) {
      if (preview.wireCells[gz * x + gx] !== 'minecraft:repeater') continue;
      const x0 = px(gx);
      const y0 = pz(gz);
      if (!detail) {
        ctx.fillStyle = '#777975';
        ctx.fillRect(x0, y0, cell - gap, cell - gap);
        continue;
      }
      const cx = x0 + cell / 2;
      const cy = y0 + cell / 2;
      const repeater = repeaterSizes(cell);
      const { inset, radius } = repeater;

      drawTileLip(ctx, x0 + inset, y0 + inset, cell - inset * 2, cell - inset * 2, radius);
      fillRoundedRect(
        ctx,
        x0 + inset,
        y0 + inset,
        cell - inset * 2,
        cell - inset * 2,
        radius,
        '#e1e1de',
        '#a3a19b',
      );

      const facing = (preview.repeaterFacings || [])[gz * x + gx] || 'west';
      const rotation = { west: 0, north: Math.PI / 2, east: Math.PI, south: -Math.PI / 2 }[facing] || 0;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rotation);
      ctx.translate(-cx, -cy);
      // Input and output terminals
      ctx.fillStyle = '#bd4d49';
      ctx.beginPath();
      ctx.arc(x0 + repeater.terminalOffset, cy, repeater.terminalRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e88962';
      ctx.beginPath();
      ctx.arc(x0 + cell - repeater.terminalOffset, cy, repeater.terminalRadius, 0, Math.PI * 2);
      ctx.fill();

      // Centre track and arrow
      ctx.strokeStyle = '#8e8b84';
      ctx.lineWidth = repeater.centerStroke;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0 + cell * 0.28, cy);
      ctx.lineTo(x0 + cell * 0.68, cy);
      ctx.stroke();
      ctx.fillStyle = '#68655f';
      ctx.beginPath();
      ctx.moveTo(x0 + cell * 0.76, cy);
      ctx.lineTo(x0 + cell * 0.65, cy - cell * 0.11);
      ctx.lineTo(x0 + cell * 0.65, cy + cell * 0.11);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      const delay = (preview.repeaterDelays || [])[gz * x + gx] || '';
      if (delay && repeater.showBadge) {
        const top = y0 + Math.max(2, cell * 0.05);
        fillRoundedRect(
          ctx,
          cx - repeater.badgeWidth / 2,
          top,
          repeater.badgeWidth,
          repeater.badgeHeight,
          repeater.badgeRadius,
          '#6c6860',
          '#4f4b45',
        );
        ctx.lineWidth = 1;
        label(
          ctx,
          delay + 't',
          cx,
          top + repeater.badgeHeight / 2,
          '#fffaf2',
          'bold ' + repeater.badgeFont + 'px ui-monospace, monospace',
        );
      }
    }
  }

  // Note blocks: wooden body, clear note glyph and a timbre stripe along the bottom.
  if (showNotes) {
    for (let gz = gz0; gz < gz1; gz += 1) {
      for (let gx = gx0; gx < gx1; gx += 1) {
        const idx = gz * x + gx;
        if (preview.noteCells[idx] !== 'minecraft:note_block') continue;
        const x0 = px(gx);
        const y0 = pz(gz);
        if (!detail) {
          ctx.fillStyle = '#a86839';
          ctx.fillRect(x0, y0, cell - gap, cell - gap);
          continue;
        }
        const cx = x0 + cell / 2;
        const cy = y0 + cell / 2 + 2;
        const note = noteBlockSizes(cell);
        const { inset, radius } = note;

        drawTileLip(ctx, x0 + inset, y0 + inset, cell - inset * 2, cell - inset * 2, radius);
        fillRoundedRect(
          ctx,
          x0 + inset,
          y0 + inset,
          cell - inset * 2,
          cell - inset * 2,
          radius,
          '#a86839',
          '#70401f',
        );

        // Grain stripes, so it reads clearly as something other than dust or a repeater.
        ctx.fillStyle = 'rgba(255, 232, 193, 0.32)';
        ctx.fillRect(x0 + inset + 2, y0 + inset + 3, cell - inset * 2 - 4, note.grain);
        ctx.fillStyle = 'rgba(65, 31, 13, 0.24)';
        ctx.fillRect(x0 + inset + 2, y0 + cell - inset - note.grainInset, cell - inset * 2 - 4, note.grain);

        // Note glyph
        ctx.fillStyle = '#fff6e7';
        ctx.fillRect(cx + cell * 0.02, cy - note.stem * 0.9, note.stemWidth, note.stem);
        ctx.fillRect(cx + cell * 0.02, cy - note.stem * 0.9, note.headOffset, note.stemWidth);
        ctx.beginPath();
        ctx.ellipse(cx - cell * 0.11, cy + cell * 0.12, note.head, note.head * 0.78, -0.2, 0, Math.PI * 2);
        ctx.fill();

        // The bottom stripe shows the block under the note block, which is its timbre.
        const base = preview.baseCells[idx];
        const toneColor = base ? colorOf(base, preview) : '#d7d2c8';
        fillRoundedRect(
          ctx,
          x0 + inset + note.stripeInset,
          y0 + cell - inset - note.stripeHeight,
          cell - inset * 2 - note.stripeInset * 2,
          note.stripeHeight,
          note.stripeRadius,
          toneColor,
          'rgba(50, 27, 13, 0.35)',
        );
      }
    }
  }

  if (showGrid) {
    ctx.strokeStyle = 'rgba(103, 97, 86, 0.14)';
    ctx.lineWidth = 1;
    for (let gx = gx0; gx <= gx1; gx += 1) {
      ctx.beginPath();
      ctx.moveTo(px(gx) + 0.5, pz(gz0));
      ctx.lineTo(px(gx) + 0.5, pz(gz1));
      ctx.stroke();
    }
    for (let gz = gz0; gz <= gz1; gz += 1) {
      ctx.beginPath();
      ctx.moveTo(px(gx0), pz(gz) + 0.5);
      ctx.lineTo(px(gx1), pz(gz) + 0.5);
      ctx.stroke();
    }
  }
}

/**
 * Canvas padding is read once per element instead of twice per frame.
 *
 * getComputedStyle forces a style recalculation, and renderPreview runs on every frame of
 * a drag, so asking for four padding values each time was measurable.
 */
const viewportInsets = new WeakMap();

function viewportSize(wrap) {
  let size = viewportInsets.get(wrap);
  if (!size) {
    const box = getComputedStyle(wrap);
    const inset = (side) => Number.parseFloat(box[side]) || 0;
    size = {
      left: inset('paddingLeft'),
      right: inset('paddingRight'),
      top: inset('paddingTop'),
      bottom: inset('paddingBottom'),
    };
    viewportInsets.set(wrap, size);
  }
  return {
    width: Math.max(MIN_CANVAS_WIDTH, wrap.clientWidth - size.left - size.right),
    height: Math.max(MIN_CANVAS_HEIGHT, wrap.clientHeight - size.top - size.bottom),
  };
}

/**
 * Draw one tile of cell art into its own canvas.
 *
 * Tiles are drawn in cell space starting at the tile's own corner, so the same tile can be
 * reused wherever the viewport puts it. This is the whole point of the cache: a drag
 * shifts existing tiles and only builds the ones scrolling in.
 */
function tileArt(preview, tile, art) {
  const { cell, scale, deviceSize, detail, gap, showNotes, showGrid, x, z } = art;
  const canvas = document.createElement('canvas');
  canvas.width = deviceSize;
  canvas.height = deviceSize;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, -tile.x0 * cell * scale, -tile.z0 * cell * scale);
  ctx.beginPath();
  ctx.rect(tile.x0 * cell, tile.z0 * cell, (tile.x1 - tile.x0) * cell, (tile.z1 - tile.z0) * cell);
  ctx.clip();
  ctx.textBaseline = 'middle';
  drawCells(ctx, {
    preview,
    x,
    z,
    gx0: tile.x0,
    gz0: tile.z0,
    gx1: tile.x1,
    gz1: tile.z1,
    cell,
    gap,
    detail,
    showNotes,
    showGrid,
    px: (gx) => gx * cell,
    pz: (gz) => gz * cell,
  });
  return canvas;
}

/**
 * Circuit preview: **one row is one real Z row**, one column is one X cell (time runs
 * to the right). Dust is drawn as lines; a repeater is drawn like the real block (a
 * slab with a torch at each end and an arrow) with its delay setting above it; a note
 * block is drawn as a note block, with the block underneath shown in its corner.
 *
 * Blocks are drawn into cached tiles and composited with a fractional offset, so a drag
 * moves the picture instead of redrawing it. Only the ruler, the gutter and the selection
 * ring are drawn per frame.
 */
function renderPreview(res) {
  const canvas = $('canvas');
  const hint = $('previewHint');
  const wrap = $('canvasWrap');
  const preview = res && res.preview;

  // Everything that redraws - panning, the locate button, the layer toggles - reads this
  // to know what it is drawing. It used to be assigned only by the previous renderer's
  // orchestrator, which this interface does not load, so it stayed undefined and every one
  // of those actions returned without doing anything: dragging and the wheel were dead.
  state.generated = res;
  $('previewDescription').textContent =
    res?.playbackMode === 'command'
      ? '命令播放器 · 立体结构俯视图'
      : '向右是时间，向下是不同音轨的空间排布。';

  if (!preview || preview.size.x === 0) {
    canvas.width = 0;
    canvas.height = 0;
    hint.textContent = '尚未生成电路。';
    $('legend').replaceChildren();
    legendFor = null;
    $('previewSize').textContent = '—';
    $('previewRegions').textContent = '—';
    $('previewTracks').textContent = '—';
    $('previewBlocks').textContent = '—';
    return;
  }

  const isNewResult = fittedFor !== res;
  if (isNewResult) {
    fittedFor = res;
    state.previewFocus = null;
  }
  state.previewScale = scaleForCell(READABLE_CELL);

  const { x, z } = preview.size;
  const dpr = window.devicePixelRatio || 1;
  const geometry = viewGeometry({ previewScale: state.previewScale });
  const { cell: CELL, detail, gap } = geometry;
  const showGrid = $('showGrid').checked;
  const showNotes = $('showNotes').checked;

  const { width: w, height: h } = viewportSize(wrap);
  const { cols, rows } = visibleCells({ viewportWidth: w, viewportHeight: h, cell: CELL });
  if (isNewResult) {
    // Open on the row that carries the most notes, which is the main line. A tall
    // fan-out otherwise opens on empty upper branches with the music below the fold.
    const focus = mainRowOf(preview);
    state.previewView = { x0: 0, z0: Math.max(0, focus - Math.floor(rows / 2)) };
  }
  const view = (state.previewView = clampView({ x, z }, state.previewView, { cols, rows }));
  const gridX0 = GUTTER;
  const gridY0 = RULER;

  // Assigning width/height reallocates and clears the backing buffer. During a drag the
  // viewport size is unchanged; only clearRect is needed.
  const pixelWidth = Math.round(w * dpr);
  const pixelHeight = Math.round(h * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  const ctx = canvas.getContext('2d');
  const started = performance.now();

  // Tiles are anchored to whole multiples of their own size in cells, so panning only
  // changes where they land, never what they contain. Anything that changes what a cell
  // looks like invalidates all of them.
  const { span, tiles } = tilesForView({ view, width: w, height: h, cell: CELL, grid: { x, z } });
  const deviceSize = Math.max(1, Math.round(span * CELL * dpr));
  const scale = deviceSize / (span * CELL);
  const signature = [CELL, detail ? 1 : 0, gap, showNotes ? 1 : 0, showGrid ? 1 : 0, deviceSize, dpr].join(
    '|',
  );
  if (tileOwner !== preview || tileSignature !== signature) {
    tileCache.clear();
    tileOwner = preview;
    tileSignature = signature;
  }

  // Device pixel alignment: every tile lands on a whole pixel edge, so the seams between
  // them cannot show up as a half-lit column.
  const baseX = Math.round((gridX0 - view.x0 * CELL) * dpr);
  const baseY = Math.round((gridY0 - view.z0 * CELL) * dpr);
  const step = deviceSize / span;
  const art = { cell: CELL, span, scale, deviceSize, detail, gap, showNotes, showGrid, x, z };

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pixelWidth, pixelHeight);
  for (const tile of tiles) {
    const key = tile.tx + ',' + tile.tz;
    let image = tileCache.get(key);
    if (image) {
      // Refresh the insertion order so the least recently used tile is the one dropped.
      tileCache.delete(key);
      tileCache.set(key, image);
    } else {
      image = tileArt(preview, tile, art);
      tileBuilds += 1;
      tileCache.set(key, image);
      while (tileCache.size > TILE_LIMIT) {
        const oldest = tileCache.keys().next();
        if (oldest.done) break;
        tileCache.delete(oldest.value);
      }
    }
    ctx.drawImage(image, baseX + tile.tx * deviceSize, baseY + tile.tz * deviceSize);
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textBaseline = 'middle';

  // Cell coordinates are absolute; the viewport decides where they land on the canvas.
  // The offset stays fractional, which is what lets a short drag move the picture.
  const px = (gx) => (baseX + gx * step) / dpr;
  const pz = (gz) => (baseY + gz * step) / dpr;
  const { gx0, gz0, gx1, gz1 } = cellRangeForView({ view, width: w, height: h, cell: CELL, grid: { x, z } });

  // ── Top ruler (X is the time axis) ──
  ctx.fillStyle = HEAD_BG;
  ctx.fillRect(0, 0, w, RULER);
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = '#716d64';
  ctx.fillText(res.playbackMode === 'command' ? 'X（立体命令链）' : 'X →（时间）', 8, RULER / 2);
  // Label spacing follows the zoom: a fixed step collides when zoomed in and falls off
  // screen when zoomed out.
  const tickStep = CELL >= 26 ? 5 : CELL >= 12 ? 10 : CELL >= 6 ? 20 : 50;
  for (let gx = Math.floor(gx0 / tickStep) * tickStep; gx <= gx1; gx += tickStep) {
    const cx = px(gx);
    ctx.strokeStyle = '#c5c1b8';
    ctx.beginPath();
    ctx.moveTo(cx + 0.5, RULER - 6);
    ctx.lineTo(cx + 0.5, RULER);
    ctx.stroke();
    ctx.fillStyle = '#716d64';
    ctx.fillText(String(gx), cx + 3, RULER / 2 - 1);
  }

  // ── Left gutter (Z row and its track) ──
  ctx.fillStyle = HEAD_BG;
  ctx.fillRect(0, 0, GUTTER, h);
  const trackOf = new Map();
  for (const t of res.tracks || []) trackOf.set(t.index, t);
  const zStep = Math.max(1, Math.ceil(13 / CELL));
  for (let gz = gz0; gz < gz1; gz += 1) {
    const y = pz(gz);
    const absoluteZ = gz + preview.origin.z;
    const ri = regionOfRow(res, absoluteZ);
    const region = ri >= 0 ? res.regions[ri] : null;
    const color = ri >= 0 ? REGION_COLORS[ri % REGION_COLORS.length] : 'rgba(255,255,255,0.12)';

    // Give a whole region's rows the same coloured stripe so it is obvious which rows
    // belong to the same track.
    ctx.fillStyle = color;
    ctx.fillRect(0, y, 3, CELL);
    // Row labels only where there is room. A fixed 11 px font on a four-pixel row piles
    // every number on top of the next, so below roughly 13 px per row only every
    // step-th row is labelled.
    const onStep = (gz - gz0) % zStep === 0;
    const regionTop = region ? region.position.z : Number.POSITIVE_INFINITY;
    // A track's name takes the first stepped row inside its region and replaces that
    // row's number, so the two labels can never land on the same line.
    if (region && onStep && absoluteZ >= regionTop && absoluteZ - regionTop < zStep) {
      const t = trackOf.get(region.trackIndex);
      const name =
        res.playbackMode === 'command'
          ? '命令播放器'
          : region.trackIndex < 0
            ? '合并主线'
            : t
              ? '轨' + (region.trackIndex + 1) + ' ' + t.instrument
              : '轨' + (region.trackIndex + 1);
      ctx.fillStyle = '#4d4a44';
      ctx.font = '12px system-ui, sans-serif';
      // Leave the number column clear: the gutter is 150 px and the number sits at 116.
      const room = 14;
      ctx.fillText(name.length > room ? name.slice(0, room - 1) + '…' : name, 10, y + CELL / 2);
    } else if (onStep) {
      ctx.fillStyle = '#8d887f';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('z' + gz, GUTTER - 34, y + CELL / 2);
    }
  }

  // Gutter and ruler borders
  ctx.strokeStyle = '#c1bdb4';
  ctx.beginPath();
  ctx.moveTo(gridX0 + 0.5, 0);
  ctx.lineTo(gridX0 + 0.5, h);
  ctx.moveTo(0, gridY0 + 0.5);
  ctx.lineTo(w, gridY0 + 0.5);
  ctx.stroke();

  // Ring the cell a warning was jumped to, so the eye lands on it straight away.
  if (state.previewFocus) {
    const { x: fx, z: fz } = state.previewFocus;
    if (fx >= gx0 && fx < gx1 && fz >= gz0 && fz < gz1) {
      ctx.strokeStyle = '#a35f35';
      ctx.lineWidth = 2;
      ctx.strokeRect(px(fx) + 1, pz(fz) + 1, CELL - 2, CELL - 2);
      ctx.lineWidth = 1;
    }
  }

  const counts = previewCounts(preview);
  const nonEmpty = counts.wire + counts.base + (showNotes ? counts.notes : 0);
  const trackCount = res.stats?.outputTrackCount ?? (res.tracks || []).filter((t) => t.noteCount > 0).length;
  setText($('previewSize'), x + ' × ' + z);
  setText($('previewRegions'), String((res.regions || []).length));
  setText($('previewTracks'), String(trackCount));
  setText($('previewBlocks'), String(nonEmpty));
  // Where the viewport currently sits, since the whole grid is no longer on screen.
  const visible =
    '视口 X ' +
    gx0 +
    '–' +
    Math.max(gx0, gx1 - 1) +
    ' / Z ' +
    gz0 +
    '–' +
    Math.max(gz0, gz1 - 1) +
    '　·　一格 ' +
    CELL.toFixed(CELL < 10 ? 1 : 0) +
    ' px';
  const hintText =
    res.playbackMode === 'command'
      ? res.regions[0].size.x +
        '×' +
        res.regions[0].size.y +
        '×' +
        res.regions[0].size.z +
        ' 格 · 命令播放器 · 俯视图　·　' +
        visible
      : '一行 = 一个 Z 行，一列 = 一格 X（向右为时间）　·　' +
        x +
        '×' +
        z +
        ' 格　·　' +
        trackCount +
        ' 条音轨 / ' +
        (res.regions || []).length +
        ' 个区域　·　可见方块 ' +
        nonEmpty +
        ' 个　·　' +
        visible;
  setText(hint, hintText);

  // Legend: only rebuilt when the song changes, so a drag does not churn the DOM.
  if (legendFor !== preview) {
    legendFor = preview;
    const legend = $('legend');
    legend.replaceChildren();
    for (const block of preview.blocks) {
      const item = create('span');
      const sw = create('i');
      sw.style.background = colorOf(block, preview);
      item.append(sw, document.createTextNode(displayBlockName(block)));
      legend.append(item);
    }
    if (res.playbackMode !== 'command') {
      legend.append(create('span', 'legend-note', '红石线 · 中继器档位 · 音符盒底色代表音色'));
    }
  }

  lastDrawMs = performance.now() - started;

  // The interface draws a position indicator. It cannot poll for this, and the drawing
  // module should not know about it, so the change is announced instead.
  document.dispatchEvent(new CustomEvent('preview:drawn'));
}

/** Scroll the view by a pixel offset, which is what a wheel or drag produces. */
function panPreview(pixelsX, pixelsZ) {
  if (!state.generated) return;
  const { cell } = viewGeometry({ previewScale: state.previewScale });
  state.previewView = {
    x0: state.previewView.x0 + pixelsX / cell,
    z0: state.previewView.z0 + pixelsZ / cell,
  };
  state.previewFocus = null;
  renderPreview(state.generated);
}

/** Put a given cell in the middle of the view; the warning list uses this. */
function focusPreviewCell(x, z) {
  const wrap = $('canvasWrap');
  // Being sent to a cell you cannot see is no use, so a jump never lands below the size
  // at which the cell is actually drawn rather than filled flat.
  state.previewScale = scaleForCell(Math.max(cellForScale(state.previewScale), DETAIL_MIN_CELL));
  const geometry = viewGeometry({ previewScale: state.previewScale });
  state.previewView = {
    x0: x - (wrap?.clientWidth ?? 0) / 2 / geometry.cell,
    z0: z - (wrap?.clientHeight ?? 0) / 2 / geometry.cell,
  };
  state.previewFocus = { x, z };
  if (state.generated) renderPreview(state.generated);
}

/**
 * Where the view sits, for the position indicator the interface draws.
 *
 * Returns null before anything has been drawn, so the caller can hide the track rather
 * than show a thumb at a position that means nothing yet.
 */
function previewPosition() {
  const previewData = state.generated?.preview;
  const wrap = document.getElementById('canvasWrap');
  if (!previewData?.size?.x || !wrap) return null;
  const { cell } = viewGeometry({ previewScale: state.previewScale });
  const usable = Math.max(cell, wrap.clientWidth - GUTTER);
  return {
    x0: Math.max(0, state.previewView?.x0 ?? 0),
    columns: Math.max(1, Math.floor(usable / cell)),
    total: previewData.size.x,
    cell,
  };
}

/**
 * Counters for the interface check.
 *
 * Redrawing the whole circuit on every drag frame is what made dragging feel heavy; the
 * check reads these numbers to prove a pan reuses the tiles instead of rebuilding them.
 */
function previewDiagnostics() {
  return {
    tiles: tileCache.size,
    builds: tileBuilds,
    lastDrawMs,
    view: { x0: state.previewView?.x0 ?? 0, z0: state.previewView?.z0 ?? 0 },
  };
}

export { renderPreview, panPreview, focusPreviewCell, previewPosition, previewDiagnostics };
