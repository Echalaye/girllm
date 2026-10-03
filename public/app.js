// girllm front-end — dependency-free ES module.
// Security: all model/user text is inserted with textContent (never
// innerHTML), so a reply containing HTML can't inject script.

import { SentenceSplitter } from './speech.js';
import { micSupported, Recorder, Speaker } from './voice.js';

const $ = (id) => document.getElementById(id);
const els = {
  select: $('character-select'),
  sessionSelect: $('session-select'),
  newChat: $('new-chat'),
  deleteChat: $('delete-chat'),
  openMemory: $('open-memory'),
  memoryDialog: $('memory-dialog'),
  closeMemory: $('close-memory'),
  memorySummary: $('memory-summary'),
  memoryMood: $('memory-mood'),
  memoryForm: $('memory-form'),
  memoryCategory: $('memory-category'),
  memoryContent: $('memory-content'),
  memoryList: $('memory-list'),
  status: $('status'),
  messages: $('messages'),
  form: $('composer'),
  input: $('input'),
  send: $('send'),
  stop: $('stop'),
  regenerate: $('regenerate'),
  mic: $('mic'),
  photo: $('photo'),
  voiceToggle: $('voice-toggle'),
};

const state = {
  userName: 'You',
  characterName: '',
  characterId: null,
  sessionId: null,
  /** AbortController of the running generation, if any. */
  controller: null,
  /** Read replies aloud (persisted per browser). */
  speakReplies: false,
  ttsAvailable: false,
};

const recorder = new Recorder();
const speaker = new Speaker(async (text) => {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (res.status === 204) return null; // nothing speakable (e.g. only *actions*)
  if (!res.ok) throw new Error(`TTS failed (${res.status})`);
  return res.blob();
});

// ---------- small utilities ----------

/** localStorage may be unavailable (private mode…): never let it crash. */
const store = {
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

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    // Only send a JSON content type when there is a body (Fastify rejects
    // an empty body declared as JSON).
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers ?? {}) } : options.headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

/** Short local date/time for chat lists. */
function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/** Render roleplay text: *actions* become <em>, everything else is plain text. */
function renderText(container, text) {
  container.replaceChildren();
  for (const part of text.split(/(\*[^*\n]+\*)/g)) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
      const em = document.createElement('em');
      em.textContent = part.slice(1, -1);
      container.append(em);
    } else {
      container.append(document.createTextNode(part));
    }
  }
}

