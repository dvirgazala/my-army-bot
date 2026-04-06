require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const https = require("https");
const http = require("http");
const cron = require("node-cron");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const VALID_UNITS = ['מפל"ג', "מחלקה 1", "מחלקה 2", "מחלקה 3", "חובשים"];
const RLM = "\u200f";

http.createServer((req, res) => { res.write("Bot V59 Active"); res.end(); }).listen(process.env.PORT || 3000);

const GROUP_CHAT_ID = "-1003748361029"; 

console.log("🚀 גרסה 59 - שליטה מלאה דרך כוכבית (*) בלבד!");

// ==========================================
// תזמון הודעות (Cron)
// ==========================================
cron.schedule('0 18 * * 0,1,2,3,6', () => {
  if (GROUP_CHAT_ID) bot.sendMessage(GROUP_CHAT_ID, "⚠️ *תזכורת:* נא לשלוח דוח 1 למחר!", { parse_mode: "Markdown" });
}, { scheduled: true, timezone: "Asia/Jerusalem" });

cron.schedule('0 18 * * 4', () => {
  if (GROUP_CHAT_ID) bot.sendMessage(GROUP_CHAT_ID, "⚠️ *תזכורת סופ\"ש:* נא לשלוח דוח 1 לשישי-שבת!", { parse_mode: "Markdown" });
}, { scheduled: true, timezone: "Asia/Jerusalem" });

// ==========================================
// לוגיקת הודעות ושומר הסף
// ==========================================
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const senderName = msg.from.first_name || "מפקד";

  if (text.startsWith("/id")) return bot.sendMessage(chatId, `ID: \`${chatId}\``);

  // --- שומר הסף (גרסה 59) ---
  const isGroup = chatId < 0; 
  
  // 1. חוק הכוכבית - הפקודה חייבת להתחיל בכוכבית
  const isAsteriskStart = text.startsWith("*");
  
  // 2. דיווח מלא (חריג יחיד ללא כוכבית - פורמט רשימה רשמי)
  const isFullReport = (text.includes("בבית:") || text.includes("בבסיס:")) && text.includes("\n");
  
  // 3. פקודות מערכת (/id וכו')
  const isSlashCommand = text.startsWith("/");

  // הבוט מתעורר רק אם יש כוכבית, דיווח מלא או פקודת סלאש
  const shouldProcess = isAsteriskStart || isFullReport || isSlashCommand;

  if (isGroup && !shouldProcess) {
    // הבוט מתעלם מכל השאר (כולל מילים כמו "דוח" או "איפוס" ללא כוכבית)
    return; 
  }
  // --- סוף שומר הסף ---

  console.log(`\n📥 הודעה עברה סינון מ-${senderName}: "${text.substring(0, 30)}..."`);

  try {
    const { data: roster } = await supabase.from("soldiers").select("name, unit").eq("is_active", true);
    
    // ניקוי הכוכבית לפני השליחה ל-AI כדי שלא יתבלבל
    const cleanText = text.startsWith("*") ? text.substring(1).trim() : text;
    const ai = await askAi(cleanText, roster || [], senderName);
    
    console.log("🤖 תגובת ה-AI:", JSON.stringify(ai));

    // 0. איפוס דוח (Clear)
    if (ai.type === "clear") {
      const targetDate = ai.targetDate || new Date().toISOString().split('T')[0];
      await supabase.from("report_data").delete().eq("report_date", targetDate);
      return bot.sendMessage(chatId, `🧹 **דוח 1 לתאריך ${targetDate} אופס בהצלחה!**`, { parse_mode: "Markdown" });
    }

    // 1. עדכון גורף (Bulk Update)
    if (ai.type === "bulk_update") {
      let count = 0;
      const dates = ai.dates && ai.dates.length > 0 ? ai.dates : [new Date().toISOString().split('T')[0]];
      const newStatus = ai.status || "BASE";

      for (const date of dates) {
        for (let soldier of roster) {
          if (ai.unit && ai.unit !== "all" && soldier.unit !== ai.unit) continue;
          await supabase.from("report_data").upsert({
            name: soldier.name, status: newStatus, mission: "ללא משימה", report_date: date
          }, { onConflict: 'name, report_date' });
          count++;
        }
      }
      return bot.sendMessage(chatId, `✅ עדכון גורף בוצע ל-${count} חיילים עבור ${dates.join(", ")}.`);
    }

    // 2. עדכון רגיל (בודדים/רשימה)
    if (ai.type === "update" && ai.updates && ai.updates.length > 0) {
      let count = 0;
      let unknownNames = []; 
      const dates = ai.dates && ai.dates.length > 0 ? ai.dates : [new Date().toISOString().split('T')[0]];

      for (const date of dates) {
        for (let u of ai.updates) {
          const soldierInfo = (roster || []).find(s => s.name === u.name || s.name.includes(u.name) || u.name.includes(s.name));
          if (!soldierInfo) {
            if (!unknownNames.includes(u.name)) unknownNames.push(u.name);
            continue; 
          }
          await supabase.from("report_data").upsert({
            name: soldierInfo.name, status: u.status || "BASE", mission: u.mission || "ללא משימה", report_date: date
          }, { onConflict: 'name, report_date' });
          count++;
        }
      }

      let resTxt = count > 0 ? `✅ העדכון נקלט (${count} חיילים).` : "";
      if (unknownNames.length > 0) resTxt += `\n⚠️ שמות לא במצבת: ${unknownNames.join(", ")}`;
      return bot.sendMessage(chatId, resTxt);
    }

    // 3. הצגת דוח
    if (ai.type === "show_report" || (text.includes("דוח") && ai.type === "chat")) {
      const targetDate = ai.targetDate || new Date().toISOString().split('T')[0];
      const { data: dailyUpdates } = await supabase.from("report_data").select("*").eq("report_date", targetDate);
      const merged = (roster || []).map(s => {
        const u = (dailyUpdates || []).find(up => up.name === s.name);
        return { name: s.name, unit: s.unit, status: u ? u.status : "BASE" };
      });
      return bot.sendMessage(chatId, generateFixedReport(merged, targetDate), { parse_mode: "Markdown" });
    }

    // 4. ניהול מצבת
    if (ai.type === "rename") {
      await supabase.from("soldiers").update({ name: ai.newName }).eq("name", ai.oldName);
      return bot.sendMessage(chatId, `✅ השם שונה ל-${ai.newName}.`);
    }
    if (ai.type === "add") {
      await supabase.from("soldiers").insert([{ name: ai.name, unit: ai.unit, is_active: true }]);
      return bot.sendMessage(chatId, `✅ ${ai.name} נוסף למצבת.`);
    }

  } catch (e) { console.error(e); }
});

