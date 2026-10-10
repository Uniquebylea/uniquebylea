// api/_notify.js – E-Mail-Benachrichtigungen mit Protokollierung (Tabelle email_notifications).
// Versand über die Resend-REST-API (RESEND_API_KEY, EMAIL_FROM). Ohne Konfiguration bleibt der Eintrag
// "pending"/"failed" und kann später (Admin: «E-Mail erneut senden») wiederholt werden. Die Bestellung bleibt immer gespeichert.
const db = require('./_db');

const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || 'hello@uniquebylea.com';
const siteUrl = () => (process.env.SITE_URL || 'https://uniquebylea.com').replace(/\/+$/, '');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const chf = cents => `CHF ${(cents / 100).toFixed(2)}`;

function attrText(a) {
  a = a || {};
  const parts = [];
  if (a.color) parts.push(`Farbe: ${a.color}`);
  if (a.size) parts.push(`Grösse: ${a.size}`);
  if (a.customName) parts.push(`Wunschname: ${a.customName}`);
  if (a.optionsSummary) parts.push(a.optionsSummary);
  return parts.join(', ');
}

function buildEmail(kind, order, items) {
  const lines = items.map(i => `${i.quantity} × ${i.product_name}${attrText(i.attributes) ? ' (' + attrText(i.attributes) + ')' : ''} – ${chf(i.unit_price_cents * i.quantity)}`);
  const sums = [`Zwischensumme: ${chf(order.subtotal_cents)}`, `Versand: ${chf(order.shipping_cents)}`];
  if (order.discount_cents > 0) sums.push(`Gutschein: −${chf(order.discount_cents)}`);
  sums.push(`Total: ${chf(order.total_cents)}`);
  const itemsHtml = lines.map(l => `<li>${esc(l)}</li>`).join('');
  const sumsHtml = sums.map(l => `<div>${esc(l)}</div>`).join('');

  if (kind === 'customer_order_confirmation') {
    const name = order.customer_name ? ` ${order.customer_name}` : '';
    const delivery = order.shipping_type === 'pickup' ? 'Abholung im Atelier (Interlaken) – wir melden uns zur Terminabsprache.'
      : order.shipping_type === 'email' ? 'Dein Gutschein wird dir per E-Mail zugestellt.'
      : 'Wir bereiten deine Bestellung liebevoll für den Versand vor.';
    return {
      to: order.customer_email,
      subject: `Deine Bestellung ${order.order_number} bei Unique by Lea`,
      text: `Hallo${name},\n\nvielen Dank für deine Bestellung! Deine Zahlung ist bei uns eingegangen.\n\nBestellnummer: ${order.order_number}\n\n${lines.join('\n')}\n\n${sums.join('\n')}\n\n${delivery}\n\nHerzlich\nLea – Unique by Lea`,
      html: `<p>Hallo${esc(name)},</p><p>vielen Dank für deine Bestellung! Deine Zahlung ist bei uns eingegangen.</p><p><strong>Bestellnummer: ${esc(order.order_number)}</strong></p><ul>${itemsHtml}</ul>${sumsHtml}<p>${esc(delivery)}</p><p>Herzlich<br>Lea – Unique by Lea</p>`
    };
  }
  const adminLink = `${siteUrl()}/admin/bestellungen.html?order=${order.id}`;
  if (kind === 'operator_alert') {
    return {
      to: OPERATOR_EMAIL,
      subject: `⚠️ Bestellung ${order.order_number} braucht Aufmerksamkeit`,
      text: `Bestellung ${order.order_number}: ${order.needs_attention || 'Bitte prüfen'}\n\n${adminLink}`,
      html: `<p>Bestellung <strong>${esc(order.order_number)}</strong>: ${esc(order.needs_attention || 'Bitte prüfen')}</p><p><a href="${esc(adminLink)}">Zur Bestellung</a></p>`
    };
  }
  // operator_new_order
  const addr = order.shipping_address || {};
  const addrLine = [addr.name, addr.line1, addr.postal_code && `${addr.postal_code} ${addr.city || ''}`, addr.country].filter(Boolean).join(', ');
  return {
    to: OPERATOR_EMAIL,
    subject: `Neue bezahlte Bestellung ${order.order_number} (${chf(order.total_cents)})`,
    text: `Neue Bestellung ${order.order_number}\nZahlungsstatus: bezahlt\nBetrag: ${chf(order.total_cents)}\nKunde: ${order.customer_name || '-'} (${order.customer_email || '-'})\nLieferung: ${order.shipping_type}${addrLine ? ' – ' + addrLine : ''}\n\n${lines.join('\n')}\n\n${adminLink}`,
    html: `<p><strong>Neue bezahlte Bestellung ${esc(order.order_number)}</strong> – ${esc(chf(order.total_cents))}</p><p>Kunde: ${esc(order.customer_name || '-')} (${esc(order.customer_email || '-')})<br>Lieferung: ${esc(order.shipping_type)}${addrLine ? ' – ' + esc(addrLine) : ''}</p><ul>${itemsHtml}</ul><p><a href="${esc(adminLink)}">Bestellung im Admin-Bereich öffnen</a></p>`
  };
}

