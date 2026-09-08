const crypto = require('crypto');

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

function getEmailHash(email) {
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').substring(0, 16);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { action, email, password, wishlist, token } = req.body || {};
    const normalizedEmail = (email || '').trim().toLowerCase();

    if (!action) {
      return res.status(400).json({ error: 'Aktion fehlt.' });
    }

    const githubToken = process.env.GITHUB_TOKEN;
    const repoOwner = 'Uniquebylea';
    const repoName = 'uniquebylea';

    async function getStoredUser(emailHash) {
      if (!githubToken) return null;
      try {
        const ghRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/content/customers/${emailHash}.json`, {
          headers: {
            'Authorization': `token ${githubToken}`,
            'User-Agent': 'UniqueByLea-Auth',
            'Accept': 'application/vnd.github+json'
          }
        });
        if (ghRes.ok) {
          const data = await ghRes.json();
          const content = Buffer.from(data.content, 'base64').toString('utf8');
          return { data: JSON.parse(content), sha: data.sha };
        }
      } catch (e) {}
      return null;
    }

    async function saveUser(emailHash, userData, sha) {
      if (!githubToken) return false;
      try {
        const body = {
          message: `Update customer ${emailHash.substring(0, 6)}`,
          content: Buffer.from(JSON.stringify(userData, null, 2)).toString('base64'),
          branch: 'main'
        };
        if (sha) body.sha = sha;

        const ghRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/content/customers/${emailHash}.json`, {
          method: 'PUT',
          headers: {
            'Authorization': `token ${githubToken}`,
            'User-Agent': 'UniqueByLea-Auth',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });
        return ghRes.ok;
      } catch (e) {
        return false;
      }
    }

    const secret = process.env.AUTH_SECRET || 'unique-by-lea-secret-key-2026';
    function createSessionToken(userEmail) {
      const payload = `${userEmail}:${Date.now()}`;
      const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      return Buffer.from(`${payload}:${sig}`).toString('base64');
    }

    function verifySessionToken(tok) {
      try {
        const decoded = Buffer.from(tok, 'base64').toString('utf8');
        const parts = decoded.split(':');
        if (parts.length < 3) return null;
        const [userEmail, time, sig] = parts;
        const expectedSig = crypto.createHmac('sha256', secret).update(`${userEmail}:${time}`).digest('hex');
        if (sig === expectedSig) {
          return userEmail;
        }
      } catch (e) {}
      return null;
    }

    if (action === 'register') {
      if (!normalizedEmail || !normalizedEmail.includes('@')) {
        return res.status(400).json({ error: 'Bitte gib eine gültige E-Mail-Adresse ein.' });
      }
      if (!password || password.length < 6) {
        return res.status(400).json({ error: 'Das Passwort muss mindestens 6 Zeichen lang sein.' });
      }

      const emailHash = getEmailHash(normalizedEmail);
      const existing = await getStoredUser(emailHash);
      if (existing) {
        return res.status(400).json({ error: 'Für diese E-Mail-Adresse existiert bereits ein Konto. Bitte melde dich an.' });
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const hashed = hashPassword(password, salt);
      const userData = {
        email: normalizedEmail,
        salt,
        passwordHash: hashed,
        wishlist: Array.isArray(wishlist) ? wishlist : [],
        createdAt: new Date().toISOString()
      };

      await saveUser(emailHash, userData);
      const sessionToken = createSessionToken(normalizedEmail);
      return res.status(200).json({
        success: true,
        user: { email: normalizedEmail, wishlist: userData.wishlist },
        token: sessionToken
      });
    }

    if (action === 'login') {
      if (!normalizedEmail || !password) {
        return res.status(400).json({ error: 'Bitte E-Mail und Passwort eingeben.' });
      }

      const emailHash = getEmailHash(normalizedEmail);
      const stored = await getStoredUser(emailHash);

      if (!stored) {
        if (!githubToken) {
          const sessionToken = createSessionToken(normalizedEmail);
          return res.status(200).json({
            success: true,
            user: { email: normalizedEmail, wishlist: Array.isArray(wishlist) ? wishlist : [] },
            token: sessionToken,
            note: 'local'
          });
        }
        return res.status(400).json({ error: 'Kein Konto mit dieser E-Mail-Adresse gefunden. Bitte registriere dich zuerst.' });
      }

      const { data } = stored;
      const expectedHash = hashPassword(password, data.salt);
      if (expectedHash !== data.passwordHash) {
        return res.status(400).json({ error: 'Das eingegebene Passwort ist leider nicht korrekt.' });
      }

      let mergedWishlist = data.wishlist || [];
      if (Array.isArray(wishlist) && wishlist.length > 0) {
        wishlist.forEach(item => {
          const name = typeof item === 'string' ? item : item.name;
          if (!mergedWishlist.some(m => (typeof m === 'string' ? m : m.name) === name)) {
            mergedWishlist.push(item);
          }
        });
        data.wishlist = mergedWishlist;
        await saveUser(emailHash, data, stored.sha);
      }

      const sessionToken = createSessionToken(normalizedEmail);
      return res.status(200).json({
        success: true,
        user: { email: normalizedEmail, wishlist: mergedWishlist },
        token: sessionToken
      });
    }

    if (action === 'sync_wishlist') {
      let userEmail = normalizedEmail;
      if (token) {
        const verified = verifySessionToken(token);
        if (verified) userEmail = verified;
      }

      if (!userEmail) {
        return res.status(401).json({ error: 'Nicht angemeldet.' });
      }

      const emailHash = getEmailHash(userEmail);
      const stored = await getStoredUser(emailHash);
      if (stored) {
        stored.data.wishlist = Array.isArray(wishlist) ? wishlist : [];
        stored.data.updatedAt = new Date().toISOString();
        await saveUser(emailHash, stored.data, stored.sha);
      }

      return res.status(200).json({ success: true, wishlist: wishlist || [] });
    }

    return res.status(400).json({ error: 'Unbekannte Aktion.' });
  } catch (err) {
    return res.status(500).json({ error: 'Serverfehler: ' + err.message });
  }
};
