import {
  $, askText, clear, confirmAction, debounce, el, formatBytes, formatDate, icon, plural, toast,
} from './ui.js';

/* Darkroom client.
   One page, three states: setting up, locked, and browsing. The server is the
   authority on which — a poll of /api/status decides what is on screen, so the
   moment the drive is pulled the grid goes away without the client having to
   guess. */

const PAGE = 120;

const state = {
  status: null,
  tree: null,
  view: { mode: 'folder', folder: '', q: '', sort: 'taken_desc' },
  items: [],
  total: 0,
  loading: false,
  exhausted: false,
  expanded: new Set(['']),
  lightbox: -1,
  watchedJob: null,
  browsePath: null,
  browseParent: null,
};

// ------------------------------------------------------------------- fetching

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 423) {
    // The drive went away between the click and the request. Re-read status so
    // the lock screen comes up instead of a stray error.
    refreshStatus();
    throw new ApiError('the drive is not connected', 423);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error ?? response.statusText, response.status);
  return payload;
}

/** Run an action, surfacing any failure as a toast rather than a console trace. */
async function attempt(fn, { silent423 = true } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 423 || !silent423) {
      toast(err.message ?? 'something went wrong', 'bad');
    }
    return null;
  }
}

// --------------------------------------------------------------------- status

let previousLocked = null;

async function refreshStatus() {
  let status;
  try {
    status = await api('/api/status');
  } catch {
    return; // Server restarting or gone; the next poll will find it.
  }
  state.status = status;

  const setup = !status.configured;
  const locked = status.locked;

  $('#gate').hidden = !(setup || locked);
  $('#gate-setup').hidden = !setup;
  $('#gate-locked').hidden = setup || !locked;
  $('#app').hidden = setup || locked;
  if (locked || setup) closeLightbox();

  if (setup && state.browsePath === null) browseTo(null);

  if (locked && !setup) {
    $('#gate-drive-label').textContent = status.volume?.label ?? 'your library';
    $('#gate-message').textContent =
      'Your photos live on an external drive, and that drive is not connected right now.';
  }

  if (!locked && !setup && previousLocked !== false) {
    // Crossing from locked to unlocked: rebuild the world. The drive can
    // vanish again mid-rebuild, so failing here is expected — leave
    // `previousLocked` alone and the next poll will try again.
    renderDriveStatus(status);
    try {
      await loadTree();
      resetGrid();
    } catch {
      return;
    }
  } else if (!locked && !setup) {
    renderDriveStatus(status);
  }
  previousLocked = locked;

  renderJob(status.jobs?.find((job) => job.status === 'running') ?? null);
}

function renderDriveStatus(status) {
  $('#drive-name').textContent = status.volume?.label ?? 'Library';
  const space = status.volume?.free
    ? `${formatBytes(status.volume.free)} free of ${formatBytes(status.volume.total)}`
    : status.volume?.path ?? '';
  $('#drive-space').textContent = space;
  $('#count-all').textContent = status.library ? status.library.count.toLocaleString() : '';
  $('#count-fav').textContent = status.library?.favorites ? status.library.favorites.toLocaleString() : '';
}

// ---------------------------------------------------------------- folder tree

async function loadTree() {
  const { tree } = await api('/api/folders');
  state.tree = tree;
  renderTree();
}

function findNode(node, path) {
  if (!node) return null;
  if (node.path === path) return node;
  for (const child of node.children) {
    const hit = findNode(child, path);
    if (hit) return hit;
  }
  return null;
}

function renderTree() {
  const host = clear($('#tree'));
  if (!state.tree) return;
  for (const child of state.tree.children) host.append(treeRow(child));
  if (state.tree.children.length === 0) {
    host.append(el('p', { class: 'muted', text: 'No folders yet. Make one with the + above.' }));
  }
}

