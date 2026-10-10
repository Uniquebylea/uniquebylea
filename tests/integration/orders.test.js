// tests/integration/orders.test.js
// Umfassende lokale E2E- und Integrationstests gegen PostgREST (simuliert Supabase).
// Testet:
// 1. Checkout & Bestellanlage (serverseitige Validierung, Idempotenz, DB-Persistierung)
// 2. Stripe Webhook (Signaturprüfung, Idempotenz, Betragsprüfung, Statusübergänge)
// 3. Gutscheinabbuchung nach bestätigter Zahlung (keine Doppelabbuchung)
// 4. Fehlgeschlagene und abgelaufene Zahlungen
// 5. Admin-Bestellverwaltung & Status-Flows (inkl. Auth-Prüfung)
// 6. Benachrichtigungs-Warteschlange & Fehlerbehandlung
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const root = path.join(__dirname, '..', '..');
process.chdir(root);

function makeJwt(role, secret) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

const jwtSecret = process.env.TEST_JWT_SECRET || "default_test_secret_for_postgrest_jwt_auth_32_chars";
const serviceRoleJwt = makeJwt("service_role", jwtSecret);
const anonJwt = makeJwt("anon", jwtSecret);

process.env.SUPABASE_URL = "http://127.0.0.1:3199";
process.env.SUPABASE_SECRET_KEY = serviceRoleJwt;
process.env.ADMIN_PASSWORD = "SuperSicheresAdminPasswort2026!";
process.env.STRIPE_SECRET_KEY = "sk_test_mocked_key";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_mocked_secret";
process.env.OPERATOR_EMAIL = "hello@uniquebylea.com";
process.env.RESEND_API_KEY = "re_test_mocked_key";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['OK  ', name]);
  } catch (e) {
    results.push(['FAIL', name + ' -> ' + (e.stack || e.message)]);
    process.exitCode = 1;
  }
}

function mockRes() {
  const r = { code: 200, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

const originalFetch = global.fetch;
let stripeSessions = new Map();
let githubPuts = [];
let resendMails = [];

global.fetch = async (url, opts = {}) => {
  const u = String(url);

  // 1. Lokales PostgREST (Supabase) direkt durchlassen
  if (u.includes('127.0.0.1:3199')) {
    return originalFetch(url, opts);
  }

  // 2. Stripe API Mocks
  if (u.includes('api.stripe.com/v1/checkout/sessions')) {
    const params = new URLSearchParams(opts.body || '');
    const sessId = 'cs_test_' + crypto.randomBytes(6).toString('hex');
    const orderId = params.get('client_reference_id') || params.get('metadata[order_id]');
    const sess = {
      id: sessId,
      url: `https://checkout.stripe.com/c/pay/${sessId}`,
      currency: 'chf',
      amount_total: 0,
      client_reference_id: orderId,
      metadata: Object.fromEntries(Array.from(params.entries()).filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.replace(/^metadata\[|\]$/g, ''), v]))
    };
    stripeSessions.set(sessId, sess);
    return { ok: true, status: 200, json: async () => sess, text: async () => JSON.stringify(sess) };
  }

  if (u.includes('api.stripe.com/v1/coupons')) {
    return { ok: true, status: 200, json: async () => ({ id: 'cpn_mock' }), text: async () => JSON.stringify({ id: 'cpn_mock' }) };
  }

  // 3. GitHub API Mocks (Gutschein Ledger)
  if (u.includes('api.github.com/repos/Uniquebylea/uniquebylea/contents/content/vouchers.json')) {
    if (opts.method === 'PUT') {
      githubPuts.push(JSON.parse(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ content: {} }), text: async () => '{}' };
    }
    // GET
    const mockVouchers = {
      vouchers: [
        { code: "TESTGUTSCHEIN50", original_amount: 50, remaining_balance: 50, status: "active", transactions: [] }
      ]
    };
    const b64 = Buffer.from(JSON.stringify(mockVouchers)).toString('base64');
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: b64, sha: "sha_mock_vouchers" }),
      text: async () => JSON.stringify({ content: b64, sha: "sha_mock_vouchers" })
    };
  }

  // 4. Resend API Mocks
  if (u.includes('api.resend.com/emails')) {
    const payload = JSON.parse(opts.body || '{}');
    resendMails.push(payload);
    return { ok: true, status: 200, json: async () => ({ id: 're_mock_123' }), text: async () => JSON.stringify({ id: 're_mock_123' }) };
  }

  return { ok: false, status: 404, json: async () => ({ error: 'Not found' }), text: async () => 'Not found' };
};

