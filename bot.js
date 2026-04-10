require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const https = require("https");
const cron = require("node-cron");

// משתני סביבה
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DEPLOYMENT_NAME = process.env.DEPLOYMENT_NAME || "שאגת הארי";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = `https://dvir-army-bot.onrender.com/bot${TELEGRAM_TOKEN}`;

// Webhook mode - אין polling, אין התנגשות בין instances
const bot = new TelegramBot(TELEGRAM_TOKEN, { webHook: { port: PORT } });

const VALID_UNITS = ['מפל"ג', "מחלקה 1", "מחלקה 2", "מחלקה 3", "חובשים"];
const RLM = "\u200f";

const GROUP_CHAT_ID = "-1003748361029";

// רישום Webhook וסרת health check
bot.setWebHook(WEBHOOK_URL).then(() => {
  console.log(`🚀 גרסה 62 באוויר - Webhook Mode | מבצע: ${DEPLOYMENT_NAME}`);
  console.log(`🔗 Webhook: ${WEBHOOK_URL}`);
}).catch(e => console.error("❌ Webhook setup failed:", e.message));

// ==========================================
// תזמון הודעות (Cron) - 18:00 שעון ישראל
// ==========================================
cron.schedule('0 18 * * 0,1,2,3,6', () => {
  if (GROUP_CHAT_ID) bot.sendMessage(GROUP_CHAT_ID, `⚠️ *תזכורת [${DEPLOYMENT_NAME}]:* נא לשלוח דוח 1 למחר!`, { parse_mode: "Markdown" });
}, { scheduled: true, timezone: "Asia/Jerusalem" });

cron.schedule('0 18 * * 4', () => {
  if (GROUP_CHAT_ID) bot.sendMessage(GROUP_CHAT_ID, `⚠️ *תזכורת סופ\"ש [${DEPLOYMENT_NAME}]:* נא לשלוח דוח 1 לשישי-שבת!`, { parse_mode: "Markdown" });
}, { scheduled: true, timezone: "Asia/Jerusalem" });

// ==========================================
// פונקציות עזר וזמן
// ==========================================
function getIsraelDate() {
  const now = new Date();
  const israelTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  return israelTime.toISOString().split('T')[0];
}

