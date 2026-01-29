import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

import qrcode from "qrcode-terminal";
import fs from "fs";
import axios from "axios";


// ================= IMAGE SEARCH ENGINE =================

const IMG_CACHE = new Map();

function sleep(ms) {
	return new Promise(res => setTimeout(res, ms));
}

function pickRandom(arr, n = 5) {
	return arr.sort(() => 0.5 - Math.random()).slice(0, n);
}

// ---------- Pinterest JSON search ----------
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

	const images = results
		.map(p => p?.images?.orig?.url)
		.filter(Boolean);

	return images;
}

// ---------- DuckDuckGo JSON fallback ----------
async function searchDuckDuckGo(query) {
	const vqdRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`);
	const vqdText = await vqdRes.text();

	const vqdMatch = vqdText.match(/vqd='(.*?)'/);
	if (!vqdMatch) throw new Error("DDG vqd fail");

	const vqd = vqdMatch[1];

	const api = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,&p=1`;

	const res = await fetch(api, {
		headers: {
			"user-agent": "Mozilla/5.0"
		}
	});

	if (!res.ok) throw new Error("DDG blocked");

	const json = await res.json();

	return json.results.map(r => r.image).filter(Boolean);
}

// ---------- Main search ----------
async function imageSearch(query, limit = 5) {
	const key = query.toLowerCase();

	// Cache
	if (IMG_CACHE.has(key)) {
		return pickRandom(IMG_CACHE.get(key), limit);
	}

	let images = [];

	try {
		console.log("Trying Pinterest...");
		images = await searchPinterest(query);
	} catch (e) {
		console.log("Pinterest failed, trying DDG...");
	}

	if (images.length < 3) {
		try {
			const ddg = await searchDuckDuckGo(query);
			images = images.concat(ddg);
		} catch (e) {
			console.log("DDG also failed");
		}
	}

	images = [...new Set(images)];

	if (images.length === 0) throw new Error("No images found");

	IMG_CACHE.set(key, images);

	return pickRandom(images, limit);
}





const ACTIVITY_FILE = "./data/activity.json";

// ensure data folder exists
if (!fs.existsSync("./data")) {
    fs.mkdirSync("./data");
}

// load or init db
let activityDB = {};
if (fs.existsSync(ACTIVITY_FILE)) {
    activityDB = JSON.parse(fs.readFileSync(ACTIVITY_FILE));
}

function saveActivity() {
    fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(activityDB, null, 2));
}

function getToday() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

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

        if (qr) {
            console.log("📸 Scan this QR with WhatsApp:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
            console.log("✅ Bot connected successfully!");
        }

        if (connection === "close") {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("❌ Connection closed. Reconnect:", shouldReconnect);
            if (shouldReconnect) startBot();
        }
    });

    // ================= WELCOME / GOODBYE HANDLER (robust) =================
