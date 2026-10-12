import { $ } from './state.js';
import { create } from './dom.js';
import { shortName } from './blocks.js';

function renderTrackList(analyze) {
  const box = $('trackList');
  box.replaceChildren();

  const withNotes = analyze.tracks.filter((t) => t.noteCount > 0);
  if (withNotes.length === 0) {
    box.append(create('p', 'hint', '没有含音符的轨。'));
    return;
  }

  for (const t of withNotes) {
    const row = create('div', 'trackrow');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.index = String(t.index);
    cb.id = `trk-${t.index}`;

    const label = create('label', 'tname');
    label.htmlFor = cb.id;
    label.textContent = `${t.index}: ${t.name || shortName(t.instrument) || '(无名)'}`;

    const meta = create('span', 'tmeta', String(t.noteCount));
    row.append(cb, label, meta);
    box.append(row);
  }
}

export { renderTrackList };
