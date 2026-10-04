// Character editor: create / edit / delete / export a character, and pick
// her reference face (generated portraits, or an uploaded photo after an
// explicit consent step). All text goes through form values and
// textContent; images are served by the local API.

import { api, confirmAction, ensureOk, wireDialog } from './api.js';

/** Card fields edited as plain text inputs (tags and style are handled apart). */
const TEXT_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'creator_notes',
  'appearance',
];

const $ = (id) => document.getElementById(id);

export class CharacterEditor {
  /**
   * @param {{
   *   onSaved: (summary: object) => void,
   *   onDeleted: (id: string) => void,
   *   onFaceChanged: (id: string) => void,
   *   photosAvailable: () => boolean,
   * }} handlers
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.dialog = $('editor-dialog');
    this.form = $('editor-form');
    this.id = null;
    /** Aborts a running portrait generation when the editor closes. */
    this.generation = null;
    /** JSON of the form as last loaded or saved, to detect unsaved changes. */
    this.savedState = '';
    /**
     * Character ('new' or an id) whose unsaved draft is kept after the editor
     * closed without saving: reopening the same character restores it.
     */
    this.draftKey = null;
    this.discarded = false;
    // A click outside must never throw away what was typed: only ✕ / Esc
    // close the editor, and they ask first when there are unsaved changes.
    wireDialog(this.dialog, { backdropClose: false, canClose: () => this.#confirmDiscard() });
    this.dialog.addEventListener('close', () => {
      this.generation?.abort();
      // Closed with unsaved changes without choosing "Discard" (e.g. the
      // browser forced it): keep the draft for the next opening.
      this.draftKey = !this.discarded && this.#isDirty() ? (this.id ?? 'new') : null;
      this.discarded = false;
    });

    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.#run(async () => {
        await this.#save();
        this.#status('Saved');
      });
    });
    $('editor-delete').addEventListener('click', () => void this.#delete());
    $('editor-export').addEventListener('click', () => void this.#run(() => this.#export()));
    $('face-generate').addEventListener('click', () => void this.#generateFaces());
    $('face-upload').addEventListener('click', () => void this.#askConsentThenPick());
    $('face-file').addEventListener('change', () => void this.#uploadFace());
    $('face-remove').addEventListener('click', () => void this.#removeFace());
  }

  /** Open for a new character (no id) or an existing one. */
  async open(id = null) {
    if (this.draftKey !== null && this.draftKey === (id ?? 'new')) {
      // Same character as the unsaved draft: show it as it was left.
      this.draftKey = null;
      this.dialog.showModal();
      this.#status('Your unsaved changes are still here.');
      return;
    }
    this.draftKey = null;
    this.id = id;
    this.form.reset();
    this.#status('');
    this.#faceStatus('');
    $('face-candidates').hidden = true;
    $('face-candidates').replaceChildren();
    $('editor-title').textContent = id ? 'Edit character' : 'New character';
    $('editor-delete').hidden = $('editor-export').hidden = !id;
    $('face-generate').disabled = !this.handlers.photosAvailable();
    $('face-generate').title = this.handlers.photosAvailable() ? '' : 'Photos are not available right now';
    this.#showFace(false);
    this.dialog.showModal();

    if (!id) {
      this.savedState = this.#snapshot();
      this.form.elements.namedItem('name').focus();
      return;
    }
    try {
      const data = await api(`/api/characters/${encodeURIComponent(id)}`);
      for (const key of TEXT_FIELDS) this.form.elements.namedItem(key).value = data.card[key] ?? '';
      this.form.elements.namedItem('tags').value = data.card.tags.join(', ');
      this.form.querySelector(`input[name="style"][value="${data.card.style}"]`).checked = true;
      this.#showFace(data.hasFace);
    } catch (err) {
      this.#status(err.message, true);
    }
    this.savedState = this.#snapshot();
  }

  // ------------------------------------------------- unsaved changes --

  #snapshot() {
    return JSON.stringify(this.#collect());
  }

  #isDirty() {
    return this.#snapshot() !== this.savedState;
  }

  /** Guard for ✕ / Esc: ask before throwing away unsaved changes. */
  async #confirmDiscard() {
    if (!this.#isDirty()) return true;
    const ok = await confirmAction({
      title: 'Discard your changes?',
      text: 'What you changed since the last save will be lost.',
      action: 'Discard',
    });
    if (ok) this.discarded = true;
    return ok;
  }

  // ------------------------------------------------------------- card --

  #collect() {
    const value = (key) => this.form.elements.namedItem(key).value;
    const card = Object.fromEntries(TEXT_FIELDS.map((key) => [key, value(key)]));
    card.name = card.name.trim();
    card.style = this.form.querySelector('input[name="style"]:checked').value;
    card.tags = value('tags')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20);
    return card;
  }

  /** Create or update; returns the character's summary. */
  async #save() {
    if (!this.form.reportValidity()) throw new Error('Give her a name first');
    const body = JSON.stringify(this.#collect());
    const summary = this.id
      ? await api(`/api/characters/${encodeURIComponent(this.id)}`, { method: 'PUT', body })
      : await api('/api/characters', { method: 'POST', body });
    this.id = summary.id;
    this.savedState = this.#snapshot();
    $('editor-title').textContent = 'Edit character';
    $('editor-delete').hidden = $('editor-export').hidden = false;
    this.handlers.onSaved(summary);
    return summary;
  }

  async #delete() {
    if (!this.id) return;
    const name = this.form.elements.namedItem('name').value || 'this character';
    const ok = await confirmAction({
      title: `Delete ${name}?`,
      text: 'Her card, every chat with her, her photos and what she remembers will be deleted. This cannot be undone.',
      action: 'Delete',
    });
    if (!ok) return;
    await this.#run(async () => {
      await api(`/api/characters/${encodeURIComponent(this.id)}`, { method: 'DELETE' });
      const id = this.id;
      this.dialog.close();
      this.handlers.onDeleted(id);
    });
  }

  /** Download the card as a SillyTavern-compatible V2 JSON file. */
  async #export() {
    const res = await ensureOk(await fetch(`/api/characters/${encodeURIComponent(this.id)}/export`));
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ------------------------------------------------------------- face --

  #faceUrl() {
    // The query string defeats the browser cache after a change.
    return `/api/characters/${encodeURIComponent(this.id)}/face?v=${Date.now()}`;
  }

  #showFace(hasFace) {
    const preview = $('face-preview');
    $('face-remove').hidden = !hasFace;
    if (!hasFace) {
      const empty = document.createElement('span');
      empty.className = 'muted small';
      empty.textContent = 'No face yet';
      preview.replaceChildren(empty);
      return;
    }
    const img = document.createElement('img');
    img.src = this.#faceUrl();
    img.alt = 'Her reference face';
    preview.replaceChildren(img);
  }

  /** Portraits use the SAVED appearance: save the form first. */
  async #generateFaces() {
    const appearance = this.form.elements.namedItem('appearance').value.trim();
    if (!appearance) {
      this.#faceStatus('Describe her appearance first.', true);
      this.form.elements.namedItem('appearance').focus();
      return;
    }
    const button = $('face-generate');
    button.disabled = true;
    const started = Date.now();
    const tick = () => this.#faceStatus(`Generating 4 faces… ${Math.round((Date.now() - started) / 1000)} s`);
    let timer;
    try {
      await this.#save();
      tick();
      timer = setInterval(tick, 1000);
      this.generation = new AbortController();
      const res = await fetch(`/api/characters/${encodeURIComponent(this.id)}/face/candidates`, {
        method: 'POST',
        signal: this.generation.signal,
      });
      await ensureOk(res);
      const { candidates } = await res.json();
      this.#showCandidates(candidates);
      this.#faceStatus('Pick the face you prefer.');
    } catch (err) {
      this.#faceStatus(err.name === 'AbortError' ? 'Cancelled' : err.message, err.name !== 'AbortError');
    } finally {
      clearInterval(timer);
      this.generation = null;
      button.disabled = !this.handlers.photosAvailable();
    }
  }

  #showCandidates(ids) {
    const box = $('face-candidates');
    box.replaceChildren(
      ...ids.map((cid, i) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-label', `Use face ${i + 1}`);
        const img = document.createElement('img');
        img.src = `/api/characters/${encodeURIComponent(this.id)}/face/candidates/${cid}`;
        img.alt = `Face option ${i + 1}`;
        button.append(img);
        button.addEventListener('click', () => void this.#pickCandidate(cid));
        return button;
      }),
    );
    box.hidden = false;
  }

  async #pickCandidate(cid) {
    await this.#run(async () => {
      await api(`/api/characters/${encodeURIComponent(this.id)}/face/candidates/${cid}`, { method: 'POST' });
      $('face-candidates').hidden = true;
      this.#showFace(true);
      this.#faceStatus('Face saved');
      this.handlers.onFaceChanged(this.id);
    });
  }

  /** Real photos need an explicit attestation before the file picker opens. */
  async #askConsentThenPick() {
    const dialog = $('consent-dialog');
    $('consent-check').checked = false;
    dialog.returnValue = '';
    dialog.showModal();
    const answer = await new Promise((resolve) =>
      dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }),
    );
    if (answer === 'ok') $('face-file').click();
  }

  async #uploadFace() {
    const input = $('face-file');
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      this.#faceStatus('This image is larger than 10 MB.', true);
      return;
    }
    await this.#run(async () => {
      await this.#save();
      this.#faceStatus('Uploading…');
      const res = await fetch(`/api/characters/${encodeURIComponent(this.id)}/face`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'x-girllm-consent': 'adult-and-consenting' },
        body: file,
      });
      await ensureOk(res);
      this.#showFace(true);
      this.#faceStatus('Face saved (metadata removed)');
      this.handlers.onFaceChanged(this.id);
    }, true);
  }

  async #removeFace() {
    await this.#run(async () => {
      await api(`/api/characters/${encodeURIComponent(this.id)}/face`, { method: 'DELETE' });
      this.#showFace(false);
      this.#faceStatus('Face removed');
      this.handlers.onFaceChanged(this.id);
    }, true);
  }

  // ---------------------------------------------------------- helpers --

  /** Run an action, reporting errors in the footer (or the face section). */
  async #run(action, face = false) {
    try {
      await action();
    } catch (err) {
      (face ? this.#faceStatus : this.#status).call(this, err.message, true);
    }
  }

  #status(text, isError = false) {
    const node = $('editor-status');
    node.textContent = text;
    node.classList.toggle('error-text', isError);
  }

  #faceStatus(text, isError = false) {
    const node = $('face-status');
    node.textContent = text;
    node.classList.toggle('error-text', isError);
  }
}
