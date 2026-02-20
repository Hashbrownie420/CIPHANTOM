import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import {
  initDb,
  getUser,
  getOwnerAuthByUsername,
  setUserBiography,
  addOwnerAuditLog,
  listOwnerAuditLogs,
  listUsers,
  setUserRole,
  setBan,
  clearBan,
  listBans,
  addOwnerOutboxMessage,
  listOwnerOutbox,
} from "../../src/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.resolve(__dirname, "..", "web");
const OWNER_DIR = path.resolve(__dirname, "..");
const OWNER_PACKAGE_JSON = path.resolve(OWNER_DIR, "package.json");
const PROJECT_ROOT = path.resolve(OWNER_DIR, "..");
const AVATAR_DIR = path.resolve(PROJECT_ROOT, "data", "avatars");
const DB_FILE = path.resolve(PROJECT_ROOT, "data", "cipherphantom.db");
const DB_BACKUP_DIR = path.resolve(PROJECT_ROOT, "data", "backups");
const parsedBackupKeep = Number(process.env.OWNER_DB_BACKUP_KEEP || 20);
const DB_BACKUP_KEEP = Number.isFinite(parsedBackupKeep) && parsedBackupKeep > 0 ? Math.floor(parsedBackupKeep) : 20;
const ADMIN_FLAGS_FILE = path.resolve(PROJECT_ROOT, "data", "admin-flags.json");
const ADMIN_JOBS_FILE = path.resolve(PROJECT_ROOT, "data", "admin-jobs.json");
const SESSION_STORE_FILE = path.resolve(PROJECT_ROOT, "data", "owner-sessions.json");
const ANDROID_LOCAL_PROPERTIES = path.resolve(OWNER_DIR, "android", "local.properties");
const DEFAULT_APK_FILE = path.resolve(
  OWNER_DIR,
  "android",
  "app",
  "build",
  "outputs",
  "apk",
  "debug",
  "app-debug.apk"
);
const parsedPort = Number(process.env.OWNER_APP_PORT || 8787);
const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8787;
const HOST = String(process.env.OWNER_APP_HOST || "0.0.0.0").trim() || "0.0.0.0";
const LATEST_APK_VERSION = Number(process.env.OWNER_LATEST_APK_VERSION || 1);
const MIN_APK_VERSION = Number(process.env.OWNER_MIN_APK_VERSION || 1);
const APK_DOWNLOAD_URL = String(process.env.OWNER_APK_DOWNLOAD_URL || "").trim();
const OWNER_IDS = new Set(
  String(process.env.OWNER_IDS || "72271934840903@lid")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);
const OWNER_PUBLIC_BASE_URL = String(process.env.OWNER_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
const OWNER_ALLOW_QUERY_TOKEN = String(process.env.OWNER_ALLOW_QUERY_TOKEN || "0") === "1";
const PM2_UNAVAILABLE_CODES = new Set(["ENOENT", "PM2_UNAVAILABLE"]);
const DOCKER_PROCESS_MAP = {
  bot: ["cipherphantom-bot", "bot"],
  app: ["cipherphantom-owner-app", "owner-app"],
  all: ["cipherphantom-bot", "cipherphantom-owner-app"],
};

const sessions = new Map();
const parsedSessionTtlHours = Number(process.env.OWNER_SESSION_TTL_HOURS || 12);
const SESSION_TTL_HOURS =
  Number.isFinite(parsedSessionTtlHours) && parsedSessionTtlHours > 0 ? parsedSessionTtlHours : 12;
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;
const execFileAsync = promisify(execFile);
const PROCESS_MAP = {
  bot: ["cipherphantom-bot"],
  app: ["cipherphantom-owner-app", "cipherphantom-owner-remote"],
  all: ["cipherphantom-bot", "cipherphantom-owner-app", "cipherphantom-owner-remote"],
};
const OWNER_ALLOW_SERVER_REBOOT = String(process.env.OWNER_ALLOW_SERVER_REBOOT || "0") === "1";
const OWNER_SERVER_REBOOT_CMD = String(process.env.OWNER_SERVER_REBOOT_CMD || "sudo /sbin/shutdown -r +1");

const db = await initDb();
const rateLimitState = new Map();
const RATE_LIMITS = {
  login: { windowMs: 15 * 60 * 1000, max: 12 },
  api: { windowMs: 60 * 1000, max: 180 },
  processAction: { windowMs: 60 * 1000, max: 30 },
};
let adminJobTimer = null;

function persistSessions() {
  try {
    const dir = path.dirname(SESSION_STORE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const list = Array.from(sessions.values())
      .filter((s) => s && s.token && Number(s.expiresAt || 0) > now)
      .map((s) => ({
        token: String(s.token),
        chatId: String(s.chatId || ""),
        username: String(s.username || ""),
        expiresAt: Number(s.expiresAt || 0),
      }));
    fs.writeFileSync(SESSION_STORE_FILE, JSON.stringify({ sessions: list }, null, 2), "utf8");
  } catch {
    // keep runtime sessions even if persistence fails
  }
}

function loadPersistedSessions() {
  try {
    if (!fs.existsSync(SESSION_STORE_FILE)) return;
    const raw = fs.readFileSync(SESSION_STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const now = Date.now();
    list.forEach((s) => {
      const token = String(s?.token || "").trim();
      const expiresAt = Number(s?.expiresAt || 0);
      if (!token || expiresAt <= now) return;
      sessions.set(token, {
        token,
        chatId: String(s?.chatId || ""),
        username: String(s?.username || ""),
        expiresAt,
      });
    });
  } catch {
    // ignore broken persistence file
  }
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Number(bytes || 0);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function logStartupOverview() {
  const mem = process.memoryUsage();
  const lines = [
    `[owner-app] gestartet auf http://${HOST}:${PORT}`,
    `[owner-app] host=${os.hostname()} platform=${process.platform}/${process.arch} node=${process.version}`,
    `[owner-app] cpu_cores=${os.cpus()?.length || 0} load_1m=${(os.loadavg()[0] || 0).toFixed(2)}`,
    `[owner-app] ram_process_rss=${formatBytes(mem.rss)} ram_system=${formatBytes(os.freemem())}/${formatBytes(os.totalmem())} (free/total)`,
    `[owner-app] paths web=${WEB_DIR} local.properties=${ANDROID_LOCAL_PROPERTIES}`,
  ];
  lines.forEach((line) => console.log(line));
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  res.end(body);
}

function getClientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").trim();
  if (fwd) return fwd.split(",")[0].trim();
  return String(req.socket?.remoteAddress || "unknown");
}

function applyRateLimit(req, bucket, key = "") {
  const conf = RATE_LIMITS[bucket];
  if (!conf) return { limited: false };
  const now = Date.now();
  const ip = getClientIp(req);
  const mapKey = `${bucket}:${ip}:${key}`;
  const current = rateLimitState.get(mapKey) || { count: 0, resetAt: now + conf.windowMs };
  if (now > current.resetAt) {
    current.count = 0;
    current.resetAt = now + conf.windowMs;
  }
  current.count += 1;
  rateLimitState.set(mapKey, current);
  if (current.count > conf.max) {
    return { limited: true, retryAfterSec: Math.ceil((current.resetAt - now) / 1000) };
  }
  return { limited: false };
}

function rateLimitExceeded(res, limitResult) {
  res.setHeader("Retry-After", String(limitResult.retryAfterSec || 60));
  return json(res, 429, { ok: false, error: "Zu viele Anfragen. Bitte kurz warten." });
}

async function auditAdminAction(session, command, targetId = null, payload = null) {
  if (!session?.chatId) return;
  try {
    await addOwnerAuditLog(
      db,
      session.chatId,
      String(command || "admin_action"),
      targetId,
      payload ? JSON.stringify(payload) : null
    );
  } catch {
    // ignore audit failures in API responses
  }
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function getTokenFromReq(req) {
  const raw = req.headers.authorization || "";
  const parts = raw.split(" ");
  if (parts.length === 2 && /^Bearer$/i.test(parts[0])) return parts[1];
  if (!OWNER_ALLOW_QUERY_TOKEN) return null;
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const q = String(url.searchParams.get("token") || "").trim();
    if (q) return q;
  } catch {
    // ignore
  }
  return null;
}

function getSession(req) {
  const token = getTokenFromReq(req);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    persistSessions();
    return null;
  }
  return s;
}

function requireAuth(req, res) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { ok: false, error: "Nicht eingeloggt" });
    return null;
  }
  return session;
}

