require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const https = require("https");
const http = require("http");

// הגדרת מפתחות
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!TELEGRAM_TOKEN || !GEMINI_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ שגיאה: חסרים מפתחות! ודא שהגדרת אותם ב-Render או ב-.env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const VALID_UNITS = ['מפל"ג', "מחלקה 1", "מחלקה 2", "מחלקה 3", "חובשים"];
const RLM = "\u200f";

// שרת דמה ל-Render (Keep Alive)
http.createServer((req, res) => {
  res.write("Bot is running securely!");
  res.end();
}).listen(process.env.PORT || 3000);

console.log("🚀 בוט סמב''ץ גרסה 40 - מאוחדת ומאובטחת באוויר!");

// ==========================================
// לוגיקת קבלת הודעות
// ==========================================
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const senderName = msg.from.first_name || "מפקד";

  // 1. בדיקת דוח (סטטוס)
  const isReport = ["דוח", "מצב", "תמונה", "סיכום", "סטטוס"].some((k) => text.includes(k));
  const isResetCommand = ["איפוס", "תאפס", "לאפס", "נקה"].some((k) => text.includes(k));

  if (isReport && !isResetCommand) {
    const { data } = await supabase.from("soldiers").select("*").eq("is_active", true);
    return bot.sendMessage(chatId, generateFixedReport(data || []), { parse_mode: "Markdown" });
  }

  // 2. הזנת סד"כ רשימה (זיהוי "בסיס:" ו-"בבית:")
  if (text.includes(":") && !text.startsWith("***")) {
    const lines = text.split("\n");
    let currentUnit = "";
    let currentStatus = "BASE";
    let toInsert = [];
    
    for (let line of lines) {
      let l = line.trim();
      if (!l) continue;
      
      if (l.includes(":")) {
        const rawHeader = l.replace(":", "").trim().replace(/''/g, '"');
        if (rawHeader === "בסיס" || rawHeader === "בבסיס") {
          currentStatus = "BASE";
        } else if (rawHeader === "בבית" || rawHeader === "בית") {
          currentStatus = "HOME";
        } else {
          currentUnit = rawHeader; 
          currentStatus = "BASE";
        }
      } else if (currentUnit) {
        toInsert.push({ 
          name: l, unit: currentUnit, status: currentStatus, 
          mission: "ללא משימה", is_active: true 
        });
      }
    }
    if (toInsert.length > 0) {
      await supabase.from("soldiers").upsert(toInsert, { onConflict: "name" });
      return bot.sendMessage(chatId, `✅ המאגר עודכן! ${toInsert.length} חיילים נשמרו והוכנסו לדוח.`);
    }
  }

  // 3. עיבוד פקודות באמצעות AI
  try {
    const { data: allSoldiers } = await supabase.from("soldiers").select("*");
    const ai = await askAi(text, allSoldiers || [], senderName);

    // --- פקודת שינוי שם ---
    if (ai.type === "rename") {
      const { error } = await supabase.from("soldiers").update({ name: ai.newName }).eq("name", ai.oldName);
      if (error) return bot.sendMessage(chatId, `❌ שגיאה בשינוי השם. ודא שהשם "${ai.oldName}" קיים.`);
      return bot.sendMessage(chatId, `✅ השם עודכן בהצלחה מ-${ai.oldName} ל-${ai.newName}.`);
    }

    // --- פקודת הוספת חייל חדש ---
    if (ai.type === "add") {
      const { error } = await supabase.from("soldiers").insert([
        { name: ai.name, unit: ai.unit, status: "BASE", is_active: true }
      ]);
      if (error) return bot.sendMessage(chatId, `❌ לא הצלחתי להוסיף את ${ai.name}. אולי הוא כבר קיים?`);
      return bot.sendMessage(chatId, `✅ ${ai.name} נוסף למחלקת ${ai.unit} ומופיע בדוח.`);
    }

    // --- איפוס חכם ---
    if (ai.type === "reset") {
      let q = supabase.from("soldiers").update({ is_active: false, status: "BASE", mission: "ללא משימה" });
      if (ai.unit && ai.unit !== "ALL") {
        await q.eq("unit", ai.unit);
        return bot.sendMessage(chatId, `🫡 מחלקת **${ai.unit}** אופסה.`);
      } else {
        await q.neq("name", "dummy");
        return bot.sendMessage(chatId, `🫡 כל הדוח אופס.`);
      }
    }

    // --- עדכון סטטוס רגיל (רק למי שקיים!) ---
    if (ai.type === "update" && ai.updates) {
      let count = 0;
      for (let u of ai.updates) {
        let updateFields = { status: u.status, is_active: true };
        if (u.mission) updateFields.mission = u.mission;

        let q = supabase.from("soldiers").update(updateFields);
        if (u.name) q = q.ilike("name", `%${u.name.replace(/[-\s]/g, '%')}%`);
        else if (u.unit) q = q.eq("unit", u.unit);
        
        const { data } = await q.select();
        if (data) count += data.length;
      }
      if (count > 0) return bot.sendMessage(chatId, ai.text);
      else return bot.sendMessage(chatId, "🤔 לא מצאתי את השמות האלו במאגר. להוספה השתמש ב-***עדכון.");
    }

    // --- שיחה רגילה ---
    if (ai.type === "chat") {
      bot.sendMessage(chatId, ai.text);
    }

  } catch (e) {
    console.error("AI Logic Error:", e);
    bot.sendMessage(chatId, "הייתה לי תקלה בעיבוד. נסה שוב בעוד רגע.");
  }
});

