const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const https = require("https");
const http = require("http");

// --- משתני סביבה ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 10000;

// --- חיבור ל-MongoDB ---
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
    .then(() => console.log("✅ מחובר בהצלחה ל-MongoDB!"))
    .catch(err => console.error("❌ שגיאת Mongo:", err.message));

// --- מודל חייל ---
const soldierSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    unit: String,
    status: { type: String, default: "BASE" },
    lastUpdate: { type: Date, default: Date.now }
});

const Soldier = mongoose.model("Soldier", soldierSchema);

// --- יצירת בוט ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// --- פונקציית AI ---
async function askAI(userInput) {
    const allSoldiers = await Soldier.find({});
    const prompt = `You are a military clerk. Data: ${JSON.stringify(allSoldiers)}. 
Return JSON only: {"type": "update", "updates": [{"name": "Name", "status": "STATUS"}]} OR {"type": "chat", "text": "Hebrew reply"}.
Status: HOME, BASE, HQ_MM1, HQ_MM2, HQ_MM3, HQ_MF, HQ_SMF, DRIVER, ASSIST.
User: "${userInput}"`;

    const postData = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
    });

    const options = {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_KEY}`,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
        },
    };

    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            let body = "";
            res.on("data", (d) => (body += d));
            res.on("end", () => {
                try {
                    if (res.statusCode !== 200) {
                        resolve({ type: "chat", text: `שגיאה מגוגל (${res.statusCode})` });
                        return;
                    }
                    const parsed = JSON.parse(body);
                    const aiText = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                    const jsonMatch = aiText?.match(/\{[\s\S]*\}/);
                    resolve(jsonMatch ? JSON.parse(jsonMatch[0]) : { type: "chat", text: aiText });
                } catch (e) {
                    resolve({ type: "chat", text: "שגיאה בפענוח הנתונים." });
                }
            });
        });
        req.on("error", () => resolve({ type: "chat", text: "תקלת תקשורת עם AI." }));
        req.write(postData);
        req.end();
    });
}

// --- דוח תמונת מצב ---
async function buildStatusReport() {
    const allSoldiers = await Soldier.find({});
    let groups = { HQ_MF: [], HQ_SMF: [], HQ_MM1: [], HQ_MM2: [], HQ_MM3: [], DRIVER: [], ASSIST: [], BASE: [], HOME: [] };

    allSoldiers.forEach(s => {
        if (groups[s.status]) groups[s.status].push(s.name);
    });

    return `📍 *תמונת מצב פלוגתית:*
⭐ *חפ"ק:*
• מ"פ: ${groups.HQ_MF.join(", ") || "-"} | סמ"פ: ${groups.HQ_SMF.join(", ") || "-"}
• ממ1: ${groups.HQ_MM1.join(", ") || "-"} | ממ2: ${groups.HQ_MM2.join(", ") || "-"} | ממ3: ${groups.HQ_MM3.join(", ") || "-"}
🚛 *לוגיסטיקה:* ${groups.DRIVER.join(", ") || "-"} | ${groups.ASSIST.join(", ") || "-"}
🏠 *בבית:* ${groups.HOME.join(", ") || "-"}
🚌 *בבסיס:* ${groups.BASE.join(", ") || "-"}
_עודכן: ${new Date().toLocaleTimeString("he-IL")}_`;
}

// --- טיפול בהודעות ---
bot.on("message", async (msg) => {
    if (!msg.text) return;
    const text = msg.text.trim();
    const chatId = msg.chat.id;

    // דוח
    if (text.includes("תמונת מצב") || text === "מי פה") {
        const report = await buildStatusReport();
        bot.sendMessage(chatId, report, { parse_mode: "Markdown" });
        return;
    }

    // עדכון סד"כ (מחלקות)
    if (text.includes("מחלקה") && text.includes(":")) {
        const lines = text.split("\n");
        let currentUnit = null;
        for (const line of lines) {
            if (line.includes(":")) {
                currentUnit = line.split(":")[0].replace("מחלקה", "").trim();
            } else if (currentUnit && line.trim()) {
                const name = line.trim();
                await Soldier.findOneAndUpdate(
                    { name },
                    { unit: currentUnit },
                    { upsert: true, new: true }
                );
            }
        }
        bot.sendMessage(chatId, 'הסד"כ עודכן! 🫡');
        return;
    }

    // AI
    const aiResult = await askAI(text);
    if (aiResult.type === "update" && aiResult.updates) {
        for (const upd of aiResult.updates) {
            if (upd.name) {
                await Soldier.findOneAndUpdate(
                    { name: upd.name },
                    { status: upd.status, lastUpdate: Date.now() },
                    { upsert: true }
                );
            }
        }
        bot.sendMessage(chatId, `קיבלתי, עדכנתי! 👍`);
    } else {
        bot.sendMessage(chatId, aiResult.text || "רות.");
    }
});

// --- שרת HTTP לשמירה על החיים ב-Render ---
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is Alive');
}).listen(PORT);

console.log("🚀 הבוט דרוך ומוכן ב-Ohio!");