// ==========================================
// לוגיקת הודעות ושומר הסף
// ==========================================
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const senderName = msg.from.first_name || "מפקד";

  // פקודת ID תמיד עובדת
  if (text.startsWith("/id")) return bot.sendMessage(chatId, `ID: \`${chatId}\``);

  // --- חסימת צ'אט פרטי לכל מי שאינו המפקד ---
  const COMMANDER_ID = 434078287;
  const isPrivate = chatId > 0;
  if (isPrivate && chatId !== COMMANDER_ID) return;

  // --- שומר הסף ---
  const isGroup = chatId < 0;
  const isAsteriskStart = text.startsWith("*");
  const isFullReport = (text.includes("בבית:") || text.includes("בבסיס:")) && text.includes("\n");
  const isReportRequest = text.includes("דוח");
  const isSlashCommand = text.startsWith("/");

  const shouldProcess = isAsteriskStart || isFullReport || isReportRequest || isSlashCommand;

  if (isGroup && !shouldProcess) return;

  console.log(`\n📥 הודעה עברה סינון מ-${senderName}: "${text.substring(0, 30)}..."`);

  try {
    const { data: roster } = await supabase.from("soldiers").select("name, unit").eq("is_active", true);

    // ניקוי הכוכביות לפני השליחה ל-AI
    let cleanText = text;
    if (text.startsWith("***")) {
      cleanText = text.substring(3).trim();
    } else if (text.startsWith("*")) {
      cleanText = text.substring(1).trim();
    }

    console.log("🧠 פנייה ל-Gemini...");
    const ai = await askAi(cleanText, roster || [], senderName);
    console.log("🤖 תגובת ה-AI:", JSON.stringify(ai));

    const todayDate = getIsraelDate();

    // 0. איפוס דוח (Clear)
    if (ai.type === "clear") {
      const targetDate = ai.targetDate || todayDate;
      await supabase.from("report_data").delete().eq("report_date", targetDate);
      return bot.sendMessage(chatId, `🧹 **דוח 1 לתאריך ${targetDate} [${DEPLOYMENT_NAME}] אופס בהצלחה!**`, { parse_mode: "Markdown" });
    }

    // 1. עדכון גורף (Bulk)
    if (ai.type === "bulk_update") {
      let count = 0;
      const dates = (ai.dates && ai.dates.length > 0) ? ai.dates : [todayDate];
      const newStatus = ai.status || "BASE";

      for (const date of dates) {
        for (let s of (roster || [])) {
          if (ai.unit && ai.unit !== "all" && s.unit !== ai.unit) continue;
          await supabase.from("report_data").upsert({
            name: s.name, status: newStatus, mission: "ללא משימה", report_date: date, deployment_name: DEPLOYMENT_NAME
          }, { onConflict: 'name, report_date' });
          count++;
        }
      }
      return bot.sendMessage(chatId, `✅ עדכון גורף [${DEPLOYMENT_NAME}] בוצע ל-${count} חיילים עבור ${dates.join(", ")}.`);
    }

    // 2. עדכון רגיל (בודדים/רשימה)
    if (ai.type === "update" && ai.updates && ai.updates.length > 0) {
      let count = 0;
      let unknownNames = [];
      const dates = (ai.dates && ai.dates.length > 0) ? ai.dates : [todayDate];

      for (const date of dates) {
        for (let u of ai.updates) {
          const sInfo = (roster || []).find(s => s.name === u.name || s.name.includes(u.name) || u.name.includes(s.name));
          if (!sInfo) {
            if (!unknownNames.includes(u.name)) unknownNames.push(u.name);
            continue;
          }
          await supabase.from("report_data").upsert({
            name: sInfo.name, status: u.status || "BASE", mission: u.mission || "ללא משימה", report_date: date, deployment_name: DEPLOYMENT_NAME
          }, { onConflict: 'name, report_date' });
          count++;
        }
      }
      let resTxt = count > 0 ? `✅ העדכון נקלט ביומן [${DEPLOYMENT_NAME}] (${count} חיילים).` : "";
      if (unknownNames.length > 0) resTxt += `\n⚠️ שמות לא במצבת: ${unknownNames.join(", ")}`;
      if (resTxt) return bot.sendMessage(chatId, resTxt);
      return;
    }

    // 3. הצגת דוח
    if (ai.type === "show_report" || (text.includes("דוח") && ai.type === "chat")) {
      const targetDate = ai.targetDate || todayDate;
      const { data: dailyUpdates } = await supabase.from("report_data").select("*").eq("report_date", targetDate);

      const mergedData = (roster || []).map(soldier => {
        const update = (dailyUpdates || []).find(u => u.name === soldier.name);
        return {
          name: soldier.name, unit: soldier.unit,
          status: update ? update.status : "BASE", mission: update ? update.mission : "ללא משימה"
        };
      });

      let reportHeader = `🏕️ **מבצע: ${DEPLOYMENT_NAME}**\n`;
      return bot.sendMessage(chatId, reportHeader + generateFixedReport(mergedData, targetDate), { parse_mode: "Markdown" });
    }

    // 4. ניהול מצבת
    if (ai.type === "rename") {
      await supabase.from("soldiers").update({ name: ai.newName }).eq("name", ai.oldName);
      return bot.sendMessage(chatId, `✅ השם שונה ל-${ai.newName} במצבת.`);
    }
    if (ai.type === "add") {
      await supabase.from("soldiers").insert([{ name: ai.name, unit: ai.unit, is_active: true }]);
      return bot.sendMessage(chatId, `✅ ${ai.name} נוסף למצבת הקבועה.`);
    }

    if (ai.type === "chat" && !text.includes("דוח")) {
      bot.sendMessage(chatId, ai.text || "הפקודה לא הובנה, נסה שוב.");
    }

  } catch (e) {
    console.error("🔴 שגיאה:", e);
    bot.sendMessage(chatId, "הייתה שגיאה בעיבוד הפקודה.");
  }
});

