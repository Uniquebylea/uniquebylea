module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Nur POST erlaubt' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY ist in Vercel noch nicht eingetragen.' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    const { imageBase64, mimeType } = body || {};
    if (!imageBase64) {
      return res.status(400).json({ error: 'Kein Stoffbild empfangen.' });
    }

    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const cleanMime = mimeType || 'image/jpeg';

    const prompt = `Du bist eine passionierte Textilexpertin beim Schweizer Handarbeits- und Nähatelier "Unique by Lea" in Interlaken.
Analysiere dieses Foto eines handverlesenen Atelier-Stoffes oder Garns und gib ausschließlich ein valides JSON-Objekt zurück.

Zwingendes JSON-Format:
{
  "name": "Prägnanter Stoffname im Boutique-Stil (z. B. 'Bio-Musselin Salbeigrün', 'Waffelpiqué Creme Natur', 'Bio-Jersey Waldtiere', 'Makramee Terracotta Garn')",
  "fabricType": "Genaue Stoffart (z. B. Bio-Musselin, Waffelpiqué, Bio-Jersey, Makramee-Garn, Rib-Jersey, French Terry, Leinen, Breitcord, etc.)",
  "category": "Exakt eine dieser Kategorien: musselin | waffel | jersey | makramee | weitere",
  "primaryColor": "Name der Hauptfarbe auf Deutsch (z. B. Salbeigrün, Terracotta, Altrosa, Creme Natur, Senfgelb, Waldgrün, Puderrosa, etc.)",
  "colorHex": "Exakter Hex-Farbcode der Hauptfarbe (z. B. #97A594, #B08968, #F5EFEB, #D3A29D) für das digitale Farbmusterfeld",
  "pattern": "Musterbeschreibung (z. B. 'Unifarben mit sanfter Struktur', 'Botanische Zweige & Blätter', 'Kleine Waldtiere', 'Boho Regenbögen', 'Punkte', 'Streifen')",
  "cert": "GOTS Bio-Baumwolle oder OEKO-TEX Standard 100",
  "badge": "Ein kurzes Badge (z. B. 'Neu im Atelier', 'Bestseller', 'Musterliebe', 'Zart', 'Trend')",
  "description": "Liebevoller, ansprechender Schweizer Atelier-Text (2-3 Sätze): Beschreibe Weichheit, Haptik und wofür sich der Stoff besonders schön eignet (z. B. Babynestchen, Krabbeldecken, Halstücher, Babykleidung oder Kissen).",
  "recommendedWith": ["Kombipartner 1", "Kombipartner 2"]
}`;

    const modelsToTry = [
      'gemini-2.5-flash',
      'gemini-1.5-flash',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash'
    ];

    let lastError = null;
    let successfulData = null;

    for (const model of modelsToTry) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                { inline_data: { mime_type: cleanMime, data: cleanBase64 } }
              ]
            }],
            generationConfig: {
              response_mime_type: 'application/json',
              temperature: 0.2
            }
          })
        });

        const data = await response.json();
        if (response.ok && !data.error && data.candidates?.[0]?.content?.parts?.[0]?.text) {
          successfulData = data;
          break;
        } else {
          lastError = data.error?.message || `HTTP ${response.status} from ${model}`;
        }
      } catch (err) {
        lastError = err.message;
      }
    }

    if (!successfulData) {
      return res.status(500).json({ error: lastError || 'Kein KI-Modell konnte die Stoffanalyse durchführen.' });
    }

    const textResponse = successfulData.candidates[0].content.parts[0].text;
    const cleanText = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
    const fabricData = JSON.parse(cleanText);
    return res.status(200).json(fabricData);

  } catch (err) {
    console.error('Error in fabric-analyze:', err);
    return res.status(500).json({ error: err.message || 'Serverfehler bei der Stoffanalyse' });
  }
};