function addMessage(role, text, { pending = false, imageId = null } = {}) {
  const wrap = document.createElement('article');
  wrap.className = `msg ${role}${pending ? ' pending' : ''}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = role === 'user' ? state.userName : state.characterName;
  const body = document.createElement('div');
  renderText(body, text);
  wrap.append(who);
  if (imageId) wrap.append(photoElement(imageId));
  wrap.append(body);
  els.messages.append(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;
  return { wrap, body };
}

/** A photo she sent: thumbnail in the bubble, click to open full size. */
function photoElement(imageId) {
  const url = `/api/images/${encodeURIComponent(imageId)}`;
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.className = 'photo-link';
  const img = document.createElement('img');
  img.src = url;
  img.alt = `Photo from ${state.characterName}`;
  img.loading = 'lazy';
  img.className = 'photo';
  // Keep the chat scrolled to the bottom once the image has its real size.
  img.addEventListener('load', () => {
    if (link.closest('.msg') === els.messages.lastElementChild) els.messages.scrollTop = els.messages.scrollHeight;
  });
  link.append(img);
  return link;
}

function renderSession(session) {
  els.messages.replaceChildren();
  for (const m of session.messages) addMessage(m.role, m.content, { imageId: m.imageId });
}

function setBusy(busy) {
  for (const el of [
    els.send,
    els.regenerate,
    els.newChat,
    els.deleteChat,
    els.select,
    els.sessionSelect,
    els.mic,
    els.photo,
  ]) {
    el.disabled = busy;
  }
  els.stop.hidden = !busy;
}

// ---------- SSE over fetch ----------

/** Parse an SSE byte stream into {event, data} objects. */
async function* readSse(body) {
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

/** POST to a streaming endpoint and render tokens into a new bubble. */
async function streamInto(path, payload) {
  state.controller = new AbortController();
  setBusy(true);
  setStatus(`${state.characterName} is typing…`);
  const bubble = addMessage('assistant', '', { pending: true });
  let text = '';
  // Speak sentence by sentence while the reply is still being written.
  speaker.stop();
  const splitter = state.speakReplies ? new SentenceSplitter() : null;

  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: state.controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    for await (const { event, data } of readSse(res.body)) {
      if (event === 'token') {
        text += data.text;
        renderText(bubble.body, text);
        splitter?.push(data.text).forEach((sentence) => speaker.enqueue(sentence));
        els.messages.scrollTop = els.messages.scrollHeight;
      } else if (event === 'error') {
        throw new Error(data.message);
      } else if (event === 'done') {
        splitter?.flush().forEach((sentence) => speaker.enqueue(sentence));
        const note = data.droppedMessages ? ` · ${data.droppedMessages} old messages out of context` : '';
        setStatus(`~${data.estimatedPromptTokens} prompt tokens${note}`);
      }
    }
  } catch (err) {
    speaker.stop();
    if (err.name === 'AbortError') setStatus('Stopped');
    else setStatus(err.message, true);
  } finally {
    bubble.wrap.classList.remove('pending');
    if (!text) bubble.wrap.remove();
    state.controller = null;
    setBusy(false);
    els.input.focus();
    void refreshSessionList(); // the title appears after the first message
  }
}

// ---------- chats ----------

/** Show a session (already fetched) and remember it for the next visit. */
function showSession(session, character) {
  state.sessionId = session.id;
  state.characterId = character.id;
  state.characterName = character.name;
  els.select.value = character.id;
  store.set('girllm.sessionId', session.id);
  store.set('girllm.characterId', character.id);
  renderSession(session);
}

async function startSession(characterId) {
  const { session, character } = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ characterId }),
  });
  showSession(session, character);
  await refreshSessionList();
  setStatus('');
}

/** Open an existing chat. @returns false if it no longer exists. */
async function openSession(sessionId) {
  try {
    const { session, character } = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
    showSession(session, character);
    await refreshSessionList();
    return true;
  } catch {
    return false;
  }
}

/** Switch character: reopen its latest chat, or start one. */
async function selectCharacter(characterId) {
  const sessions = await api(`/api/characters/${encodeURIComponent(characterId)}/sessions`);
  if (!(sessions.length && (await openSession(sessions[0].id)))) await startSession(characterId);
}

async function refreshSessionList() {
  if (!state.characterId) return;
  const sessions = await api(`/api/characters/${encodeURIComponent(state.characterId)}/sessions`).catch(() => []);
  els.sessionSelect.replaceChildren(
    ...sessions.map((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.title ?? 'New chat'} · ${formatDate(s.updatedAt)}`;
      return opt;
    }),
  );
  els.sessionSelect.value = state.sessionId;
}

async function deleteCurrentChat() {
  if (!state.sessionId) return;
  // Native confirm is fine here: destructive, rare, and needs no styling.
  if (!window.confirm('Delete this chat? Long-term memories are kept.')) return;
  await api(`/api/sessions/${state.sessionId}`, { method: 'DELETE' });
  store.set('girllm.sessionId', '');
  await selectCharacter(state.characterId);
  setStatus('Chat deleted');
}

// ---------- messages ----------

async function sendMessage() {
  const text = els.input.value.trim();
  if (!text || !state.sessionId || state.controller) return;
  els.input.value = '';
  addMessage('user', text);
  await streamInto(`/api/sessions/${state.sessionId}/messages`, { text });
}

async function regenerate() {
  if (!state.sessionId || state.controller) return;
  const last = els.messages.lastElementChild;
  // Only remove the last bubble if it is a reply (never the user's message).
  if (last?.classList.contains('assistant') && els.messages.children.length > 1) last.remove();
  await streamInto(`/api/sessions/${state.sessionId}/regenerate`);
}

// ---------- memory panel ----------

const CATEGORY_LABELS = { user: 'You', character: 'Her', relationship: 'Us', event: 'Event' };

