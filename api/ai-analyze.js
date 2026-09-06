module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Nur POST erlaubt' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY ist in Vercel noch nicht eingetragen.' });
  }

  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'Kein Bild empfangen.' });
    }

    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const cleanMime = mimeType || 'image/jpeg';

    const prompt = `Du bist ein erfahrener E-Commerce-Experte für das Schweizer Handarbeits-Label "Unique by Lea" in Interlaken.
Analysiere dieses Foto eines handgefertigten Unikats/Produkts und gib ausschließlich ein valides JSON-Objekt zurück.

Folgendes Format ist zwingend einzuhalten:
{
  "name": "Prägnanter, eleganter Produktname im Schweizer Boutique-Stil (z. B. 'Babynestchen Kuschelschaf' oder 'Makramee Wandbehang Boho')",
  "cat": "Wähle exakt eine dieser Kategorien: Baby, Kinder, Erwachsene, Makramee, Taschen, Gutscheine, Accessoires",
  "description": "Liebevoller, ansprechender Verkaufstext (ca. 2-3 Sätze). Betone hochwertige Handarbeit und das Besondere an diesem Unikat.",
  "colors": ["Hauptfarbe 1", "Hauptfarbe 2"],
  "badge": "Unikat"
}`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: cleanMime,
                  data: cleanBase64
                }
              }
            ]
          }
        ],
        generationConfig: {
          response_mime_type: 'application/json',
          temperature: 0.2
        }
      })
    });

    const data = await response.json();
    if (data.error) {
      return res.status(500).json({ error: data.error.message || 'Fehler bei Gemini API' });
    }

    const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textResponse) {
      return res.status(500).json({ error: 'Keine Antwort von der KI erhalten.' });
    }

    const productData = JSON.parse(textResponse);
    return res.status(200).json(productData);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Serverfehler bei der Bildanalyse' });
  }
};
