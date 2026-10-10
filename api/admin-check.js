// api/admin-check.js – prüft serverseitig, ob das übermittelte Admin-Passwort gültig ist (Login der Admin-Seiten).
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!require('./_auth').isAdmin(req)) return res.status(401).json({ ok: false });
  return res.status(200).json({ ok: true });
};
