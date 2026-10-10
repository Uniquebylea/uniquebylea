// api/create-checkout-session.js
// Erstellt eine Stripe Checkout-Session. ALLE Beträge werden serverseitig aus vertrauenswürdigen Daten berechnet
// (content/products.json, feste Versandtabelle, content/vouchers.json). Werte aus dem Browser gelten nur als Auswahl,
// nie als Preis. Gutschein-Guthaben wird hier NICHT abgebucht, sondern erst im Stripe-Webhook (api/stripe-webhook.js)
// nach bestätigter Zahlung.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./_db');

const SHIPPING_TYPES = ['bpost', 'apost', 'letter', 'email', 'pickup'];
const FREE_SHIPPING_FROM = 100;
const VOUCHER_MIN = 10;
const VOUCHER_MAX = 500;
const MAX_QTY = 20;
const MAX_ITEMS = 50;

function parsePrice(str) {
  if (typeof str === 'number') return str;
  if (!str) return 0;
  const match = str.toString().match(/(\d+(?:\.\d{1,2})?)/);
  return match ? parseFloat(match[1]) : 0;
}

function isVoucherItem(item) {
  return item.cat === 'Gutscheine' || (item.name && item.name.toLowerCase().includes('gutschein'));
}

// Versandkosten ausschliesslich serverseitig
function computeShipping(shippingType, subtotal, onlyVouchers) {
  if (shippingType === 'email' || shippingType === 'pickup') return 0;
  if (shippingType === 'letter') return 2.0;
  if (shippingType === 'apost') return subtotal >= FREE_SHIPPING_FROM ? 0 : 9.0;
  // bpost (Standard)
  return subtotal >= FREE_SHIPPING_FROM ? 0 : 7.0;
}

