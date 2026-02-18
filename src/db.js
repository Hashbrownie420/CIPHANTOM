import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "cipherphantom.db");

export async function initDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = await open({
    filename: DB_FILE,
    driver: sqlite3.Database,
  });

  await db.exec("PRAGMA journal_mode = WAL");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id TEXT PRIMARY KEY,
      profile_name TEXT NOT NULL,
      friend_code TEXT UNIQUE NOT NULL,
      wallet_address TEXT UNIQUE,
      created_at TEXT NOT NULL,
      xp INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      phn INTEGER NOT NULL DEFAULT 0,
      last_daily TEXT,
      daily_streak INTEGER NOT NULL DEFAULT 0,
      last_weekly TEXT,
      dsgvo_accepted_at TEXT,
      dsgvo_version TEXT,
      user_role TEXT NOT NULL DEFAULT 'user',
      level_role TEXT NOT NULL DEFAULT 'Rookie',
      last_name_change TEXT,
      game_daily_date TEXT,
      game_daily_profit INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS friends (
      user_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, friend_id)
    );

    CREATE TABLE IF NOT EXISTS quests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      title TEXT NOT NULL,
      period TEXT NOT NULL,
      target INTEGER NOT NULL,
      reward_phn INTEGER NOT NULL,
      reward_xp INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS user_quests (
      user_id TEXT NOT NULL,
      quest_id INTEGER NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      claimed_at TEXT,
      UNIQUE(user_id, quest_id)
    );

    CREATE TABLE IF NOT EXISTS dsgvo_accepts (
      chat_id TEXT PRIMARY KEY,
      accepted_at TEXT NOT NULL,
      version TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS characters (
      user_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      health INTEGER NOT NULL DEFAULT 100,
      hunger INTEGER NOT NULL DEFAULT 0,
      last_work TEXT,
      last_feed TEXT,
      last_tick TEXT,
      created_at TEXT NOT NULL,
      rename_count INTEGER NOT NULL DEFAULT 0,
      last_maintenance TEXT
    );

    CREATE TABLE IF NOT EXISTS bans (
      user_id TEXT PRIMARY KEY,
      reason TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS owner_todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      done_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS error_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      error_id TEXT UNIQUE NOT NULL,
      severity TEXT NOT NULL DEFAULT 'error',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL,
      command TEXT,
      chat_id TEXT,
      fingerprint TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL,
      error_stack TEXT
    );

    CREATE TABLE IF NOT EXISTS fix_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      error_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      owner_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS owner_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      command TEXT NOT NULL,
      target_id TEXT,
      payload TEXT
    );

    CREATE TABLE IF NOT EXISTS owner_auth (
      chat_id TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS known_chats (
      chat_id TEXT PRIMARY KEY,
      is_group INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS owner_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      target_id TEXT,
      target_scope TEXT,
      message TEXT NOT NULL,
      signature TEXT,
      created_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS command_help (
      cmd TEXT PRIMARY KEY,
      usage TEXT NOT NULL,
      purpose TEXT NOT NULL,
      tips TEXT,
      owner_only INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await ensureUserColumns(db);
  await ensureOwnerTodoColumns(db);
  await ensureErrorLogColumns(db);

  // Ensure unique constraint for upserts
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_quests_key ON quests(key)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_error_logs_error_id ON error_logs(error_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_error_logs_fingerprint_last_seen ON error_logs(fingerprint, last_seen_at)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_owner_outbox_status_created ON owner_outbox(status, created_at)");
  await seedQuests(db);
  await seedCommandHelp(db);
  return db;
}

async function ensureUserColumns(db) {
  const cols = await db.all("PRAGMA table_info(users)");
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("dsgvo_accepted_at")) {
    await db.exec("ALTER TABLE users ADD COLUMN dsgvo_accepted_at TEXT");
  }
  if (!names.has("dsgvo_version")) {
    await db.exec("ALTER TABLE users ADD COLUMN dsgvo_version TEXT");
  }
  if (!names.has("user_role")) {
    await db.exec("ALTER TABLE users ADD COLUMN user_role TEXT NOT NULL DEFAULT 'user'");
  }
  if (!names.has("level_role")) {
    await db.exec("ALTER TABLE users ADD COLUMN level_role TEXT NOT NULL DEFAULT 'Rookie'");
  }
  if (!names.has("last_name_change")) {
    await db.exec("ALTER TABLE users ADD COLUMN last_name_change TEXT");
  }
  if (!names.has("game_daily_date")) {
    await db.exec("ALTER TABLE users ADD COLUMN game_daily_date TEXT");
  }
  if (!names.has("game_daily_profit")) {
    await db.exec("ALTER TABLE users ADD COLUMN game_daily_profit INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("wallet_address")) {
    await db.exec("ALTER TABLE users ADD COLUMN wallet_address TEXT");
  }
  if (!names.has("profile_photo_url")) {
    await db.exec("ALTER TABLE users ADD COLUMN profile_photo_url TEXT");
  }
  if (!names.has("profile_bio")) {
    await db.exec("ALTER TABLE users ADD COLUMN profile_bio TEXT");
  }
}

async function ensureOwnerTodoColumns(db) {
  const cols = await db.all("PRAGMA table_info(owner_todos)");
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("status")) {
    await db.exec("ALTER TABLE owner_todos ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
  }
  if (!names.has("done_at")) {
    await db.exec("ALTER TABLE owner_todos ADD COLUMN done_at TEXT");
  }
}

async function ensureErrorLogColumns(db) {
  const cols = await db.all("PRAGMA table_info(error_logs)");
  const names = new Set(cols.map((c) => c.name));
  const createdExpr = names.has("created_at") ? "created_at" : "datetime('now')";
  if (!names.has("severity")) {
    await db.exec("ALTER TABLE error_logs ADD COLUMN severity TEXT NOT NULL DEFAULT 'error'");
  }
  if (!names.has("first_seen_at")) {
    await db.exec("ALTER TABLE error_logs ADD COLUMN first_seen_at TEXT");
    await db.exec(`UPDATE error_logs SET first_seen_at = COALESCE(${createdExpr}, datetime('now')) WHERE first_seen_at IS NULL`);
  }
  if (!names.has("last_seen_at")) {
    await db.exec("ALTER TABLE error_logs ADD COLUMN last_seen_at TEXT");
    await db.exec(`UPDATE error_logs SET last_seen_at = COALESCE(${createdExpr}, datetime('now')) WHERE last_seen_at IS NULL`);
  }
  if (!names.has("occurrences")) {
    await db.exec("ALTER TABLE error_logs ADD COLUMN occurrences INTEGER NOT NULL DEFAULT 1");
  }
  if (!names.has("fingerprint")) {
    await db.exec("ALTER TABLE error_logs ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''");
  }
}

async function seedQuests(db) {
  const quests = [
    {
      key: "daily_work_1",
      title: "Arbeite 1x",
      period: "daily",
      target: 1,
      reward_phn: 120,
      reward_xp: 80,
    },
    {
      key: "daily_feed_1",
      title: "Fuehre 1x Essen/Medizin aus",
      period: "daily",
      target: 1,
      reward_phn: 90,
      reward_xp: 70,
    },
    {
      key: "daily_keep_health",
      title: "Gesundheit >= 80 halten",
      period: "daily",
      target: 1,
      reward_phn: 110,
      reward_xp: 90,
    },
    {
      key: "daily_hunger_low",
      title: "Sattheit unter 30 halten",
      period: "daily",
      target: 1,
      reward_phn: 100,
      reward_xp: 80,
    },
    {
      key: "weekly_work_5",
      title: "Arbeite 5x",
      period: "weekly",
      target: 5,
      reward_phn: 500,
      reward_xp: 300,
    },
    {
      key: "weekly_feed_5",
      title: "Fuehre 5x Essen/Medizin aus",
      period: "weekly",
      target: 5,
      reward_phn: 450,
      reward_xp: 280,
    },
    {
      key: "monthly_work_20",
      title: "Arbeite 20x",
      period: "monthly",
      target: 20,
      reward_phn: 1800,
      reward_xp: 900,
    },
    {
      key: "monthly_feed_20",
      title: "Fuehre 20x Essen/Medizin aus",
      period: "monthly",
      target: 20,
      reward_phn: 1600,
      reward_xp: 850,
    },
    {
      key: "progress_age_30",
      title: "Erreiche Alter 30",
      period: "progress",
      target: 30,
      reward_phn: 900,
      reward_xp: 0,
    },
  ];

  await db.exec("BEGIN");
  try {
    for (const q of quests) {
      await db.run(
        `INSERT INTO quests (key, title, period, target, reward_phn, reward_xp, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET
           title=excluded.title,
           period=excluded.period,
           target=excluded.target,
           reward_phn=excluded.reward_phn,
           reward_xp=excluded.reward_xp,
           active=1`,
        q.key,
        q.title,
        q.period,
        q.target,
        q.reward_phn,
        q.reward_xp,
      );
    }
    // Deaktiviert alte Quests (Spiel-Quests)
    const keys = quests.map((q) => q.key);
    await db.run(
      `UPDATE quests SET active = 0 WHERE key NOT IN (${keys.map(() => "?").join(",")})`,
      keys,
    );
    await db.exec("COMMIT");
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
}

async function seedCommandHelp(db) {
  const entries = [
    ["menu", "menu", "Befehlsmenue", "Starte immer hier", 0],
    ["help", "help <befehl>", "Befehlshilfe", "Nutze exakte Befehlsnamen", 0],
    ["dsgvo", "dsgvo", "Datenschutztext", "Vor Registrierung lesen", 0],
    ["accept", "accept", "DSGVO bestaetigen", "Danach registrieren", 0],
    ["register", "register <name>", "Profil erstellen", "Name kurz halten", 0],
    ["profile", "profile", "Profil ansehen", "Zeigt Rollen und Wallet", 0],
    ["xp", "xp", "Levelstand", "Tipp: daily + quests", 0],
    ["level", "level", "Levelstand", "Alias von xp", 0],
    ["name", "name <neuer_name>", "Profilname aendern", "Hat Cooldown", 0],
    ["wallet", "wallet", "Kontostand sehen", "Adresse fuer Transfers", 0],
    ["pay", "pay <wallet_address> <betrag>", "PHN transferieren", "Limits beachten", 0],
    ["char", "char", "Charakterstatus", "Sattheit beobachten", 0],
    ["buychar", "buychar <name>", "Charakter kaufen", "Einmalig kaufen", 0],
    ["charname", "charname <neuer_name>", "Charakter umbenennen", "Nur begrenzt moeglich", 0],
    ["work", "work", "Arbeiten gehen", "Cooldown 3h", 0],
    ["feed", "feed <snack|meal|feast>", "Charakter fuettern", "Vorher Kauf bestaetigen", 0],
    ["med", "med <small|big>", "Medizin nutzen", "Vorher Kauf bestaetigen", 0],
    ["confirmbuy", "confirmbuy <code>", "Kauf bestaetigen", "Interner Bestaetigungsbefehl", 0],
    ["guide", "guide", "PDF Anleitung", "Fuer Neueinsteiger", 0],
    ["flip", "flip <betrag> <kopf|zahl>", "Coinflip spielen", "5m Spiel-Cooldown", 0],
    ["slots", "slots <betrag>", "Slots spielen", "5m Spiel-Cooldown", 0],
    ["roulette", "roulette <betrag> <typ> [wert]", "Roulette spielen", "Typen: rot/schwarz/gerade/ungerade/zahl", 0],
    ["blackjack", "blackjack <betrag>|hit|stand", "Blackjack spielen", "Erst Start mit Betrag", 0],
    ["fish", "fish <betrag>", "Fishgame spielen", "Multiplikator zufaellig", 0],
    ["stacker", "stacker <betrag>|cashout", "Stacker spielen", "Risiko stufenweise", 0],
    ["daily", "daily", "Tagesbonus holen", "Streak erhoeht Belohnung", 0],
    ["weekly", "weekly", "Wochenbonus holen", "1x pro Woche", 0],
    ["quests", "quests <daily|weekly|monthly|progress>", "Questliste", "Passende Kategorie waehlen", 0],
    ["claim", "claim <quest_id>", "Quest claimen", "Nur fertige Quests", 0],
    ["friendcode", "friendcode", "Freundescode zeigen", "Zum Adden teilen", 0],
    ["addfriend", "addfriend <code>", "Freund hinzufuegen", "Nicht selbst adden", 0],
    ["friends", "friends", "Freundesliste", "Zeigt gespeicherte Freunde", 0],
    ["delete", "delete", "Account loeschen", "Bestaetigungscode noetig", 0],
    ["confirmdelete", "confirmdelete <code>", "Loeschung bestaetigen", "Interner Bestaetigungsbefehl", 0],
    ["prefix", "prefix <neues_prefix>", "Prefix setzen", "Max 3 Zeichen", 0],
    ["setprefix", "setprefix <neues_prefix>", "Prefix setzen", "Alias von prefix", 0],
    ["ping", "ping", "Bot erreichbar?", "Schneller Check", 0],
    ["confirmname", "confirmname <code>", "Namensaenderung bestaetigen", "Interner Bestaetigungsbefehl", 0],
    ["chatid", "chatid", "Chat-ID sehen", "Owner only", 1],
    ["syncroles", "syncroles", "Rollen synchronisieren", "Owner only", 1],
    ["dbdump", "dbdump", "DB als PDF", "Owner only", 1],
    ["ban", "ban <id|@user> [dauer] [grund]", "Nutzer sperren", "Owner only", 1],
    ["unban", "unban <id|@user>", "Sperre aufheben", "Owner only", 1],
    ["bans", "bans", "Sperrliste", "Owner only", 1],
    ["setphn", "setphn <id|@user> <betrag>", "PHN setzen", "Owner only", 1],
    ["purge", "purge <id|@user>", "Profil entfernen", "Owner only", 1],
    ["todo", "todo <add|list|edit|done|del> ...", "Owner-Aufgaben", "Owner only", 1],
    ["errors", "errors [limit] [severity]", "Fehlerliste", "Owner only", 1],
    ["error", "error <FEHLER-ID>", "Fehlerdetails", "Owner only", 1],
    ["errorfile", "errorfile <FEHLER-ID>", "Fehlerexport", "Owner only", 1],
    ["fix", "fix <add|list|status> ...", "Fix-Queue", "Owner only", 1],
    ["audits", "audits [limit]", "Owner-Auditlog", "Owner only", 1],
    ["health", "health", "Bot-Status", "Owner only", 1],
    ["sendpc", "sendpc --name \"DATEI\" <text|datei>", "Handy-Upload", "Owner only", 1],
    ["pcupload", "pcupload --name \"DATEI\" <text|datei>", "Handy-Upload", "Alias von sendpc", 1],
    ["sendmsg", "sendmsg <nummer|jid> <nachricht>", "Direktnachricht senden", "Owner only", 1],
    ["broadcast", "broadcast <users|groups|all> <nachricht>", "Broadcast senden", "Owner only", 1],
    ["outbox", "outbox [all|pending|sent|failed] [limit]", "Outboxstatus ansehen", "Owner only", 1],
    ["apppanel", "apppanel", "App Notfallpanel", "Owner only", 1],
    ["appstart", "appstart", "Owner-App starten", "Owner only", 1],
    ["appstop", "appstop", "Owner-App stoppen", "Owner only", 1],
    ["apprestart", "apprestart", "Owner-App neustarten", "Owner only", 1],
    ["applogs", "applogs [zeilen]", "Owner-App Logs exportieren", "Owner only", 1],
    ["ownerpass", "ownerpass <neues_passwort>", "Owner-Login Passwort setzen", "Owner only", 1],
    ["helpadd", "helpadd <cmd> | <usage> | <nutzen> | [tipps] | [owner_only]", "Hilfeeintrag anlegen", "Owner only", 1],
    ["helpedit", "helpedit <cmd> | <usage> | <nutzen> | [tipps] | [owner_only]", "Hilfeeintrag aendern", "Owner only", 1],
    ["helpdel", "helpdel <cmd>", "Hilfeeintrag loeschen", "Owner only", 1],
    ["helplist", "helplist [all|owner|public]", "Hilfeeintraege listen", "Owner only", 1],
  ];

  const now = new Date().toISOString();
  await db.exec("BEGIN");
  try {
    for (const [cmd, usage, purpose, tips, ownerOnly] of entries) {
      await db.run(
        `INSERT INTO command_help (cmd, usage, purpose, tips, owner_only, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cmd) DO UPDATE SET
           usage = excluded.usage,
           purpose = excluded.purpose,
           tips = excluded.tips,
           owner_only = excluded.owner_only,
           updated_at = excluded.updated_at`,
        cmd,
        usage,
        purpose,
        tips || null,
        ownerOnly ? 1 : 0,
        now,
        now
      );
    }
    await db.exec("COMMIT");
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
}

export async function getUser(db, chatId) {
  return db.get("SELECT * FROM users WHERE chat_id = ?", chatId);
}

export async function getUserByProfileName(db, profileName) {
  return db.get(
    "SELECT * FROM users WHERE lower(profile_name) = lower(?) LIMIT 1",
    profileName
  );
}

export async function createUser(db, chatId, profileName, friendCode, userRole, levelRole) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO users (chat_id, profile_name, friend_code, created_at)
     VALUES (?, ?, ?, ?)`
  , chatId, profileName, friendCode, now);
  await db.run(
    "UPDATE users SET user_role = ?, level_role = ? WHERE chat_id = ?",
    userRole,
    levelRole,
    chatId
  );
}

export async function setProfileName(db, chatId, profileName) {
  await db.run("UPDATE users SET profile_name = ? WHERE chat_id = ?", profileName, chatId);
}

export async function setUserProfilePhoto(db, chatId, profilePhotoUrl) {
  await db.run(
    "UPDATE users SET profile_photo_url = ? WHERE chat_id = ?",
    profilePhotoUrl || null,
    chatId
  );
}

export async function setUserBiography(db, chatId, profileBio) {
  await db.run(
    "UPDATE users SET profile_bio = ? WHERE chat_id = ?",
    profileBio || null,
    chatId
  );
}

export async function upsertOwnerPasswordHash(db, chatId, passwordHash, passwordSalt) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO owner_auth (chat_id, password_hash, password_salt, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       password_hash = excluded.password_hash,
       password_salt = excluded.password_salt,
       updated_at = excluded.updated_at`,
    chatId,
    passwordHash,
    passwordSalt,
    now
  );
}

export async function getOwnerAuthByChatId(db, chatId) {
  return db.get("SELECT * FROM owner_auth WHERE chat_id = ?", chatId);
}

export async function getOwnerAuthByUsername(db, username) {
  return db.get(
    `SELECT oa.*, u.profile_name, u.chat_id
     FROM owner_auth oa
     JOIN users u ON u.chat_id = oa.chat_id
     WHERE lower(u.profile_name) = lower(?)
     LIMIT 1`,
    username
  );
}

export async function setWalletAddress(db, chatId, walletAddress) {
  await db.run("UPDATE users SET wallet_address = ? WHERE chat_id = ?", walletAddress, chatId);
}

export async function getUserByWalletAddress(db, walletAddress) {
  return db.get("SELECT * FROM users WHERE wallet_address = ?", walletAddress);
}

export async function setNameChange(db, chatId, ts) {
  await db.run("UPDATE users SET last_name_change = ? WHERE chat_id = ?", ts, chatId);
}

export async function setGameDailyProfit(db, chatId, dateStr, profit) {
  await db.run(
    "UPDATE users SET game_daily_date = ?, game_daily_profit = ? WHERE chat_id = ?",
    dateStr,
    profit,
    chatId
  );
}

export async function getCharacter(db, userId) {
  return db.get("SELECT * FROM characters WHERE user_id = ?", userId);
}

export async function createCharacter(db, userId, name) {
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO characters (user_id, name, created_at, last_tick) VALUES (?, ?, ?, ?)",
    userId,
    name,
    now,
    now
  );
}

export async function updateCharacter(db, userId, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const vals = keys.map((k) => fields[k]);
  vals.push(userId);
  await db.run(`UPDATE characters SET ${sets} WHERE user_id = ?`, vals);
}

export async function setBan(db, userId, reason, expiresAt, createdBy) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO bans (user_id, reason, expires_at, created_at, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       reason = excluded.reason,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at,
       created_by = excluded.created_by`,
    userId,
    reason || null,
    expiresAt || null,
    now,
    createdBy
  );
}

export async function getBan(db, userId) {
  return db.get("SELECT * FROM bans WHERE user_id = ?", userId);
}

export async function clearBan(db, userId) {
  await db.run("DELETE FROM bans WHERE user_id = ?", userId);
}

export async function listBans(db) {
  return db.all("SELECT * FROM bans ORDER BY created_at DESC");
}

export async function addOwnerTodo(db, text, createdBy) {
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO owner_todos (text, status, done_at, created_at, updated_at, created_by) VALUES (?, 'open', NULL, ?, ?, ?)",
    text,
    now,
    now,
    createdBy
  );
}

export async function listOwnerTodos(db, status = "all") {
  if (status === "open" || status === "done") {
    return db.all(
      "SELECT * FROM owner_todos WHERE status = ? ORDER BY id DESC",
      status
    );
  }
  return db.all("SELECT * FROM owner_todos ORDER BY id DESC");
}

export async function updateOwnerTodo(db, id, text) {
  const now = new Date().toISOString();
  await db.run(
    "UPDATE owner_todos SET text = ?, updated_at = ? WHERE id = ?",
    text,
    now,
    id
  );
}

export async function deleteOwnerTodo(db, id) {
  await db.run("DELETE FROM owner_todos WHERE id = ?", id);
}

export async function setOwnerTodoStatus(db, id, status) {
  const now = new Date().toISOString();
  const doneAt = status === "done" ? now : null;
  await db.run(
    "UPDATE owner_todos SET status = ?, done_at = ?, updated_at = ? WHERE id = ?",
    status,
    doneAt,
    now,
    id
  );
}

export async function upsertErrorLog(
  db,
  errorId,
  severity,
  source,
  command,
  chatId,
  fingerprint,
  message,
  stack
) {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const existing = await db.get(
    `SELECT id, error_id, occurrences
     FROM error_logs
     WHERE fingerprint = ? AND last_seen_at >= ?
     ORDER BY id DESC
     LIMIT 1`,
    fingerprint,
    cutoff
  );
  if (existing) {
    const nextCount = (existing.occurrences || 1) + 1;
    await db.run(
      `UPDATE error_logs
       SET severity = ?, source = ?, command = ?, chat_id = ?, error_message = ?, error_stack = ?, last_seen_at = ?, occurrences = ?
       WHERE id = ?`,
      severity,
      source,
      command || null,
      chatId || null,
      message,
      stack || null,
      now,
      nextCount,
      existing.id
    );
    return { errorId: existing.error_id, deduped: true, occurrences: nextCount, firstSeenAt: null, lastSeenAt: now };
  }
  await db.run(
    `INSERT INTO error_logs
      (error_id, severity, first_seen_at, last_seen_at, occurrences, source, command, chat_id, fingerprint, error_message, error_stack)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    errorId,
    severity,
    now,
    now,
    source,
    command || null,
    chatId || null,
    fingerprint,
    message,
    stack || null
  );
  return { errorId, deduped: false, occurrences: 1, firstSeenAt: now, lastSeenAt: now };
}

export async function listErrorLogs(db, limit = 10, severity = "all") {
  if (severity && severity !== "all") {
    return db.all(
      `SELECT error_id, severity, first_seen_at, last_seen_at, occurrences, source, command, chat_id, error_message
       FROM error_logs
       WHERE severity = ?
       ORDER BY last_seen_at DESC
       LIMIT ?`,
      severity,
      limit
    );
  }
  return db.all(
    `SELECT error_id, severity, first_seen_at, last_seen_at, occurrences, source, command, chat_id, error_message
     FROM error_logs
     ORDER BY last_seen_at DESC
     LIMIT ?`,
    limit
  );
}

export async function getErrorLogById(db, errorId) {
  return db.get(
    `SELECT error_id, severity, first_seen_at, last_seen_at, occurrences, source, command, chat_id, error_message, error_stack
     FROM error_logs
     WHERE error_id = ?`,
    errorId
  );
}

export async function addFixQueueEntry(db, errorId, ownerNote, createdBy) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO fix_queue (error_id, status, owner_note, created_at, updated_at, created_by)
     VALUES (?, 'open', ?, ?, ?, ?)`,
    errorId,
    ownerNote || null,
    now,
    now,
    createdBy
  );
}

export async function listFixQueue(db, status = "all", limit = 20) {
  if (status === "open" || status === "in_progress" || status === "done") {
    return db.all(
      `SELECT * FROM fix_queue WHERE status = ? ORDER BY id DESC LIMIT ?`,
      status,
      limit
    );
  }
  return db.all(`SELECT * FROM fix_queue ORDER BY id DESC LIMIT ?`, limit);
}

export async function updateFixQueueStatus(db, id, status, ownerNote = null) {
  const now = new Date().toISOString();
  await db.run(
    "UPDATE fix_queue SET status = ?, owner_note = COALESCE(?, owner_note), updated_at = ? WHERE id = ?",
    status,
    ownerNote,
    now,
    id
  );
}

export async function getFixQueueEntry(db, id) {
  return db.get("SELECT * FROM fix_queue WHERE id = ?", id);
}

export async function addOwnerAuditLog(db, actorId, command, targetId = null, payload = null) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO owner_audit_logs (created_at, actor_id, command, target_id, payload)
     VALUES (?, ?, ?, ?, ?)`,
    now,
    actorId,
    command,
    targetId,
    payload
  );
}

