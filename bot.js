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

http.createServer((req, res) => { res.write("Bot V55 Active"); res.end(); }).listen(process.env.PORT || 3000);

const GROUP_CHAT_ID = "-1003748361029"; 

console.log("🚀 גרסה 55 - כולל חסימת חיילים שלא במצבת (Validation)!");

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

  // --- שומר הסף ---
  const isGroup = chatId < 0; 
  const isQuickUpdate = text.startsWith("*");
  const isFullReport = (text.includes("בבית:") || text.includes("בבסיס:")) && text.includes("\n");
  const isCommand = ["דוח 1", "***שינוי", "***הוספת", "איפוס"].some(cmd => text.includes(cmd)) || text.startsWith("/");

  if (isGroup && !isQuickUpdate && !isFullReport && !isCommand) return; 

  console.log(`\n📥 הודעה עברה סינון מ-${senderName}: "${text.substring(0, 30)}..."`);

  try {
    // שליפת המצבת הקבועה
    const { data: roster } = await supabase.from("soldiers").select("name, unit").eq("is_active", true);
    
    console.log("🧠 שולח לניתוח ב-Gemini...");
    const ai = await askAi(text, roster || [], senderName);

    // 1. בקשת דוח
    const isReportReq = ["דוח", "מצב", "סטטוס"].some(k => text.includes(k));
    if (ai.type === "show_report" || (isReportReq && ai.type !== "update")) {
      const targetDate = ai.targetDate || new Date().toISOString().split('T')[0];
      const { data: dailyUpdates } = await supabase.from("report_data").select("*").eq("report_date", targetDate);
      
      const mergedData = (roster || []).map(soldier => {
        const update = (dailyUpdates || []).find(u => u.name === soldier.name);
        return {
          name: soldier.name,
          unit: soldier.unit,
          status: update ? update.status : "BASE",
          mission: update ? update.mission : "ללא משימה"
        };
      });

      return bot.sendMessage(chatId, generateFixedReport(mergedData, targetDate), { parse_mode: "Markdown" });
    }

    // 2. עדכון רשימה/כוכבית (עם חסימת זרים)
    if (ai.type === "update" && ai.updates && ai.updates.length > 0) {
      let count = 0;
      let unknownNames = []; // מערך לשמירת שמות שלא קיימים במצבת
      const dates = ai.dates && ai.dates.length > 0 ? ai.dates : [new Date().toISOString().split('T')[0]];

      for (const date of dates) {
        for (let u of ai.updates) {
          // בדיקה האם השם קיים במצבת
          const soldierInfo = (roster || []).find(s => s.name === u.name || s.name.includes(u.name) || u.name.includes(s.name));

          if (!soldierInfo) {
            // אם לא נמצא, נוסיף לרשימת השגויים ונדלג על העדכון שלו
            if (!unknownNames.includes(u.name)) unknownNames.push(u.name);
            console.log(`⚠️ חסימה: השם '${u.name}' לא מופיע במצבת ולכן לא עודכן ביומן.`);
            continue; 
          }

          // אם נמצא, ניקח את השם המדויק מהמצבת כדי למנוע טעויות
          const exactName = soldierInfo.name;

          const { data, error } = await supabase.from("report_data").upsert({
            name: exactName,
            status: u.status || "BASE",
            mission: u.mission || "ללא משימה",
            report_date: date
          }, { onConflict: 'name, report_date' }).select();
          
          if (error) console.error(`❌ שגיאה בעדכון ביומן ל-${exactName}:`, error);
          else if (data) count++;
        }
      }

      // הרכבת הודעת התשובה למשתמש
      let responseText = "";
      if (count > 0) responseText += `✅ העדכון נקלט ביומן (${count} חיילים).\n`;
      if (unknownNames.length > 0) {
        responseText += `\n⚠️ *שים לב:* השמות הבאים לא מופיעים במצבת הפלוגתית ולכן הרישום שלהם נדחה:\n${unknownNames.map(n => `- ${n}`).join("\n")}\n\n*(ניתן להוסיף אותם למצבת עם הפקודה: \`***הוספת [שם] [מחלקה]\`)*`;
      }
      if (count === 0 && unknownNames.length === 0) responseText = "לא בוצעו עדכונים מחוסר נתונים.";

      return bot.sendMessage(chatId, responseText, { parse_mode: "Markdown" });
    }

    // 3. הוספה / שינוי שם
    if (ai.type === "rename") {
      await supabase.from("soldiers").update({ name: ai.newName }).eq("name", ai.oldName);
      return bot.sendMessage(chatId, `✅ המצבת עודכנה: השם שונה מ-${ai.oldName} ל-${ai.newName}.`);
    }

    if (ai.type === "add") {
      await supabase.from("soldiers").insert([{ name: ai.name, unit: ai.unit, is_active: true }]);
      return bot.sendMessage(chatId, `✅ ${ai.name} נוסף בהצלחה למצבת הקבועה.`);
    }

    if (ai.type === "chat") {
      bot.sendMessage(chatId, ai.text);
    }

  } catch (e) { 
    console.error("🔴 שגיאה:", e);
  }
});

