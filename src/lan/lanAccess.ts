/**
 * Phone access over the local network (step 8): the routes on both sides.
 *
 *  - On the PC's own server (127.0.0.1, the browser): manage pairing — show a
 *    one-time QR code, list and revoke phones. Never on the phone listener.
 *  - On the phone listener (HTTPS, private network only): exchange the
 *    pairing code for a token, then every API route requires that token.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { DeviceStore } from './devices.js';
import { isPrivateAddress } from './network.js';

/** What the PC knows about its phone listener (null when LAN_ENABLED=false). */
export interface LanInfo {
  port: number;
  /** This PC's private addresses (computed when asked: Wi-Fi may change). */
  addresses: () => string[];
  /** SHA-256 of the TLS certificate (hex), pinned by the phone. */
  fingerprint: string;
}

/**
 * Contents of the pairing QR code: everything the phone needs, nothing
 * secret beyond the 5-minute single-use code.
 *   girllm://pair?v=1&a=<ip>,<ip>&p=<port>&c=<code>&f=<sha256 hex>
 * Pure function (exported for tests).
 */
export function pairingPayload(o: { addresses: string[]; port: number; code: string; fingerprint: string }): string {
  const query = new URLSearchParams({
    v: '1',
    a: o.addresses.join(','),
    p: String(o.port),
    c: o.code,
    f: o.fingerprint,
  });
  return `girllm://pair?${query.toString()}`;
}

const DeviceParams = z.object({ id: z.string().uuid() });

/** PC side (127.0.0.1 only): pairing QR code, list and revoke phones. */
export function registerLanAdminRoutes(
  app: FastifyInstance,
  lan: LanInfo | null,
  devices: DeviceStore | undefined,
): void {
  app.get('/api/lan', (_request, reply) =>
    reply.send({
      enabled: Boolean(lan && devices),
      port: lan?.port ?? null,
      addresses: lan?.addresses() ?? [],
      fingerprint: lan?.fingerprint ?? null,
      devices: devices?.list() ?? [],
    }),
  );

  if (!lan || !devices) return;

  /** A new pairing code, as QR code (SVG, drawn here: no browser library) and text. */
  app.post('/api/lan/pairing', async (_request, reply) => {
    const addresses = lan.addresses();
    if (!addresses.length) {
      return reply.code(409).send({ error: 'This PC has no private network address (is it connected to your Wi-Fi?)' });
    }
    const { code, expiresAt } = devices.createPairingCode();
    const payload = pairingPayload({ addresses, port: lan.port, code, fingerprint: lan.fingerprint });
    const svg = await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
    return { payload, svg, expiresAt: expiresAt.toISOString(), addresses, port: lan.port };
  });

  app.delete('/api/lan/pairing', async (_request, reply) => {
    devices.cancelPairing();
    return reply.code(204).send();
  });

  /** Revoke a phone: its token stops working immediately. */
  app.delete('/api/lan/devices/:id', async (request, reply) => {
    const { id } = DeviceParams.parse(request.params);
    if (!devices.remove(id)) return reply.code(404).send({ error: 'Device not found' });
    return reply.code(204).send();
  });
}

const PairBody = z.object({
  code: z.string().trim().min(1).max(64),
  name: z.string().max(200).default('Phone'),
});

/** The bearer token of a request, if any. */
function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  const match = header ? /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header) : null;
  return match?.[1];
}

/**
 * Phone listener: private network only, no browser (Origin) requests, and a
 * paired device's token on every route but the pairing exchange itself.
 * Registered before the API routes (an onRequest hook).
 */
export function guardLanListener(app: FastifyInstance, devices: DeviceStore): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!isPrivateAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'Only devices on your private network may connect' });
    }
    // The phone app sends no Origin; a web page would (cross-site): refuse it.
    if (request.headers.origin) return reply.code(403).send({ error: 'Browser requests are not accepted here' });
    const path = request.url.split('?')[0];
    if (request.method === 'POST' && path === '/api/pair') return;
    if (!devices.authenticate(bearer(request))) {
      return reply.code(401).send({ error: 'This phone is not paired (scan the QR code in the PC settings)' });
    }
  });

  /** Exchange the one-time code from the QR code for this phone's token. */
  app.post('/api/pair', async (request, reply) => {
    const { code, name } = PairBody.parse(request.body);
    const paired = devices.pair(code, name);
    if (!paired) {
      return reply.code(403).send({ error: 'This pairing code is wrong or expired: show a new QR code on the PC' });
    }
    request.log.info({ device: paired.device.name }, 'phone paired');
    return { token: paired.token, device: paired.device };
  });
}