export async function upsertKnownChat(db, chatId, isGroup) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO known_chats (chat_id, is_group, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       is_group = excluded.is_group,
       last_seen_at = excluded.last_seen_at`,
    chatId,
    isGroup ? 1 : 0,
    now
  );
}

export async function listKnownChats(db, groupOnly = false) {
  if (groupOnly) {
    return db.all("SELECT * FROM known_chats WHERE is_group = 1 ORDER BY last_seen_at DESC");
  }
  return db.all("SELECT * FROM known_chats ORDER BY last_seen_at DESC");
}

export async function addOwnerOutboxMessage(db, type, targetId, targetScope, message, signature, createdBy) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO owner_outbox
      (type, target_id, target_scope, message, signature, created_by, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    type,
    targetId || null,
    targetScope || null,
    message,
    signature || null,
    createdBy,
    now
  );
}

export async function listPendingOwnerOutbox(db, limit = 20) {
  return db.all(
    `SELECT * FROM owner_outbox
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT ?`,
    limit
  );
}

export async function markOwnerOutboxSent(db, id) {
  const now = new Date().toISOString();
  await db.run(
    "UPDATE owner_outbox SET status = 'sent', processed_at = ?, error = NULL WHERE id = ?",
    now,
    id
  );
}

export async function markOwnerOutboxFailed(db, id, errorText) {
  const now = new Date().toISOString();
  await db.run(
    "UPDATE owner_outbox SET status = 'failed', processed_at = ?, error = ? WHERE id = ?",
    now,
    errorText || "unknown error",
    id
  );
}

export async function listOwnerOutbox(db, status = "all", limit = 100) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit || 100)));
  if (status === "pending" || status === "sent" || status === "failed") {
    return db.all(
      `SELECT * FROM owner_outbox
       WHERE status = ?
       ORDER BY id DESC
       LIMIT ?`,
      status,
      safeLimit
    );
  }
  return db.all(
    `SELECT * FROM owner_outbox
     ORDER BY id DESC
     LIMIT ?`,
    safeLimit
  );
}

export async function listOwnerAuditLogs(db, limit = 20) {
  return db.all(
    `SELECT * FROM owner_audit_logs ORDER BY id DESC LIMIT ?`,
    limit
  );
}

export async function getCommandHelpEntry(db, cmd) {
  return db.get("SELECT * FROM command_help WHERE cmd = ?", cmd.toLowerCase());
}

export async function listCommandHelpEntries(db, mode = "all") {
  if (mode === "owner") {
    return db.all("SELECT * FROM command_help WHERE owner_only = 1 ORDER BY cmd ASC");
  }
  if (mode === "public") {
    return db.all("SELECT * FROM command_help WHERE owner_only = 0 ORDER BY cmd ASC");
  }
  return db.all("SELECT * FROM command_help ORDER BY cmd ASC");
}

export async function searchCommandHelpEntries(db, query) {
  const q = `%${query.toLowerCase()}%`;
  return db.all(
    `SELECT * FROM command_help
     WHERE lower(cmd) LIKE ?
        OR lower(usage) LIKE ?
        OR lower(purpose) LIKE ?
        OR lower(COALESCE(tips, '')) LIKE ?
     ORDER BY cmd ASC`,
    q,
    q,
    q,
    q
  );
}

export async function upsertCommandHelpEntry(db, cmd, usage, purpose, tips, ownerOnly) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO command_help (cmd, usage, purpose, tips, owner_only, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cmd) DO UPDATE SET
       usage = excluded.usage,
       purpose = excluded.purpose,
       tips = excluded.tips,
       owner_only = excluded.owner_only,
       updated_at = excluded.updated_at`,
    cmd.toLowerCase(),
    usage,
    purpose,
    tips || null,
    ownerOnly ? 1 : 0,
    now,
    now
  );
}

