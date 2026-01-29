// server/server.js
import express from "express";
import path from "path";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import Database from "better-sqlite3";
import bcrypt from "bcrypt";

dotenv.config();
const PORT = process.env.PORT ?? 3000;
const API_KEY = process.env.API_KEY ?? "replace_me";
const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "data", "gmb.db");

const app = express();
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

// ensure data folder exists (node >= 18)
import fs from "fs";
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// open DB
const db = new Database(DB_PATH);

// create tables (if not exists)
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_jid TEXT UNIQUE,
  phone TEXT UNIQUE,
  password_hash TEXT,
  verified INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  profile_json TEXT
);

CREATE TABLE IF NOT EXISTS coins (
  user_id INTEGER PRIMARY KEY,
  balance INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  type TEXT,
  amount INTEGER,
  meta TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS verify_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  code TEXT,
  expires_at DATETIME,
  used INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// static web
app.use("/", express.static(path.join(process.cwd(), "web")));

// helper: find or create user by phone on register
function findUserByPhone(phone){
  return db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone);
}

app.post("/api/register", async (req, res) => {
  try {
    const { phone, password, profile } = req.body;
    if (!phone || !password) return res.status(400).json({ error: "phone & password required" });

    if (findUserByPhone(phone)) return res.status(400).json({ error: "phone already registered" });

    const hash = await bcrypt.hash(password, 10);
    const info = db.prepare(`INSERT INTO users (phone, password_hash, profile_json) VALUES (?, ?, ?)`)
                   .run(phone, hash, profile ? JSON.stringify(profile) : null);
    const userId = info.lastInsertRowid;

    // create verify code
    const code = Math.floor(100000 + Math.random()*900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min
    db.prepare(`INSERT INTO verify_codes (user_id, code, expires_at) VALUES (?, ?, ?)`).run(userId, code, expiresAt);

    return res.json({ ok: true, message: "Registered. Use the bot to verify. Verification code sent.", code }); // code included for dev; remove in prod
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// simple login (returns cookieless very simple token - for later we will add JWT)
app.post("/api/login", async (req, res) => {
  const { phone, password } = req.body;
  const user = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone);
  if (!user) return res.status(401).json({ error: "invalid" });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "invalid" });
  // return user id & verified flag; a real implementation would return JWT
  res.json({ ok: true, user: { id: user.id, phone: user.phone, verified: !!user.verified } });
});

// BOT calls this to finish verification
app.post("/api/verify", (req, res) => {
  // Bot must include header x-api-key: API_KEY
  if (req.headers["x-api-key"] !== API_KEY) return res.status(403).json({ error: "forbidden" });
  const { jid, code } = req.body;
  if (!jid || !code) return res.status(400).json({ error: "jid & code required" });

  // find user by phone extracted from jid
  const phone = jid.split("@")[0];
  const user = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone);
  if (!user) return res.status(404).json({ error: "user not found" });

  const verify = db.prepare(`SELECT * FROM verify_codes WHERE user_id = ? AND code = ? AND used = 0 ORDER BY created_at DESC`).get(user.id, code);
  if (!verify) return res.status(400).json({ error: "invalid code" });
  if (new Date(verify.expires_at) < new Date()) return res.status(400).json({ error: "expired" });

  db.prepare(`UPDATE users SET verified = 1 WHERE id = ?`).run(user.id);
  db.prepare(`UPDATE verify_codes SET used = 1 WHERE id = ?`).run(verify.id);

  // ensure coins row exists
  db.prepare(`INSERT OR IGNORE INTO coins (user_id, balance) VALUES (?, 0)`).run(user.id);

  return res.json({ ok: true, message: "verified" });
});

// Bot can award coins (server-side API) - protected via API key
app.post("/api/award", (req, res) => {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(403).json({ error: "forbidden" });
  const { jid, amount, reason } = req.body;
  if (!jid || typeof amount !== "number") return res.status(400).json({ error: "jid & amount required" });

  const phone = jid.split("@")[0];
  const user = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone);
  if (!user) return res.status(404).json({ error: "user not found" });

  db.prepare(`INSERT OR IGNORE INTO coins (user_id, balance) VALUES (?, 0)`).run(user.id);
  db.prepare(`UPDATE coins SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).run(amount, user.id);
  db.prepare(`INSERT INTO transactions (user_id, type, amount, meta) VALUES (?, ?, ?, ?)`).run(user.id, "earn", amount, JSON.stringify({ reason }));

  return res.json({ ok: true, message: "awarded" });
});

app.get("/api/balance/:phone", (req, res) => {
  const phone = req.params.phone;
  const user = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone);
  if (!user) return res.status(404).json({ error: "user not found" });
  const coins = db.prepare(`SELECT * FROM coins WHERE user_id = ?`).get(user.id) || { balance: 0 };
  res.json({ ok: true, balance: coins.balance });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
