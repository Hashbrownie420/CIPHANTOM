let token = null;
let infoAutoTimer = null;
let processAutoTimer = null;
const TABS = ["db", "dbform", "ban", "secaccess", "secwatch", "seclockdown", "secaudit", "msg", "broadcast", "outbox", "dbinsight", "dbexport", "botctl", "botcomposer", "botlookup", "botstats", "appctl", "admin", "profile", "info", "forge"];
let infoLoading = false;
const processLoading = { bot: false, app: false };
let lastInfoPayload = "";
const lastProcessPayload = { bot: "", app: "" };
let currentDbRows = [];
let forgeRunId = 0;
let dbExportRowsCache = [];
const BOT_TEMPLATES_KEY = "owner_bot_templates_v1";

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
    const isActive = btn.getAttribute("data-tab") === name;
    btn.classList.toggle("active", isActive);
    if (isActive) {
      const group = btn.closest("details");
      if (group) group.open = true;
    }
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
  setMenuOpen(false);
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
}

function formatCellValue(value) {
  if (value == null) return "-";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "-";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  const text = String(value).trim();
  const maybeDate = Date.parse(text);
  if (!Number.isNaN(maybeDate) && /^\d{4}-\d{2}-\d{2}T/.test(text)) {
    return new Date(maybeDate).toLocaleString("de-DE");
  }
  return text || "-";
}