export async function deleteCommandHelpEntry(db, cmd) {
  await db.run("DELETE FROM command_help WHERE cmd = ?", cmd.toLowerCase());
}

export async function setBalance(db, chatId, phn) {
  await db.run("UPDATE users SET phn = ? WHERE chat_id = ?", phn, chatId);
}

export async function setUserRole(db, chatId, role) {
  await db.run("UPDATE users SET user_role = ? WHERE chat_id = ?", role, chatId);
}

export async function setLevelRole(db, chatId, role) {
  await db.run("UPDATE users SET level_role = ? WHERE chat_id = ?", role, chatId);
}

export async function addBalance(db, chatId, delta) {
  await db.run("UPDATE users SET phn = phn + ? WHERE chat_id = ?", delta, chatId);
}

export async function addXp(db, chatId, deltaXp, newLevel) {
  await db.run("UPDATE users SET xp = xp + ?, level = ? WHERE chat_id = ?", deltaXp, newLevel, chatId);
}

export async function setDaily(db, chatId, dateStr, streak) {
  await db.run(
    "UPDATE users SET last_daily = ?, daily_streak = ? WHERE chat_id = ?",
    dateStr,
    streak,
    chatId
  );
}

export async function setWeekly(db, chatId, weekStr) {
  await db.run("UPDATE users SET last_weekly = ? WHERE chat_id = ?", weekStr, chatId);
}

