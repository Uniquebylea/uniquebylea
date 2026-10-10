// api/stripe-webhook.js
// Verarbeitet Stripe-Ereignisse. Eine Bestellung gilt NUR als bezahlt, wenn dieses Ereignis
//  1. eine gültige Stripe-Signatur über den unveränderten Request-Body trägt,
//  2. zu einer bei uns angelegten Bestellung gehört (order_id + gespeicherte Session-ID stimmen überein),
//  3. Betrag und Währung exakt der serverseitig gespeicherten Bestellung entsprechen und
//  4. payment_status = 'paid' (oder 'no_payment_required' bei voll gedecktem Betrag) lautet.
// Ein Browser-Redirect (success_url) ist nie ein Zahlungsnachweis.
//
// Verarbeitete Ereignisse (im Stripe-Dashboard für den Endpunkt aktivieren):
//  - checkout.session.completed            -> bezahlt, falls payment_status paid/no_payment_required; sonst (asynchrone Zahlarten) warten
//  - checkout.session.async_payment_succeeded -> bezahlt
//  - checkout.session.async_payment_failed -> Zahlung fehlgeschlagen
//  - checkout.session.expired              -> Bestellung abgelaufen/storniert (nur wenn noch unbezahlt)
// completed allein genügt NICHT für verzögerte Zahlarten; deshalb zusätzlich async_payment_*.
//
// Idempotenz: payment_events.stripe_event_id ist UNIQUE; Statuswechsel erfolgen als atomares
// "Compare-and-Set" (UPDATE ... WHERE payment_status IN (...)); E-Mails sind UNIQUE(order_id, kind);
// Gutscheinabbuchung UNIQUE(stripe_session_id).
const crypto = require('crypto');
const db = require('./_db');
const notify = require('./_notify');

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
  const parts = {};
  header.split(',').forEach(p => { const i = p.indexOf('='); if (i > 0) (parts[p.slice(0, i)] = parts[p.slice(0, i)] || []).push(p.slice(i + 1)); });
  const t = parts.t && parts.t[0];
  const sigs = parts.v1 || [];
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // Replay-Schutz
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  return sigs.some(sig => { const a = Buffer.from(expected); const b = Buffer.from(sig); return a.length === b.length && crypto.timingSafeEqual(a, b); });
}

async function history(orderId, kind, from, to, detail) {
  await db.insert('order_status_history', [{ order_id: orderId, kind, from_value: from, to_value: to, actor: 'stripe-webhook', detail }], 'return=minimal');
}

const { applyVoucherLedger } = require('./_voucher');

function extractCustomer(s) {
  const cd = s.customer_details || {};
  const ship = (s.collected_information && s.collected_information.shipping_details) || s.shipping_details || null;
  const pick = a => a ? { name: a.name || undefined, line1: a.address && a.address.line1, line2: a.address && a.address.line2, postal_code: a.address && a.address.postal_code, city: a.address && a.address.city, country: a.address && a.address.country } : null;
  return {
    customer_email: cd.email || null,
    customer_name: cd.name || null,
    customer_phone: cd.phone || null,
    billing_address: pick({ name: cd.name, address: cd.address }),
    shipping_address: pick(ship)
  };
}