function safeFilePath(urlPath) {
  const clean = urlPath === "/" ? "/index.html" : urlPath;
  const full = path.normalize(path.join(WEB_DIR, clean));
  const rel = path.relative(WEB_DIR, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

function readLocalProps() {
  const out = {};
  try {
    if (!fs.existsSync(ANDROID_LOCAL_PROPERTIES)) return out;
    const raw = fs.readFileSync(ANDROID_LOCAL_PROPERTIES, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      const t = String(line || "").trim();
      if (!t || t.startsWith("#")) return;
      const idx = t.indexOf("=");
      if (idx <= 0) return;
      const k = t.slice(0, idx).trim();
      const v = t.slice(idx + 1).trim();
      if (k) out[k] = v;
    });
  } catch {
    return out;
  }
  return out;
}

function getOwnerPanelVersion() {
  try {
    const raw = fs.readFileSync(OWNER_PACKAGE_JSON, "utf8");
    const parsed = JSON.parse(raw);
    const version = String(parsed?.version || "").trim();
    return version || null;
  } catch {
    return null;
  }
}

function getMetaUpdatedAt() {
  try {
    const stat = fs.statSync(ANDROID_LOCAL_PROPERTIES);
    if (stat?.mtime) return new Date(stat.mtime).toISOString();
  } catch {}
  return null;
}

function resolveFileFromCandidate(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

function fileExists(filePath) {
  try {
    return Boolean(filePath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveApkFilePath(props = {}) {
  const fromProps = resolveFileFromCandidate(props.OWNER_APK_FILE || "");
  const fromEnv = resolveFileFromCandidate(process.env.OWNER_APK_FILE || "");
  const releaseApk = path.resolve(PROJECT_ROOT, "data", "releases", "latest.apk");
  const candidates = [fromProps, fromEnv, releaseApk, DEFAULT_APK_FILE].filter(Boolean);
  const existing = candidates.find((p) => fileExists(p));
  return existing || candidates[0] || DEFAULT_APK_FILE;
}

function resolvePublicBaseUrl(req = null) {
  if (OWNER_PUBLIC_BASE_URL) return OWNER_PUBLIC_BASE_URL;
  const host = String(req?.headers?.host || "").trim();
  if (!host) return "";
  const proto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  return `${proto}://${host}`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonFileSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonFileSafe(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function defaultAdminFlags() {
  return {
    deployEnabled: true,
    apkBuildEnabled: true,
    rebootEnabled: OWNER_ALLOW_SERVER_REBOOT,
    logStreamEnabled: true,
    alertsEnabled: true,
  };
}

function getAdminFlags() {
  const merged = { ...defaultAdminFlags(), ...readJsonFileSafe(ADMIN_FLAGS_FILE, {}) };
  return merged;
}

function setAdminFlags(partial = {}) {
  const next = { ...getAdminFlags(), ...(partial || {}) };
  writeJsonFileSafe(ADMIN_FLAGS_FILE, next);
  return next;
}

function listDbBackups(limit = 50) {
  ensureDir(DB_BACKUP_DIR);
  return fs
    .readdirSync(DB_BACKUP_DIR)
    .filter((name) => name.endsWith(".db"))
    .map((name) => {
      const full = path.join(DB_BACKUP_DIR, name);
      const st = fs.statSync(full);
      return {
        name,
        sizeBytes: st.size,
        createdAt: st.mtime.toISOString(),
      };
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
}

function rotateDbBackups(keep = DB_BACKUP_KEEP) {
  const files = listDbBackups(5000);
  const drop = files.slice(Math.max(1, keep));
  for (const f of drop) {
    try {
      fs.unlinkSync(path.join(DB_BACKUP_DIR, f.name));
    } catch {
      // ignore
    }
  }
}

async function createDbBackup() {
  ensureDir(DB_BACKUP_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `cipherphantom-${stamp}.db`;
  const full = path.join(DB_BACKUP_DIR, fileName);
  const esc = full.replace(/'/g, "''");

  // Make sure WAL content is flushed before backup snapshot.
  await db.exec("PRAGMA wal_checkpoint(FULL)");
  await db.exec(`VACUUM INTO '${esc}'`);

  const st = fs.statSync(full);
  rotateDbBackups(DB_BACKUP_KEEP);
  return {
    name: fileName,
    sizeBytes: st.size,
    createdAt: st.mtime.toISOString(),
    keep: DB_BACKUP_KEEP,
  };
}

function sendDbBackup(res, fileName) {
  const safeName = String(fileName || "").trim();
  if (!/^[a-zA-Z0-9._-]+\.db$/.test(safeName)) {
    return json(res, 400, { ok: false, error: "Ungültiger Backup-Dateiname" });
  }
  const full = path.resolve(DB_BACKUP_DIR, safeName);
  const rel = path.relative(DB_BACKUP_DIR, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return json(res, 400, { ok: false, error: "Bad path" });
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return json(res, 404, { ok: false, error: "Backup nicht gefunden" });
  }
  const content = fs.readFileSync(full);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": content.length,
    "Content-Disposition": `attachment; filename="${safeName}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(content);
}

function getApkIntegrityMeta(apkFile) {
  try {
    if (!fs.existsSync(apkFile) || fs.statSync(apkFile).isDirectory()) {
      return { apkSha256: null, apkSizeBytes: null };
    }
    const buf = fs.readFileSync(apkFile);
    const apkSha256 = crypto.createHash("sha256").update(buf).digest("hex");
    return { apkSha256, apkSizeBytes: buf.length };
  } catch {
    return { apkSha256: null, apkSizeBytes: null };
  }
}

async function checkDbHealth() {
  try {
    const row = await db.get("SELECT 1 AS ok");
    return { ok: Number(row?.ok || 0) === 1 };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "db check failed") };
  }
}

async function runDbIntegrityCheck() {
  try {
    const row = await db.get("PRAGMA integrity_check");
    const result = String(row?.integrity_check || "").trim();
    return { ok: result.toLowerCase() === "ok", result: result || "unknown" };
  } catch (err) {
    return { ok: false, result: String(err?.message || err || "integrity check failed") };
  }
}

async function checkPm2Health() {
  const listRes = await getPm2List();
  if (!listRes.ok) {
    if (PM2_UNAVAILABLE_CODES.has(String(listRes.code || ""))) {
      const dockerBot = await resolveRunningDockerName("bot");
      const dockerApp = await resolveRunningDockerName("app");
      const checks = [];
      if (dockerBot.ok) checks.push(await getDockerStatus(dockerBot.containerName));
      if (dockerApp.ok) checks.push(await getDockerStatus(dockerApp.containerName));
      if (checks.length > 0) {
        const online = checks.filter((c) => c.ok && String(c.data?.status || "") === "running").length;
        return {
          ok: online >= 1,
          managed: true,
          mode: "docker",
          reason: "pm2_unavailable",
          error: listRes.error || "pm2 not available",
          online,
          total: checks.length,
        };
      }
      return {
        ok: false,
        managed: false,
        mode: "unmanaged",
        reason: "pm2_unavailable",
        error: listRes.error || "pm2 not available",
        online: 0,
        total: 0,
      };
    }
    return { ok: false, managed: true, error: listRes.error || "pm2 check failed", online: 0, total: 0 };
  }
  const list = listRes.list || [];
  const relevant = list.filter((p) => ["cipherphantom-bot", "cipherphantom-owner-app", "cipherphantom-owner-remote"].includes(p?.name));
  const online = relevant.filter((p) => String(p?.pm2_env?.status || "") === "online").length;
  return { ok: online >= 1, managed: true, mode: "pm2", online, total: relevant.length };
}

async function checkDiskHealth(baseDir) {
  try {
    const { stdout } = await execFileAsync("df", ["-Pk", baseDir], { maxBuffer: 1024 * 1024 });
    const lines = String(stdout || "").trim().split(/\r?\n/);
    if (lines.length < 2) return { ok: false, error: "df parse failed" };
    const parts = lines[1].trim().split(/\s+/);
    const availableKb = Number(parts[3] || 0);
    const availableBytes = availableKb * 1024;
    const minFreeBytes = 256 * 1024 * 1024; // 256MB
    return {
      ok: availableBytes >= minFreeBytes,
      availableBytes,
      minFreeBytes,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "disk check failed") };
  }
}

async function collectHealthSnapshot() {
  const dbHealth = await checkDbHealth();
  const pm2Health = await checkPm2Health();
  const diskHealth = await checkDiskHealth(PROJECT_ROOT);
  const rss = process.memoryUsage().rss;
  const load1 = os.loadavg()[0] || 0;
  const serviceOk = dbHealth.ok && diskHealth.ok;

  return {
    ok: serviceOk,
    service: "cipherphantom-owner-app",
    ts: new Date().toISOString(),
    checks: {
      db: dbHealth,
      pm2: pm2Health,
      disk: diskHealth,
    },
    runtime: {
      uptimeSec: Math.floor(process.uptime()),
      rssBytes: rss,
      loadAvg1m: Number(load1.toFixed(2)),
    },
  };
}

function readAdminJobs() {
  const rows = readJsonFileSafe(ADMIN_JOBS_FILE, []);
  return Array.isArray(rows) ? rows : [];
}

function writeAdminJobs(rows) {
  writeJsonFileSafe(ADMIN_JOBS_FILE, Array.isArray(rows) ? rows : []);
}

function upsertAdminJob(job) {
  const rows = readAdminJobs();
  const id = String(job?.id || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const next = {
    id,
    op: String(job?.op || ""),
    runAt: String(job?.runAt || new Date().toISOString()),
    status: String(job?.status || "queued"),
    createdAt: String(job?.createdAt || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
    result: job?.result || null,
  };
  const idx = rows.findIndex((r) => String(r?.id) === id);
  if (idx >= 0) rows[idx] = { ...rows[idx], ...next };
  else rows.unshift(next);
  writeAdminJobs(rows.slice(0, 500));
  return next;
}

function deleteAdminJob(id) {
  const rows = readAdminJobs();
  const next = rows.filter((r) => String(r?.id) !== String(id));
  writeAdminJobs(next);
}

async function collectAlerts() {
  const health = await collectHealthSnapshot();
  const alerts = [];
  if (!health.checks.db.ok) alerts.push({ level: "critical", code: "DB_DOWN", message: health.checks.db.error || "DB check failed" });
  if (!health.checks.disk.ok) alerts.push({ level: "warning", code: "DISK_LOW", message: `Freier Speicher niedrig (${formatBytes(health.checks.disk.availableBytes || 0)})` });
  if (!health.checks.pm2.ok) alerts.push({ level: "warning", code: "PM2_PROC_DOWN", message: "Nicht alle Kernprozesse sind online." });
  if ((health.runtime.loadAvg1m || 0) > 2.5) alerts.push({ level: "warning", code: "LOAD_HIGH", message: `Hohe CPU-Last (${health.runtime.loadAvg1m})` });
  const freeRatio = Number(os.freemem() / os.totalmem());
  if (freeRatio < 0.12) alerts.push({ level: "warning", code: "RAM_LOW", message: `Wenig freier RAM (${(freeRatio * 100).toFixed(1)}%)` });
  return { ok: true, alerts, health };
}

function startAdminJobsWorker() {
  if (adminJobTimer) return;
  adminJobTimer = setInterval(async () => {
    const now = Date.now();
    const rows = readAdminJobs();
    for (const row of rows) {
      if (row.status !== "queued") continue;
      const runAt = new Date(row.runAt).getTime();
      if (!Number.isFinite(runAt) || runAt > now) continue;
      row.status = "running";
      row.updatedAt = new Date().toISOString();
      writeAdminJobs(rows);
      const result = await runAdminOperation(row.op, { via: "job", id: row.id });
      row.status = result.ok ? "done" : "failed";
      row.result = {
        ok: result.ok,
        stdout: String(result.stdout || "").slice(-2000),
        stderr: String(result.stderr || "").slice(-2000),
      };
      row.updatedAt = new Date().toISOString();
      writeAdminJobs(rows);
    }
  }, 5000);
}

function sendStatic(req, res) {
  const full = safeFilePath(new URL(req.url, "http://localhost").pathname);
  if (!full) return json(res, 400, { ok: false, error: "Bad path" });
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return json(res, 404, { ok: false, error: "Not found" });
  }
  const ext = path.extname(full).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  const content = fs.readFileSync(full);
  res.writeHead(200, {
    "Content-Type": map[ext] || "application/octet-stream",
    "Content-Length": content.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(content);
}

function sendApk(reqMethod, res, filePath) {
  if (!fileExists(filePath) || fs.statSync(filePath).isDirectory()) {
    return json(res, 404, { ok: false, error: "APK not found" });
  }
  const size = fs.statSync(filePath).size;
  res.writeHead(200, {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Length": size,
    "Cache-Control": "no-store",
    "Content-Disposition": "attachment; filename=\"cipherphantom-owner-latest.apk\"",
    "X-Content-Type-Options": "nosniff",
  });
  if (String(reqMethod || "GET").toUpperCase() === "HEAD") {
    res.end();
    return;
  }
  const content = fs.readFileSync(filePath);
  res.end(content);
}

function sendAvatar(res, fileName) {
  const rel = String(fileName || "").replace(/^\/+/, "");
  if (!rel) return json(res, 400, { ok: false, error: "Bad file" });
  const full = path.resolve(AVATAR_DIR, rel);
  const safeRel = path.relative(AVATAR_DIR, full);
  if (safeRel.startsWith("..") || path.isAbsolute(safeRel)) return json(res, 400, { ok: false, error: "Bad path" });
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return json(res, 404, { ok: false, error: "Avatar not found" });
  }
  const ext = path.extname(full).toLowerCase();
  const mime =
    ext === ".png" ? "image/png" :
    ext === ".webp" ? "image/webp" :
    ext === ".gif" ? "image/gif" :
    "image/jpeg";
  const content = fs.readFileSync(full);
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": content.length,
    "Cache-Control": "public, max-age=60",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(content);
}

function safeAvatarId(chatId) {
  return String(chatId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function findLatestAvatarForChat(chatId) {
  const safeId = safeAvatarId(chatId);
  const dir = path.join(AVATAR_DIR, safeId);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return "";
  const files = fs
    .readdirSync(dir)
    .map((name) => {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      return st.isFile() ? { name, mtime: st.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return "";
  return `/media/avatar/${encodeURIComponent(safeId)}/${encodeURIComponent(files[0].name)}`;
}

function normalizeStoredAvatarPath(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  const idx = v.indexOf("/media/avatar/");
  if (idx >= 0) return v.slice(idx);
  return v;
}

function avatarPathExists(mediaPath) {
  const rel = String(mediaPath || "").replace(/^\/media\/avatar\//, "");
  if (!rel) return false;
  const full = path.resolve(AVATAR_DIR, rel);
  const safeRel = path.relative(AVATAR_DIR, full);
  if (safeRel.startsWith("..") || path.isAbsolute(safeRel)) return false;
  return fs.existsSync(full) && fs.statSync(full).isFile();
}

function avatarPathToFull(mediaPath) {
  const rel = String(mediaPath || "").replace(/^\/media\/avatar\//, "");
  if (!rel) return "";
  const full = path.resolve(AVATAR_DIR, rel);
  const safeRel = path.relative(AVATAR_DIR, full);
  if (safeRel.startsWith("..") || path.isAbsolute(safeRel)) return "";
  return full;
}

function resolveProcessCandidates(target) {
  const key = String(target || "").toLowerCase();
  const out = PROCESS_MAP[key];
  return Array.isArray(out) ? out : null;
}

function getNetworkIps() {
  const classifyScope = (address = "") => {
    const v = String(address);
    if (v.includes(":")) return "ipv6";
    const p = v.split(".").map((n) => Number(n));
    if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return "unknown";
    if (p[0] === 10) return "private";
    if (p[0] === 127) return "loopback";
    if (p[0] === 192 && p[1] === 168) return "private";
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return "private";
    if (p[0] === 169 && p[1] === 254) return "link-local";
    return "public";
  };
  const out = [];
  const ifaces = os.networkInterfaces() || {};
  for (const [name, rows] of Object.entries(ifaces)) {
    for (const row of rows || []) {
      if (!row || row.internal) continue;
      out.push({
        iface: name,
        family: row.family,
        address: row.address,
        scope: classifyScope(row.address),
      });
    }
  }
  return out;
}

function getPublicEndpointFromReq(req) {
  return resolvePublicBaseUrl(req);
}

async function runPm2(args) {
  try {
    const { stdout, stderr } = await execFileAsync("pm2", args, { maxBuffer: 1024 * 1024 * 8 });
    return { ok: true, code: null, stdout: String(stdout || ""), stderr: String(stderr || "") };
  } catch (err) {
    const code = String(err?.code || "");
    return {
      ok: false,
      code: code || "PM2_FAILED",
      stdout: String(err?.stdout || ""),
      stderr: String(err?.stderr || err?.message || "pm2 failed"),
    };
  }
}

const DOCKER_SOCK = process.env.DOCKER_SOCK || "/var/run/docker.sock";
const DOCKER_API_PREFIX = process.env.DOCKER_API_PREFIX || "/v1.44";

function dockerApiRequest(method, apiPath, { query = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
    const pathWithVersion = `${DOCKER_API_PREFIX}${apiPath}${qs}`;
    const pathFallback = `${apiPath}${qs}`;
    const payload = body == null ? null : JSON.stringify(body);

    const makeReq = (reqPath, isRetry = false) => {
      const req = http.request(
        {
          socketPath: DOCKER_SOCK,
          path: reqPath,
          method,
          headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            if (!isRetry && res.statusCode === 404 && reqPath.startsWith(DOCKER_API_PREFIX)) {
              return makeReq(pathFallback, true);
            }
            resolve({ status: Number(res.statusCode || 0), body: data, headers: res.headers || {} });
          });
        }
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    };

    makeReq(pathWithVersion);
  });
}

function resolveDockerCandidates(target) {
  const key = String(target || "").toLowerCase();
  const out = DOCKER_PROCESS_MAP[key];
  return Array.isArray(out) ? out : null;
}

async function resolveRunningDockerName(target) {
  const candidates = resolveDockerCandidates(target);
  if (!candidates) return { ok: false, code: "DOCKER_BAD_TARGET", error: "Target muss bot|app sein" };
  for (const name of candidates) {
    try {
      const res = await dockerApiRequest("GET", `/containers/${encodeURIComponent(name)}/json`);
      if (res.status >= 200 && res.status < 300) return { ok: true, code: null, containerName: name };
    } catch {}
  }
  // Fallback: discover by compose service label (works across varying container names)
  const service = String(target || "").toLowerCase() === "app" ? "owner-app" : "bot";
  try {
    const filters = JSON.stringify({ label: [`com.docker.compose.service=${service}`] });
    const byLabel = await dockerApiRequest("GET", "/containers/json", { query: { all: "1", filters } });
    if (byLabel.status >= 200 && byLabel.status < 300) {
      const arr = JSON.parse(byLabel.body || "[]");
      const first = Array.isArray(arr) ? arr[0] : null;
      const name = String(first?.Names?.[0] || "").replace(/^\/+/, "");
      if (name) return { ok: true, code: null, containerName: name };
    }
  } catch {}
  // Last fallback: get all containers and match by suffix
  try {
    const all = await dockerApiRequest("GET", "/containers/json", { query: { all: "1" } });
    if (all.status >= 200 && all.status < 300) {
      const arr = JSON.parse(all.body || "[]");
      const match = (Array.isArray(arr) ? arr : []).find((c) => {
        const names = Array.isArray(c?.Names) ? c.Names.map((n) => String(n || "").replace(/^\/+/, "")) : [];
        return names.some((n) => candidates.some((cand) => n === cand || n.endsWith(`_${cand}_1`) || n.includes(cand)));
      });
      const name = String(match?.Names?.[0] || "").replace(/^\/+/, "");
      if (name) return { ok: true, code: null, containerName: name };
    }
  } catch {}
  return { ok: false, code: "DOCKER_CONTAINER_NOT_FOUND", error: "Container nicht gefunden" };
}

async function dockerContainerAction(containerName, action) {
  const map = { start: "start", stop: "stop", restart: "restart" };
  const safe = map[String(action || "").toLowerCase()];
  if (!safe) return { ok: false, code: "DOCKER_BAD_ACTION", error: "Ungültige Docker-Aktion" };
  try {
    const res = await dockerApiRequest("POST", `/containers/${encodeURIComponent(containerName)}/${safe}`);
    if (res.status >= 200 && res.status < 300) return { ok: true, code: null, error: "" };
    return { ok: false, code: `DOCKER_HTTP_${res.status}`, error: res.body || `Docker API ${res.status}` };
  } catch (err) {
    return { ok: false, code: "DOCKER_FAILED", error: String(err?.message || err || "docker action failed") };
  }
}

async function getDockerStatus(containerName) {
  let res;
  try {
    res = await dockerApiRequest("GET", `/containers/${encodeURIComponent(containerName)}/json`);
  } catch (err) {
    return { ok: false, code: "DOCKER_FAILED", error: String(err?.message || err || "docker inspect failed") };
  }
  if (!(res.status >= 200 && res.status < 300)) {
    return { ok: false, code: `DOCKER_HTTP_${res.status}`, error: res.body || "docker inspect failed" };
  }
  try {
    const inspect = JSON.parse(String(res.body || "").trim() || "{}");
    const state = inspect?.State || {};
    const startedAt = String(state?.StartedAt || "");
    const startedMs = Date.parse(startedAt);
    const uptimeSec = Number.isFinite(startedMs) ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000)) : 0;
    return {
      ok: true,
      code: null,
      data: {
        name: containerName,
        status: String(state?.Status || inspect?.Status || "unknown"),
        uptimeSec,
        restarts: Number(state?.RestartCount ?? inspect?.RestartCount ?? 0),
        pid: Number(state?.Pid ?? 0) || null,
        mode: "docker",
        managed: true,
      },
    };
  } catch {
    return { ok: false, code: "DOCKER_PARSE_ERROR", error: "docker inspect parse failed" };
  }
}

async function getDockerLogs(containerName, lines = 80) {
  const safeLines = Math.max(10, Math.min(500, Number(lines || 80)));
  let res;
  try {
    res = await dockerApiRequest("GET", `/containers/${encodeURIComponent(containerName)}/logs`, {
      query: { stdout: "1", stderr: "1", tail: String(safeLines), timestamps: "1" },
    });
  } catch (err) {
    return { ok: false, code: "DOCKER_FAILED", error: String(err?.message || err || "docker logs failed") };
  }
  if (!(res.status >= 200 && res.status < 300)) {
    return { ok: false, code: `DOCKER_HTTP_${res.status}`, error: res.body || "docker logs failed" };
  }
  const combined = String(res.body || "").trimEnd();
  return {
    ok: true,
    code: null,
    data: {
      processName: containerName,
      lines: safeLines,
      out: combined,
      err: "",
      mode: "docker",
      managed: true,
    },
  };
}

async function getPm2List() {
  const res = await runPm2(["jlist"]);
  if (!res.ok) {
    const code = String(res.code || "");
    const normalized = code === "ENOENT" ? "PM2_UNAVAILABLE" : code || "PM2_FAILED";
    return { ok: false, code: normalized, error: res.stderr };
  }
  let list = [];
  try {
    list = JSON.parse(res.stdout || "[]");
  } catch {
    return { ok: false, code: "PM2_PARSE_ERROR", error: "pm2 jlist parse failed" };
  }
  return { ok: true, code: null, list };
}

async function runShell(command) {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], { maxBuffer: 1024 * 1024 * 16 });
    return { ok: true, stdout: String(stdout || ""), stderr: String(stderr || "") };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err?.stdout || ""),
      stderr: String(err?.stderr || err?.message || "shell failed"),
    };
  }
}

function buildAdminOpCommand(op) {
  const root = PROJECT_ROOT;
  const ownerAndroid = path.resolve(OWNER_DIR, "android");
  const map = {
    pm2_save: "pm2 save",
    pm2_resurrect: "pm2 resurrect",
    restart_bot: "pm2 restart cipherphantom-bot",
    restart_app: "pm2 restart cipherphantom-owner-app",
    restart_all: "pm2 restart cipherphantom-bot && pm2 restart cipherphantom-owner-app",
    git_pull: `cd '${root}' && git pull --ff-only origin main`,
    npm_install: `cd '${root}' && npm install`,
    deploy_now: `cd '${root}' && git pull --ff-only origin main && pm2 restart cipherphantom-bot && pm2 restart cipherphantom-owner-app && pm2 save`,
    apk_build_debug: `cd '${ownerAndroid}' && ./gradlew assembleDebug --no-daemon`,
  };
  return map[String(op || "").trim()] || "";
}

async function runAdminOperation(op, args = {}) {
  const cmd = buildAdminOpCommand(op);
  if (!cmd) return { ok: false, error: `Unbekannte Operation: ${op}` };
  if (op === "deploy_now" && !getAdminFlags().deployEnabled) {
    return { ok: false, error: "Deploy ist per Feature-Flag deaktiviert." };
  }
  if (op === "apk_build_debug" && !getAdminFlags().apkBuildEnabled) {
    return { ok: false, error: "APK-Build ist per Feature-Flag deaktiviert." };
  }
  const result = await runShell(cmd);
  return {
    ok: result.ok,
    op,
    cmd,
    stdout: result.stdout.slice(-12000),
    stderr: result.stderr.slice(-12000),
    args,
  };
}

async function resolveRunningProcessName(target) {
  const candidates = resolveProcessCandidates(target);
  if (!candidates) return { ok: false, error: "Target muss bot|app sein" };
  const listRes = await getPm2List();
  if (!listRes.ok) {
    if (PM2_UNAVAILABLE_CODES.has(String(listRes.code || ""))) {
      return {
        ok: false,
        code: "PM2_UNAVAILABLE",
        error: "Prozesssteuerung über PM2 ist im aktuellen Laufmodus nicht verfügbar.",
      };
    }
    return { ok: false, code: String(listRes.code || "PM2_FAILED"), error: listRes.error };
  }
  const found = candidates.find((name) => listRes.list.some((p) => p?.name === name));
  return { ok: true, code: null, processName: found || candidates[0], list: listRes.list };
}

async function getPm2Status(processName) {
  const listRes = await getPm2List();
  if (!listRes.ok) {
    if (PM2_UNAVAILABLE_CODES.has(String(listRes.code || ""))) {
      return { ok: false, code: "PM2_UNAVAILABLE", error: "PM2 nicht verfügbar" };
    }
    return { ok: false, code: String(listRes.code || "PM2_FAILED"), error: listRes.error };
  }
  const list = listRes.list;
  const row = list.find((p) => p?.name === processName);
  if (!row) return { ok: false, code: "PM2_PROCESS_NOT_FOUND", error: `Process '${processName}' nicht gefunden` };
  const pmUptime = Number(row?.pm2_env?.pm_uptime || 0);
  const uptimeSec = pmUptime > 0 ? Math.max(0, Math.floor((Date.now() - pmUptime) / 1000)) : 0;
  return {
    ok: true,
    code: null,
    data: {
      name: row.name,
      status: row?.pm2_env?.status || "unknown",
      uptimeSec,
      restarts: row?.pm2_env?.restart_time ?? 0,
      pid: row?.pid || null,
    },
  };
}

async function login(res, body) {
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) {
    return json(res, 400, { ok: false, error: "Username und Passwort erforderlich" });
  }
  const row = await getOwnerAuthByUsername(db, username);
  if (!row || !OWNER_IDS.has(row.chat_id)) {
    return json(res, 401, { ok: false, error: "Ungültige Login-Daten" });
  }
  const inputHash = hashPassword(password, row.password_salt);
  const ok = crypto.timingSafeEqual(Buffer.from(inputHash, "hex"), Buffer.from(row.password_hash, "hex"));
  if (!ok) {
    return json(res, 401, { ok: false, error: "Ungültige Login-Daten" });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, {
    token,
    chatId: row.chat_id,
    username: row.profile_name,
    expiresAt,
  });
  persistSessions();
  return json(res, 200, {
    ok: true,
    token,
    expiresAt,
    user: { username: row.profile_name, chatId: row.chat_id },
  });
}

function logout(req, res) {
  const token = getTokenFromReq(req);
  if (token) sessions.delete(token);
  persistSessions();
  return json(res, 200, { ok: true });
}

function normalizePhone(v) {
  return String(v || "").replace(/[^0-9]/g, "");
}

function phoneToJid(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return "";
  return `${digits}@s.whatsapp.net`;
}

async function findUserByPhone(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return null;
  const exact = await db.get(
    `SELECT chat_id, profile_name FROM users
     WHERE chat_id LIKE ? OR chat_id LIKE ?
     LIMIT 1`,
    `${digits}@%`,
    `%${digits}%`
  );
  return exact || null;
}

async function banUser(res, session, body) {
  const phone = String(body.phone || "").trim();
  const reason = String(body.reason || "").trim() || null;
  const durationHours = Number(body.durationHours || 0);
  const target = await findUserByPhone(phone);
  if (!target) {
    return json(res, 404, { ok: false, error: "Kein Nutzer mit dieser Nummer gefunden" });
  }
  if (OWNER_IDS.has(target.chat_id)) {
    return json(res, 400, { ok: false, error: "Owner kann nicht gebannt werden" });
  }
  const expiresAt = durationHours > 0 ? new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString() : null;
  await setBan(db, target.chat_id, reason, expiresAt, session.chatId);
  return json(res, 200, {
    ok: true,
    user: target,
    ban: {
      reason: reason || "Kein Grund",
      expiresAt,
      permanent: !expiresAt,
    },
  });
}

async function unbanUser(res, body) {
  const phone = String(body.phone || "").trim();
  const target = await findUserByPhone(phone);
  if (!target) return json(res, 404, { ok: false, error: "Kein Nutzer mit dieser Nummer gefunden" });
  await clearBan(db, target.chat_id);
  return json(res, 200, { ok: true, user: target });
}

async function queueSingleMessage(res, session, body) {
  const phone = String(body.phone || "").trim();
  const text = String(body.message || "").trim();
  const jid = phoneToJid(phone);
  if (!jid) return json(res, 400, { ok: false, error: "Ungültige Handynummer" });
  if (!text) return json(res, 400, { ok: false, error: "Nachricht fehlt" });
  const signature = `— ${session.username}`;
  await addOwnerOutboxMessage(db, "single", jid, null, text, signature, session.chatId);
  return json(res, 200, { ok: true, queued: true, target: jid });
}

async function queueBroadcast(res, session, body) {
  const text = String(body.message || "").trim();
  const scope = String(body.scope || "users").toLowerCase();
  if (!text) return json(res, 400, { ok: false, error: "Nachricht fehlt" });
  if (!["users", "groups", "all"].includes(scope)) {
    return json(res, 400, { ok: false, error: "scope muss users|groups|all sein" });
  }
  const signature = `— ${session.username}`;
  await addOwnerOutboxMessage(db, "broadcast", null, scope, text, signature, session.chatId);
  return json(res, 200, { ok: true, queued: true, scope });
}

async function getOutbox(res, status, limit) {
  const rows = await listOwnerOutbox(db, status || "all", limit || 100);
  return json(res, 200, { ok: true, rows });
}

async function getProfile(res, session) {
  const user = await getUser(db, session.chatId);
  const dbAvatar = normalizeStoredAvatarPath(user?.profile_photo_url || "");
  const avatarUrl =
    dbAvatar && dbAvatar.startsWith("/media/avatar/") && avatarPathExists(dbAvatar)
      ? dbAvatar
      : findLatestAvatarForChat(session.chatId);
  return json(res, 200, {
    ok: true,
    profile: {
      username: session.username,
      chatId: session.chatId,
      role: user?.user_role || "owner",
      levelRole: user?.level_role || "-",
      level: user?.level ?? "-",
      xp: user?.xp ?? "-",
      phn: user?.phn ?? "-",
      createdAt: user?.created_at || "-",
      wallet: user?.wallet_address || "-",
      bio: user?.profile_bio || "",
      avatarUrl,
    },
  });
}

async function updateProfileBio(res, session, body) {
  const bio = String(body?.bio || "").trim();
  await setUserBiography(db, session.chatId, bio || null);
  return json(res, 200, { ok: true, bio });
}

async function getAvatarCheck(req, res, session) {
  const user = await getUser(db, session.chatId);
  const dbAvatar = normalizeStoredAvatarPath(user?.profile_photo_url || "");
  const dbAvatarExists = dbAvatar && dbAvatar.startsWith("/media/avatar/") && avatarPathExists(dbAvatar);
  const fallbackAvatar = findLatestAvatarForChat(session.chatId);
  const selectedAvatar = dbAvatarExists ? dbAvatar : fallbackAvatar;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  const host = String(req.headers.host || "").trim();
  const selectedAbsolute = selectedAvatar && host ? `${proto}://${host}${selectedAvatar}` : selectedAvatar;

  return json(res, 200, {
    ok: true,
    chatId: session.chatId,
    dbAvatarPath: dbAvatar || null,
    dbAvatarExists: Boolean(dbAvatarExists),
    dbAvatarFile: dbAvatarExists ? avatarPathToFull(dbAvatar) : null,
    fallbackAvatarPath: fallbackAvatar || null,
    fallbackAvatarExists: Boolean(fallbackAvatar && avatarPathExists(fallbackAvatar)),
    selectedAvatarPath: selectedAvatar || null,
    selectedAvatarUrl: selectedAbsolute || null,
  });
}

async function getProcessStatus(res, target) {
  const safeTarget = String(target || "").toLowerCase();
  if (safeTarget === "server") {
    return json(res, 200, {
      ok: true,
      target: "server",
      processName: "server",
      status: {
        status: "online",
        host: os.hostname(),
        uptimeSec: Math.floor(process.uptime()),
        platform: `${process.platform} ${process.arch}`,
        ips: getNetworkIps(),
        rebootAllowed: OWNER_ALLOW_SERVER_REBOOT,
      },
    });
  }

  if (safeTarget === "all") {
    const targets = ["bot", "app"];
    const statuses = {};
    for (const t of targets) {
      const resolved = await resolveRunningProcessName(t);
      if (!resolved.ok) {
        if (resolved.code === "PM2_UNAVAILABLE") {
          const dockerResolved = await resolveRunningDockerName(t);
          if (!dockerResolved.ok) {
            statuses[t] = { ok: false, error: dockerResolved.error };
            continue;
          }
          const dockerStatus = await getDockerStatus(dockerResolved.containerName);
          statuses[t] = dockerStatus.ok
            ? { ok: true, processName: dockerResolved.containerName, status: dockerStatus.data }
            : { ok: false, processName: dockerResolved.containerName, error: dockerStatus.error };
        } else {
          statuses[t] = { ok: false, error: resolved.error };
        }
        continue;
      }
      const status = await getPm2Status(resolved.processName);
      if (!status.ok && status.code === "PM2_UNAVAILABLE") {
        const dockerResolved = await resolveRunningDockerName(t);
        if (!dockerResolved.ok) {
          statuses[t] = { ok: false, error: dockerResolved.error };
          continue;
        }
        const dockerStatus = await getDockerStatus(dockerResolved.containerName);
        statuses[t] = dockerStatus.ok
          ? { ok: true, processName: dockerResolved.containerName, status: dockerStatus.data }
          : { ok: false, processName: dockerResolved.containerName, error: dockerStatus.error };
        continue;
      }
      statuses[t] = status.ok
        ? { ok: true, processName: resolved.processName, status: status.data }
        : { ok: false, processName: resolved.processName, error: status.error };
    }
    return json(res, 200, { ok: true, target: "all", statuses });
  }

  const resolved = await resolveRunningProcessName(safeTarget);
  if (!resolved.ok) {
    if (resolved.code === "PM2_UNAVAILABLE" && (safeTarget === "bot" || safeTarget === "app")) {
      const dockerResolved = await resolveRunningDockerName(safeTarget);
      if (!dockerResolved.ok) return json(res, 500, { ok: false, error: dockerResolved.error });
      const dockerStatus = await getDockerStatus(dockerResolved.containerName);
      if (!dockerStatus.ok) return json(res, 500, { ok: false, error: dockerStatus.error });
      return json(res, 200, {
        ok: true,
        target: safeTarget,
        processName: dockerResolved.containerName,
        status: dockerStatus.data,
      });
    }
    return json(res, 400, { ok: false, error: "Target muss bot|app|all|server sein" });
  }
  const processName = resolved.processName;
  const status = await getPm2Status(processName);
  if (!status.ok) {
    if (status.code === "PM2_UNAVAILABLE" && (safeTarget === "bot" || safeTarget === "app")) {
      const dockerResolved = await resolveRunningDockerName(safeTarget);
      if (!dockerResolved.ok) return json(res, 500, { ok: false, error: dockerResolved.error });
      const dockerStatus = await getDockerStatus(dockerResolved.containerName);
      if (!dockerStatus.ok) return json(res, 500, { ok: false, error: dockerStatus.error });
      return json(res, 200, {
        ok: true,
        target: safeTarget,
        processName: dockerResolved.containerName,
        status: dockerStatus.data,
      });
    }
    return json(res, 500, { ok: false, error: status.error });
  }
  return json(res, 200, { ok: true, target: safeTarget, processName, status: status.data });
}

async function getProcessLogs(res, target, lines = 80) {
  const safeLines = Math.max(10, Math.min(500, Number(lines || 80)));
  const safeTarget = String(target || "").toLowerCase();
  const readTail = (p) => {
    if (!fs.existsSync(p)) return "";
    const all = fs.readFileSync(p, "utf8").split("\n");
    return all.slice(-safeLines).join("\n");
  };
  if (safeTarget === "all") {
    const logs = {};
    for (const t of ["bot", "app"]) {
      const resolved = await resolveRunningProcessName(t);
      if (!resolved.ok) {
        if (resolved.code === "PM2_UNAVAILABLE") {
          const dockerResolved = await resolveRunningDockerName(t);
          if (!dockerResolved.ok) {
            logs[t] = { ok: false, error: dockerResolved.error };
            continue;
          }
          const dockerLogs = await getDockerLogs(dockerResolved.containerName, safeLines);
          logs[t] = dockerLogs.ok
            ? { ok: true, processName: dockerResolved.containerName, lines: safeLines, out: dockerLogs.data.out, err: dockerLogs.data.err }
            : { ok: false, error: dockerLogs.error };
        } else {
          logs[t] = { ok: false, error: resolved.error };
        }
        continue;
      }
      const processName = resolved.processName;
      const outPath = path.resolve(process.env.HOME || "", ".pm2", "logs", `${processName}-out.log`);
      const errPath = path.resolve(process.env.HOME || "", ".pm2", "logs", `${processName}-error.log`);
      logs[t] = {
        ok: true,
        processName,
        lines: safeLines,
        out: readTail(outPath),
        err: readTail(errPath),
      };
    }
    return json(res, 200, { ok: true, target: "all", logs });
  }

  if (safeTarget === "server") {
    const appResolved = await resolveRunningProcessName("app");
    if (!appResolved.ok && appResolved.code === "PM2_UNAVAILABLE") {
      const dockerResolved = await resolveRunningDockerName("app");
      if (!dockerResolved.ok) return json(res, 500, { ok: false, error: dockerResolved.error });
      const dockerLogs = await getDockerLogs(dockerResolved.containerName, safeLines);
      if (!dockerLogs.ok) return json(res, 500, { ok: false, error: dockerLogs.error });
      return json(res, 200, {
        ok: true,
        target: "server",
        processName: dockerResolved.containerName,
        ...dockerLogs.data,
      });
    }
    const processName = appResolved.ok ? appResolved.processName : "cipherphantom-owner-app";
    const outPath = path.resolve(process.env.HOME || "", ".pm2", "logs", `${processName}-out.log`);
    const errPath = path.resolve(process.env.HOME || "", ".pm2", "logs", `${processName}-error.log`);
    const serverErr = appResolved.ok
      ? readTail(errPath)
      : appResolved.code === "PM2_UNAVAILABLE"
        ? "PM2-Logs sind im Docker-/Container-Modus nicht verfügbar."
        : "";
    return json(res, 200, {
      ok: true,
      target: "server",
      processName,
      lines: safeLines,
      out: readTail(outPath),
      err: serverErr,
    });
  }

  const resolved = await resolveRunningProcessName(safeTarget);
  if (!resolved.ok) {
    if (resolved.code === "PM2_UNAVAILABLE" && (safeTarget === "bot" || safeTarget === "app")) {
      const dockerResolved = await resolveRunningDockerName(safeTarget);
      if (!dockerResolved.ok) return json(res, 500, { ok: false, error: dockerResolved.error });
      const dockerLogs = await getDockerLogs(dockerResolved.containerName, safeLines);
      if (!dockerLogs.ok) return json(res, 500, { ok: false, error: dockerLogs.error });
      return json(res, 200, { ok: true, target: safeTarget, ...dockerLogs.data });
    }
    return json(res, 400, { ok: false, error: "Target muss bot|app|all|server sein" });
  }
  const processName = resolved.processName;
  const outPath = path.resolve(process.env.HOME || "", ".pm2", "logs", `${processName}-out.log`);
  const errPath = path.resolve(process.env.HOME || "", ".pm2", "logs", `${processName}-error.log`);
  return json(res, 200, {
    ok: true,
    target: safeTarget,
    processName,
    lines: safeLines,
    out: readTail(outPath),
    err: readTail(errPath),
  });
}

function streamProcessLogs(req, res, target, lines = 80) {
  const safeTarget = String(target || "all").toLowerCase();
  const safeLines = Math.max(10, Math.min(300, Number(lines || 80)));
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const send = async () => {
    const snapshot = await (async () => {
      if (safeTarget === "all") {
        const logs = {};
        for (const t of ["bot", "app"]) {
          const resolved = await resolveRunningProcessName(t);
          if (!resolved.ok) {
            if (resolved.code === "PM2_UNAVAILABLE") {
              const dockerResolved = await resolveRunningDockerName(t);
              if (!dockerResolved.ok) {
                logs[t] = { ok: false, error: dockerResolved.error };
                continue;
              }
              const dockerLogs = await getDockerLogs(dockerResolved.containerName, safeLines);
              logs[t] = dockerLogs.ok
                ? { ok: true, processName: dockerResolved.containerName, out: dockerLogs.data.out, err: dockerLogs.data.err }
                : { ok: false, error: dockerLogs.error };
            } else {
              logs[t] = { ok: false, error: resolved.error };
            }
            continue;
          }
          const processName = resolved.processName;
          const outPath = path.resolve(process.env.HOME || "", ".pm2", "logs", `${processName}-out.log`);
          const errPath = path.resolve(process.env.HOME || "", ".pm2", "logs", `${processName}-error.log`);
          const readTail = (p) => {
            if (!fs.existsSync(p)) return "";
            const all = fs.readFileSync(p, "utf8").split("\n");
            return all.slice(-safeLines).join("\n");
          };
          logs[t] = { ok: true, processName, out: readTail(outPath), err: readTail(errPath) };
        }
        return { ok: true, target: "all", logs };
      }
      const resolved = await resolveRunningProcessName(safeTarget);
      if (!resolved.ok) {
        if (resolved.code === "PM2_UNAVAILABLE" && (safeTarget === "bot" || safeTarget === "app")) {
          const dockerResolved = await resolveRunningDockerName(safeTarget);
          if (!dockerResolved.ok) return { ok: false, error: dockerResolved.error };
          const dockerLogs = await getDockerLogs(dockerResolved.containerName, safeLines);
          if (!dockerLogs.ok) return { ok: false, error: dockerLogs.error };
          return { ok: true, target: safeTarget, processName: dockerResolved.containerName, out: dockerLogs.data.out, err: dockerLogs.data.err };
        }
        return { ok: false, error: resolved.error };
      }
      const processName = resolved.processName;
      const outPath = path.resolve(process.env.HOME || "", ".pm2", "logs", `${processName}-out.log`);
      const errPath = path.resolve(process.env.HOME || "", ".pm2", "logs", `${processName}-error.log`);
      const readTail = (p) => {
        if (!fs.existsSync(p)) return "";
        const all = fs.readFileSync(p, "utf8").split("\n");
        return all.slice(-safeLines).join("\n");
      };
      return { ok: true, target: safeTarget, processName, out: readTail(outPath), err: readTail(errPath) };
    })();
    res.write(`event: logs\n`);
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  };
  send().catch(() => {});
  const timer = setInterval(() => {
    send().catch(() => {});
  }, 1500);
  req.on("close", () => clearInterval(timer));
}

async function processAction(res, target, action, session = null) {
  const safeAction = String(action || "").toLowerCase();
  const safeTarget = String(target || "").toLowerCase();

  if (!["start", "stop", "restart"].includes(safeAction)) {
    return json(res, 400, { ok: false, error: "action muss start|stop|restart sein" });
  }

  if (safeTarget === "server") {
    if (safeAction !== "restart") {
      return json(res, 400, { ok: false, error: "Für server ist nur action=restart erlaubt" });
    }
    if (!OWNER_ALLOW_SERVER_REBOOT) {
      return json(res, 403, { ok: false, error: "Server-Reboot ist deaktiviert (OWNER_ALLOW_SERVER_REBOOT=1 setzen)." });
    }
    await runPm2(["save"]);
    execFile("bash", ["-lc", OWNER_SERVER_REBOOT_CMD], () => {});
    await auditAdminAction(session, "server_restart", safeTarget, { action: safeAction, cmd: OWNER_SERVER_REBOOT_CMD });
    return json(res, 200, {
      ok: true,
      target: "server",
      action: "restart",
      queued: true,
      command: OWNER_SERVER_REBOOT_CMD,
    });
  }

  if (safeTarget === "all") {
    const results = {};
    for (const t of ["bot", "app"]) {
      const resolved = await resolveRunningProcessName(t);
      if (!resolved.ok) {
        if (resolved.code === "PM2_UNAVAILABLE") {
          const dockerResolved = await resolveRunningDockerName(t);
          if (!dockerResolved.ok) {
            results[t] = { ok: false, error: dockerResolved.error };
            continue;
          }
          const dockerResult = await dockerContainerAction(dockerResolved.containerName, safeAction);
          if (!dockerResult.ok) {
            results[t] = { ok: false, processName: dockerResolved.containerName, error: dockerResult.error };
            continue;
          }
          const dockerStatus = await getDockerStatus(dockerResolved.containerName);
          results[t] = dockerStatus.ok
            ? { ok: true, processName: dockerResolved.containerName, status: dockerStatus.data }
            : { ok: false, processName: dockerResolved.containerName, error: dockerStatus.error };
        } else {
          results[t] = { ok: false, error: resolved.error };
        }
        continue;
      }
      const processName = resolved.processName;
      const result = await runPm2([safeAction, processName]);
      if (!result.ok) {
        results[t] = { ok: false, processName, error: result.stderr };
        continue;
      }
      const status = await getPm2Status(processName);
      results[t] = status.ok
        ? { ok: true, processName, status: status.data }
        : { ok: false, processName, error: status.error };
    }
    await auditAdminAction(session, "process_action_all", safeTarget, { action: safeAction, results });
    const entries = Object.values(results);
    const unmanagedOnly =
      entries.length > 0 &&
      entries.every((r) => !r?.ok) &&
      entries.every((r) => /pm2|nicht verfügbar/i.test(String(r?.error || "")));
    return json(
      res,
      unmanagedOnly ? 409 : 200,
      unmanagedOnly
        ? {
            ok: false,
            target: "all",
            action: safeAction,
            error: "Prozesssteuerung ist im Docker-/Container-Modus nicht verfügbar.",
            results,
          }
        : { ok: true, target: "all", action: safeAction, results }
    );
  }

  const resolved = await resolveRunningProcessName(safeTarget);
  if (!resolved.ok) {
    if (resolved.code === "PM2_UNAVAILABLE") {
      const dockerResolved = await resolveRunningDockerName(safeTarget);
      if (!dockerResolved.ok) {
        return json(res, 500, { ok: false, error: dockerResolved.error });
      }
      const result = await dockerContainerAction(dockerResolved.containerName, safeAction);
      if (!result.ok) return json(res, 500, { ok: false, error: result.error });
      const status = await getDockerStatus(dockerResolved.containerName);
      await auditAdminAction(session, "process_action_docker", dockerResolved.containerName, {
        target: safeTarget,
        action: safeAction,
      });
      return json(res, 200, {
        ok: true,
        target: safeTarget,
        processName: dockerResolved.containerName,
        action: safeAction,
        status: status.ok ? status.data : null,
      });
    }
    return json(res, 400, { ok: false, error: "Target muss bot|app|all|server sein" });
  }
  const processName = resolved.processName;
  const result = await runPm2([safeAction, processName]);
  if (!result.ok) return json(res, 500, { ok: false, error: result.stderr });
  const status = await getPm2Status(processName);
  await auditAdminAction(session, "process_action", processName, { target: safeTarget, action: safeAction });
  return json(res, 200, {
    ok: true,
    target: safeTarget,
    processName,
    action: safeAction,
    status: status.ok ? status.data : null,
  });
}

async function getInfo(res) {
  const usersCount = (await db.get("SELECT COUNT(*) AS c FROM users")).c;
  const bansCount = (await db.get("SELECT COUNT(*) AS c FROM bans")).c;
  const questsCount = (await db.get("SELECT COUNT(*) AS c FROM quests")).c;
  const mem = process.memoryUsage();
  return json(res, 200, {
    ok: true,
    server: {
      host: os.hostname(),
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      uptimeSec: Math.floor(process.uptime()),
      totalMemGB: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1),
      freeMemGB: (os.freemem() / 1024 / 1024 / 1024).toFixed(1),
      processMemMB: (mem.rss / 1024 / 1024).toFixed(1),
      loadAvg: os.loadavg(),
      ips: getNetworkIps(),
      rebootAllowed: OWNER_ALLOW_SERVER_REBOOT,
    },
    bot: {
      users: usersCount,
      bans: bansCount,
      quests: questsCount,
      currency: "PHN",
    },
  });
}

async function getServerAdminSummary(req, res) {
  const botResolved = await resolveRunningProcessName("bot");
  const appResolved = await resolveRunningProcessName("app");
  const botStatus = botResolved.ok ? await getPm2Status(botResolved.processName) : { ok: false, error: botResolved.error };
  const appStatus = appResolved.ok ? await getPm2Status(appResolved.processName) : { ok: false, error: appResolved.error };
  let botData = botStatus.ok ? botStatus.data : { status: "unknown", error: botStatus.error };
  let appData = appStatus.ok ? appStatus.data : { status: "unknown", error: appStatus.error };

  const isBotPm2Unavailable = (!botResolved.ok && botResolved.code === "PM2_UNAVAILABLE") || (!botStatus.ok && botStatus.code === "PM2_UNAVAILABLE");
  const isAppPm2Unavailable = (!appResolved.ok && appResolved.code === "PM2_UNAVAILABLE") || (!appStatus.ok && appStatus.code === "PM2_UNAVAILABLE");

  if (isBotPm2Unavailable) {
    const dockerResolved = await resolveRunningDockerName("bot");
    if (dockerResolved.ok) {
      const dockerStatus = await getDockerStatus(dockerResolved.containerName);
      if (dockerStatus.ok) botData = dockerStatus.data;
    }
  }
  if (isAppPm2Unavailable) {
    const dockerResolved = await resolveRunningDockerName("app");
    if (dockerResolved.ok) {
      const dockerStatus = await getDockerStatus(dockerResolved.containerName);
      if (dockerStatus.ok) appData = dockerStatus.data;
    }
  }
  return json(res, 200, {
    ok: true,
    server: {
      host: os.hostname(),
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      uptimeSec: Math.floor(process.uptime()),
      ips: getNetworkIps(),
      publicEndpoint: getPublicEndpointFromReq(req) || null,
      rebootAllowed: OWNER_ALLOW_SERVER_REBOOT,
    },
    processes: {
      bot: botData,
      app: appData,
    },
  });
}

async function getAdminAudit(res, limit = 100) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit || 100)));
  const rows = await listOwnerAuditLogs(db, safeLimit);
  return json(res, 200, { ok: true, rows });
}

async function getAdminUsers(res, limit = 200) {
  const rows = await listUsers(db);
  const sliced = (rows || []).slice(0, Math.max(1, Math.min(2000, Number(limit) || 200)));
  return json(res, 200, {
    ok: true,
    rows: sliced.map((u) => ({
      chat_id: u.chat_id,
      profile_name: u.profile_name,
      user_role: u.user_role,
      level: u.level,
      xp: u.xp,
      phn: u.phn,
    })),
  });
}

async function setAdminUserRole(res, chatId, body, session) {
  const safeChatId = String(chatId || "").trim();
  const role = String(body?.role || "").trim().toLowerCase();
  if (!safeChatId) return json(res, 400, { ok: false, error: "chat_id fehlt" });
  if (!["owner", "admin", "user"].includes(role)) {
    return json(res, 400, { ok: false, error: "role muss owner|admin|user sein" });
  }
  await setUserRole(db, safeChatId, role);
  await auditAdminAction(session, "set_user_role", safeChatId, { role });
  return json(res, 200, { ok: true, chat_id: safeChatId, role });
}

async function listTables(res) {
  const rows = await db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC"
  );
  return json(res, 200, { ok: true, tables: rows.map((r) => r.name) });
}

function quoteIdent(name) {
  return `"${String(name || "").replace(/"/g, '""')}"`;
}

async function getTableColumns(table) {
  const cols = await db.all(`PRAGMA table_info(${quoteIdent(table)})`);
  return (cols || []).map((c) => ({
    name: c.name,
    notnull: Number(c.notnull || 0) === 1,
    pk: Number(c.pk || 0) > 0,
  }));
}

async function listTableRows(res, table, limit, offset, search = "") {
  if (!/^[a-z_]+$/i.test(table)) {
    return json(res, 400, { ok: false, error: "Ungültiger Tabellenname" });
  }
  const allowed = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    table
  );
  if (!allowed) return json(res, 404, { ok: false, error: "Tabelle nicht gefunden" });
  const columns = await getTableColumns(table);
  const safeLimit = Math.min(500, Math.max(1, Number(limit || 50)));
  const safeOffset = Math.max(0, Number(offset || 0));
  const q = String(search || "").trim();
  let rows = [];
  if (q) {
    const like = `%${q}%`;
    const where = columns
      .map((c) => `CAST(${quoteIdent(c.name)} AS TEXT) LIKE ?`)
      .join(" OR ");
    const params = columns.map(() => like);
    rows = await db.all(
      `SELECT rowid AS __rowid, * FROM ${quoteIdent(table)} WHERE ${where} LIMIT ? OFFSET ?`,
      ...params,
      safeLimit,
      safeOffset
    );
  } else {
    rows = await db.all(
      `SELECT rowid AS __rowid, * FROM ${quoteIdent(table)} LIMIT ? OFFSET ?`,
      safeLimit,
      safeOffset
    );
  }
  return json(res, 200, { ok: true, table, limit: safeLimit, offset: safeOffset, q, columns, rows });
}

async function insertTableRow(res, table, payload) {
  if (!/^[a-z_]+$/i.test(table)) {
    return json(res, 400, { ok: false, error: "Ungültiger Tabellenname" });
  }
  const allowed = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    table
  );
  if (!allowed) return json(res, 404, { ok: false, error: "Tabelle nicht gefunden" });
  const data = payload && typeof payload === "object" ? payload : null;
  if (!data || Array.isArray(data) || Object.keys(data).length === 0) {
    return json(res, 400, { ok: false, error: "data-Objekt erforderlich" });
  }
  const columns = await getTableColumns(table);
  const allowedCols = new Set(columns.map((c) => c.name));
  const keys = Object.keys(data).filter((k) => allowedCols.has(k));
  if (keys.length === 0) {
    return json(res, 400, { ok: false, error: "Keine gültigen Spalten übergeben" });
  }
  const placeholders = keys.map(() => "?").join(", ");
  const values = keys.map((k) => (data[k] === undefined ? null : data[k]));
  const sql = `INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(", ")}) VALUES (${placeholders})`;
  const result = await db.run(sql, ...values);
  return json(res, 200, { ok: true, table, rowid: result?.lastID || null });
}

async function updateTableRow(res, table, rowid, payload) {
  if (!/^[a-z_]+$/i.test(table)) {
    return json(res, 400, { ok: false, error: "Ungültiger Tabellenname" });
  }
  const rid = Number(rowid);
  if (!Number.isFinite(rid) || rid <= 0) {
    return json(res, 400, { ok: false, error: "Ungültige Row-ID" });
  }
  const allowed = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    table
  );
  if (!allowed) return json(res, 404, { ok: false, error: "Tabelle nicht gefunden" });
  const data = payload && typeof payload === "object" ? payload : null;
  if (!data || Array.isArray(data) || Object.keys(data).length === 0) {
    return json(res, 400, { ok: false, error: "data-Objekt erforderlich" });
  }
  const columns = await getTableColumns(table);
  const allowedCols = new Set(columns.map((c) => c.name));
  const keys = Object.keys(data).filter((k) => allowedCols.has(k));
  if (keys.length === 0) {
    return json(res, 400, { ok: false, error: "Keine gültigen Spalten übergeben" });
  }
  const setSql = keys.map((k) => `${quoteIdent(k)} = ?`).join(", ");
  const values = keys.map((k) => (data[k] === undefined ? null : data[k]));
  const sql = `UPDATE ${quoteIdent(table)} SET ${setSql} WHERE rowid = ?`;
  const result = await db.run(sql, ...values, rid);
  return json(res, 200, { ok: true, table, rowid: rid, changed: result?.changes || 0 });
}

async function deleteTableRow(res, table, rowid) {
  if (!/^[a-z_]+$/i.test(table)) {
    return json(res, 400, { ok: false, error: "Ungültiger Tabellenname" });
  }
  const rid = Number(rowid);
  if (!Number.isFinite(rid) || rid <= 0) {
    return json(res, 400, { ok: false, error: "Ungültige Row-ID" });
  }
  const allowed = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    table
  );
  if (!allowed) return json(res, 404, { ok: false, error: "Tabelle nicht gefunden" });
  const result = await db.run(`DELETE FROM ${quoteIdent(table)} WHERE rowid = ?`, rid);
  return json(res, 200, { ok: true, table, rowid: rid, deleted: result?.changes || 0 });
}

async function getTableRowById(res, table, rowid) {
  if (!/^[a-z_]+$/i.test(table)) {
    return json(res, 400, { ok: false, error: "Ungültiger Tabellenname" });
  }
  const rid = Number(rowid);
  if (!Number.isFinite(rid) || rid <= 0) {
    return json(res, 400, { ok: false, error: "Ungültige Row-ID" });
  }
  const allowed = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    table
  );
  if (!allowed) return json(res, 404, { ok: false, error: "Tabelle nicht gefunden" });
  const columns = await getTableColumns(table);
  const row = await db.get(`SELECT rowid AS __rowid, * FROM ${quoteIdent(table)} WHERE rowid = ?`, rid);
  if (!row) return json(res, 404, { ok: false, error: "Datensatz nicht gefunden" });
  return json(res, 200, { ok: true, table, rowid: rid, columns, row });
}