function renderTable(rows) {
  if (!rows || rows.length === 0) return "<p style='padding:8px'>Keine Daten</p>";
  const keys = Object.keys(rows[0]);
  const th = ["#", ...keys].map((k) => `<th>${escapeHtml(k)}</th>`).join("");
  const body = rows
    .map((r, idx) => {
      const rowNo = idx + 1;
      const cells = keys.map((k) => {
        const fullText = formatCellValue(r[k]);
        const clipped = fullText.length > 120 ? `${fullText.slice(0, 117)}...` : fullText;
        const cellClass = /(^id$|_id$|chat_id|jid|phone|wallet|hash|token)/i.test(k) ? "cellMono" : "";
        return `<td class="${cellClass}" data-label="${escapeHtml(k)}" title="${escapeHtml(fullText)}">${escapeHtml(clipped)}</td>`;
      });
      return `<tr><td data-label="#" class="cellIdx">${rowNo}</td>${cells.join("")}</tr>`;
    })
    .join("");
  return `
    <div class="tableMeta">${rows.length} Einträge · ${keys.length} Spalten</div>
    <table class="respTable">
      <thead><tr>${th}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
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
          const titleValue = titleKey ? formatCellValue(r[titleKey]) : "";
          const body = keys
            .filter((k) => k !== "__rowid")
            .map((k) => `<div class="dbCardKv"><span>${escapeHtml(k)}</span><strong>${escapeHtml(formatCellValue(r[k]))}</strong></div>`)
            .join("");
          return `
            <article class="dbCard">
              <div class="dbCardHead">
                <span>${escapeHtml(titleValue || "Datensatz")}</span>
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
  return `<div class="kv"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(formatCellValue(v))}</span></div>`;
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

const FORGE_PRESETS = {
  heal_app: {
    name: "App-Heilung",
    steps: [
      { type: "request", method: "GET", url: "/api/healthz", expectStatus: 200, label: "Healthcheck 1" },
      { type: "process_action", target: "app", action: "restart", label: "App neustarten" },
      { type: "delay", ms: 7000, label: "Wartezeit 7s" },
      { type: "request", method: "GET", url: "/api/healthz", expectStatus: 200, label: "Healthcheck 2" },
      { type: "request", method: "GET", url: "/api/app-meta", expectStatus: 200, label: "App-Meta prüfen" },
    ],
  },
  full_smoke: {
    name: "System-Smoketest",
    steps: [
      { type: "request", method: "GET", url: "/api/info", expectStatus: 200, label: "Info-API" },
      { type: "request", method: "GET", url: "/api/process/bot/status", expectStatus: 200, label: "Bot Status" },
      { type: "request", method: "GET", url: "/api/process/app/status", expectStatus: 200, label: "App Status" },
      { type: "request", method: "GET", url: "/api/app-meta", expectStatus: 200, label: "App-Meta" },
      { type: "request", method: "GET", url: "/downloads/latest.apk", expectStatus: 200, label: "APK Download" },
    ],
  },
  safe_reboot: {
    name: "Sicherer Neustart",
    steps: [
      { type: "process_action", target: "bot", action: "restart", label: "Bot neustarten" },
      { type: "process_action", target: "app", action: "restart", label: "App neustarten" },
      { type: "delay", ms: 5000, label: "Wartezeit 5s" },
      { type: "request", method: "GET", url: "/api/process/bot/status", expectStatus: 200, label: "Bot prüfen" },
      { type: "request", method: "GET", url: "/api/process/app/status", expectStatus: 200, label: "App prüfen" },
      { type: "request", method: "GET", url: "/api/healthz", expectStatus: 200, label: "Healthcheck" },
    ],
  },
};

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
  const options = data.tables.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
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

function fmtPercent(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "-";
  return `${n.toFixed(1)}%`;
}

async function loadDbInsights() {
  try {
    const sample = Math.max(10, Math.min(500, Number($("dbInsightSampleInput").value || 150)));
    const maxTables = Math.max(1, Math.min(100, Number($("dbInsightTablesInput").value || 20)));
    setMsg("dbInsightMsg", "Analysiere Tabellen...");
    const t = await api("/api/db/tables");
    const tables = (t.tables || []).slice(0, maxTables);
    const rows = [];
    for (const table of tables) {
      const d = await api(`/api/db/${encodeURIComponent(table)}?limit=${sample}&offset=0`);
      const cols = Array.isArray(d.columns) ? d.columns.map((c) => c.name) : [];
      const items = Array.isArray(d.rows) ? d.rows : [];
      let total = 0;
      let filled = 0;
      let longest = 0;
      for (const r of items) {
        for (const c of cols) {
          total += 1;
          const v = r[c];
          const s = String(v ?? "").trim();
          if (s !== "") {
            filled += 1;
            if (s.length > longest) longest = s.length;
          }
        }
      }
      const completeness = total ? (filled / total) * 100 : 100;
      rows.push({
        tabelle: table,
        spalten: cols.length,
        sample_zeilen: items.length,
        komplettheit: fmtPercent(completeness),
        laengster_wert: longest,
      });
    }
    const avgComp = rows.length
      ? rows.reduce((a, r) => a + Number(String(r.komplettheit).replace("%", "")), 0) / rows.length
      : 0;
    const totalCols = rows.reduce((a, r) => a + Number(r.spalten || 0), 0);
    $("dbInsightCardsWrap").innerHTML = `
      <div class="infoGrid">
        <div class="infoCard">${kvRow("Analysierte Tabellen", rows.length)}</div>
        <div class="infoCard">${kvRow("Spalten gesamt", totalCols)}</div>
        <div class="infoCard">${kvRow("Ø Vollständigkeit", fmtPercent(avgComp))}</div>
        <div class="infoCard">${kvRow("Sample/Tabelle", sample)}</div>
      </div>
    `;
    $("dbInsightTableWrap").innerHTML = renderTable(rows);
    setMsg("dbInsightMsg", "Schema-Radar abgeschlossen.", true);
  } catch (err) {
    $("dbInsightCardsWrap").innerHTML = "";
    $("dbInsightTableWrap").innerHTML = "";
    setMsg("dbInsightMsg", err.message || "Schema-Radar fehlgeschlagen.");
  }
}

async function ensureDbExportTablesLoaded() {
  const sel = $("dbExportTableSelect");
  if (!sel) return;
  if (sel.options.length > 0) return;
  const t = await api("/api/db/tables");
  sel.innerHTML = (t.tables || []).map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
}

function rowsToCsv(rows) {
  const data = Array.isArray(rows) ? rows : [];
  if (!data.length) return "";
  const keys = Object.keys(data[0]);
  const esc = (v) => {
    const s = String(v ?? "");
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const head = keys.map(esc).join(",");
  const body = data.map((r) => keys.map((k) => esc(formatCellValue(r[k]))).join(",")).join("\n");
  return `${head}\n${body}`;
}

function rowsToExcelHtml(rows, title = "Export") {
  const data = Array.isArray(rows) ? rows : [];
  if (!data.length) {
    return `<!doctype html><html><head><meta charset="utf-8"></head><body><table><tr><td>Keine Daten</td></tr></table></body></html>`;
  }
  const keys = Object.keys(data[0]);
  const head = keys.map((k) => `<th>${escapeHtml(k)}</th>`).join("");
  const body = data
    .map((r) => `<tr>${keys.map((k) => `<td>${escapeHtml(formatCellValue(r[k]))}</td>`).join("")}</tr>`)
    .join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <table border="1">
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>
</body>
</html>`;
}

async function fetchTableRowsForExport(table, maxRows) {
  const safeMax = Math.max(1, Math.min(5000, Number(maxRows || 1500)));
  const page = 500;
  const out = [];
  let offset = 0;
  while (out.length < safeMax) {
    const d = await api(`/api/db/${encodeURIComponent(table)}?limit=${page}&offset=${offset}`);
    const items = Array.isArray(d.rows) ? d.rows : [];
    out.push(...items);
    if (items.length < page) break;
    offset += page;
  }
  return out.slice(0, safeMax);
}

function triggerDownload(fileName, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function previewDbExport() {
  try {
    await ensureDbExportTablesLoaded();
    const table = $("dbExportTableSelect").value;
    const format = $("dbExportFormatSelect").value;
    const maxRows = Number($("dbExportMaxRowsInput").value || 1500);
    if (!table) throw new Error("Bitte Tabelle wählen.");
    setMsg("dbExportMsg", "Export-Vorschau wird erstellt...");
    const rows = await fetchTableRowsForExport(table, maxRows);
    dbExportRowsCache = rows;
    const raw = format === "csv"
      ? rowsToCsv(rows)
      : format === "excel"
        ? rowsToCsv(rows)
        : JSON.stringify(rows, null, 2);
    $("dbExportPreviewWrap").textContent = raw.slice(0, 25000) + (raw.length > 25000 ? "\n... (gekürzt)" : "");
    $("dbExportMetaWrap").innerHTML = `
      ${kvRow("Tabelle", table)}
      ${kvRow("Format", format === "excel" ? "EXCEL (.XLS)" : format.toUpperCase())}
      ${kvRow("Zeilen", rows.length)}
      ${kvRow("Zeichen", raw.length)}
    `;
    setMsg("dbExportMsg", "Vorschau bereit.", true);
  } catch (err) {
    $("dbExportPreviewWrap").textContent = "";
    $("dbExportMetaWrap").innerHTML = "";
    setMsg("dbExportMsg", err.message || "Vorschau fehlgeschlagen.");
  }
}

async function downloadDbExport() {
  try {
    await ensureDbExportTablesLoaded();
    const table = $("dbExportTableSelect").value;
    const format = $("dbExportFormatSelect").value;
    const maxRows = Number($("dbExportMaxRowsInput").value || 1500);
    if (!table) throw new Error("Bitte Tabelle wählen.");
    const rows = dbExportRowsCache.length ? dbExportRowsCache : await fetchTableRowsForExport(table, maxRows);
    const now = new Date().toISOString().replace(/[:.]/g, "-");
    if (format === "csv") {
      const csv = rowsToCsv(rows);
      triggerDownload(`${table}-${now}.csv`, csv, "text/csv;charset=utf-8");
    } else if (format === "excel") {
      const xlsHtml = rowsToExcelHtml(rows, table);
      triggerDownload(`${table}-${now}.xls`, xlsHtml, "application/vnd.ms-excel;charset=utf-8");
    } else {
      const jsonText = JSON.stringify(rows, null, 2);
      triggerDownload(`${table}-${now}.json`, jsonText, "application/json;charset=utf-8");
    }
    setMsg("dbExportMsg", "Export heruntergeladen.", true);
  } catch (err) {
    setMsg("dbExportMsg", err.message || "Download fehlgeschlagen.");
  }
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
      return `<label class="fieldLabel">${escapeHtml(c.name)}<input data-db-col="${escapeHtml(c.name)}" type="text" value="${escapeHtml(val)}" /></label>`;
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

function readBotTemplates() {
  try {
    const raw = localStorage.getItem(BOT_TEMPLATES_KEY);
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeBotTemplates(rows) {
  localStorage.setItem(BOT_TEMPLATES_KEY, JSON.stringify(rows || []));
}

function refreshBotTemplateSelect() {
  const rows = readBotTemplates();
  const sel = $("botTplSelect");
  if (!sel) return;
  sel.innerHTML = rows
    .map((r, i) => `<option value="${i}">${escapeHtml(r.name || `Vorlage ${i + 1}`)}</option>`)
    .join("");
}

function saveBotTemplate() {
  const name = $("botTplNameInput").value.trim();
  const text = $("botTplTextInput").value.trim();
  const scope = $("botTplScopeSelect").value;
  if (!name || !text) {
    setMsg("botComposerMsg", "Name und Text sind erforderlich.");
    return;
  }
  const rows = readBotTemplates();
  const idx = rows.findIndex((r) => String(r.name || "").toLowerCase() === name.toLowerCase());
  const item = { name, text, scope, updatedAt: new Date().toISOString() };
  if (idx >= 0) rows[idx] = item;
  else rows.unshift(item);
  writeBotTemplates(rows.slice(0, 50));
  refreshBotTemplateSelect();
  setMsg("botComposerMsg", `Vorlage gespeichert: ${name}`, true);
}

function loadBotTemplate() {
  const rows = readBotTemplates();
  const idx = Number($("botTplSelect").value || -1);
  if (!Number.isFinite(idx) || idx < 0 || idx >= rows.length) {
    setMsg("botComposerMsg", "Bitte Vorlage auswählen.");
    return;
  }
  const row = rows[idx];
  $("botTplNameInput").value = row.name || "";
  $("botTplTextInput").value = row.text || "";
  $("botTplScopeSelect").value = row.scope || "users";
  setMsg("botComposerMsg", `Vorlage geladen: ${row.name || "-"}`, true);
}

function deleteBotTemplate() {
  const rows = readBotTemplates();
  const idx = Number($("botTplSelect").value || -1);
  if (!Number.isFinite(idx) || idx < 0 || idx >= rows.length) {
    setMsg("botComposerMsg", "Bitte Vorlage auswählen.");
    return;
  }
  const [removed] = rows.splice(idx, 1);
  writeBotTemplates(rows);
  refreshBotTemplateSelect();
  setMsg("botComposerMsg", `Vorlage gelöscht: ${removed?.name || "-"}`, true);
}

async function sendBotTemplate() {
  try {
    const scope = $("botTplScopeSelect").value;
    const message = $("botTplTextInput").value.trim();
    if (!message) throw new Error("Bitte Vorlagentext eingeben.");
    const data = await api("/api/broadcast", {
      method: "POST",
      body: JSON.stringify({ scope, message }),
    });
    setMsg("botComposerMsg", `Vorlage gesendet (${data.scope})`, true);
  } catch (err) {
    setMsg("botComposerMsg", err.message || "Senden fehlgeschlagen");
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

function normalizePhoneLocal(v) {
  return String(v || "").replace(/[^0-9]/g, "");
}

async function loadBotLookup() {
  try {
    const phone = normalizePhoneLocal($("botLookupPhoneInput").value);
    if (!phone) throw new Error("Bitte gültige Nummer eingeben.");
    setMsg("botLookupMsg", "Prüfung läuft...");
    const [usersRes, bansRes, outboxRes] = await Promise.all([
      api(`/api/db/users?limit=500&q=${encodeURIComponent(phone)}`),
      api("/api/bans"),
      api("/api/outbox?status=all&limit=300"),
    ]);

    const users = Array.isArray(usersRes.rows) ? usersRes.rows : [];
    const user = users.find((u) => String(u.chat_id || "").includes(phone)) || null;
    const bans = Array.isArray(bansRes.rows) ? bansRes.rows : [];
    const ban = bans.find((b) => String(b.chat_id || "").includes(phone)) || null;
    const outboxRows = Array.isArray(outboxRes.rows) ? outboxRes.rows : [];
    const history = outboxRows.filter((r) => Object.values(r).some((v) => String(v || "").includes(phone)));

    const sent = history.filter((r) => String(r.status || "").toLowerCase() === "sent").length;
    const failed = history.filter((r) => String(r.status || "").toLowerCase() === "failed").length;
    const pending = history.filter((r) => String(r.status || "").toLowerCase() === "pending").length;

    $("botLookupStatsWrap").innerHTML = `
      <div class="infoGrid">
        <div class="infoCard">${kvRow("Nummer", phone)}</div>
        <div class="infoCard">${kvRow("User gefunden", user ? "ja" : "nein")}</div>
        <div class="infoCard">${kvRow("Chat-ID", user?.chat_id || "-")}</div>
        <div class="infoCard">${kvRow("Profilname", user?.profile_name || "-")}</div>
        <div class="infoCard">${kvRow("Gebannt", ban ? "ja" : "nein")}</div>
        <div class="infoCard">${kvRow("Ban bis", ban?.expires_at || (ban ? "permanent" : "-"))}</div>
        <div class="infoCard">${kvRow("Outbox gesendet", sent)}</div>
        <div class="infoCard">${kvRow("Outbox pending", pending)}</div>
        <div class="infoCard">${kvRow("Outbox failed", failed)}</div>
      </div>
    `;

    const histText = history
      .slice(-30)
      .map((r, i) => {
        const ts = r.updated_at || r.created_at || r.ts || "-";
        const st = r.status || "-";
        const snippet = String(r.text || r.message || r.payload || "").slice(0, 120);
        return `${i + 1}. [${st}] ${ts} ${snippet}`;
      })
      .join("\n");
    $("botLookupHistoryWrap").textContent = histText || "Keine passenden Outbox-Einträge gefunden.";
    setMsg("botLookupMsg", "Empfänger-Check abgeschlossen.", true);
  } catch (err) {
    $("botLookupStatsWrap").innerHTML = "";
    $("botLookupHistoryWrap").textContent = "";
    setMsg("botLookupMsg", err.message || "Empfänger-Check fehlgeschlagen.");
  }
}

function parseTs(ts) {
  const v = Date.parse(String(ts || ""));
  return Number.isFinite(v) ? v : NaN;
}

function withinHours(ts, hours) {
  const t = parseTs(ts);
  if (!Number.isFinite(t)) return false;
  return t >= Date.now() - Math.max(1, Number(hours || 24)) * 60 * 60 * 1000;
}

function isoWeekBucket(ts) {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function getAuditChatId(row) {
  try {
    const payload = JSON.parse(String(row?.payload || "{}"));
    return String(payload?.chatId || "").trim();
  } catch {
    return "";
  }
}

async function loadBotStats() {
  try {
    const weeks = Math.max(2, Math.min(24, Number($("botStatsWeeksInput").value || 8)));
    setMsg("botStatsMsg", "Statistiken werden berechnet...");
    const [users, knownChats, audit, outbox, bans, errors] = await Promise.all([
      fetchTableRowsForExport("users", 5000),
      fetchTableRowsForExport("known_chats", 10000),
      fetchTableRowsForExport("owner_audit_logs", 20000),
      fetchTableRowsForExport("owner_outbox", 20000),
      fetchTableRowsForExport("bans", 5000),
      fetchTableRowsForExport("error_logs", 5000),
    ]);

    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const since = now - weeks * weekMs;

    const chats = Array.isArray(knownChats) ? knownChats : [];
    const groups = chats.filter((c) => Number(c.is_group || 0) === 1).length;
    const privates = chats.filter((c) => Number(c.is_group || 0) !== 1).length;

    const commands = (Array.isArray(audit) ? audit : []).filter((r) => {
      const cmd = String(r.command || "");
      return !/^process_action|set_|job_|admin_op|server_restart|process_action_all/.test(cmd);
    });
    const commands7d = commands.filter((r) => {
      const ts = parseTs(r.created_at);
      return Number.isFinite(ts) && ts >= now - weekMs;
    });
    const commandsToday = commands.filter((r) => {
      const ts = parseTs(r.created_at);
      if (!Number.isFinite(ts)) return false;
      const d = new Date(ts);
      const n = new Date(now);
      return d.getUTCFullYear() === n.getUTCFullYear() && d.getUTCMonth() === n.getUTCMonth() && d.getUTCDate() === n.getUTCDate();
    });
    const cmdTodayPrivate = commandsToday.filter((r) => {
      const chatId = getAuditChatId(r);
      return chatId && !chatId.includes("@g.us");
    }).length;
    const cmdTodayGroups = commandsToday.filter((r) => {
      const chatId = getAuditChatId(r);
      return chatId.includes("@g.us");
    }).length;
    const cmdTodayUnknown = commandsToday.length - cmdTodayPrivate - cmdTodayGroups;
    const cmdCountMap = {};
    commands7d.forEach((r) => {
      const cmd = String(r.command || "unknown");
      cmdCountMap[cmd] = (cmdCountMap[cmd] || 0) + 1;
    });
    const topCmdRows = Object.entries(cmdCountMap)
      .map(([cmd, count]) => ({ befehl: cmd, aufrufe: count }))
      .sort((a, b) => b.aufrufe - a.aufrufe)
      .slice(0, 15);

    const weeklyMap = {};
    for (const r of commands) {
      const ts = parseTs(r.created_at);
      if (!Number.isFinite(ts) || ts < since) continue;
      const w = isoWeekBucket(ts);
      if (!weeklyMap[w]) weeklyMap[w] = { woche_start: w, befehle: 0, outbox_sent: 0, outbox_failed: 0, neue_user: 0 };
      weeklyMap[w].befehle += 1;
    }
    const outboxRowsAll = Array.isArray(outbox) ? outbox : [];
    for (const r of outboxRowsAll) {
      const ts = parseTs(r.created_at || r.processed_at);
      if (!Number.isFinite(ts) || ts < since) continue;
      const w = isoWeekBucket(ts);
      if (!weeklyMap[w]) weeklyMap[w] = { woche_start: w, befehle: 0, outbox_sent: 0, outbox_failed: 0, neue_user: 0 };
      const st = String(r.status || "").toLowerCase();
      if (st === "sent") weeklyMap[w].outbox_sent += 1;
      if (st === "failed") weeklyMap[w].outbox_failed += 1;
    }
    const usersAll = Array.isArray(users) ? users : [];
    for (const u of usersAll) {
      const ts = parseTs(u.created_at);
      if (!Number.isFinite(ts) || ts < since) continue;
      const w = isoWeekBucket(ts);
      if (!weeklyMap[w]) weeklyMap[w] = { woche_start: w, befehle: 0, outbox_sent: 0, outbox_failed: 0, neue_user: 0 };
      weeklyMap[w].neue_user += 1;
    }
    const weeklyRows = Object.values(weeklyMap).sort((a, b) => a.woche_start.localeCompare(b.woche_start));

    const usersToday = usersAll.filter((u) => {
      const ts = parseTs(u.created_at);
      if (!Number.isFinite(ts)) return false;
      const d = new Date(ts);
      const n = new Date(now);
      return d.getUTCFullYear() === n.getUTCFullYear() && d.getUTCMonth() === n.getUTCMonth() && d.getUTCDate() === n.getUTCDate();
    }).length;
    const users7d = usersAll.filter((u) => {
      const ts = parseTs(u.created_at);
      return Number.isFinite(ts) && ts >= now - weekMs;
    }).length;
    const chats24h = chats.filter((c) => {
      const ts = parseTs(c.last_seen_at);
      return Number.isFinite(ts) && ts >= now - 24 * 60 * 60 * 1000;
    });
    const groups24h = chats24h.filter((c) => Number(c.is_group || 0) === 1).length;
    const privates24h = chats24h.length - groups24h;
    const outbox7d = outboxRowsAll.filter((r) => {
      const ts = parseTs(r.created_at || r.processed_at);
      return Number.isFinite(ts) && ts >= now - weekMs;
    });
    const outbox7dSent = outbox7d.filter((r) => String(r.status || "").toLowerCase() === "sent").length;
    const outbox7dFailed = outbox7d.filter((r) => String(r.status || "").toLowerCase() === "failed").length;
    const avgCommandsPerDay7d = Math.round((commands7d.length / 7) * 10) / 10;
    const topCmd = topCmdRows[0]?.befehl || "-";

    $("botStatsCardsWrap").innerHTML = `
      <div class="infoGrid">
        <div class="infoCard">${kvRow("Registrierte User", usersAll.length)}</div>
        <div class="infoCard">${kvRow("Bekannte Chats", chats.length)}</div>
        <div class="infoCard">${kvRow("Privat-Chats", privates)}</div>
        <div class="infoCard">${kvRow("Gruppen-Chats", groups)}</div>
        <div class="infoCard">${kvRow("Aktive Bans", (Array.isArray(bans) ? bans : []).length)}</div>
        <div class="infoCard">${kvRow("Fehler-Logs", (Array.isArray(errors) ? errors : []).length)}</div>
        <div class="infoCard">${kvRow("Befehle heute", commandsToday.length)}</div>
        <div class="infoCard">${kvRow("Befehle heute (Privat)", cmdTodayPrivate)}</div>
        <div class="infoCard">${kvRow("Befehle heute (Gruppe)", cmdTodayGroups)}</div>
        <div class="infoCard">${kvRow("Befehle heute (Unbekannt)", cmdTodayUnknown)}</div>
        <div class="infoCard">${kvRow("Befehle (7 Tage)", commands7d.length)}</div>
        <div class="infoCard">${kvRow("Ø Befehle/Tag (7 Tage)", avgCommandsPerDay7d)}</div>
        <div class="infoCard">${kvRow("Top-Befehl (7 Tage)", topCmd)}</div>
        <div class="infoCard">${kvRow("Neuregistrierungen heute", usersToday)}</div>
        <div class="infoCard">${kvRow("Neuregistrierungen 7 Tage", users7d)}</div>
        <div class="infoCard">${kvRow("Chats aktiv (24h)", chats24h.length)}</div>
        <div class="infoCard">${kvRow("Privat aktiv (24h)", privates24h)}</div>
        <div class="infoCard">${kvRow("Gruppen aktiv (24h)", groups24h)}</div>
        <div class="infoCard">${kvRow("Outbox gesamt", outboxRowsAll.length)}</div>
        <div class="infoCard">${kvRow("Outbox sent (7 Tage)", outbox7dSent)}</div>
        <div class="infoCard">${kvRow("Outbox failed (7 Tage)", outbox7dFailed)}</div>
      </div>
    `;
    $("botStatsTopCmdWrap").innerHTML = renderTable(topCmdRows);
    $("botStatsWeeklyWrap").innerHTML = renderTable(weeklyRows);
    setMsg("botStatsMsg", "Bot-Statistiken aktualisiert.", true);
  } catch (err) {
    $("botStatsCardsWrap").innerHTML = "";
    $("botStatsTopCmdWrap").innerHTML = "";
    $("botStatsWeeklyWrap").innerHTML = "";
    setMsg("botStatsMsg", err.message || "Statistik konnte nicht geladen werden.");
  }
}

function collectRiskyCommandStats(rows, hours = 24) {
  const risky = new Set([
    "ban", "purge", "ownerpass", "set_user_role", "process_action_all", "server_restart",
    "deploy_now", "apk_build_debug", "pm2_resurrect", "pm2_save",
  ]);
  const byActor = {};
  (rows || []).forEach((r) => {
    if (!withinHours(r.created_at, hours)) return;
    const cmd = String(r.command || "").trim();
    if (!risky.has(cmd)) return;
    const actor = String(r.actor_id || "unknown");
    if (!byActor[actor]) byActor[actor] = { actor_id: actor, risky_cmds: 0, letzter_befehl: cmd };
    byActor[actor].risky_cmds += 1;
    byActor[actor].letzter_befehl = cmd;
  });
  return Object.values(byActor).sort((a, b) => b.risky_cmds - a.risky_cmds).slice(0, 20);
}

async function loadSecurityAccess() {
  try {
    setMsg("secAccessMsg", "Rechte-Check wird geladen...");
    const [alertsRes, summaryRes, flagsRes, users, bans, errors, audit] = await Promise.all([
      api("/api/admin/alerts"),
      api("/api/admin/summary"),
      api("/api/admin/flags"),
      fetchTableRowsForExport("users", 5000),
      fetchTableRowsForExport("bans", 5000),
      fetchTableRowsForExport("error_logs", 5000),
      fetchTableRowsForExport("owner_audit_logs", 20000),
    ]);
    const alerts = Array.isArray(alertsRes.alerts) ? alertsRes.alerts : [];
    const criticalAlerts = alerts.filter((a) => String(a.level || "").toLowerCase() === "critical").length;
    const warningAlerts = alerts.filter((a) => String(a.level || "").toLowerCase() === "warning").length;
    const roleRows = Array.isArray(users) ? users : [];
    const owners = roleRows.filter((u) => String(u.user_role || "").toLowerCase() === "owner").length;
    const admins = roleRows.filter((u) => String(u.user_role || "").toLowerCase() === "admin").length;
    const usersOnly = roleRows.filter((u) => String(u.user_role || "").toLowerCase() === "user").length;
    const errors24h = (Array.isArray(errors) ? errors : []).filter((e) => withinHours(e.last_seen_at || e.created_at, 24)).length;
    const riskyRows = collectRiskyCommandStats(Array.isArray(audit) ? audit : [], 24);
    const process = summaryRes?.processes || {};
    const flags = flagsRes?.flags || {};

    $("secAccessCardsWrap").innerHTML = `
      <div class="infoGrid">
        <div class="infoCard">${kvRow("Alerts kritisch", criticalAlerts)}</div>
        <div class="infoCard">${kvRow("Alerts Warnung", warningAlerts)}</div>
        <div class="infoCard">${kvRow("Owner", owners)}</div>
        <div class="infoCard">${kvRow("Admins", admins)}</div>
        <div class="infoCard">${kvRow("User", usersOnly)}</div>
        <div class="infoCard">${kvRow("Aktive Bans", (Array.isArray(bans) ? bans : []).length)}</div>
        <div class="infoCard">${kvRow("Fehler (24h)", errors24h)}</div>
        <div class="infoCard">${kvRow("Bot Status", process?.bot?.status || "-")}</div>
        <div class="infoCard">${kvRow("App Status", process?.app?.status || "-")}</div>
        <div class="infoCard">${kvRow("Deploy erlaubt", flags.deployEnabled ? "ja" : "nein")}</div>
        <div class="infoCard">${kvRow("APK-Build erlaubt", flags.apkBuildEnabled ? "ja" : "nein")}</div>
        <div class="infoCard">${kvRow("Server-Reboot erlaubt", flags.rebootEnabled ? "ja" : "nein")}</div>
      </div>
    `;
    $("secAccessActorsWrap").innerHTML = renderTable(riskyRows);
    setMsg("secAccessMsg", "Rechte-Check geladen.", true);
  } catch (err) {
    $("secAccessCardsWrap").innerHTML = "";
    $("secAccessActorsWrap").innerHTML = "";
    setMsg("secAccessMsg", err.message || "Rechte-Check fehlgeschlagen.");
  }
}

async function loadSecurityWatch() {
  try {
    const hours = Math.max(1, Math.min(72, Number($("secWatchHoursInput").value || 24)));
    const burstThreshold = Math.max(5, Math.min(200, Number($("secWatchBurstInput").value || 25)));
    setMsg("secWatchMsg", "Anomalie-Check läuft...");
    const [audit, errors, outbox] = await Promise.all([
      fetchTableRowsForExport("owner_audit_logs", 30000),
      fetchTableRowsForExport("error_logs", 10000),
      fetchTableRowsForExport("owner_outbox", 20000),
    ]);
    const anomalies = [];
    const cmdRows = (Array.isArray(audit) ? audit : []).filter((r) => withinHours(r.created_at, hours));
    const burstByActorHour = {};
    for (const r of cmdRows) {
      const actor = String(r.actor_id || "unknown");
      const ts = parseTs(r.created_at);
      if (!Number.isFinite(ts)) continue;
      const d = new Date(ts);
      const hourBucket = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()} ${d.getUTCHours()}:00`;
      const key = `${actor}|${hourBucket}`;
      burstByActorHour[key] = (burstByActorHour[key] || 0) + 1;
    }
    Object.entries(burstByActorHour).forEach(([k, count]) => {
      if (count < burstThreshold) return;
      const [actor, hour] = k.split("|");
      anomalies.push({
        typ: "Command-Burst",
        schwere: count >= burstThreshold * 2 ? "hoch" : "mittel",
        detail: `${actor} mit ${count} Befehlen in 1h`,
        zeitfenster: hour,
      });
    });
    const errRows = (Array.isArray(errors) ? errors : []).filter((r) => withinHours(r.last_seen_at || r.created_at, hours));
    if (errRows.length >= 20) {
      anomalies.push({
        typ: "Fehler-Spike",
        schwere: errRows.length >= 50 ? "hoch" : "mittel",
        detail: `${errRows.length} Fehler-Logs im Fenster`,
        zeitfenster: `${hours}h`,
      });
    }
    const failedOutbox = (Array.isArray(outbox) ? outbox : []).filter((r) => withinHours(r.created_at || r.processed_at, hours) && String(r.status || "").toLowerCase() === "failed");
    if (failedOutbox.length >= 10) {
      anomalies.push({
        typ: "Outbox-Fail-Welle",
        schwere: failedOutbox.length >= 30 ? "hoch" : "mittel",
        detail: `${failedOutbox.length} fehlgeschlagene Outbox-Einträge`,
        zeitfenster: `${hours}h`,
      });
    }
    if (!anomalies.length) {
      anomalies.push({
        typ: "Status",
        schwere: "ok",
        detail: "Keine kritischen Auffälligkeiten erkannt",
        zeitfenster: `${hours}h`,
      });
    }
    $("secWatchTableWrap").innerHTML = renderTable(anomalies);
    setMsg("secWatchMsg", "Anomalie-Check abgeschlossen.", true);
  } catch (err) {
    $("secWatchTableWrap").innerHTML = "";
    setMsg("secWatchMsg", err.message || "Anomalie-Check fehlgeschlagen.");
  }
}

