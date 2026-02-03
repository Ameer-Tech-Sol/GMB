import 'dotenv/config'
import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

import qrcode from "qrcode-terminal";
import fs from "fs";
import { addCoins, getBalance } from "./db.js";

// ================= HELPERS & CACHE =================
const METADATA_CACHE = new Map();
const CACHE_TIMEOUT = 2 * 60 * 1000; // 2 Minutes

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function cleanJid(jid) {
    if (!jid) return null;
    // Removes device suffixes like :5 or :12 that break Desktop/Commands
    return jid.split('@')[0].split(':')[0] + "@s.whatsapp.net";
}

function jidToId(jid) {
    if (!jid) return null;
    return jid.split("@")[0].split(":")[0];
}

// ================= IMAGE SEARCH ENGINE =================
const IMG_CACHE = new Map();

async function searchPinterest(query) {
    const url = `https://www.pinterest.com/resource/BaseSearchResource/get/?source_url=/search/pins/?q=${encodeURIComponent(query)}&data=${encodeURIComponent(JSON.stringify({
        options: { query, scope: "pins", no_fetch_context_on_resource: false },
        context: {}
    }))}`;
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", "accept": "application/json" } });
    if (!res.ok) throw new Error("Blocked");
    const json = await res.json();
    return (json?.resource_response?.data?.results || []).map(p => p?.images?.orig?.url).filter(Boolean);
}

// ================= ACTIVITY SYSTEM =================
const ACTIVITY_FILE = "./data/activity.json";
if (!fs.existsSync("./data")) fs.mkdirSync("./data");
let activityDB = fs.existsSync(ACTIVITY_FILE) ? JSON.parse(fs.readFileSync(ACTIVITY_FILE)) : {};

function saveActivity() {
    fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(activityDB, null, 2));
}

// ================= STD GAME HELPERS =================
const activeStdGames = new Map();      
const lastStdCompleted = new Map();    
const EMOJI_POOL = ["🍥","🔥","🥊","⚡","🐉","💧","✨","🌙","🍀","💥","🌸","🌊","🌟","⚔️","🛡️"];