async function sendViaResend(mail, idemKey) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('E-Mail-Dienst nicht konfiguriert (RESEND_API_KEY fehlt)');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'Unique by Lea <hello@uniquebylea.com>',
      to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html
    })
  });
  if (!res.ok) {
    let m = ''; try { m = (await res.json()).message || ''; } catch (e) {}
    throw new Error(`Versand fehlgeschlagen (HTTP ${res.status}) ${String(m).substring(0, 120)}`);
  }
}

// Legt Benachrichtigungen idempotent an (UNIQUE order_id+kind) – wiederholte Webhooks erzeugen keine Duplikate
async function queue(order, kinds) {
  for (const kind of kinds) {
    const recipient = kind === 'customer_order_confirmation' ? order.customer_email : OPERATOR_EMAIL;
    if (!recipient) continue;
    try {
      await db.insert('email_notifications', [{ order_id: order.id, kind, recipient }], 'return=minimal');
    } catch (e) {
      // Wenn bereits vorhanden (Unique constraint), ignorieren
      if (!e.message || !e.message.includes('unique constraint')) throw e;
    }
  }
}

// Versendet alle offenen/fehlgeschlagenen Benachrichtigungen einer Bestellung. Wirft nie.
async function sendPending(orderId, opts) {
  opts = opts || {};
  const results = [];
  try {
    const orders = await db.select('orders', `id=eq.${orderId}&select=*`);
    if (!orders.length) return results;
    const order = orders[0];
    const items = await db.select('order_items', `order_id=eq.${orderId}&select=*`);
    const states = opts.includeFailed === false ? 'pending' : 'pending,failed';
    const rows = await db.select('email_notifications', `order_id=eq.${orderId}&status=in.(${states})&select=*`);
    for (const n of rows) {
      const claim = await db.update('email_notifications', `id=eq.${n.id}&status=in.(pending,failed)`, { last_attempt_at: new Date().toISOString(), attempts: n.attempts + 1 });
      if (!claim.length) continue;
      try {
        // Kundenmail nur bei verifizierter Zahlung
        if (n.kind === 'customer_order_confirmation' && order.payment_status !== 'paid') throw new Error('Zahlung nicht bestätigt – Mail nicht gesendet');
        await sendViaResend(buildEmail(n.kind, order, items), `order-${orderId}-${n.kind}`);
        await db.update('email_notifications', `id=eq.${n.id}`, { status: 'sent', sent_at: new Date().toISOString(), error_detail: null });
        results.push({ kind: n.kind, status: 'sent' });
      } catch (e) {
        await db.update('email_notifications', `id=eq.${n.id}`, { status: 'failed', error_detail: String(e.message).substring(0, 300) });
        results.push({ kind: n.kind, status: 'failed' });
      }
    }
  } catch (e) {
    console.error('Benachrichtigung fehlgeschlagen:', e.message);
  }
  return results;
}

module.exports = { queue, sendPending, buildEmail, OPERATOR_EMAIL };
