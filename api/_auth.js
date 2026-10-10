// api/_auth.js
// Gemeinsame Admin-Prüfung. Dateien mit "_" werden von Vercel nicht als eigene Funktion veröffentlicht.
// Das Admin-Passwort kommt ausschliesslich aus der Umgebungsvariable ADMIN_PASSWORD (Vercel).
// Ist sie nicht gesetzt oder zu kurz (< 12 Zeichen), wird jeder Admin-Zugriff abgewiesen.
// Brute-Force-Bremse: nach 10 Fehlversuchen pro IP in 15 Minuten wird die IP gesperrt
// (best effort, pro Serverinstanz im Speicher – bei Serverless kein vollwertiger Ersatz für ein verteiltes Limit).
const crypto = require('crypto');

const MIN_LENGTH = 12;
const MAX_FAILS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const fails = new Map();

function extractToken(req) {
  const raw = req.headers['authorization'] || req.headers['x-admin-key'] || '';
  return String(raw).replace(/^bearer\s+/i, '').replace(/^token\s+/i, '').trim();
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isLocked(ip) {
  const e = fails.get(ip);
  if (!e) return false;
  if (Date.now() - e.first > WINDOW_MS) { fails.delete(ip); return false; }
  return e.count >= MAX_FAILS;
}

function registerFail(ip) {
  const e = fails.get(ip);
  if (!e || Date.now() - e.first > WINDOW_MS) fails.set(ip, { first: Date.now(), count: 1 });
  else e.count++;
}

function isAdmin(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || expected.length < MIN_LENGTH) return false;
  const ip = clientIp(req);
  if (isLocked(ip)) return false;
  const given = extractToken(req);
  if (!given) return false;
  const ok = safeEqual(given, expected);
  if (!ok) registerFail(ip);
  return ok;
}

function resetForTests() { fails.clear(); }

module.exports = { isAdmin, extractToken, safeEqual, clientIp, resetForTests, MIN_LENGTH };
