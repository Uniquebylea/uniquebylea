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

  // 1. PRIMARY: Read directly from content/products/*.json directory
  // This ensures any additions, edits, or DELETIONS in Sveltia CMS are immediately reflected!
  try {
    const dir = path.join(process.cwd(), 'content', 'products');
    debug.cwd = process.cwd();
    debug.dirExists = fs.existsSync(dir);
    if (debug.dirExists) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      debug.filesCount = files.length;
      if (files.length > 0) {
        const produkte = files
          .map((file) => safeParseJson(fs.readFileSync(path.join(dir, file), 'utf8')))
          .filter(Boolean);

        if (produkte.length > 0) {
          return res.status(200).json({ produkte, source: 'content-products-dir' });
        }
      }
    }
  } catch (err) {
    debug.dirError = err.message;
  }

  // 2. SECONDARY: Try local content/products.json
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

  // 3. FALLBACK: Fetch directly from GitHub API
  try {
    const headers = { 'User-Agent': 'UniqueByLea-Shop' };
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    }
    const ghRes = await fetch('https://api.github.com/repos/Uniquebylea/uniquebylea/contents/content/products', { headers });
    debug.ghStatus = ghRes.status;
    if (ghRes.ok) {
      const files = await ghRes.json();
      if (Array.isArray(files)) {
        const jsonFiles = files.filter((f) => f.name.endsWith('.json') && f.download_url);
        const produkte = await Promise.all(
          jsonFiles.map(async (f) => {
            try {
              const fileRes = await fetch(f.download_url);
              return safeParseJson(await fileRes.text());
            } catch (e) {
              return null;
            }
          })
        );
        const valid = produkte.filter(Boolean);
        if (valid.length > 0) {
          return res.status(200).json({ produkte: valid, source: 'github-api' });
        }
      }
    }
  } catch (ghErr) {
    debug.ghError = ghErr.message;
  }

  return res.status(200).json({ produkte: [], debug });
};
