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

http.createServer((req, res) => { res.write("Bot is running!"); res.end(); }).listen(process.env.PORT || 3000);

console.log("🚀 גרסה 48 באוויר - פקודת /id ותזכורות פעילות.");

// ==========================================
// תזמון הודעות (Cron Jobs) - 18:00 כל יום
// ==========================================

// כאן תכניס את ה-ID שתקבל מהפקודה /id (למשל: -100123456789)
const GROUP_CHAT_ID = "-1003748361029"; 

// שבת עד רביעי - תזכורת רגילה
cron.schedule('0 18 * * 0,1,2,3,6', () => {
  if (GROUP_CHAT_ID !== "כאן_תשים_את_המספר_שתקבל") {
    bot.sendMessage(GROUP_CHAT_ID, "⚠️ *תזכורת:* נא לשלוח דוח 1 למחר!", { parse_mode: "Markdown" });
  }
}, { scheduled: true, timezone: "Asia/Jerusalem" });

// יום חמישי - תזכורת לסופ"ש
cron.schedule('0 18 * * 4', () => {
  if (GROUP_CHAT_ID !== "כאן_תשים_את_המספר_שתקבל") {
    bot.sendMessage(GROUP_CHAT_ID, "⚠️ *תזכורת סופ\"ש:* נא לשלוח דוח 1 לשישי-שבת!", { parse_mode: "Markdown" });
  }
}, { scheduled: true, timezone: "Asia/Jerusalem" });


// ==========================================
// לוגיקת הודעות
// ==========================================
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const senderName = msg.from.first_name || "מפקד";

  // פקודת ID - עוקפת את ה-AI
  if (text.startsWith("/id")) {
    return bot.sendMessage(chatId, `ה-ID של הצ'אט הזה הוא: \`${chatId}\``, { parse_mode: "Markdown" });
  }

  // בדיקת דוח 1 - עוקפת את ה-AI
  const isReport = ["דוח", "מצב", "תמונה", "סיכום", "סטטוס"].some(k => text.includes(k));
  const isReset = ["איפוס", "תאפס", "לאפס", "נקה"].some(k => text.includes(k));

  if (isReport && !isReset) {
    const { data } = await supabase.from("soldiers").select("*").eq("is_active", true);
    return bot.sendMessage(chatId, generateFixedReport(data || []), { parse_mode: "Markdown" });
  }

  // כל השאר עובר ל-AI
  try {
    const { data: allSoldiers } = await supabase.from("soldiers").select("*");
    const ai = await askAi(text, allSoldiers || [], senderName);

    if (ai.type === "rename") {
      await supabase.from("soldiers").update({ name: ai.newName }).eq("name", ai.oldName);
      return bot.sendMessage(chatId, `✅ השם שונה ל-${ai.newName}.`);
    }

    if (ai.type === "add") {
      await supabase.from("soldiers").insert([{ name: ai.name, unit: ai.unit, status: "BASE", is_active: true }]);
      return bot.sendMessage(chatId, `✅ ${ai.name} נוסף למאגר.`);
    }

    if (ai.type === "reset") {
      let q = supabase.from("soldiers").update({ is_active: false, status: "BASE", mission: "ללא משימה" });
      if (ai.unit && ai.unit !== "ALL") await q.eq("unit", ai.unit);
      else await q.neq("name", "dummy");
      return bot.sendMessage(chatId, `🫡 אופס.`);
    }

    if (ai.type === "update" && ai.updates) {
      let count = 0;
      for (let u of ai.updates) {
        let fields = { is_active: true };
        if (u.status) fields.status = u.status;
        if (u.mission) fields.mission = u.mission;
        let q = supabase.from("soldiers").update(fields);
        if (u.name) q = q.ilike("name", `%${u.name.replace(/[-\s]/g, '%')}%`);
        const { data } = await q.select();
        if (data) count += data.length;
      }
      if (count > 0) return bot.sendMessage(chatId, ai.text);
      else return bot.sendMessage(chatId, "לא מצאתי את השמות במאגר.");
    }

    if (ai.type === "chat") bot.sendMessage(chatId, ai.text);

  } catch (e) { bot.sendMessage(chatId, "תקלה קטנה, נסה שוב."); }
});

// ==========================================
// פונקציות עזר (AI ודוח)
// ==========================================
async function askAi(input, data, senderName) {
  const prompt = `אתה סמב"ץ פלוגתי. משתמש: ${senderName}. 
  מאגר: ${JSON.stringify(data.map(s => ({ name: s.name, unit: s.unit })))}.
  הודעה: "${input}". 
  חוקים:
  1. שינוי שם: רק עם "***שינוי שם:".
  2. הוספה: רק עם "***הוספת שם:".
  3. איפוס: reset.
  4. עדכון: updates לסטטוס/משימה.
  5. שיחה: chat.
  החזר JSON בלבד!`;

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
        } catch (e) { resolve({ type: "chat", text: "לא הבנתי." }); }
      });
    });
    req.write(postData); req.end();
  });
}

function generateFixedReport(soldiers) {
  const now = new Date();
  const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const dayName = days[now.getDay()];
  const d = String(now.getDate()).padStart(2, '0'), m = String(now.getMonth() + 1).padStart(2, '0'), y = now.getFullYear();
  
  let r = `**יום ${dayName} ${d}.${m}.${y}**\n\n*סד''כ מחלקות* 🪖\n\n`;
  
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
