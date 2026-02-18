let token = null;
let infoAutoTimer = null;
let processAutoTimer = null;
const TABS = ["db", "dbform", "ban", "msg", "broadcast", "outbox", "botctl", "appctl", "profile", "info"];
let infoLoading = false;
const processLoading = { bot: false, app: false };
let lastInfoPayload = "";
const lastProcessPayload = { bot: "", app: "" };
let currentDbRows = [];

const $ = (id) => document.getElementById(id);

function setMsg(id, text, good = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.style.color = good ? "#10b981" : "#9ca3af";
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showTab(name) {
  TABS.forEach((tab) => {
    const el = $(`tab-${tab}`);
    if (!el) return;
    const shouldShow = tab === name;
    const wasHidden = el.classList.contains("hidden");
    el.classList.toggle("hidden", !shouldShow);
    if (shouldShow && wasHidden) {
      el.classList.remove("tab-enter");
      // Restart animation class for a smooth transition on each tab change.
      requestAnimationFrame(() => {
        el.classList.add("tab-enter");
        setTimeout(() => el.classList.remove("tab-enter"), 280);
      });
    }
  });
  setActiveNav(name);
}

function setActiveNav(name) {
  document.querySelectorAll(".menu button[data-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === name);
  });
}

function setMenuOpen(open) {
  const drawer = $("menuDrawer");
  const backdrop = $("menuBackdrop");
  if (!drawer || !backdrop) return;
  drawer.classList.toggle("open", Boolean(open));
  backdrop.classList.toggle("hidden", !open);
}

function closeMenuOnMobile() {
  if (window.matchMedia("(max-width: 980px)").matches) {
    setMenuOpen(false);
  }
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
}