export async function setDsgvoAccepted(db, chatId, acceptedAt, version) {
  await db.run(
    "UPDATE users SET dsgvo_accepted_at = ?, dsgvo_version = ? WHERE chat_id = ?",
    acceptedAt,
    version,
    chatId
  );
}

export async function setPreDsgvoAccepted(db, chatId, acceptedAt, version) {
  await db.run(
    "INSERT OR REPLACE INTO dsgvo_accepts (chat_id, accepted_at, version) VALUES (?, ?, ?)",
    chatId,
    acceptedAt,
    version
  );
}

export async function getPreDsgvoAccepted(db, chatId) {
  return db.get("SELECT * FROM dsgvo_accepts WHERE chat_id = ?", chatId);
}

export async function clearPreDsgvoAccepted(db, chatId) {
  await db.run("DELETE FROM dsgvo_accepts WHERE chat_id = ?", chatId);
}

export async function getFriendByCode(db, code) {
  return db.get("SELECT * FROM users WHERE friend_code = ?", code);
}

export async function addFriend(db, userId, friendId) {
  const now = new Date().toISOString();
  await db.run(
    "INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)",
    userId,
    friendId,
    now
  );
}

export async function listFriends(db, userId) {
  return db.all(
    `SELECT u.chat_id, u.profile_name, u.friend_code
     FROM friends f
     JOIN users u ON u.chat_id = f.friend_id
     WHERE f.user_id = ?`,
    userId
  );
}

