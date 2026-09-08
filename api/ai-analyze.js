let cachedModel = null;

async function getSupportedModel(apiKey) {
  if (cachedModel) return cachedModel;

  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (listRes.ok) {
      const data = await listRes.json();
      const models = data.models || [];
      const contentModels = models.filter(m => 
        Array.isArray(m.supportedGenerationMethods) && 
        m.supportedGenerationMethods.includes('generateContent')
      );
      
      // Preference: Flash models (fast & multimodal)
      const selected = 
        contentModels.find(m => m.name.includes('gemini-2.5-flash')) ||
        contentModels.find(m => m.name.includes('gemini-2.0-flash')) ||
        contentModels.find(m => m.name.includes('flash') && !m.name.includes('lite') && !m.name.includes('8b')) ||
        contentModels.find(m => m.name.includes('flash')) ||
        contentModels.find(m => m.name.includes('gemini')) ||
        contentModels[0];

      if (selected && selected.name) {
        cachedModel = selected.name.replace(/^models\//, '');
        console.log(`Discovered active Gemini model: ${cachedModel}`);
        return cachedModel;
      }
    }
  } catch (err) {
    console.error('ListModels error:', err);
  }

  return 'gemini-2.5-flash';
}

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

    // Candidate models to try in order
    const dynamicModel = await getSupportedModel(apiKey);
    const candidateModels = [dynamicModel, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-pro'];
    const uniqueCandidates = [...new Set(candidateModels)];

    let lastError = null;
    let successfulData = null;

    for (const model of uniqueCandidates) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

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

        if (response.ok && !data.error && data.candidates?.[0]?.content?.parts?.[0]?.text) {
          cachedModel = model;
          successfulData = data;
          break;
        } else {
          lastError = data.error?.message || `HTTP ${response.status} from ${model}`;
          console.warn(`Model ${model} failed:`, lastError);
          // If 404 or unsupported, continue to next candidate
          if (response.status === 404 || (data.error && data.error.message && data.error.message.includes('not found'))) {
            cachedModel = null; // invalidate cache
            continue;
          }
        }
      } catch (callErr) {
        lastError = callErr.message;
        console.warn(`Call to ${model} threw error:`, callErr);
      }
    }

    if (!successfulData) {
      return res.status(500).json({ error: lastError || 'Kein KI-Modell konnte die Bildanalyse durchführen.' });
    }

    const textResponse = successfulData.candidates[0].content.parts[0].text;
    const cleanText = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
    const productData = JSON.parse(cleanText);
    return res.status(200).json(productData);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Serverfehler bei der Bildanalyse' });
  }
};
