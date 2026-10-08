/**
 * Phones allowed to use girllm over the local network (step 8), and the
 * one-time pairing code shown as a QR code on the PC.
 *
 * Pairing: the PC (localhost only) asks for a code; the phone scans the QR
 * code, connects to the pinned TLS listener and sends the code; the PC
 * answers with a long random token the phone keeps in its secure storage.
 * Every later request carries that token. Only a SHA-256 of each token is
 * stored, so the database alone can't be used to impersonate a phone.
 *
 *  - one code at a time, valid 5 minutes, single use, 5 wrong tries max;
 *  - tokens: 32 random bytes (base64url), unguessable;
 *  - devices are listed and removed from the PC's settings.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import type { Db } from '../db/database.js';

export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const PAIRING_MAX_ATTEMPTS = 5;
const MAX_DEVICE_NAME = 60;
/** last_seen_at is written at most this often per device (fewer writes). */
const LAST_SEEN_EVERY_MS = 60 * 1000;

export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface PairingCode {
  code: string;
  expiresAt: Date;
}

/** A device name as shown in the settings: no control characters, ≤ 60 chars. */
function cleanName(name: string): string {
  const printable = Array.from(name)
    .filter((ch) => ch >= ' ' && ch !== '\u007f')
    .join('');
  return printable.trim().slice(0, MAX_DEVICE_NAME) || 'Phone';
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Base32 (RFC 4648, no padding): easy to put in a QR code, no ambiguous symbols. */
function base32(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet.charAt((value << (5 - bits)) & 31);
  return out;
}

export class DeviceStore {
  private readonly stmt: Record<string, StatementSync>;
  private pending: { code: string; expiresAt: number; attempts: number } | undefined;
  private readonly lastSeenWritten = new Map<string, number>();

  constructor(
    db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.stmt = {
      insert: db.prepare('INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)'),
      byToken: db.prepare('SELECT id, name, created_at, last_seen_at FROM devices WHERE token_hash = ?'),
      list: db.prepare('SELECT id, name, created_at, last_seen_at FROM devices ORDER BY created_at'),
      remove: db.prepare('DELETE FROM devices WHERE id = ?'),
      seen: db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?'),
    };
  }

  /** A new one-time pairing code (replaces any previous one). */
  createPairingCode(): PairingCode {
    const code = base32(randomBytes(15)); // 24 characters, 120 bits
    const expiresAt = this.now().getTime() + PAIRING_TTL_MS;
    this.pending = { code, expiresAt, attempts: 0 };
    return { code, expiresAt: new Date(expiresAt) };
  }

  /** Forget the pending code (pairing cancelled on the PC). */
  cancelPairing(): void {
    this.pending = undefined;
  }

  /**
   * Exchange the pairing code for a token.
   * @returns the new device and its token (shown to the phone once), or
   *   undefined when the code is wrong, used or expired.
   */
  pair(code: string, name: string): { device: Device; token: string } | undefined {
    const pending = this.pending;
    if (!pending) return undefined;
    if (this.now().getTime() > pending.expiresAt) {
      this.pending = undefined;
      return undefined;
    }
    const given = Buffer.from(code.trim().toUpperCase());
    const expected = Buffer.from(pending.code);
    const ok = given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) {
      pending.attempts++;
      if (pending.attempts >= PAIRING_MAX_ATTEMPTS) this.pending = undefined; // brute force: start over
      return undefined;
    }
    this.pending = undefined; // single use
    const token = randomBytes(32).toString('base64url');
    const device: Device = {
      id: randomUUID(),
      name: cleanName(name),
      createdAt: this.now().toISOString(),
      lastSeenAt: null,
    };
    this.stmt.insert!.run(device.id, device.name, sha256(token), device.createdAt);
    return { device, token };
  }

  /** The device a bearer token belongs to (and note it was seen), or undefined. */
  authenticate(token: string | undefined): Device | undefined {
    if (!token || token.length > 200) return undefined;
    const row = this.stmt.byToken!.get(sha256(token)) as DeviceRow | undefined;
    if (!row) return undefined;
    const now = this.now();
    const last = this.lastSeenWritten.get(row.id) ?? 0;
    if (now.getTime() - last > LAST_SEEN_EVERY_MS) {
      this.stmt.seen!.run(now.toISOString(), row.id);
      this.lastSeenWritten.set(row.id, now.getTime());
    }
    return toDevice(row);
  }

  list(): Device[] {
    return (this.stmt.list!.all() as unknown as DeviceRow[]).map(toDevice);
  }

  /** Revoke a phone: its token stops working at once. */
  remove(id: string): boolean {
    this.lastSeenWritten.delete(id);
    return Number(this.stmt.remove!.run(id).changes) > 0;
  }
}

interface DeviceRow {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
}

const toDevice = (r: DeviceRow): Device => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
});
