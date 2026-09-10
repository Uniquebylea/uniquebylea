// api/create-checkout-session.js
// Erstellt eine Stripe Checkout-Session mit Gutschein- und Paketversand

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
    const { items, shippingType, shippingCost } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Warenkorb ist leer.' });
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host || 'uniquebylea.vercel.app';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const baseUrl = `${proto}://${host}`;

    const isVoucherEmailOnly = (shippingType === 'email') && items.every(item => 
      item.cat === 'Gutscheine' || (item.name && item.name.toLowerCase().includes('gutschein'))
    );

    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('billing_address_collection', 'required');

    if (!isVoucherEmailOnly) {
      params.append('shipping_address_collection[allowed_countries][0]', 'CH');
      params.append('shipping_address_collection[allowed_countries][1]', 'LI');
    }

    params.append('success_url', `${baseUrl}/shop.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url', `${baseUrl}/shop.html?checkout=canceled`);

    // Artikel hinzufügen
    items.forEach((item, index) => {
      const priceCents = Math.round((Number(item.priceNum) || 0) * 100);
      params.append(`line_items[${index}][price_data][currency]`, 'chf');
      params.append(`line_items[${index}][price_data][unit_amount]`, priceCents.toString());
      params.append(`line_items[${index}][price_data][product_data][name]`, item.name || 'Produkt');

      const descParts = [];
      if (item.color) descParts.push(`Farbe: ${item.color}`);
      if (item.size) descParts.push(`Grösse: ${item.size}`);
      if (item.customName) descParts.push(`Wunschname: ${item.customName}`);

      if (descParts.length > 0) {
        params.append(`line_items[${index}][price_data][product_data][description]`, descParts.join(' | '));
      }

      params.append(`line_items[${index}][quantity]`, (Number(item.quantity) || 1).toString());
    });

    // Versandkosten als Shipping Option (Stripe erlaubt shipping_options nur, wenn shipping_address_collection aktiv ist)
    const costCents = Math.round((Number(shippingCost) || 0) * 100);
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

    // Metadaten für Lea im Stripe Dashboard
    params.append('metadata[shipping_type]', shippingType || 'bpost');
    if (isVoucherEmailOnly) {
      params.append('metadata[delivery_note]', 'Gutschein per E-Mail (PDF zum Ausdrucken)');
    } else if (shippingType === 'letter') {
      params.append('metadata[delivery_note]', 'Gutschein Post Briefversand (Gutscheinkarte)');
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
