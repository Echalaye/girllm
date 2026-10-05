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
  conversation: document.querySelector('.conversation'),
  chatBg: $('chat-bg'),
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
  /** /api/images/status: realistic availability at the top level, anime under `.anime`. */
  imageStatus: null,
  /** Her picture behind the chat: 'subtle' | 'clear' | 'off' (a setting). */
  chatBackground: 'subtle',
  /** Cache-buster for face/background URLs after they change. */
  pictureBust: '',
  /** Voices for the character editor (from /api/voice). */
  voices: [],
  /** Running hands-free call, if any. */
  call: null,
  /** She writes first after this many minutes of silence (0 = never). */
  proactiveAfterMinutes: 0,
  /** Time (ms) of the latest message in the open chat. */
  lastMessageAt: 0,
  /** She already wrote first (or was told "not now") since your last message: don't ask again. */
  nudgeBlocked: false,
  /** Messages received while the tab was hidden (shown in the title). */
  unread: 0,
};

const current = () => state.characters.find((c) => c.id === state.characterId);
const herName = () => current()?.name ?? '';

// ------------------------------------------------------------- audio --

const recorder = new Recorder();
const speaker = new Speaker(async (text) => {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Her own voice, if her card has one.
    body: JSON.stringify({ text, characterId: state.characterId ?? undefined }),
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
  const last = session.messages.at(-1);
  state.lastMessageAt = last ? new Date(last.createdAt).getTime() : 0;
  state.nudgeBlocked = last?.kind === 'nudge';
  els.messages.replaceChildren();
  for (const m of session.messages) addMessage(m.role, m.content, { imageId: m.imageId });
  if (session.messages.length === 0) {
    els.messages.append(el('p', 'empty-chat', `Say hello to ${herName()}.`));
  }
  updateBackground();
}

function setBusy(busy) {
  for (const node of [els.send, els.regenerate, els.mic, els.photo, els.call]) node.disabled = busy;
  els.stop.hidden = !busy;
  els.send.hidden = busy;
}

/**
 * POST to a streaming endpoint and render tokens into a new bubble.
 * Events: token…, done (text complete), then possibly photo_start → photo
 * (or photo_error) when she decided to send a photo with her message.
 * @param {{ speak?: boolean, quiet?: boolean }} [options]
 *   speak: force reading aloud (calls); quiet: no "typing" bubble until the
 *   first word arrives (she writes first: the server may decline with 204).
 * @returns {Promise<string>} the reply text ('' if failed, empty or declined)
 */
async function streamInto(path, payload, { speak = state.speakReplies, quiet = false } = {}) {
  state.controller = new AbortController();
  setBusy(true);
  let bubble = null;
  const ensureBubble = () => {
    if (!bubble) {
      bubble = addMessage('assistant', '', { pending: true });
      setPresence('typing…');
      setPortraitState('typing');
    }
    return bubble;
  };
  if (!quiet) ensureBubble();
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
    if (res.status === 204) return ''; // not the moment (she writes first)
    for await (const { event, data } of readSse(res.body)) {
      if (event === 'token') {
        text += data.text;
        renderText(ensureBubble().body, text);
        splitter?.push(data.text).forEach((sentence) => speaker.enqueue(sentence));
        scrollToEnd();
      } else if (event === 'error') {
        throw new Error(data.message);
      } else if (event === 'done') {
        splitter?.flush().forEach((sentence) => speaker.enqueue(sentence));
        if (bubble && data.messageId) bubble.wrap.dataset.id = data.messageId;
        if (bubble) bubble.wrap.classList.remove('pending');
        state.lastMessageAt = Date.now();
        setStatus(data.droppedMessages ? `${data.droppedMessages} older messages no longer fit in her context` : '');
      } else if (event === 'photo_start') {
        setPresence('sending you a photo…');
        setPortraitState('typing');
        ensureBubble().wrap.classList.add('photo-pending');
      } else if (event === 'photo') {
        const b = ensureBubble();
        b.wrap.classList.remove('photo-pending');
        b.wrap.classList.add('photo-msg');
        b.wrap.prepend(photoElement(data.imageId));
        updateBackground(); // "latest photo" backgrounds follow
        if (document.hidden) notifyUnread();
      } else if (event === 'photo_error') {
        bubble?.wrap.classList.remove('photo-pending');
        setStatus(`She couldn't send the photo: ${data.message}`, true);
      }
    }
  } catch (err) {
    speaker.stop();
    text = '';
    if (err.name === 'AbortError') setStatus('Stopped');
    else setStatus(err.message, true);
  } finally {
    if (bubble) {
      bubble.wrap.classList.remove('pending', 'photo-pending');
      if (!bubble.body.textContent && !bubble.wrap.querySelector('img')) bubble.wrap.remove();
    }
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

// ------------------------------------------------- she writes first --

/**
 * Ask whether she writes first: 'opening' for an empty chat, 'nudge' after
 * a silence. The server decides (204 = not now); nothing shows until she
 * actually starts writing.
 */
async function initiate(reason) {
  if (!state.sessionId || state.controller || state.call) return;
  if (reason === 'nudge') state.nudgeBlocked = true; // one try per silence
  const text = await streamInto(`/api/sessions/${state.sessionId}/initiate`, { reason }, { quiet: true });
  if (text && document.hidden) notifyUnread();
}

/** Is the chat quiet long enough for her to write first? (the server checks again) */
function silentLongEnough() {
  const minutes = state.proactiveAfterMinutes;
  return minutes > 0 && state.lastMessageAt > 0 && Date.now() - state.lastMessageAt >= minutes * 60_000;
}

/** Checked every minute while the page is open. */
function proactiveTick() {
  if (els.input.value.trim() || recorder.recording) return; // you are writing or talking
  if (silentLongEnough() && !state.nudgeBlocked) void initiate('nudge');
}

/** A message arrived while the tab is in the background: show it in the tab title. */
function notifyUnread() {
  state.unread += 1;
  document.title = `(${state.unread}) ${herName()} · girllm`;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.unread) {
    state.unread = 0;
    document.title = 'girllm';
  }
});

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
  updatePhotoButton();
  renderSession(session);
  // She writes first: the opening of an empty chat, or after a long silence.
  setTimeout(() => {
    if (state.sessionId !== session.id) return;
    if (session.messages.length === 0) void initiate('opening');
    else if (silentLongEnough() && !state.nudgeBlocked) void initiate('nudge');
  }, 400);
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
  state.lastMessageAt = Date.now();
  state.nudgeBlocked = false;
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
  state.nudgeBlocked = false;

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
    state.lastMessageAt = Date.now();
    updateBackground();
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
  state.imageStatus = status;
  els.photo.hidden = !status || String(status.reason ?? '').startsWith('disabled');
  updatePhotoButton();
}

