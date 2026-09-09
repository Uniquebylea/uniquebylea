module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Nur POST erlaubt' });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'GITHUB_TOKEN ist in Vercel nicht konfiguriert.' });
  }

  try {
    const { name, cat, price, description, badge, colorsList, imageBase64, fileName } = req.body;
    if (!name || !imageBase64) {
      return res.status(400).json({ error: 'Name und Bild sind erforderlich.' });
    }

    // Clean slug
    const slug = name.toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const cleanFileName = (fileName || 'produkt.jpg').toLowerCase().replace(/[^a-z0-9.]/g, '-');
    const imagePath = `images/${slug}-${cleanFileName}`;
    const rawBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    const headers = {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'UniqueByLea-AI-Admin',
      'Content-Type': 'application/json'
    };

    // 1. Upload Image to GitHub
    let imageSha = null;
    try {
      const checkRes = await fetch(`https://api.github.com/repos/Uniquebylea/uniquebylea/contents/${imagePath}`, { headers });
      if (checkRes.ok) {
        const d = await checkRes.json();
        imageSha = d.sha;
      }
    } catch (e) {}

    const imgBody = {
      message: `Upload image for ${name}`,
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
      throw new Error(`Bild-Upload zu GitHub fehlgeschlagen: ${errData.message || imgUploadRes.status}`);
    }

    // 2. Upload Product JSON to GitHub
    const productData = {
      name: name,
      cat: cat || 'Unikate',
      price: price.includes('CHF') ? price : `${price} CHF`,
      badge: badge || 'Unikat',
      stock: 1,
      description: description || '',
      img: imagePath,
      variants_color: Array.isArray(colorsList) ? colorsList : [],
      variants_size: [],
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