// ==========================================
// פונקציות עזר 
// ==========================================
async function askAi(input, data, senderName) {
  const todayStr = new Date().toLocaleDateString('he-IL');
  const prompt = `אתה סמב"ץ פלוגתי. היום: ${todayStr}. המשתמש: ${senderName}. 
  מאגר: ${JSON.stringify([...new Set(data.map(s => s.name))])}.
  הודעה: "${input}". 
  
  חוקים:
  1. עדכון מהיר בכוכבית (*): אם ההודעה מתחילה ב-* (למשל "*דביר בבית"), הפוך לפקודת update.
  2. תאריך: זהה תאריכים כמו "07/04", "מחר". הפוך ל-YYYY-MM-DD.
  3. רשימות: חלץ שמות תחת "בבית:" ו-"בבסיס:".
  4. השתמש בשמות כפי שהם משתמעים מההודעה. הקוד כבר יבדוק אם הם קיימים במאגר.
  
  החזר JSON בלבד: {"type":"update/show_report/rename/add/chat", "targetDate":"YYYY-MM-DD", "dates":["YYYY-MM-DD"], "unit":"", "updates":[{"name":"...", "status":"BASE/HOME", "mission":"..."}], "text":"..."}`;

  const postData = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
  const options = { hostname: "generativelanguage.googleapis.com", path: `/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_KEY}`, method: "POST", headers: { "Content-Type": "application/json" } };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let b = ""; res.on("data", d => b += d);
      res.on("end", () => {
        try {
          let raw = JSON.parse(b).candidates[0].content.parts[0].text;
          resolve(JSON.parse(raw.substring(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
        } catch (e) { resolve({ type: "chat", text: "שגיאה בניתוח." }); }
      });
    });
    req.write(postData); req.end();
  });
}

function generateFixedReport(soldiers, dateString) {
  const dateObj = new Date(dateString);
  const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const d = String(dateObj.getDate()).padStart(2, '0'), m = String(dateObj.getMonth() + 1).padStart(2, '0'), y = dateObj.getFullYear();
  
  let r = `**דוח כ"א ליום ${days[dateObj.getDay()]} ${d}.${m}.${y}**\n\n*סד''כ מחלקות* 🪖\n\n`;
  
  VALID_UNITS.forEach((u) => {
    const unitSolds = soldiers.filter(s => s.unit === u);
    r += `*${u}:*\n`;
    if (unitSolds.length === 0) { r += `${RLM}---\n\n`; return; }
    const inB = unitSolds.filter(s => s.status === "BASE"), inH = unitSolds.filter(s => s.status === "HOME");
    if (inB.length > 0) r += `בבסיס (${inB.length}):\n${inB.map(s => s.name).join("\n")}\n\n`;
    if (inH.length > 0) r += `בבית (${inH.length}):\n${inH.map(s => s.name).join("\n")}\n\n`;
    r += `סה"כ: ${inB.length}/${unitSolds.length}.\n\n`;
  });

  r += "---------------------------------\n\n📊 *סיכום:*\n";
  r += `סה"כ: ${soldiers.length}.\nבבסיס: ${soldiers.filter(s => s.status === "BASE").length}.\nבבית: ${soldiers.filter(s => s.status === "HOME").length}.`;
  return r;
}