function renderTable(rows) {
  if (!rows || rows.length === 0) return "<p style='padding:8px'>Keine Daten</p>";
  const keys = Object.keys(rows[0]);
  const th = keys.map((k) => `<th>${k}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${keys.map((k) => `<td data-label="${k}">${String(r[k] ?? "")}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="respTable"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderDbCards(rows) {
  if (!rows || rows.length === 0) return "<p style='padding:8px'>Keine Daten</p>";
  const titleKeys = ["profile_name", "chat_id", "name", "title", "cmd", "error_id", "id", "key"];
  return `
    <div class="dbCardList">
      ${rows
        .map((r) => {
          const keys = Object.keys(r);
          const rid = Number(r.__rowid || 0);
          const titleKey = titleKeys.find((k) => r[k] != null && String(r[k]).trim() !== "");
          const titleValue = titleKey ? String(r[titleKey]) : "";
          const body = keys
            .filter((k) => k !== "__rowid")
            .map((k) => `<div class="dbCardKv"><span>${k}</span><strong>${String(r[k] ?? "-")}</strong></div>`)
            .join("");
          return `
            <article class="dbCard">
              <div class="dbCardHead">
                <span>${titleValue || "Datensatz"}</span>
                ${rid > 0 ? `<b>#${rid}</b>` : ""}
              </div>
              ${body}
              ${
                rid > 0
                  ? `<div class="dbCardActions"><button class="dbCardEditBtn" data-rowid="${rid}">Bearbeiten</button><button class="dbCardDeleteBtn danger" data-rowid="${rid}">Löschen</button></div>`
                  : ""
              }
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function fmtUptime(sec) {
  const s = Math.max(0, Number(sec || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = [];
  if (d) r.push(`${d}d`);
  if (h) r.push(`${h}h`);
  r.push(`${m}m`);
  return r.join(" ");
}

function updateProcessAutoRefresh(target) {
  if (!target) {
    if (processAutoTimer) {
      clearInterval(processAutoTimer);
      processAutoTimer = null;
    }
    return;
  }
  if (processAutoTimer) clearInterval(processAutoTimer);
  processAutoTimer = setInterval(() => {
    if (!token) return;
    if (target === "bot") {
      const tab = $("tab-botctl");
      if (!tab || tab.classList.contains("hidden")) return;
      loadProcessPanel("bot", "botStatusWrap", "botLogsWrap", "botCtlMsg").catch(() => {});
      return;
    }
    const tab = $("tab-appctl");
    if (!tab || tab.classList.contains("hidden")) return;
    loadProcessPanel("app", "appStatusWrap", "appLogsWrap", "appCtlMsg").catch(() => {});
  }, 1000);
}

function kvRow(k, v) {
  return `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

function fmtVersion(versionCode) {
  const code = Number(versionCode);
  if (!Number.isFinite(code) || code <= 0) return "-";
  const normalized = Math.floor(code);
  const major = Math.floor(normalized / 10000);
  const minor = Math.floor((normalized % 10000) / 100);
  const patch = normalized % 100;
  return `v${major}.${minor}.${patch}`;
}

function fmtSemver(version) {
  const v = String(version || "").trim();
  if (!v) return "-";
  return v.startsWith("v") ? v : `v${v}`;
}

function getClientDeviceInfo() {
  const ua = navigator.userAgent || "-";
  const platform = navigator.platform || "-";
  const lang = navigator.language || "-";
  const online = navigator.onLine ? "online" : "offline";
  const screenSize = `${window.screen?.width || "-"}x${window.screen?.height || "-"}`;
  const viewport = `${window.innerWidth || "-"}x${window.innerHeight || "-"}`;
  return { ua, platform, lang, online, screenSize, viewport };
}

function renderInfo(data, appMeta, clientInfo) {
  const server = data?.server || {};
  const bot = data?.bot || {};
  const app = appMeta || {};
  const client = clientInfo || {};
  const load = Array.isArray(server.loadAvg) ? server.loadAvg.map((v) => Number(v).toFixed(2)).join(" / ") : "-";
  return `
    <div class="infoGrid">
      <div class="infoCard">
        <h4 class="infoTitle">Server</h4>
        ${kvRow("Host", server.host || "-")}
        ${kvRow("Plattform", server.platform || "-")}
        ${kvRow("Node.js", server.node || "-")}
        ${kvRow("Uptime", fmtUptime(server.uptimeSec))}
      </div>
      <div class="infoCard">
        <h4 class="infoTitle">Ressourcen</h4>
        ${kvRow("RAM gesamt", `${server.totalMemGB || "-"} GB`)}
        ${kvRow("RAM frei", `${server.freeMemGB || "-"} GB`)}
        ${kvRow("Bot RAM", `${server.processMemMB || "-"} MB`)}
        ${kvRow("Load (1/5/15)", load)}
      </div>
      <div class="infoCard">
        <h4 class="infoTitle">Bot</h4>
        ${kvRow("Nutzer", bot.users ?? "-")}
        ${kvRow("Bans", bot.bans ?? "-")}
        ${kvRow("Quests", bot.quests ?? "-")}
        ${kvRow("Währung", bot.currency || "-")}
      </div>
      <div class="infoCard">
        <h4 class="infoTitle">App</h4>
        ${kvRow("Neueste Version", fmtVersion(app.latestVersionCode))}
        ${kvRow("Download-URL", app.apkDownloadUrl || "-")}
        ${kvRow("Server-URL", app.serverUrl || "-")}
        ${kvRow("Panel Build", fmtSemver(app.panelVersion))}
        ${kvRow("Update-Stand", app.ts ? new Date(app.ts).toLocaleString("de-DE") : "-")}
      </div>
      <div class="infoCard">
        <h4 class="infoTitle">Endgerät</h4>
        ${kvRow("Plattform", client.platform || "-")}
        ${kvRow("Sprache", client.lang || "-")}
        ${kvRow("Netz", client.online || "-")}
        ${kvRow("Display", client.screenSize || "-")}
        ${kvRow("Viewport", client.viewport || "-")}
        ${kvRow("User-Agent", client.ua || "-")}
      </div>
    </div>
    <div class="pillRow">
      <span class="pill">Status: online</span>
      <span class="pill">Antwortformat: Owner Panel</span>
      <span class="pill">Update-Stand: ${app.ts ? new Date(app.ts).toLocaleString("de-DE") : "-"}</span>
    </div>
  `;
}

async function loadTables() {
  const data = await api("/api/db/tables");
  const select = $("tableSelect");
  const options = data.tables.map((t) => `<option value="${t}">${t}</option>`).join("");
  select.innerHTML = options;
  const formSelect = $("dbFormTableSelect");
  if (formSelect) formSelect.innerHTML = options;
}

async function loadCurrentTable() {
  const table = $("tableSelect").value;
  const limit = Math.max(1, Math.min(500, Number($("limitInput").value || 50)));
  const q = $("dbSearchInput")?.value?.trim() || "";
  const data = await api(`/api/db/${encodeURIComponent(table)}?limit=${limit}&q=${encodeURIComponent(q)}`);
  currentDbRows = Array.isArray(data.rows) ? data.rows : [];
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  $("tableWrap").innerHTML = mobile ? renderDbCards(currentDbRows) : renderTable(currentDbRows);
  if (mobile) bindDbCardActions();
}

function fillDbFormFromRow(row) {
  if (!row) return;
  const clean = { ...row };
  const rid = Number(clean.__rowid || 0);
  delete clean.__rowid;
  $("dbFormRowIdInput").value = rid > 0 ? String(rid) : "";
  dbFormColumns = Object.keys(clean).map((name) => ({ name }));
  renderDbFormFields(dbFormColumns, clean);
}

async function openDbFormForRow(rowid) {
  const row = currentDbRows.find((r) => Number(r.__rowid || 0) === Number(rowid));
  if (!row) return;
  const table = $("tableSelect").value;
  showTab("dbform");
  setActiveNav("dbform");
  $("dbFormTableSelect").value = table;
  await loadDbFormTable();
  fillDbFormFromRow(row);
  setMsg("dbFormMsg", `Datensatz ${rowid} geladen.`, true);
}

function bindDbCardActions() {
  const wrap = $("tableWrap");
  if (!wrap) return;
  wrap.querySelectorAll(".dbCardEditBtn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const rowid = Number(btn.getAttribute("data-rowid") || 0);
      if (!rowid) return;
      await openDbFormForRow(rowid);
    });
  });
  wrap.querySelectorAll(".dbCardDeleteBtn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const rowid = Number(btn.getAttribute("data-rowid") || 0);
      if (!rowid) return;
      const ok = window.confirm(`Datensatz #${rowid} wirklich löschen?`);
      if (!ok) return;
      try {
        const table = $("tableSelect").value;
        await api(`/api/db/${encodeURIComponent(table)}/row/${rowid}`, { method: "DELETE" });
        setMsg("dbMsg", `Eintrag ${rowid} gelöscht.`, true);
        await loadCurrentTable();
      } catch (err) {
        setMsg("dbMsg", err.message || "Löschen fehlgeschlagen.");
      }
    });
  });
}

let dbFormColumns = [];

function renderDbFormFields(columns, rowData = {}) {
  const wrap = $("dbFormFields");
  if (!wrap) return;
  const items = (columns || []).filter((c) => c.name !== "__rowid");
  if (items.length === 0) {
    wrap.innerHTML = "<p class='muted'>Keine Spalten gefunden.</p>";
    return;
  }
  wrap.innerHTML = items
    .map((c) => {
      const val = rowData[c.name] == null ? "" : String(rowData[c.name]);
      return `<label class="fieldLabel">${c.name}<input data-db-col="${c.name}" type="text" value="${val.replace(/"/g, "&quot;")}" /></label>`;
    })
    .join("");
}

function collectDbFormData() {
  const out = {};
  document.querySelectorAll("[data-db-col]").forEach((el) => {
    const key = el.getAttribute("data-db-col");
    if (!key) return;
    const value = String(el.value ?? "").trim();
    out[key] = value === "" ? null : value;
  });
  return out;
}

async function loadDbFormTable() {
  const table = $("dbFormTableSelect").value;
  if (!table) return;
  const data = await api(`/api/db/${encodeURIComponent(table)}?limit=1`);
  dbFormColumns = data.columns || [];
  renderDbFormFields(dbFormColumns);
}

async function loadDbFormRecord() {
  try {
    const table = $("dbFormTableSelect").value;
    const rowid = Number($("dbFormRowIdInput").value || 0);
    if (!table) throw new Error("Bitte Tabelle wählen.");
    if (!rowid) throw new Error("Bitte Row-ID eingeben.");
    const data = await api(`/api/db/${encodeURIComponent(table)}/row/${rowid}`);
    dbFormColumns = data.columns || dbFormColumns;
    renderDbFormFields(dbFormColumns, data.row || {});
    setMsg("dbFormMsg", `Datensatz ${rowid} geladen.`, true);
  } catch (err) {
    setMsg("dbFormMsg", err.message || "Datensatz konnte nicht geladen werden.");
  }
}

async function createDbFormRecord() {
  try {
    const table = $("dbFormTableSelect").value;
    const data = collectDbFormData();
    const res = await api(`/api/db/${encodeURIComponent(table)}/row`, {
      method: "POST",
      body: JSON.stringify({ data }),
    });
    setMsg("dbFormMsg", `Eintrag erstellt (Row-ID ${res.rowid || "?"}).`, true);
    $("dbFormRowIdInput").value = String(res.rowid || "");
    await loadCurrentTable();
  } catch (err) {
    setMsg("dbFormMsg", err.message || "Eintrag erstellen fehlgeschlagen.");
  }
}

async function updateDbFormRecord() {
  try {
    const table = $("dbFormTableSelect").value;
    const rowid = Number($("dbFormRowIdInput").value || 0);
    if (!rowid) throw new Error("Bitte Row-ID eingeben.");
    const data = collectDbFormData();
    await api(`/api/db/${encodeURIComponent(table)}/row/${rowid}`, {
      method: "PATCH",
      body: JSON.stringify({ data }),
    });
    setMsg("dbFormMsg", `Eintrag ${rowid} aktualisiert.`, true);
    await loadCurrentTable();
  } catch (err) {
    setMsg("dbFormMsg", err.message || "Update fehlgeschlagen.");
  }
}

async function deleteDbFormRecord() {
  try {
    const table = $("dbFormTableSelect").value;
    const rowid = Number($("dbFormRowIdInput").value || 0);
    if (!rowid) throw new Error("Bitte Row-ID eingeben.");
    await api(`/api/db/${encodeURIComponent(table)}/row/${rowid}`, { method: "DELETE" });
    setMsg("dbFormMsg", `Eintrag ${rowid} gelöscht.`, true);
    await loadCurrentTable();
  } catch (err) {
    setMsg("dbFormMsg", err.message || "Löschen fehlgeschlagen.");
  }
}

async function loadInfo() {
  if (infoLoading) return;
  infoLoading = true;
  if (!$("infoBox").innerHTML.trim()) {
    $("infoBox").innerHTML = "<span class='muted'>Lade Informationen...</span>";
  }
  setMsg("infoMsg", "");
  try {
    await api("/api/ping");
    const [data, appMeta] = await Promise.all([
      api("/api/info"),
      api("/api/app-meta"),
    ]);
    const clientInfo = getClientDeviceInfo();
    const next = JSON.stringify({ data, appMeta, clientInfo });
    if (next !== lastInfoPayload) {
      lastInfoPayload = next;
      $("infoBox").innerHTML = renderInfo(data, appMeta, clientInfo);
    }
    setMsg("infoMsg", "");
  } catch (err) {
    $("infoBox").innerHTML = "";
    setMsg("infoMsg", `Fehler beim Laden: ${err.message || "Unbekannt"}`);
  } finally {
    infoLoading = false;
  }
}

async function loadBans() {
  const data = await api("/api/bans");
  $("bansWrap").innerHTML = renderTable(data.rows);
}

async function sendMessageTool() {
  try {
    const phone = $("msgPhone").value.trim();
    const message = $("msgText").value.trim();
    const data = await api("/api/message", {
      method: "POST",
      body: JSON.stringify({ phone, message }),
    });
    setMsg("msgToolMsg", `In Warteschlange: ${data.target}`, true);
  } catch (err) {
    setMsg("msgToolMsg", err.message || "Senden fehlgeschlagen");
  }
}

async function sendBroadcastTool() {
  try {
    const scope = $("broadcastScope").value;
    const message = $("broadcastText").value.trim();
    const data = await api("/api/broadcast", {
      method: "POST",
      body: JSON.stringify({ scope, message }),
    });
    setMsg("broadcastMsg", `Broadcast in Warteschlange (${data.scope})`, true);
  } catch (err) {
    setMsg("broadcastMsg", err.message || "Broadcast fehlgeschlagen");
  }
}

async function loadOutbox() {
  try {
    const status = $("outboxStatus").value;
    const limit = Math.max(1, Math.min(500, Number($("outboxLimit").value || 100)));
    const data = await api(`/api/outbox?status=${encodeURIComponent(status)}&limit=${limit}`);
    $("outboxWrap").innerHTML = renderTable(data.rows);
    setMsg("outboxMsg", `Einträge: ${data.rows.length}`, true);
  } catch (err) {
    setMsg("outboxMsg", err.message || "Outbox konnte nicht geladen werden");
  }
}

function renderProcStatus(data) {
  const s = data?.status || {};
  return `
    <div class="infoGrid">
      <div class="infoCard">
        <h4 class="infoTitle">${data?.processName || "-"}</h4>
        ${kvRow("Status", s.status || "-")}
        ${kvRow("PID", s.pid ?? "-")}
        ${kvRow("Restarts", s.restarts ?? "-")}
        ${kvRow("Uptime", fmtUptime(s.uptimeSec ?? 0))}
      </div>
    </div>
  `;
}

function renderLogs(data) {
  const out = stripAnsi(data?.out || "").slice(-14000).trimEnd();
  const err = stripAnsi(data?.err || "").slice(-14000).trimEnd();
  const blocks = [];

  if (out) blocks.push(`--- STDOUT ---\n${out}`);
  if (err) blocks.push(`--- STDERR ---\n${err}`);
  if (blocks.length === 0) blocks.push("Keine Logs vorhanden.");

  blocks.push(`\n--- AKTUALISIERT ---\n${new Date().toLocaleString("de-DE")}`);
  return blocks.join("\n\n");
}

async function loadProcessPanel(target, statusId, logsId, msgId) {
  if (processLoading[target]) return;
  processLoading[target] = true;
  try {
    const [status, logs] = await Promise.all([
      api(`/api/process/${target}/status`),
      api(`/api/process/${target}/logs?lines=70`),
    ]);
    const payload = JSON.stringify({ status, logs });
    if (payload !== lastProcessPayload[target]) {
      lastProcessPayload[target] = payload;
      $(statusId).innerHTML = renderProcStatus(status);
      $(logsId).textContent = renderLogs(logs);
    }
    setMsg(msgId, "Status und Logs aktualisiert.", true);
  } catch (err) {
    $(statusId).innerHTML = "";
    $(logsId).textContent = "";
    setMsg(msgId, err.message || "Status/Logs konnten nicht geladen werden");
  } finally {
    processLoading[target] = false;
  }
}

async function processAction(target, action, msgId, statusId, logsId) {
  try {
    await api(`/api/process/${target}/action`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    await loadProcessPanel(target, statusId, logsId, msgId);
    setMsg(msgId, `${target.toUpperCase()} ${action} ausgeführt.`, true);
  } catch (err) {
    setMsg(msgId, err.message || "Aktion fehlgeschlagen");
  }
}

async function loadProfile() {
  try {
    const data = await api("/api/me");
    const p = data.profile || {};
    const rawAvatar = String(p.avatarUrl || "").trim();
    const avatarUrl = rawAvatar
      ? (rawAvatar.startsWith("http://") || rawAvatar.startsWith("https://")
        ? rawAvatar
        : `${window.location.origin}${rawAvatar.startsWith("/") ? "" : "/"}${rawAvatar}`)
      : "";
    const avatarSrc = avatarUrl ? `${avatarUrl}${avatarUrl.includes("?") ? "&" : "?"}ts=${Date.now()}` : "";
    const initials = String(p.username || "Owner").slice(0, 2).toUpperCase();
    $("profileWrap").innerHTML = `
      <div class="infoGrid">
        <div class="infoCard">
          <div class="profileHeader">
            ${
              avatarSrc
                ? `<img class="profileAvatar" src="${avatarSrc}" alt="WhatsApp Avatar" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex';" /><div class="profileAvatarFallback" style="display:none">${initials}</div>`
                : `<div class="profileAvatarFallback">${initials}</div>`
            }
            <div>
              <h4 class="infoTitle">${p.username || "-"}</h4>
              <div class="muted smallHint">Profilbild + Biografie</div>
            </div>
          </div>
          ${kvRow("Chat-ID", p.chatId || "-")}
          ${kvRow("Rolle", p.role || "-")}
          ${kvRow("Levelrolle", p.levelRole || "-")}
          ${kvRow("Level", p.level ?? "-")}
          ${kvRow("XP", p.xp ?? "-")}
          ${kvRow("PHN", p.phn ?? "-")}
          ${kvRow("Wallet", p.wallet || "-")}
          ${kvRow("Erstellt", p.createdAt || "-")}
          ${kvRow("Biografie", p.bio || "Keine WhatsApp-Bio gespeichert")}
        </div>
      </div>
    `;
    const bioInput = $("profileBioInput");
    if (bioInput) bioInput.value = p.bio || "";
    setMsg("profileMsg", "Profil geladen.", true);
  } catch (err) {
    setMsg("profileMsg", err.message || "Profil konnte nicht geladen werden");
  }
}

async function saveProfileBio() {
  try {
    const bio = $("profileBioInput").value.trim();
    await api("/api/me/bio", {
      method: "POST",
      body: JSON.stringify({ bio }),
    });
    await loadProfile();
    setMsg("profileMsg", "Bio gespeichert.", true);
  } catch (err) {
    setMsg("profileMsg", err.message || "Bio konnte nicht gespeichert werden");
  }
}

async function clearProfileBio() {
  try {
    await api("/api/me/bio", {
      method: "POST",
      body: JSON.stringify({ bio: "" }),
    });
    await loadProfile();
    setMsg("profileMsg", "Bio gelöscht.", true);
  } catch (err) {
    setMsg("profileMsg", err.message || "Bio konnte nicht gelöscht werden");
  }
}

function updateInfoAutoRefresh(active) {
  if (active) {
    if (infoAutoTimer) return;
    infoAutoTimer = setInterval(() => {
      if (!token) return;
      const tab = $("tab-info");
      if (!tab || tab.classList.contains("hidden")) return;
      loadInfo().catch(() => {});
    }, 1000);
    return;
  }
  if (infoAutoTimer) {
    clearInterval(infoAutoTimer);
    infoAutoTimer = null;
  }
}

async function login() {
  try {
    const username = $("username").value.trim();
    const password = $("password").value;
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      headers: {},
    });
    token = data.token;
    localStorage.setItem("owner_token", token);
    localStorage.setItem("owner_user", data.user.username);
    $("loginCard").classList.add("hidden");
    $("appCard").classList.remove("hidden");
    showTab("db");
    await loadTables();
    await loadCurrentTable();
    updateInfoAutoRefresh(false);
    setMsg("loginMsg", "Login erfolgreich", true);
  } catch (err) {
    setMsg("loginMsg", err.message || "Login fehlgeschlagen");
  }
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST", body: JSON.stringify({}) });
  } catch {}
  token = null;
  localStorage.removeItem("owner_token");
  localStorage.removeItem("owner_user");
  updateInfoAutoRefresh(false);
  updateProcessAutoRefresh(null);
  $("appCard").classList.add("hidden");
  $("loginCard").classList.remove("hidden");
}

async function ban() {
  try {
    const phone = $("banPhone").value.trim();
    const reason = $("banReason").value.trim();
    const durationHours = Number($("banDuration").value || 0);
    const data = await api("/api/ban", {
      method: "POST",
      body: JSON.stringify({ phone, reason, durationHours }),
    });
    setMsg(
      "banMsg",
      `Gebannt: ${data.user.profile_name} (${data.user.chat_id})${data.ban.permanent ? " | permanent" : " | bis " + data.ban.expiresAt}`,
      true
    );
    await loadBans();
  } catch (err) {
    setMsg("banMsg", err.message || "Ban fehlgeschlagen");
  }
}

async function unban() {
  try {
    const phone = $("banPhone").value.trim();
    const data = await api("/api/unban", {
      method: "POST",
      body: JSON.stringify({ phone }),
    });
    setMsg("banMsg", `Entbannt: ${data.user.profile_name} (${data.user.chat_id})`, true);
    await loadBans();
  } catch (err) {
    setMsg("banMsg", err.message || "Unban fehlgeschlagen");
  }
}

function bind() {
  $("loginBtn").addEventListener("click", login);
  $("logoutBtn").addEventListener("click", logout);
  $("loadTableBtn").addEventListener("click", loadCurrentTable);
  $("dbSearchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadCurrentTable().catch(() => {});
  });
  $("dbFormTableSelect").addEventListener("change", () => loadDbFormTable().catch(() => {}));
  $("dbFormLoadBtn").addEventListener("click", loadDbFormRecord);
  $("dbFormCreateBtn").addEventListener("click", createDbFormRecord);
  $("dbFormUpdateBtn").addEventListener("click", updateDbFormRecord);
  $("dbFormDeleteBtn").addEventListener("click", deleteDbFormRecord);
  $("banBtn").addEventListener("click", ban);
  $("unbanBtn").addEventListener("click", unban);
  $("loadBansBtn").addEventListener("click", loadBans);
  $("sendMsgBtn").addEventListener("click", sendMessageTool);
  $("sendBroadcastBtn").addEventListener("click", sendBroadcastTool);
  $("loadOutboxBtn").addEventListener("click", loadOutbox);
  $("botRefreshBtn").addEventListener("click", () => loadProcessPanel("bot", "botStatusWrap", "botLogsWrap", "botCtlMsg"));
  $("appRefreshBtn").addEventListener("click", () => loadProcessPanel("app", "appStatusWrap", "appLogsWrap", "appCtlMsg"));
  $("botStartBtn").addEventListener("click", () => processAction("bot", "start", "botCtlMsg", "botStatusWrap", "botLogsWrap"));
  $("botStopBtn").addEventListener("click", () => processAction("bot", "stop", "botCtlMsg", "botStatusWrap", "botLogsWrap"));
  $("botRestartBtn").addEventListener("click", () => processAction("bot", "restart", "botCtlMsg", "botStatusWrap", "botLogsWrap"));
  $("appStartBtn").addEventListener("click", () => processAction("app", "start", "appCtlMsg", "appStatusWrap", "appLogsWrap"));
  $("appStopBtn").addEventListener("click", () => processAction("app", "stop", "appCtlMsg", "appStatusWrap", "appLogsWrap"));
  $("appRestartBtn").addEventListener("click", () => processAction("app", "restart", "appCtlMsg", "appStatusWrap", "appLogsWrap"));
  $("profileRefreshBtn").addEventListener("click", loadProfile);
  $("profileBioSaveBtn").addEventListener("click", saveProfileBio);
  $("profileBioClearBtn").addEventListener("click", clearProfileBio);
  $("menuToggle")?.addEventListener("click", () => setMenuOpen(true));
  $("menuClose")?.addEventListener("click", () => setMenuOpen(false));
  $("menuBackdrop")?.addEventListener("click", () => setMenuOpen(false));

  document.querySelectorAll(".menu button[data-tab]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tab = btn.getAttribute("data-tab");
      showTab(tab);
      closeMenuOnMobile();
      if (tab === "db") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        await loadTables();
        await loadCurrentTable();
      }
      if (tab === "dbform") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        await loadTables();
        await loadDbFormTable();
      }
      if (tab === "ban") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        await loadBans();
      }
      if (tab === "msg" || tab === "broadcast") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
      }
      if (tab === "outbox") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        await loadOutbox();
      }
      if (tab === "botctl") {
        updateInfoAutoRefresh(false);
        await loadProcessPanel("bot", "botStatusWrap", "botLogsWrap", "botCtlMsg");
        updateProcessAutoRefresh("bot");
      }
      if (tab === "appctl") {
        updateInfoAutoRefresh(false);
        await loadProcessPanel("app", "appStatusWrap", "appLogsWrap", "appCtlMsg");
        updateProcessAutoRefresh("app");
      }
      if (tab === "profile") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        await loadProfile();
      }
      if (tab === "info") {
        updateProcessAutoRefresh(null);
        await loadInfo();
        updateInfoAutoRefresh(true);
      }
    });
  });
}

async function boot() {
  bind();
  token = localStorage.getItem("owner_token");
  if (!token) return;
  try {
    await api("/api/info");
    $("loginCard").classList.add("hidden");
    $("appCard").classList.remove("hidden");
    showTab("db");
    await loadTables();
    await loadCurrentTable();
    updateInfoAutoRefresh(false);
    updateProcessAutoRefresh(null);
    setMenuOpen(false);
  } catch {
    await logout();
  }
}

boot();
