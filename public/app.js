// girllm front-end — dependency-free ES modules.
//
// Security: every piece of model/user text is inserted with textContent
// (never innerHTML), so a reply containing HTML can't inject script; the
// CSP only allows scripts, styles, images and media from this origin.
//
// Modules: api.js (fetch/SSE helpers), settings.js (settings drawer),
// editor.js (character editor), voice.js (push-to-talk + playback),
// call.js + vad.js (hands-free call), speech.js (sentence splitter).

import { api, ApiError, confirmAction, el, ensureOk, readSse, store, wireDialog } from './api.js';
import { CallSession, callSupported } from './call.js';
import { CharacterEditor } from './editor.js';
import { SettingsPanel } from './settings.js';
import { SentenceSplitter } from './speech.js';
import { micSupported, Recorder, Speaker } from './voice.js';

const $ = (id) => document.getElementById(id);
const els = {
  sidebar: $('sidebar'),
  characterList: $('character-list'),
  sessionList: $('session-list'),
  chatsWith: $('chats-with'),
  herName: $('her-name'),
  presenceLine: $('presence-line'),
  portrait: $('portrait'),
  messages: $('messages'),
  status: $('status'),
  form: $('composer'),
  input: $('input'),
  send: $('send'),
  stop: $('stop'),
  regenerate: $('regenerate'),
  mic: $('mic'),
  photo: $('photo'),
  voiceToggle: $('voice-toggle'),
  call: $('call'),
  callScreen: $('call-screen'),
  callPortrait: $('call-portrait'),
  callName: $('call-name'),
  callState: $('call-state'),
  callTranscript: $('call-transcript'),
  memoryDialog: $('memory-dialog'),
  memorySummary: $('memory-summary'),
  memoryMood: $('memory-mood'),
  memoryForm: $('memory-form'),
  memoryCategory: $('memory-category'),
  memoryContent: $('memory-content'),
  memoryList: $('memory-list'),
  themeToggle: $('theme-toggle'),
};

const state = {
  userName: 'You',
  /** Character summaries from /api/characters (id, name, style, hasFace…). */
  characters: [],
  characterId: null,
  sessionId: null,
  /** Current chat's mood (shown under her name when nothing else is). */
  mood: '',
  /** AbortController of the running generation, if any. */
  controller: null,
  /** Read replies aloud (persisted per browser). */
  speakReplies: false,
  photosAvailable: false,
  /** Running hands-free call, if any. */
  call: null,
};

const current = () => state.characters.find((c) => c.id === state.characterId);
const herName = () => current()?.name ?? '';

// ------------------------------------------------------------- audio --

const recorder = new Recorder();
const speaker = new Speaker(async (text) => {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (res.status === 204) return null; // nothing speakable (only *actions*)
  await ensureOk(res);
  return res.blob();
});

/** POST 16 kHz float32 samples to the local speech-to-text. */
async function transcribe(samples) {
  const res = await fetch('/api/stt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: samples, // sent as raw little-endian float32
  });
  await ensureOk(res);
  return (await res.json()).text;
}

// ------------------------------------------------------------ status --

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

/** The line under her name: what she's doing right now, else her mood. */
function setPresence(text) {
  els.presenceLine.textContent = text || (state.mood ? `Mood: ${state.mood}` : '');
}

/** Portrait ring: idle | typing | speaking (and call states on the call screen). */
function setPortraitState(value) {
  els.portrait.dataset.state = value;
}

const report = (promise) => void promise.catch((e) => setStatus(e.message, true));

// ----------------------------------------------------------- portraits --

/** Fill a portrait/avatar element with her face, or her initial. */
function paintFace(node, character, bust = '') {
  node.querySelector('img')?.remove();
  const initial = node.querySelector('.initial') ?? node;
  initial.textContent = character?.name?.charAt(0).toUpperCase() ?? '';
  node.classList.toggle('has-face', Boolean(character?.hasFace));
  if (character?.hasFace) {
    const img = el('img');
    img.src = `/api/characters/${encodeURIComponent(character.id)}/face${bust}`;
    img.alt = '';
    node.append(img);
  }
}

