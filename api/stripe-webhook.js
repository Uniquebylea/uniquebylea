// api/stripe-webhook.js
// Empfängt Stripe-Ereignisse (Signaturprüfung mit STRIPE_WEBHOOK_SECRET) und bucht Gutschein-Guthaben
// erst nach bestätigter Zahlung ab. Idempotent: pro Stripe-Session wird höchstens einmal abgebucht.
// Einrichtung: Stripe Dashboard -> Entwickler -> Webhooks -> Endpunkt https://uniquebylea.com/api/stripe-webhook
// mit Ereignis "checkout.session.completed"; das Signing-Secret in Vercel als STRIPE_WEBHOOK_SECRET speichern.
const crypto = require('crypto');

module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, header, secret) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')));
  const t = parts.t;
  const sig = parts.v1;
  if (!t || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // Replay-Schutz (5 Min.)
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function redeemVoucher(code, amount, sessionId) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN fehlt');
  const url = 'https://api.github.com/repos/Uniquebylea/uniquebylea/contents/content/vouchers.json';
  const headers = { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'UniqueByLea-Webhook', 'Content-Type': 'application/json' };

  for (let attempt = 0; attempt < 3; attempt++) {
    const getRes = await fetch(`${url}?ref=main`, { headers });
    if (!getRes.ok) throw new Error(`Gutscheine nicht ladbar (${getRes.status})`);
    const file = await getRes.json();
    const vouchers = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')).vouchers || [];
    const v = vouchers.find(x => (x.code || '').trim().toUpperCase() === code);
    if (!v) throw new Error('Gutschein nicht gefunden');

    if ((v.transactions || []).some(t => t.session_id === sessionId)) return 'already_processed';

    const balance = Number(v.remaining_balance) || 0;
    const charged = Math.min(balance, amount);
    v.remaining_balance = Math.round((balance - charged) * 100) / 100;
    v.status = v.remaining_balance === 0 ? 'fully_redeemed' : 'partially_redeemed';
    if (!Array.isArray(v.transactions)) v.transactions = [];
    v.transactions.push({
      date: new Date().toISOString().slice(0, 10),
      type: 'redeem',
      amount: charged,
      note: charged < amount ? 'Shop-Kauf (Guthaben war geringer als Rabatt – bitte prüfen)' : 'Shop-Kauf',
      session_id: sessionId,
      new_balance: v.remaining_balance
    });

    const putRes = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Redeem CHF ${charged.toFixed(2)} from ${code}`,
        content: Buffer.from(JSON.stringify({ vouchers }, null, 2), 'utf8').toString('base64'),
        sha: file.sha,
        branch: 'main'
      })
    });
    if (putRes.ok) return 'redeemed';
    if (putRes.status !== 409) throw new Error(`Speichern fehlgeschlagen (${putRes.status})`);
    // 409 = paralleler Schreibzugriff -> erneut versuchen
  }
  throw new Error('Gutschein-Update nach 3 Versuchen nicht möglich');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'Webhook nicht konfiguriert' });

  const raw = await readRawBody(req);
  if (!verifySignature(raw, req.headers['stripe-signature'], secret)) {
    return res.status(400).json({ error: 'Ungültige Signatur' });
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).end(); }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const paid = s.payment_status === 'paid' || s.payment_status === 'no_payment_required';
      const code = (s.metadata && s.metadata.eingeloester_gutschein || '').trim().toUpperCase();
      const amount = parseFloat(s.metadata && s.metadata.gutschein_rabatt_chf);
      if (paid && code && amount > 0) {
        const result = await redeemVoucher(code, amount, s.id);
        console.log(`Webhook: Gutschein ${code} ${result} (Session ${s.id})`);
      }
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('Webhook-Verarbeitung fehlgeschlagen:', e.message);
    // 500 -> Stripe wiederholt die Zustellung automatisch
    return res.status(500).json({ error: 'Verarbeitung fehlgeschlagen' });
  }
};

module.exports.config = { api: { bodyParser: false } };
