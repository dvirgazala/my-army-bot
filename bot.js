require("dotenv").config(); // מושך את המפתחות מקובץ ה-.env אצלך במחשב
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const https = require("https");
const http = require("http"); // שרת דמה ל-Render

// המפתחות נמשכים כעת ממשתני הסביבה - שום סוד לא כתוב בקוד!
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!TELEGRAM_TOKEN || !GEMINI_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "❌ שגיאה: חסרים מפתחות! ודא שהגדרת אותם בקובץ .env או ב-Render.",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const VALID_UNITS = ['מפל"ג', "מחלקה 1", "מחלקה 2", "מחלקה 3", "חובשים"];
const RLM = "\u200f";

// ==========================================
// שרת דמה - שומר על הבוט ער ב-Render
// ==========================================
http
  .createServer((req, res) => {
    res.write("Bot is running securely!");
    res.end();
  })
  .listen(process.env.PORT || 3000);

console.log("🚀 בוט סמב''ץ גרסה מוכנה לשרת (מאובטחת)...");

// ==========================================
// לוגיקת הבוט (זהה לגרסה 35 בדיוק)
// ==========================================
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const senderName = msg.from.first_name || "מפקד";
  const senderId = msg.from.id; // אנחנו שומרים גם את ה-ID למקרה שנרצה לעשות הרשאות בעתיד

  const isReport = ["דוח", "מצב", "תמונה", "סיכום", "סטטוס"].some((k) =>
    text.includes(k),
  );
  const isResetCommand = ["איפוס", "תאפס", "לאפס", "נקה", "לאפס את"].some((k) =>
    text.includes(k),
  );

  if (isReport && !isResetCommand) {
    const { data } = await supabase
      .from("soldiers")
      .select("*")
      .eq("is_active", true);
    return bot.sendMessage(chatId, generateFixedReport(data || []), {
      parse_mode: "Markdown",
    });
  }

  if (text.includes(":")) {
    const lines = text.split("\n");
    let currentUnit = "";
    let toInsert = [];
    for (let line of lines) {
      let l = line.trim();
      if (!l) continue;
      if (l.includes(":")) {
        currentUnit = l.replace(":", "").trim().replace(/''/g, '"');
      } else if (currentUnit) {
        toInsert.push({
          name: l,
          unit: currentUnit,
          status: "BASE",
          mission: "ללא משימה",
          is_active: false,
        });
      }
    }
    if (toInsert.length > 0) {
      await supabase.from("soldiers").upsert(toInsert, { onConflict: "name" });
      return bot.sendMessage(
        chatId,
        `✅ המאגר עודכן! ${toInsert.length} חיילים נשמרו.`,
      );
    }
  }

  try {
    const { data: allSoldiers } = await supabase.from("soldiers").select("*");
    const ai = await askAi(text, allSoldiers || [], senderName);

    if (ai.type === "reset") {
      let q = supabase.from("soldiers").update({
        is_active: false,
        status: "BASE",
        mission: "ללא משימה",
      });

      if (ai.unit && ai.unit !== "ALL") {
        const unitSearch = ai.unit.replace(/''/g, '"');
        q = q.eq("unit", unitSearch);
        await q;
        return bot.sendMessage(
          chatId,
          `🫡 הכותרת של **${ai.unit}** נשמרה, אבל כל השמות אופסו בהצלחה.`,
          { parse_mode: "Markdown" },
        );
      } else {
        q = q.neq("name", "dummy");
        await q;
        return bot.sendMessage(
          chatId,
          `🫡 כל הדוח (כל המחלקות) אופס בהצלחה. השמות שמורים בענן.`,
        );
      }
    }

    if (ai.type === "update" && ai.updates) {
      let count = 0;
      for (let u of ai.updates) {
        let updateFields = { status: u.status, is_active: true };
        updateFields.mission = u.mission || "ללא משימה";

        let q = supabase.from("soldiers").update(updateFields);

        if (u.name) {
          const cleanName = u.name.replace(/[-\s]/g, "%");
          q = q.ilike("name", `%${cleanName}%`);
        } else if (u.unit && u.unit !== "ALL") {
          const unitSearch = u.unit.replace(/''/g, '"');
          q = q.eq("unit", unitSearch);
        }

        const { data } = await q.select();
        if (data) count += data.length;
      }
      bot.sendMessage(
        chatId,
        count > 0 ? ai.text : "🤔 לא מצאתי את השם הזה במאגר.",
      );
    } else {
      if (ai.type !== "reset") bot.sendMessage(chatId, ai.text || "אני כאן.");
    }
  } catch (e) {
    console.error("AI Catch Error:", e);
    bot.sendMessage(
      chatId,
      "שגיאה בעיבוד הנתונים. יתכן שיש עומס על שרתי ה-AI כרגע.",
    );
  }
});