// ==========================================
// פונקציית AI (Gemini)
// ==========================================
async function askAi(input, data, senderName) {
  const prompt = `אתה סמב"ץ פלוגתי בשם ג'מיני. המשתמש שפונה אליך: ${senderName}. 
  המאגר הקיים: ${JSON.stringify(data.map((s) => ({ name: s.name, unit: s.unit })))}.
  הודעה: "${input}". 

  חוקים:
  1. שינוי שם: אם מבקשים לשנות שם (למשל: "***שינוי שם א ל-ב"), החזר: {"type":"rename", "oldName":"א", "newName":"ב", "text":"משנה..."}.
  2. הוספה: אם מבקשים להוסיף מישהו (למשל: "***עדכון יוסי למחלקה 1"), החזר: {"type":"add", "name":"יוסי", "unit":"מחלקה 1", "text":"מוסיף..."}.
  3. איפוס: אם מבקשים לאפס, החזר: {"type":"reset", "unit":"ALL או שם מחלקה"}.
  4. עדכון: עבור הודעות רגילות, חפש במאגר. אם קיים, החזר: {"type":"update", "updates":[{"name":"שם", "status":"BASE/HOME", "mission":"משימה"}], "text":"אישור"}.
  5. אם השם לא קיים או שזו שיחה רגילה, החזר: {"type":"chat", "text":"תשובה ידידותית"}.

  החזר JSON בלבד!`;

  const postData = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
  const options = {
    hostname: "generativelanguage.googleapis.com",
    path: `/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_KEY}`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => {
        try {
          const jsonResponse = JSON.parse(b);
          let raw = jsonResponse.candidates[0].content.parts[0].text;
          const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
          resolve(JSON.parse(raw.substring(start, end + 1)));
        } catch (e) { resolve({ type: "chat", text: "לא הבנתי, נסה שוב." }); }
      });
    });
    req.write(postData);
    req.end();
  });
}

// ==========================================
// פונקציית יצירת הדוח
// ==========================================
function generateFixedReport(soldiers) {
  let r = "*סד''כ מחלקות* 🪖\n\n";
  
  // חישוב סיכום כללי
  const totalAll = soldiers.length;
  const totalBaseAll = soldiers.filter(s => s.status === "BASE").length;
  const totalHomeAll = soldiers.filter(s => s.status === "HOME").length;

  VALID_UNITS.forEach((u) => {
    const unitSolds = soldiers.filter(s => s.unit === u);
    r += `*${u}:*\n`;
    
    if (unitSolds.length === 0) {
      r += `${RLM}---\n\n`;
      return;
    }

    const inBase = unitSolds.filter(s => s.status === "BASE");
    const inHome = unitSolds.filter(s => s.status === "HOME");

    if (inBase.length > 0) r += `בבסיס (${inBase.length}):\n${inBase.map(s => s.name).join("\n")}\n\n`;
    if (inHome.length > 0) r += `בבית (${inHome.length}):\n${inHome.map(s => s.name).join("\n")}\n\n`;
    
    r += `סה"כ: ${inBase.length}/${unitSolds.length}.\n\n`;
  });

  r += "---------------------------------\n\n*שיבוץ משימות* ⚡️\n\n";
  const missions = ['חפ"ק מ"פ', 'חפ"ק סמ"פ', 'חפ"ק מ"מ 1', 'חפ"ק מ"מ 2', 'חפ"ק מ"מ 3', 'חפ"ק עתודה', 'משאית'];
  
  missions.forEach((m) => {
    const assigned = soldiers.filter(s => (s.mission || "").includes(m.replace(/['"״]/g, '')));
    r += `*${m}:*\n`;
    r += assigned.length > 0 ? `${assigned.map(s => s.name).join("\n")}\n\n` : `${RLM}---\n\n`;
  });

  r += "---------------------------------\n\n📊 *סיכום:*\n";
  r += `סה"כ: ${totalAll}.\nבבסיס: ${totalBaseAll}.\nבבית: ${totalHomeAll}.`;

  return r;
}
