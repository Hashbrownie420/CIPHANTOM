import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadContentFromMessage,
} from "@whiskeysockets/baileys";
import P from "pino";
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import crypto from "crypto";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import PDFDocument from "pdfkit";
import {
  initDb,
  getUser,
  createUser,
  setProfileName,
  setUserProfilePhoto,
  setUserBiography,
  setBalance,
  addBalance,
  addXp,
  setDaily,
  setWeekly,
  setDsgvoAccepted,
  setUserRole,
  setLevelRole,
  setNameChange,
  setGameDailyProfit,
  setPreDsgvoAccepted,
  getPreDsgvoAccepted,
  clearPreDsgvoAccepted,
  setWalletAddress,
  getUserByWalletAddress,
  getFriendByCode,
  addFriend,
  listFriends,
  listUsers,
  listQuests,
  getQuestByKey,
  ensureUserQuest,
  getUserQuest,
  updateQuestProgress,
  completeQuest,
  claimQuest,
  deleteUser,
  dumpAll,
  getCharacter,
  createCharacter,
  updateCharacter,
  setBan,
  getBan,
  clearBan,
  listBans,
  addOwnerTodo,
  listOwnerTodos,
  updateOwnerTodo,
  deleteOwnerTodo,
  setOwnerTodoStatus,
  upsertErrorLog,
  listErrorLogs,
  getErrorLogById,
  addFixQueueEntry,
  listFixQueue,
  updateFixQueueStatus,
  getFixQueueEntry,
  addOwnerAuditLog,
  listOwnerAuditLogs,
  upsertKnownChat,
  listKnownChats,
  addOwnerOutboxMessage,
  listPendingOwnerOutbox,
  markOwnerOutboxSent,
  markOwnerOutboxFailed,
  listOwnerOutbox,
  getCommandHelpEntry,
  listCommandHelpEntries,
  searchCommandHelpEntries,
  upsertCommandHelpEntry,
  deleteCommandHelpEntry,
  upsertOwnerPasswordHash,
} from "./db.js";

// Pfad-Utilities fuer ES Modules (kein __dirname von Haus aus)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Speicherorte fuer Daten und WhatsApp-Session
const DATA_DIR = path.resolve(__dirname, "..", "data");
const PREFIX_FILE = path.join(DATA_DIR, "prefixes.json");
const INBOX_DIR = path.join(DATA_DIR, "inbox");
const ERROR_EXPORT_DIR = path.join(DATA_DIR, "errors");
const AVATAR_DIR = path.join(DATA_DIR, "avatars");
const OWNER_ANDROID_DIR = path.resolve(__dirname, "..", "owner-app", "android");
const OWNER_LOCAL_PROPERTIES = path.join(OWNER_ANDROID_DIR, "local.properties");
const OWNER_APK_PATH = path.join(
  OWNER_ANDROID_DIR,
  "app",
  "build",
  "outputs",
  "apk",
  "debug",
  "app-debug.apk",
);
const OWNER_APP_URL_STATE_FILE = path.join(DATA_DIR, "owner-app-url-state.json");
const AUTH_DIR = path.resolve(__dirname, "..", "auth");
const CURRENCY = "PHN";
const CURRENCY_NAME = "Phantoms";
const DSGVO_VERSION = "2026-02-09";
const pendingDeletes = new Map();
const OWNER_IDS = new Set(["72271934840903@lid"]);
const pendingNameChanges = new Map();
const pendingPurchases = new Map();
const GAME_DAILY_PROFIT_CAP = Number.POSITIVE_INFINITY;
const HOUSE_EDGE = 0;
const GAME_COOLDOWN_MS = 5 * 60 * 1000;
const lastGameAt = new Map();
const XP_LEVEL_FACTOR = 350;
const MAX_TRANSFER_PHN = 1000;
const blackjackSessions = new Map();
const stackerSessions = new Map();
const CHAR_PRICE = 500;
const WORK_COOLDOWN_HOURS = 3;
let runtimeDb = null;
let runtimeSock = null;
let messageCutoffSec = 0;
let lastDisconnectInfo = null;
let startupSelftestIssues = [];
let startupSelftestSent = false;
const BOOT_TS = Date.now();
let ownerOutboxTimer = null;
let ownerOutboxBusy = false;
const execFileAsync = promisify(execFile);
let ownerApkWatcherTimer = null;
let ownerApkBuildRunning = false;
const OWNER_APK_AUTOBUILD_ENABLED = String(process.env.OWNER_APK_AUTOBUILD || "1").trim() !== "0";
const OWNER_APP_PM2_NAMES = ["cipherphantom-owner-app", "cipherphantom-owner-remote"];

// Einfache ANSI-Farben fuer Terminal-Ausgabe
const COLORS = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  bold: "\x1b[1m",
};

// Logger: farbig + Emojis + kurzer deutscher Zeitstempel
function log(type, msg) {
  const ts = new Date().toLocaleString("de-DE", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  let color = COLORS.gray;
  let icon = "•";
  if (type === "qr") {
    color = COLORS.cyan;
    icon = "📱";
  }
  if (type === "open") {
    color = COLORS.green;
    icon = "✅";
  }
  if (type === "close") {
    color = COLORS.yellow;
    icon = "⚠️";
  }
  if (type === "cmd") {
    color = COLORS.cyan;
    icon = "🧩";
  }
  if (type === "error") {
    color = COLORS.red;
    icon = "❌";
  }
  const line = `${COLORS.cyan}[${ts}]${COLORS.reset} ${color}${icon} ${msg}${COLORS.reset}`;
  console.log(line);
}

function formatError(err) {
  if (!err) return "unknown error";
  if (err instanceof Error) {
    return err.stack || `${err.name}: ${err.message}`;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function makeErrorId() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `ERR-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePhoneDigits(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function phoneToJid(value) {
  const digits = normalizePhoneDigits(value);
  if (!digits) return "";
  return `${digits}@s.whatsapp.net`;
}

function normalizeTargetToJid(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes("@")) return raw;
  return phoneToJid(raw);
}

async function syncUserAvatar(db, sock, chatId) {
  if (!chatId || !chatId.includes("@")) return;
  try {
    await saveAvatarForChat(db, sock, chatId);
  } catch {
    // ignore (private/no profile image/restricted)
  }
}

async function syncUserBiography(db, sock, userChatId, candidates = []) {
  if (!userChatId || !String(userChatId).includes("@")) return;
  const tryIds = [];
  const addTry = (v) => {
    const t = String(v || "").trim();
    if (!t || !t.includes("@")) return;
    if (!tryIds.includes(t)) tryIds.push(t);
  };
  addTry(userChatId);
  for (const c of candidates) addTry(c);
  for (const c of [...tryIds]) {
    if (c.endsWith("@lid")) {
      addTry(c.replace(/@lid$/i, "@s.whatsapp.net"));
    }
  }
  for (const c of [...tryIds]) {
    const digits = normalizePhoneDigits(c);
    if (!digits) continue;
    try {
      const exists = await sock.onWhatsApp(digits);
      for (const row of exists || []) {
        if (row?.jid) addTry(row.jid);
      }
    } catch {
      // ignore
    }
  }

  // Prefer a real existing users.chat_id row for storage.
  let targetChatId = "";
  for (const jid of tryIds) {
    const u = await getUser(db, jid);
    if (u?.chat_id) {
      targetChatId = u.chat_id;
      break;
    }
  }
  if (!targetChatId) {
    for (const jid of tryIds) {
      const digits = normalizePhoneDigits(jid);
      if (!digits) continue;
      const row = await db.get(
        "SELECT chat_id FROM users WHERE chat_id LIKE ? OR chat_id LIKE ? LIMIT 1",
        `${digits}%@s.whatsapp.net`,
        `${digits}%@lid`
      );
      if (row?.chat_id) {
        targetChatId = row.chat_id;
        break;
      }
    }
  }
  if (!targetChatId) {
    targetChatId = userChatId;
  }

  for (const jid of tryIds) {
    try {
      const st = await sock.fetchStatus(jid);
      const bio = String(st?.status || "").trim();
      if (!bio) continue;
      await setUserBiography(db, targetChatId, bio);
      log("cmd", `Bio aktualisiert fuer ${targetChatId} (via ${jid})`);
      return;
    } catch {
      // try next jid variant
    }
  }
}

async function debugUserBiographyFetch(db, sock, userChatId, candidates = []) {
  const tryIds = [];
  const addTry = (v) => {
    const t = String(v || "").trim();
    if (!t || !t.includes("@")) return;
    if (!tryIds.includes(t)) tryIds.push(t);
  };
  addTry(userChatId);
  for (const c of candidates) addTry(c);
  for (const c of [...tryIds]) {
    if (c.endsWith("@lid")) addTry(c.replace(/@lid$/i, "@s.whatsapp.net"));
  }
  for (const c of [...tryIds]) {
    const digits = normalizePhoneDigits(c);
    if (!digits) continue;
    try {
      const exists = await sock.onWhatsApp(digits);
      for (const row of exists || []) {
        if (row?.jid) addTry(row.jid);
      }
    } catch {
      // ignore
    }
  }

  const lines = [`Ziel: ${userChatId}`, `Kandidaten: ${tryIds.length}`];
  let savedBio = "";
  let savedVia = "";
  for (const jid of tryIds) {
    try {
      const st = await sock.fetchStatus(jid);
      const bio = String(st?.status || "").trim();
      lines.push(`${jid} => ${bio || "<leer>"}`);
      if (!savedBio && bio) {
        savedBio = bio;
        savedVia = jid;
      }
    } catch (err) {
      lines.push(`${jid} => FEHLER: ${String(err?.message || err || "unknown").slice(0, 120)}`);
    }
  }
  if (savedBio) {
    await setUserBiography(db, userChatId, savedBio);
    lines.push(`Gespeichert via: ${savedVia}`);
  } else {
    lines.push("Keine Bio aus fetchStatus erhalten.");
  }
  return lines;
}

function avatarExtFromMime(mime, fallback = ".jpg") {
  const m = String(mime || "").toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("webp")) return ".webp";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("gif")) return ".gif";
  return fallback;
}

async function saveAvatarForChat(db, sock, chatId) {
  const picUrl = await sock.profilePictureUrl(chatId, "image");
  if (!picUrl) throw new Error("Kein Profilbild gefunden.");
  const res = await fetch(picUrl);
  if (!res.ok) throw new Error(`Profilbild Download fehlgeschlagen (${res.status})`);
  const arr = await res.arrayBuffer();
  const buf = Buffer.from(arr);
  if (!buf.length) throw new Error("Leeres Profilbild.");
  if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const ext = avatarExtFromMime(res.headers.get("content-type"), ".jpg");
  const safeId = String(chatId).replace(/[^a-zA-Z0-9._-]/g, "_");
  const userDir = path.join(AVATAR_DIR, safeId);
  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
  const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
  const fileName = `avatar-${hash}${ext}`;
  const filePath = path.join(userDir, fileName);

  const existing = fs
    .readdirSync(userDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name);
  const hasSameFile = existing.includes(fileName);

  if (!hasSameFile) {
    fs.writeFileSync(filePath, buf);
  }

  const publicPath = `/media/avatar/${encodeURIComponent(safeId)}/${encodeURIComponent(fileName)}`;
  await setUserProfilePhoto(db, chatId, publicPath);
  return { publicPath, filePath, size: buf.length, changed: !hasSameFile };
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

async function getPm2Proc(name) {
  const res = await runPm2(["jlist"]);
  if (!res.ok) return null;
  try {
    const list = JSON.parse(res.stdout || "[]");
    return list.find((p) => p?.name === name) || null;
  } catch {
    return null;
  }
}

async function getFirstPm2Proc(names) {
  for (const name of names) {
    const proc = await getPm2Proc(name);
    if (proc) return proc;
  }
  return null;
}

function getPm2LogPath(processName, stream = "out") {
  const home = process.env.HOME || "";
  return path.join(home, ".pm2", "logs", `${processName}-${stream}.log`);
}

function tailFileSafe(filePath, lines = 40) {
  try {
    if (!fs.existsSync(filePath)) return "";
    const all = fs.readFileSync(filePath, "utf8").split("\n");
    return all.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function readOwnerLocalProperties() {
  try {
    if (!fs.existsSync(OWNER_LOCAL_PROPERTIES)) {
      return { appUrl: "", versionCode: 0, apkDownloadUrl: "" };
    }
    const txt = fs.readFileSync(OWNER_LOCAL_PROPERTIES, "utf8");
    const appUrl = (txt.match(/^OWNER_APP_URL=(.+)$/m)?.[1] || "").trim();
    const versionCode = Number((txt.match(/^OWNER_APK_VERSION_CODE=(.+)$/m)?.[1] || "0").trim()) || 0;
    const apkDownloadUrl = (txt.match(/^OWNER_APK_DOWNLOAD_URL=(.+)$/m)?.[1] || "").trim();
    return { appUrl, versionCode, apkDownloadUrl };
  } catch {
    return { appUrl: "", versionCode: 0, apkDownloadUrl: "" };
  }
}

function parseOwnerVersionCode(versionCode) {
  const code = Math.max(0, Number(versionCode || 0) || 0);
  const major = Math.floor(code / 10000);
  const minor = Math.floor((code % 10000) / 100);
  const patch = code % 100;
  return { major, minor, patch, code };
}

function composeOwnerVersionCode(major, minor, patch) {
  const safeMajor = Math.max(0, Number(major || 0) || 0);
  const safeMinor = Math.max(0, Math.min(99, Number(minor || 0) || 0));
  const safePatch = Math.max(0, Math.min(99, Number(patch || 0) || 0));
  return safeMajor * 10000 + safeMinor * 100 + safePatch;
}

function formatOwnerVersion(versionCode) {
  const v = parseOwnerVersionCode(versionCode);
  return `v${v.major}.${v.minor}.${v.patch}`;
}

function bumpOwnerVersionCode(versionCode, bumpType = "patch") {
  const current = parseOwnerVersionCode(versionCode);
  let { major, minor, patch } = current;
  const t = String(bumpType || "patch").toLowerCase();
  if (t === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (t === "minor") {
    minor += 1;
    patch = 0;
    if (minor > 99) {
      major += 1;
      minor = 0;
    }
  } else {
    patch += 1;
    if (patch > 99) {
      patch = 0;
      minor += 1;
      if (minor > 99) {
        major += 1;
        minor = 0;
      }
    }
  }
  return composeOwnerVersionCode(major, minor, patch);
}

function inferOwnerVersionBumpType(input) {
  const text = String(input || "").toLowerCase();
  if (!text) return "patch";
  if (/(^|\s)(major|breaking|release|rewrite|umbau|neuaufbau)(\s|$)/.test(text)) return "major";
  if (/(^|\s)(minor|feature|feat|funktion|neu)(\s|$)/.test(text)) return "minor";
  if (/(^|\s)(patch|fix|hotfix|bug|fehler)(\s|$)/.test(text)) return "patch";
  return "patch";
}

function writeOwnerLocalProperty(key, value) {
  const line = `${key}=${value}`;
  let txt = "";
  if (fs.existsSync(OWNER_LOCAL_PROPERTIES)) {
    txt = fs.readFileSync(OWNER_LOCAL_PROPERTIES, "utf8");
  }
  const hasKey = new RegExp(`^${key}=`, "m").test(txt);
  if (hasKey) {
    txt = txt.replace(new RegExp(`^${key}=.*$`, "m"), line);
  } else {
    const suffix = txt.endsWith("\n") || txt.length === 0 ? "" : "\n";
    txt = `${txt}${suffix}${line}\n`;
  }
  fs.writeFileSync(OWNER_LOCAL_PROPERTIES, txt, "utf8");
}

function bumpOwnerLocalVersionForBuild(hintText = "") {
  const current = readOwnerLocalProperties();
  const fromCode = Number(current.versionCode || 0) || 0;
  const baseCode = fromCode > 0 ? fromCode : 1;
  const bumpType = inferOwnerVersionBumpType(hintText);
  const nextCode = bumpOwnerVersionCode(baseCode, bumpType);
  writeOwnerLocalProperty("OWNER_APK_VERSION_CODE", String(nextCode));
  return {
    bumpType,
    prevCode: baseCode,
    nextCode,
    prevVersion: formatOwnerVersion(baseCode),
    nextVersion: formatOwnerVersion(nextCode),
  };
}

function readOwnerAppUrlState() {
  try {
    if (!fs.existsSync(OWNER_APP_URL_STATE_FILE))
      return {
        lastUrl: "",
        lastVersionCode: 0,
        builtAt: null,
        lastSendOk: false,
        pendingSend: false,
        lastAttemptAt: null,
        lastError: null,
      };
    const raw = fs.readFileSync(OWNER_APP_URL_STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    return {
      lastUrl: String(data?.lastUrl || ""),
      lastVersionCode: Number(data?.lastVersionCode || 0) || 0,
      builtAt: data?.builtAt || null,
      lastSendOk: Boolean(data?.lastSendOk),
      pendingSend: Boolean(data?.pendingSend),
      lastAttemptAt: data?.lastAttemptAt || null,
      lastError: data?.lastError ? String(data.lastError) : null,
    };
  } catch {
    return {
      lastUrl: "",
      lastVersionCode: 0,
      builtAt: null,
      lastSendOk: false,
      pendingSend: false,
      lastAttemptAt: null,
      lastError: null,
    };
  }
}

function writeOwnerAppUrlState({ url, versionCode, sendOk }) {
  const prev = readOwnerAppUrlState();
  const payload = {
    lastUrl: url || "",
    lastVersionCode: Number(versionCode || 0) || 0,
    builtAt: new Date().toISOString(),
    lastSendOk: Boolean(sendOk),
    pendingSend: sendOk ? false : true,
    lastAttemptAt: new Date().toISOString(),
    lastError: sendOk ? null : prev.lastError || null,
  };
  fs.writeFileSync(OWNER_APP_URL_STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
}

function updateOwnerAppUrlStatePartial(partial) {
  const prev = readOwnerAppUrlState();
  const payload = {
    lastUrl: prev.lastUrl || "",
    lastVersionCode: Number(prev.lastVersionCode || 0) || 0,
    builtAt: prev.builtAt || null,
    lastSendOk: Boolean(prev.lastSendOk),
    pendingSend: Boolean(prev.pendingSend),
    lastAttemptAt: prev.lastAttemptAt || null,
    lastError: prev.lastError || null,
    ...partial,
  };
  fs.writeFileSync(OWNER_APP_URL_STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
}

async function sendLatestOwnerApkToOwners(sock, reason = "send") {
  const lp = readOwnerLocalProperties();
  if (!fs.existsSync(OWNER_APK_PATH)) {
    throw new Error("APK nicht gefunden.");
  }
  const apk = fs.readFileSync(OWNER_APK_PATH);
  const infoLines = [
    `APP_URL: ${lp.appUrl || "-"}`,
    `VersionCode: ${lp.versionCode || "-"}`,
    `Datei: ${path.basename(OWNER_APK_PATH)}`,
    `Groesse: ${formatBytes(apk.length)}`,
    `Grund: ${reason}`,
  ];
  let sentOk = true;
  let lastErr = null;
  for (const ownerId of OWNER_IDS) {
    try {
      await sock.sendMessage(ownerId, {
        document: apk,
        fileName: `owner-app-${new Date().toISOString().replace(/[:.]/g, "-")}.apk`,
        mimetype: "application/vnd.android.package-archive",
        caption: formatMessage("Owner APK Auto-Build", infoLines, "", "📦", {
          user: "Owner",
          command: "auto-build",
        }),
      });
    } catch (sendErr) {
      sentOk = false;
      lastErr = formatError(sendErr).slice(0, 240);
      const fallbackLines = [
        "APK konnte nicht direkt gesendet werden.",
        `Fehler: ${lastErr}`,
        lp.apkDownloadUrl ? `Download: ${lp.apkDownloadUrl}` : "Download-Link nicht gesetzt.",
      ];
      try {
        await sendPlain(sock, ownerId, "Owner APK Auto-Build Fallback", fallbackLines, "", "⚠️");
      } catch {
        // ignore
      }
    }
  }
  updateOwnerAppUrlStatePartial({
    lastSendOk: sentOk,
    pendingSend: !sentOk,
    lastAttemptAt: new Date().toISOString(),
    lastError: sentOk ? null : lastErr,
  });
  return sentOk;
}

async function buildOwnerApkAndSend(sock, url, reason = "watcher") {
  if (ownerApkBuildRunning) return;
  ownerApkBuildRunning = true;
  try {
    const lp = readOwnerLocalProperties();
    const resolvedUrl = url || lp.appUrl;
    const versionCode = lp.versionCode || 0;
    log("cmd", `Owner-APK Auto-Build gestartet (${reason}) fuer URL: ${resolvedUrl}`);
    log("cmd", `APK Build ${renderProgressBar(0)} Start`);
    const { stdout, stderr } = await runGradleBuildWithProgress();
    if (!fs.existsSync(OWNER_APK_PATH)) {
      throw new Error("APK nicht gefunden nach Build.");
    }
    const sentOk = await sendLatestOwnerApkToOwners(sock, `${reason}/post-build`);
    writeOwnerAppUrlState({ url: resolvedUrl, versionCode, sendOk: sentOk });
    if (stderr?.trim()) {
      log("close", `Gradle stderr (gekürzt): ${stderr.trim().slice(0, 180)}`);
    }
    if (stdout?.trim()) {
      log("open", "Owner-APK Build abgeschlossen.");
    }
  } catch (err) {
    const lp = readOwnerLocalProperties();
    writeOwnerAppUrlState({ url: url || lp.appUrl, versionCode: lp.versionCode, sendOk: false });
    await recordError("owner_apk_autobuild", err, "autobuild", "owner-app");
    const text = formatError(err).slice(0, 900);
    for (const ownerId of OWNER_IDS) {
      try {
        await sendPlain(sock, ownerId, "Owner APK Auto-Build fehlgeschlagen", [text], "", "❌");
      } catch {
        // ignore
      }
    }
  } finally {
    ownerApkBuildRunning = false;
  }
}

function startOwnerApkUrlWatcher(sock) {
  if (!OWNER_APK_AUTOBUILD_ENABLED) {
    log("info", "Owner-APK Auto-Build ist deaktiviert (OWNER_APK_AUTOBUILD=0).");
    return;
  }
  if (ownerApkWatcherTimer) return;
  ownerApkWatcherTimer = setInterval(() => {
    const lp = readOwnerLocalProperties();
    const currentUrl = lp.appUrl;
    const currentVersionCode = lp.versionCode || 0;
    if (!currentUrl) return;
    const state = readOwnerAppUrlState();
    const urlChanged = state.lastUrl !== currentUrl;
    const versionChanged = Number(state.lastVersionCode || 0) !== currentVersionCode;
    const lastAttemptTs = state.lastAttemptAt ? new Date(state.lastAttemptAt).getTime() : 0;
    const retryDue = !state.lastSendOk && Date.now() - lastAttemptTs > 60 * 1000;
    if (!urlChanged && !versionChanged && !retryDue) return;
    if (urlChanged || versionChanged) {
      buildOwnerApkAndSend(sock, currentUrl, "url-change").catch(() => {});
      return;
    }
    // Retry should only re-send the already built APK, not rebuild every minute.
    sendLatestOwnerApkToOwners(sock, "retry-send").catch(() => {});
  }, 15000);
}

async function flushPendingOwnerApkSend(sock) {
  if (!OWNER_APK_AUTOBUILD_ENABLED) return;
  const st = readOwnerAppUrlState();
  if (!st.pendingSend) return;
  try {
    log("cmd", "Owner-APK Pending-Send wird nach Verbindung versucht.");
    await sendLatestOwnerApkToOwners(sock, "reconnect-pending");
  } catch (err) {
    updateOwnerAppUrlStatePartial({
      lastSendOk: false,
      pendingSend: true,
      lastAttemptAt: new Date().toISOString(),
      lastError: formatError(err).slice(0, 240),
    });
  }
}

function renderProgressBar(percent, width = 20) {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}] ${p}%`;
}

async function runGradleBuildWithProgress() {
  return new Promise((resolve, reject) => {
    const child = spawn("./gradlew", ["assembleDebug"], {
      cwd: OWNER_ANDROID_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lastPercent = 0;
    let out = "";
    let err = "";
    const bump = (pct, label) => {
      if (pct <= lastPercent) return;
      lastPercent = pct;
      log("cmd", `APK Build ${renderProgressBar(pct)} ${label}`);
    };

    child.stdout.on("data", (buf) => {
      const text = String(buf || "");
      out += text;
      if (/CONFIGURING/.test(text)) bump(10, "Konfiguration");
      if (/Task .*:compile/i.test(text)) bump(35, "Compile");
      if (/Task .*:merge/i.test(text)) bump(55, "Merge");
      if (/Task .*:packageDebug/i.test(text)) bump(80, "Packaging");
      if (/BUILD SUCCESSFUL/i.test(text)) bump(100, "Fertig");
    });

    child.stderr.on("data", (buf) => {
      const text = String(buf || "");
      err += text;
      if (/deprecated/i.test(text)) bump(65, "Warnungen");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout: out, stderr: err });
      reject(new Error(`Gradle failed (code=${code})\n${(err || out).slice(-1200)}`));
    });
  });
}

function hashOwnerPassword(password, salt = null) {
  const usedSalt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, usedSalt, 120000, 32, "sha256").toString("hex");
  return { hash, salt: usedSalt };
}

function inferSeverity(source, err) {
  if (source === "startup" || source === "uncaught_exception") return "fatal";
  if (source === "reconnect" || source === "unhandled_rejection") return "error";
  if (source === "error_notify_user") return "warn";
  if (err instanceof Error && /timeout|network|socket/i.test(err.message)) return "warn";
  return "error";
}

function makeErrorFingerprint(source, command, errorText) {
  return `${source}|${command || "-"}|${errorText}`.slice(0, 900);
}

async function recordError(source, err, command = null, chatId = null) {
  const errorText = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const errorStack = err instanceof Error ? err.stack : null;
  const severity = inferSeverity(source, err);
  const fingerprint = makeErrorFingerprint(source, command, errorText);
  const newErrorId = makeErrorId();
  let persisted = { errorId: newErrorId, deduped: false, occurrences: 1, lastSeenAt: new Date().toISOString() };

  try {
    if (runtimeDb) {
      persisted = await upsertErrorLog(
        runtimeDb,
        newErrorId,
        severity,
        source,
        command,
        chatId,
        fingerprint,
        errorText,
        errorStack,
      );
    }
  } catch (dbErr) {
    log("error", `[${newErrorId}] Fehler beim Speichern in DB: ${formatError(dbErr)}`);
  }

  const errorId = persisted.errorId || newErrorId;
  log(
    "error",
    `[${errorId}] severity=${severity} count=${persisted.occurrences || 1} ${source} | cmd=${command || "-"} | chat=${chatId || "-"} | ${errorText}`,
  );
  if (errorStack && !persisted.deduped) {
    log("error", `[${errorId}] stack: ${errorStack}`);
  }

  if (runtimeSock) {
    const ownerMsg = [
      `Fehler-ID: ${errorId}`,
      `Zeit: ${formatDateTime(persisted.lastSeenAt || new Date().toISOString())}`,
      `Severity: ${severity}`,
      `Count: ${persisted.occurrences || 1}`,
      `Quelle: ${source}`,
      `Befehl: ${command || "-"}`,
      `Chat: ${chatId || "-"}`,
      `Fehler: ${errorText}`,
    ];
    for (const ownerId of OWNER_IDS) {
      try {
        await sendPlain(runtimeSock, ownerId, "Bot-Fehler", ownerMsg, "", "⚠️");
      } catch {
        // Owner-Notify darf nie den eigentlichen Fehlerfluss blockieren
      }
    }
  }

  return errorId;
}

function toSingleLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function buildMessageMeta(m, fallbackCommand = "system", fallbackUser = "Nutzer") {
  const user = toSingleLine(m?.pushName) || toSingleLine(m?.key?.participant) || fallbackUser;
  const raw = getText(m?.message);
  const command = toSingleLine(raw.split("\n")[0]) || fallbackCommand;
  return { user, command };
}

function formatMessage(title, lines = [], footer = "", emoji = "ℹ️", meta = null) {
  const user = meta?.user || "Nutzer";
  const command = meta?.command || "system";
  const innerWidth = 29;
  const border = `+${"-".repeat(innerWidth + 2)}+`;
  const divider = "_".repeat(innerWidth + 4);
  const fit = (value, max = innerWidth) => {
    const text = String(value || "");
    if (text.length <= max) return text;
    if (max <= 3) return text.slice(0, max);
    return `${text.slice(0, max - 3)}...`;
  };
  const line = (value, align = "left") => {
    const text = fit(value, innerWidth);
    if (align === "center") {
      const left = Math.max(0, Math.floor((innerWidth - text.length) / 2));
      const right = Math.max(0, innerWidth - text.length - left);
      return `| ${" ".repeat(left)}${text}${" ".repeat(right)} |`;
    }
    return `| ${text.padEnd(innerWidth, " ")} |`;
  };
  let out = "";
  out += `${border}\n`;
  out += `${line("CIPHERPHANTOM", "center")}\n`;
  out += `${border}\n`;
  out += `Hallo ${user}\n`;
  out += `Befehl: ${command}\n`;
  out += `${divider}\n`;
  out += `${emoji} ${title}`;
  if (lines.length) {
    out += "\n" + lines.map((l) => `- ${l}`).join("\n");
  }
  if (footer) out += `\n${divider}\n${footer}`;
  return `\`\`\`\n${out}\n\`\`\``;
}

async function sendText(sock, chatId, m, title, lines, footer, emoji) {
  const meta = buildMessageMeta(m, "system");
  return sock.sendMessage(
    chatId,
    { text: formatMessage(title, lines, footer, emoji, meta) },
    { quoted: m },
  );
}

async function sendPlain(sock, chatId, title, lines, footer, emoji) {
  const meta = { user: "Nutzer", command: "system" };
  return sock.sendMessage(chatId, {
    text: formatMessage(title, lines, footer, emoji, meta),
  });
}

async function syncDb(db) {
  if (!db) return;
  await db.exec("PRAGMA wal_checkpoint(PASSIVE)");
}

async function resolveOutboxTargets(db, job) {
  if (job.type === "single") {
    return job.target_id ? [job.target_id] : [];
  }
  if (job.type !== "broadcast") return [];

  if (job.target_scope === "users") {
    const users = await listUsers(db);
    return users.map((u) => u.chat_id).filter(Boolean);
  }
  if (job.target_scope === "groups") {
    const chats = await listKnownChats(db, true);
    return chats.map((c) => c.chat_id).filter(Boolean);
  }
  if (job.target_scope === "all") {
    const users = await listUsers(db);
    const groups = await listKnownChats(db, true);
    return [...new Set([...users.map((u) => u.chat_id), ...groups.map((g) => g.chat_id)].filter(Boolean))];
  }
  return [];
}

async function resolveBroadcastTargets(db, scope) {
  const mode = String(scope || "users").toLowerCase();
  if (mode === "users") {
    const users = await listUsers(db);
    return users.map((u) => u.chat_id).filter(Boolean);
  }
  if (mode === "groups") {
    const groups = await listKnownChats(db, true);
    return groups.map((g) => g.chat_id).filter(Boolean);
  }
  if (mode === "all") {
    const users = await listUsers(db);
    const groups = await listKnownChats(db, true);
    return [...new Set([...users.map((u) => u.chat_id), ...groups.map((g) => g.chat_id)].filter(Boolean))];
  }
  return [];
}

function buildOwnerOutboxText(job) {
  const msg = String(job.message || "").trim();
  const signature = String(job.signature || "").trim();
  if (!signature) return msg;
  return `${msg}\n\n${signature}`;
}

async function processOwnerOutbox(db, sock) {
  if (!db || !sock || ownerOutboxBusy) return;
  ownerOutboxBusy = true;
  try {
    const jobs = await listPendingOwnerOutbox(db, 15);
    for (const job of jobs) {
      try {
        const targets = await resolveOutboxTargets(db, job);
        if (!targets.length) {
          await markOwnerOutboxFailed(db, job.id, "Keine Ziel-Chats gefunden.");
          continue;
        }
        const text = buildOwnerOutboxText(job);
        let success = 0;
        let fails = 0;
        for (const chatId of targets) {
          try {
            await sock.sendMessage(chatId, { text });
            success += 1;
            await wait(180);
          } catch {
            fails += 1;
          }
        }
        if (success > 0) {
          await markOwnerOutboxSent(db, job.id);
        } else {
          await markOwnerOutboxFailed(db, job.id, `Versand fehlgeschlagen (${fails}/${targets.length})`);
        }
      } catch (err) {
        await markOwnerOutboxFailed(db, job.id, formatError(err).slice(0, 500));
      }
    }
  } catch (err) {
    await recordError("owner_outbox_worker", err).catch(() => {});
  } finally {
    ownerOutboxBusy = false;
  }
}

async function runStartupSelftest(db) {
  const issues = [];
  const requiredDirs = [DATA_DIR, INBOX_DIR, ERROR_EXPORT_DIR, AVATAR_DIR];
  for (const dir of requiredDirs) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (err) {
      issues.push(`Ordner nicht beschreibbar: ${dir} (${formatError(err)})`);
    }
  }

  try {
    const requiredTables = ["users", "quests", "error_logs", "owner_todos", "fix_queue", "owner_audit_logs"];
    const rows = await db.all("SELECT name FROM sqlite_master WHERE type='table'");
    const names = new Set(rows.map((r) => r.name));
    for (const t of requiredTables) {
      if (!names.has(t)) issues.push(`Tabelle fehlt: ${t}`);
    }
  } catch (err) {
    issues.push(`Tabellenpruefung fehlgeschlagen: ${formatError(err)}`);
  }

  try {
    const cols = await db.all("PRAGMA table_info(users)");
    const names = new Set(cols.map((c) => c.name));
    for (const c of ["wallet_address", "user_role", "level_role"]) {
      if (!names.has(c)) issues.push(`users.${c} fehlt`);
    }
  } catch (err) {
    issues.push(`Spaltenpruefung fehlgeschlagen: ${formatError(err)}`);
  }

  return issues;
}