// ================= MAIN BOT =================
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
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
        }
    });

    sock.ev.on("group-participants.update", async (update) => {
        if (update.action !== "add") return;
        for (const user of update.participants) {
            const welcome = `⚔️🔥 *A NEW WARRIOR HAS ENTERED* 🔥⚔️\n\n💥 @${user.split("@")[0]} has entered the CHAOS! 💥\n\n📝 Name:\n🎂 Age:\n🍥 Anime:\n👑 Character:`;
            await sock.sendMessage(update.id, { text: welcome, mentions: [user] });
        }
    });

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const pushName = msg.pushName || "Warrior";
        
        // --- IDENTITY RESOLVER ---
        let whoRaw = msg.key.participant || from;
        let senderNum = jidToId(whoRaw);

        if (isGroup) {
            // Activity tracking
            const today = new Date().toISOString().slice(0, 10);
            if (!activityDB[from]) activityDB[from] = {};
            if (!activityDB[from][today]) activityDB[from][today] = {};
            
            // Record message with PushName
            if (!activityDB[from][today][senderNum]) {
                activityDB[from][today][senderNum] = { count: 0, name: pushName };
            }
            activityDB[from][today][senderNum].count += 1;
            activityDB[from][today][senderNum].name = pushName;
            saveActivity();
        }

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        // --- GAME CHECK ---
        if (activeStdGames.has(senderNum)) {
            const game = activeStdGames.get(senderNum);
            if (text.trim().includes(game.correct)) {
                activeStdGames.delete(senderNum);
                const bal = await addCoins(senderNum, 50);
                return sock.sendMessage(from, { text: `✅ Correct! +§50. Balance: §${bal}` }, { quoted: msg });
            }
        }

        if (!text.startsWith(".")) return;
        const args = text.slice(1).trim().split(/\s+/);
        const command = args.shift().toLowerCase();

        // ================= COMMAND LOGIC =================
        if (command === "ping") return sock.sendMessage(from, { text: "🏓 Pong!" });

        if (isGroup) {
            // Fetch metadata with cache to avoid crashes
            let groupMetadata = METADATA_CACHE.get(from);
            if (!groupMetadata || (Date.now() - groupMetadata.time > CACHE_TIMEOUT)) {
                groupMetadata = { data: await sock.groupMetadata(from), time: Date.now() };
                METADATA_CACHE.set(from, groupMetadata);
            }
            const participants = groupMetadata.data.participants;

            // Admin Checks
            const senderObj = participants.find(p => jidToId(p.id) === senderNum);
            const isAdmin = senderObj?.admin === "admin" || senderObj?.admin === "superadmin";
            const botId = jidToId(sock.user.id);
            const botObj = participants.find(p => jidToId(p.id) === botId);
            const isBotAdmin = botObj?.admin === "admin" || botObj?.admin === "superadmin";

            // 1. .activity / .active
            if (command === "active" || command === "activity") {
                const today = new Date().toISOString().slice(0, 10);
                const data = activityDB[from]?.[today] || {};
                const sorted = Object.entries(data).sort((a,b) => b[1].count - a[1].count).slice(0, 15);

                let out = `📊 *Top Warriors Today*\n\n`;
                let mentions = [];
                sorted.forEach(([id, info], i) => {
                    const fullJid = cleanJid(id + "@s.whatsapp.net");
                    mentions.push(fullJid);
                    out += `${i+1}. ${info.name} (@${id}) — ${info.count} msgs\n`;
                });
                return sock.sendMessage(from, { text: out, mentions }, { quoted: msg });
            }

            // 2. .inactive
            if (command === "inactive") {
                const today = new Date().toISOString().slice(0, 10);
                const activeIds = Object.keys(activityDB[from]?.[today] || {});
                const inactive = participants.filter(p => !activeIds.includes(jidToId(p.id)));

                let out = `💤 *Inactive Members (Today)*\n\n`;
                let mentions = [];
                inactive.slice(0, 20).forEach(p => {
                    const cJid = cleanJid(p.id);
                    mentions.push(cJid);
                    out += `• @${jidToId(cJid)}\n`;
                });
                return sock.sendMessage(from, { text: out, mentions });
            }

            // 3. .kick (Admin Only)
            if (command === "kick") {
                if (!isAdmin) return sock.sendMessage(from, { text: "❌ Admins only." });
                if (!isBotAdmin) return sock.sendMessage(from, { text: "❌ Bot is not Admin." });

                let target = msg.message.extendedTextMessage?.contextInfo?.participant || (args[0] ? args[0].replace("@", "") + "@s.whatsapp.net" : null);
                target = cleanJid(target);

                if (!target || target.length < 10) return sock.sendMessage(from, { text: "❌ Tag or reply to someone to kick." });
                
                try {
                    await sock.groupParticipantsUpdate(from, [target], "remove");
                    return sock.sendMessage(from, { text: "👢 Target has been eliminated." });
                } catch (e) {
                    return sock.sendMessage(from, { text: "❌ Failed to kick. They might be an admin or already gone." });
                }
            }

            // 4. .del (Upgraded)
            if (command === "del") {
                if (!isAdmin) return;
                const targetMsg = {
                    remoteJid: from,
                    fromMe: false,
                    id: msg.message.extendedTextMessage?.contextInfo?.stanzaId,
                    participant: msg.message.extendedTextMessage?.contextInfo?.participant
                };
                if (targetMsg.id) {
                    await sock.sendMessage(from, { delete: targetMsg }); // Delete target
                    await sleep(300);
                    await sock.sendMessage(from, { delete: msg.key });   // Delete command message
                }
            }

            // 5. .promote / .demote
            if (command === "promote" || command === "demote") {
                if (!isAdmin) return;
                let target = msg.message.extendedTextMessage?.contextInfo?.participant || (args[0] ? args[0].replace("@", "") + "@s.whatsapp.net" : null);
                target = cleanJid(target);
                if (target) {
                    await sock.groupParticipantsUpdate(from, [target], command);
                    await sock.sendMessage(from, { text: `✅ User ${command}d successfully.` });
                }
            }

            // 6. .tagall
            if (command === "tagall" || command === "hidetag") {
                if (!isAdmin) return;
                const mentions = participants.map(p => cleanJid(p.id));
                const note = args.join(" ") || "Wake up warriors!";
                let out = `📢 *Attention*\n\n${note}\n\n` + mentions.map(m => `@${jidToId(m)}`).join(" ");
                return sock.sendMessage(from, { text: out, mentions });
            }

            // 7. .std (Game)
            if (command === "std") {
                const base = EMOJI_POOL.sort(() => 0.5 - Math.random()).slice(0, 5);
                const diff = "🍕"; 
                const alt = [...base]; alt[2] = diff;
                activeStdGames.set(senderNum, { correct: diff });
                return sock.sendMessage(from, { text: `🔎 *Find the difference!*\n\n${base.join("")}\n${alt.join("")}` });
            }

            // 8. .give
            if (command === "give") {
                const amount = parseInt(args[0]) || 0;
                if (amount <= 0) return;
                const bal = await addCoins(senderNum, amount);
                return sock.sendMessage(from, { text: `💰 Granted! New balance: §${bal}` });
            }
        }
    });
}

startBot();