/** Inline stroke icon from a path (built with DOM APIs, no innerHTML). */
function icon(d) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

function avatar(character) {
  const node = el('span', 'avatar');
  const initial = el('span', 'initial');
  node.append(initial);
  paintFace(node, character);
  return node;
}

// ------------------------------------------------------------ sidebar --

function renderCharacters() {
  // Disambiguate cards sharing a name (e.g. "Aria" and its French version).
  const count = new Map();
  for (const c of state.characters) count.set(c.name, (count.get(c.name) ?? 0) + 1);
  els.characterList.replaceChildren(
    ...state.characters.map((c) => {
      const li = el('li');
      const button = el('button');
      button.type = 'button';
      button.setAttribute('aria-current', String(c.id === state.characterId));
      button.append(avatar(c), el('span', '', count.get(c.name) > 1 ? `${c.name} (${c.id})` : c.name));
      button.addEventListener('click', () => {
        closeSidebar();
        report(selectCharacter(c.id));
      });
      li.append(button);
      return li;
    }),
  );
}

/** Short local date/time for chat lists. */
function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

async function refreshSessionList() {
  if (!state.characterId) return;
  const sessions = await api(`/api/characters/${encodeURIComponent(state.characterId)}/sessions`).catch(() => []);
  els.chatsWith.textContent = herName();
  els.sessionList.replaceChildren(
    ...sessions.map((s) => {
      const li = el('li');
      const button = el('button', 'open-chat');
      button.type = 'button';
      button.setAttribute('aria-current', String(s.id === state.sessionId));
      const time = el('time', '', formatDate(s.updatedAt));
      time.dateTime = s.updatedAt;
      button.append(el('span', 'title', s.title ?? 'New chat'), time);
      button.addEventListener('click', () => {
        closeSidebar();
        report(openSession(s.id));
      });
      const del = el('button', 'icon-button delete-chat');
      del.type = 'button';
      del.setAttribute('aria-label', `Delete the chat "${s.title ?? 'New chat'}"`);
      del.append(icon('M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6'));
      del.addEventListener('click', () => report(deleteChat(s.id)));
      li.append(button, del);
      return li;
    }),
  );
}

const openSidebar = () => els.sidebar.classList.add('open');
const closeSidebar = () => els.sidebar.classList.remove('open');

// ----------------------------------------------------------- messages --

/** Render roleplay text: *actions* become <em>, everything else is plain text. */
function renderText(container, text) {
  container.replaceChildren();
  for (const part of text.split(/(\*[^*\n]+\*)/g)) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith('*') && part.endsWith('*'))
      container.append(el('em', '', part.slice(1, -1)));
    else container.append(document.createTextNode(part));
  }
}

function scrollToEnd() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addMessage(role, text, { pending = false, imageId = null } = {}) {
  els.messages.querySelector('.empty-chat')?.remove();
  const wrap = el('article', `msg ${role}${pending ? ' pending' : ''}${imageId ? ' photo-msg' : ''}`);
  wrap.setAttribute('aria-label', role === 'user' ? state.userName : herName());
  const body = el('div', 'text');
  renderText(body, text);
  if (imageId) wrap.append(photoElement(imageId));
  wrap.append(body);
  els.messages.append(wrap);
  scrollToEnd();
  return { wrap, body };
}

/** A photo she sent: thumbnail in the bubble, click to open full size. */
function photoElement(imageId) {
  const url = `/api/images/${encodeURIComponent(imageId)}`;
  const link = el('a', 'photo-link');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  const img = el('img', 'photo');
  img.src = url;
  img.alt = `Photo from ${herName()}`;
  img.loading = 'lazy';
  // Keep the chat scrolled to the bottom once the image has its real size.
  img.addEventListener('load', () => {
    if (link.closest('.msg') === els.messages.lastElementChild) scrollToEnd();
  });
  link.append(img);
  return link;
}

function renderSession(session) {
  els.messages.replaceChildren();
  for (const m of session.messages) addMessage(m.role, m.content, { imageId: m.imageId });
  if (session.messages.length === 0) {
    els.messages.append(el('p', 'empty-chat', `Say hello to ${herName()}.`));
  }
}

