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
const PORT = Number(process.env.OWNER_APP_PORT || 8787);
const HOST = String(process.env.OWNER_APP_HOST || "0.0.0.0");
const LATEST_APK_VERSION = Number(process.env.OWNER_LATEST_APK_VERSION || 1);
const MIN_APK_VERSION = Number(process.env.OWNER_MIN_APK_VERSION || 1);
const APK_DOWNLOAD_URL = String(process.env.OWNER_APK_DOWNLOAD_URL || "").trim();
const OWNER_IDS = new Set(
  String(process.env.OWNER_IDS || "72271934840903@lid")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);

const sessions = new Map();
const SESSION_TTL_HOURS = Math.max(1, Number(process.env.OWNER_SESSION_TTL_HOURS || 12));
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;
const execFileAsync = promisify(execFile);
const PROCESS_MAP = {
  bot: ["cipherphantom-bot"],
  app: ["cipherphantom-owner-app", "cipherphantom-owner-remote"],
};

const db = await initDb();
const rateLimitState = new Map();
const RATE_LIMITS = {
  login: { windowMs: 15 * 60 * 1000, max: 12 },
  api: { windowMs: 60 * 1000, max: 180 },
  processAction: { windowMs: 60 * 1000, max: 30 },
};

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
  return null;
}

function getSession(req) {
  const token = getTokenFromReq(req);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
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
  if (!full.startsWith(WEB_DIR)) return null;
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

function resolveApkFilePath(props = {}) {
  const candidate = String(props.OWNER_APK_FILE || "").trim();
  return candidate || process.env.OWNER_APK_FILE || DEFAULT_APK_FILE;
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

function sendApk(res, filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return json(res, 404, { ok: false, error: "APK not found" });
  }
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Length": content.length,
    "Cache-Control": "no-store",
    "Content-Disposition": "attachment; filename=\"cipherphantom-owner-latest.apk\"",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(content);
}

function sendAvatar(res, fileName) {
  const rel = String(fileName || "").replace(/^\/+/, "");
  if (!rel) return json(res, 400, { ok: false, error: "Bad file" });
  const full = path.resolve(AVATAR_DIR, rel);
  if (!full.startsWith(AVATAR_DIR)) return json(res, 400, { ok: false, error: "Bad path" });
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
  if (!full.startsWith(AVATAR_DIR)) return false;
  return fs.existsSync(full) && fs.statSync(full).isFile();
}

function avatarPathToFull(mediaPath) {
  const rel = String(mediaPath || "").replace(/^\/media\/avatar\//, "");
  if (!rel) return "";
  const full = path.resolve(AVATAR_DIR, rel);
  if (!full.startsWith(AVATAR_DIR)) return "";
  return full;
}

function resolveProcessCandidates(target) {
  const key = String(target || "").toLowerCase();
  const out = PROCESS_MAP[key];
  return Array.isArray(out) ? out : null;
}

async function runPm2(args) {
  try {
    const { stdout, stderr } = await execFileAsync("pm2", args, { maxBuffer: 1024 * 1024 * 8 });
    return { ok: true, stdout: String(stdout || ""), stderr: String(stderr || "") };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err?.stdout || ""),
      stderr: String(err?.stderr || err?.message || "pm2 failed"),
    };
  }
}

async function getPm2List() {
  const res = await runPm2(["jlist"]);
  if (!res.ok) return { ok: false, error: res.stderr };
  let list = [];
  try {
    list = JSON.parse(res.stdout || "[]");
  } catch {
    return { ok: false, error: "pm2 jlist parse failed" };
  }
  return { ok: true, list };
}

async function resolveRunningProcessName(target) {
  const candidates = resolveProcessCandidates(target);
  if (!candidates) return { ok: false, error: "Target muss bot|app sein" };
  const listRes = await getPm2List();
  if (!listRes.ok) return { ok: false, error: listRes.error };
  const found = candidates.find((name) => listRes.list.some((p) => p?.name === name));
  return { ok: true, processName: found || candidates[0], list: listRes.list };
}

