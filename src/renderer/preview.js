import { $, state } from './state.js';
import { colorOf, displayBlockName } from './blocks.js';
import { create } from './dom.js';

const BASE_CELL = 38;
/** Width of the left gutter, which shows the Z row and its track. */
const GUTTER = 150;
/** Height of the top ruler (X is the time axis). */
const RULER = 28;
/** Background of the gutter and ruler. */
const HEAD_BG = '#e9e7e2';
/** Chromium caps canvas dimensions, so leave headroom for long songs. */
const MAX_CANVAS_PIXELS = 30000;
const MAX_CANVAS_AREA = 16000000;
/** Narrowest CSS width the preview canvas may be compressed to. */
const MIN_CANVAS_CSS_WIDTH = 640;
/** Zoom bounds for the manual zoom buttons. */
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 1.8;
/** Ceiling for "fit to window", which should not zoom in as far as the buttons. */
const ZOOM_FIT_MAX = 1.35;
/** Smallest viewport the fit calculation will consider, and the margin it leaves. */
const MIN_FIT_WIDTH = 320;
const MIN_FIT_HEIGHT = 220;
const FIT_PADDING = 40;
/** Below this the zoom label is reporting the render scale, not the user's setting. */
const ZOOM_LABEL_EPSILON = 0.005;

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

  const { x, z } = preview.size;
  const dpr = window.devicePixelRatio || 1;
  const maxCssWidth = Math.max(MIN_CANVAS_CSS_WIDTH, MAX_CANVAS_PIXELS / Math.max(1, dpr));
  const dimensionCell = Math.min(
    (maxCssWidth - GUTTER) / Math.max(1, x),
    (maxCssWidth - RULER) / Math.max(1, z),
  );
  // Include fixed headers in the area budget, not just the circuit rectangle.
  const cssArea = MAX_CANVAS_AREA / (dpr * dpr);
  const areaB = GUTTER * z + RULER * x;
  const areaCell =
    (2 * Math.max(1, cssArea - GUTTER * RULER)) /
    (areaB + Math.sqrt(areaB * areaB + 4 * x * z * Math.max(1, cssArea - GUTTER * RULER)));
  const requestedCell = BASE_CELL * state.previewScale;
  // Scale long songs down to a safe canvas size; past Chromium's dimension cap the
  // whole canvas renders blank.
  const CELL = Math.min(requestedCell, dimensionCell, areaCell);
  const renderScale = CELL / BASE_CELL;
  state.previewRenderScale = renderScale;
  const showGrid = $('showGrid').checked;
  const showNotes = $('showNotes').checked;
  const w = GUTTER + x * CELL;
  const h = RULER + z * CELL;
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

  const px = (gx) => gridX0 + gx * CELL;
  const pz = (gz) => gridY0 + gz * CELL;

  // ── Top ruler (X is the time axis) ──
  ctx.fillStyle = HEAD_BG;
  ctx.fillRect(0, 0, w, RULER);
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = '#716d64';
  ctx.fillText(res.playbackMode === 'command' ? 'X（立体命令链）' : 'X →（时间）', 8, RULER / 2);
  const step = 10;
  for (let gx = 0; gx <= x; gx += step) {
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
  for (let gz = 0; gz < z; gz++) {
    const y = pz(gz);
    const absoluteZ = gz + preview.origin.z;
    const ri = regionOfRow(res, absoluteZ);
    const region = ri >= 0 ? res.regions[ri] : null;
    const color = ri >= 0 ? REGION_COLORS[ri % REGION_COLORS.length] : 'rgba(255,255,255,0.12)';

    // Give a whole region's rows the same coloured stripe so it is obvious which rows
    // belong to the same track.
    ctx.fillStyle = color;
    ctx.fillRect(0, y, 3, CELL);
    if (region && absoluteZ === region.position.z) {
      const t = trackOf.get(region.trackIndex);
      const label =
        res.playbackMode === 'command'
          ? '命令播放器'
          : t
            ? `轨${region.trackIndex + 1} ${t.instrument}`
            : `轨${region.trackIndex + 1}`;
      ctx.fillStyle = '#4d4a44';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(label.slice(0, 18), 10, y + CELL / 2);
    }
    ctx.fillStyle = '#8d887f';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(`z${gz}`, GUTTER - 34, y + CELL / 2);
  }

  // ── Cells ──
  // Base blocks: a faint wash so the material underneath is still readable.
  for (let gz = 0; gz < z; gz++) {
    for (let gx = 0; gx < x; gx++) {
      const base = preview.baseCells[gz * x + gx];
      if (!base) continue;
      ctx.globalAlpha = base.includes('command_block') ? 1 : 0.22;
      ctx.fillStyle = colorOf(base, preview);
      ctx.fillRect(px(gx), pz(gz), CELL, CELL);
      ctx.globalAlpha = 1;
      if (base.includes('command_block') && CELL >= 18) {
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
  const wireStroke = Math.max(3, CELL * 0.12);
  ctx.strokeStyle = '#c74e4a';
  ctx.lineWidth = wireStroke;
  ctx.lineCap = 'round';
  for (let gz = 0; gz < z; gz++) {
    for (let gx = 0; gx < x; gx++) {
      if (!wireAt(gx, gz)) continue;
      if (CELL < 8) {
        ctx.fillStyle = '#c74e4a';
        ctx.fillRect(px(gx), pz(gz), CELL, CELL);
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
      const nodeRadius = Math.max(3.5, CELL * (degree > 2 ? 0.11 : 0.09));
      ctx.fillStyle = '#fff8f5';
      ctx.beginPath();
      ctx.arc(cx, cy, nodeRadius + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#bf4744';
      ctx.beginPath();
      ctx.arc(cx, cy, nodeRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Repeaters: drawn as a clear input -> delay -> output module so direction and delay
  // setting are readable at a glance.
  for (let gz = 0; gz < z; gz++) {
    for (let gx = 0; gx < x; gx++) {
      if (preview.wireCells[gz * x + gx] !== 'minecraft:repeater') continue;
      const x0 = px(gx);
      const y0 = pz(gz);
      if (CELL < 8) {
        ctx.fillStyle = '#777975';
        ctx.fillRect(x0, y0, CELL, CELL);
        continue;
      }
      const cx = x0 + CELL / 2;
      const cy = y0 + CELL / 2;
      const inset = Math.max(3, CELL * 0.09);

      drawTileShadow(
        ctx,
        x0 + inset,
        y0 + inset,
        CELL - inset * 2,
        CELL - inset * 2,
        Math.max(4, CELL * 0.12),
      );
      fillRoundedRect(
        ctx,
        x0 + inset,
        y0 + inset,
        CELL - inset * 2,
        CELL - inset * 2,
        Math.max(4, CELL * 0.12),
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
      ctx.arc(x0 + Math.max(8, CELL * 0.19), cy, Math.max(3, CELL * 0.08), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e88962';
      ctx.beginPath();
      ctx.arc(x0 + CELL - Math.max(8, CELL * 0.19), cy, Math.max(3, CELL * 0.08), 0, Math.PI * 2);
      ctx.fill();

      // Centre track and arrow
      ctx.strokeStyle = '#8e8b84';
      ctx.lineWidth = Math.max(2, CELL * 0.055);
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
      if (delay) {
        const badgeWidth = Math.max(22, CELL * 0.62);
        const badgeHeight = Math.max(14, CELL * 0.34);
        fillRoundedRect(
          ctx,
          cx - badgeWidth / 2,
          y0 + Math.max(2, CELL * 0.05),
          badgeWidth,
          badgeHeight,
          badgeHeight / 2,
          '#6c6860',
          '#4f4b45',
        );
        ctx.lineWidth = 1;
        label(
          ctx,
          `${delay}t`,
          cx,
          y0 + badgeHeight / 2 + Math.max(2, CELL * 0.05),
          '#fffaf2',
          `bold ${Math.max(9, CELL * 0.22)}px ui-monospace, monospace`,
        );
      }
    }
  }

  // Note blocks: wooden body, clear note glyph and a timbre stripe along the bottom.
  if (showNotes) {
    for (let gz = 0; gz < z; gz++) {
      for (let gx = 0; gx < x; gx++) {
        const idx = gz * x + gx;
        if (preview.noteCells[idx] !== 'minecraft:note_block') continue;
        const x0 = px(gx);
        const y0 = pz(gz);
        if (CELL < 8) {
          ctx.fillStyle = '#a86839';
          ctx.fillRect(x0, y0, CELL, CELL);
          continue;
        }
        const cx = x0 + CELL / 2;
        const cy = y0 + CELL / 2 + 2;
        const inset = Math.max(3, CELL * 0.08);

        drawTileShadow(
          ctx,
          x0 + inset,
          y0 + inset,
          CELL - inset * 2,
          CELL - inset * 2,
          Math.max(4, CELL * 0.12),
        );
        fillRoundedRect(
          ctx,
          x0 + inset,
          y0 + inset,
          CELL - inset * 2,
          CELL - inset * 2,
          Math.max(4, CELL * 0.12),
          '#a86839',
          '#70401f',
        );

        // Grain stripes, so it reads clearly as something other than dust or a repeater.
        ctx.fillStyle = 'rgba(255, 232, 193, 0.32)';
        ctx.fillRect(x0 + inset + 2, y0 + inset + 3, CELL - inset * 2 - 4, Math.max(2, CELL * 0.07));
        ctx.fillStyle = 'rgba(65, 31, 13, 0.24)';
        ctx.fillRect(
          x0 + inset + 2,
          y0 + CELL - inset - Math.max(4, CELL * 0.13),
          CELL - inset * 2 - 4,
          Math.max(2, CELL * 0.07),
        );

        // Note glyph
        const noteStem = Math.max(9, CELL * 0.3);
        const noteHead = Math.max(4, CELL * 0.13);
        ctx.fillStyle = '#fff6e7';
        ctx.fillRect(cx + CELL * 0.02, cy - noteStem * 0.9, Math.max(2, CELL * 0.07), noteStem);
        ctx.fillRect(
          cx + CELL * 0.02,
          cy - noteStem * 0.9,
          Math.max(7, CELL * 0.22),
          Math.max(2, CELL * 0.07),
        );
        ctx.beginPath();
        ctx.ellipse(cx - CELL * 0.11, cy + CELL * 0.12, noteHead, noteHead * 0.78, -0.2, 0, Math.PI * 2);
        ctx.fill();

        // The bottom stripe shows the block under the note block, which is its timbre.
        const base = preview.baseCells[idx];
        const toneColor = base ? colorOf(base, preview) : '#d7d2c8';
        fillRoundedRect(
          ctx,
          x0 + inset + 3,
          y0 + CELL - inset - Math.max(7, CELL * 0.18),
          CELL - inset * 2 - 6,
          Math.max(7, CELL * 0.18),
          Math.max(2, CELL * 0.06),
          toneColor,
          'rgba(50, 27, 13, 0.35)',
        );
      }
    }
  }

  if (showGrid) {
    ctx.strokeStyle = 'rgba(103, 97, 86, 0.14)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= x; gx++) {
      ctx.beginPath();
      ctx.moveTo(px(gx) + 0.5, gridY0);
      ctx.lineTo(px(gx) + 0.5, h);
      ctx.stroke();
    }
    for (let gz = 0; gz <= z; gz++) {
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

  const nonEmpty =
    preview.wireCells.filter(Boolean).length +
    preview.baseCells.filter(Boolean).length +
    (showNotes ? preview.noteCells.filter(Boolean).length : 0);
  const trackCount = res.stats?.outputTrackCount ?? (res.tracks || []).filter((t) => t.noteCount > 0).length;
  $('previewSize').textContent = `${x} × ${z}`;
  $('previewRegions').textContent = String((res.regions || []).length);
  $('previewTracks').textContent = String(trackCount);
  $('previewBlocks').textContent = String(nonEmpty);
  hint.textContent =
    res.playbackMode === 'command'
      ? `${res.regions[0].size.x}×${res.regions[0].size.y}×${res.regions[0].size.z} 格 · 命令播放器 · 俯视图`
      : `一行 = 一个 Z 行，一列 = 一格 X（向右为时间）　·　${x}×${z} 格　·　` +
        `${trackCount} 条音轨 / ${(res.regions || []).length} 个区域　·　可见方块 ${nonEmpty} 个` +
        (renderScale < state.previewScale - ZOOM_LABEL_EPSILON ? '　·　长曲目已自动缩小预览' : '');

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

  wrap.scrollTop = 0;
  wrap.scrollLeft = 0;
  updatePreviewZoomLabel();
}

function updatePreviewZoomLabel() {
  const scale = state.generated ? state.previewRenderScale : state.previewScale;
  $('previewZoom').textContent = `${Math.round(scale * 100)}%`;
}

function setPreviewScale(scale) {
  state.previewScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
  updatePreviewZoomLabel();
  if (state.generated) renderPreview(state.generated);
}

function fitPreview() {
  const preview = state.generated?.preview;
  const wrap = $('canvasWrap');
  if (!preview || !preview.size?.x || !wrap) return;
  const availableWidth = Math.max(MIN_FIT_WIDTH, wrap.clientWidth - FIT_PADDING);
  const availableHeight = Math.max(MIN_FIT_HEIGHT, wrap.clientHeight - FIT_PADDING);
  const widthScale = availableWidth / (GUTTER + preview.size.x * BASE_CELL);
  const heightScale = availableHeight / (RULER + preview.size.z * BASE_CELL);
  setPreviewScale(Math.min(ZOOM_FIT_MAX, Math.max(ZOOM_MIN, Math.min(widthScale, heightScale))));
}

export { renderPreview, setPreviewScale, fitPreview };
