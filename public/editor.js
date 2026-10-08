// Character editor: create / edit / delete / export a character, pick her
// reference face (generated portraits, or an uploaded photo after an
// explicit consent step), her chat background and her voice (designed from
// a description, step 7). All text goes through form values and
// textContent; images and audio are served by the local API.

import { api, confirmAction, ensureOk, wireDialog } from './api.js';
import { decodeToMono, micSupported, Recorder, VOICE_CLIP_SAMPLE_RATE } from './voice.js';

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
  'voiceDescription',
];

/** Voice candidates kept on screen to compare (newest first). */
const MAX_VOICE_CANDIDATES = 3;

/** Voice description placeholder per gender. */
const VOICE_HINTS = {
  female: 'Woman in her late twenties, warm and slightly husky voice, calm, a little playful, speaks softly',
  male: 'Man in his late twenties, deep and calm voice, slightly husky, relaxed, speaks slowly',
};

/** A real voice (step 7b): the server accepts 40 s raw, 30 s of speech; files are decoded by the browser. */
const VOICE_CLIP = { maxRecordMs: 35_000, maxSeconds: 40, maxFileBytes: 20 * 1024 * 1024 };
/** Header value attesting the voice is the user's own or a consenting adult's (checked by the server). */
const VOICE_CONSENT = 'own-voice-or-consenting-adult';

const $ = (id) => document.getElementById(id);

/** The two pictures of a character: element id prefix, how many candidates, wording. */
const PICTURES = {
  face: {
    prefix: 'face',
    count: 4,
    noun: 'faces',
    alt: 'Her reference face',
    empty: 'No face yet',
    pick: 'Pick the face you prefer.',
  },
  background: {
    prefix: 'bg',
    count: 2,
    noun: 'scenes',
    alt: 'Her chat background',
    empty: 'No scene yet',
    pick: 'Pick the scene you prefer.',
  },
};

/** Appearance placeholder per art style: photo words vs anime (Danbooru) tags. */
const APPEARANCE_HINTS = {
  realistic: 'woman, 26 years old, shoulder-length auburn hair, green eyes, freckles',
  anime: 'long hair, auburn hair, green eyes, freckles, slim',
};