function treeRow(node) {
  const expanded = state.expanded.has(node.path);
  const current = state.view.mode === 'folder' && state.view.folder === node.path;

  const twist = el('button', {
    class: `tree-twist${node.children.length ? '' : ' leaf'}`,
    'aria-expanded': String(expanded),
    'aria-label': expanded ? 'Collapse' : 'Expand',
    onClick: (event) => {
      event.stopPropagation();
      if (expanded) state.expanded.delete(node.path);
      else state.expanded.add(node.path);
      renderTree();
    },
  }, icon('i-chevron'));

  const row = el(
    'div',
    { class: 'tree-row', 'aria-current': String(current) },
    twist,
    el(
      'button',
      { class: 'tree-label', onClick: () => openFolder(node.path) },
      icon('i-folder'),
      el('span', { class: 'tree-name', text: node.name, title: node.path }),
      node.count ? el('span', { class: 'tree-count', text: node.count.toLocaleString() }) : null,
    ),
  );

  const children = node.children.length && expanded
    ? el('div', { class: 'tree-children' }, node.children.map(treeRow))
    : null;

  return el('div', {}, row, children);
}

// ----------------------------------------------------------------- navigation

function openFolder(path) {
  state.view = { ...state.view, mode: 'folder', folder: path, q: '' };
  $('#search').value = '';
  for (const part of ancestry(path)) state.expanded.add(part);
  renderTree();
  resetGrid();
}

function ancestry(path) {
  const parts = path.split('/').filter(Boolean);
  const out = [''];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    out.push(acc);
  }
  return out;
}

function setView(mode) {
  state.view = { ...state.view, mode, folder: mode === 'folder' ? state.view.folder : '' };
  renderTree();
  resetGrid();
}

function renderCrumbs() {
  const host = clear($('#crumbs'));
  const { mode, folder, q } = state.view;

  if (q) {
    // The results span the library, so a folder path here would be a lie.
    host.append(el('span', { class: 'crumb-last', text: `Results for “${q}”` }));
  } else if (mode === 'favorites') {
    host.append(el('span', { class: 'crumb-last', text: 'Favorites' }));
  } else if (mode === 'all' || folder === '') {
    host.append(el('span', { class: 'crumb-last', text: 'All photos' }));
  } else {
    host.append(el('button', { text: 'All photos', onClick: () => openFolder('') }));
    const parts = folder.split('/');
    let acc = '';
    parts.forEach((part, index) => {
      acc = acc ? `${acc}/${part}` : part;
      const at = acc;
      const last = index === parts.length - 1;
      host.append(el('span', { class: 'sep', text: '/' }));
      host.append(
        last
          ? el('span', { class: 'crumb-last', text: part })
          : el('button', { text: part, onClick: () => openFolder(at) }),
      );
    });
    host.append(
      el('button', { class: 'icon-btn', title: 'Rename this folder', onClick: renameCurrentFolder }, icon('i-pencil')),
    );
  }

  if (state.total) host.append(el('span', { class: 'crumb-count', text: plural(state.total, 'photo') }));

  const node = mode === 'folder' ? findNode(state.tree, folder) : null;
  const note = $('#folder-note');
  clear(note);
  if (node && mode === 'folder') {
    note.hidden = false;
    note.append(
      node.description
        ? el('span', { text: node.description })
        : el('span', { class: 'muted', text: 'No description yet.' }),
      ' ',
      el('button', {
        class: 'link-btn',
        text: node.description ? 'edit' : 'add one',
        onClick: () => editDescription(folder, node.description ?? ''),
      }),
    );
  } else {
    note.hidden = true;
  }
}

async function renameCurrentFolder() {
  const path = state.view.folder;
  const node = findNode(state.tree, path);
  const name = await askText({
    title: 'Rename folder',
    label: 'This renames the folder on the drive too',
    value: node?.name ?? '',
  });
  if (name === null || !name.trim()) return;

  await attempt(async () => {
    const { folder } = await api('/api/folders', { method: 'PATCH', body: { path, name } });
    await loadTree();
    openFolder(folder.rel_path);
    toast('Folder renamed');
  });
}

async function editDescription(path, current) {
  const description = await askText({
    title: 'Folder description',
    label: 'Shown at the top of the folder',
    value: current,
    multiline: true,
  });
  if (description === null) return;
  await attempt(async () => {
    await api('/api/folders', { method: 'PATCH', body: { path, description } });
    await loadTree();
    renderCrumbs();
  });
}

