require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const https = require("https");
const http = require("http");
const cron = require("node-cron");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENQUARRY_KEY = process.env.OPENQUARRY_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
// שם המבצע - ניתן לשינוי ב-Render תחת DEPLOYMENT_NAME
const DEPLOYMENT_NAME = process.env.DEPLOYMENT_NAME || "שאגת הארי";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const VALID_UNITS = ['מפל"ג', "מחלקה 1", "מחלקה 2", "מחלקה 3", "חובשים"];
const RLM = "\u200f";

http.createServer((req, res) => { res.write(`Bot V60.1 Active - Deployment: ${DEPLOYMENT_NAME}`); res.end(); }).listen(process.env.PORT || 3000);

const GROUP_CHAT_ID = "-1003748361029"; 

console.log(`🚀 גרסה 60.1 - מבצע: ${DEPLOYMENT_NAME} | מופעל באמצעות Minimax (OpenQuarry)`);

// ==========================================
// תזמון הודעות (Cron)
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
  const israelTime = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Jerusalem"}));
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

  if (text.startsWith("/id")) return bot.sendMessage(chatId, `ID: \`${chatId}\``);

  // --- שומר הסף (חוק הכוכבית / דוח מלא) ---
  const isGroup = chatId < 0; 
  const isAsteriskStart = text.startsWith("*");
  const isFullReport = (text.includes("בבית:") || text.includes("בבסיס:")) && text.includes("\n");
  const isSlashCommand = text.startsWith("/");

  if (isGroup && !isAsteriskStart && !isFullReport && !isSlashCommand) return; 

  console.log(`\n📥 הודעה עברה סינון מ-${senderName}: "${text.substring(0, 30)}..."`);

  try {
    const { data: roster } = await supabase.from("soldiers").select("name, unit").eq("is_active", true);
    
    let cleanText = text;
    if (text.startsWith("***")) {
        cleanText = text.substring(3).trim();
    } else if (text.startsWith("*")) {
        cleanText = text.substring(1).trim();
    }
    
    const ai = await askAi(cleanText, roster || [], senderName);
    console.log("🤖 תגובת ה-AI:", JSON.stringify(ai));

    const todayDate = getIsraelDate();

    // 0. איפוס דוח (Clear)
    if (ai.type === "clear") {
      const targetDate = ai.targetDate || todayDate;
      await supabase.from("report_data").delete().eq("report_date", targetDate);
      return bot.sendMessage(chatId, `🧹 **דוח 1 לתאריך ${targetDate} [${DEPLOYMENT_NAME}] אופס בהצלחה!**`);
    }

    // 1. עדכון גורף (Bulk Update)
    if (ai.type === "bulk_update") {
      let count = 0;
      const dates = (ai.dates && ai.dates.length > 0) ? ai.dates : [todayDate];
      const newStatus = ai.status || "BASE";

      for (const date of dates) {
        for (let soldier of roster) {
          if (ai.unit && ai.unit !== "all" && soldier.unit !== ai.unit) continue;
          await supabase.from("report_data").upsert({
            name: soldier.name, status: newStatus, mission: "ללא משימה", report_date: date, deployment_name: DEPLOYMENT_NAME
          }, { onConflict: 'name, report_date' });
          count++;
        }
      }
      return bot.sendMessage(chatId, `✅ עדכון גורף [${DEPLOYMENT_NAME}] בוצע ל-${count} חיילים.`);
    }

    // 2. עדכון רגיל (בודדים/רשימה)
    if (ai.type === "update" && ai.updates && ai.updates.length > 0) {
      let count = 0;
      let unknownNames = []; 
      const dates = (ai.dates && ai.dates.length > 0) ? ai.dates : [todayDate];

      for (const date of dates) {
        for (let u of ai.updates) {
          const soldierInfo = (roster || []).find(s => s.name === u.name || s.name.includes(u.name) || u.name.includes(s.name));
          if (!soldierInfo) {
            if (!unknownNames.includes(u.name)) unknownNames.push(u.name);
            continue; 
          }
          await supabase.from("report_data").upsert({
            name: soldierInfo.name, 
            status: u.status || "BASE", 
            mission: u.mission || "ללא משימה", 
            report_date: date, 
            deployment_name: DEPLOYMENT_NAME
          }, { onConflict: 'name, report_date' });
          count++;
        }
      }
      let resTxt = count > 0 ? `✅ העדכון נקלט ביומן [${DEPLOYMENT_NAME}] (${count} חיילים).` : "";
      if (unknownNames.length > 0) resTxt += `\n⚠️ שמות לא במצבת: ${unknownNames.join(", ")}`;
      return bot.sendMessage(chatId, resTxt);
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
      return bot.sendMessage(chatId, `✅ השם שונה ל-${ai.newName}.`);
    }
    if (ai.type === "add") {
      await supabase.from("soldiers").insert([{ name: ai.name, unit: ai.unit, is_active: true }]);
      return bot.sendMessage(chatId, `✅ ${ai.name} נוסף למצבת.`);
    }

  } catch (e) { console.error("🔴 שגיאה:", e); }
});

// ==========================================
// פונקציות עזר 
// ==========================================
async function askAi(input, data, senderName) {
  const todayStr = new Date().toLocaleDateString('he-IL');
  const prompt = `אתה סמב"ץ פלוגתי. היום: ${todayStr}.
מאגר חיילים: ${JSON.stringify([...new Set(data.map(s => s.name))])}.
משימות רשמיות: ["חפ\\"ק מ\\"פ","חפ\\"ק סמ\\"פ","חפ\\"ק מ\\"מ 1","חפ\\"ק מ\\"מ 2","חפ\\"ק מ\\"מ 3","נהג משאית","מלווה נהג משאית"].
מחלקות: ["מפל\\"ג","מחלקה 1","מחלקה 2","מחלקה 3","חובשים"].
הודעה: "${input}".
חוקים: אם חייל "בבית" → status=HOME. אם "בבסיס" → status=BASE. אם לא צוין → status=BASE. מלא תאריך מדויק לפי היום (YYYY-MM-DD). "מחר"=יום אחרי היום. "סופשב"=שישי ושבת.
JSON בלבד: {"type":"update/show_report/rename/add/clear/bulk_update/chat", "targetDate":"YYYY-MM-DD", "dates":["YYYY-MM-DD"], "unit":"all/שם מחלקה", "status":"BASE/HOME", "updates":[{"name":"שם מלא מהמאגר","status":"BASE/HOME","mission":"שם משימה רשמי או ללא משימה"}], "text":"..."}`;

  const postData = JSON.stringify({
    model: "minimax/minimax-m2.5:free",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const options = {
    hostname: "openrouter.ai",
    path: "/api/v1/chat/completions",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENQUARRY_KEY}`,
      "HTTP-Referer": "https://render.com",
      "X-Title": "Lion-Bot"
    }
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let b = "";
      res.on("data", d => b += d);
      res.on("end", () => {
        try {
          const json = JSON.parse(b);
          if (!json.choices || json.choices.length === 0) throw new Error("No choices in AI response");
          const raw = json.choices[0].message.content;
          resolve(JSON.parse(raw.substring(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
        } catch (e) {
          console.error("❌ AI Error:", b);
          resolve({ type: "chat" });
        }
      });
    });
    req.on("error", (e) => {
      console.error("❌ Request Error:", e);
      resolve({ type: "chat" });
    });
    req.write(postData);
    req.end();
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
    if (unitSolds.length === 0) {
      r += `${RLM}--- (אין חיילים רשומים)\n\n`;
      return;
    }
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