export class CharacterEditor {
  /**
   * @param {{
   *   onSaved: (summary: object) => void,
   *   onDeleted: (id: string) => void,
   *   onPictureChanged: (id: string) => void,
   *   photosAvailable: (artStyle?: string) => boolean,
   *   faceSupport: (artStyle: string) => { ready: boolean, reason?: string } | undefined,
   *   voiceStatus: () => { available: boolean, reason?: string } | null,
   *   readAloud: () => string,
   * }} handlers
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.dialog = $('editor-dialog');
    this.form = $('editor-form');
    this.id = null;
    /** Aborts a running portrait generation when the editor closes. */
    this.generation = null;
    /** Aborts a running voice design when the editor closes. */
    this.voiceGeneration = null;
    /** Microphone recording of a real voice (step 7b). */
    this.voiceRecorder = new Recorder();
    this.voiceRecordTimer = null;
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
    // Closing also offers to keep a designed voice that was never kept.
    wireDialog(this.dialog, {
      backdropClose: false,
      canClose: async () => (await this.#offerUnkeptVoice()) && this.#confirmDiscard(),
    });
    this.dialog.addEventListener('close', () => {
      this.generation?.abort();
      this.voiceGeneration?.abort();
      this.#cancelVoiceRecording();
      // Silence any voice preview still playing.
      this.dialog.querySelectorAll('audio').forEach((a) => a.pause());
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
    for (const kind of Object.keys(PICTURES)) {
      const { prefix } = PICTURES[kind];
      $(`${prefix}-generate`).addEventListener('click', () => void this.#generate(kind));
      $(`${prefix}-remove`).addEventListener('click', () => void this.#removePicture(kind));
    }
    $('voice-generate').addEventListener('click', () => void this.#designVoice());
    $('voice-remove').addEventListener('click', () => void this.#removeVoice());
    $('voice-record').addEventListener('click', () => void this.#startVoiceRecording());
    $('voice-record-stop').addEventListener('click', () => void this.#stopVoiceRecording());
    $('voice-record-cancel').addEventListener('click', () => this.#cancelVoiceRecording());
    $('voice-upload').addEventListener('click', () => void this.#pickVoiceFile());
    $('voice-file').addEventListener('change', () => void this.#useVoiceFile());
    $('face-upload').addEventListener('click', () => void this.#askConsentThenPick());
    $('face-file').addEventListener('change', () => void this.#uploadFace());
    // The appearance hint and face note follow the art style.
    this.form
      .querySelectorAll('input[name="artStyle"]')
      .forEach((r) => r.addEventListener('change', () => this.#renderStyleHints()));
    // "Her voice" / "His voice" follow the gender.
    this.form
      .querySelectorAll('input[name="gender"]')
      .forEach((r) => r.addEventListener('change', () => this.#renderVoiceWording()));
    $('lore-add').addEventListener('click', () => {
      const item = this.#loreItem();
      $('lore-list').append(item);
      this.#updateLoreCount();
      item.querySelector('.lore-keys').focus();
    });
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
    for (const kind of Object.keys(PICTURES)) {
      this.#pictureStatus(kind, '');
      $(`${PICTURES[kind].prefix}-candidates`).hidden = true;
      $(`${PICTURES[kind].prefix}-candidates`).replaceChildren();
      this.#showPicture(kind, false);
    }
    $('editor-title').textContent = id ? 'Edit character' : 'New character';
    $('editor-delete').hidden = $('editor-export').hidden = !id;
    this.#showVoice(false);
    this.#voiceStatus('');
    $('voice-candidates').hidden = true;
    $('voice-candidates').replaceChildren();
    this.#renderVoiceWording();
    this.#renderLore([]);
    this.#renderStyleHints();
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
      for (const name of ['style', 'artStyle', 'gender']) {
        this.form.querySelector(`input[name="${name}"][value="${data.card[name]}"]`).checked = true;
      }
      this.form.elements.namedItem('background').value = data.card.background;
      this.form.elements.namedItem('backgroundScene').value = data.card.backgroundScene ?? '';
      this.#showVoice(Boolean(data.voice));
      this.#renderVoiceWording();
      this.#renderLore(data.card.lorebook ?? []);
      this.#renderStyleHints();
      this.#showPicture('face', data.hasFace);
      this.#showPicture('background', data.hasBackground);
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
    const checked = (name) => this.form.querySelector(`input[name="${name}"]:checked`).value;
    card.style = checked('style');
    card.artStyle = checked('artStyle');
    card.gender = checked('gender');
    card.background = value('background');
    card.backgroundScene = value('backgroundScene').trim();
    card.tags = value('tags')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20);
    card.voiceDescription = card.voiceDescription.trim();
    card.lorebook = this.#collectLore();
    return card;
  }

  // ------------------------------------------------------------ voice --
  // Her voice (step 7): Qwen3-TTS designs it from the description; the user
  // listens to one or more candidates and keeps one. Every message she
  // speaks is then said with that exact voice.

  /** Pronouns of the character being edited (from the gender radio). */
  #pronouns() {
    const male = this.form.querySelector('input[name="gender"]:checked')?.value === 'male';
    return male
      ? { subject: 'he', possessive: 'his', Possessive: 'His' }
      : { subject: 'she', possessive: 'her', Possessive: 'Her' };
  }

  /** "Her voice" / "His voice" in the section title and buttons. */
  #renderVoiceWording() {
    const p = this.#pronouns();
    $('voice-title').textContent = `${p.Possessive} voice`;
    const button = $('voice-generate');
    button.textContent = $('voice-candidates').children.length
      ? 'Create another voice'
      : `Create ${p.possessive} voice`;
    $('voice-current').querySelector('audio')?.setAttribute('aria-label', `${p.Possessive} voice`);
    $('voice-description').placeholder = VOICE_HINTS[p.subject === 'he' ? 'male' : 'female'];
  }

  #voiceUrl(path = '') {
    return `/api/characters/${encodeURIComponent(this.id)}/voice${path}`;
  }

  /** Her current voice: a player, or "No voice yet". */
  #showVoice(has) {
    $('voice-remove').hidden = !has;
    const box = $('voice-current');
    if (!has) {
      const span = document.createElement('span');
      span.className = 'muted small';
      span.textContent = 'No voice yet';
      box.replaceChildren(span);
      return;
    }
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.src = `${this.#voiceUrl()}?v=${Date.now()}`; // fresh after a change
    audio.setAttribute('aria-label', `${this.#pronouns().Possessive} voice`);
    box.replaceChildren(audio);
  }

  /** The voice is designed from the SAVED card (her gender) and the description in the form. */
  async #designVoice() {
    const field = $('voice-description');
    const description = field.value.trim();
    if (!description) {
      this.#voiceStatus(`Describe ${this.#pronouns().possessive} voice first.`, true);
      field.focus();
      return;
    }
    const status = this.handlers.voiceStatus();
    if (status && !status.available) {
      this.#voiceStatus(
        `${this.#pronouns().Possessive} voice is unavailable: ${status.reason ?? 'not installed'}.`,
        true,
      );
      return;
    }
    const button = $('voice-generate');
    button.disabled = true;
    const started = Date.now();
    const tick = () =>
      this.#voiceStatus(
        `Creating ${this.#pronouns().possessive} voice… ${Math.round((Date.now() - started) / 1000)} s`,
      );
    let timer;
    try {
      await this.#save();
      tick();
      timer = setInterval(tick, 1000);
      this.voiceGeneration = new AbortController();
      const res = await fetch(this.#voiceUrl('/candidates'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
        signal: this.voiceGeneration.signal,
      });
      await ensureOk(res);
      const { candidate } = await res.json();
      this.#addVoiceCandidate(candidate, description);
      this.#voiceStatus('Listen, then keep it, or create another one.');
    } catch (err) {
      this.#voiceStatus(err.name === 'AbortError' ? 'Cancelled' : err.message, err.name !== 'AbortError');
    } finally {
      clearInterval(timer);
      this.voiceGeneration = null;
      button.disabled = false;
      button.textContent = 'Create another voice';
    }
  }

  // A real voice (step 7b): recorded with the mic or taken from a file, only
  // after the user confirms it is their own or a consenting adult's. The page
  // decodes it to 24 kHz mono; the server checks it, writes down what it says
  // (Whisper) and returns a candidate, kept like a designed voice.

  /** "Whose voice is it?" @returns true when the user confirmed. */
  async #askVoiceConsent() {
    const dialog = $('voice-consent-dialog');
    $('voice-consent-check').checked = false;
    dialog.returnValue = '';
    dialog.showModal();
    const answer = await new Promise((resolve) =>
      dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }),
    );
    return answer === 'ok';
  }

  async #startVoiceRecording() {
    if (!micSupported()) {
      this.#voiceStatus('The microphone only works on http://127.0.0.1 or localhost.', true);
      return;
    }
    if (!(await this.#askVoiceConsent())) return;
    try {
      await this.#save(); // the clip belongs to a saved character
      await this.voiceRecorder.start(() => void this.#stopVoiceRecording(), VOICE_CLIP.maxRecordMs);
    } catch (err) {
      this.#voiceStatus(err.name === 'NotAllowedError' ? 'Microphone access was denied.' : err.message, true);
      return;
    }
    $('voice-read-text').textContent = this.handlers.readAloud();
    $('voice-recorder').hidden = false;
    $('voice-record').disabled = $('voice-upload').disabled = true;
    const started = Date.now();
    const tick = () => {
      $('voice-record-time').textContent = `● ${Math.round((Date.now() - started) / 1000)} s`;
    };
    tick();
    this.voiceRecordTimer = setInterval(tick, 500);
    this.#voiceStatus('Recording…');
  }

  async #stopVoiceRecording() {
    if (!this.voiceRecorder.recording) return;
    const samples = await this.voiceRecorder.stop(VOICE_CLIP_SAMPLE_RATE);
    this.#endVoiceRecordingUi();
    await this.#sendVoiceClip(samples, 'recorded');
  }

  #cancelVoiceRecording() {
    this.voiceRecorder.cancel();
    this.#endVoiceRecordingUi();
  }

  #endVoiceRecordingUi() {
    clearInterval(this.voiceRecordTimer);
    this.voiceRecordTimer = null;
    $('voice-recorder').hidden = true;
    $('voice-record').disabled = $('voice-upload').disabled = false;
  }

  async #pickVoiceFile() {
    if (await this.#askVoiceConsent()) $('voice-file').click();
  }

  async #useVoiceFile() {
    const input = $('voice-file');
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > VOICE_CLIP.maxFileBytes) {
      this.#voiceStatus('This file is too large: use a clip of 30 seconds at most.', true);
      return;
    }
    let samples;
    try {
      samples = await decodeToMono(file, VOICE_CLIP_SAMPLE_RATE);
    } catch {
      this.#voiceStatus("This file can't be read as audio (try WAV, MP3, M4A or OGG).", true);
      return;
    }
    if (samples.length > VOICE_CLIP.maxSeconds * VOICE_CLIP_SAMPLE_RATE) {
      this.#voiceStatus('This clip is too long: cut it to 30 seconds of clear speech.', true);
      return;
    }
    await this.#sendVoiceClip(samples, 'uploaded');
  }

  /** Send the decoded clip; the server answers with a candidate and what it heard. */
  async #sendVoiceClip(samples, source) {
    if (!samples.length) {
      this.#voiceStatus('Nothing was recorded.', true);
      return;
    }
    try {
      await this.#save();
      this.#voiceStatus('Checking the recording…');
      const query = new URLSearchParams({ rate: String(VOICE_CLIP_SAMPLE_RATE), source });
      const res = await fetch(`${this.#voiceUrl('/candidates')}?${query}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'x-girllm-consent': VOICE_CONSENT },
        body: samples, // raw little-endian float32
      });
      await ensureOk(res);
      const { candidate, transcript } = await res.json();
      // A real voice is a deliberate choice (and consent was given): it becomes
      // the voice right away, nothing to compare. Designed voices are compared first.
      if (await this.#keepVoice(candidate)) {
        const what = source === 'recorded' ? 'your recording' : 'this recording';
        this.#voiceStatus(`Saved: ${this.#pronouns().subject} speaks with ${what} now. Heard: “${transcript}”`);
      }
    } catch (err) {
      this.#voiceStatus(err.message, true);
    }
  }

  /** A new candidate on top of the list (the oldest ones beyond the limit go away). */
  #addVoiceCandidate(cid, description) {
    const list = $('voice-candidates');
    const li = document.createElement('li');
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = this.#voiceUrl(`/candidates/${cid}`);
    audio.setAttribute('aria-label', 'Voice option');
    const note = document.createElement('span');
    note.className = 'small muted';
    note.textContent = description;
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'secondary small';
    keep.textContent = 'Keep this voice';
    keep.addEventListener('click', () => void this.#keepVoice(cid));
    li.dataset.cid = cid;
    li.append(audio, note, keep);
    list.prepend(li);
    while (list.children.length > MAX_VOICE_CANDIDATES) list.lastElementChild.remove();
    list.hidden = false;
    // Play it right away (the browser may block it: the player is there anyway).
    audio.play().catch(() => {});
  }

  /** Make a candidate the voice. @returns true when it worked (errors are shown). */
  async #keepVoice(cid) {
    try {
      await api(this.#voiceUrl(`/candidates/${cid}`), { method: 'POST' });
      $('voice-candidates').hidden = true;
      $('voice-candidates').replaceChildren();
      this.#showVoice(true);
      this.#renderVoiceWording();
      this.#voiceStatus(`Saved: ${this.#pronouns().subject} speaks with this voice now.`);
      return true;
    } catch (err) {
      this.#voiceStatus(err.message, true);
      return false;
    }
  }

  /**
   * Closing with designed voices that were never kept: offer to keep the
   * latest one, instead of silently getting a default voice later.
   * @returns true (the editor closes either way)
   */
  async #offerUnkeptVoice() {
    const latest = $('voice-candidates').firstElementChild?.dataset.cid;
    if (!latest || !this.id) return true;
    const p = this.#pronouns();
    const keep = await confirmAction({
      title: 'Keep the voice you created?',
      text: `You created a voice but didn't keep it. Without one, a default voice is made the first time ${p.subject} speaks.`,
      action: 'Keep the latest',
      cancel: "Don't keep",
      danger: false,
    });
    if (keep) await this.#keepVoice(latest);
    $('voice-candidates').replaceChildren(); // asked once
    return true;
  }

  async #removeVoice() {
    try {
      await api(this.#voiceUrl(), { method: 'DELETE' });
      this.#showVoice(false);
      this.#voiceStatus('Removed. A new voice will be made from the description the next time she speaks.');
    } catch (err) {
      this.#voiceStatus(err.message, true);
    }
  }

  #voiceStatus(text, isError = false) {
    const node = $('voice-status');
    node.textContent = text;
    node.classList.toggle('error-text', isError);
  }

