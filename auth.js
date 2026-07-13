"use strict";
const crypto = require('crypto');
const { query, one } = require('./db');

const SESSION_DAYS = 30;
const SCRYPT_N = 16384, SCRYPT_KEYLEN = 64;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(pw, salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${derived.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [algo, nStr, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = crypto.scryptSync(pw, salt, expected.length, { N: +nStr });
  return crypto.timingSafeEqual(derived, expected);
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function createUser(email, password, displayName) {
  const hash = hashPassword(password);
  const r = await query(
    'INSERT INTO users(email, password_hash, display_name) VALUES($1,$2,$3) RETURNING id, email, display_name, created_at',
    [email.toLowerCase().trim(), hash, displayName.trim()]
  );
  return r.rows[0];
}
async function findUserByEmail(email) {
  return one('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
}
async function findUserById(id) {
  return one('SELECT id, email, display_name, created_at FROM users WHERE id = $1', [id]);
}

async function createSession(userId) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await query('INSERT INTO sessions(token, user_id, expires_at) VALUES($1,$2,$3)', [token, userId, expires]);
  return { token, expires };
}
async function sessionUser(token) {
  if (!token) return null;
  const s = await one(
    'SELECT u.id, u.email, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > NOW()',
    [token]
  );
  return s;
}
async function deleteSession(token) {
  if (!token) return;
  await query('DELETE FROM sessions WHERE token = $1', [token]);
}

// pull session token out of a Cookie header
function tokenFromCookieHeader(header) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === 'splat_session') return rest.join('=');
  }
  return null;
}

module.exports = {
  createUser, findUserByEmail, findUserById,
  hashPassword, verifyPassword,
  createSession, sessionUser, deleteSession,
  tokenFromCookieHeader,
  SESSION_DAYS,
};
