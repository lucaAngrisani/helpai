/* global cytoscape */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const COLORS = { synced: '#27ae60', stale: '#e67e22', error: '#c0392b', never: '#7f8c8d', running: '#2980b9' };

let cy = null;
let selectedId = null;      // id della spec (es. "album/.helpai.md")
let selectedDir = '';       // cartella selezionata nell'explorer ('' = radice)
let selectedFile = null;    // file in sola lettura aperto nel dettaglio
let expanded = new Set(['']);
let es = null;
let runTask = 'spec-to-code';
let harnessOk = false;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

// ---- Viste -------------------------------------------------------------------
function showView(name) {
  $('view-config').classList.toggle('hidden', name !== 'config');
  $('workspace').classList.toggle('hidden', name !== 'project');
  $('setup').classList.add('hidden');
}

function showSetup(message = '') {
  $('setup').classList.remove('hidden');
  $('workspace').classList.add('hidden');
  $('view-config').classList.add('hidden');
  $('setup-error').textContent = message;
}

// ---- Configurazioni (harness Hermes) -----------------------------------------
async function loadHarness() {
  const cfg = await api('GET', '/api/config');
  harnessOk = !!cfg.harnessTestedOk;
  $('harness-command').value = cfg.harnessCommand || '';
  $('harness-status').textContent = harnessOk ? 'Harness verificato' : 'Harness non verificato: Spec→Code bloccato';
}

async function saveHarness() {
  try {
    await api('PUT', '/api/harness', { command: $('harness-command').value.trim() });
    await loadHarness();
  } catch (e) {
    $('harness-status').textContent = e.message;
  }
}

async function testHarness() {
  $('harness-status').textContent = 'Test in corso…';
  try {
    const r = await api('POST', '/api/harness/test');
    harnessOk = r.ok;
    $('harness-status').textContent = r.ok ? 'Harness verificato (risposta OK)' : `Test fallito (exit ${r.exitCode}): ${r.output || ''}`;
  } catch (e) {
    harnessOk = false;
    $('harness-status').textContent = e.message;
  }
}

$('btn-settings').onclick = async () => {
  await loadHarness();
  showView('config');
};
$('btn-back').onclick = () => showView('project');
$('btn-save-harness').onclick = saveHarness;
$('btn-test-harness').onclick = testHarness;

// ---- Configurazione progetto -------------------------------------------------
async function boot() {
  const cfg = await api('GET', '/api/config');
  await loadHarness();
  if (!cfg.configured) return showSetup();
  showView('project');
  await refresh();
}

$('btn-save-root').onclick = async () => {
  try {
    await api('PUT', '/api/config', { rootPath: $('root-input').value.trim() });
    $('setup-error').textContent = '';
    await boot();
  } catch (e) {
    $('setup-error').textContent = e.message;
  }
};

$('btn-change-root').onclick = async () => {
  const current = (await api('GET', '/api/config')).rootPath || '';
  $('root-input').value = current;
  showSetup();
};

// ---- Minimizzazione sezioni e explorer --------------------------------------
document.querySelectorAll('[data-hide]').forEach((btn) => {
  btn.onclick = () => {
    const sec = $(btn.dataset.hide);
    if (sec.id === 'explorer') return setExplorer(false);
    const collapsed = sec.classList.toggle('collapsed');
    btn.textContent = collapsed ? '▸' : '▾';
    if (sec.id === 'sec-graph') requestAnimationFrame(() => cy && cy.resize());
  };
});

function setExplorer(visible) {
  $('workspace').classList.toggle('no-explorer', !visible);
  $('btn-toggle-explorer').classList.toggle('active', visible);
  if (visible) requestAnimationFrame(() => cy && cy.resize());
}
$('btn-toggle-explorer').onclick = () => setExplorer($('workspace').classList.contains('no-explorer'));

