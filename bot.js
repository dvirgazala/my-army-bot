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

// שרת דמה ל-Render כדי שלא יירדם
http.createServer((req, res) => { res.write("Bot V53.1 Active"); res.end(); }).listen(process.env.PORT || 3000);

const GROUP_CHAT_ID = "-1003748361029"; 

console.log("🚀 גרסה 53.1 - כולל שומר סף מדויק והנחיות AI מורחבות לכוכבית!");

// ==========================================
// תזמון הודעות (Cron) - שעון ישראל
// ==========================================
cron.schedule('0 18 * * 0,1,2,3,6', () => {
  console.log("⏰ מפעיל תזכורת יומית (שבת-רביעי)...");
  if (GROUP_CHAT_ID) bot.sendMessage(GROUP_CHAT_ID, "⚠️ *תזכורת:* נא לשלוח דוח 1 למחר!", { parse_mode: "Markdown" });
}, { scheduled: true, timezone: "Asia/Jerusalem" });

cron.schedule('0 18 * * 4', () => {
  console.log("⏰ מפעיל תזכורת סופ\"ש (חמישי)...");
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

  // פקודת ID עוקפת הכל
  if (text.startsWith("/id")) {
    console.log("⚡ זוהתה פקודת /id.");
    return bot.sendMessage(chatId, `ה-ID של הצ'אט הזה הוא: \`${chatId}\``, { parse_mode: "Markdown" });
  }

  // --- התחלת שומר הסף (המסננת החכמה) ---
  const isGroup = chatId < 0; 
  
  // 1. עדכון מהיר בכוכבית (למשל: *דביר גזלה בבית)
  const isQuickUpdate = text.startsWith("*");
  
  // 2. דיווח מלא (נקודתיים + ירידת שורה)
  const hasStatusHeader = text.includes("בבית:") || text.includes("בבסיס:");
  const isMultiLine = text.includes("\n");
  const isFullReport = hasStatusHeader && isMultiLine;
  
  // 3. פקודות מערכת (דוח 1, הוספת שם, פקודות /)
  const systemCommands = ["דוח 1", "***שינוי", "***הוספת", "איפוס"];
  const isCommand = systemCommands.some(cmd => text.includes(cmd)) || text.startsWith("/");

  // החלטה: האם לעבד את ההודעה?
  const shouldProcess = isQuickUpdate || isFullReport || isCommand;

  if (isGroup && !shouldProcess) {
    console.log(`🙈 מסננת הופעלה - התעלמות משיחת חולין: "${text.replace(/\n/g, " ").substring(0, 30)}..."`);
    return; 
  }
  // --- סוף שומר הסף ---

  console.log(`\n📥 הודעה עברה סינון מ-${senderName}: "${text}"`);

  try {
    console.log("🔍 שולף שמות מהמאגר לטובת ה-AI...");
    const { data: allSoldiers } = await supabase.from("soldiers").select("name, unit");
    
    console.log("🧠 שולח לניתוח ב-Gemini...");
    const ai = await askAi(text, allSoldiers || [], senderName);
    
    console.log("🤖 תגובת ה-AI (JSON):", JSON.stringify(ai, null, 2));

    // 1. בקשת דוח
    const isReportReq = ["דוח", "מצב", "סטטוס"].some(k => text.includes(k));
    if (ai.type === "show_report" || (isReportReq && ai.type !== "update")) {
      const targetDate = ai.targetDate || new Date().toISOString().split('T')[0];
      console.log(`📊 מכין דוח לתאריך: ${targetDate}...`);
      const { data } = await supabase.from("soldiers").select("*").eq("report_date", targetDate);
      return bot.sendMessage(chatId, generateFixedReport(data || [], targetDate), { parse_mode: "Markdown" });
    }

    // 2. עדכון רשימה או עדכון מהיר בכוכבית
    if (ai.type === "update" && ai.updates && ai.updates.length > 0) {
      let count = 0;
      const dates = ai.dates && ai.dates.length > 0 ? ai.dates : [new Date().toISOString().split('T')[0]];
      console.log(`✍️ מתחיל עדכון עבור התאריכים: ${dates.join(", ")}`);

      for (const date of dates) {
        for (let u of ai.updates) {
          const soldierInfo = allSoldiers.find(s => s.name.includes(u.name) || u.name.includes(s.name));
          const finalUnit = u.unit || soldierInfo?.unit || ai.unit || "ללא מחלקה";
          
          console.log(`מעדכן: שם=${u.name}, תאריך=${date}, סטטוס=${u.status || "BASE"}`);
          
          const { data, error } = await supabase.from("soldiers").upsert({
            name: u.name,
            unit: finalUnit,
            status: u.status || "BASE",
            mission: u.mission || "ללא משימה",
            report_date: date,
            is_active: true
          }, { onConflict: 'name, report_date' }).select();
          
          if (error) console.error(`❌ שגיאה בעדכון ${u.name}:`, error);
          else if (data) count += data.length;
        }
      }
      const responseText = count > 0 ? `✅ עודכן דוח ליום ${dates.join(", ")} (${count} חיילים).` : "לא מצאתי שמות מוכרים במאגר.";
      return bot.sendMessage(chatId, responseText);
    }

    // 3. שינוי שם / הוספה
    if (ai.type === "rename") {
      console.log(`🔄 מחליף שם מ-${ai.oldName} ל-${ai.newName}`);
      await supabase.from("soldiers").update({ name: ai.newName }).eq("name", ai.oldName);
      return bot.sendMessage(chatId, `✅ השם שונה מ-${ai.oldName} ל-${ai.newName}.`);
    }

    if (ai.type === "add") {
      const todayStr = new Date().toISOString().split('T')[0];
      console.log(`➕ מוסיף שם חדש: ${ai.name}`);
      await supabase.from("soldiers").insert([{ name: ai.name, unit: ai.unit, status: "BASE", is_active: true, report_date: todayStr }]);
      return bot.sendMessage(chatId, `✅ ${ai.name} נוסף למאגר.`);
    }

    if (ai.type === "chat") {
      console.log("💬 ה-AI זיהה כשיחה כללית, שולח את התשובה.");
      bot.sendMessage(chatId, ai.text);
    }

  } catch (e) { 
    console.error("🔴 שגיאה בעיבוד התשובה:", e);
    bot.sendMessage(chatId, "שגיאה בעיבוד ההודעה, נסה שוב."); 
  }
});