const OWNER_AUDIT_COMMANDS = new Set([
  "chatid",
  "ownerlogin",
  "ownercred",
  "ownerpass",
  "syncroles",
  "dbdump",
  "ban",
  "unban",
  "bans",
  "setphn",
  "purge",
  "todo",
  "errors",
  "error",
  "errorfile",
  "sendpc",
  "pcupload",
  "sendmsg",
  "broadcast",
  "outbox",
  "apppanel",
  "appstart",
  "appstop",
  "apprestart",
  "applogs",
  "saveavatar",
  "health",
  "fix",
  "audits",
  "helpadd",
  "helpedit",
  "helpdel",
  "helplist",
  "biodebug",
  "setbio",
  "showbio",
  "clearbio",
]);

async function auditOwnerCommand(db, senderId, cmd, args, chatId) {
  if (!isOwner(senderId) || !OWNER_AUDIT_COMMANDS.has(cmd)) return;
  const target = args?.[0] || null;
  const payload = JSON.stringify({ args: args || [], chatId });
  try {
    await addOwnerAuditLog(db, senderId, cmd, target, payload);
  } catch (err) {
    await recordError("owner_audit", err, cmd, chatId);
  }
}

// Bytes menschenlesbar formatieren (KB/MB/GB)
function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// Sekunden in lesbare Uptime umrechnen
function formatUptime(seconds) {
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor((seconds / 3600) % 24);
  const d = Math.floor(seconds / 86400);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`, `${s}s`);
  return parts.join(" ");
}

// Start-Banner mit Systeminfos ausgeben
function printBanner() {
  const title = "CIPHERPHANTOM";
  const pad = 2;
  const width = title.length + pad * 2;
  const top = `┌${"─".repeat(width)}┐`;
  const mid = `│${" ".repeat(pad)}${title}${" ".repeat(pad)}│`;
  const bot = `└${"─".repeat(width)}┘`;

  // System-RAM
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memLine = `${formatBytes(usedMem)} / ${formatBytes(totalMem)} RAM`;

  // RAM-Nutzung des Bots selbst
  const procMem = process.memoryUsage();
  const procLine = `Bot RAM: ${formatBytes(procMem.rss)}`;

  // CPU-Load (1 Minute)
  const load = os.loadavg()[0]?.toFixed(2) ?? "0.00";
  const cpuLine = `CPU Load (1m): ${load}`;

  // Prozess-Uptime (wie lange der Bot laeuft)
  const upLine = `Uptime: ${formatUptime(process.uptime())}`;

  // System-Infos
  const hostLine = `Host: ${os.hostname()} (${os.platform()} ${os.arch()})`;
  const coresLine = `CPU Cores: ${os.cpus()?.length || 0}`;
  const nodeLine = `Node.js: ${process.version}`;

  console.log(
    `${COLORS.magenta}${COLORS.bold}${top}\n${mid}\n${bot}${COLORS.reset}`,
  );
  console.log(`${COLORS.bold}System Overview${COLORS.reset}`);
  console.log(`- ${hostLine}`);
  console.log(`- ${coresLine}`);
  console.log(`- ${cpuLine}`);
  console.log(`- ${memLine}`);
  console.log(`- ${procLine}`);
  console.log(`- ${upLine}`);
  console.log(`- ${nodeLine}`);
  console.log("");
}

function runtimeStatsLine() {
  const load1 = os.loadavg()[0]?.toFixed(2) ?? "0.00";
  const mem = process.memoryUsage();
  return `uptime=${formatUptime(process.uptime())} rss=${formatBytes(mem.rss)} heap=${formatBytes(mem.heapUsed)}/${formatBytes(mem.heapTotal)} load1=${load1}`;
}

// Zufalls-Freundescode generieren
function generateFriendCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

// Datum als YYYY-MM-DD
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ISO-Woche als YYYY-WW
function isoWeekStr(date = new Date()) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  const weekStr = String(week).padStart(2, "0");
  return `${d.getUTCFullYear()}-${weekStr}`;
}

// XP -> Level (einfache Progression)
function xpToLevel(xp) {
  return Math.floor(Math.sqrt(xp / XP_LEVEL_FACTOR)) + 1;
}

function xpToNextLevel(xp) {
  const level = xpToLevel(xp);
  const nextAt = Math.pow(level, 2) * XP_LEVEL_FACTOR;
  return Math.max(0, nextAt - xp);
}

// Nutzerrolle: Owner oder User (Owner ist fest im Code verdrahtet)
function getUserRole(senderId) {
  return OWNER_IDS.has(senderId) ? "owner" : "user";
}

// Levelrolle abhaengig vom Level
function getLevelRole(level) {
  if (level >= 30) return "Legend";
  if (level >= 20) return "Elite";
  if (level >= 10) return "Pro";
  if (level >= 5) return "Adept";
  return "Rookie";
}

// Owner bekommen unsichtbar x2 auf PHN/XP
function rewardMultiplier(senderId) {
  return OWNER_IDS.has(senderId) ? 2 : 1;
}

function isOwner(senderId) {
  return OWNER_IDS.has(senderId);
}

// Karten fuer Blackjack (unendliches Deck)
function drawCard() {
  const ranks = [
    "A",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "J",
    "Q",
    "K",
  ];
  return ranks[Math.floor(Math.random() * ranks.length)];
}

function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    if (c === "A") {
      aces += 1;
      total += 11;
    } else if (["J", "Q", "K"].includes(c)) {
      total += 10;
    } else {
      total += Number(c);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function levelToAge(level) {
  return 16 + Math.floor(level / 2);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function satietyFromHunger(hunger) {
  return clamp(100 - hunger, 0, 100);
}

async function ensureWalletAddress(db, user) {
  if (user.wallet_address) return user.wallet_address;
  for (let i = 0; i < 5; i += 1) {
    const addr = `PHN-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const existing = await getUserByWalletAddress(db, addr);
    if (!existing) {
      await setWalletAddress(db, user.chat_id, addr);
      return addr;
    }
  }
  // Fallback (should be extremely rare)
  const addr = `PHN-${Date.now().toString(36).toUpperCase()}`;
  await setWalletAddress(db, user.chat_id, addr);
  return addr;
}

function gameCooldownRemaining(userId) {
  const last = lastGameAt.get(userId) || 0;
  const remaining = GAME_COOLDOWN_MS - (Date.now() - last);
  return remaining > 0 ? remaining : 0;
}

function setGameCooldown(userId) {
  lastGameAt.set(userId, Date.now());
}

function parseDuration(input) {
  if (!input) return null;
  const m = String(input)
    .toLowerCase()
    .match(/^(\d+)([smhdw])$/);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2];
  const mult =
    unit === "s"
      ? 1000
      : unit === "m"
        ? 60000
        : unit === "h"
          ? 3600000
          : unit === "d"
            ? 86400000
            : 604800000;
  return value * mult;
}