async function renderMemoryPanel() {
  const [{ session }, memories] = await Promise.all([
    api(`/api/sessions/${state.sessionId}`),
    api(`/api/characters/${encodeURIComponent(state.characterId)}/memories`),
  ]);
  els.memorySummary.textContent =
    session.summary || 'Nothing summarized yet: the conversation still fits in the context.';
  els.memoryMood.textContent = session.mood ? `Current mood: ${session.mood}` : '';

  if (memories.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No memories yet. They are extracted automatically as you chat.';
    els.memoryList.replaceChildren(li);
    return;
  }
  els.memoryList.replaceChildren(
    ...memories.map((m) => {
      const li = document.createElement('li');
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = CATEGORY_LABELS[m.category] ?? m.category;
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = m.content;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = 'Forget';
      del.addEventListener('click', async () => {
        await api(`/api/memories/${m.id}`, { method: 'DELETE' }).catch((e) => setStatus(e.message, true));
        await renderMemoryPanel();
      });
      li.append(tag, text, del);
      return li;
    }),
  );
}

async function addMemory() {
  const content = els.memoryContent.value.trim();
  if (content.length < 3) return;
  try {
    await api(`/api/characters/${encodeURIComponent(state.characterId)}/memories`, {
      method: 'POST',
      body: JSON.stringify({ category: els.memoryCategory.value, content }),
    });
    els.memoryContent.value = '';
  } catch (err) {
    setStatus(err.message, true);
  }
  await renderMemoryPanel();
}

// ---------- photos ----------

/**
 * Ask her for a photo. Text typed in the box becomes the request
 * ("a selfie at the beach"); empty = she decides.
 */
