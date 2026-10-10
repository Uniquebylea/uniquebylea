// api/admin-orders.js – Bestellverwaltung (nur Admin; Prüfung serverseitig über api/_auth.js)
//   GET  /api/admin-orders                     -> Liste (Filter: status, payment_status, unread=1, limit)
//   GET  /api/admin-orders?id=<uuid>           -> Detail inkl. Positionen, Historie, Benachrichtigungen
//   POST /api/admin-orders {action:'set_status', id, status, tracking_number?}
//   POST /api/admin-orders {action:'mark_read', id}
//   POST /api/admin-orders {action:'retry_email', id}
// Manuelle Statusänderungen ändern NIE den Zahlungsstatus. Rückerstattungen sind hier bewusst nicht
// implementiert (finanzielle Aktion nur direkt im Stripe-Dashboard, danach hier dokumentieren).
const db = require('./_db');
const notify = require('./_notify');
const { isAdmin } = require('./_auth');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_STATUSES = ['awaiting_payment', 'processing', 'shipped', 'completed', 'cancelled'];
const PAY_STATUSES = ['pending', 'paid', 'failed', 'expired', 'refunded', 'partially_refunded'];

// Erlaubte manuelle Übergänge. Versand/Abschluss nur bei bestätigter Zahlung (siehe unten).
const TRANSITIONS = {
  awaiting_payment: ['cancelled'],
  processing: ['shipped', 'completed', 'cancelled'],
  shipped: ['completed'],
  completed: [],
  cancelled: []
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAdmin(req)) return res.status(401).json({ error: 'Nicht autorisiert.' });
  if (!db.configured()) return res.status(503).json({ error: 'Datenbank nicht konfiguriert.' });

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.id) {
        if (!UUID.test(q.id)) return res.status(400).json({ error: 'Ungültige ID.' });
        const [orders, items, hist, mails, events] = await Promise.all([
          db.select('orders', `id=eq.${q.id}&select=*`),
          db.select('order_items', `order_id=eq.${q.id}&select=*`),
          db.select('order_status_history', `order_id=eq.${q.id}&select=*&order=created_at.asc`),
          db.select('email_notifications', `order_id=eq.${q.id}&select=*&order=created_at.asc`),
          db.select('payment_events', `order_id=eq.${q.id}&select=stripe_event_id,event_type,processing_status,received_at,error_detail&order=received_at.asc`)
        ]);
        if (!orders.length) return res.status(404).json({ error: 'Bestellung nicht gefunden.' });
        const o = orders[0];
        const mode = String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test') ? 'test/' : '';
        return res.status(200).json({
          order: o, items, history: hist, notifications: mails, payment_events: events,
          stripe_url: o.stripe_payment_intent_id ? `https://dashboard.stripe.com/${mode}payments/${o.stripe_payment_intent_id}` : null
        });
      }
      const filters = [];
      if (q.status) { if (!ORDER_STATUSES.includes(q.status)) return res.status(400).json({ error: 'Ungültiger Status.' }); filters.push(`status=eq.${q.status}`); }
      if (q.payment_status) { if (!PAY_STATUSES.includes(q.payment_status)) return res.status(400).json({ error: 'Ungültiger Zahlungsstatus.' }); filters.push(`payment_status=eq.${q.payment_status}`); }
      if (q.unread === '1') filters.push('admin_read_at=is.null', 'payment_status=eq.paid');
      const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 100));
      const rows = await db.select('orders',
        `select=id,order_number,created_at,status,payment_status,customer_name,customer_email,total_cents,currency,shipping_type,admin_read_at,needs_attention&order=created_at.desc&limit=${limit}${filters.length ? '&' + filters.join('&') : ''}`);
      const failedMails = await db.select('email_notifications', 'status=eq.failed&select=order_id');
      const failedSet = new Set(failedMails.map(m => m.order_id));
      return res.status(200).json({ orders: rows.map(r => ({ ...r, email_failed: failedSet.has(r.id) })) });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      const { action, id } = body || {};
      if (!UUID.test(id || '')) return res.status(400).json({ error: 'Ungültige ID.' });
      const rows = await db.select('orders', `id=eq.${id}&select=*`);
      if (!rows.length) return res.status(404).json({ error: 'Bestellung nicht gefunden.' });
      const order = rows[0];

      if (action === 'mark_read') {
        await db.update('orders', `id=eq.${id}`, { admin_read_at: new Date().toISOString() });
        return res.status(200).json({ ok: true });
      }

      if (action === 'retry_email') {
        const result = await notify.sendPending(id, { includeFailed: true });
        return res.status(200).json({ ok: true, results: result });
      }

      if (action === 'set_status') {
        const target = body.status;
        if (!ORDER_STATUSES.includes(target)) return res.status(400).json({ error: 'Ungültiger Status.' });
        if (!TRANSITIONS[order.status].includes(target)) {
          return res.status(409).json({ error: `Übergang ${order.status} → ${target} ist nicht erlaubt.` });
        }
        // Versand/Abschluss nur bei verifizierter Zahlung – ein manueller Status täuscht keine Zahlung vor
        if ((target === 'shipped' || target === 'completed') && order.payment_status !== 'paid') {
          return res.status(409).json({ error: 'Zahlung ist nicht bestätigt.' });
        }
        const patch = { status: target };
        const now = new Date().toISOString();
        if (target === 'shipped') { patch.shipped_at = now; if (body.tracking_number) patch.tracking_number = String(body.tracking_number).substring(0, 100); }
        if (target === 'completed') patch.completed_at = now;
        if (target === 'cancelled') patch.cancelled_at = now;
        // Compare-and-Set: nur wenn Status unverändert (verhindert Überschreiben bei parallelen Änderungen)
        const changed = await db.update('orders', `id=eq.${id}&status=eq.${order.status}`, patch);
        if (!changed.length) return res.status(409).json({ error: 'Bestellung wurde zwischenzeitlich geändert.' });
        await db.insert('order_status_history', [{
          order_id: id, kind: 'order_status', from_value: order.status, to_value: target, actor: 'admin',
          detail: target === 'cancelled' && order.payment_status === 'paid' ? 'Storniert – Rückerstattung muss separat in Stripe erfolgen' : null
        }], 'return=minimal');
        return res.status(200).json({ ok: true, order: changed[0] });
      }
      return res.status(400).json({ error: 'Unbekannte Aktion.' });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('admin-orders:', e.message);
    return res.status(500).json({ error: 'Interner Fehler.' });
  }
};
