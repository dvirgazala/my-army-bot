require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const https = require("https");
const cron = require("node-cron");

// משתני סביבה
const DEPLOYMENT_NAME = process.env.DEPLOYMENT_NAME || "שאגת הארי";
const COMMANDER_ID = 434078287;
const GROUP_CHAT_ID = "-1003748361029";
const VALID_UNITS = ['מפל"ג', "מחלקה 1", "מחלקה 2", "מחלקה 3", "חובשים"];
const MISSIONS = ['חפ"ק מ"פ', 'חפ"ק סמ"פ', 'חפ"ק מ"מ 1', 'חפ"ק מ"מ 2', 'חפ"ק מ"מ 3', 'נהג משאית', 'מלווה נהג משאית'];
const GEMINI_MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash"];
const RLM = "‏";

// ==========================================
// פונקציות עזר טהורות (ללא תופעות לוואי - ניתנות לבדיקה)
// ==========================================

// בריחת תווים ל-HTML parse_mode של טלגרם (מונע שגיאות "can't parse entities")
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// תאריך/יום נוכחיים לפי שעון ישראל - ללא תלות באזור הזמן של השרת
function israelNowParts() {
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(now); // YYYY-MM-DD
  const he = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem" }).format(now);    // dd.mm.yyyy
  const weekday = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", weekday: "long" }).format(now);
  return { date, he, weekday };
}

function getIsraelDate() {
  return israelNowParts().date;
}

// שומר הסף: אילו הודעות קבוצה עוברות לעיבוד
function passesGatekeeper(text) {
  const isAsteriskStart = text.startsWith("*");
  const isFullReport = (text.includes("בבית:") || text.includes("בבסיס:")) && text.includes("\n");
  const isReportRequest = text.includes("דוח");
  const isSlashCommand = text.startsWith("/");
  return isAsteriskStart || isFullReport || isReportRequest || isSlashCommand;
}

// התאמת שם מהודעה למצבת. מעדיף התאמה מדויקת; אחרת מחזיר את כל ההתאמות החלקיות
function matchSoldiers(roster, name) {
  const n = (name || "").trim();
  if (!n) return [];
  const exact = (roster || []).filter(s => s.name === n);
  if (exact.length === 1) return exact; // העדפת התאמה מדויקת יחידה - חוסך שאלת עמימות מיותרת
  return (roster || []).filter(s => s.name === n || s.name.includes(n) || n.includes(s.name));
}

// חילוץ אובייקט JSON מתוך תשובת טקסט של ה-AI
function parseAiText(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in response");
  return JSON.parse(raw.substring(start, end + 1));
}

// בניית הפרומפט ל-Gemini (תאריך/יום לפי שעון ישראל)
function buildPrompt(input, roster, senderName) {
  const { date: todayIso, he: todayStr, weekday } = israelNowParts();
  const names = [...new Set((roster || []).map(s => s.name))];

  return `אתה סמב"ץ פלוגתי במבצע ${DEPLOYMENT_NAME}. היום יום ${weekday}, התאריך: ${todayStr} (${todayIso}).
המשתמש שכותב לך: ${senderName}.
מאגר השמות המורשה (soldiers): ${JSON.stringify(names)}.
משימות רשמיות: ${JSON.stringify(MISSIONS)}.
מחלקות: ${JSON.stringify(VALID_UNITS)}.
הודעה מהמשתמש: "${input}".

חוקים קריטיים לזיהוי הפעולה (type):
1. "clear": איפוס, מחיקה או ניקוי דוח.
2. "bulk_update": עדכון גורף לפלוגה או מחלקה. (למשל: "כולם בבית", "כל מחלקה 2 בבסיס").
3. "show_report": הצגת הדוח הקיים. (למשל: "שלח דוח 1", "מה המצב מחר?").
4. "rename": שינוי שם של חייל קיים. חובה לחלץ "oldName" ו-"newName".
5. "add": הוספת חייל חדש למצבת. חובה לחלץ "name" ו-"unit".
6. "update": עדכון סטטוס לחייל בודד או רשימה.

חוקי תאריכים ותוכן:
- תאריכים: זהה "מחר", "יום ראשון", "07/04" והפוך ל-YYYY-MM-DD לפי התאריך של היום (${todayIso}).
- סטטוס: "בבית" = HOME, "בבסיס" = BASE. אם לא צוין → BASE.
- משימות: אם צוינה משימה רשמית, השתמש בשם המדויק מהרשימה.
- שמות: אם השם שנכתב תואם בדיוק לשם מלא במאגר - החזר אותו כמות שהוא. אם הוא חלקי (שם משפחה בלבד, שם פרטי בלבד) - החזר אותו בדיוק כפי שנכתב על ידי המשתמש, אל תשלים לשם מלא.

החזר JSON בלבד, ללא הקדמות:
{"type":"update/show_report/rename/add/clear/bulk_update/chat", "targetDate":"YYYY-MM-DD", "dates":["YYYY-MM-DD"], "unit":"all/שם מחלקה", "status":"BASE/HOME", "updates":[{"name":"השם כפי שנכתב","status":"BASE/HOME","mission":"שם משימה רשמי או ללא משימה"}], "oldName":"...", "newName":"...", "name":"...", "text":"תשובה קצרה"}`;
}