function setBusy(busy) {
  for (const node of [els.send, els.regenerate, els.mic, els.photo, els.call]) node.disabled = busy;
  els.stop.hidden = !busy;
  els.send.hidden = busy;
}

/**
 * POST to a streaming endpoint and render tokens into a new bubble.
 * @param {{ speak?: boolean }} [options] speak: force reading aloud (calls)
 * @returns {Promise<string>} the reply text ('' if failed or empty)
 */
async function streamInto(path, payload, { speak = state.speakReplies } = {}) {
  state.controller = new AbortController();
  setBusy(true);
  setPresence('typing…');
  setPortraitState('typing');
  const bubble = addMessage('assistant', '', { pending: true });
  let text = '';
  // Speak sentence by sentence while the reply is still being written.
  speaker.stop();
  const splitter = speak ? new SentenceSplitter() : null;

  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: state.controller.signal,
    });
    await ensureOk(res);
    for await (const { event, data } of readSse(res.body)) {
      if (event === 'token') {
        text += data.text;
        renderText(bubble.body, text);
        splitter?.push(data.text).forEach((sentence) => speaker.enqueue(sentence));
        scrollToEnd();
      } else if (event === 'error') {
        throw new Error(data.message);
      } else if (event === 'done') {
        splitter?.flush().forEach((sentence) => speaker.enqueue(sentence));
        setStatus(data.droppedMessages ? `${data.droppedMessages} older messages no longer fit in her context` : '');
      }
    }
  } catch (err) {
    speaker.stop();
    text = '';
    if (err.name === 'AbortError') setStatus('Stopped');
    else setStatus(err.message, true);
  } finally {
    bubble.wrap.classList.remove('pending');
    if (!bubble.body.textContent) bubble.wrap.remove();
    state.controller = null;
    setBusy(false);
    setPresence('');
    setPortraitState(speaker.busy ? 'speaking' : 'idle');
    if (speaker.busy) void speaker.whenIdle().then(() => setPortraitState('idle'));
    if (!state.call) els.input.focus();
    void refreshSessionList(); // the title appears after the first message
  }
  return text;
}

// -------------------------------------------------------------- chats --

