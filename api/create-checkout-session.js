// api/create-checkout-session.js
// Erstellt eine Stripe Checkout-Session mit serverseitiger Preisprüfung und nativer Gutschein-Verrechnung
const fs = require('fs');
const path = require('path');

function parsePrice(str) {
  if (typeof str === 'number') return str;
  if (!str) return 0;
  const match = str.toString().match(/(\d+(?:\.\d{1,2})?)/);
  return match ? parseFloat(match[1]) : 0;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

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
    const { items, shippingType, shippingCost, voucherCode } = req.body || {};

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Warenkorb ist leer.' });
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host || 'uniquebylea.vercel.app';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const baseUrl = `${proto}://${host}`;

    // 1. Serverseitige Preisvalidierung aus content/products.json
    let catalogProducts = [];
    try {
      const prodPath = path.join(process.cwd(), 'content', 'products.json');
      if (fs.existsSync(prodPath)) {
        const pRaw = JSON.parse(fs.readFileSync(prodPath, 'utf8'));
        catalogProducts = pRaw.produkte || [];
      }
    } catch (e) {
      console.warn("Konnte lokale products.json nicht lesen:", e.message);
    }

    // Validiere jeden Artikel
    let totalItemAmount = 0;
    const validatedItems = items.map(item => {
      let validatedPrice = Number(item.priceNum) || 0;
      
      // Falls im Katalog gefunden: Basispreis + Optionen abgleichen
      const foundInCat = catalogProducts.find(p => (item.id && p.id === item.id) || (item.sku && p.sku === item.sku) || (p.name || '').trim().toLowerCase() === (item.name || '').trim().toLowerCase());
      if (foundInCat) {
        const catBasePrice = parsePrice(foundInCat.price);
        const optAdd = Number(item.optionPriceAdd) || 0;
        const expectedPrice = catBasePrice + optAdd;
        // Schutz vor Preis-Manipulation
        if (expectedPrice > 0 && Math.abs(validatedPrice - expectedPrice) > 0.50) {
          console.warn(`Preis-Diskrepanz erkannt für ${item.name}: Client=${validatedPrice}, Katalog=${expectedPrice}. Korrigiere auf Katalogpreis.`);
          validatedPrice = expectedPrice;
        }
      }

      // Bei Gutscheinen: Betrag aus Config oder Name übernehmen
      if (item.cat === 'Gutscheine' || (item.name && item.name.toLowerCase().includes('gutschein'))) {
        const confAmount = Number(item.voucherConfig?.wert) || parsePrice(item.name);
        if (confAmount > 0) validatedPrice = confAmount;
      }

      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      totalItemAmount += validatedPrice * qty;

      return {
        ...item,
        validatedPrice,
        quantity: qty
      };
    });

    const isVoucherEmailOnly = (shippingType === 'email') && validatedItems.every(item => 
      item.cat === 'Gutscheine' || (item.name && item.name.toLowerCase().includes('gutschein'))
    );

    const costCents = Math.round((Number(shippingCost) || 0) * 100);
    const parsedShippingCost = Number(shippingCost) || 0;

    // 2. Gutschein-Logik & Rabattierung
    let stripeCouponId = null;
    let appliedDiscountChf = 0;

    if (voucherCode && typeof voucherCode === 'string' && voucherCode.trim()) {
      const codeUpper = voucherCode.trim().toUpperCase();
      let vouchersList = [];
      let voucherSha = null;
      const vPath = path.join(process.cwd(), 'content', 'vouchers.json');

      // Gutscheine laden (lokal oder GitHub)
      if (fs.existsSync(vPath)) {
        try {
          const vData = JSON.parse(fs.readFileSync(vPath, 'utf8'));
          vouchersList = vData.vouchers || [];
        } catch (e) {}
      }

      const ghToken = process.env.GITHUB_TOKEN;
      if (ghToken && vouchersList.length === 0) {
        try {
          const ghRes = await fetch(`https://api.github.com/repos/Uniquebylea/uniquebylea/contents/content/vouchers.json?ref=main`, {
            headers: { 'Authorization': `token ${ghToken}`, 'Accept': 'application/vnd.github+json' }
          });
          if (ghRes.ok) {
            const ghJson = await ghRes.json();
            voucherSha = ghJson.sha;
            vouchersList = JSON.parse(Buffer.from(ghJson.content, 'base64').toString('utf8')).vouchers || [];
          }
        } catch (e) {}
      }

      const vIdx = vouchersList.findIndex(v => (v.code || '').trim().toUpperCase() === codeUpper);
      if (vIdx !== -1) {
        const targetVoucher = vouchersList[vIdx];
        const remainingBal = Number(targetVoucher.remaining_balance) || 0;

        if (remainingBal > 0 && targetVoucher.status !== 'fully_redeemed') {
          appliedDiscountChf = Math.min(totalItemAmount, remainingBal);
          const discountCents = Math.round(appliedDiscountChf * 100);

          // FALL A: 100% durch Gutschein gedeckt (Warenkorb + Versand = 0 CHF)
          const grandTotal = totalItemAmount + (isVoucherEmailOnly ? 0 : parsedShippingCost);
          if (appliedDiscountChf >= grandTotal) {
            const newBal = Math.max(0, remainingBal - grandTotal);
            targetVoucher.remaining_balance = Math.round(newBal * 100) / 100;
            targetVoucher.status = targetVoucher.remaining_balance === 0 ? 'fully_redeemed' : 'partially_redeemed';
            if (!targetVoucher.transactions) targetVoucher.transactions = [];
            targetVoucher.transactions.push({
              date: new Date().toISOString().slice(0, 10),
              type: 'redeem',
              amount: grandTotal,
              note: 'Vollständiger Einkauf im Shop gedeckt (Gutschein)',
              new_balance: targetVoucher.remaining_balance
            });

            // Speichern
            try {
              fs.writeFileSync(vPath, JSON.stringify({ vouchers: vouchersList }, null, 2), 'utf8');
            } catch (e) {}

            return res.status(200).json({
              zeroAmount: true,
              url: `${baseUrl}/shop.html?checkout=success&voucher_used=${encodeURIComponent(codeUpper)}&total_paid=0.00`
            });
          }

          // FALL B: Teilabzug via Stripe Coupon
          if (discountCents > 0) {
            try {
              const cpBody = new URLSearchParams();
              cpBody.append('amount_off', discountCents.toString());
              cpBody.append('currency', 'chf');
              cpBody.append('duration', 'once');
              cpBody.append('name', `Gutschein: ${codeUpper}`);

              const cpRes = await fetch('https://api.stripe.com/v1/coupons', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${stripeKey}`,
                  'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: cpBody.toString()
              });
              const cpData = await cpRes.json();
              if (cpData.id) {
                stripeCouponId = cpData.id;

                // Restguthaben abbuchen
                const newBal = Math.max(0, remainingBal - appliedDiscountChf);
                targetVoucher.remaining_balance = Math.round(newBal * 100) / 100;
                targetVoucher.status = targetVoucher.remaining_balance === 0 ? 'fully_redeemed' : 'partially_redeemed';
                if (!targetVoucher.transactions) targetVoucher.transactions = [];
                targetVoucher.transactions.push({
                  date: new Date().toISOString().slice(0, 10),
                  type: 'redeem',
                  amount: appliedDiscountChf,
                  note: `Shop-Kauf Teilbetrag (${codeUpper})`,
                  new_balance: targetVoucher.remaining_balance
                });

                try {
                  fs.writeFileSync(vPath, JSON.stringify({ vouchers: vouchersList }, null, 2), 'utf8');
                } catch (e) {}
              }
            } catch (cpErr) {
              console.error("Konnte Stripe Coupon nicht anlegen:", cpErr);
            }
          }
        }
      }
    }

    // 3. Stripe Checkout Session Parameter
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('billing_address_collection', 'required');

    if (!isVoucherEmailOnly) {
      params.append('shipping_address_collection[allowed_countries][0]', 'CH');
      params.append('shipping_address_collection[allowed_countries][1]', 'LI');
    }

    params.append('success_url', `${baseUrl}/shop.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url', `${baseUrl}/shop.html?checkout=canceled`);

    if (stripeCouponId) {
      params.append('discounts[0][coupon]', stripeCouponId);
    }

    // Artikel hinzufügen
    validatedItems.forEach((item, index) => {
      const priceCents = Math.round(item.validatedPrice * 100);
      params.append(`line_items[${index}][price_data][currency]`, 'chf');
      params.append(`line_items[${index}][price_data][unit_amount]`, priceCents.toString());
      params.append(`line_items[${index}][price_data][product_data][name]`, item.name || 'Produkt');

      const descParts = [];
      if (item.color) descParts.push(`Farbe: ${item.color}`);
      if (item.size) descParts.push(`Grösse: ${item.size}`);
      if (item.customName) descParts.push(`Wunschname: ${item.customName}`);
      if (item.optionsSummary) descParts.push(item.optionsSummary);
      if (item.voucherConfig) {
        if (item.voucherConfig.fuer) descParts.push(`Für: ${item.voucherConfig.fuer}`);
        if (item.voucherConfig.von) descParts.push(`Von: ${item.voucherConfig.von}`);
        if (item.voucherConfig.theme) descParts.push(`Design: ${item.voucherConfig.theme}`);
      }

      if (descParts.length > 0) {
        params.append(`line_items[${index}][price_data][product_data][description]`, descParts.join(' | '));
      }

      params.append(`line_items[${index}][quantity]`, item.quantity.toString());
    });

    // Versandkosten als Shipping Option
    let shippingName = 'Schweizerische Post (B-Post Paket)';
    if (shippingType === 'email') {
      shippingName = 'Gutschein per E-Mail (PDF zum Ausdrucken, gratis)';
    } else if (shippingType === 'letter') {
      shippingName = 'Schweizerische Post (Briefversand Gutscheinkarte)';
    } else if (shippingType === 'apost') {
      shippingName = 'Schweizerische Post (A-Post Paket)';
    } else if (shippingType === 'pickup') {
      shippingName = 'Abholung im Atelier (Interlaken)';
    }

    if (!isVoucherEmailOnly) {
      params.append('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
      params.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', costCents.toString());
      params.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'chf');
      params.append('shipping_options[0][shipping_rate_data][display_name]', shippingName);
    }

    // Metadaten für Stripe Dashboard
    params.append('metadata[shipping_type]', shippingType || 'bpost');
    if (voucherCode && appliedDiscountChf > 0) {
      params.append('metadata[eingeloester_gutschein]', voucherCode.trim().toUpperCase());
      params.append('metadata[gutschein_rabatt_chf]', appliedDiscountChf.toFixed(2));
    }

    if (isVoucherEmailOnly) {
      params.append('metadata[delivery_note]', 'Gutschein per E-Mail (PDF zum Ausdrucken)');
    } else if (shippingType === 'letter') {
      params.append('metadata[delivery_note]', 'Gutschein Post Briefversand (Gutscheinkarte)');
    }

    const voucherWithMsg = validatedItems.find(i => i.personalMessage || (i.voucherConfig && i.voucherConfig.text) || (i.optionsSummary && i.optionsSummary.toLowerCase().includes('nachricht')));
    if (voucherWithMsg) {
      const msg = voucherWithMsg.personalMessage || (voucherWithMsg.voucherConfig && voucherWithMsg.voucherConfig.text) || voucherWithMsg.optionsSummary;
      params.append('metadata[gutschein_nachricht]', msg.substring(0, 500));
    }

    const customVoucher = validatedItems.find(i => i.isVoucher || i.voucherConfig);
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
        'Authorization': `Bearer ${stripeKey}`,
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
