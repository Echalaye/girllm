/**
 * The phone connection's TLS certificate (step 8): self-signed, made once on
 * the PC and kept in DATA_DIR/lan. The phone app does not trust it through
 * a certificate authority: it PINS its SHA-256 fingerprint, received in the
 * pairing QR code. So the hostname / IP inside the certificate don't matter,
 * nobody on the network can impersonate the PC, and nothing ever needs an
 * internet connection (no Let's Encrypt, no public DNS).
 *
 * The X.509 structure is built by hand (DER) and signed with Node's crypto:
 * an ECDSA P-256 key, SHA-256 signature, version 3 without extensions. It is
 * small and fully checked by the tests (parsed by node:crypto, signature
 * verified, used for a real TLS handshake), and needs no dependency.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
} from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../util/atomicWrite.js';

/** How long the certificate is valid (re-pairing is needed when it changes). */
export const CERT_VALIDITY_YEARS = 10;

export interface LanCertificate {
  /** PEM, for Node's https server. */
  key: string;
  cert: string;
  /** SHA-256 of the DER certificate, lowercase hex: what the phone pins. */
  fingerprint: string;
}

// ---- Minimal DER encoder -----------------------------------------------------

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, value: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), length(value.length), value]);
const sequence = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));

/** INTEGER from unsigned big-endian bytes (a leading 0 keeps it positive). */
function integer(bytes: Buffer): Buffer {
  let value = bytes;
  while (value.length > 1 && value[0] === 0 && value[1]! < 0x80) value = value.subarray(1);
  if (value[0]! >= 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return tlv(0x02, value);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes: number[] = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [];
    let v = part;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i]! |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime (valid until 2049, plenty for 10 years). */
function utcTime(date: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const text =
    p(date.getUTCFullYear() % 100) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    'Z';
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const COMMON_NAME = '2.5.4.3';

/** Name with a single CN. */
const name = (cn: string) => sequence(set(sequence(oid(COMMON_NAME), tlv(0x0c, Buffer.from(cn, 'utf8')))));

/**
 * Build a self-signed certificate for this key pair.
 * Pure apart from the random serial (exported for tests).
 */
export function selfSignedCertificate(
  privateKeyPem: string,
  o: { commonName?: string; now?: Date; years?: number } = {},
): string {
  const privateKey = createPrivateKey(privateKeyPem);
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const now = o.now ?? new Date();
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000); // tolerate a phone clock slightly behind
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + (o.years ?? CERT_VALIDITY_YEARS));
  const algorithm = sequence(oid(ECDSA_WITH_SHA256));
  const subject = name(o.commonName ?? 'girllm (local network)');
  const serial = randomBytes(16);
  serial[0]! &= 0x7f; // positive

  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // [0] version: v3
    integer(serial),
    algorithm,
    subject, // issuer = subject: self-signed
    sequence(utcTime(notBefore), utcTime(notAfter)),
    subject,
    spki,
  );
  const signature = sign('sha256', tbs, privateKey); // DER ECDSA-Sig-Value
  const der = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const b64 = der.toString('base64').replace(/.{1,64}/g, '$&\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}-----END CERTIFICATE-----\n`;
}

/** SHA-256 of a PEM certificate's DER bytes, lowercase hex (what the phone pins). */
export function certificateFingerprint(certPem: string): string {
  return createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex');
}

/**
 * The certificate of this PC, made on first use (DATA_DIR/lan/key.pem and
 * cert.pem; the key never leaves the PC). Remade when missing, unreadable or
 * expired, which means phones must pair again.
 */
export async function loadOrCreateCertificate(dir: string, now = new Date()): Promise<LanCertificate> {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  if (existsSync(keyPath) && existsSync(certPath)) {
    try {
      const [key, cert] = await Promise.all([readFile(keyPath, 'utf8'), readFile(certPath, 'utf8')]);
      const parsed = new X509Certificate(cert);
      if (new Date(parsed.validTo) > now && parsed.checkPrivateKey(createPrivateKey(key))) {
        return { key, cert, fingerprint: certificateFingerprint(cert) };
      }
    } catch {
      /* unreadable: made again below */
    }
  }
  await mkdir(dir, { recursive: true });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const cert = selfSignedCertificate(key, { now });
  await writeFileAtomic(keyPath, key, { mode: 0o600 });
  await writeFileAtomic(certPath, cert);
  return { key, cert, fingerprint: certificateFingerprint(cert) };
}
