// Small helpers shared by the front-end modules: JSON API calls, the SSE
// reader for streamed replies, and safe localStorage access.

/** Error carrying the HTTP status and the server's (safe) message. */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Throw an ApiError for a non-2xx response, with the server's message. */
export async function ensureOk(res) {
  if (res.ok) return res;
  const body = await res.json().catch(() => ({}));
  throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status);
}

/**
 * JSON API call. A JSON content type is only sent with a string body
 * (Fastify rejects an empty body declared as JSON); binary bodies set
 * their own headers.
 * @returns {Promise<any>} the parsed JSON, or null for 204.
 */
export async function api(path, options = {}) {
  const json = typeof options.body === 'string';
  const res = await fetch(path, {
    ...options,
    headers: json ? { 'Content-Type': 'application/json', ...(options.headers ?? {}) } : options.headers,
  });
  await ensureOk(res);
  return res.status === 204 ? null : res.json();
}

/** Parse an SSE byte stream into {event, data} objects. */
export async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      const data = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) yield { event, data: JSON.parse(data.join('\n')) };
    }
  }
}

/** localStorage may be unavailable (private mode…): never let it crash. */
export const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};

/** Create an element with a class and text (always textContent, never HTML). */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Wire a <dialog>: [data-close] buttons and the Esc key close it.
 *
 * Options:
 *  - backdropClose: a click on the backdrop closes it too (the click target
 *    is the dialog itself only there). Off for forms, where a stray click
 *    must never throw away what was typed.
 *  - canClose: async guard run before closing with ✕ / Esc (e.g. "discard
 *    your changes?"); resolving false keeps the dialog open.
 */
export function wireDialog(dialog, { backdropClose = true, canClose = async () => true } = {}) {
  const tryClose = async () => {
    if (await canClose()) dialog.close();
  };
  dialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => void tryClose()));
  // Esc fires "cancel": keep the dialog open and go through the guard.
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    void tryClose();
  });
  if (backdropClose) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) void tryClose();
    });
  }
}

/**
 * Ask for confirmation with the styled dialog.
 * @returns {Promise<boolean>}
 */
export function confirmAction({ title, text, action }) {
  const dialog = document.getElementById('confirm-dialog');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-text').textContent = text;
  document.getElementById('confirm-ok').textContent = action;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}
