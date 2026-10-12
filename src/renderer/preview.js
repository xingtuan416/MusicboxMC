import { $, state } from './state.js';
import { colorOf, displayBlockName } from './blocks.js';
import { create } from './dom.js';
import {
  cellForScale,
  clampView,
  DETAIL_MIN_CELL,
  dustSizes,
  fitCell,
  GUTTER,
  noteBlockSizes,
  repeaterSizes,
  RULER,
  scaleForCell,
  viewGeometry,
  visibleCells,
} from './previewGeometry.js';

/** Background of the gutter and ruler. */
const HEAD_BG = '#e9e7e2';
/** The result the view was last fitted to, so a new one re-fits instead of scrolling. */
let fittedFor = null;
/** Multiplicative zoom step: the range is far wider than the old fit-only zoom. */
const ZOOM_STEP = 1.3;
/** Smallest panel the fit calculation will consider, and the margin it leaves. */
const MIN_FIT_WIDTH = 320;
const MIN_FIT_HEIGHT = 220;
const FIT_PADDING = 24;
/** Smallest canvas to draw, so a collapsed panel cannot produce a zero-sized one. */
const MIN_CANVAS_WIDTH = 320;
const MIN_CANVAS_HEIGHT = 200;

/** One colour per region, used for the track stripe in the gutter. */
const REGION_COLORS = ['#c97962', '#c29a65', '#879b79', '#ad8971', '#c58f9c', '#7d9690', '#aa9161'];

