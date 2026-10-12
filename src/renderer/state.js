const api = window.musicbox;

const $ = (id) => document.getElementById(id);

const state = {
  analyze: null,
  generated: null,
  busy: false,
  previewScale: 1,
  previewRenderScale: 1,
};

export { api, $, state };
