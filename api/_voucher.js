// api/_voucher.js – Gemeinsame Logik für Gutscheine (Laden, Validieren und Ledger-Abbuchung)
// Wird von api/create-checkout-session.js und api/stripe-webhook.js geteilt.
const fs = require('fs');
const path = require('path');

const REPO_OWNER = 'Uniquebylea';
const REPO_NAME = 'uniquebylea';
const FILE_PATH = 'content/vouchers.json';

async function loadVouchers() {
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    try {
      const ghRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=main`, {
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'UniqueByLea-Vouchers'
        }
      });
      if (ghRes.ok) {
        const ghJson = await ghRes.json();
        const content = Buffer.from(ghJson.content, 'base64').toString('utf8');
        return JSON.parse(content).vouchers || [];
      }
    } catch (e) {
      console.error('Fehler beim Laden der Gutscheine von GitHub:', e.message);
    }
  }

  try {
    const localPath = path.join(process.cwd(), 'content', 'vouchers.json');
    if (fs.existsSync(localPath)) {
      return JSON.parse(fs.readFileSync(localPath, 'utf8')).vouchers || [];
    }
  } catch (e) {
    console.error('Fehler beim Laden lokaler Gutscheine:', e.message);
  }

  return [];
}

// Bucht einen Betrag idempotent ab (über eine eindeutige Referenz: sessionId oder orderId)
async function applyVoucherLedger(code, amountCents, referenceId) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN fehlt');

  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`;
  const headers = {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'UniqueByLea-VoucherLedger',
    'Content-Type': 'application/json'
  };

  const codeUpper = (code || '').trim().toUpperCase();

  for (let attempt = 0; attempt < 3; attempt++) {
    const getRes = await fetch(`${url}?ref=main`, { headers });
    if (!getRes.ok) throw new Error(`Gutscheine nicht ladbar (${getRes.status})`);

    const file = await getRes.json();
    const vouchers = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')).vouchers || [];
    const v = vouchers.find(x => (x.code || '').trim().toUpperCase() === codeUpper);
    if (!v) throw new Error('Gutschein nicht gefunden');

    if ((v.transactions || []).some(t => t.session_id === referenceId)) {
      return 'already_processed';
    }

    const balance = Math.round((Number(v.remaining_balance) || 0) * 100);
    const charged = Math.min(balance, amountCents);
    v.remaining_balance = Math.max(0, (balance - charged) / 100);
    v.status = v.remaining_balance === 0 ? 'fully_redeemed' : 'partially_redeemed';

    if (!Array.isArray(v.transactions)) v.transactions = [];
    v.transactions.push({
      date: new Date().toISOString().slice(0, 10),
      type: 'redeem',
      amount: charged / 100,
      note: charged < amountCents ? 'Shop-Kauf (Guthaben geringer als Rabatt – bitte prüfen)' : 'Shop-Kauf',
      session_id: referenceId,
      new_balance: v.remaining_balance
    });

    const putRes = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Redeem CHF ${(charged / 100).toFixed(2)} from ${codeUpper}`,
        content: Buffer.from(JSON.stringify({ vouchers }, null, 2), 'utf8').toString('base64'),
        sha: file.sha,
        branch: 'main'
      })
    });

    if (putRes.ok) {
      return charged < amountCents ? 'redeemed_partial_balance' : 'redeemed';
    }
    if (putRes.status !== 409) {
      throw new Error(`Speichern fehlgeschlagen (${putRes.status})`);
    }
  }

  throw new Error('Gutschein-Update nach 3 Versuchen nicht möglich');
}

module.exports = {
  loadVouchers,
  applyVoucherLedger
};