async function findOrder(session) {
  const orderId = (session.metadata && session.metadata.order_id) || session.client_reference_id;
  if (!orderId || !/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  const rows = await db.select('orders', `id=eq.${orderId}&select=*`);
  const order = rows[0];
  if (!order || order.stripe_session_id !== session.id) return null; // Session muss zur Bestellung gehören
  return order;
}

async function markPaid(order, session) {
  if (session.currency !== 'chf' || session.amount_total !== order.total_cents) {
    await db.update('orders', `id=eq.${order.id}`, { needs_attention: `Betragsabweichung: Stripe ${session.amount_total}/${session.currency}, Bestellung ${order.total_cents}/chf` });
    await history(order.id, 'note', null, null, 'Betragsabweichung – nicht als bezahlt markiert');
    await notify.queue({ ...order, needs_attention: 'Betragsabweichung bei Stripe-Zahlung' }, ['operator_alert']);
    notify.sendPending(order.id).catch(() => {});
    return { status: 'failed', detail: 'amount_mismatch' };
  }
  const cust = extractCustomer(session);
  const changed = await db.update('orders', `id=eq.${order.id}&payment_status=in.(pending,failed,expired)`, {
    payment_status: 'paid',
    status: 'processing',
    paid_at: new Date().toISOString(),
    stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    needs_attention: order.payment_status === 'expired' || order.status === 'cancelled' ? 'Zahlung nach Ablauf/Storno eingegangen – bitte prüfen' : null,
    ...cust
  });
  if (!changed.length) return { status: 'ignored', detail: 'already_paid' }; // wiederholtes Ereignis
  const o = changed[0];
  await history(o.id, 'payment_status', order.payment_status, 'paid', 'Zahlung von Stripe bestätigt');
  await history(o.id, 'order_status', order.status, 'processing', null);

  // Gutschein erst jetzt (nach bestätigter Zahlung) abbuchen
  if (o.voucher_code && o.discount_cents > 0) {
    await db.insert('voucher_redemptions', [{ stripe_session_id: session.id, order_id: o.id, voucher_code: o.voucher_code, amount_cents: o.discount_cents }], 'resolution=ignore-duplicates,return=minimal');
    await applyVoucherLedger(o.voucher_code, o.discount_cents, session.id);
  }

  await notify.queue(o, ['operator_new_order', 'customer_order_confirmation']);
  if (o.needs_attention) await notify.queue(o, ['operator_alert']);
  await notify.sendPending(o.id); // Fehler hier lassen die gespeicherte Bestellung unberührt
  return { status: 'processed' };
}

async function handleEvent(event) {
  const s = event.data && event.data.object;
  if (!s || !String(event.type).startsWith('checkout.session.')) return { status: 'ignored', detail: 'unhandled_type' };
  const order = await findOrder(s);
  if (!order) return { status: 'failed', detail: 'order_not_found_or_session_mismatch' };

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') return { order, ...(await markPaid(order, s)) };
    return { order, status: 'ignored', detail: 'payment_pending_async' };
  }
  if (event.type === 'checkout.session.async_payment_failed') {
    const ch = await db.update('orders', `id=eq.${order.id}&payment_status=eq.pending`, { payment_status: 'failed', status: 'cancelled', cancelled_at: new Date().toISOString() });
    if (ch.length) await history(order.id, 'payment_status', 'pending', 'failed', 'Asynchrone Zahlung fehlgeschlagen');
    return { order, status: 'processed' };
  }
  if (event.type === 'checkout.session.expired') {
    const ch = await db.update('orders', `id=eq.${order.id}&payment_status=eq.pending`, { payment_status: 'expired', status: 'cancelled', cancelled_at: new Date().toISOString() });
    if (ch.length) { await history(order.id, 'payment_status', 'pending', 'expired', 'Checkout abgebrochen/abgelaufen'); await history(order.id, 'order_status', 'awaiting_payment', 'cancelled', null); }
    return { order, status: 'processed' };
  }
  return { order, status: 'ignored', detail: 'unhandled_type' };
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
  if (!event.id) return res.status(400).end();

  try {
    // Ereignis exakt einmal registrieren; Duplikat + bereits verarbeitet => sofort bestätigen
    let inserted = [];
    try {
      inserted = await db.insert('payment_events', [{ stripe_event_id: event.id, event_type: event.type }], 'return=representation');
    } catch (insertErr) {
      if (insertErr.status === 409 || (insertErr.message && insertErr.message.includes('unique constraint'))) {
        const prev = await db.select('payment_events', `stripe_event_id=eq.${encodeURIComponent(event.id)}&select=processing_status`);
        if (prev[0] && prev[0].processing_status !== 'failed' && prev[0].processing_status !== 'received') {
          return res.status(200).json({ received: true, duplicate: true });
        }
      } else {
        throw insertErr;
      }
    }
    let result;
    try {
      result = await handleEvent(event);
    } catch (e) {
      await db.update('payment_events', `stripe_event_id=eq.${encodeURIComponent(event.id)}`, { processing_status: 'failed', error_detail: String(e.message).substring(0, 300) });
      console.error('Webhook-Verarbeitung fehlgeschlagen:', e.message);
      return res.status(500).json({ error: 'Verarbeitung fehlgeschlagen' }); // Stripe wiederholt automatisch
    }
    await db.update('payment_events', `stripe_event_id=eq.${encodeURIComponent(event.id)}`, {
      processing_status: result.status === 'failed' ? 'failed' : result.status,
      processed_at: new Date().toISOString(),
      order_id: result.order ? result.order.id : null,
      error_detail: result.detail || null
    });
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('Webhook-Fehler:', e.message);
    return res.status(500).json({ error: 'Verarbeitung fehlgeschlagen' });
  }
};

module.exports.config = { api: { bodyParser: false } };
module.exports._internal = { verifySignature };