// ------------------------------------------------------------------ the grid

function resetGrid() {
  state.items = [];
  state.total = 0;
  state.exhausted = false;
  clear($('#grid'));
  $('#empty').hidden = true;
  renderCrumbs();
  renderSubfolders();
  $('#scroller').scrollTop = 0;
  loadMore();
}

function query() {
  const { mode, folder, q, sort } = state.view;
  const params = new URLSearchParams({ sort, limit: String(PAGE), offset: String(state.items.length) });
  if (mode === 'favorites') {
    params.set('favorite', '1');
    params.set('folder', '');
    params.set('recursive', '1');
  } else if (mode === 'all' || q) {
    // Searching looks at the whole library, not just the folder you happen to
    // be standing in — a photo you cannot find is the reason you are searching.
    params.set('folder', '');
    params.set('recursive', '1');
    if (q) params.set('q', q);
  } else {
    params.set('folder', folder);
  }
  return params;
}

async function loadMore() {
  if (state.loading || state.exhausted || !state.status || state.status.locked) return;
  state.loading = true;
  const token = JSON.stringify(state.view);

  try {
    const page = await api(`/api/photos?${query()}`);
    // A different folder was opened while this was in flight.
    if (token !== JSON.stringify(state.view)) return;

    state.total = page.total;
    state.items.push(...page.items);
    for (const photo of page.items) $('#grid').append(tile(photo));
    if (page.items.length < page.limit || state.items.length >= page.total) state.exhausted = true;

    renderCrumbs();
    const nothing = state.items.length === 0;
    $('#empty').hidden = !nothing;
    if (nothing) {
      $('#empty').textContent = state.view.q
        ? `Nothing matches “${state.view.q}”.`
        : 'No photos here yet. Use Sync to copy some in, or drop files into the folder on the drive and hit Scan.';
    }
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 423) toast(err.message, 'bad');
    state.exhausted = true;
  } finally {
    state.loading = false;
  }
}

function tile(photo) {
  const button = el('button', {
    class: 'tile',
    title: photo.title || photo.filename,
    onClick: () => openLightbox(state.items.indexOf(photo)),
  });

  if (photo.thumb_state === 'unsupported') {
    button.append(
      el('span', { class: 'tile-opaque' }, icon('i-image'), el('span', { text: photo.ext.replace('.', '') })),
    );
  } else {
    const img = el('img', {
      loading: 'lazy',
      decoding: 'async',
      alt: photo.title || photo.filename,
      src: `/api/photos/${photo.id}/thumb`,
      onLoad: (event) => event.target.classList.add('loaded'),
      onError: (event) => {
        // Undecodable after all — swap in the placeholder rather than an
        // empty frame with a broken-image glyph.
        event.target.remove();
        button.append(
          el('span', { class: 'tile-opaque' }, icon('i-image'), el('span', { text: photo.ext.replace('.', '') })),
        );
      },
    });
    button.append(img);
  }

  if (photo.favorite) button.append(el('span', { class: 'tile-fav' }, icon('i-star')));
  return button;
}

function renderSubfolders() {
  const host = clear($('#subfolders'));
  const node = state.view.mode === 'folder' && !state.view.q ? findNode(state.tree, state.view.folder) : null;
  const children = node?.children ?? [];
  host.hidden = children.length === 0;

  for (const child of children) {
    const cover = el('div', { class: 'folder-cover' });
    if (child.cover) {
      cover.append(
        el('img', {
          loading: 'lazy',
          alt: '',
          src: `/api/photos/${child.cover.id}/thumb`,
          onError: (event) => { event.target.remove(); cover.append(icon('i-folder')); },
        }),
      );
      if (child.cover.explicit) {
        cover.append(el('span', { class: 'pin', title: 'Cover chosen by you' }, icon('i-star')));
      }
    } else {
      cover.append(icon('i-folder'));
    }

    host.append(
      el(
        'button',
        { class: 'folder-card', onClick: () => openFolder(child.path) },
        cover,
        el(
          'div',
          { class: 'folder-card-body' },
          el('strong', { text: child.name }),
          el('small', {
            text: child.count
              ? `${plural(child.count, 'photo')}${child.children.length ? ` · ${plural(child.children.length, 'folder')}` : ''}`
              : 'Empty',
          }),
        ),
      ),
    );
  }
}