async function loadSecurityAudit() {
  try {
    const hours = Math.max(1, Math.min(168, Number($("secAuditHoursInput").value || 48)));
    const limit = Math.max(20, Math.min(1000, Number($("secAuditLimitInput").value || 200)));
    setMsg("secAuditMsg", "Audit wird geladen...");
    const data = await api(`/api/admin/audit?limit=${limit}`);
    const risky = new Set([
      "ban", "unban", "set_user_role", "set_flags", "process_action", "process_action_all",
      "server_restart", "deploy_now", "apk_build_debug", "pm2_resurrect", "pm2_save", "admin_op",
    ]);
    const rows = (Array.isArray(data.rows) ? data.rows : [])
      .filter((r) => withinHours(r.created_at, hours))
      .filter((r) => risky.has(String(r.command || "")))
      .map((r) => ({
        zeit: r.created_at,
        akteur: r.actor_id,
        aktion: r.command,
        ziel: r.target_id || "-",
      }));
    $("secAuditWrap").innerHTML = renderTable(rows);
    setMsg("secAuditMsg", `Audit geladen: ${rows.length} sicherheitsrelevante Einträge.`, true);
  } catch (err) {
    $("secAuditWrap").innerHTML = "";
    setMsg("secAuditMsg", err.message || "Sicherheits-Audit fehlgeschlagen.");
  }
}

