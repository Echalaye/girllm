// Settings drawer: edits the live settings (GET/PUT /api/settings).
// .env holds the defaults; anything saved here overrides them until
// "Restore .env values". Changes apply to the next message, no restart.

import { api, confirmAction, el, wireDialog } from './api.js';

/**
 * Form description. `type`: text | textarea | number | range | select.
 * For selects, `options(serverOptions, current)` returns [value, label, disabled?][].
 */
const GROUPS = [
  {
    title: 'Conversation',
    fields: [
      { key: 'userName', label: 'Your name', type: 'text', maxLength: 64 },
      {
        key: 'replyLanguage',
        label: 'Language of her replies',
        type: 'text',
        maxLength: 40,
        hint: 'For example "French". Empty: she answers in the language you use.',
      },
      {
        key: 'llmModel',
        label: 'Chat model',
        type: 'select',
        options: (o, current) => withCurrent(o.models, current).map((m) => [m, m]),
        hint: 'Models installed in Ollama. Switching frees the previous one from the GPU.',
      },
      {
        key: 'temperature',
        label: 'Creativity',
        type: 'range',
        min: 0,
        max: 2,
        step: 0.05,
        hint: 'Higher is more surprising, lower is more consistent.',
      },
      { key: 'minP', label: 'Min-p', type: 'range', min: 0, max: 0.5, step: 0.01 },
      { key: 'topP', label: 'Top-p', type: 'range', min: 0.05, max: 1, step: 0.01 },
      { key: 'repeatPenalty', label: 'Repetition penalty', type: 'range', min: 0.8, max: 1.5, step: 0.01 },
      { key: 'maxReplyTokens', label: 'Longest reply (tokens)', type: 'number', min: 16, max: 2048, step: 1 },
      {
        key: 'proactiveAfterMinutes',
        label: 'She writes first after (minutes of silence)',
        type: 'number',
        min: 0,
        max: 10080,
        step: 5,
        hint: 'When you are away or quiet that long, she sends a message on her own (once). 0: never.',
      },
    ],
  },
  {
    title: 'Voice',
    fields: [
      {
        key: 'ttsVoice',
        label: 'Her voice',
        type: 'select',
        options: (o) =>
          o.voices.map((v) => [v.id, v.installed ? v.description : `${v.description} (not installed)`, !v.installed]),
        hint: 'Install more voices with: npm run setup:voice',
      },
      { key: 'ttsSpeed', label: 'Speaking speed', type: 'range', min: 0.5, max: 2, step: 0.05 },
      {
        key: 'sttLanguage',
        label: 'Language you speak',
        type: 'select',
        options: () => [
          ['', 'Detect automatically'],
          ['fr', 'French'],
          ['en', 'English'],
          ['es', 'Spanish'],
          ['de', 'German'],
          ['it', 'Italian'],
        ],
      },
    ],
  },
  {
    title: 'Photos',
    fields: [
      {
        key: 'photoFrequency',
        label: 'Photos she sends on her own',
        type: 'select',
        options: () => [
          ['off', 'Never (only when you press the camera)'],
          ['rare', 'Sometimes'],
          ['often', 'Often'],
        ],
        hint: 'When you ask her for a photo in a message, she can always send one.',
      },
      {
        key: 'imageFaceWeight',
        label: 'Keep her reference face',
        type: 'range',
        min: 0,
        max: 1,
        step: 0.05,
        hint: '0 turns it off. 0.6–0.8 keeps her face while leaving the scene free. Needs: npm run setup:images',
      },
      {
        key: 'imageCheckpoint',
        label: 'Image model',
        type: 'select',
        options: (o, current) => [['', 'None (photos off)'], ...withCurrent(o.checkpoints, current).map((c) => [c, c])],
        hint: 'Checkpoints found in ComfyUI.',
      },
      { key: 'imageStyle', label: 'Style added to every photo', type: 'textarea', maxLength: 500 },
      { key: 'imageNegative', label: 'Things to avoid', type: 'textarea', maxLength: 1000 },
      { key: 'imageSteps', label: 'Steps', type: 'number', min: 1, max: 100, step: 1 },
      { key: 'imageCfg', label: 'Prompt strength (CFG)', type: 'range', min: 1, max: 12, step: 0.5 },
      { key: 'imageSampler', label: 'Sampler', type: 'text', maxLength: 50 },
      { key: 'imageScheduler', label: 'Scheduler', type: 'text', maxLength: 50 },
      {
        key: 'imageHiresScale',
        label: 'Detail pass upscale',
        type: 'range',
        min: 1,
        max: 2,
        step: 0.05,
        hint: '1 turns the detail pass off. Higher is sharper but slower.',
      },
      { key: 'imageHiresDenoise', label: 'Detail pass strength', type: 'range', min: 0.1, max: 0.7, step: 0.01 },
      { key: 'imageHiresSteps', label: 'Detail pass steps', type: 'number', min: 4, max: 60, step: 1 },
    ],
  },
];