/** Which region a Z row belongs to (regions share the preview's coordinate space). */
function regionOfRow(res, z) {
  for (let i = 0; i < res.regions.length; i++) {
    const r = res.regions[i];
    if (z >= r.position.z && z < r.position.z + r.size.z) return i;
  }
  return -1;
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

function drawTileShadow(ctx, x, y, width, height, radius) {
  ctx.save();
  ctx.shadowColor = 'rgba(75, 61, 49, 0.16)';
  ctx.shadowBlur = Math.max(2, width * 0.08);
  ctx.shadowOffsetY = Math.max(1, width * 0.035);
  fillRoundedRect(ctx, x, y, width, height, radius, '#fff');
  ctx.restore();
}

/**
 * Circuit preview: **one row is one real Z row**, one column is one X cell (time runs
 * to the right). Dust is drawn as lines; a repeater is drawn like the real block (a
 * slab with a torch at each end and an arrow) with its delay setting above it; a note
 * block is drawn as a note block, with the block underneath shown in its corner.
 */
function renderPreview(res) {
  const canvas = $('canvas');
  const hint = $('previewHint');
  const wrap = $('canvasWrap');
  const preview = res && res.preview;
  $('previewDescription').textContent =
    res?.playbackMode === 'command'
      ? '命令播放器 · 立体结构俯视图'
      : '向右是时间，向下是不同音轨的空间排布。';

  if (!preview || preview.size.x === 0) {
    canvas.width = 0;
    canvas.height = 0;
    state.previewRenderScale = 1;
    hint.textContent = '尚未生成电路。';
    $('legend').replaceChildren();
    $('previewSize').textContent = '—';
    $('previewRegions').textContent = '—';
    $('previewTracks').textContent = '—';
    $('previewBlocks').textContent = '—';
    updatePreviewZoomLabel();
    return;
  }

  if (fittedFor !== res) {
    fittedFor = res;
    // A new result: show as much of it as stays legible rather than the first sliver.
    state.previewScale = fitScaleFor(res);
    state.previewView = { x0: 0, z0: 0 };
    state.previewFocus = null;
  }

  const { x, z } = preview.size;
  const dpr = window.devicePixelRatio || 1;
  const geometry = viewGeometry({ previewScale: state.previewScale });
  const { cell: CELL, detail, gap } = geometry;
  state.previewRenderScale = geometry.renderScale;
  const showGrid = $('showGrid').checked;
  const showNotes = $('showNotes').checked;

  // The canvas is exactly the viewport and only the visible cells are drawn. Nothing is
  // solved against a canvas budget any more, so a long song no longer caps how far in
  // you can zoom, and the grid may extend well past the right and bottom edges.
  // The wrap has padding, and clientWidth/clientHeight include it; sizing the canvas to
  // those would overflow the padding box and reintroduce a scrollbar.
  const box = getComputedStyle(wrap);
  const inset = (side) => Number.parseFloat(box[side]) || 0;
  const viewportWidth = Math.max(
    MIN_CANVAS_WIDTH,
    wrap.clientWidth - inset('paddingLeft') - inset('paddingRight'),
  );
  const viewportHeight = Math.max(
    MIN_CANVAS_HEIGHT,
    wrap.clientHeight - inset('paddingTop') - inset('paddingBottom'),
  );
  const w = viewportWidth;
  const h = viewportHeight;
  const { cols, rows } = visibleCells({ viewportWidth, viewportHeight, cell: CELL });
  const view = (state.previewView = clampView({ x, z }, state.previewView, { cols, rows }));
  const gx0 = view.x0;
  const gz0 = view.z0;
  const gx1 = Math.min(x, gx0 + cols);
  const gz1 = Math.min(z, gz0 + rows);
  const gridX0 = GUTTER;
  const gridY0 = RULER;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = 'middle';

  // Cell coordinates are absolute; the viewport decides where they land on the canvas.
  const px = (gx) => gridX0 + (gx - gx0) * CELL;
  const pz = (gz) => gridY0 + (gz - gz0) * CELL;

  // ── Top ruler (X is the time axis) ──
  ctx.fillStyle = HEAD_BG;
  ctx.fillRect(0, 0, w, RULER);
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = '#716d64';
  ctx.fillText(res.playbackMode === 'command' ? 'X（立体命令链）' : 'X →（时间）', 8, RULER / 2);
  // Label spacing follows the zoom: a fixed step collides when zoomed in and falls off
  // screen when zoomed out.
  const step = CELL >= 26 ? 5 : CELL >= 12 ? 10 : CELL >= 6 ? 20 : 50;
  for (let gx = Math.floor(gx0 / step) * step; gx <= gx1; gx += step) {
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
  for (let gz = gz0; gz < gz1; gz++) {
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
    const zStep = Math.max(1, Math.ceil(13 / CELL));
    const onStep = (gz - gz0) % zStep === 0;
    const regionTop = region ? region.position.z : Number.POSITIVE_INFINITY;
    // A track's name takes the first stepped row inside its region and replaces that
    // row's number, so the two labels can never land on the same line.
    if (region && onStep && absoluteZ >= regionTop && absoluteZ - regionTop < zStep) {
      const t = trackOf.get(region.trackIndex);
      const label =
        res.playbackMode === 'command'
          ? '命令播放器'
          : t
            ? `轨${region.trackIndex + 1} ${t.instrument}`
            : `轨${region.trackIndex + 1}`;
      ctx.fillStyle = '#4d4a44';
      ctx.font = '12px system-ui, sans-serif';
      // Leave the number column clear: the gutter is 150 px and the number sits at 116.
      const room = 14;
      ctx.fillText(label.length > room ? `${label.slice(0, room - 1)}…` : label, 10, y + CELL / 2);
    } else if (onStep) {
      ctx.fillStyle = '#8d887f';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(`z${gz}`, GUTTER - 34, y + CELL / 2);
    }
  }

  // ── Cells ──
  // Base blocks: a faint wash so the material underneath is still readable.
  for (let gz = gz0; gz < gz1; gz++) {
    for (let gx = gx0; gx < gx1; gx++) {
      const base = preview.baseCells[gz * x + gx];
      if (!base) continue;
      ctx.globalAlpha = base.includes('command_block') ? 1 : 0.22;
      ctx.fillStyle = colorOf(base, preview);
      ctx.fillRect(px(gx), pz(gz), CELL, CELL);
      ctx.globalAlpha = 1;
      if (base.includes('command_block') && detail) {
        label(
          ctx,
          base === 'minecraft:repeating_command_block' ? 'R' : base === 'minecraft:command_block' ? 'I' : 'C',
          px(gx) + CELL / 2,
          pz(gz) + CELL / 2,
          '#ffffff',
          'bold 11px system-ui',
        );
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
  const dustPlain = dustSizes(CELL, false);
  const dustBranch = dustSizes(CELL, true);
  ctx.strokeStyle = '#c74e4a';
  ctx.lineWidth = dustPlain.stroke;
  ctx.lineCap = 'round';
  for (let gz = gz0; gz < gz1; gz++) {
    for (let gx = gx0; gx < gx1; gx++) {
      if (!wireAt(gx, gz)) continue;
      if (!detail) {
        ctx.fillStyle = '#c74e4a';
        ctx.fillRect(px(gx), pz(gz), CELL - gap, CELL - gap);
        continue;
      }
      const cx = px(gx) + CELL / 2;
      const cy = pz(gz) + CELL / 2;
      const directions = linkDirections(gx, gz);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      if (directions.right) ctx.lineTo(px(gx + 1) + CELL / 2, cy);
      if (directions.left) {
        ctx.moveTo(cx, cy);
        ctx.lineTo(px(gx - 1) + CELL / 2, cy);
      }
      if (directions.up) {
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx, pz(gz - 1) + CELL / 2);
      }
      if (directions.down) {
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx, pz(gz + 1) + CELL / 2);
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
  for (let gz = gz0; gz < gz1; gz++) {
    for (let gx = gx0; gx < gx1; gx++) {
      if (preview.wireCells[gz * x + gx] !== 'minecraft:repeater') continue;
      const x0 = px(gx);
      const y0 = pz(gz);
      if (!detail) {
        ctx.fillStyle = '#777975';
        ctx.fillRect(x0, y0, CELL - gap, CELL - gap);
        continue;
      }
      const cx = x0 + CELL / 2;
      const cy = y0 + CELL / 2;
      const repeater = repeaterSizes(CELL);
      const { inset, radius } = repeater;

      drawTileShadow(ctx, x0 + inset, y0 + inset, CELL - inset * 2, CELL - inset * 2, radius);
      fillRoundedRect(
        ctx,
        x0 + inset,
        y0 + inset,
        CELL - inset * 2,
        CELL - inset * 2,
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
      ctx.arc(x0 + CELL - repeater.terminalOffset, cy, repeater.terminalRadius, 0, Math.PI * 2);
      ctx.fill();

      // Centre track and arrow
      ctx.strokeStyle = '#8e8b84';
      ctx.lineWidth = repeater.centerStroke;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0 + CELL * 0.28, cy);
      ctx.lineTo(x0 + CELL * 0.68, cy);
      ctx.stroke();
      ctx.fillStyle = '#68655f';
      ctx.beginPath();
      ctx.moveTo(x0 + CELL * 0.76, cy);
      ctx.lineTo(x0 + CELL * 0.65, cy - CELL * 0.11);
      ctx.lineTo(x0 + CELL * 0.65, cy + CELL * 0.11);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      const delay = (preview.repeaterDelays || [])[gz * x + gx] || '';
      if (delay && repeater.showBadge) {
        const top = y0 + Math.max(2, CELL * 0.05);
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
          `${delay}t`,
          cx,
          top + repeater.badgeHeight / 2,
          '#fffaf2',
          `bold ${repeater.badgeFont}px ui-monospace, monospace`,
        );
      }
    }
  }

  // Note blocks: wooden body, clear note glyph and a timbre stripe along the bottom.
  if (showNotes) {
    for (let gz = gz0; gz < gz1; gz++) {
      for (let gx = gx0; gx < gx1; gx++) {
        const idx = gz * x + gx;
        if (preview.noteCells[idx] !== 'minecraft:note_block') continue;
        const x0 = px(gx);
        const y0 = pz(gz);
        if (!detail) {
          ctx.fillStyle = '#a86839';
          ctx.fillRect(x0, y0, CELL - gap, CELL - gap);
          continue;
        }
        const cx = x0 + CELL / 2;
        const cy = y0 + CELL / 2 + 2;
        const note = noteBlockSizes(CELL);
        const { inset, radius } = note;

        drawTileShadow(ctx, x0 + inset, y0 + inset, CELL - inset * 2, CELL - inset * 2, radius);
        fillRoundedRect(
          ctx,
          x0 + inset,
          y0 + inset,
          CELL - inset * 2,
          CELL - inset * 2,
          radius,
          '#a86839',
          '#70401f',
        );

        // Grain stripes, so it reads clearly as something other than dust or a repeater.
        ctx.fillStyle = 'rgba(255, 232, 193, 0.32)';
        ctx.fillRect(x0 + inset + 2, y0 + inset + 3, CELL - inset * 2 - 4, note.grain);
        ctx.fillStyle = 'rgba(65, 31, 13, 0.24)';
        ctx.fillRect(x0 + inset + 2, y0 + CELL - inset - note.grainInset, CELL - inset * 2 - 4, note.grain);

        // Note glyph
        ctx.fillStyle = '#fff6e7';
        ctx.fillRect(cx + CELL * 0.02, cy - note.stem * 0.9, note.stemWidth, note.stem);
        ctx.fillRect(cx + CELL * 0.02, cy - note.stem * 0.9, note.headOffset, note.stemWidth);
        ctx.beginPath();
        ctx.ellipse(cx - CELL * 0.11, cy + CELL * 0.12, note.head, note.head * 0.78, -0.2, 0, Math.PI * 2);
        ctx.fill();

        // The bottom stripe shows the block under the note block, which is its timbre.
        const base = preview.baseCells[idx];
        const toneColor = base ? colorOf(base, preview) : '#d7d2c8';
        fillRoundedRect(
          ctx,
          x0 + inset + note.stripeInset,
          y0 + CELL - inset - note.stripeHeight,
          CELL - inset * 2 - note.stripeInset * 2,
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
    for (let gx = gx0; gx <= gx1; gx++) {
      ctx.beginPath();
      ctx.moveTo(px(gx) + 0.5, gridY0);
      ctx.lineTo(px(gx) + 0.5, h);
      ctx.stroke();
    }
    for (let gz = gz0; gz <= gz1; gz++) {
      ctx.beginPath();
      ctx.moveTo(gridX0, pz(gz) + 0.5);
      ctx.lineTo(w, pz(gz) + 0.5);
      ctx.stroke();
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

  const nonEmpty =
    preview.wireCells.filter(Boolean).length +
    preview.baseCells.filter(Boolean).length +
    (showNotes ? preview.noteCells.filter(Boolean).length : 0);
  const trackCount = res.stats?.outputTrackCount ?? (res.tracks || []).filter((t) => t.noteCount > 0).length;
  $('previewSize').textContent = `${x} × ${z}`;
  $('previewRegions').textContent = String((res.regions || []).length);
  $('previewTracks').textContent = String(trackCount);
  $('previewBlocks').textContent = String(nonEmpty);
  // Where the viewport currently sits, since the whole grid is no longer on screen.
  const visible =
    `视口 X ${gx0}–${Math.max(gx0, gx1 - 1)} / Z ${gz0}–${Math.max(gz0, gz1 - 1)}　·　` +
    `一格 ${CELL.toFixed(CELL < 10 ? 1 : 0)} px`;
  hint.textContent =
    res.playbackMode === 'command'
      ? `${res.regions[0].size.x}×${res.regions[0].size.y}×${res.regions[0].size.z} 格 · 命令播放器 · 俯视图　·　${visible}`
      : `一行 = 一个 Z 行，一列 = 一格 X（向右为时间）　·　${x}×${z} 格　·　` +
        `${trackCount} 条音轨 / ${(res.regions || []).length} 个区域　·　可见方块 ${nonEmpty} 个　·　${visible}`;

  // Legend
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

  updatePreviewZoomLabel();
}

function updatePreviewZoomLabel() {
  $('previewZoom').textContent = `${Math.round(scaleForCell(cellForScale(state.previewScale)) * 100)}%`;
}

/** Scale at which as much of the grid as stays legible is visible. */
function fitScaleFor(res) {
  const preview = res?.preview;
  const wrap = $('canvasWrap');
  if (!preview || !preview.size?.x || !wrap) return state.previewScale;
  return scaleForCell(
    fitCell({
      x: preview.size.x,
      z: preview.size.z,
      availableWidth: Math.max(MIN_FIT_WIDTH, wrap.clientWidth - FIT_PADDING),
      availableHeight: Math.max(MIN_FIT_HEIGHT, wrap.clientHeight - FIT_PADDING),
    }),
  );
}

/** Zoom about the centre of the view, so what you are looking at stays where it is. */
function zoomPreview(factor) {
  const wrap = $('canvasWrap');
  const halfWidth = (wrap?.clientWidth ?? 0) / 2;
  const halfHeight = (wrap?.clientHeight ?? 0) / 2;
  const before = viewGeometry({ previewScale: state.previewScale });
  const centre = {
    x: state.previewView.x0 + halfWidth / before.cell,
    z: state.previewView.z0 + halfHeight / before.cell,
  };

  state.previewScale *= factor;
  const after = viewGeometry({ previewScale: state.previewScale });
  state.previewView = {
    x0: centre.x - halfWidth / after.cell,
    z0: centre.z - halfHeight / after.cell,
  };
  state.previewFocus = null;
  updatePreviewZoomLabel();
  if (state.generated) renderPreview(state.generated);
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

function fitPreview() {
  if (!state.generated) return;
  state.previewScale = fitScaleFor(state.generated);
  state.previewView = { x0: 0, z0: 0 };
  renderPreview(state.generated);
}

export { renderPreview, zoomPreview, panPreview, fitPreview, focusPreviewCell, ZOOM_STEP };
