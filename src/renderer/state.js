const api = window.musicbox;

const $ = (id) => document.getElementById(id);

const state = {
  analyze: null,
  generated: null,
  previewScale: 1,
  /** Top-left cell shown by the wiring view; the canvas itself is only viewport-sized. */
  previewView: { x0: 0, z0: 0 },
  /** Cell to ring, set when a warning is jumped to and cleared on the next pan or zoom. */
  previewFocus: null,
};

export { api, $, state };
