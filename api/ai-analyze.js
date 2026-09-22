module.exports = async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY ist in Vercel noch nicht eingetragen.' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Nur POST erlaubt' });
  }

  try {
    let imageList = [];
    if (Array.isArray(req.body.images) && req.body.images.length > 0) {
      imageList = req.body.images;
    } else if (req.body.imageBase64) {
      imageList = [{
        imageBase64: req.body.imageBase64,
        mimeType: req.body.mimeType || 'image/jpeg'
      }];
    }

    if (imageList.length === 0) {
      return res.status(400).json({ error: 'Keine Bilder empfangen.' });
    }

    const isMulti = imageList.length > 1;

    let prompt = '';
    if (isMulti) {
      prompt = `Du bist ein erfahrener Schweizer E-Commerce-Experte für das Handarbeits-Label "Unique by Lea" in Interlaken.
Vor dir liegen ${imageList.length} Fotos verschiedener Ausführungen oder Farben desselben handgefertigten Modells/Produkttyps (z. B. Badeponchos, Strampler, Taschen in verschiedenen Farben und Grössen).
Analysiere alle ${imageList.length} Fotos und gib ausschließlich ein valides JSON-Objekt zurück.

Folgendes Format ist zwingend einzuhalten:
{
  "name": "Eleganter, übergeordneter Modellname im Schweizer Boutique-Stil (z. B. 'Kuschel-Badeponcho mit Öhrchen')",
  "cat": "Wähle exakt eine dieser Kategorien: Baby, Kinder, Erwachsene, Makramee, Taschen, Gutscheine, Accessoires",
  "price": "Einheitlicher Basispreis in CHF (z. B. '55.00 CHF')",
  "description": "Liebevoller, ansprechender Verkaufstext (ca. 3-4 Sätze), der das Modell allgemein beschreibt (Schnitt, Funktion, weicher Stoff, Besonderheiten, Handarbeit im Berner Oberland), passend für alle abgebildeten Varianten.",
  "badge": "Unikate",
  "variants": [
${imageList.map((_, idx) => `    {
      "imageIndex": ${idx},
      "color": "Erkannte Hauptfarbe von Foto ${idx + 1} (z. B. 'Senfgelb', 'Beere', 'Salbei')",
      "size": "Geschätzte Grösse von Foto ${idx + 1} falls erkennbar (z. B. '1–3 Jahre' oder '62/68' oder 'Einheitsgrösse')",
      "title": "Kompakte Bezeichnung für Bild ${idx + 1} (z. B. 'Senfgelb · Gr. 1–3 Jahre')",
      "stock": 1,
      "price_add": 0
    }`).join(',\n')}
  ]
}`;
    } else {
      prompt = `Du bist ein erfahrener E-Commerce-Experte für das Schweizer Handarbeits-Label "Unique by Lea" in Interlaken.
Analysiere dieses Foto eines handgefertigten Unikats/Produkts und gib ausschließlich ein valides JSON-Objekt zurück.

Folgendes Format ist zwingend einzuhalten:
{
  "name": "Prägnanter, eleganter Produktname im Schweizer Boutique-Stil (z. B. 'Kuschel-Badeponcho mit Öhrchen' oder 'Babynestchen Kuschelschaf')",
  "cat": "Wähle exakt eine dieser Kategorien: Baby, Kinder, Erwachsene, Makramee, Taschen, Gutscheine, Accessoires",
  "price": "Passender Preis in CHF (z. B. '55.00 CHF')",
  "size": "Geschätzte Grösse (z. B. '62/68' für Babys, '1–3 Jahre' für Kleinkinder, oder 'Einheitsgrösse')",
  "description": "Liebevoller, ansprechender Verkaufstext (ca. 2-3 Sätze). Betone hochwertige Handarbeit und das Besondere an diesem Unikat.",
  "colors": ["Hauptfarbe 1", "Hauptfarbe 2"],
  "badge": "Unikat",
  "variants": [
    {
      "imageIndex": 0,
      "color": "Hauptfarbe",
      "size": "Geschätzte Grösse",
      "title": "Hauptfarbe · Grösse",
      "stock": 1,
      "price_add": 0
    }
  ]
}`;
    }

    const parts = [{ text: prompt }];
    for (const img of imageList) {
      const cleanBase64 = img.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      parts.push({
        inline_data: {
          mime_type: img.mimeType || 'image/jpeg',
          data: cleanBase64
        }
      });
    }
            generationConfig: {
              response_mime_type: 'application/json',
              temperature: 0.2
            }
          })
        });

        const data = await response.json();

        if (response.ok && !data.error && data.candidates?.[0]?.content?.parts?.[0]?.text) {
          successfulData = data;
          console.log(`Successfully generated content with ${model}`);
          break;
        } else {
          lastError = data.error?.message || `HTTP ${response.status} from ${model}`;
          console.warn(`Model ${model} failed:`, lastError);
        }
      } catch (callErr) {
        lastError = callErr.message;
        console.warn(`Error connecting to ${model}:`, callErr);
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
    console.error('Server error in ai-analyze:', err);
    return res.status(500).json({ error: err.message || 'Serverfehler bei der Bildanalyse' });
  }
};