async function listAllBans(res) {
  const bans = await listBans(db);
  return json(res, 200, { ok: true, rows: bans });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = (url.pathname || "/").replace(/\/+$/g, "") || "/";

    if (req.method === "GET" && pathname === "/metrics") {
      const h = await collectHealthSnapshot();
      const lines = [
        "# HELP owner_app_up Owner app health snapshot (1=ok,0=fail)",
        "# TYPE owner_app_up gauge",
        `owner_app_up ${h.ok ? 1 : 0}`,
        "# HELP owner_app_db_up Database check (1=ok,0=fail)",
        "# TYPE owner_app_db_up gauge",
        `owner_app_db_up ${h.checks.db.ok ? 1 : 0}`,
        "# HELP owner_app_pm2_up PM2 summary check (1=ok,0=fail)",
        "# TYPE owner_app_pm2_up gauge",
        `owner_app_pm2_up ${h.checks.pm2.ok ? 1 : 0}`,
        "# HELP owner_app_disk_up Disk free check (1=ok,0=fail)",
        "# TYPE owner_app_disk_up gauge",
        `owner_app_disk_up ${h.checks.disk.ok ? 1 : 0}`,
        "# HELP owner_app_process_rss_bytes Node RSS memory bytes",
        "# TYPE owner_app_process_rss_bytes gauge",
        `owner_app_process_rss_bytes ${h.runtime.rssBytes}`,
        "# HELP owner_app_process_uptime_seconds Node uptime in seconds",
        "# TYPE owner_app_process_uptime_seconds gauge",
        `owner_app_process_uptime_seconds ${h.runtime.uptimeSec}`,
        "# HELP owner_app_pm2_online Number of relevant PM2 processes online",
        "# TYPE owner_app_pm2_online gauge",
        `owner_app_pm2_online ${Number(h.checks.pm2.online || 0)}`,
      ];
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(`${lines.join("\n")}\n`);
      return;
    }

    if (pathname.startsWith("/api/")) {
      // Public endpoints for bootstrap/update-check (no login required)
      if (req.method === "GET" && pathname === "/api/healthz") {
        const health = await collectHealthSnapshot();
        return json(res, health.ok ? 200 : 503, health);
      }

      if (req.method === "GET" && pathname === "/api/app-meta") {
        const props = readLocalProps();
        const apkFile = resolveApkFilePath(props);
        const integrity = getApkIntegrityMeta(apkFile);
        const publicBaseUrl = resolvePublicBaseUrl(req);
        const panelVersion = getOwnerPanelVersion();
        const metaUpdatedAt = getMetaUpdatedAt();
        const latestFromProps = Number(props.OWNER_APK_VERSION_CODE || 0);
        const latestVersionCode = Number.isFinite(latestFromProps) && latestFromProps > 0
          ? latestFromProps
          : LATEST_APK_VERSION;
        const minFromProps = Number(props.OWNER_MIN_APK_VERSION || 0);
        const minVersionCode = Number.isFinite(minFromProps) && minFromProps > 0
          ? minFromProps
          : MIN_APK_VERSION;
        const apkDownloadUrl =
          String(props.OWNER_APK_DOWNLOAD_URL || "").trim() ||
          APK_DOWNLOAD_URL ||
          (publicBaseUrl ? `${publicBaseUrl}/downloads/latest.apk` : "") ||
          null;
        const serverUrl = publicBaseUrl || `http://${HOST}:${PORT}`;

        return json(res, 200, {
          ok: true,
          panelVersion,
          latestVersionCode,
          minVersionCode,
          apkDownloadUrl,
          apkSha256: integrity.apkSha256,
          apkSizeBytes: integrity.apkSizeBytes,
          serverUrl,
          ts: metaUpdatedAt,
        });
      }

      if (req.method === "POST" && pathname === "/api/login") {
        const limited = applyRateLimit(req, "login");
        if (limited.limited) return rateLimitExceeded(res, limited);
        const body = await parseBody(req);
        return login(res, body);
      }

      // Limit authenticated API traffic globally (except bootstrap endpoints above)
      const apiLimited = applyRateLimit(req, "api");
      if (apiLimited.limited) return rateLimitExceeded(res, apiLimited);

      if (req.method === "POST" && pathname === "/api/logout") {
        const session = requireAuth(req, res);
        if (!session) return;
        return logout(req, res);
      }

      if (req.method === "GET" && pathname === "/api/info") {
        const session = requireAuth(req, res);
        if (!session) return;
        return getInfo(res);
      }

      if (req.method === "GET" && pathname === "/api/admin/summary") {
        const session = requireAuth(req, res);
        if (!session) return;
        return getServerAdminSummary(req, res);
      }

      if (req.method === "GET" && pathname === "/api/admin/alerts") {
        const session = requireAuth(req, res);
        if (!session) return;
        const out = await collectAlerts();
        return json(res, 200, out);
      }

      if (req.method === "GET" && pathname === "/api/admin/flags") {
        const session = requireAuth(req, res);
        if (!session) return;
        return json(res, 200, { ok: true, flags: getAdminFlags() });
      }

      if (req.method === "POST" && pathname === "/api/admin/flags") {
        const session = requireAuth(req, res);
        if (!session) return;
        const body = await parseBody(req);
        const flags = setAdminFlags(body || {});
        await auditAdminAction(session, "set_flags", "flags", flags);
        return json(res, 200, { ok: true, flags });
      }

      if (req.method === "POST" && pathname === "/api/admin/op") {
        const session = requireAuth(req, res);
        if (!session) return;
        const body = await parseBody(req);
        const op = String(body?.op || "").trim();
        const result = await runAdminOperation(op, body?.args || {});
        await auditAdminAction(session, "admin_op", op, { ok: result.ok });
        return json(res, result.ok ? 200 : 500, result);
      }

      if (req.method === "GET" && pathname === "/api/admin/jobs") {
        const session = requireAuth(req, res);
        if (!session) return;
        return json(res, 200, { ok: true, rows: readAdminJobs() });
      }

      if (req.method === "POST" && pathname === "/api/admin/jobs") {
        const session = requireAuth(req, res);
        if (!session) return;
        const body = await parseBody(req);
        const job = upsertAdminJob({
          op: String(body?.op || "").trim(),
          runAt: String(body?.runAt || new Date(Date.now() + 60_000).toISOString()),
          status: "queued",
        });
        await auditAdminAction(session, "job_create", job.id, { op: job.op, runAt: job.runAt });
        return json(res, 200, { ok: true, job });
      }

      if (req.method === "DELETE" && pathname.startsWith("/api/admin/jobs/")) {
        const session = requireAuth(req, res);
        if (!session) return;
        const jobId = decodeURIComponent(pathname.replace("/api/admin/jobs/", "")).trim();
        deleteAdminJob(jobId);
        await auditAdminAction(session, "job_delete", jobId, null);
        return json(res, 200, { ok: true, id: jobId });
      }

      if (req.method === "GET" && pathname === "/api/admin/audit") {
        const session = requireAuth(req, res);
        if (!session) return;
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 100)));
        return getAdminAudit(res, limit);
      }

      if (req.method === "GET" && pathname === "/api/admin/users") {
        const session = requireAuth(req, res);
        if (!session) return;
        const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") || 200)));
        return getAdminUsers(res, limit);
      }

      if (req.method === "POST" && pathname.startsWith("/api/admin/users/") && pathname.endsWith("/role")) {
        const session = requireAuth(req, res);
        if (!session) return;
        const chatId = decodeURIComponent(pathname.replace("/api/admin/users/", "").replace("/role", ""));
        const body = await parseBody(req);
        return setAdminUserRole(res, chatId, body, session);
      }

      if (req.method === "GET" && pathname === "/api/ping") {
        const session = requireAuth(req, res);
        if (!session) return;
        return json(res, 200, { ok: true, user: session.username, chatId: session.chatId });
      }

      if (req.method === "GET" && pathname === "/api/me") {
        const session = requireAuth(req, res);
        if (!session) return;
        return getProfile(res, session);
      }

      if (req.method === "POST" && pathname === "/api/me/bio") {
        const session = requireAuth(req, res);
        if (!session) return;
        const body = await parseBody(req);
        return updateProfileBio(res, session, body);
      }

      if (req.method === "GET" && pathname === "/api/avatar-check") {
        const session = requireAuth(req, res);
        if (!session) return;
        return getAvatarCheck(req, res, session);
      }

      if (req.method === "GET" && pathname === "/api/db/tables") {
        const session = requireAuth(req, res);
        if (!session) return;
        return listTables(res);
      }

      if (pathname.startsWith("/api/db/")) {
        const session = requireAuth(req, res);
        if (!session) return;
        const tail = decodeURIComponent(pathname.replace("/api/db/", "")).trim();
        const parts = tail.split("/").filter(Boolean);
        const root = parts[0] || "";
        if (req.method === "GET" && root === "maintenance" && parts[1] === "check") {
          const check = await runDbIntegrityCheck();
          return json(res, check.ok ? 200 : 500, { ok: check.ok, integrity: check.result });
        }
        if (req.method === "GET" && root === "maintenance") {
          let dbStat = null;
          try {
            const st = fs.statSync(DB_FILE);
            dbStat = { sizeBytes: st.size, updatedAt: st.mtime.toISOString() };
          } catch {
            dbStat = null;
          }
          return json(res, 200, {
            ok: true,
            dbFile: DB_FILE,
            db: dbStat,
            backupDir: DB_BACKUP_DIR,
            keep: DB_BACKUP_KEEP,
            backups: listDbBackups(20),
          });
        }
        if (req.method === "POST" && root === "backup") {
          const out = await createDbBackup();
          return json(res, 200, { ok: true, backup: out });
        }
        if (req.method === "GET" && root === "backups" && parts.length === 1) {
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
          return json(res, 200, {
            ok: true,
            backupDir: DB_BACKUP_DIR,
            keep: DB_BACKUP_KEEP,
            rows: listDbBackups(limit),
          });
        }
        if (req.method === "GET" && root === "backups" && parts.length === 2) {
          return sendDbBackup(res, parts[1]);
        }
        const table = parts[0] || "";
        const mode = parts[1] || "";
        const rowid = parts[2] || "";
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 50)));
        const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
        const q = String(url.searchParams.get("q") || "");
        if (req.method === "GET" && !mode) {
          return listTableRows(res, table, limit, offset, q);
        }
        if (req.method === "GET" && mode === "row" && rowid) {
          return getTableRowById(res, table, rowid);
        }
        if (req.method === "POST" && mode === "row") {
          const body = await parseBody(req);
          return insertTableRow(res, table, body.data || body);
        }
        if (req.method === "PATCH" && mode === "row" && rowid) {
          const body = await parseBody(req);
          return updateTableRow(res, table, rowid, body.data || body);
        }
        if (req.method === "DELETE" && mode === "row" && rowid) {
          return deleteTableRow(res, table, rowid);
        }
        return json(res, 404, { ok: false, error: "Unbekannter DB-Endpoint" });
      }

      if (req.method === "POST" && pathname === "/api/ban") {
        const session = requireAuth(req, res);
        if (!session) return;
        const body = await parseBody(req);
        return banUser(res, session, body);
      }

      if (req.method === "POST" && pathname === "/api/unban") {
        const session = requireAuth(req, res);
        if (!session) return;
        const body = await parseBody(req);
        return unbanUser(res, body);
      }

      if (req.method === "GET" && pathname === "/api/bans") {
        const session = requireAuth(req, res);
        if (!session) return;
        return listAllBans(res);
      }

      if (req.method === "POST" && pathname === "/api/message") {
        const session = requireAuth(req, res);
        if (!session) return;
        const body = await parseBody(req);
        return queueSingleMessage(res, session, body);
      }

      if (req.method === "POST" && pathname === "/api/broadcast") {
        const session = requireAuth(req, res);
        if (!session) return;
        const body = await parseBody(req);
        return queueBroadcast(res, session, body);
      }

      if (req.method === "GET" && pathname === "/api/outbox") {
        const session = requireAuth(req, res);
        if (!session) return;
        const status = String(url.searchParams.get("status") || "all").toLowerCase();
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 100)));
        return getOutbox(res, status, limit);
      }

      if (req.method === "GET" && pathname.startsWith("/api/process/") && pathname.endsWith("/status")) {
        const session = requireAuth(req, res);
        if (!session) return;
        const target = pathname.split("/")[3] || "";
        return getProcessStatus(res, target);
      }

      if (req.method === "GET" && pathname.startsWith("/api/process/") && pathname.endsWith("/logs")) {
        const session = requireAuth(req, res);
        if (!session) return;
        const target = pathname.split("/")[3] || "";
        const lines = Number(url.searchParams.get("lines") || 80);
        return getProcessLogs(res, target, lines);
      }

      if (req.method === "GET" && pathname.startsWith("/api/process/") && pathname.endsWith("/stream")) {
        const session = requireAuth(req, res);
        if (!session) return;
        const target = pathname.split("/")[3] || "";
        const lines = Number(url.searchParams.get("lines") || 80);
        return streamProcessLogs(req, res, target, lines);
      }

      if (req.method === "POST" && pathname.startsWith("/api/process/") && pathname.endsWith("/action")) {
        const limited = applyRateLimit(req, "processAction");
        if (limited.limited) return rateLimitExceeded(res, limited);
        const session = requireAuth(req, res);
        if (!session) return;
        const target = pathname.split("/")[3] || "";
        const body = await parseBody(req);
        return processAction(res, target, body.action, session);
      }

      return json(res, 404, {
        ok: false,
        error: "API route not found",
        method: req.method || "-",
        path: pathname,
      });
    }

    if ((req.method === "GET" || req.method === "HEAD") && pathname === "/downloads/latest.apk") {
      const props = readLocalProps();
      const apkFile = resolveApkFilePath(props);
      return sendApk(req.method, res, apkFile);
    }

    if (req.method === "GET" && pathname.startsWith("/media/avatar/")) {
      const fileName = decodeURIComponent(pathname.replace("/media/avatar/", "")).trim();
      return sendAvatar(res, fileName);
    }

    return sendStatic(req, res);
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message || "Server error" });
  }
});

startAdminJobsWorker();
loadPersistedSessions();

server.listen(PORT, HOST, () => {
  logStartupOverview();
  console.log(`[owner-app] sessions_loaded=${sessions.size} store=${SESSION_STORE_FILE}`);
});