// ==========================================
// פונקציות עזר - AI ועיצוב דוח
// ==========================================
async function askAi(input, data, senderName) {
  const todayStr = new Date().toLocaleDateString('he-IL');

  const prompt = `אתה סמב"ץ פלוגתי במבצע ${DEPLOYMENT_NAME}. היום יום ${new Date().toLocaleDateString('he-IL', {weekday: 'long'})}, התאריך: ${todayStr}.
המשתמש שכותב לך: ${senderName}.
מאגר השמות המורשה (soldiers): ${JSON.stringify([...new Set(data.map(s => s.name))])}.
משימות רשמיות: [חפ״ק מ״פ, חפ״ק סמ״פ, חפ״ק מ״מ 1, חפ״ק מ״מ 2, חפ״ק מ״מ 3, נהג משאית, מלווה נהג משאית].
מחלקות: [מפל״ג, מחלקה 1, מחלקה 2, מחלקה 3, חובשים].
הודעה מהמשתמש: "${input}".

חוקים קריטיים לזיהוי הפעולה (type):
1. "clear": איפוס, מחיקה או ניקוי דוח.
2. "bulk_update": עדכון גורף לפלוגה או מחלקה. (למשל: "כולם בבית", "כל מחלקה 2 בבסיס").
3. "show_report": הצגת הדוח הקיים. (למשל: "שלח דוח 1", "מה המצב מחר?").
4. "rename": שינוי שם של חייל קיים. חובה לחלץ "oldName" ו-"newName".
5. "add": הוספת חייל חדש למצבת. חובה לחלץ "name" ו-"unit".
6. "update": עדכון סטטוס לחייל בודד או רשימה.

חוקי תאריכים ותוכן:
- תאריכים: זהה "מחר", "יום ראשון", "07/04" והפוך ל-YYYY-MM-DD.
- סטטוס: "בבית" = HOME, "בבסיס" = BASE. אם לא צוין → BASE.
- משימות: אם צוינה משימה רשמית, השתמש בשם המדויק מהרשימה.

החזר JSON בלבד, ללא הקדמות:
{"type":"update/show_report/rename/add/clear/bulk_update/chat", "targetDate":"YYYY-MM-DD", "dates":["YYYY-MM-DD"], "unit":"all/שם מחלקה", "status":"BASE/HOME", "updates":[{"name":"שם מלא מהמאגר","status":"BASE/HOME","mission":"שם משימה רשמי או ללא משימה"}], "oldName":"...", "newName":"...", "name":"...", "text":"תשובה קצרה"}`;

  const postData = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" }
  });

  const MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash"];

  function tryModel(model) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
        method: "POST",
        headers: { "Content-Type": "application/json" }
      };
      const req = https.request(options, (res) => {
        let b = "";
        res.on("data", d => b += d);
        res.on("end", () => {
          try {
            const response = JSON.parse(b);
            if (response.error) return reject({ code: response.error.code, msg: response.error.message });
            if (response.candidates && response.candidates[0]) {
              const rawContent = response.candidates[0].content.parts[0].text;
              console.log(`📝 [${model}] תשובה:`, rawContent.substring(0, 80));
              const start = rawContent.indexOf("{");
              const end = rawContent.lastIndexOf("}");
              resolve(JSON.parse(rawContent.substring(start, end + 1)));
            } else {
              reject({ code: 0, msg: "no candidates: " + b.substring(0, 80) });
            }
          } catch (e) {
            reject({ code: 0, msg: e.message });
          }
        });
      });
      req.on("error", (e) => reject({ code: 0, msg: e.message }));
      req.write(postData);
      req.end();
    });
  }

  return new Promise(async (resolve) => {
    for (const model of MODELS) {
      try {
        const result = await tryModel(model);
        return resolve(result);
      } catch (e) {
        console.error(`⚠️ [${model}] נכשל (${e.code}): ${e.msg}`);
        if (e.code === 503 || e.code === 429) await new Promise(r => setTimeout(r, 1500));
      }
    }
    resolve({ type: "chat", text: "לא התקבלה תשובה מה-AI." });
  });
}

function generateFixedReport(soldiers, dateString) {
  const dateObj = new Date(dateString);
  const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const d = String(dateObj.getDate()).padStart(2, '0'), m = String(dateObj.getMonth() + 1).padStart(2, '0');

  let r = `**דוח כ"א ליום ${days[dateObj.getDay()]} ${d}.${m}**\n\n*סד''כ מחלקות* 🪖\n\n`;

  VALID_UNITS.forEach((u) => {
    const unitSolds = soldiers.filter(s => s.unit === u);
    r += `*${u}:*\n`;
    if (unitSolds.length === 0) { r += `${RLM}--- (אין חיילים רשומים)\n\n`; return; }
    const inB = unitSolds.filter(s => s.status === "BASE");
    const inH = unitSolds.filter(s => s.status === "HOME");
    if (inB.length > 0) r += `🏡 בבסיס (${inB.length}):\n${inB.map(s => s.name).join("\n")}\n\n`;
    if (inH.length > 0) r += `🏠 בבית (${inH.length}):\n${inH.map(s => s.name).join("\n")}\n\n`;
    r += `סה"כ: ${inB.length}/${unitSolds.length}.\n\n`;
  });

  r += "---------------------------------\n\n*שיבוץ משימות* ⚡️\n\n";
  const mis = ['חפ"ק מ"פ', 'חפ"ק סמ"פ', 'חפ"ק מ"מ 1', 'חפ"ק מ"מ 2', 'חפ"ק מ"מ 3', 'נהג משאית', 'מלווה נהג משאית'];
  mis.forEach(m => {
    const mClean = m.replace(/['"״]/g, '');
    const assigned = soldiers.filter(s => (s.mission || "").replace(/['"״]/g, '').includes(mClean));
    r += `*${m}:*\n${assigned.length > 0 ? assigned.map(s => s.name).join("\n") : RLM + "---"}\n\n`;
  });

  const bAll = soldiers.filter(s => s.status === "BASE").length, hAll = soldiers.filter(s => s.status === "HOME").length;
  r += `---------------------------------\n\n📊 *סיכום:*\nסה"כ: ${soldiers.length}.\nבבסיס: ${bAll}.\nבבית: ${hAll}.`;
  return r;
}
