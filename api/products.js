const fs = require('fs');
const path = require('path');

function safeParseJson(text) {
  if (!text) return null;
  const clean = text.toString().replace(/^\uFEFF/, '').trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  const debug = {};

  // 1. Try local content/products.json first (fastest and complete)
  try {
    const jsonPath = path.join(process.cwd(), 'content', 'products.json');
    if (fs.existsSync(jsonPath)) {
      const data = safeParseJson(fs.readFileSync(jsonPath, 'utf8'));
      if (data && Array.isArray(data.produkte) && data.produkte.length > 0) {
        return res.status(200).json({ produkte: data.produkte, source: 'local-products-json' });
      }
    }
  } catch (e) {
    debug.localJsonError = e.message;
  }

  // 2. Try local filesystem directory (bundled by Vercel)
  try {
    const dir = path.join(process.cwd(), 'content', 'products');
    debug.cwd = process.cwd();
    debug.dirExists = fs.existsSync(dir);
    if (debug.dirExists) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      debug.files = files;
      if (files.length > 0) {
        const produkte = files
          .map((file) => safeParseJson(fs.readFileSync(path.join(dir, file), 'utf8')))
          .filter(Boolean);

        if (produkte.length > 0) {
          return res.status(200).json({ produkte, source: 'fs' });
        }
      }
    }
  } catch (err) {
    debug.fsError = err.message;
  }

  // 3. Fallback to static content/products.json via GitHub raw
  try {
    const fallbackRes = await fetch('https://raw.githubusercontent.com/Uniquebylea/uniquebylea/main/content/products.json');
    debug.fallbackStatus = fallbackRes.status;
    if (fallbackRes.ok) {
      const data = safeParseJson(await fallbackRes.text());
      if (data && data.produkte) return res.status(200).json({ ...data, source: 'fallback-file' });
    }
  } catch (e) {
    debug.fallbackError = e.message;
  }

  return res.status(200).json({ produkte: [], debug });
};