  // --------------------------------------------------------- lorebook --

  /** One editable entry. Extra fields (order, case) ride along in data attributes. */
  #loreItem(entry = { name: '', keys: [], content: '', enabled: true, constant: false }) {
    const li = document.createElement('li');
    li.className = 'lore-entry';
    li.dataset.order = String(entry.insertion_order ?? 100);
    li.dataset.caseSensitive = entry.case_sensitive ? '1' : '';
    li.dataset.enabled = entry.enabled === false ? '' : '1';

    const keys = document.createElement('input');
    keys.className = 'lore-keys';
    keys.maxLength = 1000;
    keys.placeholder = 'Keywords, comma separated (sister, Chloé, Lyon)';
    keys.setAttribute('aria-label', 'Keywords');
    keys.value = entry.keys.join(', ');

    const content = document.createElement('textarea');
    content.className = 'lore-content';
    content.rows = 3;
    content.maxLength = 5000;
    content.placeholder = "{{char}}'s older sister Chloé is a nurse in Lyon; they call every Sunday.";
    content.setAttribute('aria-label', 'What she knows');
    content.value = entry.content;

    const constant = document.createElement('label');
    constant.className = 'check small';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'lore-constant';
    box.checked = Boolean(entry.constant);
    constant.append(box, document.createTextNode(' Always included'));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost danger small';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      li.remove();
      this.#updateLoreCount();
    });

    const row = document.createElement('div');
    row.className = 'lore-row';
    row.append(constant, remove);
    li.append(keys, content, row);
    if (entry.name) li.dataset.name = entry.name;
    return li;
  }

  #renderLore(entries) {
    $('lore-list').replaceChildren(...entries.map((e) => this.#loreItem(e)));
    $('lore-section').open = entries.length > 0;
    this.#updateLoreCount();
  }

  #updateLoreCount() {
    const n = $('lore-list').children.length;
    $('lore-count').textContent = n ? `(${n})` : '';
  }

  #collectLore() {
    return [...$('lore-list').children]
      .map((li) => ({
        name: li.dataset.name ?? '',
        keys: li
          .querySelector('.lore-keys')
          .value.split(',')
          .map((k) => k.trim())
          .filter(Boolean)
          .slice(0, 30),
        content: li.querySelector('.lore-content').value.trim(),
        enabled: li.dataset.enabled === '1',
        constant: li.querySelector('.lore-constant').checked,
        case_sensitive: li.dataset.caseSensitive === '1',
        insertion_order: Number(li.dataset.order) || 100,
      }))
      .filter((e) => e.content); // an empty entry is just ignored
  }

  /** Under the face: is it used in her photos, and if not, why. */
  /**
   * Everything that depends on the art style: the appearance hint, whether
   * pictures can be generated, and whether the face is kept in her photos.
   */
  #renderStyleHints() {
    const artStyle = this.form.querySelector('input[name="artStyle"]:checked').value;
    this.form.elements.namedItem('appearance').placeholder = APPEARANCE_HINTS[artStyle];
    $('appearance-hint').textContent =
      artStyle === 'anime'
        ? 'Anime tags, comma separated: hair, eyes, build, distinctive details. No age or clothes.'
        : 'Photo words, comma separated: age, hair, eyes, build, distinctive details. No clothes.';

    const available = this.handlers.photosAvailable(artStyle);
    for (const { prefix } of Object.values(PICTURES)) {
      $(`${prefix}-generate`).disabled = !available;
      $(`${prefix}-generate`).title = available
        ? ''
        : artStyle === 'anime'
          ? 'Anime pictures need the anime model (npm run setup:images -- --anime)'
          : 'Photos are not available right now';
    }
    const support = this.handlers.faceSupport(artStyle);
    $('face-usage').textContent = support?.ready
      ? 'Her avatar, and the face kept in every photo she sends.'
      : `Her avatar. To keep this face in her photos: ${support?.reason ?? 'photos are not available right now'}.`;
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

  // --------------------------------------------------------- pictures --
  // Two pictures per character, handled the same way: the reference face
  // (element ids "face-…") and the chat background ("bg-…").

  #pictureUrl(kind) {
    // The query string defeats the browser cache after a change.
    return `/api/characters/${encodeURIComponent(this.id)}/${kind}?v=${Date.now()}`;
  }

  #showPicture(kind, has) {
    const { prefix, empty, alt } = PICTURES[kind];
    const preview = $(`${prefix}-preview`);
    $(`${prefix}-remove`).hidden = !has;
    if (!has) {
      const span = document.createElement('span');
      span.className = 'muted small';
      span.textContent = empty;
      preview.replaceChildren(span);
      return;
    }
    const img = document.createElement('img');
    img.src = this.#pictureUrl(kind);
    img.alt = alt;
    preview.replaceChildren(img);
  }

  #showFace(has) {
    this.#showPicture('face', has);
  }

  /** Pictures use the SAVED card (appearance, style, scenario): save the form first. */
  async #generate(kind) {
    const { prefix, count, noun, pick } = PICTURES[kind];
    const appearance = this.form.elements.namedItem('appearance').value.trim();
    if (!appearance) {
      this.#pictureStatus(kind, 'Describe her appearance first.', true);
      this.form.elements.namedItem('appearance').focus();
      return;
    }
    const button = $(`${prefix}-generate`);
    button.disabled = true;
    const started = Date.now();
    const tick = () =>
      this.#pictureStatus(kind, `Generating ${count} ${noun}… ${Math.round((Date.now() - started) / 1000)} s`);
    let timer;
    try {
      await this.#save();
      tick();
      timer = setInterval(tick, 1000);
      this.generation = new AbortController();
      const res = await fetch(`/api/characters/${encodeURIComponent(this.id)}/${kind}/candidates`, {
        method: 'POST',
        signal: this.generation.signal,
      });
      await ensureOk(res);
      const { candidates } = await res.json();
      this.#showCandidates(kind, candidates);
      this.#pictureStatus(kind, pick);
    } catch (err) {
      this.#pictureStatus(kind, err.name === 'AbortError' ? 'Cancelled' : err.message, err.name !== 'AbortError');
    } finally {
      clearInterval(timer);
      this.generation = null;
      this.#renderStyleHints(); // re-enables the buttons if pictures are available
    }
  }

  #showCandidates(kind, ids) {
    const { prefix, alt } = PICTURES[kind];
    const box = $(`${prefix}-candidates`);
    box.replaceChildren(
      ...ids.map((cid, i) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-label', `Use option ${i + 1}`);
        const img = document.createElement('img');
        img.src = `/api/characters/${encodeURIComponent(this.id)}/${kind}/candidates/${cid}`;
        img.alt = `${alt}, option ${i + 1}`;
        button.append(img);
        button.addEventListener('click', () => void this.#pickCandidate(kind, cid));
        return button;
      }),
    );
    box.hidden = false;
  }

  async #pickCandidate(kind, cid) {
    await this.#run(async () => {
      await api(`/api/characters/${encodeURIComponent(this.id)}/${kind}/candidates/${cid}`, { method: 'POST' });
      $(`${PICTURES[kind].prefix}-candidates`).hidden = true;
      this.#showPicture(kind, true);
      this.#pictureStatus(kind, 'Saved');
      this.handlers.onPictureChanged(this.id);
    }, kind);
  }

  async #removePicture(kind) {
    await this.#run(async () => {
      await api(`/api/characters/${encodeURIComponent(this.id)}/${kind}`, { method: 'DELETE' });
      this.#showPicture(kind, false);
      this.#pictureStatus(kind, 'Removed');
      this.handlers.onPictureChanged(this.id);
    }, kind);
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
      this.#pictureStatus('face', 'This image is larger than 10 MB.', true);
      return;
    }
    await this.#run(async () => {
      await this.#save();
      this.#pictureStatus('face', 'Uploading…');
      const res = await fetch(`/api/characters/${encodeURIComponent(this.id)}/face`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'x-girllm-consent': 'adult-and-consenting' },
        body: file,
      });
      await ensureOk(res);
      this.#showFace(true);
      this.#pictureStatus('face', 'Face saved (metadata removed)');
      this.handlers.onPictureChanged(this.id);
    }, 'face');
  }

  // ---------------------------------------------------------- helpers --

  /** Run an action, reporting errors in the footer (or in a picture section). */
  async #run(action, kind = null) {
    try {
      await action();
    } catch (err) {
      if (kind) this.#pictureStatus(kind, err.message, true);
      else this.#status(err.message, true);
    }
  }

  #status(text, isError = false) {
    const node = $('editor-status');
    node.textContent = text;
    node.classList.toggle('error-text', isError);
  }

  #pictureStatus(kind, text, isError = false) {
    const node = $(`${PICTURES[kind].prefix}-status`);
    node.textContent = text;
    node.classList.toggle('error-text', isError);
  }
}
