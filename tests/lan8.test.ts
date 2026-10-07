/**
 * Step 8: the phone app over the local network — private-address checks,
 * the pinned TLS certificate, pairing codes and tokens, and both servers:
 * the PC's own (pairing management) and the phone listener (HTTPS, private
 * network only, paired phones only, no web page).
 */
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { ChatService } from '../src/chat/chatService.js';
import { buildApp } from '../src/http/app.js';
import { DeviceStore, PAIRING_MAX_ATTEMPTS, PAIRING_TTL_MS } from '../src/lan/devices.js';
import { pairingPayload } from '../src/lan/lanAccess.js';
import { isPrivateAddress, lanAddresses } from '../src/lan/network.js';
import { certificateFingerprint, loadOrCreateCertificate, type LanCertificate } from '../src/lan/tls.js';
import { MemoryStore } from '../src/memory/memoryStore.js';
import { parseConfig } from '../src/config.js';
import { defaultsFromConfig } from '../src/settings/settingsSchema.js';
import { SettingsService } from '../src/settings/settingsService.js';
import { FakeLlm, makeCharacter, makeStore } from './helpers.js';

const tempDir = (name: string) => mkdtemp(join(tmpdir(), `girllm-${name}-`));

describe('private network only', () => {
  it('accepts private, link-local and loopback addresses', () => {
    for (const ip of [
      '192.168.1.20',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.254',
      '169.254.10.1',
      '127.0.0.1',
      '::1',
      '::ffff:192.168.1.20',
      'fd12:3456::1',
      'fe80::1%wlan0',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('refuses public and overlay addresses, and garbage', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:db8::1', '::ffff:8.8.8.8', '', 'nope', undefined]) {
      expect(isPrivateAddress(ip), String(ip)).toBe(false);
    }
  });

  it('lists this PC’s private IPv4 addresses, home Wi-Fi first', () => {
    const iface = (address: string, internal = false) => ({
      address,
      family: 'IPv4' as const,
      internal,
      netmask: '255.255.255.0',
      mac: '00:00:00:00:00:00',
      cidr: null,
    });
    expect(
      lanAddresses({
        lo: [iface('127.0.0.1', true)],
        vpn: [iface('10.8.0.2')],
        wifi: [iface('192.168.1.20')],
        weird: [iface('169.254.3.3'), iface('8.8.8.8')],
      }),
    ).toEqual(['192.168.1.20', '10.8.0.2']);
  });
});

describe('TLS certificate', () => {
  it('is made once, valid, self-signed, and kept', async () => {
    const dir = await tempDir('tls');
    const first = await loadOrCreateCertificate(dir);
    const x = new X509Certificate(first.cert);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.checkPrivateKey(createPrivateKey(first.key))).toBe(true);
    expect(x.publicKey.asymmetricKeyType).toBe('ec');
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.fingerprint).toBe(certificateFingerprint(first.cert));
    expect(new Date(x.validTo).getFullYear()).toBeGreaterThanOrEqual(new Date().getFullYear() + 9);
    expect((await loadOrCreateCertificate(dir)).fingerprint).toBe(first.fingerprint);
  });

  it('is made again once expired (phones must pair again)', async () => {
    const dir = await tempDir('tls');
    const first = await loadOrCreateCertificate(dir);
    const later = new Date(Date.now() + 11 * 365 * 24 * 3600 * 1000);
    expect((await loadOrCreateCertificate(dir, later)).fingerprint).not.toBe(first.fingerprint);
  });
});