// ---- Explorer ----------------------------------------------------------------
async function renderTree() {
  const rows = [];
  async function walk(dir, depth) {
    const data = await api('GET', `/api/fs/tree?dir=${encodeURIComponent(dir)}`);
    for (const d of data.dirs) {
      const open = expanded.has(d.rel);
      rows.push(`<div class="ex-row${selectedDir === d.rel ? ' sel' : ''}" style="padding-left:${6 + depth * 14}px" data-dir="${esc(d.rel)}">${open ? '▾' : '▸'} 📁 ${esc(d.name)}</div>`);
      if (open) await walk(d.rel, depth + 1);
    }
    for (const f of data.files) {
      const fileId = [dir, f.name].filter(Boolean).join('/');
      const pad = `padding-left:${6 + depth * 14 + 14}px`;
      if (f.spec) {
        rows.push(`<div class="ex-row spec${selectedId === fileId ? ' sel' : ''}" style="${pad}" data-spec="${esc(fileId)}">📄 ${esc(f.name)}</div>`);
      } else {
        rows.push(`<div class="ex-row plain${selectedFile === fileId ? ' sel' : ''}" style="${pad}" data-file="${esc(fileId)}" title="Sola lettura">${esc(f.name)}<span class="ro-badge">RO</span></div>`);
      }
    }
  }
  await walk('', 0);
  $('tree').innerHTML = rows.join('') || '<p class="muted">Nessuna cartella.</p>';
  $('tree').querySelectorAll('[data-dir]').forEach((el) => {
    el.onclick = () => onDirClick(el.dataset.dir);
  });
  $('tree').querySelectorAll('[data-spec]').forEach((el) => {
    el.onclick = () => { selectedFile = null; showDetail(el.dataset.spec); };
  });
  $('tree').querySelectorAll('[data-file]').forEach((el) => {
    el.onclick = () => { selectedFile = el.dataset.file; showFile(el.dataset.file); };
  });
  await updateNewSpecButton();
}

function onDirClick(dir) {
  selectedDir = dir;
  if (expanded.has(dir)) expanded.delete(dir); else expanded.add(dir);
  renderTree();
}

async function updateNewSpecButton() {
  const btn = $('btn-new-spec');
  $('ex-selected').textContent = selectedDir ? `📁 ${selectedDir}` : '📁 radice';
  const data = await api('GET', `/api/fs/tree?dir=${encodeURIComponent(selectedDir)}`);
  btn.disabled = data.hasSpec;
  btn.title = data.hasSpec ? 'Questa cartella ha già uno .helpai.md' : 'Crea uno .helpai.md in questa cartella';
}

$('btn-new-spec').onclick = async () => {
  $('ex-msg').textContent = '';
  try {
    const res = await api('POST', '/api/fs/spec', { dir: selectedDir });
    await api('POST', '/api/project/rescan');
    $('ex-msg').textContent = `creato ${res.specRel}`;
    expanded.add(selectedDir);
    await refresh();
    await showDetail(res.specRel);
  } catch (e) {
    $('ex-msg').textContent = e.message;
  }
};

// ---- Stato progetto, errori, grafo ------------------------------------------
async function refresh() {
  let data;
  try {
    data = await api('GET', '/api/project');
  } catch (e) {
    if (e.status === 409) return showSetup();
    throw e;
  }
  $('root-label').textContent = data.rootPath;
  const c = data.counts;
  $('counters').textContent = `spec ${c.total} · sincronizzate ${c.synced} · stale ${c.stale} · errori ${c.error} · mai allineate ${c.never}`;
  renderErrors(data.errors);
  $('graph-empty').classList.toggle('hidden', data.nodes.length > 0);
  renderGraph(data);
  await renderTree();
  if (selectedId) await showDetail(selectedId, true);
}

function renderErrors(errors) {
  const sec = $('sec-errors');
  if (!errors.length) return sec.classList.add('hidden');
  sec.classList.remove('hidden');
  $('errors').innerHTML =
    `<strong>Errori (${errors.length})</strong><ul>` +
    errors.map((e) => `<li><code>${esc(e.code)}</code> — ${esc(e.message)}${e.paths?.length ? ' · ' + e.paths.map(esc).join(', ') : ''}</li>`).join('') +
    '</ul>';
}

