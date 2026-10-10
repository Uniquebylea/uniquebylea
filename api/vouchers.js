const fs = require('fs');
const path = require('path');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const token = process.env.GITHUB_TOKEN;
  const repoOwner = 'Uniquebylea';
  const repoName = 'uniquebylea';
  const filePath = 'content/vouchers.json';
  const localFilePath = path.join(process.cwd(), 'content', 'vouchers.json');

  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'UniqueByLea-Vouchers-Agent'
  };
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  // Admin-Prüfung
  function checkAdmin(req) {
    return require('./_auth').isAdmin(req);
  }

  // Hilfsfunktion: Gutscheine von GitHub oder lokal laden
  async function loadVouchersFromGitHub() {
    // 1. Zuerst GitHub versuchen
    if (token) {
      try {
        const ghRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}?ref=main`, { headers });
        if (ghRes.ok) {
          const data = await ghRes.json();
          const content = Buffer.from(data.content, 'base64').toString('utf8');
          const parsed = JSON.parse(content);
          return { vouchers: parsed.vouchers || [], sha: data.sha };
        }
      } catch (e) {
        console.error("Fehler beim Laden von GitHub:", e);
      }
    }

    // 2. Lokaler Fallback
    try {
      if (fs.existsSync(localFilePath)) {
        const content = fs.readFileSync(localFilePath, 'utf8');
        const parsed = JSON.parse(content);
        return { vouchers: parsed.vouchers || [], sha: null };
      }
    } catch (e) {
      console.error("Fehler beim Laden aus lokalem Dateisystem:", e);
    }

    return { vouchers: [], sha: null };
  }

  // Hilfsfunktion: Gutscheine auf GitHub oder lokal speichern
  async function saveVouchersToGitHub(vouchersList, sha, commitMsg) {
    let saved = false;

    // 1. Lokale Datei aktualisieren
    try {
      const dir = path.dirname(localFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(localFilePath, JSON.stringify({ vouchers: vouchersList }, null, 2), 'utf8');
      saved = true;
    } catch (e) {
      console.warn("Konnte lokal nicht schreiben (ggf. Serverless-Umgebung):", e.message);
    }

    // 2. GitHub aktualisieren
    if (token) {
      try {
        const body = {
          message: commitMsg || "Update vouchers ledger",
          content: Buffer.from(JSON.stringify({ vouchers: vouchersList }, null, 2), 'utf8').toString('base64'),
          branch: 'main'
        };
        if (sha) body.sha = sha;

        const ghRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}`, {
          method: 'PUT',
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });
        if (ghRes.ok) saved = true;
      } catch (e) {
        console.error("Fehler beim Speichern auf GitHub:", e);
      }
    }

    return saved;
  }

  // GET: Gutscheine abfragen
  if (req.method === 'GET') {
    try {
      const { vouchers } = await loadVouchersFromGitHub();
      const codeQuery = (req.query?.code || '').trim().toUpperCase();

      // Öffentliche Abfrage eines einzelnen Codes (z. B. im Warenkorb)
      if (codeQuery) {
        const found = vouchers.find(v => (v.code || '').trim().toUpperCase() === codeQuery);
        if (!found) {
          return res.status(404).json({ success: false, error: 'Gutscheincode nicht gefunden.' });
        }

        const isAdminUser = checkAdmin(req);
        // Anonyme Kunden sehen NUR Guthaben und Status, keine persönlichen Daten / Absender
        return res.status(200).json({
          success: true,
          voucher: {
            code: found.code,
            original_amount: Number(found.original_amount) || 0,
            remaining_balance: Number(found.remaining_balance) || 0,
            status: found.status || 'active',
            theme: found.theme || 'Terracotta',
            ...(isAdminUser ? {
              for: found.for || '',
              from: found.from || '',
              message: found.message || '',
              created_at: found.created_at || '',
              transactions: found.transactions || []
            } : {})
          }
        });
      }

      // Abfrage ALLER Gutscheine: NUR FÜR ADMINS ERLAUBT!
      if (!checkAdmin(req)) {
        return res.status(401).json({
          success: false,
          error: 'Nicht autorisiert. Die Gesamtübersicht der Gutscheine erfordert ein gültiges Atelier-Passwort.'
        });
      }

      return res.status(200).json({ success: true, vouchers: vouchers });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // POST: Gutschein einlösen oder neu anlegen
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      body = body || {};

      const { action } = body;
      const { vouchers, sha } = await loadVouchersFromGitHub();

      // 1. TEILBETRAG ABBUCHEN / EINLÖSEN (vom Checkout oder Admin)
      if (action === 'redeem') {
        if (!checkAdmin(req)) {
          return res.status(401).json({ success: false, error: 'Nur für autorisierte Atelier-Admins.' });
        }
        const code = (body.code || '').trim().toUpperCase();
        const amount = parseFloat(body.amount);
        const note = (body.note || 'Einkauf im Shop / Atelier').trim();

        if (!code || isNaN(amount) || amount <= 0) {
          return res.status(400).json({ success: false, error: 'Gültiger Code und Betrag erforderlich.' });
        }

        const vIdx = vouchers.findIndex(v => (v.code || '').trim().toUpperCase() === code);
        if (vIdx === -1) {
          return res.status(404).json({ success: false, error: `Gutschein «${code}» nicht gefunden.` });
        }

        const voucher = vouchers[vIdx];
        const currentBalance = Number(voucher.remaining_balance) || 0;

        if (currentBalance < amount) {
          return res.status(400).json({ 
            success: false, 
            error: `Restguthaben nicht ausreichend. Aktuell verfügbar: CHF ${currentBalance.toFixed(2)}` 
          });
        }

        const newBalance = Math.max(0, currentBalance - amount);
        voucher.remaining_balance = Math.round(newBalance * 100) / 100;
        voucher.status = voucher.remaining_balance === 0 ? 'fully_redeemed' : 'partially_redeemed';

        if (!Array.isArray(voucher.transactions)) {
          voucher.transactions = [];
        }
        voucher.transactions.push({
          date: new Date().toISOString().slice(0, 10),
          type: 'redeem',
          amount: amount,
          note: note,
          new_balance: voucher.remaining_balance
        });

        vouchers[vIdx] = voucher;

        await saveVouchersToGitHub(vouchers, sha, `Redeem CHF ${amount.toFixed(2)} from ${code}`);
        return res.status(200).json({ success: true, voucher: voucher });
      }

      // 2. NEUEN GUTSCHEIN ERFASSEN (NUR ADMIN)
      if (action === 'create') {
        if (!checkAdmin(req)) {
          return res.status(401).json({ success: false, error: 'Nur für autorisierte Atelier-Admins.' });
        }

        const { voucher } = body;
        if (!voucher || !voucher.code || !voucher.amount) {
          return res.status(400).json({ success: false, error: 'Code und Betrag sind erforderlich.' });
        }

        const code = voucher.code.trim().toUpperCase();
        const numAmount = parseFloat(voucher.amount) || 50;

        const existing = vouchers.find(v => (v.code || '').trim().toUpperCase() === code);
        if (existing) {
          return res.status(400).json({ success: false, error: `Code «${code}» existiert bereits!` });
        }

        const newVoucher = {
          code: code,
          created_at: new Date().toISOString().slice(0, 10),
          original_amount: numAmount,
          remaining_balance: numAmount,
          for: voucher.for || voucher.fuer || '',
          from: voucher.from || voucher.von || '',
          message: voucher.message || voucher.text || '',
          theme: voucher.theme || 'Terracotta',
          status: 'active',
          transactions: [
            {
              date: new Date().toISOString().slice(0, 10),
              type: 'issue',
              amount: numAmount,
              note: voucher.note || 'Gutschein ausgestellt',
              new_balance: numAmount
            }
          ]
        };

        vouchers.unshift(newVoucher);
        await saveVouchersToGitHub(vouchers, sha, `Create voucher ${code} (CHF ${numAmount})`);
        return res.status(200).json({ success: true, voucher: newVoucher });
      }

      return res.status(400).json({ success: false, error: 'Unbekannte Aktion.' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};