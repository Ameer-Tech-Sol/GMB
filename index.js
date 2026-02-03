import 'dotenv/config'
import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

import qrcode from "qrcode-terminal";
import fs from "fs";
import axios from "axios";
import { addCoins, getBalance } from "./db.js";

// ================= IMAGE SEARCH ENGINE =================
const IMG_CACHE = new Map();

function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
}

function pickRandom(arr, n = 5) {
    return arr.sort(() => 0.5 - Math.random()).slice(0, n);
}

async function searchPinterest(query) {
    const url = `https://www.pinterest.com/resource/BaseSearchResource/get/?source_url=/search/pins/?q=${encodeURIComponent(query)}&data=${encodeURIComponent(JSON.stringify({
        options: {
            query: query,
            scope: "pins",
            no_fetch_context_on_resource: false
        },
        context: {}
    }))}`;

    const res = await fetch(url, {
        headers: {
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "accept": "application/json"
        }
    });

    if (!res.ok) throw new Error("Pinterest blocked");
    const json = await res.json();
    const results = json?.resource_response?.data?.results || [];
    const images = results.map(p => p?.images?.orig?.url).filter(Boolean);
    return images;
}

async function searchDuckDuckGo(query) {
    const vqdRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`);
    const vqdText = await vqdRes.text();
    const vqdMatch = vqdText.match(/vqd='(.*?)'/);
    if (!vqdMatch) throw new Error("DDG vqd fail");
    const vqd = vqdMatch[1];
    const api = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,&p=1`;
    const res = await fetch(api, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error("DDG blocked");
    const json = await res.json();
    return json.results.map(r => r.image).filter(Boolean);
}

async function imageSearch(query, limit = 5) {
    const key = query.toLowerCase();
    if (IMG_CACHE.has(key)) return pickRandom(IMG_CACHE.get(key), limit);
    let images = [];
    try {
        images = await searchPinterest(query);
    } catch (e) { console.log("Pinterest failed, trying DDG..."); }
    if (images.length < 3) {
        try {
            const ddg = await searchDuckDuckGo(query);
            images = images.concat(ddg);
        } catch (e) { console.log("DDG also failed"); }
    }
    images = [...new Set(images)];
    if (images.length === 0) throw new Error("No images found");
    IMG_CACHE.set(key, images);
    return pickRandom(images, limit);
}

// ================= ACTIVITY SYSTEM =================
const ACTIVITY_FILE = "./data/activity.json";
if (!fs.existsSync("./data")) fs.mkdirSync("./data");
let activityDB = {};
if (fs.existsSync(ACTIVITY_FILE)) {
    activityDB = JSON.parse(fs.readFileSync(ACTIVITY_FILE));
}
function saveActivity() {
    fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(activityDB, null, 2));
}

// ================= STD GAME HELPERS =================
const activeStdGames = new Map();      
const lastStdCompleted = new Map();    
const STD_COOLDOWN_MS = 2 * 60 * 1000; 
const STD_TIMEOUT_MS = 2 * 60 * 1000;  

const EMOJI_POOL = [
  "🍥","🔥","🥊","⚡","🐉","💧","✨","🌙","🍀","💥",
  "🌸","🌊","🪄","🔮","🍣","🍕","🍩","🍪","🌟","⚔️",
  "🛡️","🐱","🐶","🐼","🐵","🐲","🌈","🌪️","☀️","🌙"
];

function shuffleArray(arr) {
  return arr.slice().sort(() => 0.5 - Math.random());
}

// Logic to start the game and set the timer
function startStdGame(phone, destJid, sockInstance) {
  if (activeStdGames.has(phone)) throw new Error("ALREADY_ACTIVE");
  const base = shuffleArray(EMOJI_POOL).slice(0, 5);
  const idx = Math.floor(Math.random() * base.length);
  const otherChoices = EMOJI_POOL.filter(e => !base.includes(e));
  const diff = otherChoices[Math.floor(Math.random() * otherChoices.length)];
  const alt = base.slice();
  alt[idx] = diff;

  const A = `A: ${base.join("")}`;
  const B = `B: ${alt.join("")}`;

  const ts = Date.now();
  const timeoutId = setTimeout(async () => {
    if (!activeStdGames.has(phone)) return;
    activeStdGames.delete(phone);
    try {
      await sockInstance.sendMessage(destJid, { text: `⏰ Time's up! You didn't answer in time. Start a new game with .std` });
    } catch (e) {}
  }, STD_TIMEOUT_MS);

  activeStdGames.set(phone, { correct: diff, ts, timeoutId, fromJid: destJid });
  return { A, B };
}

function getToday() { return new Date().toISOString().slice(0, 10); }
function getLastNDays(n) {
    const days = [];
    for (let i = 0; i < n; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        days.push(d.toISOString().slice(0, 10));
    }
    return days;
}