// ------------------------------------------------------------------ lightbox

function openLightbox(index) {
  if (index < 0 || index >= state.items.length) return;
  state.lightbox = index;
  $('#lightbox').hidden = false;
  renderLightbox();
}

function closeLightbox() {
  if ($('#lightbox').hidden) return;
  $('#lightbox').hidden = true;
  $('#lb-image').removeAttribute('src');
  state.lightbox = -1;
}

async function step(delta) {
  const next = state.lightbox + delta;
  if (next < 0) return;
  if (next >= state.items.length) {
    if (state.exhausted) return;
    await loadMore();
    if (next >= state.items.length) return;
  }
  openLightbox(next);
}

async function renderLightbox() {
  const photo = state.items[state.lightbox];
  if (!photo) return closeLightbox();

  const image = $('#lb-image');
  const opaque = photo.thumb_state === 'unsupported';
  image.hidden = opaque;
  $('#lb-unsupported').hidden = !opaque;
  $('#lb-unsupported-note').textContent = photo.filename;
  if (!opaque) {
    image.src = `/api/photos/${photo.id}/preview`;
    image.alt = photo.title || photo.filename;
  } else {
    image.removeAttribute('src');
  }

  $('#lb-name').textContent = photo.filename;
  $('#lb-title').value = photo.title ?? '';
  $('#lb-caption').value = photo.caption ?? '';
  $('#lb-fav').classList.toggle('on', Boolean(photo.favorite));
  $('#lb-download').href = `/api/photos/${photo.id}/original?download=1`;
  $('#lb-download').setAttribute('download', photo.filename);
  $('#lb-cover').title = `Use as the cover for ${coverTarget(photo) || 'the library root'}`;

  const meta = clear($('#lb-meta'));
  const rows = [
    ['Folder', photo.folder_path || 'Library root'],
    ['Taken', formatDate(photo.taken_at)],
    ['Size', photo.width && photo.height ? `${photo.width} × ${photo.height}` : null],
    ['File', formatBytes(photo.size)],
    ['Camera', photo.camera],
    ['Lens', photo.lens],
  ];
  for (const [label, value] of rows) {
    if (!value) continue;
    meta.append(el('dt', { text: label }), el('dd', { text: value }));
  }

  // Warm the next image so arrowing through feels instant.
  const next = state.items[state.lightbox + 1];
  if (next && next.thumb_state !== 'unsupported') new Image().src = `/api/photos/${next.id}/preview`;
}

/** Which folder a "set as cover" applies to: the one you are looking at. */
function coverTarget(photo) {
  const { mode, folder } = state.view;
  if (mode !== 'folder') return photo.folder_path;
  const inside = folder === '' || photo.folder_path === folder || photo.folder_path.startsWith(`${folder}/`);
  return inside ? folder : photo.folder_path;
}

async function patchPhoto(changes) {
  const photo = state.items[state.lightbox];
  if (!photo) return;
  await attempt(async () => {
    const { photo: updated } = await api(`/api/photos/${photo.id}`, { method: 'PATCH', body: changes });
    Object.assign(photo, updated);
    renderLightbox();
    // Keep the grid tile in step with the panel.
    const tiles = $('#grid').children;
    const node = tiles[state.lightbox];
    if (node) node.replaceWith(tile(photo));
  });
}

// ---------------------------------------------------------------------- jobs

function renderJob(job) {
  const bar = $('#job-bar');
  if (!job) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const { phase, processed, total } = job.progress ?? {};
  $('#job-label').textContent = `${job.type}: ${phase ?? 'working'}`;
  $('#job-detail').textContent = total ? `${processed} of ${total}` : `${processed ?? 0}`;
  const pct = total ? Math.min(100, Math.round((processed / total) * 100)) : 4;
  $('#job-fill').style.setProperty('width', `${pct}%`);
  $('#job-cancel').onclick = () => attempt(() => api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }));
}