const FIELDS = GROUPS.flatMap((g) => g.fields);

/** Keep the current value selectable even if the server didn't list it. */
function withCurrent(list, current) {
  return current && !list.includes(current) ? [current, ...list] : list;
}

export class SettingsPanel {
  /** @param {{ onSaved: (values: object) => void }} handlers */
  constructor(handlers) {
    this.handlers = handlers;
    this.dialog = document.getElementById('settings-dialog');
    this.form = document.getElementById('settings-form');
    this.status = document.getElementById('settings-status');
    this.values = null;
    // Like the editor: no closing on a stray click outside, and a
    // confirmation before discarding unsaved changes.
    wireDialog(this.dialog, { backdropClose: false, canClose: () => this.#confirmDiscard() });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.#save();
    });
    document.getElementById('settings-reset').addEventListener('click', () => void this.#reset());
  }

  async open() {
    this.status.textContent = 'Loading…';
    this.dialog.showModal();
    try {
      this.#render(await api('/api/settings'));
      this.status.textContent = '';
    } catch (err) {
      this.status.textContent = err.message;
    }
  }

  #render(view) {
    this.values = view.values;
    if (view.options) this.options = view.options;
    const overridden = new Set(view.overridden);
    this.form.replaceChildren(
      ...GROUPS.map((group) => {
        const fieldset = el('fieldset');
        fieldset.append(el('legend', '', group.title));
        for (const field of group.fields) fieldset.append(this.#field(field, overridden.has(field.key)));
        return fieldset;
      }),
    );
  }

  #field(field, isOverridden) {
    const value = this.values[field.key];
    const id = `setting-${field.key}`;
    const wrap = el('div', `field${isOverridden ? ' overridden' : ''}`);
    const label = el('label', '', field.label);
    label.htmlFor = id;
    // .field > span gets the label style: wrap the label text.
    const caption = el('span');
    caption.append(label);
    wrap.append(caption);

    let input;
    if (field.type === 'select') {
      input = el('select');
      for (const [v, text, disabled] of field.options(this.options, value)) {
        const opt = el('option', '', text);
        opt.value = v;
        opt.disabled = Boolean(disabled) && v !== value;
        input.append(opt);
      }
      input.value = value;
    } else if (field.type === 'textarea') {
      input = el('textarea');
      input.rows = 2;
      input.maxLength = field.maxLength;
      input.value = value;
    } else {
      input = el('input');
      input.type = field.type;
      for (const attr of ['min', 'max', 'step', 'maxLength']) if (field[attr] !== undefined) input[attr] = field[attr];
      input.value = String(value);
    }
    input.id = id;
    input.name = field.key;

    if (field.type === 'range') {
      const row = el('div', 'range-row');
      const out = el('output', '', String(value));
      out.htmlFor = id;
      input.addEventListener('input', () => (out.textContent = input.value));
      row.append(input, out);
      wrap.append(row);
    } else {
      wrap.append(input);
    }
    if (field.hint) {
      const hint = el('span', 'hint', field.hint);
      hint.id = `${id}-hint`;
      input.setAttribute('aria-describedby', hint.id);
      wrap.append(hint);
    }
    return wrap;
  }

  async #confirmDiscard() {
    if (!this.values || Object.keys(this.#patch()).length === 0) return true;
    return confirmAction({
      title: 'Discard your changes?',
      text: 'The settings you changed have not been saved.',
      action: 'Discard',
    });
  }

  /** Only send what changed: unchanged keys stay at their current origin (.env or saved). */
  #patch() {
    const patch = {};
    for (const field of FIELDS) {
      const input = this.form.elements.namedItem(field.key);
      if (!input) continue;
      const numeric = field.type === 'number' || field.type === 'range';
      const value = numeric ? Number(input.value) : input.value.trim();
      if (value !== this.values[field.key]) patch[field.key] = value;
    }
    return patch;
  }

  async #save() {
    const patch = this.#patch();
    if (Object.keys(patch).length === 0) {
      this.dialog.close();
      return;
    }
    this.status.textContent = 'Saving…';
    try {
      const view = await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
      this.#render(view);
      this.status.textContent = 'Saved';
      this.handlers.onSaved(view.values);
    } catch (err) {
      this.status.textContent = err.message;
    }
  }

  async #reset() {
    this.status.textContent = 'Restoring…';
    try {
      const view = await api('/api/settings/reset', { method: 'POST', body: '{}' });
      this.#render(view);
      this.status.textContent = 'Restored the .env values';
      this.handlers.onSaved(view.values);
    } catch (err) {
      this.status.textContent = err.message;
    }
  }
}
