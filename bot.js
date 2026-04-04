const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const https = require("https");
const http = require("http");

// --- משיכת מפתחות ממשתני הסביבה ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI, { 
    serverSelectionTimeoutMS: 5000 // יחכה רק 5 שניות במקום 10
})
.then(() => console.log("✅ מחובר בהצלחה ל-MongoDB!"))
.catch(err => {
    console.error("❌ שגיאת חיבור מפורטת:");
    console.error("Message:", err.message);
    console.error("Reason:", err.reason);
});

// הגדרת מבנה הנתונים של חייל במסד הנתונים
const soldierSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    unit: String,
    status: { type: String, default: "BASE" },
    lastUpdate: { type: Date, default: Date.now }
});

const Soldier = mongoose.model("Soldier", soldierSchema);

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// פונקציית AI לעיבוד הודעות
async function askAI(userInput, allSoldiers) {
    const prompt = `You are a military clerk. Current Soldiers Data: ${JSON.stringify(allSoldiers)}. 
    Return JSON only: {"type": "update", "updates": [{"name": "Name", "status": "STATUS"}]} OR {"type": "chat", "text": "Hebrew reply"}.
    Status options: HOME, BASE, HQ_MM1, HQ_MM2, HQ_MM3, HQ_MF, HQ_SMF, DRIVER, ASSIST.
    User message: "${userInput}"`;

    const postData = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
    });

    const options = {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
        },
    };

    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            let body = "";
            res.on("data", (d) => (body += d));
            res.on("end", () => {
                try {
                    if (res.statusCode !== 200) {
                        resolve({ type: "chat", text: `שגיאת AI (${res.statusCode}).` });
                        return;
                    }
                    const parsed = JSON.parse(body);
                    const aiText = parsed.candidates[0].content.parts[0].text;
                    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
                    resolve(jsonMatch ? JSON.parse(jsonMatch[0]) : { type: "chat", text: aiText });
                } catch (e) {
                    resolve({ type: "chat", text: "שגיאה בפענוח תשובת ה-AI." });
                }
            });
        });
        req.on("error", () => resolve({ type: "chat", text: "תקלת תקשורת מול גוגל." }));
        req.write(postData);
        req.end();
    });
}

// בניית דוח תמונת מצב מתוך מסד הנתונים
async function buildStatusReport() {
    const allSoldiers = await Soldier.find({});
    let groups = { HQ_MF: [], HQ_SMF: [], HQ_MM1: [], HQ_MM2: [], HQ_MM3: [], DRIVER: [], ASSIST: [], BASE: [], HOME: [] };
    
    allSoldiers.forEach(s => {
        if (groups[s.status]) groups[s.status].push(s.name);
    });

    return `📍 *תמונת מצב פלוגתית (מענן):*
⭐ *חפ"ק:*
• מ"פ: ${groups.HQ_MF.join(", ") || "-"} | סמ"פ: ${groups.HQ_SMF.join(", ") || "-"}
• ממ1: ${groups.HQ_MM1.join(", ") || "-"} | ממ2: ${groups.HQ_MM2.join(", ") || "-"} | ממ3: ${groups.HQ_MM3.join(", ") || "-"}
🚛 *לוגיסטיקה:* ${groups.DRIVER.join(", ") || "-"} | ${groups.ASSIST.join(", ") || "-"}
🏠 *בבית:* ${groups.HOME.join(", ") || "-"}
🚌 *בבסיס:* ${groups.BASE.join(", ") || "-"}
_עודכן: ${new Date().toLocaleTimeString("he-IL")}_`;
}

// טיפול בהודעות נכנסות
bot.on("message", async (msg) => {
    if (!msg.text) return;
    const text = msg.text.trim();
    const chatId = msg.chat.id;

    // פקודת דוח
    if (text.includes("תמונת מצב") || text === "מי פה") {
        const report = await buildStatusReport();
        bot.sendMessage(chatId, report, { parse_mode: "Markdown" });
        return;
    }

    // עדכון סד"כ ראשוני (הוספת חיילים)
    if (text.includes("מחלקה") && text.includes(":")) {
        const lines = text.split("\n");
        let currentUnit = null;
        for (const line of lines) {
            if (line.includes(":")) {
                currentUnit = line.split(":")[0].replace("מחלקה", "").trim();
            } else if (currentUnit && line.trim()) {
                const name = line.trim();
                // עדכון או יצירה של חייל במונגו
                await Soldier.findOneAndUpdate(
                    { name: name },
                    { unit: currentUnit },
                    { upsert: true, new: true }
                );
            }
        }
        bot.sendMessage(chatId, 'הסד"כ עודכן בבסיס הנתונים! 🫡');
        return;
    }

    // שימוש ב-AI לעדכון סטטוסים או שיחה
    const allSoldiers = await Soldier.find({});
    const aiResult = await askAI(text, allSoldiers);

    if (aiResult.type === "update" && aiResult.updates) {
        for (const upd of aiResult.updates) {
            if (upd.name) {
                await Soldier.findOneAndUpdate(
                    { name: upd.name },
                    { status: upd.status, lastUpdate: Date.now() }
                );
            }
        }
        bot.sendMessage(chatId, `קיבלתי, הסטטוסים עודכנו בענן! 👍`);
    } else {
        bot.sendMessage(chatId, aiResult.text || "רות.");
    }
});

// שרת לשמירה על הבוט בחיים ב-Render
const port = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is Alive and Persistent');
}).listen(port);

console.log("הבוט דרוך ב-Ohio ומחובר לענן MongoDB!");
