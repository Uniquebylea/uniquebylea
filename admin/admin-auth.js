// admin/admin-auth.js – gemeinsame Admin-Anmeldung für alle Admin-Seiten.
// Das Passwort wird nie im Code gespeichert, sondern bei Bedarf abgefragt und nur für die Dauer der
// Browser-Sitzung (sessionStorage) gehalten. Geprüft wird ausschliesslich serverseitig (api/_auth.js).
(function () {
  var KEY = 'uniquebylea_admin_pw';
  window.getAdminToken = function (forcePrompt) {
    var t = sessionStorage.getItem(KEY) || '';
    if (!t || forcePrompt) {
      t = (window.prompt('Atelier-Passwort:') || '').trim();
      if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY);
    }
    return t;
  };
  window.clearAdminToken = function () { sessionStorage.removeItem(KEY); };
  // Entfernt Altlasten früherer Versionen (Klartext-Passwörter in localStorage)
  ['uniquebylea_admin_token', 'uniquebylea_admin_auth', 'uniquebylea_gh_token'].forEach(function (k) { localStorage.removeItem(k); });
  window.adminHeaders = function (extra) {
    var h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    var t = window.getAdminToken();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  };
  // Zentrale Behandlung von 401: Passwort verwerfen, damit die nächste Aktion erneut fragt
  window.adminFetch = async function (url, opts) {
    opts = opts || {};
    opts.headers = window.adminHeaders(opts.headers);
    var res = await fetch(url, opts);
    if (res.status === 401) window.clearAdminToken();
    return res;
  };
})();