// ==========================================
// פונקציות עזר 
// ==========================================
async function askAi(input, data, senderName) {
  const todayStr = new Date().toLocaleDateString('he-IL');
  const prompt = `אתה סמב"ץ פלוגתי. היום: ${todayStr}. מאגר: ${JSON.stringify([...new Set(data.map(s => s.name))])}.
  הודעה: "${input}". 
  
  חוקים:
  1. איפוס/מחיקה: אם הבקשה היא למחוק/לאפס דוח, החזר type: "clear".
  2. עדכון גורף: אם הבקשה היא לכולם או למחלקה שלמה, החזר type: "bulk_update" עם הסטטוס והיחידה.
  3. הצגת דוח: אם הבקשה היא לראות דוח, החזר type: "show_report".
  4. עדכון בודדים: החזר type: "update".
  
  החזר JSON בלבד: {"type":"update/show_report/rename/add/clear/bulk_update/chat", "targetDate":"YYYY-MM-DD", "dates":["YYYY-MM-DD"], "unit":"all/מחלקה", "status":"BASE/HOME", "updates":[{"name":"...", "status":"BASE/HOME"}], "text":"..."}`;

  const postData = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
  const options = { hostname: "generativelanguage.googleapis.com", path: `/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_KEY}`, method: "POST", headers: { "Content-Type": "application/json" } };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let b = ""; res.on("data", d => b += d);
      res.on("end", () => {
        try {
          let raw = JSON.parse(b).candidates[0].content.parts[0].text;
          resolve(JSON.parse(raw.substring(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
        } catch (e) { resolve({ type: "chat" }); }
      });
    });
    req.write(postData); req.end();
  });
}

function generateFixedReport(soldiers, dateString) {
  const dateObj = new Date(dateString);
  const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const d = String(dateObj.getDate()).padStart(2, '0'), m = String(dateObj.getMonth() + 1).padStart(2, '0');
  let r = `**דוח כ"א ליום ${days[dateObj.getDay()]} ${d}.${m}**\n\n`;
  VALID_UNITS.forEach((u) => {
    const unitSolds = soldiers.filter(s => s.unit === u);
    r += `*${u}:*\n`;
    if (unitSolds.length === 0) { r += `---\n\n`; return; }
    const inB = unitSolds.filter(s => s.status === "BASE"), inH = unitSolds.filter(s => s.status === "HOME");
    if (inB.length > 0) r += `בבסיס (${inB.length}):\n${inB.map(s => s.name).join("\n")}\n\n`;
    if (inH.length > 0) r += `בבית (${inH.length}):\n${inH.map(s => s.name).join("\n")}\n\n`;
  });
  return r;
}
