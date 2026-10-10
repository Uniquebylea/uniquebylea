// api/_auth.js
// Gemeinsame Admin-Prüfung. Dateien mit "_" werden von Vercel nicht als eigene Funktion veröffentlicht.
// Das Admin-Passwort kommt ausschliesslich aus der Umgebungsvariable ADMIN_PASSWORD (Vercel).
// Ist sie nicht gesetzt, wird jeder Admin-Zugriff abgewiesen (kein Standardpasswort im Code).
const crypto = require('crypto');

function extractToken(req) {
  const raw = req.headers['authorization'] || req.headers['x-admin-key'] || '';
  return String(raw).replace(/^bearer\s+/i, '').replace(/^token\s+/i, '').trim();
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAdmin(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  const given = extractToken(req);
  return !!given && safeEqual(given, expected);
}

module.exports = { isAdmin, extractToken, safeEqual };