sock.ev.on("group-participants.update", async (update) => {
	try {
		// debug: always log raw update so we know what shape it has
		console.log("GROUP-PARTICIPANTS.UPDATE:", JSON.stringify(update));

		const groupJid = update.id;
		const action = update.action; // e.g. "add", "remove", "promote", "invite", ...
		let participants = update.participants || [];

		// Bail early if this isn't an addition / invite
		if (!["add", "invite"].includes(action)) return;

		// Participants sometimes come as strings ("1234@s.whatsapp.net")
		// or as objects ({ id: '1234@s.whatsapp.net', ... }). Normalize:
		participants = participants.map(p => {
			if (!p) return null;
			if (typeof p === "string") return p;
			if (typeof p === "object" && p.id) return p.id;
			// fallback: stringify
			return String(p);
		}).filter(Boolean);

		// Slight delay to let WA settle group metadata (helps avoid race)
		await new Promise(r => setTimeout(r, 700));

		for (const userJidRaw of participants) {
			// Ensure full @s.whatsapp.net form
			const userJid = userJidRaw.includes("@") ? userJidRaw : `${userJidRaw}@s.whatsapp.net`;
			const username = userJid.split("@")[0];

			// Compose a more thrilling, informal welcome
			const welcomeText =
`⚔️🔥 *A NEW WARRIOR HAS ENTERED THE REALM* 🔥⚔️

Welcome @${username} 👑  
Another brave soul has joined the chaos! 🗿

Drop your favorite emoji to show your current mood 😈  
And don’t forget to introduce yourself:

📝 *Intro for the battlefield:*
• Name:
• Age:
• Favorite anime:
• Favorite character:

💥 Prepare for memes, chaos, debates, and legendary moments.
⚔️ *Welcome to the battlefield!*`;

			// Send message and mention the new warrior so WA shows the name
			await sock.sendMessage(groupJid, {
				text: welcomeText,
				mentions: [userJid]
			});
		}
	} catch (err) {
		console.error("WELCOME ERROR:", err);
	}
});



    function normalizeJid(jid) {
    if (!jid) return jid;
    return jid.split(":")[0].replace(/@.+/, "") + "@s.whatsapp.net";
    }   

    function jidToId(jid) {
    if (!jid) return null;
    return jid.split("@")[0].split(":")[0];
    }


    function getDisplayName(uid, participants) {
        // try to find participant by matching id or phoneNumber
        const p = participants.find(p =>
            jidToId(p.id) === uid || (p.phoneNumber && jidToId(p.phoneNumber) === uid)
        );

        if (!p) {
            return uid; // fallback
        }

        // priority: contact name / notify / phone number
        if (p.name) return p.name;
        if (p.notify) return p.notify;
        if (p.phoneNumber) return p.phoneNumber.split("@")[0];

        return p.id;
    }




    // 🧠 MESSAGE HANDLER
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;
        if (msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");

        // ================= ACTIVITY TRACKING =================
        if (isGroup) {
            const today = getToday();

            if (!activityDB[from]) activityDB[from] = {};
            if (!activityDB[from][today]) activityDB[from][today] = {};

            const senderRaw = msg.key.participant || msg.key.remoteJid;
            const senderId = jidToId(senderRaw);

            if (!activityDB[from][today][senderId]) {
                activityDB[from][today][senderId] = 0;
            }

            activityDB[from][today][senderId] += 1;

            saveActivity();
        }


        let sender = msg.key.participant || msg.key.remoteJid;
        sender = sender.split(":")[0] + "@s.whatsapp.net";


        const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            "";

        if (!text.startsWith(PREFIX)) return;

        const args = text.slice(1).trim().split(/\s+/);
        const command = args.shift().toLowerCase();

        console.log("⚡ Command:", command, "Args:", args);

        // ================= BASIC =================

        if (command === "ping") {
            return sock.sendMessage(from, { text: "🏓 Pong!" }, { quoted: msg });
        }

        // ================= GROUP ONLY =================

        if (["tagall", "kick", "promote", "demote", "mute", "unmute", "del"].includes(command) && !isGroup) {
            return sock.sendMessage(from, { text: "❌ This command only works in groups." }, { quoted: msg });
        }

        if (isGroup) {
            const groupMetadata = await sock.groupMetadata(from);
            const participants = groupMetadata.participants;

            // ================= ADMINS DEBUG =================

            if (command === "admins") {
                let out = "👥 *Group Participants Debug:*\n\n";

                for (let p of participants) {
                    out += `ID: ${p.id}\n`;
                    out += `  admin: ${p.admin}\n`;
                    out += `  isSelf: ${p.isSelf}\n\n`;
                }

                return sock.sendMessage(from, { text: out });
        
            }
        

            // ======= LID-SAFE ADMIN DETECTION =======

            // normalize bot phone jid (remove :device)
            const botPhoneJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";

            // find sender participant (by LID id OR phoneNumber)
            const senderRawJid = msg.key.participant || msg.key.remoteJid;
            const senderId = jidToId(senderRawJid);

            const senderParticipant = participants.find(p =>
                jidToId(p.id) === senderId || jidToId(p.phoneNumber) === senderId
            );                  

            // find bot participant by phoneNumber (THIS IS THE KEY FIX)
            const botParticipant = participants.find(p =>
                p.phoneNumber && p.phoneNumber.split(":")[0] === botPhoneJid
            );


            // check admin flags
            const isSenderAdmin = senderParticipant?.admin === "admin" || senderParticipant?.admin === "superadmin";
            const isBotAdmin = botParticipant?.admin === "admin" || botParticipant?.admin === "superadmin";
            

            // Helpful short in-chat debug if admin check fails (temporary)
            if (!isSenderAdmin) {
                // include only minimal debug to avoid giant messages
                return sock.sendMessage(from, {
                    text: `❌ You must be admin to use this.\n\nDebug:\nsenderId: ${senderId}\nmatchedAdmin: ${senderParticipant?.admin ?? 'null'}`
                }, { quoted: msg });
            }
            if (!isBotAdmin) {
                return sock.sendMessage(from, {
                    text: `❌ I must be admin to do this.\n\nDebug:\nbotId: ${botId}\nmatchedAdmin: ${botParticipant?.admin ?? 'null'}`
                }, { quoted: msg });
            }

            // ================= TAGALL =================

            if (command === "tagall") {
                let text = "📢 *Tagging everyone:*\n\n";
                let mentions = [];

                for (let p of participants) {
                    mentions.push(p.id);
                    text += `@${p.id.split("@")[0]}\n`;
                }

                return sock.sendMessage(from, { text, mentions });
            }

            // ================= ADMIN CHECK =================

            if (["kick", "promote", "demote", "mute", "unmute", "del"].includes(command)) {
                if (!isSenderAdmin) {
                    return sock.sendMessage(from, { text: "❌ You must be admin to use this." }, { quoted: msg });
                }
                if (!isBotAdmin) {
                    return sock.sendMessage(from, { text: "❌ I must be admin to do this." }, { quoted: msg });
                }
            }

            // ================= GET TARGET =================

            let target =
                msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
                msg.message.extendedTextMessage?.contextInfo?.participant;

            if (["kick", "promote", "demote", "mute", "unmute"].includes(command) && !target) {
                return sock.sendMessage(from, { text: "❌ Tag or reply to someone." }, { quoted: msg });
            }

            // ================= DELETE MSG =================

            if (command === "del") {
                const quoted = msg.message.extendedTextMessage?.contextInfo?.stanzaId;

                if (!quoted) {
                    return sock.sendMessage(from, { text: "❌ Reply to a message you want to delete." }, { quoted: msg });
                }

                const participant = msg.message.extendedTextMessage.contextInfo.participant;    
                await sock.sendMessage(from, {
                    delete: {
                        remoteJid: from,
                        fromMe: false,
                        id: quoted,
                        participant: participant
                    }
                });
                return;
            }

            // ================= MUTE =================

            if (command === "mute") {
                await sock.groupParticipantsUpdate(from, [target], "restrict");
                return sock.sendMessage(from, { text: "🔇 User has been muted (restricted)." });
            }

            // ================= UNMUTE =================

            if (command === "unmute") {
                await sock.groupParticipantsUpdate(from, [target], "unrestrict");
                return sock.sendMessage(from, { text: "🔊 User has been unmuted." });
            }


            // ================= KICK =================

            if (command === "kick") {
                await sock.groupParticipantsUpdate(from, [target], "remove");
                return sock.sendMessage(from, { text: "✅ User removed." });
            }

            // ================= PROMOTE =================

            if (command === "promote") {
                await sock.groupParticipantsUpdate(from, [target], "promote");
                return sock.sendMessage(from, { text: "✅ User promoted to admin." });
            }

            // ================= DEMOTE =================

            if (command === "demote") {
                await sock.groupParticipantsUpdate(from, [target], "demote");
                return sock.sendMessage(from, { text: "✅ User demoted." });
            }


            // ================= IMG =================

            if (command === "img") {
	if (!args.length) {
		await sock.sendMessage(from, { text: "❌ Usage: .img <query>" });
		return;
	}

	const query = args.join(" ");

	await sock.sendMessage(from, { text: `🔍 Searching images for: *${query}* ...` });

	try {
		const images = await imageSearch(query, 5);

		for (const img of images) {
			await sock.sendMessage(from, {
				image: { url: img },
				caption: `🖼️ Result for: *${query}*`
			});
			await sleep(700); // anti-spam delay
		}
	} catch (err) {
		console.error("IMG ERROR:", err);
		await sock.sendMessage(from, { text: "❌ No images found." });
	}
}







            // ----------------- .active and .inactive -----------------
if (command === "active") {
    const threshold = 5;
    const customMessage = args.join(" ").trim(); // optional message after .active

    const days = getLastNDays(7);
    const groupData = activityDB[from] || {};

    // sum activity for last N days
    let perUser = {};
    let availableDays = 0;
    for (let d of days) {
        if (!groupData[d]) continue;
        availableDays++;
        for (let uid in groupData[d]) {
            const c = groupData[d][uid];
            if (!perUser[uid]) perUser[uid] = 0;
            perUser[uid] += c;
        }
    }

    // pick active users >= threshold, sort descending and take top 10
    const activeList = Object.entries(perUser)
        .filter(([uid, count]) => count >= threshold)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    let text = `✅ *Active members (>= ${threshold} msgs in last 7 days)*\n\n`;
    text += `📅 Data available for: ${availableDays} / 7 days\n\n`;

    let mentions = [];

    if (activeList.length === 0) {
        text += "No active members found (yet).";
        // send without mentions
        return sock.sendMessage(from, { text }, { quoted: msg });
    }

    // build lines and mentions
    let i = 0;
    for (let [uid, count] of activeList) {
        i++;
        // find participant entry (match by LID id or phoneNumber id)
        const p = participants.find(p =>
            jidToId(p.id) === uid || (p.phoneNumber && jidToId(p.phoneNumber) === uid)
        );

        if (p) {
            // prefer phoneJid when available, normalized
            const raw = p.phoneNumber ? p.phoneNumber.split(":")[0] : p.id;
            const mentionJid = raw.includes("@") ? raw : `${raw}@s.whatsapp.net`;
            mentions.push(mentionJid);

            const num = mentionJid.split("@")[0].split(":")[0];
            text += `${i}. @${num} — ${count} msgs\n`;
        } else {
            text += `${i}. ${uid} — ${count} msgs\n`;
        }
    }

    if (customMessage) {
        text += `\n📣 Message:\n${customMessage}`;
    }

    return sock.sendMessage(from, { text, mentions }, { quoted: msg });
}

if (command === "inactive") {
    const threshold = 5;
    const customMessage = args.join(" ").trim(); // optional message after .inactive

    const days = getLastNDays(7);
    const groupData = activityDB[from] || {};

    // sum activity for last N days
    let perUser = {};
    let availableDays = 0;
    for (let d of days) {
        if (!groupData[d]) continue;
        availableDays++;
        for (let uid in groupData[d]) {
            const c = groupData[d][uid];
            if (!perUser[uid]) perUser[uid] = 0;
            perUser[uid] += c;
        }
    }

    // collect all participants' numeric ids (the keys used in perUser)
    const allMemberIds = participants.map(p => {
        // prefer numeric id from p.id or p.phoneNumber
        const idFromP = jidToId(p.id);
        if (idFromP) return idFromP;
        if (p.phoneNumber) return jidToId(p.phoneNumber);
        return null;
    }).filter(Boolean);

    // determine inactive members (< threshold)
    const inactive = [];
    for (let uid of allMemberIds) {
        // skip the bot itself
        if (uid === jidToId(sock.user.id)) continue;

        const count = perUser[uid] || 0;
        if (count < threshold) {
            inactive.push({ uid, count });
        }
    }

    // sort by ascending message count (least active first)
    inactive.sort((a, b) => a.count - b.count);

    let text = `⚠️ *Inactive members (< ${threshold} msgs in last 7 days)*\n\n`;
    text += `📅 Data available for: ${availableDays} / 7 days\n\n`;

    if (inactive.length === 0) {
        text += "No inactive members found.";
        return sock.sendMessage(from, { text }, { quoted: msg });
    }

    // build mentions and listing
    let mentions = [];
    let idx = 0;
    for (let entry of inactive) {
        idx++;
        const uid = entry.uid;
        const count = entry.count;

        // find participant object
        const p = participants.find(p =>
            jidToId(p.id) === uid || (p.phoneNumber && jidToId(p.phoneNumber) === uid)
        );

        if (p) {
            const raw = p.phoneNumber ? p.phoneNumber.split(":")[0] : p.id;
            const mentionJid = raw.includes("@") ? raw : `${raw}@s.whatsapp.net`;
            mentions.push(mentionJid);

            const num = mentionJid.split("@")[0].split(":")[0];
            text += `${idx}. @${num} — ${count} msgs\n`;
        } else {
            text += `${idx}. ${uid} — ${count} msgs\n`;
        }
    }

    if (customMessage) {
        text += `\n📣 Message to inactive members:\n${customMessage}`;
    }

    return sock.sendMessage(from, { text, mentions }, { quoted: msg });
}







            // ==================== ACTIVITY =================

            if (command === "activity") {
				const days = getLastNDays(7);
				const groupData = activityDB[from] || {};

				let total = 0;
				let perUser = {};
				let availableDays = 0;

				for (let d of days) {
					if (!groupData[d]) continue;
					availableDays++;

					for (let uid in groupData[d]) {
						const c = groupData[d][uid];
						total += c;
						if (!perUser[uid]) perUser[uid] = 0;
						perUser[uid] += c;
					}
				}

				const sorted = Object.entries(perUser)
					.sort((a, b) => b[1] - a[1])
					.slice(0, 5);

				let text = `📊 *Group Activity Report*\n\n`;
				text += `📅 Data available for: ${availableDays} / 7 days\n`;
				text += `💬 Total messages (last ${availableDays} days): ${total}\n\n`;
				text += `🔥 *Top Active Members:*\n\n`;

				// **ONE** mentions array (do NOT redeclare it elsewhere)
				let mentions = [];

				if (sorted.length === 0) {
					text += "No data yet.";
				} else {
					for (let [uid, count] of sorted) {
						// find participant entry (match by LID id or phoneNumber id)
						const p = participants.find(p =>
							jidToId(p.id) === uid || (p.phoneNumber && jidToId(p.phoneNumber) === uid)
						);

						if (p) {
							// Prefer real phone JID when available.
							// Normalize away any :device suffix so WhatsApp resolves it correctly.
							let raw = p.phoneNumber ? p.phoneNumber.split(":")[0] : p.id;
							// If raw doesn't contain @domain, append @s.whatsapp.net
							const mentionJid = raw.includes("@") ? raw : `${raw}@s.whatsapp.net`;

							mentions.push(mentionJid);

							const num = mentionJid.split("@")[0].split(":")[0];
							text += `• @${num} : ${count} msgs\n`;
						} else {
							// fallback if participant object not found
							text += `• ${uid} : ${count} msgs\n`;
						}
					}
				}

				// send with the single, correctly filled mentions array
				return sock.sendMessage(from, { text, mentions });
			}




        }

    });
}

startBot();
