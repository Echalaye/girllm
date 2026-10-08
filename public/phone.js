// Settings → "Phone app" (step 8): pair a phone on the local network by QR
// code, list paired phones and remove them. Only the PC's own page has these
// routes; the phone listener never does.

import { api, confirmAction, el } from './api.js';

/** While a QR code is shown, look for the new phone this often. */
const POLL_MS = 2500;

export class PhonePairing {
  constructor() {
    /** One fieldset, re-attached by the settings panel at each render. */
    this.root = el('fieldset', 'phone-pairing');
    this.timer = null;
    this.countdown = null;
  }

  /** The section's element (fills itself in). */
  element() {
    void this.refresh();
    return this.root;
  }

  /** Stop polling (settings closed). */
  stop() {
    clearInterval(this.timer);
    clearInterval(this.countdown);
    this.timer = this.countdown = null;
  }

  async refresh(message = '') {
    let lan;
    try {
      lan = await api('/api/lan');
    } catch (err) {
      this.#render({ enabled: false, devices: [] }, err.message);
      return;
    }
    this.#render(lan, message);
  }

  #render(lan, message) {
    this.stop();
    const children = [el('legend', '', 'Phone app')];
    if (!lan.enabled) {
      children.push(
        el(
          'p',
          'small muted',
          'Off. To chat from your phone over your Wi-Fi, set LAN_ENABLED=true in .env and restart girllm. ' +
            'The phone talks to this PC only, over an encrypted connection; nothing leaves your local network.',
        ),
      );
    } else {
      const address = lan.addresses[0] ? `https://${lan.addresses[0]}:${lan.port}` : 'no private network address';
      children.push(
        el('p', 'small muted', `On: ${address} · certificate ${lan.fingerprint.slice(0, 16)}…`),
        this.#pairButton(),
      );
    }
    if (message) children.push(el('p', 'small', message));
    children.push(this.#deviceList(lan.devices));
    this.root.replaceChildren(...children);
  }

  #pairButton() {
    const button = el('button', 'secondary', 'Pair a phone');
    button.type = 'button';
    button.addEventListener('click', () => void this.#pair(button));
    return button;
  }

  /** Show the one-time QR code and wait for the phone to use it. */
  async #pair(button) {
    button.disabled = true;
    let pairing;
    try {
      pairing = await api('/api/lan/pairing', { method: 'POST' });
    } catch (err) {
      button.disabled = false;
      void this.refresh(err.message);
      return;
    }
    const known = new Set((await api('/api/lan')).devices.map((d) => d.id));

    const box = el('div', 'pairing-qr');
    const img = el('img');
    // The server draws the SVG; shown as an image (no markup inserted in the page).
    img.src = `data:image/svg+xml;base64,${btoa(pairing.svg)}`;
    img.alt = 'Pairing QR code';
    const help = el(
      'p',
      'small',
      'In the girllm app on your phone, tap "Pair with my PC" and scan this code. ' +
        'The phone must be on the same Wi-Fi as this PC.',
    );
    const left = el('p', 'small muted');
    const cancel = el('button', 'ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      void api('/api/lan/pairing', { method: 'DELETE' }).finally(() => void this.refresh());
    });
    box.append(img, help, left, cancel);
    button.replaceWith(box);

    const expires = new Date(pairing.expiresAt).getTime();
    const tick = () => {
      const s = Math.max(0, Math.round((expires - Date.now()) / 1000));
      left.textContent = `Valid ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}, for one phone.`;
      if (s === 0) void this.refresh('The code expired: pair again.');
    };
    tick();
    this.countdown = setInterval(tick, 1000);
    this.timer = setInterval(async () => {
      const lan = await api('/api/lan').catch(() => null);
      const added = lan?.devices.find((d) => !known.has(d.id));
      if (added) void this.refresh(`Paired: ${added.name}.`);
    }, POLL_MS);
  }

  #deviceList(devices) {
    if (!devices.length) return el('p', 'small muted', 'No phone paired.');
    const list = el('ul', 'device-list');
    for (const d of devices) {
      const li = el('li');
      const seen = d.lastSeenAt ? `last used ${new Date(d.lastSeenAt).toLocaleString()}` : 'never used yet';
      li.append(
        el('span', '', d.name),
        el('span', 'small muted', ` · paired ${new Date(d.createdAt).toLocaleDateString()}, ${seen}`),
      );
      const remove = el('button', 'ghost danger small', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', () => void this.#remove(d));
      li.append(remove);
      list.append(li);
    }
    return list;
  }

  async #remove(device) {
    const ok = await confirmAction({
      title: `Remove ${device.name}?`,
      text: 'This phone will no longer be able to connect. You can pair it again later.',
      action: 'Remove',
    });
    if (!ok) return;
    try {
      await api(`/api/lan/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
      void this.refresh(`${device.name} removed.`);
    } catch (err) {
      void this.refresh(err.message);
    }
  }
}
