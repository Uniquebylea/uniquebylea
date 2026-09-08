const fs = require('fs');
const path = require('path');

function safeParseJson(text) {
  if (!text) return null;
  const clean = text.toString().replace(/^\uFEFF/, '').trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error("JSON parse error:", e.message);
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=5, stale-while-revalidate=30');

  // 1. Try local filesystem (bundled by Vercel)
  try {
    const dir = path.join(process.cwd(), 'content/products');
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      if (files.length > 0) {
        const produkte = files
          .map((file) => safeParseJson(fs.readFileSync(path.join(dir, file), 'utf8')))
          .filter(Boolean);

        if (produkte.length > 0) {
          return res.status(200).json({ produkte });
        }
      }
    }
  } catch (err) {
    console.error("Local FS read error:", err);
  }

  // 2. Fetch directly from GitHub API (always fresh)
  try {
    const ghRes = await fetch('https://api.github.com/repos/Uniquebylea/uniquebylea/contents/content/products', {
      headers: {
        'User-Agent': 'UniqueByLea-Shop',
        'Accept': 'application/vnd.github+json'
      }
    });

    if (ghRes.ok) {
      const files = await ghRes.json();
      if (Array.isArray(files)) {
        const jsonFiles = files.filter((f) => f.name.endsWith('.json') && f.download_url);
        const produkte = await Promise.all(
          jsonFiles.map(async (f) => {
            try {
              const fileRes = await fetch(f.download_url);
              const text = await fileRes.text();
              return safeParseJson(text);
            } catch (e) {
              return null;
            }
          })
        );
        const valid = produkte.filter(Boolean);
        if (valid.length > 0) {
          return res.status(200).json({ produkte: valid });
        }
      }
    }
  } catch (ghErr) {
    console.error("GitHub API fetch error:", ghErr);
  }

  // 3. Fallback to static content/products.json
  try {
    const fallbackRes = await fetch('https://raw.githubusercontent.com/Uniquebylea/uniquebylea/main/content/products.json');
    if (fallbackRes.ok) {
      const data = safeParseJson(await fallbackRes.text());
      if (data && data.produkte) return res.status(200).json(data);
    }
  } catch (e) {}

  return res.status(200).json({ produkte: [] });
};