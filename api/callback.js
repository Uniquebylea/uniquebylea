module.exports = async (req, res) => {
  const code = req.query.code;
  const clientId =
    process.env.OAUTH_GITHUB_CLIENT_ID ||
    process.env.GITHUB_CLIENT_ID ||
    process.env.CLIENT_ID;
  const clientSecret =
    process.env.OAUTH_GITHUB_CLIENT_SECRET ||
    process.env.GITHUB_CLIENT_SECRET ||
    process.env.CLIENT_SECRET;

  if (!code) {
    return res.status(400).send("Fehler: Kein Code von GitHub empfangen.");
  }

  if (!clientId || !clientSecret) {
    return res.status(500).send("Fehler: GitHub OAuth Umgebungsvariablen fehlen in Vercel.");
  }

  try {
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
      }),
    });

    const data = await response.json();

    if (data.error || !data.access_token) {
      const errorMsg = data.error_description || data.error || "Login fehlgeschlagen";
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(400).send(renderPostMessage({ error: errorMsg }, "error"));
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(
      renderPostMessage({ token: data.access_token, provider: "github" }, "success")
    );
  } catch (err) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(500).send(renderPostMessage({ error: err.message }, "error"));
  }
};

function renderPostMessage(data, status) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Authentifizierung...</title></head>
<body>
  <p>Authentifizierung erfolgreich, Fenster schließt sich...</p>
  <script>
    (function() {
      function receiveMessage(e) {
        console.log("receiveMessage", e);
        window.opener.postMessage(
          'authorization:github:${status}:' + JSON.stringify(${JSON.stringify(data)}),
          e.origin
        );
        window.removeEventListener("message", receiveMessage, false);
      }
      window.addEventListener("message", receiveMessage, false);
      window.opener.postMessage("authorizing:github", "*");
    })();
  </script>
</body>
</html>`;
}