/** Image availability for an art style: realistic at the top level, anime under `.anime`. */
function styleStatus(artStyle = 'realistic') {
  const status = state.imageStatus;
  return artStyle === 'anime' ? status?.anime : status;
}

/** The 📷 button follows the current character's art style. */
function updatePhotoButton() {
  const st = styleStatus(current()?.artStyle);
  els.photo.title = st?.available
    ? 'Ask for a photo (describe it in the box first, or leave it empty)'
    : `Photos unavailable: ${st?.reason ?? 'unknown'}`;
}

// --------------------------------------------------- chat background --

/**
 * Her picture behind the chat (step 5). Source, per character:
 *   "latest" → her latest photo in this chat, else her scene, else her face;
 *   "scene"  → her generated scene, else her face.
 * The look (subtle / clear / off) is a setting.
 */
function updateBackground() {
  const c = current();
  const layer = els.chatBg;
  let url = '';
  if (c && state.chatBackground !== 'off') {
    const latest = c.background === 'latest' ? [...els.messages.querySelectorAll('img.photo')].at(-1) : null;
    if (latest) url = latest.getAttribute('src');
    else if (c.hasBackground) url = `/api/characters/${encodeURIComponent(c.id)}/background${state.pictureBust}`;
    else if (c.hasFace) url = `/api/characters/${encodeURIComponent(c.id)}/face${state.pictureBust}`;
  }
  els.conversation.classList.toggle('has-bg', Boolean(url));
  layer.dataset.look = state.chatBackground;
  if (!url) {
    layer.replaceChildren();
    return;
  }
  // Only swap the image when the source changes (no flicker on re-renders).
  if (layer.firstElementChild?.getAttribute('src') === url) return;
  const img = el('img');
  img.alt = '';
  img.decoding = 'async';
  img.src = url;
  // Fade in once loaded; a missing file just leaves the plain background.
  img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
  img.addEventListener('error', () => img.remove(), { once: true });
  layer.replaceChildren(img);
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
  state.voices = voice?.voices ?? [];
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
    state.proactiveAfterMinutes = values.proactiveAfterMinutes;
    state.chatBackground = values.chatBackground;
    updateBackground();
    void initPhotos(); // the image model may have changed
  },
});

const editor = new CharacterEditor({
  photosAvailable: (artStyle) => Boolean(styleStatus(artStyle)?.available),
  faceSupport: (artStyle) => styleStatus(artStyle)?.face,
  voices: () => state.voices,
  onSaved: (summary) => {
    report(
      (async () => {
        await loadCharacters();
        if (summary.id === state.characterId) {
          els.herName.textContent = summary.name;
          paintFace(els.portrait, current(), `?v=${Date.now()}`);
          updatePhotoButton();
          updateBackground(); // the background mode may have changed
          void refreshSessionList();
        }
      })(),
    );
  },
  onPictureChanged: (id) => {
    report(
      (async () => {
        await loadCharacters();
        if (id !== state.characterId) return;
        state.pictureBust = `?v=${Date.now()}`; // a new face/scene has the same URL
        paintFace(els.portrait, current(), state.pictureBust);
        updateBackground();
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
    state.proactiveAfterMinutes = config.proactiveAfterMinutes ?? 0;
    state.chatBackground = config.chatBackground ?? 'subtle';
    setInterval(proactiveTick, 60_000);
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