const PREFIX = ".";

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./session");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        browser: ["GMB Bot", "Chrome", "1.0"],
        markOnlineOnConnect: false,
        syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === "open") console.log("✅ Bot connected successfully!");
        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });

    // ================= WELCOME HANDLER =================
    sock.ev.on("group-participants.update", async (update) => {
        try {
            const groupJid = update.id;
            const action = update.action;
            if (!["add", "invite"].includes(action)) return;

            let participants = (update.participants || []).map(p => typeof p === "string" ? p : p.id).filter(Boolean);
            await new Promise(r => setTimeout(r, 700));

            for (const userJidRaw of participants) {
                const userJid = userJidRaw.includes("@") ? userJidRaw : `${userJidRaw}@s.whatsapp.net`;
                const username = userJid.split("@")[0];
                const welcomeText = `⚔️🔥 *A NEW WARRIOR HAS ENTERED THE REALM* 🔥⚔️\n\n💥 *@${username} has entered the CHAOS!* 💥\n\n📝 Name:\n🎂 Age:\n🍥 Anime:\n👑 Character:\n\n⚔️ _Choose your side wisely..._ 😏🔥`;
                await sock.sendMessage(groupJid, { text: welcomeText, mentions: [userJid] });
            }
        } catch (err) { console.error("WELCOME ERROR:", err); }
    });

    function jidToId(jid) {
        if (!jid) return null;
        return jid.split("@")[0].split(":")[0];
    }

    // ================= MESSAGE HANDLER =================
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");

        // --- 🛡️ 1. GLOBAL IDENTITY SCANNER (LID to Phone Conversion) ---
        let whoRaw = msg.key.participant || msg.key.remoteJid;
        let senderNum = whoRaw.split('@')[0].split(':')[0]; // Default ID

        if (isGroup) {
            try {
                // Fetch group info once per message flow to ensure we have the real phone number
                const groupMetadata = await sock.groupMetadata(from);
                const participant = groupMetadata.participants.find(p => p.id === whoRaw);
                if (participant && participant.phoneNumber) {
                    senderNum = participant.phoneNumber.split('@')[0].split(':')[0];
                }
            } catch (e) {}
        }

        // --- 📊 2. ACTIVITY TRACKING (Using the converted Phone Number) ---
        if (isGroup) {
            const today = getToday();
            if (!activityDB[from]) activityDB[from] = {};
            if (!activityDB[from][today]) activityDB[from][today] = {};

            if (!activityDB[from][today][senderNum]) {
                activityDB[from][today][senderNum] = 0;
            }
            activityDB[from][today][senderNum] += 1;
            saveActivity();
        }

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        // --- 🔎 3. STD GAME REPLY CHECK ---
        if (activeStdGames.has(senderNum)) {
            const game = activeStdGames.get(senderNum);
            const reply = text.trim();
            if (reply) {
                const answeredCorrect = reply.includes(game.correct);
                clearTimeout(game.timeoutId);
                activeStdGames.delete(senderNum);

                if (answeredCorrect) {
                    const secondsTaken = Math.floor((Date.now() - game.ts) / 1000);
                    const coins = Math.max(1, 60 - secondsTaken);
                    try {
                        const newBalance = await addCoins(senderNum, coins);
                        lastStdCompleted.set(senderNum, Date.now());
                        await sock.sendMessage(from, {
                            text: `✅ *Correct!* You spotted it!\n⏱️ Time: ${secondsTaken}s\n💰 Reward: §${coins} Sigils\n🔥 New balance: §${newBalance}`
                        }, { quoted: msg });
                    } catch (err) {
                        const errMsg = /not registered/i.test(err.message) ? "❌ You are not registered. Visit the website first." : `❌ ${err.message}`;
                        await sock.sendMessage(from, { text: errMsg }, { quoted: msg });
                    }
                } else {
                    lastStdCompleted.set(senderNum, Date.now());
                    await sock.sendMessage(from, { text: `❌ *Wrong!* The correct emoji was: ${game.correct}\nTry again in 2 minutes.` }, { quoted: msg });
                }
                return; // Stop here, don't process as command
            }
        }

        if (!text.startsWith(PREFIX)) return;

        const args = text.slice(1).trim().split(/\s+/);
        const command = args.shift().toLowerCase();

        // ================= COMMANDS =================
        if (command === "ping") {
            return sock.sendMessage(from, { text: "🏓 Pong!" }, { quoted: msg });
        }

        if (isGroup) {
            const groupMetadata = await sock.groupMetadata(from);
            const participants = groupMetadata.participants;

            // Admin detection logic
            const senderParticipant = participants.find(p => jidToId(p.id) === jidToId(whoRaw) || jidToId(p.phoneNumber) === jidToId(whoRaw));
            const isSenderAdmin = senderParticipant?.admin === "admin" || senderParticipant?.admin === "superadmin";

            // .active / .activity / .inactive commands
            if (command === "active") {
                const threshold = 5;
                const days = getLastNDays(7);
                const groupData = activityDB[from] || {};
                let perUser = {};
                for (let d of days) {
                    if (!groupData[d]) continue;
                    for (let uid in groupData[d]) {
                        if (!perUser[uid]) perUser[uid] = 0;
                        perUser[uid] += groupData[d][uid];
                    }
                }

                const activeList = Object.entries(perUser).filter(([uid, count]) => count >= threshold).sort((a, b) => b[1] - a[1]).slice(0, 10);
                let outText = `✅ *Active members (>= ${threshold} msgs)*\n\n`;
                let mentions = [];
                activeList.forEach(([uid, count], i) => {
                    const p = participants.find(p => jidToId(p.id) === uid || (p.phoneNumber && jidToId(p.phoneNumber) === uid));
                    const mentionJid = p ? (p.phoneNumber ? p.phoneNumber.split(":")[0] + "@s.whatsapp.net" : p.id) : `${uid}@s.whatsapp.net`;
                    mentions.push(mentionJid);
                    outText += `${i+1}. @${mentionJid.split("@")[0]} — ${count} msgs\n`;
                });
                return sock.sendMessage(from, { text: outText, mentions }, { quoted: msg });
            }

            if (command === "activity") {
                const days = getLastNDays(7);
                const groupData = activityDB[from] || {};
                let total = 0, perUser = {};
                days.forEach(d => {
                    if (groupData[d]) {
                        Object.entries(groupData[d]).forEach(([uid, count]) => {
                            total += count;
                            perUser[uid] = (perUser[uid] || 0) + count;
                        });
                    }
                });
                const sorted = Object.entries(perUser).sort((a, b) => b[1] - a[1]).slice(0, 5);
                let outText = `📊 *Group Activity Report*\n💬 Total: ${total}\n\n🔥 *Top Members:*\n`;
                let mentions = [];
                sorted.forEach(([uid, count]) => {
                    const p = participants.find(p => jidToId(p.id) === uid || (p.phoneNumber && jidToId(p.phoneNumber) === uid));
                    const mentionJid = p ? (p.phoneNumber ? p.phoneNumber.split(":")[0] + "@s.whatsapp.net" : p.id) : `${uid}@s.whatsapp.net`;
                    mentions.push(mentionJid);
                    outText += `• @${mentionJid.split("@")[0]} : ${count}\n`;
                });
                return sock.sendMessage(from, { text: outText, mentions });
            }

            // --- 🔎 STD COMMAND (.std) ---
            if (command === "std") {
                try {
                    await getBalance(senderNum); 
                    const last = lastStdCompleted.get(senderNum) || 0;
                    if (Date.now() - last < STD_COOLDOWN_MS) {
                        return sock.sendMessage(from, { text: `⏳ Cooldown active. Try again in ${Math.ceil((STD_COOLDOWN_MS - (Date.now() - last)) / 1000)}s.` }, { quoted: msg });
                    }
                    const { A, B } = startStdGame(senderNum, from, sock);
                    await sock.sendMessage(from, { text: `🔎 *Spot the Difference*\nReply with the *odd* emoji!\n\n${A}\n${B}` }, { quoted: msg });
                } catch (err) {
                    const msgText = /not registered/i.test(err.message) ? "❌ Register first to play." : `❌ ${err.message}`;
                    await sock.sendMessage(from, { text: msgText }, { quoted: msg });
                }
            }

            // --- 💰 GIVE COMMAND (.give) ---
            if (command === "give") {
                try {
                    const amount = Number(args[0]) || 0;
                    if (amount <= 0) return sock.sendMessage(from, { text: "❌ Invalid amount" });
                    const newBalance = await addCoins(senderNum, amount);
                    await sock.sendMessage(from, { text: `💰 Success!\n🔥 New Balance: §${newBalance}` });
                } catch (err) { await sock.sendMessage(from, { text: `❌ ${err.message}` }); }
            }

            // .img search
            if (command === "img") {
                if (!args.length) return sock.sendMessage(from, { text: "❌ Usage: .img <query>" });
                const query = args.join(" ");
                await sock.sendMessage(from, { text: `🔍 Searching for: *${query}*` });
                try {
                    const images = await imageSearch(query, 5);
                    for (const img of images) {
                        await sock.sendMessage(from, { image: { url: img }, caption: `🖼️ *${query}*` });
                        await sleep(700);
                    }
                } catch (err) { await sock.sendMessage(from, { text: "❌ No images found." }); }
            }
        }
    });
}

startBot();