/** Show a session (already fetched) and remember it for the next visit. */
function showSession(session, character) {
  state.sessionId = session.id;
  state.characterId = character.id;
  state.mood = session.mood ?? '';
  store.set('girllm.sessionId', session.id);
  store.set('girllm.characterId', character.id);
  els.herName.textContent = herName() || character.name;
  els.input.placeholder = `Message ${character.name}…`;
  paintFace(els.portrait, current());
  setPresence('');
  renderCharacters();
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

/** Switch character: reopen her latest chat, or start one. */
async function selectCharacter(characterId) {
  if (state.controller) return;
  const sessions = await api(`/api/characters/${encodeURIComponent(characterId)}/sessions`);
  if (!(sessions.length && (await openSession(sessions[0].id)))) await startSession(characterId);
}

async function deleteChat(sessionId) {
  const ok = await confirmAction({
    title: 'Delete this chat?',
    text: 'Its messages and photos will be deleted. What she remembers about you is kept.',
    action: 'Delete chat',
  });
  if (!ok) return;
  await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  if (sessionId === state.sessionId) {
    store.set('girllm.sessionId', '');
    await selectCharacter(state.characterId);
  } else {
    await refreshSessionList();
  }
  setStatus('Chat deleted');
}

async function loadCharacters() {
  state.characters = await api('/api/characters');
  renderCharacters();
}

// ------------------------------------------------------------ sending --

async function sendText(text, options) {
  if (!text || !state.sessionId || state.controller) return '';
  addMessage('user', text);
  return streamInto(`/api/sessions/${state.sessionId}/messages`, { text }, options);
}

async function sendMessage() {
  const text = els.input.value.trim();
  if (!text || state.controller) return;
  els.input.value = '';
  autoGrow();
  await sendText(text);
}

async function regenerate() {
  if (!state.sessionId || state.controller) return;
  const last = els.messages.lastElementChild;
  // Only remove the last bubble if it is a reply (never the user's message).
  if (last?.classList.contains('assistant') && els.messages.children.length > 1) last.remove();
  await streamInto(`/api/sessions/${state.sessionId}/regenerate`);
}

/** The message box grows with its content (up to its CSS max-height). */
function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${els.input.scrollHeight}px`;
}

// ---------------------------------------------------------- memories --

const CATEGORY_LABELS = { user: 'You', character: 'Her', relationship: 'You two', event: 'Event' };

async function renderMemoryPanel() {
  const [{ session }, memories] = await Promise.all([
    api(`/api/sessions/${state.sessionId}`),
    api(`/api/characters/${encodeURIComponent(state.characterId)}/memories`),
  ]);
  els.memorySummary.textContent =
    session.summary || 'Nothing summarized yet: the whole conversation still fits in her context.';
  els.memoryMood.textContent = session.mood ? `Current mood: ${session.mood}` : '';

  if (memories.length === 0) {
    els.memoryList.replaceChildren(el('li', 'muted', 'No memories yet. She picks them up as you chat.'));
    return;
  }
  els.memoryList.replaceChildren(
    ...memories.map((m) => {
      const li = el('li');
      const del = el('button', 'ghost danger', 'Forget');
      del.type = 'button';
      del.addEventListener('click', async () => {
        await api(`/api/memories/${m.id}`, { method: 'DELETE' }).catch((e) => setStatus(e.message, true));
        await renderMemoryPanel();
      });
      li.append(el('span', 'tag', CATEGORY_LABELS[m.category] ?? m.category), el('span', 'text', m.content), del);
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

// ------------------------------------------------------------- photos --

/**
 * Ask her for a photo. Text typed in the box becomes the request
 * ("a selfie at the beach"); empty = she decides.
 */
async function sendPhoto() {
  if (!state.sessionId || state.controller) return;
  const request = els.input.value.trim();
  els.input.value = '';
  autoGrow();
  // Shown right away; saved by the server only if the photo succeeds.
  const requestBubble = request ? addMessage('user', `📷 ${request}`) : null;

  state.controller = new AbortController();
  setBusy(true);
  speaker.stop();
  setPortraitState('typing');
  const bubble = addMessage('assistant', '', { pending: true });
  const started = Date.now();
  const tick = () => setPresence(`taking a photo… ${Math.round((Date.now() - started) / 1000)} s`);
  tick();
  const timer = setInterval(tick, 1000);

  try {
    const res = await fetch(`/api/sessions/${state.sessionId}/photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request }),
      signal: state.controller.signal,
    });
    await ensureOk(res);
    const { message } = await res.json();
    bubble.wrap.remove();
    addMessage('assistant', message.content, { imageId: message.imageId });
    if (state.speakReplies) speaker.enqueue(message.content);
    setStatus('');
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
    setPresence('');
    setPortraitState('idle');
    void refreshSessionList();
  }
}

/** Show the photo button unless photos are disabled in the config. */
async function initPhotos() {
  const status = await api('/api/images/status').catch(() => null);
  const disabled = !status || String(status.reason ?? '').startsWith('disabled');
  state.photosAvailable = Boolean(status?.available);
  els.photo.hidden = disabled;
  els.photo.title = status?.available
    ? 'Ask for a photo (describe it in the box first, or leave it empty)'
    : `Photos unavailable: ${status?.reason ?? 'unknown'}`;
}

// -------------------------------------------------------------- voice --

function renderVoiceToggle() {
  const on = state.speakReplies;
  els.voiceToggle.setAttribute('aria-pressed', String(on));
  els.voiceToggle.setAttribute('aria-label', on ? 'Stop reading her replies aloud' : 'Read her replies aloud');
  els.voiceToggle.title = els.voiceToggle.getAttribute('aria-label');
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
    els.mic.setAttribute('aria-label', 'Stop and send');
    setStatus('Recording… click the microphone again to send');
    return;
  }

  els.mic.classList.remove('recording');
  els.mic.setAttribute('aria-label', 'Record a voice message');
  els.mic.disabled = true;
  setStatus('Transcribing…');
  try {
    const text = await transcribe(await recorder.stop());
    if (!text) {
      setStatus('Nothing was heard. Try again a little closer to the microphone.');
      return;
    }
    setStatus('');
    els.input.value = text;
    await sendMessage();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    els.mic.disabled = Boolean(state.controller);
  }
}

