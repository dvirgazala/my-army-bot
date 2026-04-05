require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const https = require("https");
const http = require("http");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const VALID_UNITS = ['מפל"ג', "מחלקה 1", "מחלקה 2", "מחלקה 3", "חובשים"];
const RLM = "\u200f";

http.createServer((req, res) => { res.write("Bot is running!"); res.end(); }).listen(process.env.PORT || 3000);

console.log("🚀 גרסה 42 באוויר - חסימת עדכון מאגר אוטומטי פעילה.");

bot.on("message", async (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const senderName = msg.from.first_name || "מפקד";

  // 1. דוח מהיר
  const isReport = ["דוח", "מצב", "תמונה", "סיכום", "סטטוס"].some(k => text.includes(k));
  const isReset = ["איפוס", "תאפס", "לאפס", "נקה"].some(k => text.includes(k));

  if (isReport && !isReset) {
    const { data } = await supabase.from("soldiers").select("*").eq("is_active", true);
    return bot.sendMessage(chatId, generateFixedReport(data || []), { parse_mode: "Markdown" });
  }

  // 2. עיבוד כל הודעה דרך ה-AI (ביטלנו את לוגיקת הנקודתיים העצמאית!)
  try {
    const { data: allSoldiers } = await supabase.from("soldiers").select("*");
    const ai = await askAi(text, allSoldiers || [], senderName);

    // א. שינוי שם (רק עם פקודה מפורשת)
    if (ai.type === "rename" && ai.newName && ai.oldName) {
      const { error } = await supabase.from("soldiers").update({ name: ai.newName }).eq("name", ai.oldName);
      if (error) return bot.sendMessage(chatId, `❌ לא מצאתי את "${ai.oldName}" במאגר.`);
      return bot.sendMessage(chatId, `✅ השם שונה מ-${ai.oldName} ל-${ai.newName}.`);
    }

    // ב. הוספת חייל חדש (רק עם פקודה מפורשת)
    if (ai.type === "add" && ai.name && ai.unit) {
      await supabase.from("soldiers").insert([{ name: ai.name, unit: ai.unit, status: "BASE", is_active: true }]);
      return bot.sendMessage(chatId, `✅ ${ai.name} נוסף למחלקת ${ai.unit}.`);
    }

    // ג. איפוס
    if (ai.type === "reset") {
      let q = supabase.from("soldiers").update({ is_active: false, status: "BASE", mission: "ללא משימה" });
      if (ai.unit && ai.unit !== "ALL") await q.eq("unit", ai.unit);
      else await q.neq("name", "dummy");
      return bot.sendMessage(chatId, `🫡 הדוח אופס (${ai.unit === "ALL" ? "הכל" : ai.unit}).`);
    }

    // ד. עדכון סטטוס / משימה (החלק שאתה משתמש בו בשוטף)
    if (ai.type === "update" && ai.updates) {
      let count = 0;
      for (let u of ai.updates) {
        let fields = { is_active: true };
        if (u.status) fields.status = u.status;
        if (u.mission) fields.mission = u.mission;

        let q = supabase.from("soldiers").update(fields);
        // מחפשים רק את מי שכבר קיים במאגר!
        if (u.name) {
          const cleanName = u.name.replace(/[-\s]/g, '%');
          q = q.ilike("name", `%${cleanName}%`);
        }
        const { data } = await q.select();
        if (data) count += data.length;
      }
      if (count > 0) return bot.sendMessage(chatId, ai.text);
      return bot.sendMessage(chatId, `🤔 ${senderName}, לא מצאתי אף אחד מהשמות האלו במאגר הפלוגתי.`);
    }

    // ה. שיחה רגילה
    if (ai.type === "chat") bot.sendMessage(chatId, ai.text);

  } catch (e) {
    console.error("Error:", e);
    bot.sendMessage(chatId, "הייתה לי תקלה. נסה שוב.");
  }
});

async function askAi(input, data, senderName) {
  const prompt = `אתה סמב"ץ פלוגתי. המשתמש: ${senderName}. 
  מחלקות מותרות בלבד: ${VALID_UNITS.join(", ")}.
  משימות מותרות: חפ"ק מ"פ, חפ"ק סמ"פ, חפ"ק מ"מ 1, חפ"ק מ"מ 2, חפ"ק מ"מ 3, חפ"ק עתודה, משאית.
  מאגר שמות קיים: ${JSON.stringify(data.map(s => s.name))}.

  חוקים קשיחים:
  1. אין ליצור שמות חדשים אלא אם המשתמש כתב במפורש "***עדכון".
  2. הודעה כמו "חפ"ק מ"פ: שם, שם" היא עדכון משימה (mission) לשמות הקיימים.
  3. אם שם לא קיים במאגר, התעלם ממנו ב-updates.
  4. החזר JSON בלבד: {"type":"update/rename/add/reset/chat", "updates":[{"name":"שם", "status":"BASE/HOME", "mission":"משימה"}], "oldName":"שם", "newName":"שם", "unit":"מחלקה", "text":"תשובה"}`;

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
        } catch (e) { resolve({ type: "chat", text: "לא הצלחתי לעבד את הבקשה." }); }
      });
    });
    req.write(postData); req.end();
  });
}

function generateFixedReport(soldiers) {
  let r = "*סד''כ מחלקות* 🪖\n\n";
  VALID_UNITS.forEach((u) => {
    const unitSolds = soldiers.filter(s => s.unit === u);
    r += `*${u}:*\n`;
    if (unitSolds.length === 0) { r += `${RLM}---\n\n`; return; }
    const inBase = unitSolds.filter(s => s.status === "BASE");
    const inHome = unitSolds.filter(s => s.status === "HOME");
    if (inBase.length > 0) r += `בבסיס (${inBase.length}):\n${inBase.map(s => s.name).join("\n")}\n\n`;
    if (inHome.length > 0) r += `בבית (${inHome.length}):\n${inHome.map(s => s.name).join("\n")}\n\n`;
    r += `סה"כ: ${inBase.length}/${unitSolds.length}.\n\n`;
  });

  r += "---------------------------------\n\n*שיבוץ משימות* ⚡️\n\n";
  const missions = ['חפ"ק מ"פ', 'חפ"ק סמ"פ', 'חפ"ק מ"מ 1', 'חפ"ק מ"מ 2', 'חפ"ק מ"מ 3', 'חפ"ק עתודה', 'משאית'];
  missions.forEach(m => {
    const assigned = soldiers.filter(s => (s.mission || "").includes(m.replace(/['"״]/g, '')));
    r += `*${m}:*\n${assigned.length > 0 ? assigned.map(s => s.name).join("\n") : RLM + "---"}\n\n`;
  });

  r += "---------------------------------\n\n📊 *סיכום:*\n";
  r += `סה"כ: ${soldiers.length}.\nבבסיס: ${soldiers.filter(s => s.status === "BASE").length}.\nבבית: ${soldiers.filter(s => s.status === "HOME").length}.`;
  return r;
}