async function loadSecurityLockStatus() {
  try {
    const [summary, flags] = await Promise.all([api("/api/admin/summary"), api("/api/admin/flags")]);
    const p = summary?.processes || {};
    const f = flags?.flags || {};
    $("secLockStatusWrap").innerHTML = `
      ${kvRow("Bot Status", p.bot?.status || "-")}
      ${kvRow("App Status", p.app?.status || "-")}
      ${kvRow("Deploy erlaubt", f.deployEnabled ? "ja" : "nein")}
      ${kvRow("APK-Build erlaubt", f.apkBuildEnabled ? "ja" : "nein")}
      ${kvRow("Reboot erlaubt", f.rebootEnabled ? "ja" : "nein")}
      ${kvRow("Logstream aktiv", f.logStreamEnabled ? "ja" : "nein")}
      ${kvRow("Alerts aktiv", f.alertsEnabled ? "ja" : "nein")}
    `;
  } catch {
    $("secLockStatusWrap").innerHTML = "<span class='muted'>Status konnte nicht geladen werden.</span>";
  }
}

async function applySecurityPreset(mode) {
  if (mode === "lockdown") {
    await api("/api/process/all/action", { method: "POST", body: JSON.stringify({ action: "stop" }) });
    await api("/api/admin/flags", {
      method: "POST",
      body: JSON.stringify({
        deployEnabled: false,
        apkBuildEnabled: false,
        rebootEnabled: false,
        logStreamEnabled: true,
        alertsEnabled: true,
      }),
    });
    return;
  }
  if (mode === "safe-default") {
    await api("/api/admin/flags", {
      method: "POST",
      body: JSON.stringify({
        deployEnabled: false,
        apkBuildEnabled: false,
        rebootEnabled: false,
        logStreamEnabled: true,
        alertsEnabled: true,
      }),
    });
    return;
  }
  if (mode === "stop-bot") {
    await api("/api/process/bot/action", { method: "POST", body: JSON.stringify({ action: "stop" }) });
    return;
  }
  if (mode === "stop-app") {
    await api("/api/process/app/action", { method: "POST", body: JSON.stringify({ action: "stop" }) });
  }
}