// ---------------------------------------------------- hands-free call --

const CALL_STATE_TEXT = {
  listening: 'Listening',
  hearing: 'Listening',
  paused: '',
};

function setCallState(value, text) {
  els.callPortrait.dataset.state = value;
  els.callState.textContent = text ?? CALL_STATE_TEXT[value] ?? '';
}

async function startCall() {
  if (state.call || state.controller || !state.sessionId) return;
  recorder.cancel();
  speaker.stop();
  els.callName.textContent = herName();
  paintFace(els.callPortrait, current());
  els.callTranscript.textContent = '';
  els.callScreen.hidden = false;
  setCallState('paused', 'Connecting…');

  const call = new CallSession({
    onState: (s) => {
      if (s !== 'off') setCallState(s);
    },
    onLevel: (db) => {
      // -60 dB (silence) … -20 dB (loud voice) → 0 … 1
      const level = Math.min(1, Math.max(0, (db + 60) / 40));
      els.callPortrait.style.setProperty('--level', level.toFixed(2));
    },
    onUtterance: (audio) => void handleUtterance(audio),
  });
  state.call = call;
  try {
    await call.start();
    $('hang-up').focus();
  } catch (err) {
    endCall();
    setStatus(err.name === 'NotAllowedError' ? 'Microphone access was denied' : err.message, true);
  }
}

/** One turn of the call: transcribe → send → let her speak → listen again. */
async function handleUtterance(audio) {
  const call = state.call;
  if (!call) return;
  els.callPortrait.style.setProperty('--level', '0');
  try {
    setCallState('paused', 'Understanding…');
    const text = await transcribe(audio);
    if (!state.call) return;
    if (!text) {
      call.resume();
      return;
    }
    els.callTranscript.textContent = text;
    setCallState('paused', `${herName()} is thinking…`);
    const reply = await sendText(text, { speak: true });
    if (!state.call) return;
    if (reply) {
      setCallState('speaking', `${herName()} is talking`);
      await speaker.whenIdle();
    }
  } catch (err) {
    setStatus(err instanceof ApiError ? err.message : String(err), true);
  }
  if (state.call === call) {
    els.callTranscript.textContent = '';
    call.resume();
  }
}

function endCall() {
  state.call?.stop();
  state.call = null;
  state.controller?.abort();
  speaker.stop();
  els.callScreen.hidden = true;
  els.call.focus();
}

/** Show voice controls only for engines whose models are installed. */
async function initVoice() {
  const voice = await api('/api/voice').catch(() => null);
  const ttsReady = Boolean(voice?.tts.available);
  const sttReady = Boolean(voice?.stt.available);
  els.voiceToggle.hidden = !ttsReady;
  state.speakReplies = ttsReady && store.get('girllm.speakReplies') === '1';
  renderVoiceToggle();

  els.mic.hidden = !sttReady;
  if (sttReady && !micSupported()) {
    els.mic.disabled = true;
    els.mic.title = 'The microphone only works on http://127.0.0.1 or localhost';
  }
  // A call needs both directions.
  els.call.hidden = !(sttReady && ttsReady && callSupported());
}

// -------------------------------------------------------------- theme --

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const dark = theme ? theme === 'dark' : !window.matchMedia('(prefers-color-scheme: light)').matches;
  els.themeToggle.textContent = dark ? 'Light mode' : 'Dark mode';
  els.themeToggle.setAttribute('aria-pressed', String(!dark));
}

function toggleTheme() {
  const dark = els.themeToggle.getAttribute('aria-pressed') === 'false';
  const theme = dark ? 'light' : 'dark';
  store.set('girllm.theme', theme);
  applyTheme(theme);
}

// ------------------------------------------------------------- panels --

const settingsPanel = new SettingsPanel({
  onSaved: (values) => {
    state.userName = values.userName;
    void initPhotos(); // the image model may have changed
  },
});

