// api/create-checkout-session.js
// Erstellt eine Stripe Checkout-Session mit serverseitiger Preis- und Versandvalidierung

const fs = require('fs');
const path = require('path');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(500).json({
      error: 'STRIPE_SECRET_KEY ist noch nicht in Vercel hinterlegt.'
    });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const { items, shippingType, appliedVoucherCode } = body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Warenkorb ist leer.' });
    }

    // 1. Katalogprodukte für serverseitige Preisprüfung laden
    let knownProducts = [];
    try {
      const prodPath = path.join(process.cwd(), 'content/products.json');
      if (fs.existsSync(prodPath)) {
        const fileContent = fs.readFileSync(prodPath, 'utf8');
        const parsed = JSON.parse(fileContent);
        knownProducts = parsed.produkte || [];
      }
    } catch (e) {}

    if (knownProducts.length === 0) {
      try {
        const ghRes = await fetch('https://raw.githubusercontent.com/Uniquebylea/uniquebylea/main/content/products.json');
        if (ghRes.ok) {
          const parsed = await ghRes.json();
          knownProducts = parsed.produkte || [];
        }
      } catch (e) {}
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host || 'uniquebylea.vercel.app';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const baseUrl = ${proto}://System.Management.Automation.Internal.Host.InternalHost;

    const isVoucherEmailOnly = (shippingType === 'email') && items.every(item => 
      item.cat === 'Gutscheine' || (item.name && item.name.toLowerCase().includes('gutschein')) || item.isVoucher
    );

    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('billing_address_collection', 'required');

    if (!isVoucherEmailOnly) {
      params.append('shipping_address_collection[allowed_countries][0]', 'CH');
      params.append('shipping_address_collection[allowed_countries][1]', 'LI');
    }

    params.append('success_url', ${baseUrl}/shop.html?checkout=success&session_id={CHECKOUT_SESSION_ID});
    params.append('cancel_url', ${baseUrl}/shop.html?checkout=canceled);

    // 2. Artikel & Preise validieren
    let subtotal = 0;

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const isVoucherItem = item.cat === 'Gutscheine' || 
                            (item.name && item.name.toLowerCase().includes('gutschein')) || 
                            item.isVoucher;

      let verifiedPrice = Number(item.priceNum) || 0;

      if (isVoucherItem) {
        if (verifiedPrice < 10 || verifiedPrice > 1000) {
          return res.status(400).json({ error: 'Ungültiger Gutscheinbetrag (erlaubt: CHF 10.– bis CHF 1000.–).' });
        }
      } else if (knownProducts.length > 0) {
        const catalogItem = knownProducts.find(p => 
          (p.name || '').trim().toLowerCase() === (item.name || '').trim().toLowerCase()
        );

        if (catalogItem) {
          const basePrice = parseFloat(catalogItem.price.replace(/[^0-9.]/g, '')) || 0;
          let expectedPrice = basePrice;

          // Eventuelle Optionsaufpreise berechnen
          if (Array.isArray(catalogItem.options)) {
            catalogItem.options.forEach(opt => {
              if (Array.isArray(opt.values)) {
                opt.values.forEach(val => {
                  if (item.optionsSummary && item.optionsSummary.includes(val.title) && val.price_add) {
                    expectedPrice += Number(val.price_add) || 0;
                  }
                });
              }
            });
          }

          // Schutz vor Parameter Tampering
          if (Math.abs(expectedPrice - verifiedPrice) > 0.50) {
            console.warn([SECURITY] Preisabweichung für : Übergeben=, Erwartet=);
            return res.status(400).json({ 
              error: Preisüberprüfung für " fehlgeschlagen. Bitte aktualisiere deinen Warenkorb. 
 });
 }
 verifiedPrice = expectedPrice;
 }
 }

 const qty = Math.max(1, Math.min(20, parseInt(item.quantity) || 1));
 subtotal += verifiedPrice * qty;
 const priceCents = Math.round(verifiedPrice * 100);

 params.append(line_items[][price_data][currency], 'chf');
 params.append(line_items[][price_data][unit_amount], priceCents.toString());
 params.append(line_items[][price_data][product_data][name], (item.name || 'Produkt').substring(0, 100));

 const descParts = [];
 if (item.color) descParts.push(Farbe: );
 if (item.size) descParts.push(Grösse: );
 if (item.customName) descParts.push(Wunschname: );
 if (item.optionsSummary) descParts.push(item.optionsSummary.substring(0, 100));
 if (item.voucherConfig) {
 if (item.voucherConfig.fuer) descParts.push(Für: );
 if (item.voucherConfig.von) descParts.push(Von: );
 if (item.voucherConfig.theme) descParts.push(Design: );
 }

 if (descParts.length > 0) {
 params.append(line_items[][price_data][product_data][description], descParts.join(' | '));
 }

 params.append(line_items[][quantity], qty.toString());
 }

 // 3. Versandkosten serverseitig determinieren
 let validShippingCost = 0;
 let shippingName = 'Schweizerische Post (B-Post Paket)';

 if (isVoucherEmailOnly || shippingType === 'email') {
 validShippingCost = 0;
 shippingName = 'Gutschein per E-Mail (PDF zum Ausdrucken, gratis)';
 } else if (shippingType === 'pickup') {
 validShippingCost = 0;
 shippingName = 'Abholung im Atelier (Interlaken)';
 } else if (shippingType === 'letter') {
 validShippingCost = 2.00;
 shippingName = 'Schweizerische Post (Briefversand Gutscheinkarte)';
 } else if (subtotal >= 100 && (shippingType === 'bpost' || !shippingType)) {
 validShippingCost = 0; // Kostenloser Versand ab 100 CHF
 shippingName = 'Schweizerische Post (B-Post Paket, portofrei ab CHF 100.–)';
 } else if (shippingType === 'apost') {
 validShippingCost = 10.50;
 shippingName = 'Schweizerische Post (A-Post Paket)';
 } else {
 validShippingCost = 8.50;
 shippingName = 'Schweizerische Post (B-Post Paket)';
 }

 const costCents = Math.round(validShippingCost * 100);

 if (!isVoucherEmailOnly) {
 params.append('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
 params.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', costCents.toString());
 params.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'chf');
 params.append('shipping_options[0][shipping_rate_data][display_name]', shippingName);
 }

 // Metadaten für Lea im Stripe Dashboard
 params.append('metadata[shipping_type]', shippingType || 'bpost');
 if (isVoucherEmailOnly) {
 params.append('metadata[delivery_note]', 'Gutschein per E-Mail (PDF zum Ausdrucken)');
 } else if (shippingType === 'letter') {
 params.append('metadata[delivery_note]', 'Gutschein Post Briefversand (Gutscheinkarte)');
 }

 const voucherWithMsg = items.find(i => i.personalMessage || (i.voucherConfig && i.voucherConfig.text) || (i.optionsSummary && i.optionsSummary.toLowerCase().includes('nachricht')));
 if (voucherWithMsg) {
 const msg = voucherWithMsg.personalMessage || (voucherWithMsg.voucherConfig && voucherWithMsg.voucherConfig.text) || voucherWithMsg.optionsSummary;
 params.append('metadata[gutschein_nachricht]', msg.substring(0, 500));
 }

 const customVoucher = items.find(i => i.isVoucher || i.voucherConfig);
 if (customVoucher && customVoucher.voucherConfig) {
 const vc = customVoucher.voucherConfig;
 params.append('metadata[gutschein_wert]', (vc.wert || '').toString());
 params.append('metadata[gutschein_fuer]', (vc.fuer || '').substring(0, 100));
 params.append('metadata[gutschein_von]', (vc.von || '').substring(0, 100));
 }

 // Call Stripe API
 const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
 method: 'POST',
 headers: {
 'Authorization': Bearer ,
 'Content-Type': 'application/x-www-form-urlencoded'
 },
 body: params.toString()
 });

 const session = await response.json();

 if (session.error) {
 console.error('Stripe API Fehler:', session.error);
 return res.status(400).json({ error: session.error.message });
 }

 return res.status(200).json({ url: session.url });
 } catch (err) {
 console.error('Checkout Fehler:', err);
 return res.status(500).json({ error: err.message || 'Interner Serverfehler beim Erstellen der Kasse.' });
 }
};