async function runJob(kind, label) {
  const started = await attempt(() => api(`/api/jobs/${kind}`, { method: 'POST' }));
  if (!started?.job) return;
  toast(`${label} started`);
  state.watchedJob = started.job.id;
  pollJob(started.job.id);
}

async function pollJob(id) {
  let payload;
  try {
    payload = await api(`/api/jobs/${id}`);
  } catch {
    state.watchedJob = null;
    return;
  }
  const job = payload.job;
  renderJob(job.status === 'running' ? job : null);

  if (job.status === 'running') {
    setTimeout(() => pollJob(id), 600);
    return;
  }

  state.watchedJob = null;
  if (job.status === 'error') toast(`${job.type} failed: ${job.error}`, 'bad');
  else if (job.status === 'cancelled') toast(`${job.type} cancelled`);
  else toast(summarise(job));

  if (job.result) {
    $('#job-report-wrap').hidden = false;
    $('#job-report').textContent = JSON.stringify(job.result, null, 2);
  }
  // A scan or sync moves things around, so reload rather than patch. If the
  // drive left while the job was finishing, the status poll takes over.
  if (await attempt(loadTree) !== null) resetGrid();
  refreshStatus();
}

function summarise(job) {
  const result = job.result ?? {};
  if (job.type === 'scan') {
    return `Scan done — ${result.added ?? 0} new, ${result.updated ?? 0} updated, ${result.moved ?? 0} moved`;
  }
  if (job.type === 'sync') {
    return `Imported ${result.imported ?? 0} photo(s); ${result.duplicates ?? 0} already here`;
  }
  if (job.type === 'verify') {
    const bad = (result.changed?.length ?? 0) + (result.missing?.length ?? 0) + (result.unreadable?.length ?? 0);
    return bad === 0
      ? `All ${result.checked ?? 0} files match the index`
      : `${bad} file(s) need attention — see Settings`;
  }
  if (job.type === 'thumbs') return `Built ${result.rendered ?? 0} thumbnail(s)`;
  return `${job.type} finished`;
}

// ------------------------------------------------------------------ settings

async function openSettings() {
  const dialog = $('#settings');
  const [config, cache] = await Promise.all([
    attempt(() => api('/api/config')),
    attempt(() => api('/api/cache')),
  ]);
  if (config) {
    $('#scan-on-unlock').checked = Boolean(config.scanOnUnlock);
    renderSources(config.sync?.sources ?? []);
  }
  $('#cache-info').textContent = cache
    ? `Thumbnail cache: ${plural(cache.files, 'file')}, ${formatBytes(cache.bytes)} — stored on the drive.`
    : '';
  $('#info-path').textContent = state.status?.volume?.path ?? '—';
  dialog.showModal();
}

function renderSources(sources) {
  const host = clear($('#sources'));
  if (sources.length === 0) {
    host.append(el('li', { class: 'muted', text: 'No source folders yet.' }));
    return;
  }
  sources.forEach((source, index) => {
    host.append(
      el(
        'li',
        {},
        el('code', { text: source.path, title: source.path }),
        el('span', { class: 'tag', text: `→ ${source.into}/ (${source.organizeBy})` }),
        el('button', {
          class: 'icon-btn',
          title: 'Remove',
          onClick: async () => {
            const next = sources.filter((_, i) => i !== index);
            await attempt(async () => {
              await api('/api/config', { method: 'PATCH', body: { sync: { sources: next } } });
              renderSources(next);
            });
          },
        }, icon('i-close')),
      ),
    );
  });
}

async function addSource() {
  const path = $('#source-path').value.trim();
  if (!path) return toast('Type the full path of a folder on this computer', 'bad');

  const config = await attempt(() => api('/api/config'));
  const sources = [...(config?.sync?.sources ?? []), {
    path,
    into: $('#source-into').value.trim() || 'Imported',
    organizeBy: $('#source-organize').value,
  }];

  return attempt(async () => {
    const saved = await api('/api/config', { method: 'PATCH', body: { sync: { sources } } });
    renderSources(saved.config.sync.sources);
    $('#source-path').value = '';
    $('#source-into').value = '';
    toast('Source added');
  });
}

// --------------------------------------------------------------- setup wizard

