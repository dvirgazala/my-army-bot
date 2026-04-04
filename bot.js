const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const https = require("https");
const http = require("http");

// --- משתנים ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 10000;
const URL = "https://dvir-army-bot.onrender.com"; // הכתובת שלך

// --- MongoDB ---
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
.then(() => console.log("✅ מחובר בהצלחה ל-MongoDB!"))
.catch(err => console.error("❌ שגיאת Mongo:", err.message));

// --- מודל ---
const soldierSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    unit: String,
    status: { type: String, default: "BASE" },
    lastUpdate: { type: Date, default: Date.now }
});

const Soldier = mongoose.model("Soldier", soldierSchema);

// --- יצירת בוט (ללא polling!) ---
const bot = new TelegramBot(TELEGRAM_TOKEN);

// --- הגדרת Webhook ---
bot.setWebHook(`${URL}/bot${TELEGRAM_TOKEN}`);

async function askAI(userInput, allSoldiers) {
    const prompt = `You are a military clerk. Current Soldiers Data: ${JSON.stringify(allSoldiers)}. 
Return JSON only: {"type": "update", "updates": [{"name": "Name", "status": "STATUS"}]} OR {"type": "chat", "text": "Hebrew reply"}.
User message: "${userInput}"`;

    const postData = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
    });

    const options = {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1/models/gemini-1.5-pro:generateContent?key=${GEMINI_KEY}`,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData)
        },
    };

    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            let body = "";

            res.on("data", (d) => (body += d));

            res.on("end", () => {
                try {
                    console.log("🔍 Gemini raw response:", body);

                    if (res.statusCode !== 200) {
                        resolve({ type: "chat", text: `שגיאת AI (${res.statusCode})` });
                        return;
                    }

                    const parsed = JSON.parse(body);

                    if (!parsed.candidates) {
                        resolve({ type: "chat", text: "AI לא החזיר תשובה תקינה" });
                        return;
                    }

                    const aiText = parsed.candidates?.[0]?.content?.parts?.[0]?.text;

                    if (!aiText) {
                        resolve({ type: "chat", text: "AI החזיר תשובה ריקה" });
                        return;
                    }

                    const jsonMatch = aiText.match(/\{[\s\S]*\}/);

                    resolve(
                        jsonMatch
                            ? JSON.parse(jsonMatch[0])
                            : { type: "chat", text: aiText }
                    );

                } catch (e) {
                    console.error("❌ AI parse error:", e);
                    resolve({ type: "chat", text: "שגיאה בפענוח תשובת AI" });
                }
            });
        });

        req.on("error", (err) => {
            console.error("❌ Request error:", err);
            resolve({ type: "chat", text: "תקלת תקשורת עם AI" });
        });

        req.write(postData);
        req.end();
    });
}
// --- דוח ---
async function buildStatusReport() {
    const allSoldiers = await Soldier.find({});
    let groups = { HQ_MF: [], HQ_SMF: [], HQ_MM1: [], HQ_MM2: [], HQ_MM3: [], DRIVER: [], ASSIST: [], BASE: [], HOME: [] };

    allSoldiers.forEach(s => {
        if (groups[s.status]) groups[s.status].push(s.name);
    });

    return `📍 תמונת מצב:
חפ"ק: ${groups.HQ_MF.join(", ")}
בית: ${groups.HOME.join(", ")}
בסיס: ${groups.BASE.join(", ")}`;
}

// --- טיפול בהודעות ---
bot.on("message", async (msg) => {
    if (!msg.text) return;

    const text = msg.text.trim();
    const chatId = msg.chat.id;

    if (text.includes("תמונת מצב") || text === "מי פה") {
        const report = await buildStatusReport();
        bot.sendMessage(chatId, report);
        return;
    }

    const allSoldiers = await Soldier.find({});
    const aiResult = await askAI(text, allSoldiers);

    if (aiResult.type === "update") {
        for (const upd of aiResult.updates) {
            await Soldier.findOneAndUpdate(
                { name: upd.name },
                { status: upd.status, lastUpdate: Date.now() }
            );
        }
        bot.sendMessage(chatId, "עודכן 👍");
    } else {
        bot.sendMessage(chatId, aiResult.text);
    }
});

// --- שרת webhook ---
http.createServer((req, res) => {
    if (req.method === "POST" && req.url === `/bot${TELEGRAM_TOKEN}`) {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                const update = JSON.parse(body);
                bot.processUpdate(update);
            } catch (e) {
                console.error("Webhook error:", e);
            }
            res.writeHead(200);
            res.end();
        });
    } else {
        res.writeHead(200);
        res.end("Bot alive");
    }
}).listen(PORT);

console.log("🚀 Bot running with Webhook");