// עיצוב הדוח הקבוע (HTML)
function generateFixedReport(soldiers, dateString) {
  const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  // פירוק ידני של YYYY-MM-DD כדי להימנע מתלות באזור הזמן של השרת
  const [y, mo, dd] = dateString.split("-").map(Number);
  const dateObj = new Date(Date.UTC(y, mo - 1, dd));
  const d = String(dd).padStart(2, "0");
  const m = String(mo).padStart(2, "0");
  const dayName = days[dateObj.getUTCDay()];

  let r = `<b>דוח כ"א ליום ${dayName} ${d}.${m}</b>\n\n<b>סד''כ מחלקות</b> 🪖\n\n`;

  VALID_UNITS.forEach((u) => {
    const unitSolds = soldiers.filter(s => s.unit === u);
    r += `<b>${esc(u)}:</b>\n`;
    if (unitSolds.length === 0) { r += `${RLM}--- (אין חיילים רשומים)\n\n`; return; }
    const inB = unitSolds.filter(s => s.status === "BASE");
    const inH = unitSolds.filter(s => s.status === "HOME");
    if (inB.length > 0) r += `🏡 בבסיס (${inB.length}):\n${inB.map(s => esc(s.name)).join("\n")}\n\n`;
    if (inH.length > 0) r += `🏠 בבית (${inH.length}):\n${inH.map(s => esc(s.name)).join("\n")}\n\n`;
    r += `סה"כ: ${inB.length}/${unitSolds.length}.\n\n`;
  });

  r += "---------------------------------\n\n<b>שיבוץ משימות</b> ⚡️\n\n";
  MISSIONS.forEach(mis => {
    const mClean = mis.replace(/['"״]/g, "");
    const assigned = soldiers.filter(s => (s.mission || "").replace(/['"״]/g, "").includes(mClean));
    r += `<b>${esc(mis)}:</b>\n${assigned.length > 0 ? assigned.map(s => esc(s.name)).join("\n") : RLM + "---"}\n\n`;
  });

  const bAll = soldiers.filter(s => s.status === "BASE").length;
  const hAll = soldiers.filter(s => s.status === "HOME").length;
  r += `---------------------------------\n\n📊 <b>סיכום:</b>\nסה"כ: ${soldiers.length}.\nבבסיס: ${bAll}.\nבבית: ${hAll}.`;
  return r;
}

// ==========================================
// הרצת הבוט (תופעות לוואי) - רק כשמריצים את הקובץ ישירות
// ==========================================
function main() {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
  const GEMINI_KEY = process.env.GEMINI_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const PORT = process.env.PORT || 3000;

  // ולידציה - עצירה מיידית עם הודעה ברורה אם חסר מפתח
  const required = { TELEGRAM_TOKEN, GEMINI_KEY, SUPABASE_URL, SUPABASE_KEY };
  const missing = Object.keys(required).filter(k => !required[k]);
  if (missing.length > 0) {
    console.error(`❌ חסרים משתני סביבה הכרחיים: ${missing.join(", ")}. בדוק את קובץ ה-.env או את הגדרות Render.`);
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const WEBHOOK_URL = `https://dvir-army-bot.onrender.com/bot${TELEGRAM_TOKEN}`;

  // Webhook mode - אין polling, אין התנגשות בין instances
  const bot = new TelegramBot(TELEGRAM_TOKEN, { webHook: { port: PORT } });

  // זיכרון זמני לאישורים ממתינים (שם מעורפל). נמחק בהפעלה מחדש.
  const pendingConfirmations = new Map();

  // עטיפות בטוחות לשליחה/עריכה - תמיד HTML, ותמיד תופסות שגיאות
  function send(chatId, text, extra = {}) {
    return bot.sendMessage(chatId, text, { parse_mode: "HTML", ...extra })
      .catch(e => console.error("❌ שליחת הודעה נכשלה:", e.message));
  }
  function edit(text, extra = {}) {
    return bot.editMessageText(text, { parse_mode: "HTML", ...extra })
      .catch(e => console.error("❌ עריכת הודעה נכשלה:", e.message));
  }

  // כתיבת שורות ליומן הדיווחים בקריאה אחת (batch)
  async function upsertReports(rows) {
    if (rows.length === 0) return;
    const { error } = await supabase.from("report_data").upsert(rows, { onConflict: "name,report_date" });
    if (error) throw error;
  }

  // ----- פנייה ל-Gemini עם fallback בין מודלים -----
  async function askAi(input, roster, senderName) {
    const prompt = buildPrompt(input, roster, senderName);
    const postData = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    });

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
                resolve(parseAiText(rawContent));
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

    for (const model of GEMINI_MODELS) {
      try {
        return await tryModel(model);
      } catch (e) {
        console.error(`⚠️ [${model}] נכשל (${e.code}): ${e.msg}`);
        if (e.code === 503 || e.code === 429) await new Promise(r => setTimeout(r, 1500));
      }
    }
    return { type: "chat", text: "לא התקבלה תשובה מה-AI." };
  }

  // ----- רישום Webhook -----
  bot.setWebHook(WEBHOOK_URL).then(() => {
    console.log(`🚀 גרסה 63 באוויר - Webhook Mode | מבצע: ${DEPLOYMENT_NAME}`);
    console.log(`🔗 Webhook: ${WEBHOOK_URL}`);
  }).catch(e => console.error("❌ Webhook setup failed:", e.message));

  // ----- תזמון הודעות (Cron) - 18:00 שעון ישראל -----
  cron.schedule("0 18 * * 0,1,2,3,6", () => {
    send(GROUP_CHAT_ID, `⚠️ <b>תזכורת [${esc(DEPLOYMENT_NAME)}]:</b> נא לשלוח דוח 1 למחר!`);
  }, { scheduled: true, timezone: "Asia/Jerusalem" });

  cron.schedule("0 18 * * 4", () => {
    send(GROUP_CHAT_ID, `⚠️ <b>תזכורת סופ"ש [${esc(DEPLOYMENT_NAME)}]:</b> נא לשלוח דוח 1 לשישי-שבת!`);
  }, { scheduled: true, timezone: "Asia/Jerusalem" });

  // ==========================================
  // לוגיקת הודעות ושומר הסף
  // ==========================================
  bot.on("message", async (msg) => {
    if (!msg.text) return;
    const text = msg.text.trim();
    const chatId = msg.chat.id;
    const senderName = msg.from.first_name || "מפקד";

    // פקודת ID תמיד עובדת
    if (text.startsWith("/id")) return send(chatId, `ID: <code>${chatId}</code>`);

    // --- חסימת צ'אט פרטי לכל מי שאינו המפקד ---
    const isPrivate = chatId > 0;
    if (isPrivate && chatId !== COMMANDER_ID) return;

    // --- טיפול באישור ממתין (fallback טקסט, לא בשימוש רגיל) ---
    if (pendingConfirmations.has(chatId)) {
      pendingConfirmations.delete(chatId); // ביטול - המשך לעיבוד רגיל
    }

    // --- שומר הסף ---
    const isGroup = chatId < 0;
    if (isGroup && !passesGatekeeper(text)) return;

    console.log(`\n📥 הודעה עברה סינון מ-${senderName}: "${text.substring(0, 30)}..."`);

    try {
      const { data: roster } = await supabase.from("soldiers").select("name, unit").eq("is_active", true);
      const rosterList = roster || [];

      // ניקוי הכוכביות לפני השליחה ל-AI
      let cleanText = text;
      if (text.startsWith("***")) {
        cleanText = text.substring(3).trim();
      } else if (text.startsWith("*")) {
        cleanText = text.substring(1).trim();
      }

      console.log("🧠 פנייה ל-Gemini...");
      const ai = await askAi(cleanText, rosterList, senderName);
      console.log("🤖 תגובת ה-AI:", JSON.stringify(ai));

      const todayDate = getIsraelDate();

      // 0. איפוס דוח (Clear)
      if (ai.type === "clear") {
        const targetDate = ai.targetDate || todayDate;
        await supabase.from("report_data").delete().eq("report_date", targetDate);
        return send(chatId, `🧹 <b>דוח 1 לתאריך ${targetDate} [${esc(DEPLOYMENT_NAME)}] אופס בהצלחה!</b>`);
      }

      // 1. עדכון גורף (Bulk)
      if (ai.type === "bulk_update") {
        const dates = (ai.dates && ai.dates.length > 0) ? ai.dates : [todayDate];
        const newStatus = ai.status || "BASE";
        const rows = [];
        for (const date of dates) {
          for (const s of rosterList) {
            if (ai.unit && ai.unit !== "all" && s.unit !== ai.unit) continue;
            rows.push({ name: s.name, status: newStatus, mission: "ללא משימה", report_date: date, deployment_name: DEPLOYMENT_NAME });
          }
        }
        await upsertReports(rows);
        return send(chatId, `✅ עדכון גורף [${esc(DEPLOYMENT_NAME)}] בוצע ל-${rows.length} חיילים עבור ${esc(dates.join(", "))}.`);
      }

      // 2. עדכון רגיל (בודדים/רשימה)
      if (ai.type === "update" && ai.updates && ai.updates.length > 0) {
        const dates = (ai.dates && ai.dates.length > 0) ? ai.dates : [todayDate];
        const ready = [];          // התאמה ייחודית - מוכן לעדכון
        const ambiguous = [];      // מספר התאמות - צריך בחירה
        const unknownNames = [];

        for (const u of ai.updates) {
          const matches = matchSoldiers(rosterList, u.name);
          if (matches.length > 1) {
            ambiguous.push({ originalName: u.name, matches, status: u.status || "BASE", mission: u.mission || "ללא משימה" });
          } else if (matches.length === 1) {
            ready.push({ sInfo: matches[0], status: u.status || "BASE", mission: u.mission || "ללא משימה" });
          } else {
            unknownNames.push(u.name);
          }
        }

        // יש שמות מעורפלים - שמור הכל ושאל על הראשון
        if (ambiguous.length > 0) {
          pendingConfirmations.set(chatId, { ready, ambiguous, resolved: [], dates, unknownNames });
          const first = ambiguous[0];
          const keyboard = first.matches.map((s, i) => [{ text: s.name, callback_data: `amb_${chatId}_${i}` }]);
          return send(chatId, `❓ <b>"${esc(first.originalName)}" - איזה מהם?</b>`, { reply_markup: { inline_keyboard: keyboard } });
        }

        // אין עמימות - עדכן ישירות (batch)
        const rows = [];
        for (const date of dates) {
          for (const item of ready) {
            rows.push({ name: item.sInfo.name, status: item.status, mission: item.mission, report_date: date, deployment_name: DEPLOYMENT_NAME });
          }
        }
        await upsertReports(rows);

        let resTxt = ready.length > 0 ? `✅ העדכון נקלט ביומן [${esc(DEPLOYMENT_NAME)}] (${ready.length} חיילים).` : "";
        if (unknownNames.length > 0) resTxt += `\n⚠️ שמות לא במצבת: ${esc(unknownNames.join(", "))}`;
        if (resTxt) return send(chatId, resTxt);
        return;
      }

      // 3. הצגת דוח
      if (ai.type === "show_report" || (text.includes("דוח") && ai.type === "chat")) {
        const targetDate = ai.targetDate || todayDate;
        const { data: dailyUpdates } = await supabase.from("report_data").select("*").eq("report_date", targetDate);

        const mergedData = rosterList.map(soldier => {
          const update = (dailyUpdates || []).find(u => u.name === soldier.name);
          return {
            name: soldier.name, unit: soldier.unit,
            status: update ? update.status : "BASE", mission: update ? update.mission : "ללא משימה"
          };
        });

        const reportHeader = `🏕️ <b>מבצע: ${esc(DEPLOYMENT_NAME)}</b>\n`;
        return send(chatId, reportHeader + generateFixedReport(mergedData, targetDate));
      }

      // 4. ניהול מצבת
      if (ai.type === "rename") {
        await supabase.from("soldiers").update({ name: ai.newName }).eq("name", ai.oldName);
        return send(chatId, `✅ השם שונה ל-${esc(ai.newName)} במצבת.`);
      }
      if (ai.type === "add") {
        await supabase.from("soldiers").insert([{ name: ai.name, unit: ai.unit, is_active: true }]);
        return send(chatId, `✅ ${esc(ai.name)} נוסף למצבת הקבועה.`);
      }

      if (ai.type === "chat" && !text.includes("דוח")) {
        send(chatId, esc(ai.text || "הפקודה לא הובנה, נסה שוב."));
      }

    } catch (e) {
      console.error("🔴 שגיאה:", e);
      send(chatId, "הייתה שגיאה בעיבוד הפקודה.");
    }
  });

  // ==========================================
  // טיפול בלחיצה על כפתור (Inline Keyboard)
  // ==========================================
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (!data.startsWith("amb_")) return bot.answerCallbackQuery(query.id);

    const parts = data.split("_");
    const idx = parseInt(parts[parts.length - 1]);

    if (!pendingConfirmations.has(chatId)) {
      return bot.answerCallbackQuery(query.id, { text: "הפעולה פגה תוקף, שלח שוב." });
    }

    const pending = pendingConfirmations.get(chatId);
    const current = pending.ambiguous[0];

    if (isNaN(idx) || idx < 0 || idx >= current.matches.length) {
      return bot.answerCallbackQuery(query.id, { text: "בחירה לא תקינה." });
    }

    // פתור את השאלה הנוכחית
    const sInfo = current.matches[idx];
    pending.resolved.push({ sInfo, status: current.status, mission: current.mission });
    pending.ambiguous.shift();

    // יש עוד שאלות?
    if (pending.ambiguous.length > 0) {
      const next = pending.ambiguous[0];
      const keyboard = next.matches.map((s, i) => [{ text: s.name, callback_data: `amb_${chatId}_${i}` }]);
      await edit(`✅ <b>${esc(sInfo.name)}</b> נבחר.\n\n❓ <b>"${esc(next.originalName)}" - איזה מהם?</b>`, {
        chat_id: chatId, message_id: query.message.message_id,
        reply_markup: { inline_keyboard: keyboard }
      });
      return bot.answerCallbackQuery(query.id);
    }

    // כל השאלות נפתרו - עדכן הכל (batch)
    pendingConfirmations.delete(chatId);
    const allItems = [...pending.ready, ...pending.resolved];

    try {
      const rows = [];
      for (const date of pending.dates) {
        for (const item of allItems) {
          rows.push({ name: item.sInfo.name, status: item.status, mission: item.mission, report_date: date, deployment_name: DEPLOYMENT_NAME });
        }
      }
      await upsertReports(rows);

      let confirmText = `✅ <b>${allItems.length} חיילים עודכנו בהצלחה.</b>`;
      if (pending.unknownNames.length > 0) confirmText += `\n⚠️ שמות לא במצבת: ${esc(pending.unknownNames.join(", "))}`;
      await edit(confirmText, { chat_id: chatId, message_id: query.message.message_id });
      bot.answerCallbackQuery(query.id);
    } catch (e) {
      console.error("🔴 שגיאה ב-callback:", e);
      bot.answerCallbackQuery(query.id, { text: "הייתה שגיאה." });
    }
  });
}

// ייצוא פונקציות טהורות לצורכי בדיקה
module.exports = {
  esc, getIsraelDate, israelNowParts, passesGatekeeper,
  matchSoldiers, parseAiText, buildPrompt, generateFixedReport,
  VALID_UNITS, MISSIONS
};

if (require.main === module) main();
