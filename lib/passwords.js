'use strict';
// Password hashing with Node's built-in scrypt (memory-hard, no native
// add-ons to compile). Stored as: scrypt$N$r$p$saltB64$hashB64
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const N = 32768, R = 8, P = 1, KEYLEN = 64;
const MAXMEM = 128 * N * R * 2; // headroom for N

// A short list of passwords people actually use. Length rules catch most
// of the rest.
const COMMON = new Set([
  'password', 'password1', 'password123', '1234567890', '12345678910', 'qwertyuiop',
  'iloveyou123', 'admin12345', 'administrator', 'welcome123', 'protohub123',
  'iichub12345', 'letmein123', 'changeme123', 'india12345', 'abcdefghij',
]);

function checkPolicy(pw, { email, name } = {}) {
  if (typeof pw !== 'string') return 'Password is required.';
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 128) return 'Password must be at most 128 characters.';
  if (/^(.)\1+$/.test(pw)) return 'Password cannot be one repeated character.';
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common. Choose another.';
  const local = (email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return 'Password cannot contain your email name.';
  if (name && name.length >= 4 && lower.includes(name.toLowerCase().replace(/\s+/g, ''))) {
    return 'Password cannot contain your name.';
  }
  return null;
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// Hash used to spend the same time when the email doesn't exist, so the
// response time doesn't reveal which emails have accounts.
let dummyHash = null;
async function getDummyHash() {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

async function verifyPassword(pw, stored) {
  if (typeof pw !== 'string' || pw.length > 128) pw = '';
  if (!stored) {
    await verifyPassword(pw, await getDummyHash());
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(pw, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2,
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Readable temporary password for accounts created by an admin.
function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % alphabet.length];
  return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8, 12) + '-' + out.slice(12);
}

// One-time link tokens: the raw token goes in the email, only its hash
// is stored.
function newLinkToken() {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: sha256(raw) };
}
function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

module.exports = { checkPolicy, hashPassword, verifyPassword, tempPassword, newLinkToken, sha256 };
