const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const https = require("https");
const http = require("http");

// --- משיכת מפתחות ממשתני הסביבה (אבטחה) ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const DB_FILE = "database.json";
const COMPANY_FILE = "company.json";

let soldiersStatus = {};
let companyData = [];

// טעינת נתונים
if (fs.existsSync(DB_FILE)) {
    try { soldiersStatus = JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) {}
}
if (fs.existsSync(COMPANY_FILE)) {
    try { companyData = JSON.parse(fs.readFileSync(COMPANY_FILE)); } catch (e) {}
}

function saveAll() {
    fs.writeFileSync(DB_FILE, JSON.stringify(soldiersStatus, null, 2));
    fs.writeFileSync(COMPANY_FILE, JSON.stringify(companyData, null, 2));
}

async function askAI(userInput) {
    const prompt = `You are a military clerk. Data: ${JSON.stringify(companyData)}. 
    Return JSON only: {"type": "update", "updates": [{"name": "Name", "status": "STATUS"}]} OR {"type": "chat", "text": "Hebrew reply"}.
    Status: HOME, BASE, HQ_MM1, HQ_MM2, HQ_MM3, HQ_MF, HQ_SMF, DRIVER, ASSIST.
    User: "${userInput}"`;

    const postData = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
    });

    const options = {
        hostname: "generativelanguage.googleapis.com",
        // זו הכתובת שעובדת ב-100% עבור מודל ה-Flash המהיר:
        path: `/v1/models/gemini-flash-latest:generateContent?key=${GEMINI_KEY}`,
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
                        console.error("Google Error:", body);
                        // אם זה עדיין נכשל, נסה להחזיר את השגיאה המקורית כדי שנבין מה קורה
                        resolve({ type: "chat", text: `שגיאה מגוגל (${res.statusCode}). ודא שהמפתח ב-Environment תקין.` });
                        return;
                    }
                    const parsed = JSON.parse(body);
                    if (!parsed.candidates || !parsed.candidates[0]) {
                         resolve({ type: "chat", text: "גוגל החזיר תשובה ריקה. נסה שוב." });
                         return;
                    }
                    const aiText = parsed.candidates[0].content.parts[0].text;
                    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
                    resolve(jsonMatch ? JSON.parse(jsonMatch[0]) : { type: "chat", text: aiText });
                } catch (e) {
                    resolve({ type: "chat", text: "שגיאה בפענוח הנתונים." });
                }
            });
        });
        req.on("error", () => resolve({ type: "chat", text: "תקלת תקשורת." }));
        req.write(postData);
        req.end();
    });
}

// פונקציית דוח תמונת מצב
function buildStatusReport() {
    let groups = { HQ_MF: [], HQ_SMF: [], HQ_MM1: [], HQ_MM2: [], HQ_MM3: [], DRIVER: [], ASSIST: [], BASE: [], HOME: [] };
    for (let name in soldiersStatus) {
        if (groups[soldiersStatus[name]]) groups[soldiersStatus[name]].push(name);
    }
    return `📍 *תמונת מצב פלוגתית:*
⭐ *חפ"ק:*
• מ"פ: ${groups.HQ_MF.join(", ") || "-"} | סמ"פ: ${groups.HQ_SMF.join(", ") || "-"}
• ממ1: ${groups.HQ_MM1.join(", ") || "-"} | ממ2: ${groups.HQ_MM2.join(", ") || "-"} | ממ3: ${groups.HQ_MM3.join(", ") || "-"}
🚛 *לוגיסטיקה:* ${groups.DRIVER.join(", ") || "-"} | ${groups.ASSIST.join(", ") || "-"}
🏠 *בבית:* ${groups.HOME.join(", ") || "-"}
🚌 *בבסיס:* ${groups.BASE.join(", ") || "-"}
_עודכן: ${new Date().toLocaleTimeString("he-IL")}_`;
}

bot.on("message", async (msg) => {
    if (!msg.text) return;
    const text = msg.text.trim();
    const chatId = msg.chat.id;

    if (text.includes("תמונת מצב") || text === "מי פה") {
        bot.sendMessage(chatId, buildStatusReport(), { parse_mode: "Markdown" });
        return;
    }

    if (text.includes("מחלקה") && text.includes(":")) {
        const lines = text.split("\n");
        let currentUnit = null;
        lines.forEach((line) => {
            if (line.includes(":")) currentUnit = line.split(":")[0].replace("מחלקה", "").trim();
            else if (currentUnit && line.trim()) {
                const name = line.trim();
                companyData = companyData.filter((s) => s.name !== name);
                companyData.push({ name, unit: currentUnit });
            }
        });
        saveAll();
        bot.sendMessage(chatId, 'הסד"כ עודכן! 🫡');
        return;
    }

    const aiResult = await askAI(text);
    if (aiResult.type === "update" && aiResult.updates) {
        aiResult.updates.forEach((upd) => { if (upd.name) soldiersStatus[upd.name] = upd.status; });
        saveAll();
        bot.sendMessage(chatId, `קיבלתי, עדכנתי! 👍`);
    } else {
        bot.sendMessage(chatId, aiResult.text || "רות.");
    }
});

// שרת HTTP עבור Render
const port = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is Alive');
}).listen(port);

console.log("הבוט דרוך ומוכן ב-Ohio!");
