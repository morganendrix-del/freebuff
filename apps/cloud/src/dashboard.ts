/**
 * Sandbox dashboard. Deliberately a single dependency-free page: it lists sandboxes, shows where the
 * pipeline is, links to previews and lets you import another repository. The API token is kept in
 * sessionStorage, not in the URL, so sharing a preview link never shares the token.
 */
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>freebuff cloud · sandboxes</title>
<style>
  :root { color-scheme: dark; --bg:#0d1014; --panel:#151a21; --line:#242c36; --text:#e7edf3; --muted:#8d9aa8; --accent:#4ea1ff; --ok:#42c98b; --bad:#ff6b6b; --warn:#f0b64b; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { display:flex; align-items:baseline; gap:12px; padding:20px 28px; border-bottom:1px solid var(--line); }
  header h1 { font-size:16px; margin:0; letter-spacing:.2px; }
  header span { color:var(--muted); font-size:12px; }
  main { max-width:1080px; margin:0 auto; padding:24px 28px 64px; }
  form { display:flex; flex-wrap:wrap; gap:8px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:24px; }
  input, button { font:inherit; border-radius:7px; border:1px solid var(--line); background:#0b0e12; color:var(--text); padding:8px 10px; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { background:var(--accent); border-color:transparent; color:#04121f; font-weight:600; cursor:pointer; }
  button.secondary { background:transparent; color:var(--text); border-color:var(--line); font-weight:500; }
  button:disabled { opacity:.5; cursor:progress; }
  .row { display:flex; align-items:center; gap:8px; flex:1; min-width:320px; }
  .row input { flex:1; }
  .hint { color:var(--muted); font-size:12px; margin:-14px 0 24px; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.6px; color:var(--muted); padding:0 10px 8px; }
  td { padding:12px 10px; border-top:1px solid var(--line); vertical-align:top; }
  .repo { font-weight:600; }
  .meta { color:var(--muted); font-size:12px; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; }
  .pill.ready { background:rgba(66,201,139,.15); color:var(--ok); }
  .pill.failed { background:rgba(255,107,107,.15); color:var(--bad); }
  .pill.working { background:rgba(240,182,75,.15); color:var(--warn); }
  .pill.stopped { background:rgba(141,154,168,.15); color:var(--muted); }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .stages { color:var(--muted); font-size:11px; }
  .empty { color:var(--muted); padding:32px 10px; border-top:1px solid var(--line); }
  .error { color:var(--bad); font-size:12px; min-height:18px; }
</style>
</head>
<body>
<header><h1>freebuff cloud</h1><span>isolated sandboxes · repo to preview</span></header>
<main>
  <form id="import">
    <div class="row">
      <input id="repo" placeholder="owner/repository" autocomplete="off" required />
      <input id="branch" placeholder="branch (optional)" autocomplete="off" />
      <button type="submit">Import repository</button>
    </div>
    <div class="row">
      <input id="token" type="password" placeholder="API token (stored for this tab)" autocomplete="off" />
      <button type="button" class="secondary" id="save-token">Use token</button>
    </div>
    <div class="error" id="error"></div>
  </form>
  <p class="hint">Previews are public to anyone with the link. Sandboxes stop at their TTL.</p>
  <table>
    <thead><tr><th>Repository</th><th>Status</th><th>Preview</th><th>Timings</th><th></th></tr></thead>
    <tbody id="list"><tr><td colspan="5" class="empty">Loading…</td></tr></tbody>
  </table>
</main>
<script>
(function () {
  var KEY = "freebuff.cloud.token";
  var tokenInput = document.getElementById("token");
  var saved = sessionStorage.getItem(KEY);
  if (saved) tokenInput.value = saved;

  function getToken() { return sessionStorage.getItem(KEY) || ""; }

  function headers(extra) {
    var out = extra || {};
    var token = getToken();
    if (token) out["authorization"] = "Bearer " + token;
    return out;
  }

  function showError(message) {
    document.getElementById("error").textContent = message || "";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  function pillClass(status) {
    if (status === "ready") return "ready";
    if (status === "failed") return "failed";
    if (status === "stopped") return "stopped";
    return "working";
  }

  function renderItems(items) {
    var body = document.getElementById("list");
    if (!items || items.length === 0) {
      body.innerHTML = '<tr><td colspan="5" class="empty">No sandboxes yet. Import a public repository above.</td></tr>';
      return;
    }
    body.innerHTML = items.map(function (item) {
      var name = escapeHtml(item.repo.owner + "/" + item.repo.name);
      var pill = '<span class="pill ' + pillClass(item.status) + '">' + escapeHtml(item.status) + "</span>";
      var preview = item.previewUrl
        ? '<a href="' + escapeHtml(item.previewUrl) + '" target="_blank" rel="noreferrer">Open preview</a>'
        : '<span class="meta">' + (item.failure ? escapeHtml(item.failure.code + ": " + item.failure.message) : "—") + "</span>";
      var stages = (item.stages || []).map(function (stage) {
        return escapeHtml(stage.stage) + " " + Math.round(stage.durationMs) + "ms";
      }).join(" · ");
      var total = item.stages ? item.stages.reduce(function (sum, stage) { return sum + stage.durationMs; }, 0) : 0;
      var stop = item.status === "ready" || item.status === "starting"
        ? '<button class="secondary" data-stop="' + escapeHtml(item.id) + '">Stop</button>'
        : "";
      return '<tr><td><div class="repo">' + name + '</div><div class="meta">' + escapeHtml(item.isolation) + " · " + escapeHtml(item.id.slice(0, 16)) + "</div></td>" +
        "<td>" + pill + "</td><td>" + preview + "</td>" +
        '<td class="stages">' + (stages || "—") + (total ? "<div>" + Math.round(total) + "ms total</div>" : "") + "</td>" +
        "<td>" + stop + "</td></tr>";
    }).join("");
  }

  function load() {
    fetch("/v1/sandboxes", { headers: headers() })
      .then(function (response) {
        if (response.status === 401) throw new Error("API token required.");
        if (!response.ok) throw new Error("Could not load sandboxes (status " + response.status + ").");
        return response.json();
      })
      .then(function (payload) { showError(""); renderItems(payload.sandboxes); })
      .catch(function (error) { showError(error.message); });
  }

  document.getElementById("save-token").addEventListener("click", function () {
    sessionStorage.setItem(KEY, tokenInput.value.trim());
    load();
  });

  document.getElementById("import").addEventListener("submit", function (event) {
    event.preventDefault();
    var repo = document.getElementById("repo").value.trim();
    var branch = document.getElementById("branch").value.trim();
    var button = event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    showError("");
    fetch("/v1/sandboxes", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ repo: repo, branch: branch || undefined })
    })
      .then(function (response) {
        if (!response.ok) return response.json().then(function (payload) {
          throw new Error((payload.error && payload.error.message) || "Import failed.");
        });
        document.getElementById("repo").value = "";
        document.getElementById("branch").value = "";
        load();
      })
      .catch(function (error) { showError(error.message); })
      .finally(function () { button.disabled = false; });
  });

  document.getElementById("list").addEventListener("click", function (event) {
    var id = event.target.getAttribute("data-stop");
    if (!id) return;
    fetch("/v1/sandboxes/" + encodeURIComponent(id) + "/stop", { method: "POST", headers: headers() })
      .then(load)
      .catch(function (error) { showError(error.message); });
  });

  load();
  setInterval(load, 2000);
})();
</script>
</body>
</html>`;
}