function formatDuration(ms) {
  if (ms == null) return "Permanent";
  const totalSec = Math.max(1, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function extractTargetId(m, args) {
  const mentioned =
    m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || null;
  const quoted =
    m.message?.extendedTextMessage?.contextInfo?.participant || null;
  const direct = args[0] || null;
  return mentioned || quoted || direct;
}

function getMediaFromMessage(msg) {
  if (!msg) return null;
  if (msg.imageMessage) return { type: "image", content: msg.imageMessage };
  if (msg.videoMessage) return { type: "video", content: msg.videoMessage };
  if (msg.documentMessage) return { type: "document", content: msg.documentMessage };
  if (msg.audioMessage) return { type: "audio", content: msg.audioMessage };
  if (msg.stickerMessage) return { type: "sticker", content: msg.stickerMessage };
  return null;
}

async function downloadMediaToBuffer(content, type) {
  const stream = await downloadContentFromMessage(content, type);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function extFromMime(mime, fallback) {
  if (!mime) return fallback;
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return map[mime] || fallback;
}

function estimateMaintenance(user, char) {
  const today = todayStr();
  if (char.last_maintenance === today) return 0;
  const cost = 30 + user.level * 5;
  return Math.min(user.phn, cost);
}

async function applyMaintenance(db, user, char) {
  const today = todayStr();
  if (char.last_maintenance === today) return 0;
  const cost = 30 + user.level * 5;
  const pay = Math.min(user.phn, cost);
  if (pay > 0) await addBalance(db, user.chat_id, -pay);
  await updateCharacter(db, char.user_id, { last_maintenance: today });
  return pay;
}

async function tickCharacter(db, char) {
  const now = Date.now();
  const last = char.last_tick ? new Date(char.last_tick).getTime() : now;
  const hours = Math.max(0, (now - last) / 3600000);

  // Hunger steigt langsam (Sattheit sinkt), Gesundheit sinkt wenn Hunger hoch ist
  let hunger = char.hunger + hours * 2.5; // +2.5 pro Stunde
  hunger = clamp(hunger, 0, 100);

  let health = char.health;
  if (hunger >= 70) {
    health -= hours * 1.5;
  } else if (hunger >= 40) {
    health -= hours * 0.5;
  }
  health = clamp(health, 0, 100);

  let starved = false;
  if (hunger >= 100 && health <= 0) {
    starved = true;
    hunger = 80;
    health = 10;
  }

  await updateCharacter(db, char.user_id, {
    hunger: Math.round(hunger),
    health: Math.round(health),
    last_tick: new Date().toISOString(),
  });

  return {
    ...char,
    hunger: Math.round(hunger),
    health: Math.round(health),
    last_tick: new Date().toISOString(),
    starved,
  };
}

// XP aendern + Levelrolle automatisch aktualisieren
async function applyXp(db, chatId, currentXp, deltaXp) {
  const newXp = currentXp + deltaXp;
  const newLevel = xpToLevel(newXp);
  const levelRole = getLevelRole(newLevel);
  await addXp(db, chatId, deltaXp, newLevel);
  await setLevelRole(db, chatId, levelRole);
  return { newXp, newLevel, levelRole };
}

async function applyXpDelta(db, chatId, currentXp, deltaXp) {
  const newXp = Math.max(0, currentXp + deltaXp);
  const newLevel = xpToLevel(newXp);
  const levelRole = getLevelRole(newLevel);
  await addXp(db, chatId, newXp - currentXp, newLevel);
  await setLevelRole(db, chatId, levelRole);
  return { newXp, newLevel, levelRole };
}

// Quest-Progress erhoehen (falls vorhanden)
async function addQuestProgress(db, userId, key, delta) {
  const q = await getQuestByKey(db, key);
  if (!q) return;
  await ensureUserQuest(db, userId, q.id);
  const uq = await getUserQuest(db, userId, q.id);
  if (uq.completed_at) return;
  const next = (uq.progress || 0) + delta;
  await updateQuestProgress(db, userId, q.id, next);
  if (next >= q.target) {
    await completeQuest(db, userId, q.id, new Date().toISOString());
  }
}

// Rollen aus DB mit Code-Logik abgleichen
async function syncRoles(db, user, senderId) {
  const userRole = getUserRole(senderId);
  const levelRole = getLevelRole(user.level);
  if (user.user_role !== userRole) {
    await setUserRole(db, user.chat_id, userRole);
  }
  if (user.level_role !== levelRole) {
    await setLevelRole(db, user.chat_id, levelRole);
  }
  return { userRole, levelRole };
}

function formatDumpSection(title, rows) {
  const header = `=== ${title} (${rows.length}) ===`;
  if (rows.length === 0) return `${header}\n<leer>\n`;
  const lines = rows.map((r) => JSON.stringify(r));
  return `${header}\n${lines.join("\n")}\n`;
}

async function sendDbDump(sock, chatId, db, m = null) {
  const dump = await dumpAll(db);
  const content =
    formatDumpSection("users", dump.users) +
    formatDumpSection("friends", dump.friends) +
    formatDumpSection("quests", dump.quests) +
    formatDumpSection("user_quests", dump.userQuests) +
    formatDumpSection("dsgvo_accepts", dump.dsgvoAccepts);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.resolve(DATA_DIR, `dbdump-${ts}.txt`);
  fs.writeFileSync(filePath, content, "utf8");

  const meta = buildMessageMeta(m, "dbdump");
  await sock.sendMessage(chatId, {
    document: fs.readFileSync(filePath),
    fileName: path.basename(filePath),
    mimetype: "text/plain",
    caption: formatMessage("DB Dump (Text)", ["Datei wurde erstellt und angehaengt."], "", "📄", meta),
  });
}

function drawTable(doc, title, rows, columns, addPage) {
  const pageWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const minCol = 70;
  const maxCol = 140;
  const rowPadding = 4;

  const ensureSpace = (needed) => {
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + needed > bottom) addPage();
  };

  // Ueberschrift + Abstand
  ensureSpace(28);
  doc.fontSize(14).fillColor("#0B0F1A").text(title);
  doc.moveDown(0.2);

  if (!rows || rows.length === 0) {
    ensureSpace(16);
    doc.fontSize(10).fillColor("#6B7280").text("Keine Daten");
    doc.moveDown(0.8);
    return;
  }

  const cols =
    columns && columns.length
      ? columns
      : Object.keys(rows[0]).map((k) => ({ key: k, label: k }));

  const formatValue = (key, val) => {
    if (val === null || val === undefined) return "";
    if (
      /_at$/.test(key) ||
      key.includes("created_at") ||
      key.includes("accepted_at")
    ) {
      return new Date(val).toLocaleString("de-DE");
    }
    return String(val);
  };

  // Spaltenbreiten nach Textlaenge
  const colWeights = cols.map((c) => {
    const headerW = doc.widthOfString(c.label);
    const sample = rows.slice(0, 40).map((r) => formatValue(c.key, r[c.key]));
    const maxW = Math.max(headerW, ...sample.map((v) => doc.widthOfString(v)));
    return Math.min(maxCol, Math.max(minCol, maxW + 18));
  });
  const total = colWeights.reduce((a, b) => a + b, 0);
  const scale = total > pageWidth ? pageWidth / total : 1;
  const colWidths = colWeights.map((w) => Math.max(minCol, w * scale));

  const drawHeader = () => {
    const y = doc.y + 6;
    const headerHeight = 18;
    doc.save();
    doc
      .rect(doc.page.margins.left, y - 4, pageWidth, headerHeight + 6)
      .fill("#E9EEF5");
    doc.restore();
    doc.fontSize(9).fillColor("#0F172A");
    let x = doc.page.margins.left;
    cols.forEach((c, i) => {
      doc.text(c.label, x + 2, y, { width: colWidths[i] - 4 });
      x += colWidths[i];
    });
    // Vertikale Trennlinien (Header)
    doc.save().strokeColor("#D1D5DB").lineWidth(0.8);
    let vx = doc.page.margins.left;
    for (let i = 0; i < colWidths.length - 1; i += 1) {
      vx += colWidths[i];
      doc
        .moveTo(vx, y - 4)
        .lineTo(vx, y - 4 + headerHeight + 6)
        .stroke();
    }
    doc.restore();
    doc.y = y + headerHeight;
  };

  ensureSpace(22);
  drawHeader();

  let rowIndex = 0;
  for (const r of rows) {
    const cells = cols.map((c) => formatValue(c.key, r[c.key]));
    const heights = cells.map((val, i) =>
      doc.heightOfString(val, { width: colWidths[i] - 4, lineGap: 1 }),
    );
    const rowHeight = Math.max(...heights) + rowPadding;

    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      addPage();
      drawHeader();
    }

    if (rowIndex % 2 === 0) {
      doc.save();
      doc
        .rect(doc.page.margins.left, doc.y - 1, pageWidth, rowHeight + 2)
        .fill("#F7F9FC");
      doc.restore();
    }

    doc.fontSize(9).fillColor("#111827");
    let x = doc.page.margins.left;
    cells.forEach((val, i) => {
      const textHeight = heights[i];
      const offsetY = Math.max(0, (rowHeight - rowPadding - textHeight) / 2);
      doc.text(val, x + 2, doc.y + offsetY, {
        width: colWidths[i] - 4,
        lineGap: 1,
      });
      x += colWidths[i];
    });
    // Zeilentrenner + vertikale Trennlinien
    doc.save().strokeColor("#E5E7EB").lineWidth(0.8);
    doc
      .moveTo(doc.page.margins.left, doc.y + rowHeight - 1)
      .lineTo(doc.page.margins.left + pageWidth, doc.y + rowHeight - 1)
      .stroke();
    let vx = doc.page.margins.left;
    for (let i = 0; i < colWidths.length - 1; i += 1) {
      vx += colWidths[i];
      doc
        .moveTo(vx, doc.y - 1)
        .lineTo(vx, doc.y + rowHeight - 1)
        .stroke();
    }
    doc.restore();
    doc.y += rowHeight;
    rowIndex += 1;
  }

  // Natuerlicher Abstand zur naechsten Tabelle
  doc.moveDown(0.6);
}

function estimateUserSectionHeight(doc, user) {
  const pageWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const keyWidth = Math.min(170, pageWidth * 0.35);
  const valWidth = pageWidth - keyWidth;
  const rowPad = 4;
  const rows = [
    ["Freundescode", user.friend_code],
    ["Level", user.level],
    ["XP", user.xp],
    ["PHN", user.phn],
    ["Rolle", user.user_role],
    ["Levelrolle", user.level_role],
    ["Daily Streak", user.daily_streak],
    ["Erstellt", formatDateTime(user.created_at)],
    [
      "DSGVO akzeptiert",
      user.dsgvo_accepted_at ? formatDateTime(user.dsgvo_accepted_at) : "-",
    ],
    ["DSGVO Version", user.dsgvo_version || "-"],
  ];
  let estimated = 24; // Titel + Abstand
  for (const [k, v] of rows) {
    const key = String(k);
    const val = v === null || v === undefined ? "" : String(v);
    const h =
      Math.max(
        doc.heightOfString(key, { width: keyWidth }),
        doc.heightOfString(val, { width: valWidth }),
      ) + rowPad;
    estimated += h;
  }
  estimated += 8;
  return estimated;
}

function drawUserSection(doc, user, addPage) {
  const ensureSpace = (needed) => {
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + needed > bottom) addPage();
  };

  const title = `User: ${user.profile_name} (${user.chat_id})`;
  ensureSpace(28);
  doc.fontSize(13).fillColor("#0B0F1A").text(title);
  doc.moveDown(0.2);

  const rows = [
    ["Freundescode", user.friend_code],
    ["Level", user.level],
    ["XP", user.xp],
    ["PHN", user.phn],
    ["Rolle", user.user_role],
    ["Levelrolle", user.level_role],
    ["Daily Streak", user.daily_streak],
    ["Erstellt", formatDateTime(user.created_at)],
    [
      "DSGVO akzeptiert",
      user.dsgvo_accepted_at ? formatDateTime(user.dsgvo_accepted_at) : "-",
    ],
    ["DSGVO Version", user.dsgvo_version || "-"],
  ];

  const pageWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const keyWidth = Math.min(170, pageWidth * 0.35);
  const valWidth = pageWidth - keyWidth;
  const rowPad = 4;

  // Abschnitts-Hoehe abschaetzen, um Split zu vermeiden
  ensureSpace(estimateUserSectionHeight(doc, user));

  for (const [k, v] of rows) {
    const key = String(k);
    const val = v === null || v === undefined ? "" : String(v);
    const h =
      Math.max(
        doc.heightOfString(key, { width: keyWidth }),
        doc.heightOfString(val, { width: valWidth }),
      ) + rowPad;

    doc
      .fontSize(9)
      .fillColor("#6B7280")
      .text(key, doc.page.margins.left, doc.y, {
        width: keyWidth,
      });
    doc
      .fontSize(10)
      .fillColor("#111827")
      .text(val, doc.page.margins.left + keyWidth, doc.y, { width: valWidth });
    doc.y += h;
  }

  doc.moveDown(0.6);
}

function drawRecordSection(doc, title, row, columns, addPage) {
  addPage();
  doc.fontSize(13).fillColor("#0B0F1A").text(title);
  doc.moveDown(0.3);

  const pageWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const keyWidth = Math.min(180, pageWidth * 0.35);
  const valWidth = pageWidth - keyWidth;
  const rowPad = 4;

  for (const c of columns) {
    const key = c.label;
    const raw = row[c.key];
    const val =
      raw === null || raw === undefined
        ? ""
        : /_at$/.test(c.key) ||
            c.key.includes("created_at") ||
            c.key.includes("accepted_at")
          ? new Date(raw).toLocaleString("de-DE")
          : String(raw);
    const h =
      Math.max(
        doc.heightOfString(key, { width: keyWidth }),
        doc.heightOfString(val, { width: valWidth }),
      ) + rowPad;

    doc
      .fontSize(9)
      .fillColor("#6B7280")
      .text(key, doc.page.margins.left, doc.y, {
        width: keyWidth,
      });
    doc
      .fontSize(10)
      .fillColor("#111827")
      .text(val, doc.page.margins.left + keyWidth, doc.y, { width: valWidth });
    doc.y += h;
  }
}

function drawPdfHeader(doc, pageNumber, meta) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;

  // Header: Brand + Document info
  doc.fontSize(22).fillColor("#0B0F1A").text("CIPHERPHANTOM", left, doc.y);
  doc
    .fontSize(9)
    .fillColor("#6B7280")
    .text(`Dokument: ${meta.title}`, right - 220, doc.y - 16, {
      width: 220,
      align: "right",
    })
    .text(`Datum: ${meta.date}`, right - 220, doc.y, {
      width: 220,
      align: "right",
    })
    .text(`Dokument-ID: ${meta.docId}`, right - 220, doc.y + 12, {
      width: 220,
      align: "right",
    });

  doc.moveDown(0.4);
  doc
    .strokeColor("#111827")
    .lineWidth(1)
    .moveTo(left, doc.y)
    .lineTo(right, doc.y)
    .stroke();
  doc.moveDown(0.6);

  // Footer mit Seitenzahl
  const footerY = doc.page.height - doc.page.margins.bottom + 10;
  doc
    .fontSize(9)
    .fillColor("#6B7280")
    .text(`Seite ${pageNumber}`, left, footerY, {
      width: right - left,
      align: "right",
    });
}

async function sendGuidePdf(sock, chatId, prefix, m = null) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const exportDir = path.resolve(DATA_DIR, "exports");
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
  const filePath = path.resolve(exportDir, `guide-${ts}.pdf`);
  const doc = new PDFDocument({ margin: 40, autoFirstPage: false });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const meta = {
    title: "CIPHERPHANTOM Anleitung",
    date: new Date().toLocaleString("de-DE"),
    docId: `GUIDE-${ts}`,
  };

  const page = { n: 0 };
  const addPage = () => {
    doc.addPage();
    page.n += 1;
    drawPdfHeader(doc, page.n, meta);
  };

  addPage();
  doc.fontSize(16).fillColor("#111111").text("CIPHERPHANTOM – Anleitung");
  doc.moveDown(0.3);
  doc
    .fontSize(10)
    .fillColor("#6B7280")
    .text(
      "Kurzer Einstieg, Spielregeln und Tipps fuer einen stabilen Fortschritt.",
    );
  doc.moveDown(0.6);

  const section = (title, lines) => {
    doc.fontSize(13).fillColor("#0B0F1A").text(title);
    doc.moveDown(0.2);
    doc
      .fontSize(10)
      .fillColor("#111827")
      .text(lines.join("\n"), { lineGap: 2 });
    doc.moveDown(0.6);
  };

  section("Erste Schritte", [
    `1) ${prefix}dsgvo lesen`,
    `2) ${prefix}accept bestaetigen`,
    `3) ${prefix}register <name> registrieren`,
    `4) ${prefix}buychar <name> Charakter kaufen (Ziel: Pflege & Leveln)`,
  ]);

  section("Charakter-System", [
    `${prefix}char zeigt Status (Alter, Gesundheit, Sattheit). Alter steigt mit Level.`,
    `${prefix}work bringt PHN + XP (Cooldown 3h). Arbeit senkt Sattheit und senkt Gesundheit.`,
    `${prefix}feed (snack|meal|feast) erhoeht Sattheit und steigert Gesundheit.`,
    `${prefix}med (small|big) steigert Gesundheit.`,
    `Name des Charakters kann 2x geaendert werden: ${prefix}charname <neuer_name>.`,
  ]);

  section("Quests & Fortschritt", [
    `${prefix}daily und ${prefix}weekly geben Bonus + XP.`,
    `${prefix}quests zeigt Aufgaben, ${prefix}claim holt Belohnungen.`,
    "Der Fortschritt kommt langfristig durch Quests, Arbeit und gutes Ressourcen-Management.",
  ]);

  section("Minispiele (fair)", [
    `${prefix}flip <betrag> <kopf|zahl> – 50/50.`,
    `${prefix}slots <betrag> – 3 Walzen, 2er/3er Treffer zahlen aus.`,
    `${prefix}roulette <betrag> <rot|schwarz|gerade|ungerade|zahl> [wert]`,
    `${prefix}blackjack <betrag> | hit | stand – Standardregeln.`,
    `${prefix}fish <betrag> – Fische mit Multiplikatoren.`,
    `${prefix}stacker <betrag> | cashout – Risiko-Stacking.`,
  ]);

  section("Tipps & Tricks", [
    "• Leveln ist ein Marathon: Arbeite regelmaessig und pflege deinen Charakter.",
    "• Iss rechtzeitig, sonst sinkt die Gesundheit und Arbeit lohnt weniger.",
    "• Spiele nur mit Betraegen, die du verkraftest – Quests sind der sichere Weg.",
    "• Verwende ${prefix}profile um deinen Fortschritt zu checken.",
  ]);

  doc.end();
  await new Promise((resolve) => stream.on("finish", resolve));

  const msgMeta = buildMessageMeta(m, "guide");
  await sock.sendMessage(chatId, {
    document: fs.readFileSync(filePath),
    fileName: path.basename(filePath),
    mimetype: "application/pdf",
    caption: formatMessage("CIPHERPHANTOM Anleitung", ["PDF mit Anleitung wurde erstellt."], "", "📘", msgMeta),
  });
}

async function sendDbDumpPdf(sock, chatId, db, m = null) {
  const dump = await dumpAll(db);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const exportDir = path.resolve(DATA_DIR, "exports");
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
  const filePath = path.resolve(exportDir, `dbdump-${ts}.pdf`);

  const doc = new PDFDocument({ margin: 40, autoFirstPage: false });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const meta = {
    title: "Datenbank Export",
    date: new Date().toLocaleString("de-DE"),
    docId: `DB-${ts}`,
  };

  const page = { n: 0 };
  const addPage = () => {
    doc.addPage();
    page.n += 1;
    drawPdfHeader(doc, page.n, meta);
  };

  // Kein Deckblatt: direkt mit Eintraegen starten

  const schemas = {
    users: [
      { key: "chat_id", label: "Chat-ID" },
      { key: "profile_name", label: "Profil" },
      { key: "friend_code", label: "Code" },
      { key: "level", label: "Level" },
      { key: "xp", label: "XP" },
      { key: "phn", label: "PHN" },
      { key: "user_role", label: "Rolle" },
      { key: "level_role", label: "Levelrolle" },
      { key: "created_at", label: "Erstellt" },
    ],
    friends: [
      { key: "user_id", label: "User" },
      { key: "friend_id", label: "Freund" },
      { key: "created_at", label: "Seit" },
    ],
    quests: [
      { key: "id", label: "ID" },
      { key: "key", label: "Key" },
      { key: "title", label: "Titel" },
      { key: "period", label: "Typ" },
      { key: "target", label: "Ziel" },
      { key: "reward_phn", label: "PHN" },
      { key: "reward_xp", label: "XP" },
      { key: "active", label: "Aktiv" },
    ],
    user_quests: [
      { key: "user_id", label: "User" },
      { key: "quest_id", label: "Quest" },
      { key: "progress", label: "Progress" },
      { key: "completed_at", label: "Abgeschlossen" },
      { key: "claimed_at", label: "Geclaimt" },
    ],
    dsgvo_accepts: [
      { key: "chat_id", label: "Chat-ID" },
      { key: "accepted_at", label: "Akzeptiert" },
      { key: "version", label: "Version" },
    ],
  };

  // Users als einzelne, saubere Sektionen
  if (dump.users.length === 0) {
    addPage();
    doc.fontSize(13).fillColor("#0B0F1A").text("Users (0)");
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor("#6B7280").text("Keine Daten");
  } else {
    for (const u of dump.users) {
      addPage();
      drawUserSection(doc, u, () => {});
    }
  }
  if (dump.friends.length === 0) {
    addPage();
    doc.fontSize(13).fillColor("#0B0F1A").text("Friends (0)");
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor("#6B7280").text("Keine Daten");
  } else {
    dump.friends.forEach((r, i) =>
      drawRecordSection(
        doc,
        `Friend ${i + 1}/${dump.friends.length}`,
        r,
        schemas.friends,
        addPage,
      ),
    );
  }

  if (dump.quests.length === 0) {
    addPage();
    doc.fontSize(13).fillColor("#0B0F1A").text("Quests (0)");
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor("#6B7280").text("Keine Daten");
  } else {
    dump.quests.forEach((r, i) =>
      drawRecordSection(
        doc,
        `Quest ${i + 1}/${dump.quests.length}`,
        r,
        schemas.quests,
        addPage,
      ),
    );
  }

  if (dump.userQuests.length === 0) {
    addPage();
    doc.fontSize(13).fillColor("#0B0F1A").text("User Quests (0)");
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor("#6B7280").text("Keine Daten");
  } else {
    dump.userQuests.forEach((r, i) =>
      drawRecordSection(
        doc,
        `User Quest ${i + 1}/${dump.userQuests.length}`,
        r,
        schemas.user_quests,
        addPage,
      ),
    );
  }

  if (dump.dsgvoAccepts.length === 0) {
    addPage();
    doc.fontSize(13).fillColor("#0B0F1A").text("DSGVO Accepts (0)");
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor("#6B7280").text("Keine Daten");
  } else {
    dump.dsgvoAccepts.forEach((r, i) =>
      drawRecordSection(
        doc,
        `DSGVO Accept ${i + 1}/${dump.dsgvoAccepts.length}`,
        r,
        schemas.dsgvo_accepts,
        addPage,
      ),
    );
  }

  // Signaturblock auf der letzten Seite
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  if (doc.y + 120 > doc.page.height - doc.page.margins.bottom) addPage();
  doc.moveDown(0.8);
  doc.fontSize(11).fillColor("#111111").text("Systemsignatur");
  doc.moveDown(0.4);
  doc
    .strokeColor("#9CA3AF")
    .lineWidth(1)
    .moveTo(left, doc.y)
    .lineTo(left + 220, doc.y)
    .stroke();
  doc
    .fontSize(10)
    .fillColor("#374151")
    .text("CIPHERPHANTOM System", left, doc.y + 4);
  doc
    .fontSize(9)
    .fillColor("#6B7280")
    .text("Automatisch generierte Unterschrift", left, doc.y + 18);

  // Nur eine Unterschrift

  doc.end();

  await new Promise((resolve) => stream.on("finish", resolve));

  const msgMeta = buildMessageMeta(m, "dbdump");
  await sock.sendMessage(chatId, {
    document: fs.readFileSync(filePath),
    fileName: path.basename(filePath),
    mimetype: "application/pdf",
    caption: formatMessage("DB Dump (PDF)", ["PDF-Export wurde erstellt und angehaengt."], "", "📑", msgMeta),
  });
}

// Datum/Zeit lesbar im deutschen Format
function formatDateTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("de-DE");
}

// Einfache DSGVO-Info (Kurzfassung) fuer den Bot
function dsgvoText(prefix) {
  return (
    "DSGVO Kurzinfo (CIPHERPHANTOM)\n" +
    "1) Gespeicherte Daten: chat_id, Profilname, Freundescode, Wallet-Stand, XP/Level, Quest-Progress, Daily/Weekly Status.\n" +
    "2) Zweck: Spiel-Features, Fortschritt, Freunde, Belohnungen.\n" +
    "3) Speicherung: lokal in einer SQLite-Datenbank auf dem Bot-System.\n" +
    "4) Keine Weitergabe an Dritte, kein Tracking von IPs.\n" +
    "5) Du kannst Loeschung verlangen (Befehl folgt spaeter).\n\n" +
    `Bestaetigen mit: ${prefix}accept`
  );
}

// Verifiziert nur weitermachen: registriert + DSGVO bestaetigt
async function requireVerified(sock, m, chatId, prefix, user) {
  if (!user) {
    await sendText(
      sock,
      chatId,
      m,
      "Zugriff verweigert",
      [`Bitte zuerst registrieren: ${prefix}register <name>`],
      "",
      "🔒",
    );
    return null;
  }
  if (!user.dsgvo_accepted_at) {
    await sendText(
      sock,
      chatId,
      m,
      "DSGVO fehlt",
      [`Bitte zuerst DSGVO lesen: ${prefix}dsgvo`],
      "",
      "⚠️",
    );
    return null;
  }
  return user;
}

