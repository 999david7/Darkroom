/* Small DOM and formatting helpers shared by the app.
   Everything builds nodes programmatically and sets user text through
   textContent — no innerHTML anywhere, so a filename containing markup is just
   a filename. */

export const $ = (selector, root = document) => root.querySelector(selector);

/**
 * Build an element.
 *
 * Styles go through the CSSOM (`node.style.setProperty`) rather than a `style`
 * attribute, because the page runs under a Content-Security-Policy without
 * `unsafe-inline` and attribute styles would be dropped.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') throw new Error('el() does not take raw HTML');
    else if (key === 'style') for (const [prop, val] of Object.entries(value)) node.style.setProperty(prop, val);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** An <svg><use href="#id"/></svg> reference into the inline sprite. */
export function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// --------------------------------------------------------------- formatting

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value >= 100 || exp === 0 ? Math.round(value) : value.toFixed(1)} ${units[exp]}`;
}

export function formatDate(ms) {
  if (!ms) return null;
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

// ------------------------------------------------------------------- toasts

let toastTimer = null;

export function toast(message, kind = 'ok') {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('bad', kind === 'bad');
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, kind === 'bad' ? 6000 : 3200);
}

// ------------------------------------------------------------------ dialogs

function modal(build) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'dialog' });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      dialog.close();
    };
    dialog.addEventListener('close', () => { done(null); dialog.remove(); });
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); done(null); });
    build(dialog, done);
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Ask for a line (or a paragraph) of text. Resolves null when dismissed. */
export function askText({ title, label, value = '', placeholder = '', multiline = false, confirm = 'Save' }) {
  return modal((dialog, done) => {
    const input = multiline
      ? el('textarea', { rows: 4, placeholder, value })
      : el('input', { type: 'text', placeholder, value, autocomplete: 'off' });

    const form = el(
      'form',
      {
        class: 'dialog-body',
        onSubmit: (event) => { event.preventDefault(); done(input.value); },
      },
      el('label', { class: 'field' }, el('span', { text: label }), input),
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'btn btn-primary', type: 'submit', text: confirm }),
        el('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel', onClick: () => done(null) }),
      ),
    );

    dialog.append(
      el('div', { class: 'dialog-head' }, el('h2', { text: title })),
      form,
    );
    queueMicrotask(() => { input.focus(); input.select?.(); });
  });
}

/** Yes/no. Resolves true only on an explicit confirmation. */
export function confirmAction({ title, body, confirm = 'Continue', danger = false }) {
  return modal((dialog, done) => {
    dialog.append(
      el('div', { class: 'dialog-head' }, el('h2', { text: title })),
      el(
        'div',
        { class: 'dialog-body' },
        el('p', { class: 'muted', text: body }),
        el(
          'div',
          { class: 'row' },
          el('button', {
            class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
            text: confirm,
            onClick: () => done(true),
          }),
          el('button', { class: 'btn btn-quiet', text: 'Cancel', onClick: () => done(false) }),
        ),
      ),
    );
    queueMicrotask(() => dialog.querySelector('button').focus());
  });
}

/** Debounce that keeps the latest call's arguments. */
export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
