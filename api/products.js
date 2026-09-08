const fs = require('fs');
const path = require('path');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=5, stale-while-revalidate=30');

  // 1. Try local filesystem (if bundled by Vercel)
  try {
    const dir = path.join(process.cwd(), 'content/products');
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      if (files.length > 0) {
        const produkte = files
          .map((file) => {
            try {
              return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
            } catch (e) {
              return null;
            }
          })
          .filter(Boolean);

        if (produkte.length > 0) {
          return res.status(200).json({ produkte });
        }
      }
    }
  } catch (err) {
    console.error("Local FS read error:", err);
  }

  // 2. Fetch directly from GitHub API (always fresh, no build wait required!)
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
              return await fileRes.json();
            } catch (e) {
              return null;
            }
          })
        );
        return res.status(200).json({ produkte: produkte.filter(Boolean) });
      }
    }
  } catch (ghErr) {
    console.error("GitHub API fetch error:", ghErr);
  }

  // 3. Fallback to static content/products.json
  try {
    const fallbackRes = await fetch('https://raw.githubusercontent.com/Uniquebylea/uniquebylea/main/content/products.json');
    if (fallbackRes.ok) {
      const data = await fallbackRes.json();
      return res.status(200).json(data);
    }
  } catch (e) {}

  return res.status(200).json({ produkte: [] });
};