async function askAi(input, data, senderName) {
  const prompt = `אתה סמב"ץ פלוגתי. המאגר: ${JSON.stringify(data.map((s) => ({ name: s.name, unit: s.unit })))}.
  המשתמש שפונה אליך כרגע קוראים לו: ${senderName}.
  הודעה: "${input}". 
  
  חוקים:
  1. עדכון: אם החייל במשימה, status: "BASE". משימות: חפ"ק מ"פ, חפ"ק סמ"פ, חפ"ק מ"מ 1, חפ"ק מ"מ 2, חפ"ק מ"מ 3, חפ"ק עתודה, נהג משאית, מלווה נהג משאית. החזר: {"type":"update", "updates":[{"name":"שם", "status":"BASE/HOME", "mission":"שם משימה"}], "text":"אישור קצר וידידותי שפונה למשתמש בשמו"}.
  2. איפוס חכם: אם המשתמש מבקש לאפס (מילים כמו "תאפס", "לאפס", "איפוס", "נקה"):
     - אם הוא אומר "את הכל", "את דוח 1", "הדוח כולו" -> החזר {"type":"reset", "unit":"ALL"}
     - אם הוא אומר "את מחלקה X" -> החזר {"type":"reset", "unit":"שם המחלקה המדויק"}
  3. אם זו שיחה רגילה, החזר {"type":"chat", "text":"תשובה ידידותית שכוללת את שם המשתמש"}
  
  החזר JSON תקין בלבד!`;

// ... המשך הפונקציה נשאר בדיוק אותו דבר ...

  const postData = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
  });
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
          if (jsonResponse.error) {
            console.error("Google API Error:", jsonResponse.error.message);
            return resolve({ type: "chat", text: "שגיאת תקשורת מול גוגל." });
          }
          let raw = jsonResponse.candidates[0].content.parts[0].text;
          const start = raw.indexOf("{"),
            end = raw.lastIndexOf("}");
          if (start !== -1) raw = raw.substring(start, end + 1);
          resolve(JSON.parse(raw));
        } catch (e) {
          resolve({
            type: "chat",
            text: "לא הצלחתי להבין את הפקודה (כנראה ה-AI החזיר פורמט לא תקין).",
          });
        }
      });
    });
    req.write(postData);
    req.end();
  });
}

function generateFixedReport(soldiers) {
  let r = "*סד''כ מחלקות* 🪖\n\n";

  VALID_UNITS.forEach((u) => {
    const unitSolds = soldiers.filter(
      (s) => s.unit === u || s.unit === u.replace('"', "''"),
    );
    r += `*${u}:*\n`;

    if (unitSolds.length === 0) {
      r += `${RLM}---\n\n`;
      return;
    }

    const inBase = unitSolds.filter((s) => s.status === "BASE");
    const inHome = unitSolds.filter((s) => s.status === "HOME");

    if (inBase.length > 0) {
      r += `בבסיס (${inBase.length}):\n${inBase.map((s) => s.name).join("\n")}\n\n`;
    }
    if (inHome.length > 0) {
      r += `בבית (${inHome.length}):\n${inHome.map((s) => s.name).join("\n")}\n\n`;
    }
    if (inBase.length === 0 && inHome.length === 0) {
      r += `${RLM}---\n\n`;
    }

    r += `*סה"כ: ${inBase.length}/${unitSolds.length}.*\n\n`;
  });

  r += "---------------------------------\n\n*שיבוץ משימות* ⚡\n\n";
  const missions = [
    { k: 'חפ"ק מ"פ', l: 'חפ"ק מ"פ' },
    { k: 'חפ"ק סמ"פ', l: 'חפ"ק סמ"פ' },
    { k: 'חפ"ק מ"מ 1', l: 'חפ"ק מ"מ 1' },
    { k: 'חפ"ק מ"מ 2', l: 'חפ"ק מ"מ 2' },
    { k: 'חפ"ק מ"מ 3', l: 'חפ"ק מ"מ 3' },
    { k: 'חפ"ק עתודה', l: 'חפ"ק עתודה' },
    { k: "משאית", l: "משאית" },
  ];

  missions.forEach((m) => {
    let assigned;
    if (m.k === "משאית") {
      assigned = soldiers.filter(
        (s) =>
          (s.mission || "").includes("משאית") ||
          (s.mission || "").includes("נהג"),
      );
    } else {
      const mKey = m.k.replace(/['"״]/g, "").trim();
      assigned = soldiers.filter((s) => {
        const sMission = (s.mission || "").replace(/['"״]/g, "").trim();
        return sMission === mKey;
      });
    }

    r += `*${m.l}:*\n`;
    r +=
      assigned.length > 0
        ? `${assigned.map((s) => s.name).join("\n")}\n\n`
        : `${RLM}---\n\n`;
  });

  const totalBase = soldiers.filter((s) => s.status === "BASE").length;
  const totalHome = soldiers.filter((s) => s.status === "HOME").length;
  r += `---------------------------------\n\n*📊 סיכום:*\n*בבסיס: ${totalBase}.*\n*בבית: ${totalHome}.*`;
  return r;
}