// Prefixe aus JSON laden (pro Chat gespeichert)
function loadPrefixes() {
  try {
    const raw = fs.readFileSync(PREFIX_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") return data;
    return {};
  } catch {
    return {};
  }
}

// Prefixe in JSON speichern
function savePrefixes(prefixes) {
  fs.writeFileSync(PREFIX_FILE, JSON.stringify(prefixes, null, 2));
}

// Text aus unterschiedlichen Message-Typen holen
function getText(msg) {
  if (!msg) return "";
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    ""
  );
}

// Command aus Text parsen, wenn Prefix stimmt
function parseCommand(text, prefix) {
  if (!text || !text.startsWith(prefix)) return null;
  const withoutPrefix = text.slice(prefix.length).trim();
  if (!withoutPrefix) return null;
  const [cmd, ...args] = withoutPrefix.split(/\s+/);
  return { cmd: cmd.toLowerCase(), args };
}

// Hauptstart: WhatsApp verbinden, Events registrieren
async function start() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PREFIX_FILE)) savePrefixes({});
  if (!fs.existsSync(INBOX_DIR)) fs.mkdirSync(INBOX_DIR, { recursive: true });
  if (!fs.existsSync(ERROR_EXPORT_DIR)) fs.mkdirSync(ERROR_EXPORT_DIR, { recursive: true });
  if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

  printBanner();
  // Alles vor diesem Zeitpunkt gilt als Altlast und wird ignoriert
  messageCutoffSec = Math.floor(Date.now() / 1000) - 2;

  const db = await initDb();
  runtimeDb = db;
  startupSelftestIssues = await runStartupSelftest(db);
  startupSelftestSent = false;

  // Baileys internes Logging deaktivieren
  const logger = P({ level: "silent" });
  // Session laden/speichern (Multi-File Auth)
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  // Neueste kompatible Baileys-Version holen
  const { version } = await fetchLatestBaileysVersion();

  // Socket/Client erstellen
  const sock = makeWASocket({
    version,
    logger,
    auth: state,
  });
  runtimeSock = sock;

  // Jede Antwort mit DB-Sync absichern (immer vor dem Senden)
  const rawSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    await syncDb(db);
    return rawSendMessage(...args);
  };

  if (!ownerOutboxTimer) {
    ownerOutboxTimer = setInterval(() => {
      processOwnerOutbox(runtimeDb, runtimeSock).catch(() => {});
    }, 4000);
  }
  startOwnerApkUrlWatcher(sock);

  // Neue Credentials automatisch speichern
  sock.ev.on("creds.update", saveCreds);

  // Verbindungsstatus behandeln (QR, open, close)
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      log("qr", "QR erhalten - bitte mit WhatsApp scannen");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode ??
        lastDisconnect?.error?.statusCode ??
        "unknown";
      const reasonName =
        Object.entries(DisconnectReason).find(([, code]) => code === statusCode)?.[0] ??
        "unknown";
      const errorMsg = lastDisconnect?.error?.message || "kein Fehlertext";
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      lastDisconnectInfo = {
        at: new Date().toISOString(),
        code: String(statusCode),
        reason: reasonName,
        error: errorMsg,
        reconnect: shouldReconnect,
      };
      log(
        "close",
        `Verbindung geschlossen. code=${statusCode} reason=${reasonName} reconnect=${shouldReconnect} error="${errorMsg}"`,
      );
      if (shouldReconnect) {
        start().catch((err) => {
          recordError("reconnect", err).catch(() => {});
        });
      }
    }
    if (connection === "open") {
      log("open", "Verbunden");
      log("open", `Runtime: ${runtimeStatsLine()}`);
      flushPendingOwnerApkSend(sock).catch(() => {});
      if (startupSelftestIssues.length > 0 && !startupSelftestSent) {
        startupSelftestSent = true;
        const lines = ["Selftest hat Probleme gefunden:", ...startupSelftestIssues.slice(0, 12)];
        for (const ownerId of OWNER_IDS) {
          sendPlain(sock, ownerId, "Startup-Selftest", lines, "", "⚠️").catch(() => {});
        }
      }
    }
  });

  // Eingehende Nachrichten behandeln
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages?.[0];
    if (!m || m.key.fromMe) return;
    try {
    const tsRaw = m.messageTimestamp;
    const tsNum =
      typeof tsRaw === "bigint"
        ? Number(tsRaw)
        : typeof tsRaw === "object" && tsRaw?.low != null
          ? Number(tsRaw.low)
          : Number(tsRaw);
    if (Number.isFinite(tsNum) && tsNum > 0 && tsNum < messageCutoffSec) {
      return;
    }

    // Chat-ID und Nachrichtentext
    const chatId = m.key.remoteJid;
    const senderId = m.key.participant || m.key.remoteJid;
    const body = getText(m.message);
    await upsertKnownChat(db, chatId, chatId?.endsWith("@g.us"));

    // Ban-Check: auf jede Nachricht reagieren
    const ban = await getBan(db, senderId);
    if (ban) {
      const now = Date.now();
      const expires = ban.expires_at
        ? new Date(ban.expires_at).getTime()
        : null;
      if (expires && now > expires) {
        await clearBan(db, senderId);
        await sendPlain(
          sock,
          senderId,
          "Entbannt",
          ["Dein Ban ist abgelaufen. Du kannst den Bot wieder nutzen."],
          "",
          "✅",
        );
      } else {
        const remaining = expires ? formatDuration(expires - now) : "Permanent";
        await sendPlain(
          sock,
          senderId,
          "Gebannt",
          [
            `Grund: ${ban.reason || "Kein Grund angegeben"}`,
            `Dauer: ${remaining}`,
          ],
          "",
          "⛔",
        );
        return;
      }
    }

    // Prefix pro Chat laden (Default: "-")
    const prefixes = loadPrefixes();
    const prefix = prefixes[chatId] || "-";

    // Command parsen
    const parsed = parseCommand(body, prefix);
    if (!parsed) return;
    syncUserAvatar(db, sock, senderId).catch(() => {});
    syncUserBiography(db, sock, chatId, [senderId, chatId]).catch(() => {});

    const { cmd, args } = parsed;
    log("cmd", `Befehl: ${cmd} | Chat: ${chatId}`);
    await auditOwnerCommand(db, senderId, cmd, args, chatId);

    const publicCmds = new Set(["menu", "help", "helpsearch", "register", "dsgvo", "accept"]);

    const user = await getUser(db, chatId);
    const preAccept = await getPreDsgvoAccepted(db, chatId);

    // Nutzung nur wenn registriert + DSGVO bestaetigt
    if (!publicCmds.has(cmd)) {
      if (!user) {
        if (preAccept) {
          await sendText(
            sock,
            chatId,
            m,
            "Registrierung erforderlich",
            [`Bitte jetzt registrieren: ${prefix}register <name>`],
            "",
            "📝",
          );
        } else {
          await sendText(
            sock,
            chatId,
            m,
            "DSGVO erforderlich",
            [`Bitte zuerst lesen und bestaetigen: ${prefix}dsgvo`],
            "",
            "🛡️",
          );
        }
        return;
      }
      if (!user.dsgvo_accepted_at) {
        await sendText(
          sock,
          chatId,
          m,
          "DSGVO erforderlich",
          [`Bitte zuerst lesen und bestaetigen: ${prefix}dsgvo`],
          "",
          "🛡️",
        );
        return;
      }
    }

    // Befehle per switch/case
    switch (cmd) {
      case "ping":
        // Ping-Pong Test: prueft ob Bot reagiert
        await sendText(sock, chatId, m, "Pong", ["Bot ist online."], "", "🏓");
        break;

      case "menu":
        // Hilfe-Menue mit allen Befehlen anzeigen
        if (!user && !preAccept) {
          await sendText(
            sock,
            chatId,
            m,
            "CIPHERPHANTOM – Einstieg",
            [`${prefix}dsgvo lesen`],
            "",
            "📘",
          );
          break;
        }
        if (!user && preAccept) {
          await sendText(
            sock,
            chatId,
            m,
            "Naechster Schritt",
            [`${prefix}register <name>`],
            "",
            "📝",
          );
          break;
        }
        if (user && !user.dsgvo_accepted_at) {
          await sendText(
            sock,
            chatId,
            m,
            "DSGVO fehlt",
            [`${prefix}dsgvo lesen`],
            "",
            "⚠️",
          );
          break;
        }
        const sep = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
        const menuLines = [
          `${sep}`,
          "👤 PROFIL",
          "  ├─ 🪪 Konto",
          `  │  • ${prefix}profile  • Profilinfo`,
          `  │  • ${prefix}xp  • Levelstand`,
          "  └─ ✏️ Verwaltung",
          `     • ${prefix}name <neuer_name>  • Name aendern`,
          `     • ${prefix}delete  • Account loeschen`,
          `${sep}`,
          "💰 WALLET",
          "  ├─ 🧾 Kontostand",
          `  │  • ${prefix}wallet  • Kontostand`,
          "  └─ 🔁 Transfer",
          `     • ${prefix}pay <wallet_address> <betrag>  • PHN senden`,
          `${sep}`,
          "🎮 SPIELE",
          "  ├─ 🍀 Quick Games",
          `  │  • ${prefix}flip <betrag> <kopf|zahl>  • Coinflip`,
          `  │  • ${prefix}slots <betrag>  • Slots`,
          `  │  • ${prefix}roulette <betrag> <rot|schwarz|gerade|ungerade|zahl> [wert]  • Roulette`,
          "  └─ 🃏 Session Games",
          `     • ${prefix}blackjack <betrag>|hit|stand  • Blackjack`,
          `     • ${prefix}fish <betrag>  • Fishgame`,
          `     • ${prefix}stacker <betrag>|cashout  • Risiko-Spiel`,
          `${sep}`,
          "🧑 CHARAKTER",
          "  ├─ 📊 Status",
          `  │  • ${prefix}char  • Status`,
          "  ├─ 🛒 Setup",
          `  │  • ${prefix}buychar <name>  • Charakter kaufen`,
          `  │  • ${prefix}charname <neuer_name>  • Charaktername`,
          "  └─ 🧰 Pflege",
          `     • ${prefix}work  • Arbeiten`,
          `     • ${prefix}feed <snack|meal|feast>  • Fuettern`,
          `     • ${prefix}med <small|big>  • Medizin`,
          `${sep}`,
          "🎯 FORTSCHRITT",
          "  ├─ 🎁 Boni",
          `  │  • ${prefix}daily  • Tagesbonus`,
          `  │  • ${prefix}weekly  • Wochenbonus`,
          "  └─ 🏁 Quests",
          `     • ${prefix}quests <daily|weekly|monthly|progress>  • Questliste`,
          `     • ${prefix}claim <quest_id>  • Belohnung`,
          `${sep}`,
          "👥 SOCIAL",
          "  └─ 🤝 Freunde",
          `     • ${prefix}friendcode  • Code zeigen`,
          `     • ${prefix}addfriend <code>  • Freund adden`,
          `     • ${prefix}friends  • Freundesliste`,
          `${sep}`,
          "⚙️ SYSTEM",
          "  └─ 📚 Hilfe",
          `     • ${prefix}guide  • Bot-Anleitung`,
          `     • ${prefix}help <befehl>  • Detailhilfe`,
          `     • ${prefix}helpsearch <text>  • Hilfe suchen`,
          `     • ${prefix}prefix <neues_prefix>  • Prefix setzen`,
          `     • ${prefix}ping  • Erreichbarkeit`,
        ];
        const ownerLines = isOwner(senderId)
          ? [
              `${sep}`,
              "🛡️ OWNER KONSOLE",
              "  ├─ 🛰️ Bot Core",
              `  │  • ${prefix}chatid  • Chat-ID`,
              `  │  • ${prefix}ownerlogin <name> | <passwort>  • App-Login komplett`,
              `  │  • ${prefix}ownerpass <passwort>  • App-Login`,
              `  │  • ${prefix}syncroles  • Rollen sync`,
              `  │  • ${prefix}dbdump  • DB Export`,
              `  │  • ${prefix}health  • Botstatus`,
              "  ├─ 🔨 Moderation",
              `  │  • ${prefix}ban <id|@user> [dauer] [grund]  • Ban setzen`,
              `  │  • ${prefix}unban <id|@user>  • Ban aufheben`,
              `  │  • ${prefix}bans  • Banliste`,
              `  │  • ${prefix}purge <id|@user>  • Profil loeschen`,
              "  ├─ 💸 Economy Admin",
              `  │  • ${prefix}setphn <id|@user> <betrag>  • PHN setzen`,
              "  ├─ 📢 Comm Center",
              `  │  • ${prefix}sendmsg <nummer|jid> <text>  • Direktnachricht`,
              `  │  • ${prefix}broadcast <users|groups|all> <text>  • Rundsendung`,
              `  │  • ${prefix}outbox [status] [limit]  • Sendestatus`,
              "  ├─ 📱 App Notfallsteuerung",
              `  │  • ${prefix}apppanel  • App-Panel`,
              `  │  • ${prefix}appstart  • App starten`,
              `  │  • ${prefix}appstop  • App stoppen`,
              `  │  • ${prefix}apprestart  • App neustarten`,
              `  │  • ${prefix}applogs [zeilen]  • App-Logs`,
              "  ├─ 🗂️ Owner Tools",
              `  │  • ${prefix}todo <add|list|edit|done|del> ...  • Aufgaben`,
              `  │  • ${prefix}sendpc <text|datei>  • Handy-Upload`,
              "  ├─ 🧯 Debug & Fix",
              `  │  • ${prefix}errors [limit] [severity]  • Fehlerliste`,
              `  │  • ${prefix}error <FEHLER-ID>  • Fehlerdetails`,
              `  │  • ${prefix}errorfile <FEHLER-ID>  • Fehlerdatei`,
              `  │  • ${prefix}fix <add|list|status> ...  • Fix-Queue`,
              `  │  • ${prefix}audits [limit]  • Admin-Log`,
              "  └─ 📖 Help Admin",
              `     • ${prefix}helpadd ...  • Help anlegen`,
              `     • ${prefix}helpedit ...  • Help aendern`,
              `     • ${prefix}helpdel <cmd>  • Help loeschen`,
              `     • ${prefix}helplist [all|owner|public]  • Helpliste`,
            ]
          : [];
        await sendText(
          sock,
          chatId,
          m,
          `Befehle (Prefix: ${prefix})`,
          [...menuLines, ...ownerLines, sep],
          "",
          "📌",
        );
        break;

      case "help": {
        // Detailhilfe aus command_help Tabelle
        const rawQuery = (args[0] || "").toLowerCase().trim();
        const query = rawQuery.startsWith(prefix) ? rawQuery.slice(prefix.length) : rawQuery;
        if (!query) {
          await sendText(
            sock,
            chatId,
            m,
            "Help",
            [`Usage: ${prefix}help <befehl>`, `Beispiel: ${prefix}help flip`],
            "",
            "ℹ️",
          );
          break;
        }
        const entry = await getCommandHelpEntry(db, query);
        if (!entry) {
          await sendText(sock, chatId, m, "Help", ["Kein Eintrag gefunden."], "", "⚠️");
          break;
        }
        if (entry.owner_only && !isOwner(senderId)) {
          await sendText(sock, chatId, m, "Help", ["Dieser Befehl ist Owner only."], "", "🚫");
          break;
        }
        await sendText(
          sock,
          chatId,
          m,
          `Help: ${entry.cmd}`,
          [
            `Verwendung: ${prefix}${entry.usage}`,
            `Nutzen: ${entry.purpose}`,
            `Tipps: ${entry.tips || "-"}`,
            `Sichtbar: ${entry.owner_only ? "Owner" : "Alle"}`,
          ],
          "",
          "📘",
        );
        break;
      }

      case "helpsearch": {
        // Hilfeeintraege per Stichwort suchen
        const query = args.join(" ").trim().toLowerCase();
        if (!query) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}helpsearch <stichwort>`],
            "",
            "ℹ️",
          );
          break;
        }
        const rows = await searchCommandHelpEntries(db, query);
        const visible = rows.filter((r) => !r.owner_only || isOwner(senderId));
        if (!visible.length) {
          await sendText(sock, chatId, m, "Help-Suche", ["Keine Treffer."], "", "ℹ️");
          break;
        }
        const lines = visible
          .slice(0, 25)
          .map((r) => `${r.cmd} | ${r.purpose}${r.owner_only ? " | owner" : ""}`);
        await sendText(
          sock,
          chatId,
          m,
          `Help-Suche (${visible.length})`,
          lines,
          `Details: ${prefix}help <befehl>`,
          "🔎",
        );
        break;
      }

      case "helpadd":
      case "helpedit": {
        // Owner: Hilfeeintrag anlegen/aendern
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const raw = args.join(" ").trim();
        const parts = raw.split("|").map((s) => s.trim());
        if (parts.length < 3) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [
              `${prefix}${cmd} <cmd> | <usage> | <nutzen> | [tipps] | [owner_only]`,
              `owner_only: true|false`,
            ],
            "",
            "ℹ️",
          );
          break;
        }
        const helpCmd = parts[0].toLowerCase();
        const usage = parts[1];
        const purpose = parts[2];
        const tips = parts[3] || null;
        const ownerOnly = ["1", "true", "yes", "owner"].includes((parts[4] || "").toLowerCase());
        await upsertCommandHelpEntry(db, helpCmd, usage, purpose, tips, ownerOnly);
        await sendText(
          sock,
          chatId,
          m,
          "Help gespeichert",
          [`cmd: ${helpCmd}`, `owner_only: ${ownerOnly ? "true" : "false"}`],
          "",
          "✅",
        );
        break;
      }

      case "helpdel": {
        // Owner: Hilfeeintrag loeschen
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const helpCmd = (args[0] || "").toLowerCase().trim();
        if (!helpCmd) {
          await sendText(sock, chatId, m, "Usage", [`${prefix}helpdel <cmd>`], "", "ℹ️");
          break;
        }
        await deleteCommandHelpEntry(db, helpCmd);
        await sendText(sock, chatId, m, "Help geloescht", [`cmd: ${helpCmd}`], "", "🗑️");
        break;
      }

      case "helplist": {
        // Owner: Hilfeeintraege listen
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const modeRaw = (args[0] || "all").toLowerCase();
        const mode = ["all", "public", "owner"].includes(modeRaw) ? modeRaw : "all";
        const rows = await listCommandHelpEntries(db, mode);
        if (!rows.length) {
          await sendText(sock, chatId, m, "Help-Liste", ["Keine Eintraege."], "", "ℹ️");
          break;
        }
        const lines = rows.map((r) => `${r.cmd} | ${r.owner_only ? "owner" : "public"} | ${r.purpose}`);
        await sendText(sock, chatId, m, `Help-Liste (${mode}, ${rows.length})`, lines, "", "📚");
        break;
      }

      case "dsgvo": {
        // DSGVO Kurzinfo anzeigen
        await sendText(
          sock,
          chatId,
          m,
          "DSGVO Kurzinfo",
          dsgvoText(prefix).split("\n"),
          "",
          "📄",
        );
        break;
      }

      case "accept": {
        // DSGVO bestaetigen
        const acceptedAt = new Date().toISOString();
        if (user?.dsgvo_accepted_at) {
          await sendText(
            sock,
            chatId,
            m,
            "Hinweis",
            ["DSGVO bereits bestaetigt."],
            "",
            "ℹ️",
          );
          break;
        }
        if (user) {
          await setDsgvoAccepted(db, chatId, acceptedAt, DSGVO_VERSION);
        } else {
          if (preAccept) {
            await sendText(
              sock,
              chatId,
              m,
              "Naechster Schritt",
              [`${prefix}register <name>`],
              "",
              "📝",
            );
            break;
          }
          await setPreDsgvoAccepted(db, chatId, acceptedAt, DSGVO_VERSION);
        }
        await sendText(
          sock,
          chatId,
          m,
          "DSGVO bestaetigt",
          user
            ? ["Du kannst den Bot nun nutzen."]
            : [`Jetzt registrieren: ${prefix}register <name>`],
          "",
          "✅",
        );
        break;
      }

      case "register": {
        // Registrierung: Profil anlegen + Wallet + Freundescode
        const nameFromArgs = args.join(" ").trim();
        const profileName = nameFromArgs || m.pushName || "Spieler";

        let user = await getUser(db, chatId);
        if (user) {
          await sendText(
            sock,
            chatId,
            m,
            "Info",
            ["Du bist bereits registriert."],
            "",
            "ℹ️",
          );
          break;
        }

        const pre = preAccept;
        if (!pre) {
          await sendText(
            sock,
            chatId,
            m,
            "DSGVO fehlt",
            [`${prefix}dsgvo lesen`],
            "",
            "⚠️",
          );
          break;
        }

        // Freundescode sicher einzigartig generieren
        let code = generateFriendCode();
        while (await getFriendByCode(db, code)) code = generateFriendCode();

        const userRole = getUserRole(senderId);
        const levelRole = getLevelRole(1);
        await createUser(db, chatId, profileName, code, userRole, levelRole);
        user = await getUser(db, chatId);
        const walletAddress = await ensureWalletAddress(db, user);
        await setDsgvoAccepted(db, chatId, pre.accepted_at, pre.version);
        await clearPreDsgvoAccepted(db, chatId);

        await sendText(
          sock,
          chatId,
          m,
          "Registrierung erfolgreich",
          [
            `Profil: ${user.profile_name}`,
            `Freundescode: ${user.friend_code}`,
            `Wallet: ${user.phn} ${CURRENCY}`,
            `Wallet-Adresse: ${walletAddress}`,
          ],
          "",
          "✅",
        );
        break;
      }

      case "profile": {
        // Profil anzeigen (Level, XP, Wallet, Streak)
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const roles = await syncRoles(db, user, senderId);
        await sendText(
          sock,
          chatId,
          m,
          "Profil",
          [
            `Name: ${user.profile_name}`,
            `Rolle: ${roles.userRole} | Levelrolle: ${roles.levelRole}`,
            `Level: ${user.level} (XP: ${user.xp}, bis Level-Up: ${xpToNextLevel(user.xp)})`,
            `Wallet: ${user.phn} ${CURRENCY}`,
            `Wallet-Adresse: ${await ensureWalletAddress(db, user)}`,
            `Daily Streak: ${user.daily_streak}`,
            `Freundescode: ${user.friend_code}`,
            `Erstellt: ${formatDateTime(user.created_at)}`,
          ],
          "",
          "👤",
        );
        break;
      }

      case "xp":
      case "level": {
        // XP/Level anzeigen
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const level = xpToLevel(user.xp);
        const nextAt = Math.pow(level, 2) * XP_LEVEL_FACTOR;
        const remaining = xpToNextLevel(user.xp);
        const progress = Math.min(
          100,
          Math.round(((nextAt - remaining) / nextAt) * 100),
        );
        await sendText(
          sock,
          chatId,
          m,
          "Level-Status",
          [
            `Level: ${level}`,
            `XP: ${user.xp}`,
            `Naechstes Level bei: ${nextAt} XP`,
            `Fehlend: ${remaining} XP`,
            `Fortschritt: ${progress}%`,
          ],
          "",
          "📈",
        );
        break;
      }

      case "name": {
        // Profilname aendern
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const newName = args.join(" ").trim();
        if (!newName) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}name <neuer_name>`],
            "",
            "ℹ️",
          );
          break;
        }
        if (newName.length > 30) {
          await sendText(
            sock,
            chatId,
            m,
            "Fehler",
            ["Name zu lang. Maximal 30 Zeichen."],
            "",
            "⚠️",
          );
          break;
        }
        // 7 Tage Cooldown (Owner ausgenommen)
        if (!isOwner(senderId) && user.last_name_change) {
          const last = new Date(user.last_name_change).getTime();
          const now = Date.now();
          const diff = now - last;
          const cooldownMs = 7 * 24 * 60 * 60 * 1000;
          if (diff < cooldownMs) {
            const remaining = cooldownMs - diff;
            const days = Math.ceil(remaining / (24 * 60 * 60 * 1000));
            await sendText(
              sock,
              chatId,
              m,
              "Cooldown aktiv",
              [`Noch ${days} Tag(en) bis zur naechsten Aenderung.`],
              "",
              "⏳",
            );
            break;
          }
        }

        // Bestaetigungscode aehnlich wie delete
        const token = Math.random().toString(36).slice(2, 8).toUpperCase();
        const expiresAt = Date.now() + 2 * 60 * 1000;
        pendingNameChanges.set(chatId, { token, expiresAt, newName });

        await sendText(
          sock,
          chatId,
          m,
          "Namensaenderung bestaetigen",
          [
            `Neuer Name: ${newName}`,
            "Achtung: 7 Tage keine weitere Aenderung moeglich.",
            `Bestaetigen: ${prefix}confirmname ${token}`,
          ],
          "",
          "⚠️",
        );
        break;
      }

      case "confirmname": {
        // Bestaetigung fuer Namensaenderung
        const entry = pendingNameChanges.get(chatId);
        if (!entry || entry.expiresAt < Date.now()) {
          pendingNameChanges.delete(chatId);
          await sendText(
            sock,
            chatId,
            m,
            "Kein Vorgang",
            [`Starte mit ${prefix}name <neuer_name>`],
            "",
            "ℹ️",
          );
          break;
        }
        const token = (args[0] || "").toUpperCase();
        if (!token || token !== entry.token) {
          await sendText(
            sock,
            chatId,
            m,
            "Fehler",
            ["Bestaetigungscode ist falsch."],
            "",
            "⚠️",
          );
          break;
        }
        pendingNameChanges.delete(chatId);
        await setProfileName(db, chatId, entry.newName);
        await setNameChange(db, chatId, new Date().toISOString());
        await sendText(
          sock,
          chatId,
          m,
          "Name aktualisiert",
          [entry.newName],
          "",
          "✅",
        );
        break;
      }

      case "wallet": {
        // Wallet anzeigen
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        await sendText(
          sock,
          chatId,
          m,
          "Wallet",
          [
            `Stand: ${user.phn} ${CURRENCY} (${CURRENCY_NAME})`,
            `Adresse: ${await ensureWalletAddress(db, user)}`,
            `Transfer-Limit: ${MAX_TRANSFER_PHN} ${CURRENCY}`,
          ],
          "",
          "💰",
        );
        break;
      }

      case "pay": {
        // Transfer per Wallet-Adresse
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const address = (args[0] || "").trim().toUpperCase();
        const amount = Number(args[1]);
        if (!address || !amount || amount <= 0 || !Number.isFinite(amount)) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}pay <wallet_address> <betrag>`],
            "",
            "ℹ️",
          );
          break;
        }
        if (amount > MAX_TRANSFER_PHN) {
          await sendText(
            sock,
            chatId,
            m,
            "Limit",
            [`Max pro Transfer: ${MAX_TRANSFER_PHN} ${CURRENCY}`],
            "",
            "⚠️",
          );
          break;
        }
        const toUser = await getUserByWalletAddress(db, address);
        if (!toUser) {
          await sendText(
            sock,
            chatId,
            m,
            "Fehler",
            ["Adresse nicht gefunden."],
            "",
            "⚠️",
          );
          break;
        }
        if (toUser.chat_id === chatId) {
          await sendText(
            sock,
            chatId,
            m,
            "Fehler",
            ["Du kannst nicht an dich selbst senden."],
            "",
            "⚠️",
          );
          break;
        }
        if (user.phn < amount) {
          await sendText(
            sock,
            chatId,
            m,
            "Nicht genug PHN",
            ["Wallet ist zu niedrig."],
            "",
            "💸",
          );
          break;
        }
        await addBalance(db, chatId, -amount);
        await addBalance(db, toUser.chat_id, amount);
        await sendText(
          sock,
          chatId,
          m,
          "Transfer gesendet",
          [`-${amount} ${CURRENCY}`, `An: ${address}`],
          "",
          "💸",
        );
        await sendPlain(
          sock,
          toUser.chat_id,
          "Transfer erhalten",
          [
            `+${amount} ${CURRENCY}`,
            `Von: ${await ensureWalletAddress(db, user)}`,
          ],
          "",
          "💰",
        );
        break;
      }

      case "char": {
        // Charakterstatus anzeigen
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const char = await getCharacter(db, chatId);
        if (!char) {
          await sendText(
            sock,
            chatId,
            m,
            "Charakter fehlt",
            [`${prefix}buychar <name>`],
            "",
            "🧩",
          );
          break;
        }
        const maintenance = await applyMaintenance(db, user, char);
        const updated = await tickCharacter(db, char);
        if (updated.starved) {
          const penaltyPhn = Math.max(0, Math.floor(user.phn * 0.1));
          await addBalance(db, chatId, -penaltyPhn);
          await applyXpDelta(db, chatId, user.xp, -200);
        }
        const satiety = satietyFromHunger(updated.hunger);
        if (satiety <= 5) {
          await sendText(
            sock,
            chatId,
            m,
            "Warnung",
            ["Sattheit sehr niedrig (unter 5)."],
            "",
            "⚠️",
          );
        }
        const age = levelToAge(user.level);
        await sendText(
          sock,
          chatId,
          m,
          `Charakter: ${updated.name}`,
          [
            `Alter: ${age} Jahre (Level ${user.level})`,
            `Gesundheit: ${updated.health}/100`,
            `Sattheit: ${satiety}/100`,
            `Letzte Arbeit: ${updated.last_work ? formatDateTime(updated.last_work) : "-"}`,
            `Letztes Essen: ${updated.last_feed ? formatDateTime(updated.last_feed) : "-"}`,
            ...(maintenance > 0
              ? [`Unterhalt heute: -${maintenance} ${CURRENCY}`]
              : []),
          ],
          "",
          "🧑‍🤝‍🧑",
        );
        break;
      }

      case "buychar": {
        // Charakter kaufen
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const name = args.join(" ").trim();
        if (!name) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}buychar <name>`],
            "",
            "ℹ️",
          );
          break;
        }
        if (name.length > 20) {
          await sendText(
            sock,
            chatId,
            m,
            "Fehler",
            ["Name zu lang. Maximal 20 Zeichen."],
            "",
            "⚠️",
          );
          break;
        }
        const existing = await getCharacter(db, chatId);
        if (existing) {
          await sendText(
            sock,
            chatId,
            m,
            "Info",
            ["Du hast bereits einen Charakter."],
            "",
            "ℹ️",
          );
          break;
        }
        if (user.phn < CHAR_PRICE) {
          await sendText(
            sock,
            chatId,
            m,
            "Nicht genug PHN",
            [`Preis: ${CHAR_PRICE} ${CURRENCY}`],
            "",
            "💸",
          );
          break;
        }
        await addBalance(db, chatId, -CHAR_PRICE);
        await createCharacter(db, chatId, name);
        await sendText(
          sock,
          chatId,
          m,
          "Charakter erstellt",
          [`Name: ${name}`, `Preis: ${CHAR_PRICE} ${CURRENCY}`],
          "",
          "✅",
        );
        break;
      }

      case "charname": {
        // Charakter umbenennen (max 2x)
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const char = await getCharacter(db, chatId);
        if (!char) {
          await sendText(
            sock,
            chatId,
            m,
            "Charakter fehlt",
            [`${prefix}buychar <name>`],
            "",
            "🧩",
          );
          break;
        }
        if (char.rename_count >= 2) {
          await sendText(
            sock,
            chatId,
            m,
            "Limit erreicht",
            ["Name kann nur 2x geaendert werden."],
            "",
            "⚠️",
          );
          break;
        }
        const newName = args.join(" ").trim();
        if (!newName) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}charname <neuer_name>`],
            "",
            "ℹ️",
          );
          break;
        }
        if (newName.length > 20) {
          await sendText(
            sock,
            chatId,
            m,
            "Fehler",
            ["Name zu lang. Maximal 20 Zeichen."],
            "",
            "⚠️",
          );
          break;
        }
        await updateCharacter(db, chatId, {
          name: newName,
          rename_count: char.rename_count + 1,
        });
        await sendText(
          sock,
          chatId,
          m,
          "Charakter umbenannt",
          [`${newName} (${char.rename_count + 1}/2)`],
          "",
          "✅",
        );
        break;
      }

      case "work": {
        // Arbeiten schicken
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const char = await getCharacter(db, chatId);
        if (!char) {
          await sendText(
            sock,
            chatId,
            m,
            "Charakter fehlt",
            [`${prefix}buychar <name>`],
            "",
            "🧩",
          );
          break;
        }
        const maintenance = await applyMaintenance(db, user, char);
        const updated = await tickCharacter(db, char);
        if (updated.starved) {
          const penaltyPhn = Math.max(0, Math.floor(user.phn * 0.1));
          await addBalance(db, chatId, -penaltyPhn);
          await applyXpDelta(db, chatId, user.xp, -200);
        }
        const satiety = satietyFromHunger(updated.hunger);
        if (satiety <= 5) {
          await sendText(
            sock,
            chatId,
            m,
            "Warnung",
            ["Sattheit sehr niedrig (unter 5)."],
            "",
            "⚠️",
          );
        }
        if (updated.health <= 20) {
          await sendText(
            sock,
            chatId,
            m,
            "Arbeit nicht moeglich",
            ["Zu schwach. Bitte erst fuettern."],
            "",
            "🚫",
          );
          break;
        }
        if (satiety <= 10) {
          await sendText(
            sock,
            chatId,
            m,
            "Arbeit nicht moeglich",
            ["Zu hungrig. Bitte erst fuettern."],
            "",
            "🚫",
          );
          break;
        }
        const last = updated.last_work
          ? new Date(updated.last_work).getTime()
          : 0;
        const now = Date.now();
        const cooldown = WORK_COOLDOWN_HOURS * 3600000;
        if (now - last < cooldown) {
          const remaining = Math.ceil((cooldown - (now - last)) / 3600000);
          await sendText(
            sock,
            chatId,
            m,
            "Cooldown",
            [`Noch ${remaining} Stunde(n).`],
            "",
            "⏳",
          );
          break;
        }
        const base = 80 + user.level * 6;
        const healthFactor = updated.health / 100;
        const hungerPenalty =
          updated.hunger >= 70 ? 0.7 : updated.hunger >= 50 ? 0.85 : 1;
        const payout = Math.round(base * healthFactor * hungerPenalty);
        const workCost = 20 + user.level * 2;
        if (user.phn < workCost + maintenance) {
          await sendText(
            sock,
            chatId,
            m,
            "Nicht genug PHN",
            [`Arbeitskosten: ${workCost} ${CURRENCY}`],
            "",
            "💸",
          );
          break;
        }
        await addBalance(db, chatId, -workCost);
        await addBalance(db, chatId, payout);
        await applyXp(db, chatId, user.xp, 25);
        await updateCharacter(db, chatId, {
          last_work: new Date().toISOString(),
          hunger: clamp(updated.hunger + 25, 0, 100),
          health: clamp(updated.health - 8, 0, 100),
          last_tick: new Date().toISOString(),
        });
        await addQuestProgress(db, chatId, "daily_work_1", 1);
        await addQuestProgress(db, chatId, "weekly_work_5", 1);
        await addQuestProgress(db, chatId, "monthly_work_20", 1);
        await sendText(
          sock,
          chatId,
          m,
          "Arbeit erledigt",
          [
            `Lohn: +${payout} ${CURRENCY}`,
            `Arbeitskosten: -${workCost} ${CURRENCY}`,
            ...(maintenance > 0
              ? [`Unterhalt heute: -${maintenance} ${CURRENCY}`]
              : []),
            "Sattheit -25",
            "Gesundheit -8",
          ],
          "",
          "🧰",
        );
        break;
      }

      case "feed": {
        // Essen kaufen / fuettern
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const char = await getCharacter(db, chatId);
        if (!char) {
          await sendText(
            sock,
            chatId,
            m,
            "Charakter fehlt",
            [`${prefix}buychar <name>`],
            "",
            "🧩",
          );
          break;
        }
        const type = (args[0] || "").toLowerCase();
        const menu = {
          snack: { cost: 40, hunger: -20, health: +5 },
          meal: { cost: 120, hunger: -45, health: +12 },
          feast: { cost: 300, hunger: -80, health: +25 },
        };
        const item = menu[type];
        if (!item) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}feed <snack|meal|feast>`],
            "",
            "ℹ️",
          );
          break;
        }
        const maintenance = estimateMaintenance(user, char);
        if (user.phn < item.cost + maintenance) {
          await sendText(
            sock,
            chatId,
            m,
            "Nicht genug PHN",
            [
              `Preis: ${item.cost} ${CURRENCY}`,
              ...(maintenance > 0
                ? [`Unterhalt heute: ${maintenance} ${CURRENCY}`]
                : []),
            ],
            "",
            "💸",
          );
          break;
        }
        const token = Math.random().toString(36).slice(2, 8).toUpperCase();
        const expiresAt = Date.now() + 5 * 60 * 1000;
        pendingPurchases.set(chatId, {
          token,
          expiresAt,
          kind: "feed",
          itemKey: type,
        });
        await sendText(
          sock,
          chatId,
          m,
          "Kauf bestaetigen",
          [
            `Artikel: ${type.toUpperCase()}`,
            `Preis: ${item.cost} ${CURRENCY}`,
            `Effekt: Sattheit +${Math.abs(item.hunger)}, Gesundheit +${item.health}`,
            ...(maintenance > 0
              ? [`Unterhalt heute: ${maintenance} ${CURRENCY}`]
              : []),
            `Bestaetigen: ${prefix}confirmbuy ${token}`,
            "Gueltig: 5 Minuten",
          ],
          "",
          "🧾",
        );
        break;
      }

      case "guide": {
        // Anleitung als PDF senden
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        await sendGuidePdf(sock, chatId, prefix, m);
        break;
      }

      case "med": {
        // Medizin kaufen / anwenden
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const char = await getCharacter(db, chatId);
        if (!char) {
          await sendText(
            sock,
            chatId,
            m,
            "Charakter fehlt",
            [`${prefix}buychar <name>`],
            "",
            "🧩",
          );
          break;
        }
        const type = (args[0] || "").toLowerCase();
        const menu = {
          small: { cost: 80, health: +20 },
          big: { cost: 220, health: +50 },
        };
        const item = menu[type];
        if (!item) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}med <small|big>`],
            "",
            "ℹ️",
          );
          break;
        }
        const maintenance = estimateMaintenance(user, char);
        if (user.phn < item.cost + maintenance) {
          await sendText(
            sock,
            chatId,
            m,
            "Nicht genug PHN",
            [
              `Preis: ${item.cost} ${CURRENCY}`,
              ...(maintenance > 0
                ? [`Unterhalt heute: ${maintenance} ${CURRENCY}`]
                : []),
            ],
            "",
            "💸",
          );
          break;
        }
        const token = Math.random().toString(36).slice(2, 8).toUpperCase();
        const expiresAt = Date.now() + 5 * 60 * 1000;
        pendingPurchases.set(chatId, {
          token,
          expiresAt,
          kind: "med",
          itemKey: type,
        });
        await sendText(
          sock,
          chatId,
          m,
          "Kauf bestaetigen",
          [
            `Artikel: MED-${type.toUpperCase()}`,
            `Preis: ${item.cost} ${CURRENCY}`,
            `Effekt: Gesundheit +${item.health}`,
            ...(maintenance > 0
              ? [`Unterhalt heute: ${maintenance} ${CURRENCY}`]
              : []),
            `Bestaetigen: ${prefix}confirmbuy ${token}`,
            "Gueltig: 5 Minuten",
          ],
          "",
          "🧾",
        );
        break;
      }

      case "confirmbuy": {
        // Kauf bestaetigen (Food/Med)
        const entry = pendingPurchases.get(chatId);
        if (!entry) {
          await sendText(
            sock,
            chatId,
            m,
            "Kein Vorgang",
            ["Starte mit -feed oder -med."],
            "",
            "ℹ️",
          );
          break;
        }
        if (Date.now() > entry.expiresAt) {
          pendingPurchases.delete(chatId);
          await sendText(
            sock,
            chatId,
            m,
            "Abgelaufen",
            ["Bitte erneut starten."],
            "",
            "⏳",
          );
          break;
        }
        const token = (args[0] || "").toUpperCase();
        if (!token || token !== entry.token) {
          await sendText(
            sock,
            chatId,
            m,
            "Fehler",
            ["Bestaetigungscode ist falsch."],
            "",
            "⚠️",
          );
          break;
        }

        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const char = await getCharacter(db, chatId);
        if (!char) {
          await sendText(
            sock,
            chatId,
            m,
            "Charakter fehlt",
            [`${prefix}buychar <name>`],
            "",
            "🧩",
          );
          break;
        }

        const feedMenu = {
          snack: { cost: 40, hunger: -20, health: +5 },
          meal: { cost: 120, hunger: -45, health: +12 },
          feast: { cost: 300, hunger: -80, health: +25 },
        };
        const medMenu = {
          small: { cost: 80, health: +20 },
          big: { cost: 220, health: +50 },
        };
        const item =
          entry.kind === "feed"
            ? feedMenu[entry.itemKey]
            : medMenu[entry.itemKey];
        if (!item) {
          pendingPurchases.delete(chatId);
          await sendText(
            sock,
            chatId,
            m,
            "Fehler",
            ["Artikel nicht gefunden."],
            "",
            "⚠️",
          );
          break;
        }

        const maintenance = estimateMaintenance(user, char);
        if (user.phn < item.cost + maintenance) {
          await sendText(
            sock,
            chatId,
            m,
            "Nicht genug PHN",
            [
              `Preis: ${item.cost} ${CURRENCY}`,
              ...(maintenance > 0
                ? [`Unterhalt heute: ${maintenance} ${CURRENCY}`]
                : []),
            ],
            "",
            "💸",
          );
          break;
        }

        pendingPurchases.delete(chatId);
        const paidMaintenance = await applyMaintenance(db, user, char);
        const updated = await tickCharacter(db, char);
        if (updated.starved) {
          const penaltyPhn = Math.max(0, Math.floor(user.phn * 0.1));
          await addBalance(db, chatId, -penaltyPhn);
          await applyXpDelta(db, chatId, user.xp, -200);
        }

        if (entry.kind === "feed") {
          await addBalance(db, chatId, -item.cost);
          const hunger = clamp(updated.hunger + item.hunger, 0, 100);
          const health = clamp(updated.health + item.health, 0, 100);
          const satiety = satietyFromHunger(hunger);
          await updateCharacter(db, chatId, {
            hunger,
            health,
            last_feed: new Date().toISOString(),
            last_tick: new Date().toISOString(),
          });
          await addQuestProgress(db, chatId, "daily_feed_1", 1);
          await addQuestProgress(db, chatId, "weekly_feed_5", 1);
          await addQuestProgress(db, chatId, "monthly_feed_20", 1);
          if (health >= 80) {
            await addQuestProgress(db, chatId, "daily_keep_health", 1);
          }
          if (satiety <= 30) {
            await addQuestProgress(db, chatId, "daily_hunger_low", 1);
          }
          await sendText(
            sock,
            chatId,
            m,
            `${entry.itemKey.toUpperCase()} gegessen`,
            [
              `Sattheit: ${satiety}/100`,
              `Gesundheit: ${health}/100`,
              ...(paidMaintenance > 0
                ? [`Unterhalt heute: -${paidMaintenance} ${CURRENCY}`]
                : []),
            ],
            "",
            "🍽️",
          );
        } else {
          await addBalance(db, chatId, -item.cost);
          const health = clamp(updated.health + item.health, 0, 100);
          await updateCharacter(db, chatId, {
            health,
            last_tick: new Date().toISOString(),
          });
          await addQuestProgress(db, chatId, "daily_feed_1", 1);
          await addQuestProgress(db, chatId, "weekly_feed_5", 1);
          await addQuestProgress(db, chatId, "monthly_feed_20", 1);
          if (health >= 80) {
            await addQuestProgress(db, chatId, "daily_keep_health", 1);
          }
          if (satietyFromHunger(updated.hunger) <= 30) {
            await addQuestProgress(db, chatId, "daily_hunger_low", 1);
          }
          await sendText(
            sock,
            chatId,
            m,
            `${entry.itemKey.toUpperCase()} verwendet`,
            [
              `Gesundheit: ${health}/100`,
              ...(paidMaintenance > 0
                ? [`Unterhalt heute: -${paidMaintenance} ${CURRENCY}`]
                : []),
            ],
            "",
            "💊",
          );
        }
        break;
      }

      case "flip": {
        // Einfaches Coinflip-Spiel
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;

        const bet = Number(args[0]);
        const choiceRaw = (args[1] || "").toLowerCase();
        if (!bet || bet <= 0 || !Number.isFinite(bet)) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}flip <betrag> <kopf|zahl>`],
            "",
            "ℹ️",
          );
          break;
        }
        if (bet < 10) {
          await sendText(
            sock,
            chatId,
            m,
            "Einsatz",
            ["Mindesteinsatz: 10"],
            "",
            "⚠️",
          );
          break;
        }
        if (user.phn < bet) {
          await sendText(
            sock,
            chatId,
            m,
            "Nicht genug PHN",
            ["Wallet ist zu niedrig."],
            "",
            "💸",
          );
          break;
        }

        const choice = ["kopf", "k", "heads", "h"].includes(choiceRaw)
          ? "kopf"
          : ["zahl", "z", "tails", "t"].includes(choiceRaw)
            ? "zahl"
            : null;
        if (!choice) {
          await sendText(
            sock,
            chatId,
            m,
            "Auswahl fehlt",
            [`${prefix}flip <betrag> <kopf|zahl>`],
            "",
            "⚠️",
          );
          break;
        }

        // Tageslimit fuer Spielgewinne
        const today = todayStr();
        if (user.game_daily_date !== today) {
          await setGameDailyProfit(db, chatId, today, 0);
        }
        const refreshed = await getUser(db, chatId);
        const dailyProfit =
          refreshed.game_daily_date === today ? refreshed.game_daily_profit : 0;
        if (dailyProfit >= GAME_DAILY_PROFIT_CAP) {
          await sendText(
            sock,
            chatId,
            m,
            "Limit erreicht",
            ["Heute keine weiteren Spielgewinne moeglich."],
            "",
            "⛔",
          );
          break;
        }

        // Einsatz abziehen
        await addBalance(db, chatId, -bet);

        const roll = Math.random() < 0.5 ? "kopf" : "zahl";
        const win = roll === choice;
        const mult = rewardMultiplier(senderId);

        if (win) {
          const basePayout = Math.floor(bet * (2 - HOUSE_EDGE) * mult);
          const profit = Math.max(0, basePayout - bet);
          const remaining = Math.max(0, GAME_DAILY_PROFIT_CAP - dailyProfit);
          const cappedProfit = Math.min(profit, remaining);
          const payout = bet + cappedProfit;
          await addBalance(db, chatId, payout);
          await setGameDailyProfit(
            db,
            chatId,
            today,
            dailyProfit + cappedProfit,
          );
          const xpReward = 10 * mult;
          const xpWin = 15 * mult;
          await applyXp(db, chatId, user.xp, xpReward + xpWin);

          await addQuestProgress(db, chatId, "daily_play_3", 1);
          await addQuestProgress(db, chatId, "weekly_play_20", 1);
          await addQuestProgress(db, chatId, "daily_win_1", 1);
          await addQuestProgress(db, chatId, "weekly_win_5", 1);

          await sendText(
            sock,
            chatId,
            m,
            "Coinflip",
            [
              `Ergebnis: ${roll.toUpperCase()}`,
              `Gewinn: +${payout} ${CURRENCY}`,
            ],
            "",
            "🪙",
          );
        } else {
          const xpReward = 10 * mult;
          await applyXp(db, chatId, user.xp, xpReward);

          await addQuestProgress(db, chatId, "daily_play_3", 1);
          await addQuestProgress(db, chatId, "weekly_play_20", 1);

          await sendText(
            sock,
            chatId,
            m,
            "Coinflip",
            [`Ergebnis: ${roll.toUpperCase()}`, `Verlust: -${bet} ${CURRENCY}`],
            "",
            "🪙",
          );
        }
        break;
      }

      case "slots": {
        // Slotmaschine (fair, EV ~ 0)
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const bet = Number(args[0]);
        if (!bet || bet <= 0 || !Number.isFinite(bet)) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}slots <betrag>`],
            "",
            "ℹ️",
          );
          break;
        }
        if (bet < 10) {
          await sendText(
            sock,
            chatId,
            m,
            "Einsatz",
            ["Mindesteinsatz: 10"],
            "",
            "⚠️",
          );
          break;
        }
        if (user.phn < bet) {
          await sendText(
            sock,
            chatId,
            m,
            "Nicht genug PHN",
            ["Wallet ist zu niedrig."],
            "",
            "💸",
          );
          break;
        }

        const symbols = ["🍒", "🍋", "🔔", "⭐", "7️⃣", "💎"];
        const reels = [
          symbols[Math.floor(Math.random() * symbols.length)],
          symbols[Math.floor(Math.random() * symbols.length)],
          symbols[Math.floor(Math.random() * symbols.length)],
        ];

        await addBalance(db, chatId, -bet);
        const mult = rewardMultiplier(senderId);

        const a = reels[0] === reels[1];
        const b = reels[1] === reels[2];
        const c = reels[0] === reels[2];
        let payout = 0;
        if (a && b) {
          // 3-of-kind: fairer Payout
          payout = Math.round(bet * 13.5 * mult);
        } else if (a || b || c) {
          // 2-of-kind
          payout = Math.round(bet * 1.5 * mult);
        }

        if (payout > 0) {
          await addBalance(db, chatId, payout);
          await applyXp(db, chatId, user.xp, 12 * mult);
          await addQuestProgress(db, chatId, "daily_play_3", 1);
          await addQuestProgress(db, chatId, "weekly_play_20", 1);
          await addQuestProgress(db, chatId, "daily_win_1", 1);
          await addQuestProgress(db, chatId, "weekly_win_5", 1);
          await sendText(
            sock,
            chatId,
            m,
            "Slots",
            [`${reels.join(" | ")}`, `Gewinn: +${payout} ${CURRENCY}`],
            "",
            "🎰",
          );
        } else {
          await applyXp(db, chatId, user.xp, 8 * mult);
          await addQuestProgress(db, chatId, "daily_play_3", 1);
          await addQuestProgress(db, chatId, "weekly_play_20", 1);
          await sendText(
            sock,
            chatId,
            m,
            "Slots",
            [`${reels.join(" | ")}`, `Verlust: -${bet} ${CURRENCY}`],
            "",
            "🎰",
          );
        }
        break;
      }

      case "roulette": {
        // Roulette (fair angepasste Auszahlungen)
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const bet = Number(args[0]);
        const type = (args[1] || "").toLowerCase();
        const value = args[2];
        if (!bet || bet <= 0 || !Number.isFinite(bet)) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [
              `${prefix}roulette <betrag> <rot|schwarz|gerade|ungerade|zahl> [wert]`,
            ],
            "",
            "ℹ️",
          );
          break;
        }
        if (bet < 10) {
          await sendText(
            sock,
            chatId,
            m,
            "Einsatz",
            ["Mindesteinsatz: 10"],
            "",
            "⚠️",
          );
          break;
        }
        if (user.phn < bet) {
          await sendText(
            sock,
            chatId,
            m,
            "Nicht genug PHN",
            ["Wallet ist zu niedrig."],
            "",
            "💸",
          );
          break;
        }

        const red = new Set([
          1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
        ]);
        const spin = Math.floor(Math.random() * 37); // 0-36
        let win = false;
        let payout = 0;

        const mult = rewardMultiplier(senderId);
        const pay = (outcomes) => Math.round(bet * (37 / outcomes) * mult);

        if (type === "rot" || type === "red") {
          win = spin !== 0 && red.has(spin);
          if (win) payout = pay(18);
        } else if (type === "schwarz" || type === "black") {
          win = spin !== 0 && !red.has(spin);
          if (win) payout = pay(18);
        } else if (type === "gerade" || type === "even") {
          win = spin !== 0 && spin % 2 === 0;
          if (win) payout = pay(18);
        } else if (type === "ungerade" || type === "odd") {
          win = spin % 2 === 1;
          if (win) payout = pay(18);
        } else if (type === "zahl" || type === "number") {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 0 || n > 36) {
            await sendText(
              sock,
              chatId,
              m,
              "Usage",
              [`${prefix}roulette <betrag> zahl <0-36>`],
              "",
              "⚠️",
            );
            break;
          }
          win = spin === n;
          if (win) payout = pay(1);
        } else {
          await sendText(
            sock,
            chatId,
            m,
            "Unbekannter Typ",
            ["Nutze: rot, schwarz, gerade, ungerade, zahl"],
            "",
            "⚠️",
          );
          break;
        }

        await addBalance(db, chatId, -bet);
        if (win) {
          await addBalance(db, chatId, payout);
          await applyXp(db, chatId, user.xp, 12 * mult);
          await addQuestProgress(db, chatId, "daily_play_3", 1);
          await addQuestProgress(db, chatId, "weekly_play_20", 1);
          await addQuestProgress(db, chatId, "daily_win_1", 1);
          await addQuestProgress(db, chatId, "weekly_win_5", 1);
          await sendText(
            sock,
            chatId,
            m,
            "Roulette",
            [`Zahl: ${spin}`, `Gewinn: +${payout} ${CURRENCY}`],
            "",
            "🎡",
          );
        } else {
          await applyXp(db, chatId, user.xp, 8 * mult);
          await addQuestProgress(db, chatId, "daily_play_3", 1);
          await addQuestProgress(db, chatId, "weekly_play_20", 1);
          await sendText(
            sock,
            chatId,
            m,
            "Roulette",
            [`Zahl: ${spin}`, `Verlust: -${bet} ${CURRENCY}`],
            "",
            "🎡",
          );
        }
        break;
      }

      case "fish": {
        // Fish: fairer Multiplikator-Pool
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const bet = Number(args[0]);
        if (!bet || bet <= 0 || !Number.isFinite(bet)) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}fish <betrag>`],
            "",
            "ℹ️",
          );
          break;
        }
        if (bet < 10) {
          await sendText(
            sock,
            chatId,
            m,
            "Einsatz",
            ["Mindesteinsatz: 10"],
            "",
            "⚠️",
          );
          break;
        }
        if (user.phn < bet) {
          await sendText(
            sock,
            chatId,
            m,
            "Nicht genug PHN",
            ["Wallet ist zu niedrig."],
            "",
            "💸",
          );
          break;
        }

        const table = [
          { name: "Kein Fang", p: 0.31, mult: 0 },
          { name: "Kleiner Fisch", p: 0.2, mult: 0.5 },
          { name: "Fisch", p: 0.25, mult: 1 },
          { name: "Großer Fisch", p: 0.2, mult: 2 },
          { name: "Legendär", p: 0.04, mult: 6.25 },
        ];
        let r = Math.random();
        let hit = table[0];
        for (const t of table) {
          r -= t.p;
          if (r <= 0) {
            hit = t;
            break;
          }
        }

        await addBalance(db, chatId, -bet);
        const mult = rewardMultiplier(senderId);
        const payout = Math.round(bet * hit.mult * mult);
        if (payout > 0) await addBalance(db, chatId, payout);

        const win = payout > bet;
        await applyXp(db, chatId, user.xp, (win ? 12 : 8) * mult);
        await addQuestProgress(db, chatId, "daily_play_3", 1);
        await addQuestProgress(db, chatId, "weekly_play_20", 1);
        if (win) {
          await addQuestProgress(db, chatId, "daily_win_1", 1);
          await addQuestProgress(db, chatId, "weekly_win_5", 1);
        }

        await sendText(
          sock,
          chatId,
          m,
          "Fish",
          [
            `Fang: ${hit.name}`,
            payout > 0
              ? `Gewinn: +${payout} ${CURRENCY}`
              : `Verlust: -${bet} ${CURRENCY}`,
          ],
          "",
          "🎣",
        );
        break;
      }

      case "stacker": {
        // Stacker: fairer Stufenmodus
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const action = (args[0] || "").toLowerCase();

        if (action && Number.isFinite(Number(action))) {
          const bet = Number(action);
          if (!bet || bet <= 0 || !Number.isFinite(bet)) {
            await sendText(
              sock,
              chatId,
              m,
              "Usage",
              [`${prefix}stacker <betrag> | ${prefix}stacker cashout`],
              "",
              "ℹ️",
            );
            break;
          }
          if (bet < 10) {
            await sendText(
              sock,
              chatId,
              m,
              "Einsatz",
              ["Mindesteinsatz: 10"],
              "",
              "⚠️",
            );
            break;
          }
          if (user.phn < bet) {
            await sendText(
              sock,
              chatId,
              m,
              "Nicht genug PHN",
              ["Wallet ist zu niedrig."],
              "",
              "💸",
            );
            break;
          }

          // Start neue Session
          await addBalance(db, chatId, -bet);
          stackerSessions.set(chatId, {
            bet,
            level: 0,
            p: 0.7,
          });
          await addQuestProgress(db, chatId, "daily_play_3", 1);
          await addQuestProgress(db, chatId, "weekly_play_20", 1);
          await sendText(
            sock,
            chatId,
            m,
            "Stacker gestartet",
            [`Weiter: ${prefix}stacker`, `Auszahlen: ${prefix}stacker cashout`],
            "",
            "🧱",
          );
          break;
        }

        const session = stackerSessions.get(chatId);
        if (!session) {
          await sendText(
            sock,
            chatId,
            m,
            "Kein aktives Spiel",
            [`${prefix}stacker <betrag>`],
            "",
            "ℹ️",
          );
          break;
        }

        if (action === "cashout") {
          const mult = rewardMultiplier(senderId);
          const payout = Math.round(
            session.bet * Math.pow(1 / session.p, session.level) * mult,
          );
          stackerSessions.delete(chatId);
          await addBalance(db, chatId, payout);
          await applyXp(db, chatId, user.xp, 10 * mult);
          await sendText(
            sock,
            chatId,
            m,
            "Cashout",
            [`+${payout} ${CURRENCY}`],
            "",
            "💰",
          );
          break;
        }

        if (action && action !== "next") {
          await sendText(
            sock,
            chatId,
            m,
            "Aktion",
            [`${prefix}stacker | ${prefix}stacker cashout`],
            "",
            "ℹ️",
          );
          break;
        }

        // Next step
        if (Math.random() < session.p) {
          session.level += 1;
          const maxLevel = 5;
          if (session.level >= maxLevel) {
            const mult = rewardMultiplier(senderId);
            const payout = Math.round(
              session.bet * Math.pow(1 / session.p, session.level) * mult,
            );
            stackerSessions.delete(chatId);
            await addBalance(db, chatId, payout);
            await applyXp(db, chatId, user.xp, 14 * mult);
            await addQuestProgress(db, chatId, "daily_win_1", 1);
            await addQuestProgress(db, chatId, "weekly_win_5", 1);
            await sendText(
              sock,
              chatId,
              m,
              "Stacker Max-Level",
              [`+${payout} ${CURRENCY}`],
              "",
              "🏆",
            );
          } else {
            await sendText(
              sock,
              chatId,
              m,
              "Stacker",
              [
                `Stufe ${session.level} geschafft.`,
                `Weiter: ${prefix}stacker`,
                `Auszahlen: ${prefix}stacker cashout`,
              ],
              "",
              "🧱",
            );
          }
        } else {
          stackerSessions.delete(chatId);
          await applyXp(db, chatId, user.xp, 6 * rewardMultiplier(senderId));
          await sendText(
            sock,
            chatId,
            m,
            "Stacker",
            ["Fehlgeschlagen. Einsatz verloren."],
            "",
            "💥",
          );
        }
        break;
      }

      case "blackjack": {
        // Blackjack (Standardregeln)
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const arg = (args[0] || "").toLowerCase();

        if (!arg || Number.isFinite(Number(arg))) {
          const bet = Number(arg);
          if (!bet || bet <= 0 || !Number.isFinite(bet)) {
            await sendText(
              sock,
              chatId,
              m,
              "Usage",
              [`${prefix}blackjack <betrag>`],
              "",
              "ℹ️",
            );
            break;
          }
          if (bet < 10) {
            await sendText(
              sock,
              chatId,
              m,
              "Einsatz",
              ["Mindesteinsatz: 10"],
              "",
              "⚠️",
            );
            break;
          }
          if (user.phn < bet) {
            await sendText(
              sock,
              chatId,
              m,
              "Nicht genug PHN",
              ["Wallet ist zu niedrig."],
              "",
              "💸",
            );
            break;
          }
          await addBalance(db, chatId, -bet);
          const player = [drawCard(), drawCard()];
          const dealer = [drawCard(), drawCard()];
          blackjackSessions.set(chatId, { bet, player, dealer });

          await addQuestProgress(db, chatId, "daily_play_3", 1);
          await addQuestProgress(db, chatId, "weekly_play_20", 1);

          const pVal = handValue(player);
          const dVal = handValue(dealer);
          if (pVal === 21 || dVal === 21) {
            // Sofortauswertung
            let payout = 0;
            if (pVal === 21 && dVal !== 21) {
              payout = Math.round(bet * 2 * rewardMultiplier(senderId));
              await addBalance(db, chatId, payout);
              await addQuestProgress(db, chatId, "daily_win_1", 1);
              await addQuestProgress(db, chatId, "weekly_win_5", 1);
            } else if (pVal === 21 && dVal === 21) {
              payout = bet; // push
              await addBalance(db, chatId, payout);
            }
            blackjackSessions.delete(chatId);
            await sendText(
              sock,
              chatId,
              m,
              "Blackjack",
              [
                `Du: ${player.join(", ")} (${pVal})`,
                `Dealer: ${dealer.join(", ")} (${dVal})`,
                payout > 0 ? `Auszahlung: +${payout} ${CURRENCY}` : "Verloren.",
              ],
              "",
              "🂡",
            );
            break;
          }

          await sendText(
            sock,
            chatId,
            m,
            "Blackjack gestartet",
            [
              `Du: ${player.join(", ")} (${pVal})`,
              `Dealer: ${dealer[0]}, ?`,
              `Aktion: ${prefix}blackjack hit | ${prefix}blackjack stand`,
            ],
            "",
            "🃏",
          );
          break;
        }

        const session = blackjackSessions.get(chatId);
        if (!session) {
          await sendText(
            sock,
            chatId,
            m,
            "Kein aktives Spiel",
            [`${prefix}blackjack <betrag>`],
            "",
            "ℹ️",
          );
          break;
        }

        if (arg === "hit") {
          session.player.push(drawCard());
          const pVal = handValue(session.player);
          if (pVal > 21) {
            blackjackSessions.delete(chatId);
            await applyXp(db, chatId, user.xp, 8 * rewardMultiplier(senderId));
            await sendText(
              sock,
              chatId,
              m,
              "Bust",
              [
                `Du: ${session.player.join(", ")} (${pVal})`,
                "Einsatz verloren.",
              ],
              "",
              "💥",
            );
          } else {
            await sendText(
              sock,
              chatId,
              m,
              "Blackjack",
              [
                `Du: ${session.player.join(", ")} (${pVal})`,
                `Aktion: ${prefix}blackjack hit | ${prefix}blackjack stand`,
              ],
              "",
              "🃏",
            );
          }
          break;
        }

        if (arg === "stand") {
          let dVal = handValue(session.dealer);
          while (dVal < 17) {
            session.dealer.push(drawCard());
            dVal = handValue(session.dealer);
          }
          const pVal = handValue(session.player);
          const mult = rewardMultiplier(senderId);
          let payout = 0;
          let result = "Verloren";
          if (dVal > 21 || pVal > dVal) {
            payout = Math.round(session.bet * 2 * mult);
            result = "Gewonnen";
          } else if (pVal === dVal) {
            payout = session.bet; // push
            result = "Push";
          }
          if (payout > 0) await addBalance(db, chatId, payout);
          if (result === "Gewonnen") {
            await addQuestProgress(db, chatId, "daily_win_1", 1);
            await addQuestProgress(db, chatId, "weekly_win_5", 1);
          }
          await applyXp(
            db,
            chatId,
            user.xp,
            (result === "Gewonnen" ? 12 : 8) * mult,
          );
          blackjackSessions.delete(chatId);
          await sendText(
            sock,
            chatId,
            m,
            `Blackjack – ${result}`,
            [
              `Du: ${session.player.join(", ")} (${pVal})`,
              `Dealer: ${session.dealer.join(", ")} (${dVal})`,
              payout > 0
                ? `Auszahlung: +${payout} ${CURRENCY}`
                : "Einsatz verloren.",
            ],
            "",
            "🃏",
          );
          break;
        }

        await sendText(
          sock,
          chatId,
          m,
          "Aktion",
          [`${prefix}blackjack hit | ${prefix}blackjack stand`],
          "",
          "ℹ️",
        );
        break;
      }

      case "daily": {
        // Tagesbonus mit Streak
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        await syncRoles(db, user, senderId);
        const today = todayStr();
        if (user.last_daily === today) {
          await sendText(
            sock,
            chatId,
            m,
            "Daily Bonus",
            ["Bereits abgeholt. Komm morgen wieder."],
            "",
            "⏳",
          );
          break;
        }
        const streak =
          user.last_daily === yesterdayStr() ? user.daily_streak + 1 : 1;
        const mult = rewardMultiplier(senderId);
        const reward = (100 + streak * 20) * mult;
        const xpReward = (25 + streak * 5) * mult;

        const newXp = user.xp + xpReward;
        await addBalance(db, chatId, reward);
        await applyXp(db, chatId, user.xp, xpReward);
        await setDaily(db, chatId, today, streak);

        await sendText(
          sock,
          chatId,
          m,
          "Daily Bonus",
          [`+${reward} ${CURRENCY}`, `+${xpReward} XP`, `Streak: ${streak}`],
          "",
          "🎁",
        );
        break;
      }

      case "weekly": {
        // Wochenbonus
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        await syncRoles(db, user, senderId);
        const week = isoWeekStr();
        if (user.last_weekly === week) {
          await sendText(
            sock,
            chatId,
            m,
            "Weekly Bonus",
            ["Bereits abgeholt. Komm naechste Woche wieder."],
            "",
            "⏳",
          );
          break;
        }
        const mult = rewardMultiplier(senderId);
        const reward = 500 * mult;
        const xpReward = 200 * mult;
        const newXp = user.xp + xpReward;
        await addBalance(db, chatId, reward);
        await applyXp(db, chatId, user.xp, xpReward);
        await setWeekly(db, chatId, week);

        await sendText(
          sock,
          chatId,
          m,
          "Weekly Bonus",
          [`+${reward} ${CURRENCY}`, `+${xpReward} XP`],
          "",
          "🎁",
        );
        break;
      }

      case "quests": {
        // Quests anzeigen (daily/weekly/progress)
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const period = (args[0] || "daily").toLowerCase();
        if (!["daily", "weekly", "monthly", "progress"].includes(period)) {
          await sendText(
            sock,
            chatId,
            m,
            "Unbekannter Typ",
            [`Nutze: ${prefix}quests daily|weekly|monthly|progress`],
            "",
            "ℹ️",
          );
          break;
        }

        const quests = await listQuests(db, period);
        const lines = [];
        for (const q of quests) {
          await ensureUserQuest(db, chatId, q.id);
          let uq = await getUserQuest(db, chatId, q.id);

          // Progress-Quest: Alter dynamisch uebernehmen
          if (q.period === "progress" && q.key === "progress_age_30") {
            const progress = levelToAge(user.level);
            if (progress !== uq.progress) {
              await updateQuestProgress(db, chatId, q.id, progress);
              uq = await getUserQuest(db, chatId, q.id);
            }
          }

          // Automatisch abschliessen wenn Ziel erreicht
          if (!uq.completed_at && uq.progress >= q.target) {
            await completeQuest(db, chatId, q.id, new Date().toISOString());
            uq = await getUserQuest(db, chatId, q.id);
          }

          const status = uq.claimed_at
            ? "✅ abgeschlossen"
            : uq.completed_at
              ? "🎁 bereit zum Claim"
              : `⏳ ${uq.progress}/${q.target}`;
          lines.push(
            `#${q.id} ${q.title} | ${status} | +${q.reward_phn} ${CURRENCY}, +${q.reward_xp} XP`,
          );
        }

        await sendText(
          sock,
          chatId,
          m,
          `Quests (${period})`,
          lines,
          `Claim: ${prefix}claim <quest_id>`,
          "📜",
        );
        break;
      }

      case "claim": {
        // Quest-Belohnung abholen
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        await syncRoles(db, user, senderId);
        const id = Number(args[0]);
        if (!id) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}claim <quest_id>`],
            "",
            "ℹ️",
          );
          break;
        }
        const quests = (await listQuests(db, "daily"))
          .concat(await listQuests(db, "weekly"))
          .concat(await listQuests(db, "monthly"))
          .concat(await listQuests(db, "progress"));
        const q = quests.find((x) => x.id === id);
        if (!q) {
          await sendText(
            sock,
            chatId,
            m,
            "Fehler",
            ["Quest nicht gefunden."],
            "",
            "⚠️",
          );
          break;
        }
        await ensureUserQuest(db, chatId, q.id);
        const uq = await getUserQuest(db, chatId, q.id);
        if (!uq.completed_at) {
          await sendText(
            sock,
            chatId,
            m,
            "Nicht bereit",
            ["Quest noch nicht abgeschlossen."],
            "",
            "⏳",
          );
          break;
        }
        if (uq.claimed_at) {
          await sendText(
            sock,
            chatId,
            m,
            "Schon geclaimt",
            ["Diese Quest wurde bereits geclaimt."],
            "",
            "ℹ️",
          );
          break;
        }

        const mult = rewardMultiplier(senderId);
        const levelMult = 1 + user.level * 0.02;
        const phnReward = Math.round(q.reward_phn * levelMult * mult);
        const xpReward = Math.round(q.reward_xp * levelMult * mult);
        await addBalance(db, chatId, phnReward);
        await applyXp(db, chatId, user.xp, xpReward);
        await claimQuest(db, chatId, q.id, new Date().toISOString());

        await sendText(
          sock,
          chatId,
          m,
          "Belohnung erhalten",
          [`+${phnReward} ${CURRENCY}`, `+${xpReward} XP`],
          "",
          "🎁",
        );
        break;
      }

      case "friendcode": {
        // Eigenen Freundescode anzeigen
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        await sendText(
          sock,
          chatId,
          m,
          "Freundescode",
          [user.friend_code],
          "",
          "🔑",
        );
        break;
      }

      case "addfriend": {
        // Freund per Code hinzufuegen
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const code = (args[0] || "").toUpperCase();
        if (!code) {
          await sendText(
            sock,
            chatId,
            m,
            "Freund hinzufuegen",
            [`Usage: ${prefix}addfriend <code>`],
            "",
            "⚠️",
          );
          break;
        }
        const friend = await getFriendByCode(db, code);
        if (!friend) {
          await sendText(
            sock,
            chatId,
            m,
            "Freund hinzufuegen",
            ["Freund nicht gefunden."],
            "",
            "⚠️",
          );
          break;
        }
        if (friend.chat_id === chatId) {
          await sendText(
            sock,
            chatId,
            m,
            "Freund hinzufuegen",
            ["Du kannst dich nicht selbst adden."],
            "",
            "⚠️",
          );
          break;
        }
        await addFriend(db, chatId, friend.chat_id);
        await addFriend(db, friend.chat_id, chatId);
        await sendText(
          sock,
          chatId,
          m,
          "Freund hinzugefuegt",
          [friend.profile_name],
          "",
          "✅",
        );
        break;
      }

      case "friends": {
        // Freundesliste anzeigen
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const friends = await listFriends(db, chatId);
        if (friends.length === 0) {
          await sendText(
            sock,
            chatId,
            m,
            "Freunde",
            ["Noch keine Freunde hinzugefuegt."],
            "",
            "👥",
          );
          break;
        }
        const lines = friends.map(
          (f) => `- ${f.profile_name} (${f.friend_code})`,
        );
        await sendText(sock, chatId, m, "Freunde", lines, "", "👥");
        break;
      }

      case "syncroles": {
        // Owner: Rollen mit Code-Logik abgleichen
        if (!isOwner(senderId)) {
          await sendText(
            sock,
            chatId,
            m,
            "Kein Zugriff",
            ["Owner only."],
            "",
            "🚫",
          );
          break;
        }
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        const roles = await syncRoles(db, user, senderId);
        await sendText(
          sock,
          chatId,
          m,
          "Rollen synchronisiert",
          [`${roles.userRole} / ${roles.levelRole}`],
          "",
          "✅",
        );
        break;
      }

      case "chatid": {
        // Chat-ID anzeigen
        if (!isOwner(senderId)) {
          await sendText(
            sock,
            chatId,
            m,
            "Kein Zugriff",
            ["Owner only."],
            "",
            "🚫",
          );
          break;
        }
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        await sendText(sock, chatId, m, "Chat-ID", [chatId], "", "🧾");
        break;
      }

      case "ownerpass": {
        // Owner: Passwort fuer Owner-App setzen
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const newPass = args.join(" ").trim();
        if (!newPass || newPass.length < 4) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}ownerpass <neues_passwort>`, "Mindestens 4 Zeichen."],
            "",
            "🔐",
          );
          break;
        }
        const { hash, salt } = hashOwnerPassword(newPass);
        await upsertOwnerPasswordHash(db, senderId, hash, salt);
        await sendText(
          sock,
          chatId,
          m,
          "Owner Passwort gespeichert",
          ["Login fuer Owner-App ist jetzt aktiv."],
          "",
          "✅",
        );
        break;
      }

      case "ownerlogin":
      case "ownercred": {
        // Owner: Loginname + Passwort fuer Owner-App setzen
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }

        const rawInput = args.join(" ").trim();
        const parts = rawInput.includes("|")
          ? rawInput.split("|").map((p) => p.trim())
          : rawInput.split(/\s+/);
        const nextName = (parts[0] || "").trim();
        const nextPass = parts.slice(1).join(rawInput.includes("|") ? "|" : " ").trim();

        if (!nextName || !nextPass || nextName.length > 30 || nextPass.length < 4) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [
              `${prefix}ownerlogin <name> | <passwort>`,
              `Alias: ${prefix}ownercred <name> | <passwort>`,
              "Name max. 30 Zeichen, Passwort mind. 4 Zeichen.",
            ],
            "",
            "🔐",
          );
          break;
        }

        const { hash, salt } = hashOwnerPassword(nextPass);
        await setProfileName(db, senderId, nextName);
        await upsertOwnerPasswordHash(db, senderId, hash, salt);

        await sendText(
          sock,
          chatId,
          m,
          "Owner Login aktualisiert",
          [`Name: ${nextName}`, "Passwort wurde sicher gespeichert."],
          "",
          "✅",
        );
        break;
      }

      case "ban": {
        // Owner: Nutzer bannen
        if (!isOwner(senderId)) {
          await sendText(
            sock,
            chatId,
            m,
            "Kein Zugriff",
            ["Owner only."],
            "",
            "🚫",
          );
          break;
        }
        const targetId = extractTargetId(m, args);
        if (!targetId) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}ban <id|@user> [dauer] [grund]`],
            "",
            "ℹ️",
          );
          break;
        }
        if (isOwner(targetId)) {
          await sendText(
            sock,
            chatId,
            m,
            "Fehler",
            ["Owner koennen nicht gebannt werden."],
            "",
            "⚠️",
          );
          break;
        }
        const durationMs = parseDuration(args[1]);
        const reason =
          durationMs != null
            ? args.slice(2).join(" ").trim()
            : args.slice(1).join(" ").trim();
        const expiresAt = durationMs
          ? new Date(Date.now() + durationMs).toISOString()
          : null;
        await setBan(db, targetId, reason || null, expiresAt, senderId);

        await sendPlain(
          sock,
          targetId,
          "Gebannt",
          [
            `Grund: ${reason || "Kein Grund angegeben"}`,
            `Dauer: ${durationMs ? formatDuration(durationMs) : "Permanent"}`,
          ],
          "",
          "⛔",
        );

        await sendText(
          sock,
          chatId,
          m,
          "Ban gesetzt",
          [
            `User: ${targetId}`,
            `Dauer: ${durationMs ? formatDuration(durationMs) : "Permanent"}`,
            `Grund: ${reason || "Kein Grund angegeben"}`,
          ],
          "",
          "✅",
        );
        break;
      }

      case "unban": {
        // Owner: Ban aufheben
        if (!isOwner(senderId)) {
          await sendText(
            sock,
            chatId,
            m,
            "Kein Zugriff",
            ["Owner only."],
            "",
            "🚫",
          );
          break;
        }
        const targetId = extractTargetId(m, args);
        if (!targetId) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}unban <id|@user>`],
            "",
            "ℹ️",
          );
          break;
        }
        await clearBan(db, targetId);
        await sendPlain(
          sock,
          targetId,
          "Entbannt",
          ["Du kannst den Bot wieder nutzen."],
          "",
          "✅",
        );
        await sendText(
          sock,
          chatId,
          m,
          "Unban",
          [`User: ${targetId}`],
          "",
          "✅",
        );
        break;
      }

      case "setphn": {
        // Owner: PHN manuell setzen
        if (!isOwner(senderId)) {
          await sendText(
            sock,
            chatId,
            m,
            "Kein Zugriff",
            ["Owner only."],
            "",
            "🚫",
          );
          break;
        }
        const targetId = extractTargetId(m, args);
        const amount = Number(args[1]);
        if (!targetId || !Number.isFinite(amount) || amount < 0) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}setphn <id|@user> <betrag>`],
            "",
            "ℹ️",
          );
          break;
        }
        const targetUser = await getUser(db, targetId);
        if (!targetUser) {
          await sendText(
            sock,
            chatId,
            m,
            "Fehler",
            ["User nicht gefunden."],
            "",
            "⚠️",
          );
          break;
        }
        await setBalance(db, targetId, Math.floor(amount));
        await sendText(
          sock,
          chatId,
          m,
          "PHN gesetzt",
          [
            `User: ${targetId}`,
            `Neuer Stand: ${Math.floor(amount)} ${CURRENCY}`,
          ],
          "",
          "✅",
        );
        break;
      }

      case "purge": {
        // Owner: Profil komplett loeschen
        if (!isOwner(senderId)) {
          await sendText(
            sock,
            chatId,
            m,
            "Kein Zugriff",
            ["Owner only."],
            "",
            "🚫",
          );
          break;
        }
        const targetId = extractTargetId(m, args);
        if (!targetId) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}purge <id|@user>`],
            "",
            "ℹ️",
          );
          break;
        }
        await deleteUser(db, targetId);
        await sendText(
          sock,
          chatId,
          m,
          "Profil geloescht",
          [`User: ${targetId}`],
          "",
          "🗑️",
        );
        break;
      }

      case "todo": {
        // Owner: ToDo-Liste verwalten (add/list/edit/done/del)
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }

        const action = (args[0] || "").toLowerCase();

        if (!action || !["add", "list", "edit", "done", "del", "delete"].includes(action)) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [
              `${prefix}todo add <text>`,
              `${prefix}todo list [open|done|all]`,
              `${prefix}todo edit <id> <text>`,
              `${prefix}todo done <id>`,
              `${prefix}todo del <id>`,
            ],
            "",
            "ℹ️",
          );
          break;
        }

        if (action === "add") {
          const text = args.slice(1).join(" ").trim();
          if (!text) {
            await sendText(sock, chatId, m, "Fehler", ["Text fehlt."], "", "⚠️");
            break;
          }
          await addOwnerTodo(db, text, senderId);
          await sendText(sock, chatId, m, "ToDo erstellt", [text], "", "✅");
          break;
        }

        if (action === "list") {
          const mode = (args[1] || "open").toLowerCase();
          const status = ["open", "done", "all"].includes(mode) ? mode : "open";
          const todos = await listOwnerTodos(db, status);
          if (!todos.length) {
            await sendText(sock, chatId, m, "ToDos", [`Keine Eintraege fuer '${status}'.`], "", "📋");
            break;
          }
          const lines = todos.map((t) => {
            const when = formatDateTime(t.done_at || t.updated_at || t.created_at);
            const state = t.status === "done" ? "done" : "open";
            return `#${t.id} | ${state} | ${when}\n${t.text}`;
          });
          await sendText(sock, chatId, m, `ToDos (${status}, ${todos.length})`, lines, "", "📋");
          break;
        }

        if (action === "edit") {
          const id = Number(args[1]);
          const text = args.slice(2).join(" ").trim();
          if (!Number.isInteger(id) || id <= 0 || !text) {
            await sendText(sock, chatId, m, "Usage", [`${prefix}todo edit <id> <text>`], "", "ℹ️");
            break;
          }
          const todos = await listOwnerTodos(db);
          if (!todos.some((t) => t.id === id)) {
            await sendText(sock, chatId, m, "Fehler", ["ToDo-ID nicht gefunden."], "", "⚠️");
            break;
          }
          await updateOwnerTodo(db, id, text);
          await sendText(sock, chatId, m, "ToDo aktualisiert", [`#${id}`, text], "", "✅");
          break;
        }

        if (action === "done") {
          const id = Number(args[1]);
          if (!Number.isInteger(id) || id <= 0) {
            await sendText(sock, chatId, m, "Usage", [`${prefix}todo done <id>`], "", "ℹ️");
            break;
          }
          const todos = await listOwnerTodos(db, "all");
          if (!todos.some((t) => t.id === id)) {
            await sendText(sock, chatId, m, "Fehler", ["ToDo-ID nicht gefunden."], "", "⚠️");
            break;
          }
          await setOwnerTodoStatus(db, id, "done");
          await sendText(sock, chatId, m, "ToDo erledigt", [`#${id}`], "", "✅");
          break;
        }

        const id = Number(args[1]);
        if (!Number.isInteger(id) || id <= 0) {
          await sendText(sock, chatId, m, "Usage", [`${prefix}todo del <id>`], "", "ℹ️");
          break;
        }
        const todos = await listOwnerTodos(db, "all");
        if (!todos.some((t) => t.id === id)) {
          await sendText(sock, chatId, m, "Fehler", ["ToDo-ID nicht gefunden."], "", "⚠️");
          break;
        }
        await deleteOwnerTodo(db, id);
        await sendText(sock, chatId, m, "ToDo geloescht", [`#${id}`], "", "🗑️");
        break;
      }

      case "bans": {
        // Owner: aktive Bans anzeigen
        if (!isOwner(senderId)) {
          await sendText(
            sock,
            chatId,
            m,
            "Kein Zugriff",
            ["Owner only."],
            "",
            "🚫",
          );
          break;
        }
        const bans = await listBans(db);
        const now = Date.now();
        const lines = [];
        for (const b of bans) {
          const expires = b.expires_at
            ? new Date(b.expires_at).getTime()
            : null;
          if (expires && expires <= now) {
            await clearBan(db, b.user_id);
            continue;
          }
          const remaining = expires
            ? formatDuration(expires - now)
            : "Permanent";
          lines.push(
            `${b.user_id} | ${remaining} | ${b.reason || "Kein Grund"}`,
          );
        }
        if (!lines.length) {
          await sendText(
            sock,
            chatId,
            m,
            "Bans",
            ["Keine aktiven Bans."],
            "",
            "✅",
          );
          break;
        }
        await sendText(sock, chatId, m, "Bans", lines, "", "⛔");
        break;
      }

      case "errors": {
        // Owner: letzte Fehler ausgeben
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        let limit = 10;
        let severity = "all";
        for (const a of args) {
          const maybeNum = Number(a);
          if (Number.isFinite(maybeNum) && maybeNum > 0) {
            limit = Math.min(50, Math.floor(maybeNum));
            continue;
          }
          const s = String(a || "").toLowerCase();
          if (["all", "info", "warn", "error", "fatal"].includes(s)) {
            severity = s;
          }
        }
        const rows = await listErrorLogs(db, limit, severity);
        if (!rows.length) {
          await sendText(sock, chatId, m, "Fehler-Log", [`Keine Eintraege fuer severity='${severity}'.`], "", "ℹ️");
          break;
        }
        const lines = rows.map((r) => {
          const cmd = r.command || "-";
          const chat = r.chat_id || "-";
          return `${r.error_id} | ${r.severity} | x${r.occurrences} | ${formatDateTime(r.last_seen_at)} | ${r.source} | cmd=${cmd} | chat=${chat}`;
        });
        await sendText(sock, chatId, m, `Fehler-Log (letzte ${rows.length}, severity=${severity})`, lines, "", "🧾");
        break;
      }

      case "error": {
        // Owner: Fehlerdetails nach ID anzeigen
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const errorId = (args[0] || "").trim();
        if (!errorId) {
          await sendText(sock, chatId, m, "Usage", [`${prefix}error <FEHLER-ID>`], "", "ℹ️");
          break;
        }
        const row = await getErrorLogById(db, errorId);
        if (!row) {
          await sendText(sock, chatId, m, "Fehler", ["Fehler-ID nicht gefunden."], "", "⚠️");
          break;
        }
        const stackPreview = row.error_stack
          ? row.error_stack.split("\n").slice(0, 8).join("\n")
          : "kein stack";
        await sendText(
          sock,
          chatId,
          m,
          `Fehler ${row.error_id}`,
          [
            `Severity: ${row.severity}`,
            `Erster Fehler: ${formatDateTime(row.first_seen_at)}`,
            `Letzter Fehler: ${formatDateTime(row.last_seen_at)}`,
            `Count: ${row.occurrences}`,
            `Quelle: ${row.source}`,
            `Befehl: ${row.command || "-"}`,
            `Chat: ${row.chat_id || "-"}`,
            `Meldung: ${row.error_message}`,
            `Stack:\n${stackPreview}`,
            `Fix-Queue: ${prefix}fix add ${row.error_id} <notiz>`,
          ],
          "",
          "🧾",
        );
        break;
      }

      case "errorfile": {
        // Owner: Fehler als Datei exportieren
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const errorId = (args[0] || "").trim();
        if (!errorId) {
          await sendText(sock, chatId, m, "Usage", [`${prefix}errorfile <FEHLER-ID>`], "", "ℹ️");
          break;
        }
        const row = await getErrorLogById(db, errorId);
        if (!row) {
          await sendText(sock, chatId, m, "Fehler", ["Fehler-ID nicht gefunden."], "", "⚠️");
          break;
        }
        const content =
          `Fehler-ID: ${row.error_id}\n` +
          `Severity: ${row.severity}\n` +
          `Erster Fehler: ${row.first_seen_at}\n` +
          `Letzter Fehler: ${row.last_seen_at}\n` +
          `Count: ${row.occurrences}\n` +
          `Quelle: ${row.source}\n` +
          `Befehl: ${row.command || "-"}\n` +
          `Chat: ${row.chat_id || "-"}\n` +
          `Meldung: ${row.error_message}\n\n` +
          `Stack:\n${row.error_stack || "kein stack"}`;
        const fileName = `${row.error_id}.txt`;
        const filePath = path.join(ERROR_EXPORT_DIR, fileName);
        fs.writeFileSync(filePath, content, "utf8");
        await sock.sendMessage(
          chatId,
          {
            document: fs.readFileSync(filePath),
            fileName,
            mimetype: "text/plain",
            caption: formatMessage(
              "Fehlerexport",
              [`Datei: ${row.error_id}.txt wurde erstellt.`],
              "",
              "🧾",
              buildMessageMeta(m, "errorfile"),
            ),
          },
          { quoted: m },
        );
        break;
      }

      case "fix": {
        // Owner: Fehler -> Fix-Queue
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const action = (args[0] || "").toLowerCase();
        if (!action || !["add", "list", "status"].includes(action)) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [
              `${prefix}fix add <FEHLER-ID> <notiz>`,
              `${prefix}fix list [open|in_progress|done|all] [limit]`,
              `${prefix}fix status <id> <open|in_progress|done> [notiz]`,
            ],
            "",
            "ℹ️",
          );
          break;
        }
        if (action === "add") {
          const errorId = (args[1] || "").trim();
          const note = args.slice(2).join(" ").trim();
          if (!errorId) {
            await sendText(sock, chatId, m, "Usage", [`${prefix}fix add <FEHLER-ID> <notiz>`], "", "ℹ️");
            break;
          }
          const errRow = await getErrorLogById(db, errorId);
          if (!errRow) {
            await sendText(sock, chatId, m, "Fehler", ["Fehler-ID nicht gefunden."], "", "⚠️");
            break;
          }
          await addFixQueueEntry(db, errorId, note || null, senderId);
          await sendText(sock, chatId, m, "Fix-Queue", [`Hinzugefuegt: ${errorId}`, `Notiz: ${note || "-"}`], "", "✅");
          break;
        }
        if (action === "list") {
          let status = "open";
          let limit = 20;
          for (const a of args.slice(1)) {
            const s = String(a).toLowerCase();
            const n = Number(a);
            if (["open", "in_progress", "done", "all"].includes(s)) status = s;
            if (Number.isFinite(n) && n > 0) limit = Math.min(50, Math.floor(n));
          }
          const rows = await listFixQueue(db, status, limit);
          if (!rows.length) {
            await sendText(sock, chatId, m, "Fix-Queue", [`Keine Eintraege fuer '${status}'.`], "", "ℹ️");
            break;
          }
          const lines = rows.map((r) => `#${r.id} | ${r.status} | ${r.error_id} | ${formatDateTime(r.updated_at)}${r.owner_note ? `\n${r.owner_note}` : ""}`);
          await sendText(sock, chatId, m, `Fix-Queue (${rows.length})`, lines, "", "🛠️");
          break;
        }
        const id = Number(args[1]);
        const status = (args[2] || "").toLowerCase();
        const note = args.slice(3).join(" ").trim();
        if (!Number.isInteger(id) || id <= 0 || !["open", "in_progress", "done"].includes(status)) {
          await sendText(sock, chatId, m, "Usage", [`${prefix}fix status <id> <open|in_progress|done> [notiz]`], "", "ℹ️");
          break;
        }
        const row = await getFixQueueEntry(db, id);
        if (!row) {
          await sendText(sock, chatId, m, "Fehler", ["Fix-ID nicht gefunden."], "", "⚠️");
          break;
        }
        await updateFixQueueStatus(db, id, status, note || null);
        await sendText(sock, chatId, m, "Fix-Queue aktualisiert", [`#${id} -> ${status}`, `Notiz: ${note || "-"}`], "", "✅");
        break;
      }

      case "audits": {
        // Owner: Audit-Log owner Befehle
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const reqLimit = Number(args[0]);
        const limit = Number.isFinite(reqLimit) && reqLimit > 0 ? Math.min(50, Math.floor(reqLimit)) : 20;
        const rows = await listOwnerAuditLogs(db, limit);
        if (!rows.length) {
          await sendText(sock, chatId, m, "Owner-Audits", ["Keine Eintraege vorhanden."], "", "ℹ️");
          break;
        }
        const lines = rows.map((r) => `${formatDateTime(r.created_at)} | ${r.actor_id} | ${r.command} | target=${r.target_id || "-"}`);
        await sendText(sock, chatId, m, `Owner-Audits (${rows.length})`, lines, "", "🧾");
        break;
      }

      case "health": {
        // Owner: Bot-Health/Selftest/Queues
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const [usersRow, errorsRow, fixesRow] = await Promise.all([
          db.get("SELECT COUNT(*) AS c FROM users"),
          db.get("SELECT COUNT(*) AS c FROM error_logs"),
          db.get("SELECT COUNT(*) AS c FROM fix_queue WHERE status IN ('open','in_progress')"),
        ]);
        const used = process.memoryUsage().rss;
        const total = os.totalmem();
        const uptime = formatUptime(process.uptime());
        const lines = [
          `Uptime: ${uptime}`,
          `RAM: ${formatBytes(used)} / ${formatBytes(total)}`,
          `Users: ${usersRow?.c ?? 0}`,
          `Error-Logs: ${errorsRow?.c ?? 0}`,
          `Fix-Queue offen: ${fixesRow?.c ?? 0}`,
          `Pending NameChanges: ${pendingNameChanges.size}`,
          `Pending Deletes: ${pendingDeletes.size}`,
          `Pending Purchases: ${pendingPurchases.size}`,
          `Stacker Sessions: ${stackerSessions.size}`,
          `Blackjack Sessions: ${blackjackSessions.size}`,
          `Selftest Issues: ${startupSelftestIssues.length}`,
          `Last Disconnect: ${lastDisconnectInfo ? `${formatDateTime(lastDisconnectInfo.at)} | ${lastDisconnectInfo.reason} (${lastDisconnectInfo.code})` : "-"}`,
        ];
        await sendText(sock, chatId, m, "Health", lines, "", "🩺");
        break;
      }

      case "sendmsg": {
        // Owner: Direktnachricht an Nummer/JID senden (mit Signatur)
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const targetRaw = (args[0] || "").trim();
        const messageText = args.slice(1).join(" ").trim();
        const targetJid = normalizeTargetToJid(targetRaw);
        if (!targetJid || !messageText) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}sendmsg <nummer|jid> <nachricht>`],
            "",
            "ℹ️",
          );
          break;
        }
        const ownerUser = await getUser(db, chatId);
        const signature = `— ${ownerUser?.profile_name || toSingleLine(m?.pushName) || "Owner"}`;
        const finalText = `${messageText}\n\n${signature}`;
        try {
          await sock.sendMessage(targetJid, { text: finalText });
          await sendText(
            sock,
            chatId,
            m,
            "Nachricht gesendet",
            [`Empfaenger: ${targetJid}`, "Signatur angehaengt."],
            "",
            "✅",
          );
        } catch (err) {
          await sendText(
            sock,
            chatId,
            m,
            "Senden fehlgeschlagen",
            [`Empfaenger: ${targetJid}`, formatError(err).slice(0, 180)],
            "",
            "❌",
          );
        }
        break;
      }

      case "broadcast": {
        // Owner: Broadcast an users/groups/all senden (mit Signatur)
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const scope = (args[0] || "").toLowerCase();
        const text = args.slice(1).join(" ").trim();
        if (!["users", "groups", "all"].includes(scope) || !text) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}broadcast <users|groups|all> <nachricht>`],
            "",
            "ℹ️",
          );
          break;
        }
        const targets = await resolveBroadcastTargets(db, scope);
        if (!targets.length) {
          await sendText(
            sock,
            chatId,
            m,
            "Keine Ziele gefunden",
            [`Scope: ${scope}`, "Es wurden keine passenden Chats gefunden."],
            "",
            "⚠️",
          );
          break;
        }
        const ownerUser = await getUser(db, chatId);
        const signature = `— ${ownerUser?.profile_name || toSingleLine(m?.pushName) || "Owner"}`;
        const finalText = `${text}\n\n${signature}`;
        let success = 0;
        let failed = 0;
        for (const target of targets) {
          try {
            await sock.sendMessage(target, { text: finalText });
            success += 1;
            await wait(150);
          } catch {
            failed += 1;
          }
        }
        await sendText(
          sock,
          chatId,
          m,
          "Broadcast abgeschlossen",
          [`Scope: ${scope}`, `Gesendet: ${success}`, `Fehlgeschlagen: ${failed}`],
          "",
          success > 0 ? "📣" : "⚠️",
        );
        break;
      }

      case "outbox": {
        // Owner: Outbox-Status (pending/sent/failed/all)
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const statusRaw = (args[0] || "all").toLowerCase();
        const status = ["all", "pending", "sent", "failed"].includes(statusRaw) ? statusRaw : "all";
        const reqLimit = Number(args[1]);
        const limit = Number.isFinite(reqLimit) && reqLimit > 0 ? Math.min(50, Math.floor(reqLimit)) : 20;
        const rows = await listOwnerOutbox(db, status, limit);
        if (!rows.length) {
          await sendText(sock, chatId, m, "Outbox", [`Keine Eintraege (${status}).`], "", "ℹ️");
          break;
        }
        const lines = rows.map((r) => {
          const target = r.target_id || r.target_scope || "-";
          return `#${r.id} | ${r.status} | ${r.type} | ${target} | ${formatDateTime(r.created_at)}${r.error ? `\n${r.error}` : ""}`;
        });
        await sendText(sock, chatId, m, `Outbox (${rows.length})`, lines, "", "📬");
        break;
      }

      case "apppanel": {
        // Owner: App-Notfallpanel via WhatsApp
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const proc = await getFirstPm2Proc(OWNER_APP_PM2_NAMES);
        const status = proc?.pm2_env?.status || "unknown";
        const procName = proc?.name || OWNER_APP_PM2_NAMES[0];
        await sendText(
          sock,
          chatId,
          m,
          "App Notfallpanel",
          [
            `Prozess: ${procName}`,
            `Status: ${status}`,
            `▶️ Start: ${prefix}appstart`,
            `⏹️ Stop: ${prefix}appstop`,
            `🔄 Restart: ${prefix}apprestart`,
            `🧾 Logs: ${prefix}applogs [zeilen]`,
          ],
          "",
          "📱",
        );
        break;
      }

      case "appstart":
      case "appstop":
      case "apprestart": {
        // Owner: Owner-App PM2 steuern
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const action = cmd === "appstart" ? "start" : cmd === "appstop" ? "stop" : "restart";
        const proc = await getFirstPm2Proc(OWNER_APP_PM2_NAMES);
        const processName = proc?.name || OWNER_APP_PM2_NAMES[0];
        const res = await runPm2([action, processName]);
        if (!res.ok) {
          await sendText(sock, chatId, m, "PM2 Fehler", [res.stderr.slice(0, 200)], "", "❌");
          break;
        }
        const procAfter = await getPm2Proc(processName);
        await sendText(
          sock,
          chatId,
          m,
          "App Prozess",
          [`Prozess: ${processName}`, `Aktion: ${action}`, `Status: ${procAfter?.pm2_env?.status || "unknown"}`],
          "",
          "✅",
        );
        break;
      }

      case "applogs": {
        // Owner: letzte App-Logs anzeigen
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const reqLines = Number(args[0]);
        const lines = Number.isFinite(reqLines) && reqLines > 0 ? Math.min(120, Math.floor(reqLines)) : 40;
        const proc = await getFirstPm2Proc(OWNER_APP_PM2_NAMES);
        const processName = proc?.name || OWNER_APP_PM2_NAMES[0];
        const outPath = getPm2LogPath(processName, "out");
        const errPath = getPm2LogPath(processName, "error");
        const outTail = tailFileSafe(outPath, lines);
        const errTail = tailFileSafe(errPath, lines);
        const text = `--- OUT ---\n${outTail || "<leer>"}\n\n--- ERR ---\n${errTail || "<leer>"}`;
        const fileName = `applogs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
        const filePath = path.join(ERROR_EXPORT_DIR, fileName);
        fs.writeFileSync(filePath, text, "utf8");
        await sock.sendMessage(
          chatId,
          {
            document: fs.readFileSync(filePath),
            fileName,
            mimetype: "text/plain",
            caption: formatMessage(
              "App Logs",
              [`Prozess: ${processName}`, `Datei mit den letzten ${lines} Zeilen.`],
              "",
              "🧾",
              buildMessageMeta(m, "applogs"),
            ),
          },
          { quoted: m },
        );
        break;
      }

      case "biodebug": {
        // Owner: Bio-Fetch debuggen und ggf. direkt speichern
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const targetRaw = (args[0] || "").trim();
        const targetJid = targetRaw ? normalizeTargetToJid(targetRaw) : senderId;
        if (!targetJid || !targetJid.includes("@")) {
          await sendText(sock, chatId, m, "Usage", [`${prefix}biodebug [nummer|jid]`], "", "ℹ️");
          break;
        }
        try {
          const lines = await debugUserBiographyFetch(db, sock, targetJid, [senderId, chatId]);
          await sendText(sock, chatId, m, "Bio Debug", lines.slice(0, 24), "", "🧪");
        } catch (err) {
          await sendText(sock, chatId, m, "Bio Debug", [formatError(err).slice(0, 220)], "", "❌");
        }
        break;
      }

      case "setbio": {
        // Owner: manuelle Bio setzen (Fallback, falls WhatsApp-Status nicht abrufbar ist)
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const text = args.join(" ").trim();
        if (!text) {
          await sendText(sock, chatId, m, "Usage", [`${prefix}setbio <text>`], "", "ℹ️");
          break;
        }
        await setUserBiography(db, chatId, text);
        await sendText(sock, chatId, m, "Bio gesetzt", [text], "", "✅");
        break;
      }

      case "showbio": {
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const me = await getUser(db, chatId);
        const bio = String(me?.profile_bio || "").trim();
        await sendText(sock, chatId, m, "Aktuelle Bio", [bio || "Keine Bio gesetzt."], "", "ℹ️");
        break;
      }

      case "clearbio": {
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        await setUserBiography(db, chatId, "");
        await sendText(sock, chatId, m, "Bio gelöscht", ["Deine gespeicherte Bio wurde entfernt."], "", "🧹");
        break;
      }

      case "saveavatar": {
        // Owner: WhatsApp-Profilbild lokal speichern und Pfad in users.profile_photo_url setzen
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const targetRaw = (args[0] || "").trim();
        const targetJid = targetRaw ? normalizeTargetToJid(targetRaw) : senderId;
        if (!targetJid) {
          await sendText(sock, chatId, m, "Usage", [`${prefix}saveavatar [nummer|jid]`], "", "ℹ️");
          break;
        }
        try {
          const result = await saveAvatarForChat(db, sock, targetJid);
          await sendText(
            sock,
            chatId,
            m,
            "Avatar gespeichert",
            [
              `User: ${targetJid}`,
              `Pfad: ${result.publicPath}`,
              `Datei: ${path.basename(result.filePath)}`,
              `Größe: ${formatBytes(result.size)}`,
            ],
            "",
            "🖼️",
          );
        } catch (err) {
          await sendText(sock, chatId, m, "Avatar Fehler", [formatError(err).slice(0, 220)], "", "❌");
        }
        break;
      }

      case "apkstatus": {
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const lp = readOwnerLocalProperties();
        const st = readOwnerAppUrlState();
        const exists = fs.existsSync(OWNER_APK_PATH);
        const size = exists ? formatBytes(fs.statSync(OWNER_APK_PATH).size) : "-";
        await sendText(
          sock,
          chatId,
          m,
          "APK Status",
          [
            `URL: ${lp.appUrl || "-"}`,
            `Version: ${formatOwnerVersion(lp.versionCode || 0)}`,
            `VersionCode: ${lp.versionCode || "-"}`,
            `Download: ${lp.apkDownloadUrl || "-"}`,
            `APK Datei: ${exists ? "vorhanden" : "fehlt"}`,
            `Groesse: ${size}`,
            `Letzter Build-URL: ${st.lastUrl || "-"}`,
            `Letzter Build-VersionCode: ${st.lastVersionCode || "-"}`,
            `Letzter Versand OK: ${st.lastSendOk ? "ja" : "nein"}`,
            `Letzter Versuch: ${st.lastAttemptAt ? formatDateTime(st.lastAttemptAt) : "-"}`,
          ],
          "",
          "📦",
        );
        break;
      }

      case "apkbuild": {
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        if (ownerApkBuildRunning) {
          await sendText(sock, chatId, m, "APK Build", ["Build läuft bereits."], "", "⏳");
          break;
        }
        const hintText = args.join(" ");
        const bump = bumpOwnerLocalVersionForBuild(hintText);
        const lp = readOwnerLocalProperties();
        await sendText(
          sock,
          chatId,
          m,
          "APK Build",
          [
            "Start wurde ausgelöst.",
            `Update-Typ: ${bump.bumpType}`,
            `Version: ${bump.prevVersion} -> ${bump.nextVersion}`,
            `VersionCode: ${bump.prevCode} -> ${bump.nextCode}`,
          ],
          "",
          "🚀",
        );
        buildOwnerApkAndSend(sock, lp.appUrl, "manual-cmd").catch(() => {});
        break;
      }

      case "apksend": {
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        if (!fs.existsSync(OWNER_APK_PATH)) {
          await sendText(sock, chatId, m, "APK senden", ["APK Datei fehlt. Nutze erst -apkbuild"], "", "❌");
          break;
        }
        const apk = fs.readFileSync(OWNER_APK_PATH);
        await sock.sendMessage(
          chatId,
          {
            document: apk,
            fileName: `owner-app-manual-${new Date().toISOString().replace(/[:.]/g, "-")}.apk`,
            mimetype: "application/vnd.android.package-archive",
            caption: formatMessage(
              "Owner APK (manuell)",
              [
                `Datei: ${path.basename(OWNER_APK_PATH)}`,
                `Groesse: ${formatBytes(apk.length)}`,
                `Tipp: -apkstatus fuer Debug`,
              ],
              "",
              "📤",
              buildMessageMeta(m, "apksend"),
            ),
          },
          { quoted: m },
        );
        break;
      }

      case "sendpc":
      case "pcupload": {
        // Owner: Text/Datei vom Handy auf den Laptop speichern
        if (!isOwner(senderId)) {
          await sendText(sock, chatId, m, "Kein Zugriff", ["Owner only."], "", "🚫");
          break;
        }
        const quotedMsg =
          m.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
        const media =
          getMediaFromMessage(m.message) || getMediaFromMessage(quotedMsg);
        const rawBody = (body || "").slice(prefix.length).trim();
        const raw = rawBody.replace(/^sendpc\b/i, "").replace(/^pcupload\b/i, "").trim();
        let customName = "";
        let text = raw;
        const nameMatch = raw.match(/--name\s+"([^"]+)"\s*([\s\S]*)$/);
        if (nameMatch) {
          customName = nameMatch[1].trim();
          text = (nameMatch[2] || "");
        }

        if (!media && !text) {
          await sendText(
            sock,
            chatId,
            m,
            "Usage",
            [`${prefix}sendpc --name "DATEI" <text>`],
            "",
            "ℹ️",
          );
          break;
        }

        if (media) {
          const buf = await downloadMediaToBuffer(media.content, media.type);
          const mime = media.content?.mimetype;
          const fileName =
            media.type === "document" && media.content?.fileName
              ? media.content.fileName
              : null;
          const ext = extFromMime(
            mime,
            media.type === "image"
              ? ".jpg"
              : media.type === "video"
                ? ".mp4"
                : media.type === "audio"
                  ? ".ogg"
                  : ".bin",
          );
          const base = customName
            ? customName + (customName.includes(".") ? "" : ext)
            : fileName ||
              `${media.type}-${new Date().toISOString().replace(/[:.]/g, "-")}${ext}`;
          const safeName = base.replace(/[^\w.\-() ]+/g, "_");
          const filePath = path.join(INBOX_DIR, safeName);
          fs.writeFileSync(filePath, buf);
          await sendText(
            sock,
            chatId,
            m,
            "Gespeichert",
            [`Datei: ${safeName}`, `Groesse: ${formatBytes(buf.length)}`],
            "",
            "✅",
          );
          break;
        }

        // Text speichern
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const base = customName
          ? customName + (customName.endsWith(".txt") ? "" : ".txt")
          : `text-${ts}.txt`;
        const safeName = base.replace(/[^\w.\-() ]+/g, "_");
        const filePath = path.join(INBOX_DIR, safeName);
        fs.writeFileSync(filePath, text, "utf8");
        await sendText(
          sock,
          chatId,
          m,
          "Gespeichert",
          [`Text-Datei: ${path.basename(filePath)}`],
          "",
          "✅",
        );
        break;
      }

      case "dbdump": {
        // Owner: Datenbank-Dump als Textdatei senden
        if (!isOwner(senderId)) {
          await sendText(
            sock,
            chatId,
            m,
            "Kein Zugriff",
            ["Owner only."],
            "",
            "🚫",
          );
          break;
        }
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;
        await sendDbDumpPdf(sock, chatId, db, m);
        break;
      }

      case "delete": {
        // Account-Loeschung mit Bestaetigungscode
        const user = await requireVerified(
          sock,
          m,
          chatId,
          prefix,
          await getUser(db, chatId),
        );
        if (!user) break;

        const token = Math.random().toString(36).slice(2, 8).toUpperCase();
        const expiresAt = Date.now() + 2 * 60 * 1000;
        pendingDeletes.set(chatId, { token, expiresAt });

        await sendText(
          sock,
          chatId,
          m,
          "Account loeschen",
          [
            "Dieser Vorgang loescht dein Profil dauerhaft.",
            `Bestaetigen: ${prefix}confirmdelete ${token}`,
            "Gueltig fuer 2 Minuten.",
          ],
          "",
          "⚠️",
        );
        break;
      }

      case "confirmdelete": {
        // Account-Loeschung final bestaetigen
        const entry = pendingDeletes.get(chatId);
        if (!entry || entry.expiresAt < Date.now()) {
          pendingDeletes.delete(chatId);
          await sendText(
            sock,
            chatId,
            m,
            "Kein Vorgang",
            ["Starte mit -delete."],
            "",
            "ℹ️",
          );
          break;
        }
        const token = (args[0] || "").toUpperCase();
        if (!token || token !== entry.token) {
          await sendText(
            sock,
            chatId,
            m,
            "Fehler",
            ["Bestaetigungscode ist falsch."],
            "",
            "⚠️",
          );
          break;
        }
        pendingDeletes.delete(chatId);
        await deleteUser(db, chatId);
        await sendText(
          sock,
          chatId,
          m,
          "Account geloescht",
          [
            "Alle gespeicherten Daten wurden entfernt.",
            "Profil, Wallet, Quests, Freunde, DSGVO-Zustimmung.",
          ],
          "",
          "✅",
        );
        break;
      }

      case "prefix":
      case "setprefix": {
        // Prefix fuer den aktuellen Chat setzen
        const next = args[0];
        if (!next) {
          // Kein neuer Prefix angegeben -> aktuellen anzeigen + Usage
          await sendText(
            sock,
            chatId,
            m,
            "Prefix",
            [`Aktuell: ${prefix}`, `Usage: ${prefix}prefix <neues_prefix>`],
            "",
            "🔧",
          );
          break;
        }
        if (next.length > 3) {
          // Sicherheitslimit: Prefix nicht zu lang
          await sendText(
            sock,
            chatId,
            m,
            "Fehler",
            ["Prefix zu lang. Max 3 Zeichen."],
            "",
            "⚠️",
          );
          break;
        }
        // Prefix speichern und bestaetigen
        prefixes[chatId] = next;
        savePrefixes(prefixes);
        await sendText(sock, chatId, m, "Prefix gesetzt", [next], "", "✅");
        break;
      }

      default:
        // Unbekannter Befehl -> Hinweis auf Hilfe
        await sendText(
          sock,
          chatId,
          m,
          "Unbekannter Befehl",
          [`${prefix}menu fuer Hilfe`],
          "",
          "❓",
        );
        break;
    }
    } catch (err) {
      const chatId = m.key?.remoteJid;
      const body = getText(m.message);
      let cmdFromBody = null;
      if (chatId && body) {
        const prefixes = loadPrefixes();
        const prefix = prefixes[chatId] || "-";
        const parsed = parseCommand(body, prefix);
        cmdFromBody = parsed?.cmd || null;
      }
      const errorId = await recordError("command_handler", err, cmdFromBody, chatId);
      if (chatId) {
        try {
          await sendPlain(
            sock,
            chatId,
            "Interner Fehler",
            ["Beim Verarbeiten ist ein Fehler aufgetreten.", `Fehler-ID: ${errorId}`],
            "",
            "⚠️",
          );
        } catch (notifyErr) {
          await recordError("error_notify_user", notifyErr, cmdFromBody, chatId);
        }
      }
    }
  });
}

process.on("unhandledRejection", (reason) => {
  recordError("unhandled_rejection", reason instanceof Error ? reason : new Error(formatError(reason))).catch(() => {});
});

process.on("uncaughtException", (err) => {
  recordError("uncaught_exception", err).catch(() => {});
});

start().catch((err) => {
  recordError("startup", err).catch(() => {});
});