async function runSecurityAction(mode) {
  try {
    if (mode === "lockdown") {
      const ok = await confirmDangerActionWithCountdown(
        "Sofort-Lockdown",
        "Bot und App werden gestoppt, riskante Flags deaktiviert. Fortfahren?",
        8
      );
      if (!ok) return;
    }
    setMsg("secLockMsg", "Aktion läuft...");
    await applySecurityPreset(mode);
    await loadSecurityLockStatus();
    setMsg("secLockMsg", "Sicherheitsaktion erfolgreich ausgeführt.", true);
  } catch (err) {
    setMsg("secLockMsg", err.message || "Sicherheitsaktion fehlgeschlagen.");
  }
}

function renderProcStatus(data) {
  const s = data?.status || {};
  const processName = escapeHtml(data?.processName || "-");
  return `
    <div class="infoGrid">
      <div class="infoCard">
        <h4 class="infoTitle">${processName}</h4>
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

function escapeHtml(v) {
  return String(v == null ? "" : v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderAdminStatus(data) {
  const server = data?.server || {};
  const proc = data?.processes || {};
  const ips = Array.isArray(server.ips)
    ? server.ips
      .map((i) => escapeHtml(`${i.iface} ${i.address} (${i.family}${i.scope ? `, ${i.scope}` : ""})`))
      .join("<br>")
    : "-";
  const bot = proc.bot || {};
  const app = proc.app || {};
  return `
    <div class="infoGrid">
      <div class="infoCard">
        <h4 class="infoTitle">Server</h4>
        ${kvRow("Host", server.host || "-")}
        ${kvRow("Plattform", server.platform || "-")}
        ${kvRow("Node", server.node || "-")}
        ${kvRow("Uptime", fmtUptime(server.uptimeSec || 0))}
        ${kvRow("Reboot erlaubt", server.rebootAllowed ? "ja" : "nein")}
        ${kvRow("Öffentlicher Endpoint", server.publicEndpoint || "-")}
      </div>
      <div class="infoCard">
        <h4 class="infoTitle">IP-Adressen</h4>
        <div class="logsBox" style="min-height:unset;max-height:180px">${ips || "-"}</div>
      </div>
      <div class="infoCard">
        <h4 class="infoTitle">Bot Prozess</h4>
        ${kvRow("Status", bot.status || "-")}
        ${kvRow("PID", bot.pid ?? "-")}
        ${kvRow("Restarts", bot.restarts ?? "-")}
        ${kvRow("Uptime", fmtUptime(bot.uptimeSec || 0))}
      </div>
      <div class="infoCard">
        <h4 class="infoTitle">App Prozess</h4>
        ${kvRow("Status", app.status || "-")}
        ${kvRow("PID", app.pid ?? "-")}
        ${kvRow("Restarts", app.restarts ?? "-")}
        ${kvRow("Uptime", fmtUptime(app.uptimeSec || 0))}
      </div>
    </div>
  `;
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

async function loadAdminPanel() {
  try {
    const summary = await api("/api/admin/summary");
    $("adminStatusWrap").innerHTML = renderAdminStatus(summary);
    setMsg("adminMsg", "");
  } catch (err) {
    setMsg("adminMsg", err.message || "Serverstatus konnte nicht geladen werden");
  }
}

async function loadAdminAlerts() {
  try {
    const data = await api("/api/admin/alerts");
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    if (!alerts.length) {
      $("adminAlertsWrap").innerHTML = `<div class="kv"><span class="k">Status</span><span class="v">Keine Alerts</span></div>`;
      return;
    }
    $("adminAlertsWrap").innerHTML = alerts
      .map((a) => `<div class="kv"><span class="k">${escapeHtml(a.code || "-")} (${escapeHtml(a.level || "-")})</span><span class="v">${escapeHtml(a.message || "-")}</span></div>`)
      .join("");
  } catch (err) {
    setMsg("adminMsg", err.message || "Alerts konnten nicht geladen werden");
  }
}

async function loadAdminFlags() {
  try {
    const data = await api("/api/admin/flags");
    const f = data.flags || {};
    $("adminFlagsWrap").innerHTML = `
      <label class="fieldLabel"><input id="flagDeploy" type="checkbox" ${f.deployEnabled ? "checked" : ""}/> Deploy enabled</label>
      <label class="fieldLabel"><input id="flagApkBuild" type="checkbox" ${f.apkBuildEnabled ? "checked" : ""}/> APK build enabled</label>
      <label class="fieldLabel"><input id="flagReboot" type="checkbox" ${f.rebootEnabled ? "checked" : ""}/> Reboot enabled</label>
      <label class="fieldLabel"><input id="flagLogStream" type="checkbox" ${f.logStreamEnabled ? "checked" : ""}/> Log stream enabled</label>
      <label class="fieldLabel"><input id="flagAlerts" type="checkbox" ${f.alertsEnabled ? "checked" : ""}/> Alerts enabled</label>
    `;
  } catch (err) {
    setMsg("adminMsg", err.message || "Flags konnten nicht geladen werden");
  }
}

async function saveAdminFlags() {
  try {
    const payload = {
      deployEnabled: $("flagDeploy")?.checked === true,
      apkBuildEnabled: $("flagApkBuild")?.checked === true,
      rebootEnabled: $("flagReboot")?.checked === true,
      logStreamEnabled: $("flagLogStream")?.checked === true,
      alertsEnabled: $("flagAlerts")?.checked === true,
    };
    await api("/api/admin/flags", { method: "POST", body: JSON.stringify(payload) });
    setMsg("adminMsg", "Flags gespeichert.", true);
  } catch (err) {
    setMsg("adminMsg", err.message || "Flags konnten nicht gespeichert werden");
  }
}

async function loadAdminAudit() {
  try {
    const data = await api("/api/admin/audit?limit=120");
    $("adminAuditWrap").innerHTML = renderTable(data.rows || []);
  } catch (err) {
    setMsg("adminMsg", err.message || "Audit konnte nicht geladen werden");
  }
}

async function loadAdminUsers() {
  try {
    const data = await api("/api/admin/users?limit=500");
    $("adminUsersWrap").innerHTML = renderTable(data.rows || []);
  } catch (err) {
    setMsg("adminMsg", err.message || "Users konnten nicht geladen werden");
  }
}

async function setAdminUserRole() {
  try {
    const chatId = $("adminRoleChatId").value.trim();
    const role = $("adminRoleValue").value;
    await api(`/api/admin/users/${encodeURIComponent(chatId)}/role`, {
      method: "POST",
      body: JSON.stringify({ role }),
    });
    setMsg("adminMsg", `Rolle gesetzt: ${chatId} -> ${role}`, true);
    await loadAdminUsers();
  } catch (err) {
    setMsg("adminMsg", err.message || "Rolle konnte nicht gesetzt werden");
  }
}

async function loadAdminJobs() {
  try {
    const data = await api("/api/admin/jobs");
    $("adminJobsWrap").innerHTML = renderTable(data.rows || []);
  } catch (err) {
    setMsg("adminMsg", err.message || "Jobs konnten nicht geladen werden");
  }
}

async function loadAdminBackups() {
  try {
    const data = await api("/api/db/backups?limit=100");
    const rows = (data.rows || []).map((r) => ({
      ...r,
      download: `${window.location.origin}/api/db/backups/${encodeURIComponent(r.name)}`,
    }));
    $("adminBackupsWrap").innerHTML = renderTable(rows);
  } catch (err) {
    setMsg("adminMsg", err.message || "Backups konnten nicht geladen werden");
  }
}

async function createAdminBackup() {
  try {
    await api("/api/db/backup", { method: "POST", body: JSON.stringify({}) });
    setMsg("adminMsg", "Backup erstellt.", true);
    await loadAdminBackups();
  } catch (err) {
    setMsg("adminMsg", err.message || "Backup fehlgeschlagen");
  }
}

async function checkAdminBackupIntegrity() {
  try {
    const data = await api("/api/db/maintenance/check");
    setMsg("adminMsg", `Integritätscheck: ${data.integrity}`, true);
  } catch (err) {
    setMsg("adminMsg", err.message || "Integritätscheck fehlgeschlagen");
  }
}

async function createAdminJob() {
  try {
    const op = $("adminJobOp").value;
    const runAtInput = $("adminJobRunAt").value;
    const runAt = runAtInput ? new Date(runAtInput).toISOString() : new Date(Date.now() + 60_000).toISOString();
    await api("/api/admin/jobs", { method: "POST", body: JSON.stringify({ op, runAt }) });
    setMsg("adminMsg", `Job erstellt: ${op}`, true);
    await loadAdminJobs();
  } catch (err) {
    setMsg("adminMsg", err.message || "Job konnte nicht erstellt werden");
  }
}

async function adminAction(target, action) {
  try {
    await api(`/api/process/${target}/action`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    await loadAdminPanel();
    setMsg("adminMsg", `${target} ${action} ausgeführt.`, true);
  } catch (err) {
    setMsg("adminMsg", err.message || "Aktion fehlgeschlagen");
  }
}

function confirmDangerActionWithCountdown(title, text, seconds = 10) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dangerModalBackdrop";
    const modal = document.createElement("div");
    modal.className = "dangerModal";
    const heading = document.createElement("h4");
    heading.textContent = title;
    const body = document.createElement("p");
    body.textContent = text;
    const countdown = document.createElement("p");
    countdown.className = "dangerModalCountdown";
    const row = document.createElement("div");
    row.className = "row";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Abbrechen";
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "danger";
    confirmBtn.disabled = true;

    let left = Math.max(1, Number(seconds) || 10);
    const render = () => {
      countdown.textContent = left > 0
        ? `Sicherheits-Countdown: ${left}s`
        : "Countdown abgelaufen: Aktion freigegeben.";
      confirmBtn.textContent = left > 0 ? `Warten (${left}s)` : "Jetzt ausführen";
      confirmBtn.disabled = left > 0;
    };
    render();

    const timer = setInterval(() => {
      left -= 1;
      render();
      if (left <= 0) clearInterval(timer);
    }, 1000);

    const close = (result) => {
      clearInterval(timer);
      backdrop.remove();
      resolve(Boolean(result));
    };

    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) close(false);
    });

    row.appendChild(cancelBtn);
    row.appendChild(confirmBtn);
    modal.appendChild(heading);
    modal.appendChild(body);
    modal.appendChild(countdown);
    modal.appendChild(row);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  });
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
    const initials = escapeHtml(String(p.username || "Owner").slice(0, 2).toUpperCase());
    const safeAvatarSrc = escapeHtml(avatarSrc);
    const safeUsername = escapeHtml(p.username || "-");
    $("profileWrap").innerHTML = `
      <div class="infoGrid">
        <div class="infoCard">
          <div class="profileHeader">
            ${
              safeAvatarSrc
                ? `<img class="profileAvatar" src="${safeAvatarSrc}" alt="WhatsApp Avatar" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex';" /><div class="profileAvatarFallback" style="display:none">${initials}</div>`
                : `<div class="profileAvatarFallback">${initials}</div>`
            }
            <div>
              <h4 class="infoTitle">${safeUsername}</h4>
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

function setForgeMsg(text, good = false) {
  setMsg("forgeMsg", text, good);
}

function appendForgeLog(line) {
  const box = $("forgeLogsWrap");
  if (!box) return;
  const now = new Date().toLocaleTimeString("de-DE");
  const prev = box.textContent || "";
  const next = `${prev}${prev ? "\n" : ""}[${now}] ${line}`;
  box.textContent = next.slice(-30000);
  box.scrollTop = box.scrollHeight;
}

function setForgeTimeline(items) {
  const wrap = $("forgeTimelineWrap");
  if (!wrap) return;
  wrap.innerHTML = items
    .map(
      (it, idx) => `
      <div class="forgeStep ${it.status || "pending"}">
        <span class="forgeStepIdx">${idx + 1}</span>
        <div>
          <strong>${escapeHtml(it.label || `Schritt ${idx + 1}`)}</strong>
          <p>${escapeHtml(it.detail || "")}</p>
        </div>
      </div>`
    )
    .join("");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function isLikelyRestartDisconnect(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("networkerror") ||
    msg.includes("failed to fetch") ||
    msg.includes("load failed") ||
    msg.includes("network request failed")
  );
}

async function forgeHttpRequest(step) {
  const method = String(step.method || "GET").toUpperCase();
  const url = String(step.url || "").trim();
  if (!url.startsWith("/")) throw new Error("Nur relative URLs erlaubt (beginnend mit /).");
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (step.headers && typeof step.headers === "object") {
    Object.entries(step.headers).forEach(([k, v]) => {
      headers[String(k)] = String(v);
    });
  }
  let body = undefined;
  if (step.body != null) {
    body = typeof step.body === "string" ? step.body : JSON.stringify(step.body);
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  }
  const start = Date.now();
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  const took = Date.now() - start;
  const expected = Number(step.expectStatus || 0);
  if (expected && res.status !== expected) {
    throw new Error(`${method} ${url} -> HTTP ${res.status} (erwartet ${expected})`);
  }
  return { status: res.status, took, bytes: text.length };
}

async function runForgeWorkflow(workflow) {
  const runId = ++forgeRunId;
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  if (!steps.length) throw new Error("Workflow enthält keine Schritte.");
  const timeline = steps.map((s, i) => ({
    label: String(s.label || `Schritt ${i + 1}`),
    detail: String(s.type || "unknown"),
    status: "pending",
  }));
  setForgeTimeline(timeline);
  $("forgeLogsWrap").textContent = "";

  for (let i = 0; i < steps.length; i += 1) {
    if (runId !== forgeRunId) {
      appendForgeLog("Workflow manuell gestoppt.");
      throw new Error("Workflow gestoppt.");
    }
    const step = steps[i];
    const label = String(step.label || `Schritt ${i + 1}`);
    timeline[i].status = "running";
    setForgeTimeline(timeline);
    try {
      const type = String(step.type || "").toLowerCase();
      if (type === "delay") {
        const ms = Number(step.ms || 1000);
        appendForgeLog(`${label}: warte ${ms}ms`);
        await delay(ms);
      } else if (type === "process_action") {
        const target = String(step.target || "").toLowerCase();
        const action = String(step.action || "").toLowerCase();
        appendForgeLog(`${label}: ${target} ${action}`);
        try {
          const r = await api(`/api/process/${encodeURIComponent(target)}/action`, {
            method: "POST",
            body: JSON.stringify({ action }),
          });
          if (!r.ok) throw new Error("Prozessaktion fehlgeschlagen");
        } catch (err) {
          const isSelfRestart = target === "app" && action === "restart";
          if (isSelfRestart && isLikelyRestartDisconnect(err)) {
            const waitMs = Number(step.restartWaitMs || 3500);
            appendForgeLog(`${label}: Verbindungsabbruch beim App-Neustart erwartet, warte ${waitMs}ms...`);
            await delay(waitMs);
          } else {
            throw err;
          }
        }
      } else if (type === "admin_op") {
        const op = String(step.op || "").trim();
        appendForgeLog(`${label}: admin-op ${op}`);
        const r = await api("/api/admin/op", {
          method: "POST",
          body: JSON.stringify({ op, args: step.args || {} }),
        });
        if (!r.ok) throw new Error("Admin-Operation fehlgeschlagen");
      } else if (type === "request") {
        const r = await forgeHttpRequest(step);
        appendForgeLog(`${label}: HTTP ${r.status} in ${r.took}ms (${r.bytes} bytes)`);
      } else {
        throw new Error(`Unbekannter Step-Type: ${type}`);
      }
      timeline[i].status = "done";
      timeline[i].detail = "OK";
      setForgeTimeline(timeline);
    } catch (err) {
      timeline[i].status = "failed";
      timeline[i].detail = err.message || "Fehler";
      setForgeTimeline(timeline);
      appendForgeLog(`${label}: FEHLER -> ${err.message || "Unbekannt"}`);
      throw err;
    }
  }
  appendForgeLog("Workflow erfolgreich abgeschlossen.");
}

function loadForgePreset() {
  const key = $("forgePresetSelect")?.value;
  const preset = FORGE_PRESETS[key];
  if (!preset) return;
  $("forgeJsonInput").value = JSON.stringify(preset, null, 2);
  setForgeMsg(`Preset geladen: ${preset.name}`, true);
}

async function startForgeRun() {
  try {
    const raw = $("forgeJsonInput").value.trim();
    if (!raw) throw new Error("Workflow JSON fehlt.");
    const workflow = JSON.parse(raw);
    setForgeMsg("Workflow läuft...");
    await runForgeWorkflow(workflow);
    setForgeMsg("Workflow erfolgreich beendet.", true);
  } catch (err) {
    setForgeMsg(err.message || "Workflow fehlgeschlagen.");
  }
}

function stopForgeRun() {
  forgeRunId += 1;
  setForgeMsg("Workflow-Stopp angefordert.");
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
  stopForgeRun();
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
  $("botTplSaveBtn").addEventListener("click", saveBotTemplate);
  $("botTplLoadBtn").addEventListener("click", loadBotTemplate);
  $("botTplDeleteBtn").addEventListener("click", deleteBotTemplate);
  $("botTplSendBtn").addEventListener("click", sendBotTemplate);
  $("botLookupRunBtn").addEventListener("click", loadBotLookup);
  $("botStatsRefreshBtn").addEventListener("click", loadBotStats);
  $("secAccessRefreshBtn").addEventListener("click", loadSecurityAccess);
  $("secWatchRefreshBtn").addEventListener("click", loadSecurityWatch);
  $("secAuditRefreshBtn").addEventListener("click", loadSecurityAudit);
  $("secLockdownBtn").addEventListener("click", () => runSecurityAction("lockdown"));
  $("secStopBotBtn").addEventListener("click", () => runSecurityAction("stop-bot"));
  $("secStopAppBtn").addEventListener("click", () => runSecurityAction("stop-app"));
  $("secRestoreSafeBtn").addEventListener("click", () => runSecurityAction("safe-default"));
  $("loadOutboxBtn").addEventListener("click", loadOutbox);
  $("dbInsightRefreshBtn").addEventListener("click", loadDbInsights);
  $("dbExportPreviewBtn").addEventListener("click", previewDbExport);
  $("dbExportDownloadBtn").addEventListener("click", downloadDbExport);
  $("dbExportTableSelect").addEventListener("change", () => {
    dbExportRowsCache = [];
  });
  $("dbExportFormatSelect").addEventListener("change", () => {
    dbExportRowsCache = [];
  });
  $("dbExportMaxRowsInput").addEventListener("change", () => {
    dbExportRowsCache = [];
  });
  $("botRefreshBtn").addEventListener("click", () => loadProcessPanel("bot", "botStatusWrap", "botLogsWrap", "botCtlMsg"));
  $("appRefreshBtn").addEventListener("click", () => loadProcessPanel("app", "appStatusWrap", "appLogsWrap", "appCtlMsg"));
  $("botStartBtn").addEventListener("click", () => processAction("bot", "start", "botCtlMsg", "botStatusWrap", "botLogsWrap"));
  $("botStopBtn").addEventListener("click", () => processAction("bot", "stop", "botCtlMsg", "botStatusWrap", "botLogsWrap"));
  $("botRestartBtn").addEventListener("click", () => processAction("bot", "restart", "botCtlMsg", "botStatusWrap", "botLogsWrap"));
  $("appStartBtn").addEventListener("click", () => processAction("app", "start", "appCtlMsg", "appStatusWrap", "appLogsWrap"));
  $("appStopBtn").addEventListener("click", () => processAction("app", "stop", "appCtlMsg", "appStatusWrap", "appLogsWrap"));
  $("appRestartBtn").addEventListener("click", () => processAction("app", "restart", "appCtlMsg", "appStatusWrap", "appLogsWrap"));
  $("adminRefreshBtn").addEventListener("click", loadAdminPanel);
  $("adminRestartBotBtn").addEventListener("click", () => adminAction("bot", "restart"));
  $("adminRestartAppBtn").addEventListener("click", () => adminAction("app", "restart"));
  $("adminRestartAllBtn").addEventListener("click", async () => {
    const ok = await confirmDangerActionWithCountdown(
      "Alles neustarten",
      "Bot und App werden neu gestartet. Fortfahren?",
      5
    );
    if (!ok) return;
    await adminAction("all", "restart");
  });
  $("adminRestartServerBtn").addEventListener("click", async () => {
    const ok = await confirmDangerActionWithCountdown(
      "Server neustarten",
      "Der Server fährt neu hoch. Verbindung wird kurz unterbrochen.",
      10
    );
    if (!ok) return;
    await adminAction("server", "restart");
  });
  $("adminAlertsRefreshBtn").addEventListener("click", loadAdminAlerts);
  $("adminAuditRefreshBtn").addEventListener("click", loadAdminAudit);
  $("adminUsersRefreshBtn").addEventListener("click", loadAdminUsers);
  $("adminJobsRefreshBtn").addEventListener("click", loadAdminJobs);
  $("adminFlagsSaveBtn").addEventListener("click", saveAdminFlags);
  $("adminJobCreateBtn").addEventListener("click", createAdminJob);
  $("adminRoleSetBtn").addEventListener("click", setAdminUserRole);
  $("adminBackupNowBtn").addEventListener("click", createAdminBackup);
  $("adminBackupCheckBtn").addEventListener("click", checkAdminBackupIntegrity);
  $("adminBackupListBtn").addEventListener("click", loadAdminBackups);
  $("forgeLoadPresetBtn").addEventListener("click", loadForgePreset);
  $("forgeRunBtn").addEventListener("click", startForgeRun);
  $("forgeStopBtn").addEventListener("click", stopForgeRun);
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
      if (tab === "secaccess") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        await loadSecurityAccess();
      }
      if (tab === "secwatch") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        await loadSecurityWatch();
      }
      if (tab === "seclockdown") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        await loadSecurityLockStatus();
      }
      if (tab === "secaudit") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        await loadSecurityAudit();
      }
      if (tab === "msg" || tab === "broadcast") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
      }
      if (tab === "botcomposer") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        refreshBotTemplateSelect();
      }
      if (tab === "botlookup") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        await loadBotLookup();
      }
      if (tab === "botstats") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        await loadBotStats();
      }
      if (tab === "outbox") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        await loadOutbox();
      }
      if (tab === "dbinsight") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        await loadDbInsights();
      }
      if (tab === "dbexport") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        await ensureDbExportTablesLoaded();
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
      if (tab === "admin") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        await loadAdminPanel();
        await loadAdminAlerts();
        await loadAdminFlags();
        await loadAdminAudit();
        await loadAdminUsers();
        await loadAdminJobs();
        await loadAdminBackups();
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
      if (tab === "forge") {
        updateInfoAutoRefresh(false);
        updateProcessAutoRefresh(null);
        if (!$("forgeJsonInput").value.trim()) loadForgePreset();
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
    refreshBotTemplateSelect();
    updateInfoAutoRefresh(false);
    updateProcessAutoRefresh(null);
    setMenuOpen(false);
    if (!$("forgeJsonInput").value.trim()) loadForgePreset();
  } catch {
    await logout();
  }
}

boot();
