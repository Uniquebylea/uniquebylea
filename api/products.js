const fs = require('fs');
const path = require('path');

module.exports = (req, res) => {
  try {
    const dir = path.join(process.cwd(), 'content/products');
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      const produkte = files
        .map((file) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean);

      res.setHeader('Cache-Control', 'public, max-age=5, stale-while-revalidate=30');
      return res.status(200).json({ produkte });
    }
  } catch (err) {
    console.error(err);
  }

  // Fallback
  try {
    const fallbackFile = path.join(process.cwd(), 'content/products.json');
    if (fs.existsSync(fallbackFile)) {
      const data = JSON.parse(fs.readFileSync(fallbackFile, 'utf8'));
      return res.status(200).json(data);
    }
  } catch (err) {}

  return res.status(200).json({ produkte: [] });
};
