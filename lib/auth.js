import crypto from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(crypto.scrypt);

export const SESSION_COOKIE_NAME = 'smartai_session';
export const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 30;

export function normalizeEmail(email = '') {
  return String(email || '').trim().toLowerCase();
}

export function validatePasswordStrength(password = '') {
  return typeof password === 'string' && password.length >= 8;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await scryptAsync(password, salt, 64);
  return `scrypt:${salt}:${Buffer.from(derivedKey).toString('hex')}`;
}

export async function verifyPassword(password, storedHash = '') {
  const parts = String(storedHash || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const [, salt, storedDigest] = parts;
  const derivedKey = await scryptAsync(password, salt, 64);
  const digest = Buffer.from(derivedKey).toString('hex');

  const left = Buffer.from(digest, 'hex');
  const right = Buffer.from(storedDigest, 'hex');

  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((acc, pair) => {
    const index = pair.indexOf('=');
    if (index < 0) return acc;

    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key) return acc;

    try {
      acc[key] = decodeURIComponent(value);
    } catch {
      acc[key] = value;
    }

    return acc;
  }, {});
}

export function getSessionTokenFromRequest(req) {
  const cookies = parseCookies(req);
  return cookies[SESSION_COOKIE_NAME] || '';
}

export function buildSessionExpiry() {
  return new Date(Date.now() + SESSION_DURATION_MS);
}

export function setSessionCookie(res, token, expiresAt) {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}