const editor = new CharacterEditor({
  photosAvailable: () => state.photosAvailable,
  onSaved: (summary) => {
    report(
      (async () => {
        await loadCharacters();
        if (summary.id === state.characterId) {
          els.herName.textContent = summary.name;
          paintFace(els.portrait, current(), `?v=${Date.now()}`);
          void refreshSessionList();
        }
      })(),
    );
  },
  onFaceChanged: (id) => {
    report(
      (async () => {
        await loadCharacters();
        if (id === state.characterId) paintFace(els.portrait, current(), `?v=${Date.now()}`);
      })(),
    );
  },
  onDeleted: (id) => {
    report(
      (async () => {
        await loadCharacters();
        if (id !== state.characterId) return;
        store.set('girllm.sessionId', '');
        if (state.characters.length) await selectCharacter(state.characters[0].id);
        else showNoCharacters();
      })(),
    );
  },
});

/** Import a card file (.json or .png from SillyTavern, chub.ai…). */
async function importCard(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('This file is larger than 20 MB.');
  const res = await fetch('/api/characters/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  await ensureOk(res);
  const summary = await res.json();
  await loadCharacters();
  await selectCharacter(summary.id);
  setStatus(`${summary.name} imported`);
}

function showNoCharacters() {
  state.characterId = state.sessionId = null;
  els.herName.textContent = 'No character yet';
  els.messages.replaceChildren(el('p', 'empty-chat', 'Create a character or import a card to start.'));
  els.sessionList.replaceChildren();
  setBusy(false);
  for (const node of [els.send, els.regenerate, els.photo, els.call, els.mic]) node.disabled = true;
}

// ------------------------------------------------------------- wiring --

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
els.input.addEventListener('input', autoGrow);
els.stop.addEventListener('click', () => {
  state.controller?.abort();
  speaker.stop();
});
els.mic.addEventListener('click', () => void toggleRecording());
els.photo.addEventListener('click', () => void sendPhoto());
els.voiceToggle.addEventListener('click', toggleSpeakReplies);
els.regenerate.addEventListener('click', () => void regenerate());
els.call.addEventListener('click', () => void startCall());
$('hang-up').addEventListener('click', endCall);
els.callScreen.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') endCall();
});
$('new-chat').addEventListener('click', () => {
  closeSidebar();
  if (state.characterId && !state.controller) report(startSession(state.characterId));
});
$('new-character').addEventListener('click', () => void editor.open());
$('edit-character').addEventListener('click', () => {
  if (state.characterId) void editor.open(state.characterId);
});
$('import-character').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) report(importCard(file));
});
$('open-settings').addEventListener('click', () => void settingsPanel.open());
$('open-sidebar').addEventListener('click', openSidebar);
$('close-sidebar').addEventListener('click', closeSidebar);
els.themeToggle.addEventListener('click', toggleTheme);

wireDialog(els.memoryDialog);
$('open-memory').addEventListener('click', () => {
  els.memoryDialog.showModal();
  report(renderMemoryPanel());
});
els.memoryForm.addEventListener('submit', (e) => {
  e.preventDefault();
  report(addMemory());
});

async function init() {
  applyTheme(store.get('girllm.theme'));
  try {
    const [config, health] = await Promise.all([api('/api/config'), api('/api/health').catch(() => null)]);
    state.userName = config.userName;
    $('open-memory').hidden = !config.memoryEnabled;
    await Promise.all([loadCharacters(), initVoice(), initPhotos()]);

    if (state.characters.length === 0) {
      showNoCharacters();
      return;
    }
    const savedSession = store.get('girllm.sessionId');
    if (!(savedSession && (await openSession(savedSession)))) {
      const savedChar = store.get('girllm.characterId');
      const initial = state.characters.some((c) => c.id === savedChar) ? savedChar : state.characters[0].id;
      await selectCharacter(initial);
    }

    if (health && health.status !== 'ok') {
      setStatus(`Ollama isn't reachable (${health.llm.error}). Start it, then send your message again.`, true);
    }
    els.input.focus();
  } catch (err) {
    setStatus(err.message, true);
  }
}

void init();
