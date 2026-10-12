function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function create(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function kv(pairs) {
  const dl = create('dl', 'kv');
  for (const [k, v] of pairs) {
    if (v === undefined || v === null || v === '') continue;
    dl.append(create('dt', null, k), create('dd', null, String(v)));
  }
  return dl;
}

function table(headers, rows) {
  const t = create('table');
  const thead = create('thead');
  const hr = create('tr');
  for (const h of headers) {
    hr.append(
      create('th', typeof h === 'object' && h.num ? 'num' : null, typeof h === 'object' ? h.label : h),
    );
  }
  thead.append(hr);

  const tbody = create('tbody');
  for (const row of rows) {
    const tr = create('tr');
    for (const cell of row) {
      const numeric = typeof cell === 'number';
      tr.append(create('td', numeric ? 'num' : null, String(cell)));
    }
    tbody.append(tr);
  }
  t.append(thead, tbody);
  return t;
}

function card(title, ...children) {
  const c = create('div', 'card');
  if (title) c.append(create('h3', null, title));
  c.append(...children);
  return c;
}

export { fmtBytes, create, kv, table, card };