async function getPm2Status(processName) {
  const listRes = await getPm2List();
  if (!listRes.ok) return { ok: false, error: listRes.error };
  const list = listRes.list;
  const row = list.find((p) => p?.name === processName);
  if (!row) return { ok: false, error: `Process '${processName}' nicht gefunden` };
  const pmUptime = Number(row?.pm2_env?.pm_uptime || 0);
  const uptimeSec = pmUptime > 0 ? Math.max(0, Math.floor((Date.now() - pmUptime) / 1000)) : 0;
  return {
    ok: true,
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
  const resolved = await resolveRunningProcessName(target);
  if (!resolved.ok) return json(res, 400, { ok: false, error: resolved.error });
  const processName = resolved.processName;
  const status = await getPm2Status(processName);
  if (!status.ok) return json(res, 500, { ok: false, error: status.error });
  return json(res, 200, { ok: true, target, processName, status: status.data });
}

async function getProcessLogs(res, target, lines = 80) {
  const resolved = await resolveRunningProcessName(target);
  if (!resolved.ok) return json(res, 400, { ok: false, error: resolved.error });
  const processName = resolved.processName;
  const safeLines = Math.max(10, Math.min(500, Number(lines || 80)));
  const outPath = path.resolve(process.env.HOME || "", ".pm2", "logs", `${processName}-out.log`);
  const errPath = path.resolve(process.env.HOME || "", ".pm2", "logs", `${processName}-error.log`);
  const readTail = (p) => {
    if (!fs.existsSync(p)) return "";
    const all = fs.readFileSync(p, "utf8").split("\n");
    return all.slice(-safeLines).join("\n");
  };
  return json(res, 200, {
    ok: true,
    target,
    processName,
    lines: safeLines,
    out: readTail(outPath),
    err: readTail(errPath),
  });
}

async function processAction(res, target, action) {
  const resolved = await resolveRunningProcessName(target);
  const safeAction = String(action || "").toLowerCase();
  if (!resolved.ok) return json(res, 400, { ok: false, error: resolved.error });
  const processName = resolved.processName;
  if (!["start", "stop", "restart"].includes(safeAction)) {
    return json(res, 400, { ok: false, error: "action muss start|stop|restart sein" });
  }
  const result = await runPm2([safeAction, processName]);
  if (!result.ok) return json(res, 500, { ok: false, error: result.stderr });
  const status = await getPm2Status(processName);
  return json(res, 200, {
    ok: true,
    target,
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
    },
    bot: {
      users: usersCount,
      bans: bansCount,
      quests: questsCount,
      currency: "PHN",
    },
  });
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

    if (pathname.startsWith("/api/")) {
      // Public endpoints for bootstrap/update-check (no login required)
      if (req.method === "GET" && pathname === "/api/healthz") {
        return json(res, 200, {
          ok: true,
          service: "cipherphantom-owner-app",
          ts: new Date().toISOString(),
        });
      }

      if (req.method === "GET" && pathname === "/api/app-meta") {
        const props = readLocalProps();
        const apkFile = resolveApkFilePath(props);
        const integrity = getApkIntegrityMeta(apkFile);
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
          null;

        return json(res, 200, {
          ok: true,
          panelVersion,
          latestVersionCode,
          minVersionCode,
          apkDownloadUrl,
          apkSha256: integrity.apkSha256,
          apkSizeBytes: integrity.apkSizeBytes,
          serverUrl: `http://${HOST}:${PORT}`,
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

      if (req.method === "POST" && pathname.startsWith("/api/process/") && pathname.endsWith("/action")) {
        const limited = applyRateLimit(req, "processAction");
        if (limited.limited) return rateLimitExceeded(res, limited);
        const session = requireAuth(req, res);
        if (!session) return;
        const target = pathname.split("/")[3] || "";
        const body = await parseBody(req);
        return processAction(res, target, body.action);
      }

      return json(res, 404, {
        ok: false,
        error: "API route not found",
        method: req.method || "-",
        path: pathname,
      });
    }

    if (req.method === "GET" && pathname === "/downloads/latest.apk") {
      const props = readLocalProps();
      const apkFile = resolveApkFilePath(props);
      return sendApk(res, apkFile);
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

server.listen(PORT, HOST, () => {
  logStartupOverview();
});