async function loadVouchers() {
  const vPath = path.join(process.cwd(), 'content', 'vouchers.json');
  const ghToken = process.env.GITHUB_TOKEN;
  if (ghToken) {
    try {
      const ghRes = await fetch('https://api.github.com/repos/Uniquebylea/uniquebylea/contents/content/vouchers.json?ref=main', {
        headers: { 'Authorization': `token ${ghToken}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'UniqueByLea-Checkout' }
      });
      if (ghRes.ok) {
        const ghJson = await ghRes.json();
        return JSON.parse(Buffer.from(ghJson.content, 'base64').toString('utf8')).vouchers || [];
      }
    } catch (e) {}
  }
  try {
    if (fs.existsSync(vPath)) return JSON.parse(fs.readFileSync(vPath, 'utf8')).vouchers || [];
  } catch (e) {}
  return [];
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  const allowedOrigins = ['https://uniquebylea.com', 'https://www.uniquebylea.com', 'https://uniquebylea.vercel.app'];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(500).json({ error: 'Die Bezahlung ist aktuell nicht verfügbar.' });
  }
  // Keine Zahlung ohne Bestellspeicherung
  if (!db.configured()) {
    console.error('SUPABASE_URL / SUPABASE_SECRET_KEY fehlen');
    return res.status(503).json({ error: 'Die Bestellung ist aktuell nicht möglich. Bitte versuche es später erneut.' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const { items, voucherCode } = body || {};
    const shippingType = SHIPPING_TYPES.includes(body && body.shippingType) ? body.shippingType : 'bpost';

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Warenkorb ist leer.' });
    }
    if (items.length > MAX_ITEMS) {
      return res.status(400).json({ error: 'Zu viele Positionen im Warenkorb.' });
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host || 'uniquebylea.vercel.app';
    const baseUrl = `https://${host}`;

    // 1. Katalog laden (vertrauenswürdige Quelle)
    let catalogProducts = [];
    try {
      const prodPath = path.join(process.cwd(), 'content', 'products.json');
      const pRaw = JSON.parse(fs.readFileSync(prodPath, 'utf8'));
      catalogProducts = pRaw.produkte || [];
    } catch (e) {
      console.error('products.json nicht lesbar:', e.message);
      return res.status(500).json({ error: 'Katalog derzeit nicht verfügbar. Bitte später erneut versuchen.' });
    }

    // 2. Positionen serverseitig validieren
    let totalItemAmount = 0;
    const validatedItems = [];
    for (const item of items) {
      const nameKey = (item.name || '').trim().toLowerCase();
      const found = catalogProducts.find(p =>
        (item.id && p.id === item.id) ||
        (item.sku && p.sku === item.sku) ||
        (p.name || '').trim().toLowerCase() === nameKey
      );

      let qty = Math.max(1, Math.min(MAX_QTY, parseInt(item.quantity, 10) || 1));
      let price;

      if (found) {
        // Aufpreis nur akzeptieren, wenn er in den Optionen des Katalogprodukts tatsächlich existiert
        const allowedAdds = [];
        (found.options || []).forEach(o => (o.values || []).forEach(v => allowedAdds.push(Number(v.price_add) || 0)));
        const requestedAdd = Number(item.optionPriceAdd) || 0;
        const optAdd = (requestedAdd === 0 || allowedAdds.includes(requestedAdd)) ? requestedAdd : 0;
        price = parsePrice(found.price) + optAdd;
        // Unikate nur einmal
        if (found.is_unique) qty = 1;
      } else if (isVoucherItem(item)) {
        // Individueller Wertgutschein (nicht im Katalog): Betrag nur in festen Grenzen
        const wert = Number(item.voucherConfig && item.voucherConfig.wert) || parsePrice(item.name);
        if (!(wert >= VOUCHER_MIN && wert <= VOUCHER_MAX)) {
          return res.status(400).json({ error: `Gutscheinwert muss zwischen CHF ${VOUCHER_MIN} und ${VOUCHER_MAX} liegen.` });
        }
        price = Math.round(wert);
      } else {
        return res.status(400).json({ error: `Produkt «${String(item.name || '').substring(0, 60)}» ist nicht mehr verfügbar.` });
      }

      if (!(price > 0)) {
        return res.status(400).json({ error: 'Ungültiger Preis. Bitte Warenkorb aktualisieren.' });
      }

      totalItemAmount += price * qty;
      validatedItems.push({ ...item, validatedPrice: price, quantity: qty });
    }

    const onlyVouchers = validatedItems.every(isVoucherItem);
    const isVoucherEmailOnly = shippingType === 'email' && onlyVouchers;
    // E-Mail-Versand nur für reine Gutschein-Bestellungen zulässig
    if (shippingType === 'email' && !onlyVouchers) {
      return res.status(400).json({ error: 'E-Mail-Versand ist nur für Gutscheine möglich.' });
    }

    const shippingCost = isVoucherEmailOnly ? 0 : computeShipping(shippingType, totalItemAmount, onlyVouchers);
    const grandTotal = totalItemAmount + shippingCost;

    // 3. Gutschein: nur berechnen und als Stripe-Rabatt anwenden. Abbuchung erfolgt im Webhook.
    let stripeCouponId = null;
    let appliedDiscountChf = 0;
    let appliedVoucherCode = '';

    if (voucherCode && typeof voucherCode === 'string' && voucherCode.trim()) {
      const codeUpper = voucherCode.trim().toUpperCase().substring(0, 64);
      const vouchersList = await loadVouchers();
      const target = vouchersList.find(v => (v.code || '').trim().toUpperCase() === codeUpper);
      if (!target) {
        return res.status(400).json({ error: 'Gutscheincode nicht gefunden.' });
      }
      const remainingBal = Number(target.remaining_balance) || 0;
      if (!(remainingBal > 0) || target.status === 'fully_redeemed') {
        return res.status(400).json({ error: 'Dieser Gutschein hat kein Guthaben mehr.' });
      }
      // Gutscheine dürfen keine Gutscheine bezahlen
      if (!onlyVouchers) {
        appliedDiscountChf = Math.min(totalItemAmount, remainingBal); // Stripe-Coupons rabattieren nur Positionen, nicht den Versand
        appliedVoucherCode = codeUpper;
        const discountCents = Math.round(appliedDiscountChf * 100);

        const cpBody = new URLSearchParams();
        cpBody.append('amount_off', discountCents.toString());
        cpBody.append('currency', 'chf');
        cpBody.append('duration', 'once');
        cpBody.append('max_redemptions', '1');
        cpBody.append('name', `Gutschein: ${codeUpper}`);

        const cpRes = await fetch('https://api.stripe.com/v1/coupons', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: cpBody.toString()
        });
        const cpData = await cpRes.json();
        if (!cpData.id) {
          console.error('Stripe Coupon Fehler:', cpData.error && cpData.error.message);
          return res.status(502).json({ error: 'Gutschein konnte nicht angewendet werden. Bitte später erneut versuchen.' });
        }
        stripeCouponId = cpData.id;
      } else {
        return res.status(400).json({ error: 'Gutscheine können nicht mit Gutscheinen bezahlt werden.' });
      }
    }

    // 3b. Bestellung (ausstehend) anlegen. Doppelklick/Wiederholung: identischer Warenkorb innerhalb von 10 Min. -> gleiche Session
    const toCents = v => Math.round(v * 100);
    const subtotalCents = validatedItems.reduce((a, i) => a + toCents(i.validatedPrice) * i.quantity, 0);
    const shippingCents = toCents(shippingCost);
    const discountCents = toCents(appliedDiscountChf);
    const cartHash = crypto.createHash('sha256').update(JSON.stringify({
      i: validatedItems.map(i => [i.name, i.validatedPrice, i.quantity, i.color || '', i.size || '', i.customName || '', i.optionsSummary || '']),
      s: shippingType, v: appliedVoucherCode
    })).digest('hex');

    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const existing = await db.select('orders', `cart_hash=eq.${cartHash}&payment_status=eq.pending&stripe_session_url=not.is.null&created_at=gte.${since}&select=id,stripe_session_url,order_number&limit=1`);
    if (existing.length) {
      return res.status(200).json({ url: existing[0].stripe_session_url, orderNumber: existing[0].order_number });
    }

    const [order] = await db.insert('orders', [{
      shipping_type: shippingType,
      currency: 'CHF',
      subtotal_cents: subtotalCents,
      shipping_cents: shippingCents,
      discount_cents: discountCents,
      total_cents: subtotalCents + shippingCents - discountCents,
      voucher_code: appliedVoucherCode || null,
      cart_hash: cartHash
    }]);
    await db.insert('order_items', validatedItems.map(i => ({
      order_id: order.id,
      product_id: i.id ? String(i.id).substring(0, 100) : null,
      sku: i.sku ? String(i.sku).substring(0, 100) : null,
      product_name: String(i.name).substring(0, 250),
      unit_price_cents: toCents(i.validatedPrice),
      quantity: i.quantity,
      attributes: {
        color: i.color ? String(i.color).substring(0, 60) : undefined,
        size: i.size ? String(i.size).substring(0, 40) : undefined,
        customName: i.customName ? String(i.customName).substring(0, 60) : undefined,
        optionsSummary: i.optionsSummary ? String(i.optionsSummary).substring(0, 300) : undefined,
        voucherConfig: i.voucherConfig ? {
          wert: i.voucherConfig.wert, fuer: String(i.voucherConfig.fuer || '').substring(0, 100),
          von: String(i.voucherConfig.von || '').substring(0, 100), theme: String(i.voucherConfig.theme || '').substring(0, 40)
        } : undefined
      }
    })), 'return=minimal');
    await db.insert('order_status_history', [{ order_id: order.id, kind: 'order_status', from_value: null, to_value: 'awaiting_payment', actor: 'checkout', detail: 'Bestellung angelegt' }], 'return=minimal');

    // 4. Stripe Checkout Session
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('billing_address_collection', 'required');

    if (!isVoucherEmailOnly) {
      params.append('shipping_address_collection[allowed_countries][0]', 'CH');
      params.append('shipping_address_collection[allowed_countries][1]', 'LI');
    }

    params.append('success_url', `${baseUrl}/shop.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url', `${baseUrl}/shop.html?checkout=canceled`);

    if (stripeCouponId) params.append('discounts[0][coupon]', stripeCouponId);

    validatedItems.forEach((item, index) => {
      params.append(`line_items[${index}][price_data][currency]`, 'chf');
      params.append(`line_items[${index}][price_data][unit_amount]`, Math.round(item.validatedPrice * 100).toString());
      params.append(`line_items[${index}][price_data][product_data][name]`, String(item.name || 'Produkt').substring(0, 250));

      const descParts = [];
      if (item.color) descParts.push(`Farbe: ${String(item.color).substring(0, 60)}`);
      if (item.size) descParts.push(`Grösse: ${String(item.size).substring(0, 40)}`);
      if (item.customName) descParts.push(`Wunschname: ${String(item.customName).substring(0, 60)}`);
      if (item.optionsSummary) descParts.push(String(item.optionsSummary).substring(0, 300));
      if (item.voucherConfig) {
        if (item.voucherConfig.fuer) descParts.push(`Für: ${String(item.voucherConfig.fuer).substring(0, 100)}`);
        if (item.voucherConfig.von) descParts.push(`Von: ${String(item.voucherConfig.von).substring(0, 100)}`);
        if (item.voucherConfig.theme) descParts.push(`Design: ${String(item.voucherConfig.theme).substring(0, 40)}`);
      }
      if (descParts.length > 0) {
        params.append(`line_items[${index}][price_data][product_data][description]`, descParts.join(' | ').substring(0, 500));
      }
      params.append(`line_items[${index}][quantity]`, item.quantity.toString());
    });

    const shippingNames = {
      bpost: 'Schweizerische Post (B-Post Paket)',
      apost: 'Schweizerische Post (A-Post Paket)',
      letter: 'Schweizerische Post (Briefversand Gutscheinkarte)',
      email: 'Gutschein per E-Mail (PDF zum Ausdrucken, gratis)',
      pickup: 'Abholung im Atelier (Interlaken)'
    };
    if (!isVoucherEmailOnly) {
      params.append('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
      params.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', Math.round(shippingCost * 100).toString());
      params.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'chf');
      params.append('shipping_options[0][shipping_rate_data][display_name]', shippingNames[shippingType]);
    }

    // Metadaten (vom Webhook ausgewertet)
    params.append('metadata[shipping_type]', shippingType);
    if (appliedVoucherCode && appliedDiscountChf > 0) {
      params.append('metadata[eingeloester_gutschein]', appliedVoucherCode);
      params.append('metadata[gutschein_rabatt_chf]', appliedDiscountChf.toFixed(2));
    }
    if (isVoucherEmailOnly) {
      params.append('metadata[delivery_note]', 'Gutschein per E-Mail (PDF zum Ausdrucken)');
    } else if (shippingType === 'letter') {
      params.append('metadata[delivery_note]', 'Gutschein Post Briefversand (Gutscheinkarte)');
    }

    const voucherWithMsg = validatedItems.find(i => i.personalMessage || (i.voucherConfig && i.voucherConfig.text));
    if (voucherWithMsg) {
      const msg = String(voucherWithMsg.personalMessage || voucherWithMsg.voucherConfig.text || '');
      params.append('metadata[gutschein_nachricht]', msg.substring(0, 500));
    }
    const customVoucher = validatedItems.find(i => i.voucherConfig);
    if (customVoucher) {
      const vc = customVoucher.voucherConfig;
      params.append('metadata[gutschein_wert]', String(vc.wert || '').substring(0, 10));
      params.append('metadata[gutschein_fuer]', String(vc.fuer || '').substring(0, 100));
      params.append('metadata[gutschein_von]', String(vc.von || '').substring(0, 100));
    }

    params.append('client_reference_id', order.id);
    params.append('metadata[order_id]', order.id);
    params.append('metadata[order_number]', order.order_number);
    params.append('expires_at', String(Math.floor(Date.now() / 1000) + 31 * 60));

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': `order-${order.id}`
      },
      body: params.toString()
    });
    const session = await response.json();

    if (session.error || !session.id) {
      console.error('Stripe API Fehler:', session.error && session.error.message);
      await db.update('orders', `id=eq.${order.id}&payment_status=eq.pending`, { payment_status: 'failed', status: 'cancelled', cancelled_at: new Date().toISOString() });
      await db.insert('order_status_history', [{ order_id: order.id, kind: 'payment_status', from_value: 'pending', to_value: 'failed', actor: 'checkout', detail: 'Stripe-Session konnte nicht erstellt werden' }], 'return=minimal');
      return res.status(400).json({ error: 'Die Bezahlung konnte nicht gestartet werden.' });
    }

    await db.update('orders', `id=eq.${order.id}`, { stripe_session_id: session.id, stripe_session_url: session.url });
    return res.status(200).json({ url: session.url, orderNumber: order.order_number });
  } catch (err) {
    console.error('Checkout Fehler:', err);
    return res.status(500).json({ error: 'Interner Serverfehler beim Erstellen der Kasse.' });
  }
};