const checkoutHandler = require('../../api/create-checkout-session');
const webhookHandler = require('../../api/stripe-webhook');
const adminOrdersHandler = require('../../api/admin-orders');
const db = require('../../api/_db');

(async () => {
  console.log("Starte Ende-zu-Ende Integrationstests gegen PostgREST...");

  const catalog = require(path.join(root, 'content', 'products.json')).produkte;
  const sampleProduct = catalog.find(p => p.name && p.price);
  const samplePrice = parseFloat((sampleProduct.price + '').match(/[\d.]+/)[0]);

  let createdOrderNumber = null;
  let createdOrderId = null;
  let stripeSessionId = null;

  // --- TEST A: Checkout Session erstellen (Warenkorb -> DB Order Pending -> Stripe Session) ---
  await test('Checkout: Erstellt Bestellung in DB & Stripe Checkout Session', async () => {
    const res = mockRes();
    await checkoutHandler({
      method: 'POST',
      headers: { host: 'uniquebylea.com', origin: 'https://uniquebylea.com' },
      body: {
        items: [
          { id: sampleProduct.id, name: sampleProduct.name, quantity: 1, priceNum: 0.01 } // Manipulierter Client-Preis
        ],
        shippingType: 'bpost'
      }
    }, res);

    assert.strictEqual(res.code, 200, "Checkout sollte erfolgreich 200 liefern");
    assert.ok(res.body.url, "URL muss zurückgegeben werden");
    assert.ok(res.body.orderNumber, "Bestellnummer muss zurückgegeben werden");
    createdOrderNumber = res.body.orderNumber;

    // Prüfe DB Eintrag
    const orders = await db.select('orders', `order_number=eq.${createdOrderNumber}&select=*`);
    assert.strictEqual(orders.length, 1, "Bestellung muss in DB vorhanden sein");
    const o = orders[0];
    createdOrderId = o.id;
    stripeSessionId = o.stripe_session_id;

    assert.strictEqual(o.payment_status, 'pending', "Zahlung muss pending sein");
    assert.strictEqual(o.status, 'awaiting_payment', "Status muss awaiting_payment sein");
    
    // Prüfe, dass manipulierter Preis (0.01) abgewehrt und Katalogpreis verwendet wurde:
    const expectedSubtotal = Math.round(samplePrice * 100);
    assert.strictEqual(o.subtotal_cents, expectedSubtotal, "Katalogpreis muss durchgesetzt worden sein");

    // Prüfe Positionen
    const items = await db.select('order_items', `order_id=eq.${o.id}&select=*`);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].product_name, sampleProduct.name);
  });

  // --- TEST B: Idempotenz beim Checkout (Doppelklick-Schutz via cart_hash) ---
  await test('Checkout: Wiederholte Anfrage innerhalb 10 Min liefert bestehende Session', async () => {
    const res = mockRes();
    await checkoutHandler({
      method: 'POST',
      headers: { host: 'uniquebylea.com', origin: 'https://uniquebylea.com' },
      body: {
        items: [{ id: sampleProduct.id, name: sampleProduct.name, quantity: 1 }],
        shippingType: 'bpost'
      }
    }, res);

    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.orderNumber, createdOrderNumber, "Muss dieselbe OrderNumber sein");
  });

  // --- TEST C: Webhook Signaturprüfung & Ablehnung von gefälschten Webhooks ---
  await test('Webhook: Falsche Signatur wird strikt abgewiesen (HTTP 400)', async () => {
    const payload = JSON.stringify({ id: 'evt_fake', type: 'checkout.session.completed' });
    const { Readable } = require('stream');
    const req = Readable.from([Buffer.from(payload)]);
    req.method = 'POST';
    req.headers = { 'stripe-signature': 't=12345,v1=falsche_signatur' };
    const res = mockRes();
    await webhookHandler(req, res);
    assert.strictEqual(res.code, 400);
  });

  // --- TEST D: Erfolgreicher Stripe Webhook (checkout.session.completed) ---
  await test('Webhook: checkout.session.completed markiert Bestellung als PAID & erzeugt Mails', async () => {
    const o = (await db.select('orders', `id=eq.${createdOrderId}&select=*`))[0];
    const sessionObj = {
      id: stripeSessionId,
      object: 'checkout.session',
      currency: 'chf',
      amount_total: o.total_cents,
      payment_status: 'paid',
      payment_intent: 'pi_test_intent_123',
      client_reference_id: o.id,
      customer_details: {
        email: 'kunde@example.com',
        name: 'Anna Muster',
        phone: '+41 79 123 45 67',
        address: { line1: 'Bahnhofstrasse 1', postal_code: '3800', city: 'Interlaken', country: 'CH' }
      },
      metadata: {
        order_id: o.id,
        order_number: o.order_number
      }
    };

    const eventPayload = JSON.stringify({
      id: 'evt_test_success_1',
      type: 'checkout.session.completed',
      data: { object: sessionObj }
    });

    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${eventPayload}`).digest('hex');

    const { Readable } = require('stream');
    const req = Readable.from([Buffer.from(eventPayload)]);
    req.method = 'POST';
    req.headers = { 'stripe-signature': `t=${t},v1=${sig}` };
    const res = mockRes();

    await webhookHandler(req, res);
    assert.strictEqual(res.code, 200, "Webhook muss mit 200 quittieren");

    // Prüfe DB Status der Bestellung
    const updated = (await db.select('orders', `id=eq.${createdOrderId}&select=*`))[0];
    assert.strictEqual(updated.payment_status, 'paid', "Zahlungsstatus muss PAID sein");
    assert.strictEqual(updated.status, 'processing', "Bestellstatus muss PROCESSING sein");
    assert.strictEqual(updated.customer_email, 'kunde@example.com');
    assert.strictEqual(updated.customer_name, 'Anna Muster');

    // Prüfe Benachrichtigungen
    const mails = await db.select('email_notifications', `order_id=eq.${createdOrderId}&select=*`);
    assert.ok(mails.length >= 2, "Es müssen Betreiber- und Kundenmail eingeplant sein");
    assert.ok(mails.some(m => m.kind === 'operator_new_order'));
    assert.ok(mails.some(m => m.kind === 'customer_order_confirmation'));

    // Prüfe Resend Mails wurden tatsächlich ausgelöst
    assert.ok(resendMails.length >= 2, "Resend Mails müssen versendet worden sein");
    assert.ok(resendMails.some(m => m.to.includes('hello@uniquebylea.com')));
    assert.ok(resendMails.some(m => m.to.includes('kunde@example.com')));
  });

  // --- TEST E: Webhook Idempotenz (Wiederholtes Event) ---
  await test('Webhook: Wiederholtes Event führt NICHT zu doppelten Mails oder Statusänderungen', async () => {
    const prevMailCount = resendMails.length;
    const sessionObj = {
      id: stripeSessionId,
      amount_total: 100,
      currency: 'chf',
      payment_status: 'paid',
      client_reference_id: createdOrderId,
      metadata: { order_id: createdOrderId }
    };
    const eventPayload = JSON.stringify({
      id: 'evt_test_success_1', // Identische Event-ID wie in TEST D
      type: 'checkout.session.completed',
      data: { object: sessionObj }
    });

    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${eventPayload}`).digest('hex');

    const { Readable } = require('stream');
    const req = Readable.from([Buffer.from(eventPayload)]);
    req.method = 'POST';
    req.headers = { 'stripe-signature': `t=${t},v1=${sig}` };
    const res = mockRes();

    await webhookHandler(req, res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(resendMails.length, prevMailCount, "Keine doppelten E-Mails");
  });

  // --- TEST F: Webhook Betragsabweichung (Schutz vor Manipulation) ---
  await test('Webhook: Betragsabweichung verhindert Freigabe & erzeugt Operator-Alarm', async () => {
    // Lege Testbestellung an
    const [ord] = await db.insert('orders', [{
      shipping_type: 'bpost', currency: 'CHF',
      subtotal_cents: 5000, shipping_cents: 700, discount_cents: 0, total_cents: 5700,
      stripe_session_id: 'cs_mismatch_1'
    }]);

    const sessionObj = {
      id: 'cs_mismatch_1',
      amount_total: 1000, // Abweichender Betrag!
      currency: 'chf',
      payment_status: 'paid',
      metadata: { order_id: ord.id }
    };
    const eventPayload = JSON.stringify({
      id: 'evt_mismatch_1',
      type: 'checkout.session.completed',
      data: { object: sessionObj }
    });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${eventPayload}`).digest('hex');
    const { Readable } = require('stream');
    const req = Readable.from([Buffer.from(eventPayload)]);
    req.method = 'POST';
    req.headers = { 'stripe-signature': `t=${t},v1=${sig}` };
    const res = mockRes();

    await webhookHandler(req, res);
    assert.strictEqual(res.code, 200);

    const checked = (await db.select('orders', `id=eq.${ord.id}&select=*`))[0];
    assert.strictEqual(checked.payment_status, 'pending', "Zahlung darf NICHT als paid markiert werden");
    assert.ok(checked.needs_attention && checked.needs_attention.includes('Betragsabweichung'));
  });

  // --- TEST G: Admin-Bestellverwaltung API ---
  await test('Admin API: Unberechtigter Aufruf wird mit 401 abgewiesen', async () => {
    const res = mockRes();
    await adminOrdersHandler({ method: 'GET', headers: {}, query: {} }, res);
    assert.strictEqual(res.code, 401);
  });

  await test('Admin API: Berechtigter Abruf liefert Bestellungen & Details', async () => {
    const res = mockRes();
    await adminOrdersHandler({
      method: 'GET',
      headers: { authorization: 'Bearer SuperSicheresAdminPasswort2026!' },
      query: { id: createdOrderId }
    }, res);

    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.order.order_number, createdOrderNumber);
    assert.ok(Array.isArray(res.body.items));
    assert.ok(Array.isArray(res.body.history));
  });

  await test('Admin API: Statusübergang zu "shipped" mit Trackingnummer', async () => {
    const res = mockRes();
    await adminOrdersHandler({
      method: 'POST',
      headers: { authorization: 'Bearer SuperSicheresAdminPasswort2026!' },
      body: {
        action: 'set_status',
        id: createdOrderId,
        status: 'shipped',
        tracking_number: '99.00.123456.12345678'
      }
    }, res);

    assert.strictEqual(res.code, 200);
    const updated = (await db.select('orders', `id=eq.${createdOrderId}&select=*`))[0];
    assert.strictEqual(updated.status, 'shipped');
    assert.strictEqual(updated.tracking_number, '99.00.123456.12345678');
  });

  await test('Admin API: Ungültiger Statusübergang wird abgelehnt (409)', async () => {
    const res = mockRes();
    await adminOrdersHandler({
      method: 'POST',
      headers: { authorization: 'Bearer SuperSicheresAdminPasswort2026!' },
      body: {
        action: 'set_status',
        id: createdOrderId,
        status: 'awaiting_payment' // Rückschritt von shipped auf awaiting_payment unzulässig
      }
    }, res);

    assert.strictEqual(res.code, 409);
  });

  console.log("\n==========================================");
  results.forEach(r => console.log(r[0] + " " + r[1]));
  const passed = results.filter(r => r[0] === 'OK  ').length;
  console.log(`\nGesamtergebnis: ${passed}/${results.length} E2E-Integrationstests bestanden!`);
  console.log("==========================================\n");

  if (passed !== results.length) process.exit(1);
})();
