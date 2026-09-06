module.exports = (req, res) => {
  // Akzeptiert sowohl OAUTH_GITHUB_CLIENT_ID als auch GITHUB_CLIENT_ID
  const clientId =
    process.env.OAUTH_GITHUB_CLIENT_ID ||
    process.env.GITHUB_CLIENT_ID ||
    process.env.CLIENT_ID;

  if (!clientId) {
    // Zeigt an, welche Variablen Vercel überhaupt kennt (ohne geheime Werte zu verraten)
    const knownKeys = Object.keys(process.env).filter(
      (k) => !k.startsWith("VERCEL") && !k.startsWith("AWS") && !k.startsWith("NODE")
    );
    return res
      .status(500)
      .send(
        `Fehler: Client-ID nicht gefunden. Bekannte Variablen in Vercel: [${knownKeys.join(
          ", "
        )}]`
      );
  }

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const redirectUri = `${proto}://${host}/api/callback`;

  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&scope=repo,user`;

  res.redirect(302, githubAuthUrl);
};