async function browseTo(path) {
  const result = await attempt(() => api(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`));
  if (!result) return;
  state.browsePath = result.path;
  state.browseParent = result.parent;

  $('#picker-current').textContent = result.path;
  $('#picker-up').disabled = !result.parent;

  const shortcuts = clear($('#picker-shortcuts'));
  shortcuts.hidden = !result.shortcuts?.length;
  for (const shortcut of result.shortcuts ?? []) {
    shortcuts.append(
      el('button', {
        class: `chip${shortcut.path === result.path ? ' on' : ''}`,
        text: shortcut.name,
        title: shortcut.path,
        onClick: () => browseTo(shortcut.path),
      }),
    );
  }

  const host = clear($('#picker-list'));
  if (result.entries.length === 0) {
    host.append(el('li', { class: 'picker-empty', text: 'No folders in here.' }));
  }
  for (const entry of result.entries) {
    host.append(
      el('li', {}, el('button', { onClick: () => browseTo(entry.path) }, icon('i-folder'), entry.name)),
    );
  }
  renderSetupTarget();
}

function setupTarget() {
  const base = state.browsePath ?? '';
  const name = $('#setup-folder').value.trim();
  if (!name) return base;
  return `${base.endsWith('/') ? base.slice(0, -1) : base}/${name}`;
}

function renderSetupTarget() {
  const node = clear($('#setup-target'));
  node.append('The library will be created at ', el('code', { text: setupTarget() || '…' }));
}

async function createLibrary() {
  const target = setupTarget();
  const label = $('#setup-label').value.trim();
  $('#setup-error').hidden = true;

  try {
    const result = await api('/api/volume/init', { method: 'POST', body: { path: target, label } });
    toast(result.adopted ? `Paired with "${result.label}"` : `Library created at ${result.path}`);
    previousLocked = null;
    await refreshStatus();
  } catch (err) {
    $('#setup-error').textContent = err.message;
    $('#setup-error').hidden = false;
  }
}

// ------------------------------------------------------------------- wiring

function wire() {
  // Sidebar and toolbar.
  for (const button of document.querySelectorAll('.nav-item')) {
    button.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.nav-item')) other.setAttribute('aria-current', 'false');
      button.setAttribute('aria-current', 'true');
      setView(button.dataset.view);
    });
  }

  $('#search').addEventListener('input', debounce((event) => {
    state.view = { ...state.view, q: event.target.value.trim() };
    resetGrid();
  }, 220));

  $('#sort').addEventListener('change', (event) => {
    state.view = { ...state.view, sort: event.target.value };
    resetGrid();
  });

  $('#zoom').addEventListener('input', (event) => {
    document.documentElement.style.setProperty('--tile', `${event.target.value}px`);
  });

  $('#new-folder').addEventListener('click', async () => {
    const name = await askText({
      title: 'New folder',
      label: `Created inside ${state.view.folder || 'the library root'}`,
      placeholder: 'Iceland 2024',
      confirm: 'Create',
    });
    if (!name?.trim()) return;
    await attempt(async () => {
      const { folder } = await api('/api/folders', {
        method: 'POST',
        body: { parent: state.view.mode === 'folder' ? state.view.folder : '', name },
      });
      await loadTree();
      openFolder(folder.rel_path);
      toast('Folder created');
    });
  });

  $('#btn-scan').addEventListener('click', () => runJob('scan', 'Scan'));
  $('#btn-sync').addEventListener('click', () => runJob('sync', 'Sync'));
  $('#btn-settings').addEventListener('click', openSettings);

  // Settings.
  $('#source-add').addEventListener('click', addSource);
  $('#scan-on-unlock').addEventListener('change', (event) =>
    attempt(() => api('/api/config', { method: 'PATCH', body: { scanOnUnlock: event.target.checked } })));
  $('#btn-verify').addEventListener('click', () => runJob('verify', 'Verify'));
  $('#btn-thumbs').addEventListener('click', () => runJob('thumbs', 'Thumbnail build'));

  $('#btn-clear-cache').addEventListener('click', async () => {
    const ok = await confirmAction({
      title: 'Clear the thumbnail cache?',
      body: 'Thumbnails are rebuilt as you browse. Your photos are not touched.',
      confirm: 'Clear cache',
    });
    if (!ok) return;
    await attempt(() => api('/api/cache', { method: 'DELETE' }));
    toast('Cache cleared');
    resetGrid();
  });

  $('#btn-forget').addEventListener('click', async () => {
    const ok = await confirmAction({
      title: 'Unpair this drive?',
      body: 'This computer forgets which drive to look for. Nothing on the drive itself is changed, and you can pair with it again at any time.',
      confirm: 'Unpair',
      danger: true,
    });
    if (!ok) return;
    await attempt(() => api('/api/volume/forget', { method: 'POST' }));
    $('#settings').close();
    previousLocked = null;
    state.browsePath = null;
    refreshStatus();
  });

  // Lock screen.
  $('#gate-recheck').addEventListener('click', async () => {
    await attempt(() => api('/api/volume/recheck', { method: 'POST' }));
    refreshStatus();
  });
  $('#gate-forget').addEventListener('click', async () => {
    await attempt(() => api('/api/volume/forget', { method: 'POST' }));
    previousLocked = null;
    state.browsePath = null;
    refreshStatus();
  });

  // Setup wizard.
  $('#picker-up').addEventListener('click', () => browseTo(state.browseParent));
  $('#setup-folder').addEventListener('input', renderSetupTarget);
  $('#setup-create').addEventListener('click', createLibrary);

  // Lightbox.
  $('#lb-close').addEventListener('click', closeLightbox);
  $('#lb-prev').addEventListener('click', () => step(-1));
  $('#lb-next').addEventListener('click', () => step(1));
  $('#lb-fav').addEventListener('click', () =>
    patchPhoto({ favorite: !state.items[state.lightbox]?.favorite }));
  $('#lb-title').addEventListener('change', (event) => patchPhoto({ title: event.target.value }));
  $('#lb-caption').addEventListener('change', (event) => patchPhoto({ caption: event.target.value }));

  $('#lb-cover').addEventListener('click', async () => {
    const photo = state.items[state.lightbox];
    if (!photo) return;
    const target = coverTarget(photo);
    await attempt(async () => {
      await api('/api/folders', { method: 'PATCH', body: { path: target, coverPhotoId: photo.id } });
      await loadTree();
      renderSubfolders();
      toast(`Cover set for ${target || 'the library root'}`);
    });
  });

  $('#lb-delete').addEventListener('click', async () => {
    const photo = state.items[state.lightbox];
    if (!photo) return;
    const ok = await confirmAction({
      title: `Move ${photo.filename} to the trash?`,
      body: 'The file moves into .darkroom/trash on the drive. Nothing is erased — you can put it back from there yourself.',
      confirm: 'Move to trash',
      danger: true,
    });
    if (!ok) return;
    await attempt(async () => {
      await api(`/api/photos/${photo.id}`, { method: 'DELETE' });
      const index = state.lightbox;
      state.items.splice(index, 1);
      $('#grid').children[index]?.remove();
      state.total = Math.max(0, state.total - 1);
      renderCrumbs();
      if (state.items.length === 0) closeLightbox();
      else openLightbox(Math.min(index, state.items.length - 1));
      toast('Moved to trash');
    });
  });

  document.addEventListener('keydown', (event) => {
    if ($('#lightbox').hidden) return;
    const typing = ['INPUT', 'TEXTAREA'].includes(event.target.tagName);
    if (event.key === 'Escape') return closeLightbox();
    if (typing) return;
    if (event.key === 'ArrowLeft') step(-1);
    else if (event.key === 'ArrowRight') step(1);
    else if (event.key === 'f') patchPhoto({ favorite: !state.items[state.lightbox]?.favorite });
  });

  // Infinite scroll.
  new IntersectionObserver(
    (entries) => { if (entries.some((entry) => entry.isIntersecting)) loadMore(); },
    { root: $('#scroller'), rootMargin: '600px' },
  ).observe($('#sentinel'));
}

wire();
refreshStatus();
// The drive can be pulled at any moment; this poll is how the UI finds out.
setInterval(() => { if (!state.watchedJob) refreshStatus(); }, 3000);