// ==========================================
// פונקציות עזר (AI ודוח)
// ==========================================
async function askAi(input, data, senderName) {
  const todayStr = new Date().toLocaleDateString('he-IL');
  const prompt = `אתה סמב"ץ פלוגתי. היום: ${todayStr}. המשתמש: ${senderName}. 
  מאגר שמות מוכר: ${JSON.stringify([...new Set(data.map(s => s.name))])}.
  הודעה מהמשתמש: "${input}". 
  
  חוקים קריטיים:
  1. עדכון מהיר בכוכבית (*): אם ההודעה מתחילה ב-* (כוכבית), זהו עדכון סטטוס מהיר. השם מופיע מיד אחרי הכוכבית והסטטוס (בבית/בבסיס) מופיע בהמשך השורה. לדוגמה: אם כתוב "*דביר גזלה בבית", הפוך ל-JSON של update עבור דביר גזלה עם status: HOME.
  2. תאריך: זהה תאריכים כמו "07/04", "מחר", "שישי שבת". הפוך לפורמט YYYY-MM-DD.
  3. דיווח רשימה: חלץ שמות תחת "בבסיס:" ו-"בבית:" ושייך להם את הסטטוס והתאריך.
  4. זיהוי שמות: חובה להשתמש בשם המדויק מהמאגר אם יש דמיון קל (למשל "שי-יה" -> "שי יה").
  
  החזר JSON בלבד: {"type":"update/show_report/rename/add/chat", "targetDate":"YYYY-MM-DD", "dates":["YYYY-MM-DD"], "unit":"שם מחלקה אם צוין", "updates":[{"name":"...", "status":"BASE/HOME", "mission":"..."}], "text":"תשובה קצרה"}`;

  const postData = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
  const options = {
    hostname: "generativelanguage.googleapis.com",
    path: `/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_KEY}`,
    method: "POST", headers: { "Content-Type": "application/json" }
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let b = "";
      res.on("data", d => b += d);
      res.on("end", () => {
        try {
          let raw = JSON.parse(b).candidates[0].content.parts[0].text;
          const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
          resolve(JSON.parse(raw.substring(start, end + 1)));
        } catch (e) { resolve({ type: "chat", text: "שגיאה בניתוח ההודעה על ידי ה-AI." }); }
      });
    });
    req.write(postData); req.end();
  });
}

function generateFixedReport(soldiers, dateString) {
  const dateObj = new Date(dateString);
  const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const dayName = days[dateObj.getDay()];
  const d = String(dateObj.getDate()).padStart(2, '0'), m = String(dateObj.getMonth() + 1).padStart(2, '0'), y = dateObj.getFullYear();
  
  let r = `**דוח כ"א ליום ${dayName} ${d}.${m}.${y}**\n\n*סד''כ מחלקות* 🪖\n\n`;
  
  VALID_UNITS.forEach((u) => {
    const unitSolds = soldiers.filter(s => s.unit === u);
    r += `*${u}:*\n`;
    if (unitSolds.length === 0) { r += `${RLM}---\n\n`; return; }
    const inB = unitSolds.filter(s => s.status === "BASE"), inH = unitSolds.filter(s => s.status === "HOME");
    if (inB.length > 0) r += `בבסיס (${inB.length}):\n${inB.map(s => s.name).join("\n")}\n\n`;
    if (inH.length > 0) r += `בבית (${inH.length}):\n${inH.map(s => s.name).join("\n")}\n\n`;
    r += `סה"כ: ${inB.length}/${unitSolds.length}.\n\n`;
  });

  r += "---------------------------------\n\n*שיבוץ משימות* ⚡️\n\n";
  const mis = ['חפ"ק מ"פ', 'חפ"ק סמ"פ', 'חפ"ק מ"מ 1', 'חפ"ק מ"מ 2', 'חפ"ק מ"מ 3', 'חפ"ק עתודה', 'משאית'];
  mis.forEach(m => {
    const assigned = soldiers.filter(s => (s.mission || "").includes(m.replace(/['"״]/g, '')));
    r += `*${m}:*\n${assigned.length > 0 ? assigned.map(s => s.name).join("\n") : RLM + "---"}\n\n`;
  });

  const bAll = soldiers.filter(s => s.status === "BASE").length, hAll = soldiers.filter(s => s.status === "HOME").length;
  r += `---------------------------------\n\n📊 *סיכום:*\nסה"כ: ${soldiers.length}.\nבבסיס: ${bAll}.\nבבית: ${hAll}.`;
  return r;
}