export async function listUsers(db) {
  return db.all("SELECT * FROM users ORDER BY created_at ASC");
}

export async function listQuests(db, period) {
  return db.all("SELECT * FROM quests WHERE active = 1 AND period = ?", period);
}

export async function getQuestByKey(db, key) {
  return db.get("SELECT * FROM quests WHERE key = ? AND active = 1", key);
}

export async function ensureUserQuest(db, userId, questId) {
  await db.run(
    "INSERT OR IGNORE INTO user_quests (user_id, quest_id) VALUES (?, ?)",
    userId,
    questId
  );
}

export async function getUserQuest(db, userId, questId) {
  return db.get(
    "SELECT * FROM user_quests WHERE user_id = ? AND quest_id = ?",
    userId,
    questId
  );
}

export async function updateQuestProgress(db, userId, questId, progress) {
  await db.run(
    "UPDATE user_quests SET progress = ? WHERE user_id = ? AND quest_id = ?",
    progress,
    userId,
    questId
  );
}

export async function completeQuest(db, userId, questId, ts) {
  await db.run(
    "UPDATE user_quests SET completed_at = ? WHERE user_id = ? AND quest_id = ?",
    ts,
    userId,
    questId
  );
}

export async function claimQuest(db, userId, questId, ts) {
  await db.run(
    "UPDATE user_quests SET claimed_at = ? WHERE user_id = ? AND quest_id = ?",
    ts,
    userId,
    questId
  );
}

export async function deleteUser(db, chatId) {
  await db.exec("BEGIN");
  try {
    await db.run("DELETE FROM user_quests WHERE user_id = ?", chatId);
    await db.run(
      "DELETE FROM friends WHERE user_id = ? OR friend_id = ?",
      chatId,
      chatId
    );
    await db.run("DELETE FROM characters WHERE user_id = ?", chatId);
    await db.run("DELETE FROM bans WHERE user_id = ?", chatId);
    await db.run("DELETE FROM users WHERE chat_id = ?", chatId);
    await db.run("DELETE FROM dsgvo_accepts WHERE chat_id = ?", chatId);
    await db.exec("COMMIT");
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
}

export async function dumpAll(db) {
  const users = await db.all("SELECT * FROM users");
  const friends = await db.all("SELECT * FROM friends");
  const quests = await db.all("SELECT * FROM quests");
  const userQuests = await db.all("SELECT * FROM user_quests");
  const dsgvoAccepts = await db.all("SELECT * FROM dsgvo_accepts");
  return { users, friends, quests, userQuests, dsgvoAccepts };
}