describe('pairing codes and tokens', () => {
  const setup = () => {
    const { db } = makeStore();
    let now = new Date('2026-10-07T10:00:00Z');
    const devices = new DeviceStore(db, () => now);
    return { db, devices, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
  };

  it('exchanges a one-time code for a token that then authenticates the phone', () => {
    const { devices } = setup();
    const { code } = devices.createPairingCode();
    expect(code).toMatch(/^[A-Z2-7]{24}$/);
    const paired = devices.pair(code.toLowerCase(), 'Pixel 8 \u0007')!;
    expect(paired.device.name).toBe('Pixel 8');
    expect(paired.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(devices.authenticate(paired.token)?.id).toBe(paired.device.id);
    expect(devices.pair(code, 'again')).toBeUndefined(); // single use
    expect(devices.authenticate('x'.repeat(43))).toBeUndefined();
    expect(devices.authenticate(undefined)).toBeUndefined();
  });

  it('stores only a hash of the token', () => {
    const { db, devices } = setup();
    const { token } = devices.pair(devices.createPairingCode().code, 'Phone')!;
    const row = db.prepare('SELECT * FROM devices').get() as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('expires codes and stops guessing after a few tries', () => {
    const { devices, advance } = setup();
    const { code } = devices.createPairingCode();
    advance(PAIRING_TTL_MS + 1);
    expect(devices.pair(code, 'late')).toBeUndefined();

    const fresh = devices.createPairingCode().code;
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++)
      expect(devices.pair('WRONGWRONGWRONGWRONGWRON', 'x')).toBeUndefined();
    expect(devices.pair(fresh, 'right but too late')).toBeUndefined();
  });

  it('revokes a phone and notes when it was last seen', () => {
    const { devices } = setup();
    const { token, device } = devices.pair(devices.createPairingCode().code, 'Phone')!;
    devices.authenticate(token);
    expect(devices.list()[0]?.lastSeenAt).toBe('2026-10-07T10:00:00.000Z');
    expect(devices.remove(device.id)).toBe(true);
    expect(devices.authenticate(token)).toBeUndefined();
    expect(devices.remove(device.id)).toBe(false);
  });

  it('puts everything the phone needs in the QR code', () => {
    const payload = pairingPayload({
      addresses: ['192.168.1.20', '10.0.0.5'],
      port: 3211,
      code: 'ABC',
      fingerprint: 'f'.repeat(64),
    });
    const url = new URL(payload);
    expect(url.protocol).toBe('girllm:');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      v: '1',
      a: '192.168.1.20,10.0.0.5',
      p: '3211',
      c: 'ABC',
      f: 'f'.repeat(64),
    });
  });
});

describe('the two servers', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  let cert: LanCertificate | undefined;
  async function servers(o: { lanEnabled?: boolean } = {}) {
    const { db, store } = makeStore();
    const characters = CharacterRepository.fromCharacters([makeCharacter()]);
    const llm = new FakeLlm(['Hi']);
    const chat = new ChatService(characters, store, llm, {
      userName: 'Etienne',
      budget: { contextTokens: 4096, maxReplyTokens: 200 },
      temperature: 0.8,
      topP: 0.9,
    });
    cert ??= await loadOrCreateCertificate(await tempDir('tls'));
    const devices = new DeviceStore(db);
    const settings = new SettingsService(db, defaultsFromConfig(parseConfig({ USER_NAME: 'Etienne' })), 4096);
    const shared = { chat, characters, llm, settings, memoryStore: new MemoryStore(db), userName: 'Etienne' };
    const local = await buildApp({
      ...shared,
      mode: 'local',
      devices,
      lan:
        o.lanEnabled === false
          ? null
          : { port: 3211, addresses: () => ['192.168.1.20'], fingerprint: cert.fingerprint },
      allowedHosts: ['127.0.0.1:3210'],
    });
    const lan = await buildApp({
      ...shared,
      mode: 'lan',
      https: { key: cert.key, cert: cert.cert },
      devices,
      allowedHosts: [],
    });
    apps.push(local, lan);
    return { local, lan, devices };
  }

  const pc = (app: FastifyInstance, method: 'GET' | 'POST' | 'DELETE', url: string) =>
    app.inject({ method, url, headers: { host: '127.0.0.1:3210' } });

  it('the PC shows a QR code and the phone exchanges it for a token', async () => {
    const { local, lan } = await servers();
    const status = (await pc(local, 'GET', '/api/lan')).json();
    expect(status).toMatchObject({ enabled: true, port: 3211, addresses: ['192.168.1.20'], devices: [] });
    const pairing = (await pc(local, 'POST', '/api/lan/pairing')).json();
    expect(pairing.svg).toMatch(/^<svg/);
    const code = new URL(pairing.payload).searchParams.get('c')!;
    expect(new URL(pairing.payload).searchParams.get('f')).toBe(cert!.fingerprint);

    const wrong = await lan.inject({ method: 'POST', url: '/api/pair', payload: { code: 'nope', name: 'Pixel' } });
    expect(wrong.statusCode).toBe(403);
    const paired = await lan.inject({ method: 'POST', url: '/api/pair', payload: { code, name: 'Pixel' } });
    expect(paired.statusCode).toBe(200);
    const { token } = paired.json();

    const auth = { authorization: `Bearer ${token}` };
    expect((await lan.inject({ method: 'GET', url: '/api/characters' })).statusCode).toBe(401);
    expect(
      (
        await lan.inject({
          method: 'GET',
          url: '/api/characters',
          headers: { authorization: 'Bearer nope-nope-nope-nope-nope' },
        })
      ).statusCode,
    ).toBe(401);
    const list = await lan.inject({ method: 'GET', url: '/api/characters', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json()[0].id).toBe('aria');
    expect((await pc(local, 'GET', '/api/lan')).json().devices).toHaveLength(1);
  });

  it('the phone listener refuses other networks, browsers, and has no web page, settings or pairing management', async () => {
    const { local, lan, devices } = await servers();
    const { token } = devices.pair(devices.createPairingCode().code, 'Phone')!;
    const auth = { authorization: `Bearer ${token}` };
    const outside = await lan.inject({
      method: 'GET',
      url: '/api/characters',
      headers: auth,
      remoteAddress: '8.8.8.8',
    });
    expect(outside.statusCode).toBe(403);
    const browser = await lan.inject({
      method: 'GET',
      url: '/api/characters',
      headers: { ...auth, origin: 'https://evil.example' },
    });
    expect(browser.statusCode).toBe(403);
    expect((await lan.inject({ method: 'GET', url: '/', headers: auth })).statusCode).toBe(404);
    expect((await lan.inject({ method: 'GET', url: '/app.js', headers: auth })).statusCode).toBe(404);
    expect((await lan.inject({ method: 'POST', url: '/api/lan/pairing', headers: auth })).statusCode).toBe(404);
    expect((await lan.inject({ method: 'GET', url: '/api/lan', headers: auth })).statusCode).toBe(404);
    // App settings are changed from the PC only.
    expect((await lan.inject({ method: 'GET', url: '/api/settings', headers: auth })).statusCode).toBe(404);
    expect((await pc(local, 'GET', '/api/settings')).statusCode).toBe(200);
  });

  it('the PC page can revoke a phone; with phone access off it only reports it', async () => {
    const { local, lan, devices } = await servers();
    const { token, device } = devices.pair(devices.createPairingCode().code, 'Phone')!;
    expect((await pc(local, 'DELETE', `/api/lan/devices/${device.id}`)).statusCode).toBe(204);
    const after = await lan.inject({
      method: 'GET',
      url: '/api/characters',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);

    const off = await servers({ lanEnabled: false });
    expect((await pc(off.local, 'GET', '/api/lan')).json()).toMatchObject({ enabled: false, addresses: [] });
    expect((await pc(off.local, 'POST', '/api/lan/pairing')).statusCode).toBe(404);
  });

  it('serves real HTTPS with the pinned certificate', async () => {
    const { lan, devices } = await servers();
    const { token } = devices.pair(devices.createPairingCode().code, 'Phone')!;
    await lan.listen({ host: '127.0.0.1', port: 0 });
    const port = (lan.server.address() as { port: number }).port;
    const { status, fingerprint } = await new Promise<{ status: number; fingerprint: string }>((resolve, reject) => {
      // Like the phone: no CA, but the exact certificate fingerprint.
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/characters',
          headers: { authorization: `Bearer ${token}` },
          rejectUnauthorized: false,
        },
        (res) => {
          const peer = (res.socket as TLSSocket).getPeerCertificate();
          res.resume();
          resolve({ status: res.statusCode ?? 0, fingerprint: peer.fingerprint256.replace(/:/g, '').toLowerCase() });
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
    expect(fingerprint).toBe(cert!.fingerprint);
  });
});
