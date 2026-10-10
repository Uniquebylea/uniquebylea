// tests/security.test.js – lokale Tests ohne Netzwerk (fetch wird gemockt). Ausführen: node tests/security.test.js
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const root = path.join(__dirname, '..');
process.chdir(root);

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['OK  ', name]); } catch (e) { results.push(['FAIL', name + ' -> ' + e.message]); process.exitCode = 1; }
}
function mockRes() {
  const r = { code: 200, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

const catalog = require(path.join(root, 'content', 'products.json')).produkte;
const unique = catalog.find(p => p.is_unique && !/gutschein/i.test(p.name));
const cheap = Number((unique.price + '').match(/[\d.]+/)[0]);

let stripeCalls;
global.fetch = async (url, opts) => {
  stripeCalls.push({ url, body: opts && opts.body });
  if (url.includes('/coupons')) return { json: async () => ({ id: 'cpn_test' }) };
  if (url.includes('/checkout/sessions')) return { json: async () => ({ id: 'cs_test_mock', url: 'https://stripe.test/session' }) };
  return { ok: false, json: async () => ({}) };
};

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.SUPABASE_URL = 'https://mock.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'mock_secret';
delete process.env.GITHUB_TOKEN;

const db = require('../api/_db');
db.configured = () => true;
db.select = async (table, q) => [];
db.insert = async (table, rows) => rows.map((r, i) => ({ id: '00000000-0000-0000-0000-00000000000' + i, order_number: 'UBL-2026-00001', ...r }));
db.update = async (table, q, p) => [p];

const checkout = require('../api/create-checkout-session.js');

async function call(body) {
  stripeCalls = [];
  const res = mockRes();
  await checkout({ method: 'POST', headers: { host: 'uniquebylea.com', origin: 'https://uniquebylea.com' }, body }, res);
  return { res, params: new URLSearchParams((stripeCalls.find(c => c.url.includes('/checkout/sessions')) || {}).body || '') };
}

(async () => {
  await test('Unbekanntes Produkt mit Client-Preis wird abgewiesen', async () => {
    const { res } = await call({ items: [{ name: 'Erfundenes Produkt', priceNum: 0.5, quantity: 1 }], shippingType: 'bpost' });
    assert.strictEqual(res.code, 400);
  });
  await test('Client-Preis wird durch Katalogpreis ersetzt', async () => {
    const { res, params } = await call({ items: [{ id: unique.id, name: unique.name, priceNum: 1, quantity: 1 }], shippingType: 'pickup' });
    assert.strictEqual(res.code, 200);
    assert.strictEqual(params.get('line_items[0][price_data][unit_amount]'), String(Math.round(cheap * 100)));
  });
  await test('Fremde Versandkosten (0) werden ignoriert', async () => {
    const { params } = await call({ items: [{ id: unique.id, name: unique.name, quantity: 1 }], shippingType: 'apost', shippingCost: 0 });
    const expected = cheap >= 100 ? 0 : 900;
    assert.strictEqual(params.get('shipping_options[0][shipping_rate_data][fixed_amount][amount]'), String(expected));
  });
  await test('Unikat-Menge wird auf 1 begrenzt', async () => {
    const { params } = await call({ items: [{ id: unique.id, name: unique.name, quantity: 5 }], shippingType: 'pickup' });
    assert.strictEqual(params.get('line_items[0][quantity]'), '1');
  });
  await test('E-Mail-Versand für Nicht-Gutschein abgewiesen', async () => {
    const { res } = await call({ items: [{ id: unique.id, name: unique.name, quantity: 1 }], shippingType: 'email' });
    assert.strictEqual(res.code, 400);
  });
  await test('Gutscheinwert ausserhalb Grenzen abgewiesen', async () => {
    const { res } = await call({ items: [{ name: 'Individueller Gutschein', cat: 'Gutscheine', quantity: 1, voucherConfig: { wert: 1 } }], shippingType: 'email' });
    assert.strictEqual(res.code, 400);
  });
  await test('Gutschein wird im Checkout nicht abgebucht (kein GitHub-PUT)', async () => {
    const { res } = await call({ items: [{ id: unique.id, name: unique.name, quantity: 1 }], shippingType: 'pickup', voucherCode: 'NICHT-VORHANDEN' });
    assert.strictEqual(res.code, 400);
    assert.ok(!stripeCalls.some(c => c.url.includes('github') && c.body));
  });

  // Admin-Auth
  const { isAdmin } = require('../api/_auth.js');
  await test('Admin ohne ADMIN_PASSWORD: immer abgewiesen (auch alte Standard-PINs)', async () => {
    delete process.env.ADMIN_PASSWORD;
    for (const pin of ['lea2026', 'uniquebylea', 'interlaken', 'LeaAtelier2026!', '']) {
      assert.strictEqual(isAdmin({ headers: { authorization: 'Bearer ' + pin } }), false);
    }
  });
  await test('Admin mit ADMIN_PASSWORD: nur korrektes Passwort', async () => {
    process.env.ADMIN_PASSWORD = 'test-pass-123';
    assert.strictEqual(isAdmin({ headers: { authorization: 'Bearer test-pass-123' } }), true);
    assert.strictEqual(isAdmin({ headers: { authorization: 'Bearer lea2026' } }), false);
    assert.strictEqual(isAdmin({ headers: { authorization: 'Bearer ghp_abc' } }), false);
  });
  await test('Gutschein redeem ohne Admin -> 401', async () => {
    const vouchers = require('../api/vouchers.js');
    const res = mockRes();
    await vouchers({ method: 'POST', headers: {}, query: {}, body: { action: 'redeem', code: 'X', amount: 5 } }, res);
    assert.strictEqual(res.code, 401);
  });
  for (const f of ['save-fabric', 'fabric-analyze', 'ai-analyze', 'save-product']) {
    await test(`${f} ohne Admin -> 401`, async () => {
      const res = mockRes();
      await require(`../api/${f}.js`)({ method: 'POST', headers: {}, body: {} }, res);
      assert.strictEqual(res.code, 401);
    });
  }

  // Webhook-Signatur
  await test('Webhook: ungültige Signatur -> 400, gültige Signatur wird akzeptiert', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const hook = require('../api/stripe-webhook.js');
    const payload = JSON.stringify({ id: 'evt_ping_1', type: 'ping', data: { object: {} } });
    const mk = (sig, t) => {
      const { Readable } = require('stream');
      const r = Readable.from([Buffer.from(payload)]);
      r.method = 'POST';
      r.headers = { 'stripe-signature': `t=${t},v1=${sig}` };
      return r;
    };
    const t = Math.floor(Date.now() / 1000);
    const good = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex');
    const bad = mockRes(); await hook(mk('deadbeef', t), bad);
    assert.strictEqual(bad.code, 400);
    const old = mockRes(); await hook(mk(good, t - 1000), old);
    assert.strictEqual(old.code, 400);
    const ok = mockRes(); await hook(mk(good, t), ok);
    assert.strictEqual(ok.code, 200);
  });

  results.forEach(r => console.log(r.join(' ')));
  console.log(`\n${results.filter(r => r[0] === 'OK  ').length}/${results.length} bestanden`);
})();
