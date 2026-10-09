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

  // 1. Try local filesystem (bundled by Vercel)
  try {
    const dir = path.join(process.cwd(), 'content/products');
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

  // 2. Fetch directly from GitHub API
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

  // 3. Fetch known products from raw GitHub
  try {
    const rawRes = await fetch('https://raw.githubusercontent.com/Uniquebylea/uniquebylea/main/content/products/babynest-schafe.json');
    debug.rawStatus = rawRes.status;
    if (rawRes.ok) {
      const item = safeParseJson(await rawRes.text());
      if (item && item.name) {
        return res.status(200).json({ produkte: [item], source: 'raw-github' });
      }
    }
  } catch (rawErr) {
    debug.rawError = rawErr.message;
  }

  // 4. Fallback to static content/products.json
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