// Etichetta del nodo: solo la cartella parent (ultimo segmento) + nome file senza ".helpai.md"
// "src/app/esempio/.helpai.md" → "esempio"; "src/app/esempio/test.helpai.md" → "esempio/test"; ".helpai.md" → "(radice)"
const nodeLabel = (id) => {
  const parts = id.replace(/\\/g, '/').split('/');
  const file = parts.pop();
  const folder = parts.length ? parts[parts.length - 1] : '';
  const base = file.endsWith('.helpai.md') ? file.slice(0, -'.helpai.md'.length) : file;
  if (!folder) return base ? base : '(radice)';
  return base ? `${folder}/${base}` : folder;
};

function renderGraph(data) {
  const elements = [
    ...data.nodes.map((n) => ({ data: { id: n.id, label: nodeLabel(n.id), status: n.status } })),
    ...data.edges.map((e, i) => ({ data: { id: `e${i}`, source: e.from, target: e.to } })),
  ];
  if (!cy) {
    cy = cytoscape({
      container: $('graph'),
      elements,
      layout: { name: 'breadthfirst', directed: true, padding: 20, spacingFactor: 1.2 },
      style: [
        { selector: 'node', style: { label: 'data(label)', 'font-size': 11, color: '#fff', 'text-valign': 'center', 'text-wrap': 'wrap', 'background-color': (n) => COLORS[n.data('status')] || '#999', width: 110, height: 40, shape: 'round-rectangle' } },
        { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#111' } },
        { selector: 'edge', style: { width: 2, 'line-color': '#999', 'target-arrow-color': '#999', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier' } },
      ],
    });
    cy.on('tap', 'node', (evt) => showDetail(evt.target.id()));
  } else {
    cy.elements().remove();
    cy.add(elements);
    cy.layout({ name: 'breadthfirst', directed: true, padding: 20, spacingFactor: 1.2 }).run();
  }
  for (const n of data.nodes) cy.getElementById(n.id).data('status', n.status);
}

// ---- Layout: grafo ridotto quando c'è un nodo selezionato --------------------
function showDetailSection(visible) {
  const sec = $('sec-detail');
  sec.classList.toggle('hidden', !visible);
  if (visible) sec.classList.remove('collapsed');
  requestAnimationFrame(() => { if (cy) cy.resize(); });
}

$('btn-close-detail').onclick = () => {
  selectedId = null;
  showDetailSection(false);
  renderTree();
};

// ---- File in sola lettura (non .helpai.md) ----------------------------------
async function showFile(relPath) {
  selectedId = null;
  showDetailSection(true);
  $('detail-title').textContent = `Sola lettura · ${relPath}`;
  $('detail').innerHTML = '<p class="muted">Caricamento…</p>';
  try {
    const f = await api('GET', `/api/fs/file?path=${encodeURIComponent(relPath)}`);
    $('detail').innerHTML = f.binary
      ? '<p class="muted">File binario: anteprima non disponibile.</p>'
      : `<pre class="ro-file">${esc(f.content)}</pre>`;
  } catch (e) {
    $('detail').innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
  renderTree();
}

// ---- Dettaglio spec ----------------------------------------------------------
async function showDetail(id, keepDraft = false) {
  selectedId = id;
  selectedFile = null;
  showDetailSection(true);
  const d = await api('GET', `/api/specs/${encodeURIComponent(id)}`);
  $('detail-title').textContent = `Spec · ${d.specPath}`;
  const draft = keepDraft && $('spec-editor') ? $('spec-editor').value : d.content;
  const list = (items, spec = false) => (items.length
    ? `<ul>${items.map((x) => (spec
        ? `<li><a href="#" class="spec-link" data-spec="${esc(x)}"><code>${esc(x)}</code></a></li>`
        : `<li><code>${esc(x)}</code></li>`)).join('')}</ul>`
    : '<p class="muted">nessuno</p>');
  $('detail').innerHTML = `
    <h3>${esc(d.specPath)}</h3>
    <p class="muted">cartella: <code>${esc(d.folderPath || '.')}</code> · stato: <span class="badge" style="background:${COLORS[d.status] || '#999'}">${esc(d.status)}</span></p>
    <strong>Spec (.helpai.md)</strong>
    <textarea id="spec-editor"></textarea>
    <div class="row" style="margin-top:6px">
      <button id="btn-save-spec">Salva spec</button>
      <span id="save-msg" class="muted"></span>
    </div>
    <details class="acc">
      <summary>Upstream (spec ereditate) <span class="count">${d.upstream.length}</span></summary>
      ${list(d.upstream, true)}
    </details>
    <details class="acc">
      <summary>Downstream (spec che dipendono da questa) <span class="count">${d.downstream.length}</span></summary>
      ${list(d.downstream, true)}
    </details>
    <details class="acc">
      <summary>File diretti nella cartella <span class="count">${d.folderFiles.length}</span></summary>
      ${list(d.folderFiles)}
      ${d.ignoredSubdirs?.length ? `<p class="muted">Sottocartelle ignorate: ${d.ignoredSubdirs.map(esc).join(', ')}</p>` : ''}
    </details>
    <div class="row" style="margin-top:10px;flex-wrap:wrap">
      <button id="btn-align" ${d.status === 'error' ? 'disabled title="Risolvi prima gli errori"' : ''}>Allinea Codice (Spec → Code)</button>
      <button id="btn-reverse" ${d.status === 'error' ? 'disabled title="Risolvi prima gli errori"' : ''}>Allinea Spec dal Codice (Code → Spec)</button>
    </div>
    <p id="align-msg" class="muted"></p>
    <strong>Storico</strong>
    <div id="history"></div>`;
  $('spec-editor').value = draft;
  $('detail').querySelectorAll('.spec-link').forEach((a) => {
    a.onclick = (ev) => { ev.preventDefault(); showDetail(a.dataset.spec); };
  });
  $('btn-save-spec').onclick = saveSpec;
  $('btn-align').onclick = () => startAlign('spec-to-code');
  $('btn-reverse').onclick = () => startAlign('code-to-spec');
  if (!harnessOk) {
    $('btn-align').disabled = true;
    $('btn-align').title = "Testa prima l'harness Hermes (⚙ Configurazioni)";
    $('btn-reverse').disabled = true;
    $('btn-reverse').title = "Testa prima l'harness Hermes (⚙ Configurazioni)";
  }
  loadHistory(id);
}

async function saveSpec() {
  try {
    const res = await api('PUT', `/api/specs/${encodeURIComponent(selectedId)}`, { content: $('spec-editor').value });
    $('save-msg').textContent = res.errors.length ? `salvato, ${res.errors.length} errori` : 'salvato';
    await refresh();
  } catch (e) {
    $('save-msg').textContent = e.message;
  }
}

const fmtDate = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
};

async function loadHistory(id) {
  const box = $('history');
  if (!box) return;
  const h = await api('GET', `/api/specs/${encodeURIComponent(id)}/history`);
  if (!h.history.length) return (box.innerHTML = '<p class="muted">nessun run ancora</p>');
  box.innerHTML = `<ul>${h.history.map((x) => `<li>${esc(fmtDate(x.at))} · ${esc(x.mode)} · file ${x.files.length ? x.files.map(esc).join(', ') : '—'}</li>`).join('')}</ul>
    <p class="muted">Confronto: scegli due run</p>
    <div class="row"><select id="cmp-a">${h.history.map((x) => `<option value="${esc(x.id)}">${esc(fmtDate(x.at))}</option>`).join('')}</select>
    <select id="cmp-b">${h.history.map((x) => `<option value="${esc(x.id)}">${esc(fmtDate(x.at))}</option>`).join('')}</select>
    <button id="btn-cmp">Confronta</button></div><pre id="cmp-out" class="muted"></pre>`;
  if (h.history.length > 1) $('cmp-b').selectedIndex = 1;
  $('btn-cmp').onclick = async () => {
    const a = $('cmp-a').value;
    const b = $('cmp-b').value;
    if (a === b) { $('cmp-out').textContent = 'Scegli due run diversi.'; return; }
    const r = await api('GET', `/api/specs/${encodeURIComponent(id)}/history?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
    openCompare(id, a, b, r.comparison);
  };
}

// ---- Sezione confronto stile git --------------------------------------------
function renderDiffLines(diff) {
  if (!diff) return '<div class="dl ctx"><span class="dn"></span><span class="dn"></span><span class="dc">(nessuna differenza)</span></div>';
  let oldN = 0;
  let newN = 0;
  return diff.split('\n').map((line) => {
    const sign = line[0];
    const text = esc(line.slice(1));
    if (sign === '+') { newN++; return `<div class="dl add"><span class="dn"></span><span class="dn">${newN}</span><span class="dc">+ ${text}</span></div>`; }
    if (sign === '-') { oldN++; return `<div class="dl del"><span class="dn">${oldN}</span><span class="dn"></span><span class="dc">- ${text}</span></div>`; }
    oldN++; newN++;
    return `<div class="dl ctx"><span class="dn">${oldN}</span><span class="dn">${newN}</span><span class="dc">  ${text}</span></div>`;
  }).join('');
}

function openCompare(specId, a, b, comparison) {
  showDetailSection(true);
  $('detail-title').textContent = `Confronto · ${specId}`;
  const files = comparison.filter((c) => c.status !== 'same');
  const body = files.length
    ? files.map((c) => `
        <details class="cmp-file" open>
          <summary><span class="badge">${esc(c.status)}</span> <code>${esc(c.name)}</code></summary>
          <div class="diff">${renderDiffLines(c.diff)}</div>
        </details>`).join('')
    : '<p class="muted">Nessuna differenza tra i due run.</p>';
  $('detail').innerHTML = `
    <div class="row"><button id="btn-cmp-back">← Torna alla spec</button><span class="spacer"></span><span class="muted">${esc(a)} → ${esc(b)}</span></div>
    ${body}`;
  $('btn-cmp-back').onclick = () => showDetail(specId);
}


// ---- Allineamento e console live --------------------------------------------
async function startAlign(task = 'spec-to-code') {
  try {
    const mode = $('mode').value;
    const suffix = task === 'code-to-spec' ? 'reverse-align' : 'align';
    const res = await api('POST', `/api/specs/${encodeURIComponent(selectedId)}/${suffix}`, { mode });
    $('align-msg').textContent = `run avviato (${mode})`;
    runTask = task;
    attachRun(res.runId);
  } catch (e) {
    $('align-msg').textContent = e.message;
  }
}

function attachRun(runId) {
  if (es) es.close();
  $('log').textContent = '';
  $('approvals').innerHTML = '';
  es = new EventSource(`/api/runs/${runId}/stream`);
  es.onmessage = (ev) => renderRun(JSON.parse(ev.data)).catch((e) => { $("align-msg").textContent = e.message; });
  es.onerror = () => {};
}

async function renderRun(run) {
  $('log').textContent = run.logs.join('\n');
  $('log').scrollTop = $('log').scrollHeight;
  const ap = $('approvals');
  if (run.status === 'awaiting-approval' && run.pending) {
    const p = run.pending;
    const path = p.change?.path ?? '';
    ap.innerHTML = `<div class="item"><strong>Modifica proposta:</strong> <code>${esc(path)}</code>
      <pre>${esc(p.diff || '(nessuna differenza testuale)')}</pre>
      <button id="ok">Approva</button> <button id="ko">Rifiuta</button></div>`;
    $('ok').onclick = () => decide(run.id, true);
    $('ko').onclick = () => decide(run.id, false);
  } else {
    ap.innerHTML = '';
  }
  if (run.status === 'done' || run.status === 'failed') {
    if (es) es.close();
    es = null;
    const msg = run.status === 'failed'
      ? `Run fallito: ${run.error}`
      : `Completato: ${run.result.applied.length} file applicati, ${run.result.reverted.length} annullati`;
    $('align-msg').textContent = msg;
    refresh();
    // Code→Spec: il file spec è stato riscritto dal run, ricarica il riquadro dal server.
    if (run.status === 'done' && runTask === 'code-to-spec' && selectedId) {
      const keepMsg = msg;
      await showDetail(selectedId, false);
      $('align-msg').textContent = keepMsg;
    }
  }
}

async function decide(runId, keep) {
  try {
    await api('POST', `/api/runs/${runId}/decision`, { keep });
  } catch (e) {
    $('align-msg').textContent = e.message;
  }
}

$('btn-rescan').onclick = async () => {
  await api('POST', '/api/project/rescan');
  await refresh();
};

boot().catch((e) => {
  $('setup-error').textContent = e.message;
  showSetup();
});
