module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Nur POST erlaubt' });
  }

  const authHeader = req.headers['authorization'] || req.headers['x-admin-token'] || '';
  const clientToken = authHeader.replace(/^bearer\s+/i, '').replace(/^token\s+/i, '').trim();

  const validPins = ['lea2026', 'uniquebylea', 'interlaken', 'uniquebylea2026'];
  const adminSecret = process.env.ADMIN_SECRET;

  let isAuthorized = false;
  if (adminSecret && clientToken === adminSecret) {
    isAuthorized = true;
  } else if (validPins.includes(clientToken.toLowerCase())) {
    isAuthorized = true;
  } else if (clientToken) {
    try {
      const ghUserRes = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `token ${clientToken}`,
          'User-Agent': 'UniqueByLea-Auth-Check'
        }
      });
      if (ghUserRes.ok) {
        const ghUser = await ghUserRes.json();
        if (ghUser.login && ghUser.login.toLowerCase() === 'uniquebylea') {
          isAuthorized = true;
        }
      }
    } catch (e) {}
  }

  if (!isAuthorized) {
    return res.status(401).json({ error: 'Zugriff verweigert. Bitte melde dich im Admin-Bereich an.' });
  }

  const token = process.env.GITHUB_TOKEN || clientToken;

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        body = {};
      }
    }
    body = body || {};

    const {
      name,
      cat,
      price,
      description,
      badge,
      size,
      isUnique,
      stock,
      hasColorVariants,
      colorsList,
      variants: rawVariants,
      images: rawImages,
      imageBase64,
      fileName
    } = body;

    // Normalisiere Varianten-Liste (entweder aus variants, images oder Einzelbild)
    let variantList = [];
    if (Array.isArray(rawVariants) && rawVariants.length > 0) {
      variantList = rawVariants;
    } else if (Array.isArray(rawImages) && rawImages.length > 0) {
      variantList = rawImages;
    } else if (imageBase64) {
      variantList = [{
        imageBase64,
        fileName: fileName || 'produkt.jpg',
        size: size || '',
        stock: stock || 1,
        price_add: 0
      }];
    }

    if (!name || variantList.length === 0 || !variantList[0].imageBase64) {
      return res.status(400).json({ error: 'Name und mindestens ein Bild sind erforderlich.' });
    }

    // Clean slug
    const slug = name.toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const headers = {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'UniqueByLea-AI-Admin',
      'Content-Type': 'application/json'
    };

    // 1. Alle Bilder zu GitHub hochladen
    const galleryPaths = [];
    for (let idx = 0; idx < variantList.length; idx++) {
      const v = variantList[idx];
      if (!v.imageBase64) continue;

      const rawBase64 = v.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const rawExtMatch = (v.fileName || '').match(/\.[a-z0-9]+$/i);
      const ext = rawExtMatch ? rawExtMatch[0].toLowerCase() : '.jpg';
      const baseClean = (v.fileName || `foto-${idx + 1}`).replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[^a-z0-9.]/g, '-');
      const cleanFileName = `${baseClean}${ext}`;

      const imagePath = `images/${slug}-${idx > 0 ? (idx + 1) + '-' : ''}${cleanFileName}`;

      let imageSha = null;
      try {
        const checkRes = await fetch(`https://api.github.com/repos/Uniquebylea/uniquebylea/contents/${imagePath}`, { headers });
        if (checkRes.ok) {
          const d = await checkRes.json();
          imageSha = d.sha;
        }
      } catch (e) {}

      const imgBody = {
        message: `Upload image ${idx + 1} for ${name}`,
        content: rawBase64,
        branch: 'main'
      };
      if (imageSha) imgBody.sha = imageSha;

      const imgUploadRes = await fetch(`https://api.github.com/repos/Uniquebylea/uniquebylea/contents/${imagePath}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(imgBody)
      });

      if (!imgUploadRes.ok) {
        const errData = await imgUploadRes.json().catch(() => ({}));
        throw new Error(`Bild-Upload #${idx + 1} fehlgeschlagen: ${errData.message || imgUploadRes.status}`);
      }

      v.imagePath = imagePath;
      galleryPaths.push(imagePath);
    }

    const coverImage = galleryPaths[0] || '';
    const isMultiVariant = variantList.length > 1;

    // 2. Produkt-Optionen aufbauen
    let options = [];
    let productStock = 1;
    let variantsColor = [];
    let variantsSize = [];
    let cleanSize = (size || '').trim();

    if (isMultiVariant) {
      // Mehrere Ausführungen / Varianten mit je eigenem Foto, Grösse und Bestand
      productStock = variantList.reduce((acc, v) => acc + (Number(v.stock) || 1), 0);
      cleanSize = ''; // Grösse ist auf Variantenebene definiert

      options = [
        {
          name: "Ausf\u00fchrung / Variante",
          type: "color",
          required: true,
          values: variantList.map((v, i) => {
            let title = v.variantTitle || v.title || '';
            if (!title) {
              const parts = [];
              if (v.color) parts.push(v.color);
              if (v.size) parts.push(`Gr. ${v.size}`);
              title = parts.join(' \u00B7 ') || `Variante ${i + 1}`;
            }
            return {
              title: title,
              img: v.imagePath || coverImage,
              stock: typeof v.stock !== 'undefined' ? Number(v.stock) : 1,
              price_add: Number(v.price_add || v.priceAdd) || 0
            };
          })
        }
      ];

      variantsColor = variantList.map(v => ({
        name: v.color || v.title || 'Unikat',
        img: v.imagePath || coverImage,
        stock: typeof v.stock !== 'undefined' ? Number(v.stock) : 1
      }));

      variantsSize = variantList.filter(v => v.size).map(v => ({
        name: v.size,
        stock: typeof v.stock !== 'undefined' ? Number(v.stock) : 1,
        price_add: Number(v.price_add || v.priceAdd) || 0
      }));

    } else {
      // Einzelstück (1 Bild)
      const single = variantList[0];
      cleanSize = (single.size || size || '').trim();
      productStock = typeof single.stock !== 'undefined' ? Number(single.stock) : (Number(stock) || 1);

      if (hasColorVariants && Array.isArray(colorsList) && colorsList.length > 0) {
        options.push({
          name: "Farbe",
          type: "color",
          required: true,
          values: colorsList.map(c => ({
            title: c.name || c.title || 'Farbe',
            price_add: 0,
            stock: typeof c.stock !== 'undefined' ? Number(c.stock) : 1
          }))
        });
      }

      variantsColor = Array.isArray(colorsList) ? colorsList : (single.color ? [{ name: single.color, stock: productStock }] : []);
      variantsSize = cleanSize ? [{ name: cleanSize, stock: productStock, price_add: 0 }] : [];
    }

    const productData = {
      name: name,
      cat: cat || 'Unikate',
      price: (price || '49.00').includes('CHF') ? price : `${price} CHF`,
      badge: badge || (isMultiVariant ? 'Unikate' : 'Unikat'),
      size: cleanSize,
      stock: productStock,
      is_unique: !isMultiVariant && (isUnique !== false),
      description: description || '',
      img: coverImage,
      gallery: galleryPaths,
      options: options,
      variants_color: variantsColor,
      variants_size: variantsSize,
      allow_custom_name: false
    };

    const productJsonBase64 = Buffer.from(JSON.stringify(productData, null, 2), 'utf8').toString('base64');
    const jsonPath = `content/products/${slug}.json`;

    let jsonSha = null;
    try {
      const checkRes = await fetch(`https://api.github.com/repos/Uniquebylea/uniquebylea/contents/${jsonPath}`, { headers });
      if (checkRes.ok) {
        const d = await checkRes.json();
        jsonSha = d.sha;
      }
    } catch (e) {}

    const jsonBody = {
      message: `Create product ${name}`,
      content: productJsonBase64,
      branch: 'main'
    };
    if (jsonSha) jsonBody.sha = jsonSha;

    const jsonUploadRes = await fetch(`https://api.github.com/repos/Uniquebylea/uniquebylea/contents/${jsonPath}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(jsonBody)
    });

    if (!jsonUploadRes.ok) {
      const errData = await jsonUploadRes.json().catch(() => ({}));
      throw new Error(`Produkt-JSON Erstellung fehlgeschlagen: ${errData.message || jsonUploadRes.status}`);
    }

    return res.status(200).json({ success: true, slug, name, imagePath });

  } catch (err) {
    console.error('Error in save-product:', err);
    return res.status(500).json({ error: err.message || 'Interner Serverfehler beim Speichern des Produkts' });
  }
};
