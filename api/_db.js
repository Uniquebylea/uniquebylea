// api/_db.js – schlanker, serverseitiger Supabase-Zugriff (PostgREST) ohne Zusatz-Abhängigkeiten.
// Benötigt SUPABASE_URL und SUPABASE_SECRET_KEY (nur in Vercel-Umgebungsvariablen, nie im Browser/Git).
function configured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

async function rest(method, table, opts) {
  opts = opts || {};
  if (!configured()) throw new Error('Datenbank nicht konfiguriert');
  const base = process.env.SUPABASE_URL.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (opts.prefer) headers.Prefer = opts.prefer;
  const urlPath = base.includes('/rest/v1') || base.includes(':3199') ? `${base}/${table}` : `${base}/rest/v1/${table}`;
  const res = await fetch(`${urlPath}${opts.query ? '?' + opts.query : ''}`, {
    method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
  if (!res.ok) {
    // Fehlertext bereinigen: nur Code/Meldung, keine Nutzdaten
    const msg = data && (data.message || data.error) ? String(data.message || data.error).substring(0, 200) : `HTTP ${res.status}`;
    const err = new Error(`DB ${method} ${table}: ${msg}`);
    err.status = res.status; err.code = data && data.code;
    throw err;
  }
  return data;
}

module.exports = {
  configured,
  select: (table, query) => rest('GET', table, { query }),
  insert: (table, rows, prefer) => rest('POST', table, { body: rows, prefer: prefer || 'return=representation' }),
  // Gibt die geänderten Zeilen zurück (leer = Bedingung traf nicht zu => atomare "Compare-and-Set"-Updates)
  update: (table, query, patch) => rest('PATCH', table, { query, body: patch, prefer: 'return=representation' })
};