async function sendPhoto() {
  if (!state.sessionId || state.controller) return;
  const request = els.input.value.trim();
  els.input.value = '';
  // Shown right away; saved by the server only if the photo succeeds.
  const requestBubble = request ? addMessage('user', `📷 ${request}`) : null;

  state.controller = new AbortController();
  setBusy(true);
  speaker.stop();
  const bubble = addMessage('assistant', '', { pending: true });
  const started = Date.now();
  const tick = () => {
    const seconds = Math.round((Date.now() - started) / 1000);
    bubble.body.textContent = `📷 ${state.characterName} is taking a photo… ${seconds} s`;
  };
  tick();
  const timer = setInterval(tick, 1000);
  setStatus('Generating the photo (the chat model is paused meanwhile)');

  try {
    const res = await fetch(`/api/sessions/${state.sessionId}/photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request }),
      signal: state.controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    bubble.wrap.remove();
    addMessage('assistant', body.message.content, { imageId: body.message.imageId });
    if (state.speakReplies) speaker.enqueue(body.message.content);
    setStatus(`Photo ready in ${Math.round((Date.now() - started) / 1000)} s`);
  } catch (err) {
    bubble.wrap.remove();
    // Nothing was saved: remove the request bubble and give the text back for a retry.
    requestBubble?.wrap.remove();
    if (request) els.input.value = request;
    setStatus(err.name === 'AbortError' ? 'Photo cancelled' : err.message, err.name !== 'AbortError');
  } finally {
    clearInterval(timer);
    state.controller = null;
    setBusy(false);
    void refreshSessionList();
  }
}

/** Show the photo button unless photos are disabled in the config. */
async function initPhotos() {
  const status = await api('/api/images/status').catch(() => null);
  const disabled = !status || String(status.reason ?? '').startsWith('disabled');
  els.photo.hidden = disabled;
  els.photo.title = status?.available
    ? 'Ask for a photo (type what you want first, or leave empty)'
    : `Photos unavailable: ${status?.reason ?? 'unknown'}`;
}

// ---------- voice ----------

function renderVoiceToggle() {
  els.voiceToggle.textContent = state.speakReplies ? '🔊 Voice on' : '🔈 Voice off';
  els.voiceToggle.setAttribute('aria-pressed', String(state.speakReplies));
}

function toggleSpeakReplies() {
  state.speakReplies = !state.speakReplies;
  store.set('girllm.speakReplies', state.speakReplies ? '1' : '');
  if (!state.speakReplies) speaker.stop();
  renderVoiceToggle();
}

/** Mic button: first click records, second click transcribes and sends. */
async function toggleRecording() {
  if (!recorder.recording) {
    speaker.stop(); // talking over her stops her
    try {
      await recorder.start(() => void toggleRecording());
    } catch (err) {
      setStatus(err.name === 'NotAllowedError' ? 'Microphone access was denied' : err.message, true);
      return;
    }
    els.mic.classList.add('recording');
    els.mic.textContent = '■ Stop';
    setStatus('Listening… click Stop when you are done');
    return;
  }

  els.mic.classList.remove('recording');
  els.mic.textContent = '🎤';
  els.mic.disabled = true;
  setStatus('Transcribing…');
  try {
    const samples = await recorder.stop();
    const res = await fetch('/api/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: samples, // Float32Array: sent as raw little-endian float32
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    if (!body.text) {
      setStatus("I didn't catch anything, try again");
      return;
    }
    setStatus('');
    els.input.value = body.text;
    await sendMessage();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    els.mic.disabled = Boolean(state.controller);
  }
}

/** Show voice controls only for engines whose models are installed. */
async function initVoice() {
  const voice = await api('/api/voice').catch(() => null);
  state.ttsAvailable = Boolean(voice?.tts.available);
  els.voiceToggle.hidden = !state.ttsAvailable;
  state.speakReplies = state.ttsAvailable && store.get('girllm.speakReplies') === '1';
  renderVoiceToggle();

  const sttReady = Boolean(voice?.stt.available);
  els.mic.hidden = !sttReady;
  if (sttReady && !micSupported()) {
    els.mic.disabled = true;
    els.mic.title = 'The microphone only works on http://127.0.0.1 or localhost (secure context)';
  }
}

// ---------- wiring ----------

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  void sendMessage();
});
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void sendMessage();
  }
});
els.stop.addEventListener('click', () => {
  state.controller?.abort();
  speaker.stop();
});
els.mic.addEventListener('click', () => void toggleRecording());
els.photo.addEventListener('click', () => void sendPhoto());
els.voiceToggle.addEventListener('click', toggleSpeakReplies);
els.regenerate.addEventListener('click', () => void regenerate());
const report = (promise) => void promise.catch((e) => setStatus(e.message, true));
els.newChat.addEventListener('click', () => report(startSession(els.select.value)));
els.select.addEventListener('change', () => report(selectCharacter(els.select.value)));
els.sessionSelect.addEventListener('change', () => report(openSession(els.sessionSelect.value)));
els.deleteChat.addEventListener('click', () => report(deleteCurrentChat()));
els.openMemory.addEventListener('click', () => {
  els.memoryDialog.showModal();
  report(renderMemoryPanel());
});
els.closeMemory.addEventListener('click', () => els.memoryDialog.close());
els.memoryForm.addEventListener('submit', (e) => {
  e.preventDefault();
  report(addMemory());
});

async function init() {
  try {
    const [config, characters, health] = await Promise.all([
      api('/api/config'),
      api('/api/characters'),
      api('/api/health').catch(() => null),
    ]);
    state.userName = config.userName;
    els.openMemory.hidden = !config.memoryEnabled;
    await Promise.all([initVoice(), initPhotos()]);

    if (characters.length === 0) {
      setStatus('No character cards found in the characters folder.', true);
      return;
    }
    // Disambiguate cards sharing a name (e.g. "Aria" and its French version).
    const nameCount = new Map();
    for (const c of characters) nameCount.set(c.name, (nameCount.get(c.name) ?? 0) + 1);
    for (const c of characters) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = nameCount.get(c.name) > 1 ? `${c.name} (${c.id})` : c.name;
      els.select.append(opt);
    }

    const savedSession = store.get('girllm.sessionId');
    if (!(savedSession && (await openSession(savedSession)))) {
      const savedChar = store.get('girllm.characterId');
      const initial = characters.some((c) => c.id === savedChar) ? savedChar : characters[0].id;
      await selectCharacter(initial);
    }

    if (health && health.status !== 'ok') setStatus(`LLM backend unreachable: ${health.llm.error}`, true);
    els.input.focus();
  } catch (err) {
    setStatus(err.message, true);
  }
}

void init();
