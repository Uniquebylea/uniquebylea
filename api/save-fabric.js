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

  const authHeader = req.headers['authorization'] || '';
  const clientToken = authHeader.replace(/^bearer\s+/i, '').replace(/^token\s+/i, '').trim();
  const token = process.env.GITHUB_TOKEN || clientToken;

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const incomingFabrics = Array.isArray(body.fabrics) ? body.fabrics : (body.fabric ? [body.fabric] : []);
    if (!incomingFabrics || incomingFabrics.length === 0) {
      return res.status(400).json({ error: 'Keine Stoffdaten empfangen.' });
    }

    const ghHeaders = token ? {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'UniqueByLea-Fabric-Admin',
      'Content-Type': 'application/json'
    } : null;

    const savedList = [];

    for (let i = 0; i < incomingFabrics.length; i++) {
      const f = incomingFabrics[i];
      let imagePath = f.image || '';

      // Falls Bild übergeben wurde und ein GitHub Token vorliegt: Bild hochladen
      if (f.imageBase64 && ghHeaders) {
        try {
          const rawBase64 = f.imageBase64.replace(/^data:image\/\w+;base64,/, '');
          const cleanCode = (f.code || 'stoff').toLowerCase().replace(/[^a-z0-9]/g, '-');
          const cleanName = (f.fileName || `${cleanCode}.jpg`).toLowerCase().replace(/[^a-z0-9.]/g, '-');
          imagePath = `images/fabrics/${cleanCode}-${Date.now()}-${cleanName}`;

          await fetch(`https://api.github.com/repos/Uniquebylea/uniquebylea/contents/${imagePath}`, {
            method: 'PUT',
            headers: ghHeaders,
            body: JSON.stringify({
              message: `Upload fabric swatch image for ${f.name || f.code}`,
              content: rawBase64,
              branch: 'main'
            })
          });
        } catch (imgErr) {
          console.warn('Image upload error (continuing with color swatch):', imgErr);
        }
      }

      // Map textureClass
      let textureClass = f.textureClass || 'texture-musselin';
      if (f.cat === 'waffel') textureClass = 'texture-waffle';
      else if (f.cat === 'jersey') textureClass = 'texture-jersey';
      else if (f.cat === 'makramee') textureClass = 'texture-cord';

      savedList.push({
        code: f.code || `S-${Date.now().toString().slice(-4)}`,
        name: f.name || 'Neuer Atelier-Stoff',
        cat: f.cat || 'musselin',
        color: f.color || '#97A594',
        textColor: f.textColor || '#FFFFFF',
        textureClass: textureClass,
        material: f.material || f.cert || '100 % Bio-Baumwolle (GOTS)',
        badge: f.badge || 'Neu im Atelier',
        desc: f.desc || f.description || '',
        image: imagePath || f.imageBase64 || ''
      });
    }

    // Falls GitHub-Token verfügbar, auch zentral in content/fabrics.json einpflegen
    if (ghHeaders) {
      try {
        let existingFabrics = [];
        let fileSha = null;

        const getRes = await fetch('https://api.github.com/repos/Uniquebylea/uniquebylea/contents/content/fabrics.json', {
          headers: ghHeaders
        });

        if (getRes.ok) {
          const fileData = await getRes.json();
          fileSha = fileData.sha;
          const contentStr = Buffer.from(fileData.content, 'base64').toString('utf8');
          existingFabrics = JSON.parse(contentStr);
        }

        // Neue Stoffe oben anfügen (Duplikate anhand des Codes vermeiden)
        const updatedList = [...savedList];
        const newCodes = new Set(savedList.map(s => s.code));
        for (const ef of existingFabrics) {
          if (!newCodes.has(ef.code)) {
            updatedList.push(ef);
          }
        }

        // Bildpfade für die JSON-Datei säubern (kein riesiges Base64 in der JSON speichern, falls Bildpfad existiert)
        const cleanForJson = updatedList.map(item => {
          const copy = { ...item };
          if (copy.image && copy.image.startsWith('data:image')) {
            // Wenn der Upload zu GitHub geklappt hat, ist copy.image bereits images/fabrics/...
            // Ansonsten für die JSON löschen, um 100MB-Commits zu vermeiden
            delete copy.image;
          }
          return copy;
        });

        const newJsonBase64 = Buffer.from(JSON.stringify(cleanForJson, null, 2), 'utf8').toString('base64');
        const putBody = {
          message: `Add ${savedList.length} new atelier fabric(s)`,
          content: newJsonBase64,
          branch: 'main'
        };
        if (fileSha) putBody.sha = fileSha;

        await fetch('https://api.github.com/repos/Uniquebylea/uniquebylea/contents/content/fabrics.json', {
          method: 'PUT',
          headers: ghHeaders,
          body: JSON.stringify(putBody)
        });
      } catch (jsonErr) {
        console.warn('Could not update content/fabrics.json on GitHub:', jsonErr);
      }
    }

    return res.status(200).json({
      success: true,
      count: savedList.length,
      fabrics: savedList
    });

  } catch (err) {
    console.error('Error in save-fabric:', err);
    return res.status(500).json({ error: err.message || 'Serverfehler beim Speichern der Stoffe' });
  }
};
