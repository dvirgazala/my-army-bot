require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const cron = require("node-cron");
const https = require("https");

// ==========================================
// קבועים
// ==========================================
const DEPLOYMENT_NAME = process.env.DEPLOYMENT_NAME || "תע״מ בחן 2026";
const COMMANDER_ID = 434078287;
const GROUP_CHAT_ID = "-1003748361029";
const RLM = "‏";

// מחלקות - סדר התצוגה בדוח. מסופחים משויכים למחלקה שתחתיה הם נמצאים; חובשים נפרדים.
const VALID_UNITS = ['מפל"ג', "מחלקה 1", "מחלקה 2", "מחלקה 3", "חובשים", 'חמ"ל'];

// משימות רשמיות (מתוך "תקן יומי בחן")
const MISSIONS = [
  'חפ"ק מ"פ', 'חפ"ק סמ"פ', "רספ", 'פ"פ', "קצין מוצב", 'ש"ג 4-8',
  "סיור 1", "סיור 2", "כרמל", "חובש פלוגתי", "עמדת בת חפר",
  "תורן לוגיסטיקה", "תורן רחפן", "נהג תורן", 'חמ"ל'
];

// מילות סטטוס
const HOME_WORDS = ["בבית", "הביתה", "בביתה", "הבייתה", "בייתה", "בית", "גימלים", "גימלמים", "גימל", "גימלת", "חופש", "חופשי", "חופשה", "שוחרר", "שוחררה", "יצא", "יצאה", "יוצא", "יוצאת"];
const BASE_WORDS = ["בבסיס", "בסיס", "בקו", "קו", "נוכח", "נוכחת", "נמצא", "פה", "פלוגה", "חזר", "חזרה", "נכנס", "נכנסה", "עלה", "עלתה", "הגיע", "הגיעה"];
const CLEAR_WORDS = ["אפס", "תאפס", "לאפס", "נקה", "תנקה", "אפסי", "מחק", "תמחק", "איפוס", "רענן"];

const DOW = { "ראשון": 0, "שני": 1, "שלישי": 2, "רביעי": 3, "חמישי": 4, "שישי": 5, "שבת": 6 };
const DAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

// מילים מבניות/פקודה/מילוי - לא שמות של חיילים
const STOP_WORDS = new Set(["דוח", 'דו"ח', "שלח", "הצג", "מצב", "המצב", "סטטוס", "את", "של", "גם", "הוא", "היא",
  "כל", "כולם", "כולן", "הפלוגה", "פלוגה", "לכל", "מחלקה", "יום", "היום", "מחר", "מחרתיים", "אתמול", "ה", "ו", "ל", "ב",
  "נשאר", "נשארת", "נשארה", "מגיע", "מגיעה", "בא", "באה", "יודע", "מתי", "מסדר", "טוב", "בוקר", "ערב", "לא", "יהיה", "תהיה", "היה", "לבסיס", "לקו"]);

// גבול מילה עברי (JS \b לא עובד על עברית)
function hw(text, word) {
  const w = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[^א-ת])" + w + "($|[^א-ת])").test(text);
}

// ==========================================
// פונקציות עזר טהורות
// ==========================================
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function stripPunct(s) {
  return String(s == null ? "" : s).replace(/["'`״׳]/g, "").replace(/[.,:;!?]+/g, " ").replace(/\s+/g, " ").trim();
}

// נרמול עברי: הסרת גרשיים/מקף + איחוד אותיות סופיות
const FINALS = { "ם": "מ", "ן": "נ", "ך": "כ", "ף": "פ", "ץ": "צ" };
function hebNorm(s) {
  return String(s == null ? "" : s).replace(/['"`״׳().\-־]/g, "").replace(/[םןךףץ]/g, c => FINALS[c]).replace(/\s+/g, " ").trim();
}
// "שלד" השם: הסרת אותיות אם-קריאה (א/ה/ו/י) לזיהוי גרסאות כתיב (עומרי≈עמרי)
function hebSkel(s) { return hebNorm(s).replace(/[אהוי]/g, ""); }

// כינויים נפוצים → שם קנוני
const NICKNAMES = {
  "דימה": "דמיטרי", "דימי": "דמיטרי", "אלכס": "אלכסנדר", "סשה": "אלכסנדר",
  "יוני": "יהונתן", "יונתן": "יהונתן", "מישה": "מיכאל", "מיקי": "מיכאל",
  "דודו": "דוד", "קובי": "יעקב", "איציק": "יצחק", "צחי": "יצחק",
  "מוטי": "מרדכי", "אבי": "אברהם", "בני": "בנימין", "רפי": "רפאל", "גבי": "גבריאל"
};

// מרחק עריכה ≤ 1 (הוספה/מחיקה/החלפה בודדת)
function editLE1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
  }
  if (i < la || j < lb) edits++;
  return edits <= 1;
}

function israelNowParts() {
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(now);
  const he = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem" }).format(now);
  return { date, he };
}
function getIsraelDate() { return israelNowParts().date; }

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function nextWeekday(iso, dow) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const diff = (dow - dt.getUTCDay() + 7) % 7;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}

// זיהוי תאריך מתוך טקסט → YYYY-MM-DD (ברירת מחדל: היום)
function resolveDate(text, todayIso) {
  const t = text;
  if (/מחרתיים/.test(t)) return addDays(todayIso, 2);
  if (hw(t, "מחר")) return addDays(todayIso, 1);
  if (hw(t, "אתמול")) return addDays(todayIso, -1);
  if (hw(t, "היום")) return todayIso;
  for (const [name, dow] of Object.entries(DOW)) {
    if (t.includes("יום " + name) || new RegExp("ב" + name + "(?![א-ת])").test(t)) return nextWeekday(todayIso, dow);
  }
  const m = t.match(/\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/);
  if (m) {
    let d = +m[1], mo = +m[2], y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : +todayIso.slice(0, 4);
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return todayIso;
}

// הסרת ביטויי תאריך מהטקסט (כדי שלא יתפרשו כשמות)
function stripDates(text) {
  return text
    .replace(/מחרתיים/g, " ")
    .replace(/מחר/g, " ")
    .replace(/אתמול/g, " ")
    .replace(/היום/g, " ")
    .replace(/יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/g, " ")
    .replace(/ב(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)(?![א-ת])/g, " ")
    .replace(/\d{1,2}[\/.]\d{1,2}([\/.]\d{2,4})?/g, " ")
    .replace(/\s+/g, " ").trim();
}

function statusOfWord(w) {
  const n = stripPunct(w);
  const check = x => HOME_WORDS.includes(x) ? "HOME" : BASE_WORDS.includes(x) ? "BASE" : null;
  // ישיר, או לאחר הסרת תחילית ב/ל (בחופש→חופש, לבסיס→בסיס, לקו→קו)
  return check(n) || (n.length > 2 && (n[0] === "ב" || n[0] === "ל") ? check(n.slice(1)) : null);
}

// נרמול ביטויים נפוצים לצורה קנונית (עוזר ל"חוכמה")
function normalizePhrases(t) {
  return t
    .replace(/לא\s+(מגיע|מגיעה|בא|באה|יגיע|תגיע|יהיה|תהיה|נמצא|נמצאת)/g, " בבית ")
    .replace(/יצא(ה|ת)?\s+(הביתה|לבית|לחופש|לגימלים)/g, " בבית ")
    .replace(/נשאר(ת|ה)?\s+(ב)?בית/g, " בבית ")
    .replace(/חזר(ה|תי)?\s+ל?(בסיס|קו)/g, " בבסיס ")
    .replace(/על(ה|תה|יתי)\s+לקו/g, " בבסיס ")
    .replace(/\s+/g, " ").trim();
}
function detectStatus(text) {
  for (const w of text.split(/\s+/)) { const s = statusOfWord(w); if (s) return s; }
  return null;
}

// זיהוי משימה יחידה בטקסט → {mission, cleaned} (הטקסט ללא ביטוי המשימה)
function detectMission(text) {
  const esc2 = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const norm = stripPunct(text);
  for (const mis of MISSIONS) {
    const mn = stripPunct(mis);
    if (mn && norm.includes(mn)) {
      const cleaned = text.replace(new RegExp(esc2(mis), "g"), " ").replace(new RegExp(esc2(mn), "g"), " ");
      return { mission: mis, cleaned };
    }
  }
  // כינוי נפוץ: ש"ג / שג → ש"ג 4-8
  if (/ש"?ג/.test(text)) return { mission: 'ש"ג 4-8', cleaned: text.replace(/בש"?ג|לש"?ג|ש"?ג/g, " ") };
  return { mission: null, cleaned: text };
}

// התאמת שם למצבת: מעדיף התאמה מדויקת יחידה, אחרת כל ההתאמות החלקיות
function matchSoldiers(roster, name) {
  const R = roster || [];
  const raw = (name || "").trim();
  if (!raw || raw.length < 2) return [];
  const doMatch = n => {
    const exact = R.filter(s => s.name === n);
    if (exact.length === 1) return exact;
    return R.filter(s => s.name === n || s.name.includes(n) || n.includes(s.name));
  };
  // שלב 1: מדויק/חלקי, כולל הסרת ו' החיבור וכינוי נפוץ
  const tries = [raw];
  if (raw[0] === "ו" && raw.length > 2) tries.push(raw.slice(1));
  const nick = NICKNAMES[hebNorm(raw)];
  if (nick) tries.push(nick);
  for (const t of tries) { const r = doMatch(t); if (r.length) return r; }

  // שלב 2: גרסאות כתיב (שלד השם) - עומרי≈עמרי, ז'אן≈זאן
  const cs = hebSkel(raw);
  if (cs.length >= 3) {
    const fuzzy = R.filter(s => hebSkel(s.name) === cs || s.name.split(" ").some(tok => hebSkel(tok) === cs));
    if (fuzzy.length) return fuzzy;
  }
  // שלב 3: מרחק עריכה ≤ 1 (שגיאת כתיב בודדת)
  const cn = hebNorm(raw);
  if (cn.length >= 3) {
    const ed = R.filter(s => editLE1(cn, hebNorm(s.name)) || s.name.split(" ").some(tok => editLE1(cn, hebNorm(tok))));
    if (ed.length) return ed;
  }
  return [];
}

// המרת רצף מילים לשמות: ממזג שתי/שלוש מילים רק אם הן שם מלא מדויק במצבת
function tokensToNames(tokens, roster) {
  const names = [];
  let i = 0;
  while (i < tokens.length) {
    let consumed = false;
    for (let len = Math.min(3, tokens.length - i); len >= 2; len--) {
      const cand = tokens.slice(i, i + len).join(" ");
      if ((roster || []).some(s => s.name === cand)) { names.push(cand); i += len; consumed = true; break; }
    }
    if (!consumed) { names.push(tokens[i]); i++; }
  }
  return names;
}

// --- חילוק לקבוצות {names[], status} ---
// מצב "כותרת": "בבית:\n..." / "בבסיס:\n..."
function parseHeaderList(text) {
  const re = /(בבית|בבסיס|בקו|בית)\s*:/g;
  const marks = [];
  let m;
  while ((m = re.exec(text))) marks.push({ status: HOME_WORDS.includes(m[1]) ? "HOME" : "BASE", start: m.index, end: re.lastIndex });
  const groups = [];
  for (let k = 0; k < marks.length; k++) {
    const to = k + 1 < marks.length ? marks[k + 1].start : text.length;
    groups.push({ status: marks[k].status, raw: text.slice(marks[k].end, to) });
  }
  return groups;
}

// מצב "נגרר": "דני בבית משה בבסיס" - הסטטוס בא אחרי השמות
function parseTrailing(text) {
  const words = stripPunct(text).split(/\s+/).filter(Boolean);
  const groups = [];
  let pending = [];
  for (const w of words) {
    const st = statusOfWord(w);
    if (st) { if (pending.length) { groups.push({ status: st, tokens: pending }); pending = []; } }
    else pending.push(w);
  }
  if (pending.length) groups.push({ status: null, tokens: pending });
  return groups;
}

// הפקת עדכונים מטקסט → {ready, ambiguous, unknown}
function extractUpdates(text, roster) {
  let t = stripDates(text);
  const md = detectMission(t);
  t = md.cleaned;
  const mission = md.mission;

  let rawGroups;
  if (/(בבית|בבסיס|בקו|בית)\s*:/.test(t)) {
    rawGroups = parseHeaderList(t).map(g => ({ status: g.status, tokens: stripPunct(g.raw).split(/\s+/).filter(Boolean) }));
  } else {
    rawGroups = parseTrailing(t);
  }

  const isNameWord = w => {
    const n = stripPunct(w);
    return n.length >= 2 && !statusOfWord(w) && !STOP_WORDS.has(n) && !/^\d+$/.test(n);
  };
  const ready = [], ambiguous = [], unknown = [];
  for (const g of rawGroups) {
    const status = g.status || "BASE";
    const names = tokensToNames(g.tokens.filter(isNameWord), roster);
    for (const cand of names) {
      if (cand.length < 2) continue;
      const matches = matchSoldiers(roster, cand);
      const mis = status === "BASE" ? (mission || "ללא משימה") : "ללא משימה";
      if (matches.length > 1) ambiguous.push({ originalName: cand, matches, status, mission: mis });
      else if (matches.length === 1) ready.push({ sInfo: matches[0], status, mission: mis });
      else unknown.push(cand);
    }
  }
  // ניקוי כפילויות: אותו חייל פעמיים ("ונועה כהן"→נועה+כהן), ועמימות/לא-מזוהה שכבר כוסו
  const seen = new Set();
  const dready = ready.filter(r => seen.has(r.sInfo.name) ? false : (seen.add(r.sInfo.name), true));
  const amb = ambiguous.filter(a => !dready.some(r => r.sInfo.name.includes(a.originalName)));
  const unk = [...new Set(unknown)].filter(u => !dready.some(r => r.sInfo.name.includes(u)) && !amb.some(a => a.originalName === u));
  return { ready: dready, ambiguous: amb, unknown: unk };
}

function detectBulk(text) {
  const status = detectStatus(text);
  if (!status) return null; // עדכון גורף דורש סטטוס מפורש (מונע "בוקר טוב לכולם")
  const all = /כולם|כולן|כל הפלוגה|כל האנשים|הפלוגה כולה/.test(text);
  let unit = null;
  for (const u of VALID_UNITS) if (text.includes(u)) unit = u;
  if (all && !unit) return { type: "bulk_update", unit: "all", status };
  if ((hw(text, "כל") || all) && unit) return { type: "bulk_update", unit, status };
  return null;
}

// זיהוי פעולות ניהול מצבת (הוספה / הסרה / שינוי שם)
function detectRosterOp(text, roster) {
  const t = text;
  // שינוי שם: "שנה <ישן> ל<חדש>". מזהים את השם הישן מול המצבת כדי לא להישבר על ל' בשם.
  if (hw(t, "שנה") || hw(t, "תשנה") || t.includes("שינוי שם")) {
    const after = t.replace(/^.*?(שנה|תשנה|שינוי שם)\s+/, "").replace(/^את\s+/, "");
    let best = null;
    for (const s of (roster || [])) if (after.includes(s.name) && (!best || s.name.length > best.length)) best = s.name;
    if (best) {
      const newName = after.slice(after.indexOf(best) + best.length).replace(/^\s*ל[\s\-־]*/, "").trim();
      if (newName) return { type: "rename", oldName: best, newName };
    }
    const m = after.match(/^(.*)\sל[\s\-־]*(.+)$/);
    if (m) return { type: "rename", oldName: m[1].trim(), newName: m[2].trim() };
  }
  // הסרה (רכה): "הסר/הורד <שם>"
  if (hw(t, "הסר") || hw(t, "תסיר") || hw(t, "הורד") || hw(t, "תוריד")) {
    const name = t.replace(/הסר|תסיר|הורד|תוריד|מהמצב[התא]|מהמסדר/g, " ").replace(/\s+/g, " ").trim();
    if (name) return { type: "remove", name };
  }
  // הוספה: "הוסף <שם> <מחלקה>"
  if (hw(t, "הוסף") || hw(t, "תוסיף") || hw(t, "הוסיפי")) {
    let unit = null;
    for (const u of VALID_UNITS) if (t.includes(u)) unit = u;
    let name = t.replace(/הוסף|תוסיף|הוסיפי/g, " ");
    if (unit) name = name.replace(unit, " ");
    name = name.replace(/למחלקה|מחלקה|לחובשים|לחמ"ל|לחמל|\d+/g, " ").replace(/\s+/g, " ").trim();
    return { type: "add", name, unit };
  }
  return null;
}

// --- המנוע המרכזי: טקסט → פעולה (ללא LLM) ---
function parseCommand(text, roster, isRosterCmd) {
  const raw = (text || "").trim();
  const date = resolveDate(raw, getIsraelDate());

  // ניהול מצבת (הוספה/הסרה/שינוי שם) - לפי מילות מפתח מפורשות
  const rosterOp = detectRosterOp(raw, roster);
  if (rosterOp) return rosterOp;

  // נרמול ביטויים נפוצים (לא מגיע→בבית, חזר לבסיס→בבסיס וכו')
  const clean = normalizePhrases(raw);

  // איפוס
  if (CLEAR_WORDS.some(w => clean.includes(w)) && (clean.includes("דוח") || clean.includes("דו"))) return { type: "clear", targetDate: date };

  // עדכון גורף
  const bulk = detectBulk(clean);
  if (bulk) return { ...bulk, dates: [date] };

  // עדכון רגיל. שמות לא-מזוהים נחשבים לעדכון רק אם יש כוונת עדכון (סטטוס/משימה).
  const upd = extractUpdates(clean, roster);
  const hasIntent = !!detectStatus(clean) || !!detectMission(clean).mission;
  if (upd.ready.length || upd.ambiguous.length || (upd.unknown.length && hasIntent))
    return { type: "update", ...upd, dates: [date] };

  // הצגת דוח
  if (/דוח|דו"ח|מצב|סטטוס/.test(clean) || hw(clean, "הצג") || hw(clean, "שלח"))
    return { type: "show_report", targetDate: date };

  return { type: "unknown" };
}

// האם כדאי לנסות LLM? (הקוד לא הבין, או שמות לא זוהו)
function needsLLM(ai) {
  return ai.type === "unknown" ||
    (ai.type === "update" && !ai.ready.length && !ai.ambiguous.length && ai.unknown.length > 0);
}

// המרת JSON מה-LLM לפעולה פנימית מאומתת מול המצבת
function buildActionFromLLM(j, roster) {
  if (!j || !j.type) return null;
  const date = (j.targetDate && /^\d{4}-\d{2}-\d{2}$/.test(j.targetDate)) ? j.targetDate : getIsraelDate();
  // בטיחות: פעולות הרסניות (איפוס/גורף) נשארות דטרמיניסטיות בלבד - לא מ-AI מעורפל.
  if (j.type === "show_report") return { type: "show_report", targetDate: date };
  if (j.type === "update") {
    const ready = [], unknown = [];
    for (const u of (j.updates || [])) {
      if (!u || !u.name) continue;
      const exact = (roster || []).find(s => s.name === u.name);
      const sInfo = exact || ((matchSoldiers(roster, u.name) || [])[0]);
      const status = u.status === "HOME" ? "HOME" : "BASE";
      const mission = status === "BASE" && u.mission && MISSIONS.includes(u.mission) ? u.mission : "ללא משימה";
      if (sInfo) ready.push({ sInfo, status, mission });
      else unknown.push(u.name);
    }
    if (!ready.length && !unknown.length) return null;
    return { type: "update", ready, ambiguous: [], unknown, dates: [date] };
  }
  return null;
}

function missionMatch(mission, target) {
  return stripPunct(mission || "").includes(stripPunct(target));
}

// --- הדוח (פורמט מלא, HTML) ---
function generateReport(soldiers, dateString, deployment) {
  const [y, mo, dd] = dateString.split("-").map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, dd)).getUTCDay();
  const d = String(dd).padStart(2, "0"), m = String(mo).padStart(2, "0");
  const DIV = "━━━━━━━━━━━━━━";

  let r = `🏕️ <b>דוח 1 — ${esc(deployment)}</b>\nיום ${DAY_NAMES[dow]} ${d}.${m}\n\n`;

  for (const u of VALID_UNITS) {
    const us = soldiers.filter(s => s.unit === u);
    if (us.length === 0) continue;
    const base = us.filter(s => s.status === "BASE");
    const home = us.filter(s => s.status === "HOME");
    r += `⬛ <b>${esc(u)}</b> (${base.length}/${us.length})\n`;
    r += `🏡 בבסיס (${base.length}): ${base.length ? base.map(s => esc(s.name)).join(", ") : "—"}\n`;
    if (home.length) r += `🏠 בבית (${home.length}): ${home.map(s => esc(s.name)).join(", ")}\n`;
    r += "\n";
  }

  // שיבוץ משימות - רק משימות מאוישות
  const lines = [];
  for (const mis of MISSIONS) {
    const names = soldiers.filter(s => s.mission && s.mission !== "ללא משימה" && missionMatch(s.mission, mis));
    if (names.length) lines.push(`• <b>${esc(mis)}</b>: ${names.map(s => esc(s.name)).join(", ")}`);
  }
  if (lines.length) r += `${DIV}\n⚡ <b>שיבוץ משימות</b>\n${lines.join("\n")}\n\n`;

  const bAll = soldiers.filter(s => s.status === "BASE").length;
  r += `${DIV}\n📊 <b>סה"כ נוכחים: ${bAll}/${soldiers.length}</b>`;
  return r;
}

function passesGatekeeper(text) {
  return text.startsWith("*")
    || ((text.includes("בבית:") || text.includes("בבסיס:")) && text.includes("\n"))
    || text.includes("דוח")
    || text.startsWith("/");
}

// ==========================================
// הרצת הבוט (רק בהרצה ישירה)
// ==========================================
function main() {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const PORT = process.env.PORT || 3000;

  const required = { TELEGRAM_TOKEN, SUPABASE_URL, SUPABASE_KEY };
  const missing = Object.keys(required).filter(k => !required[k]);
  if (missing.length) { console.error(`❌ חסרים משתני סביבה: ${missing.join(", ")}`); process.exit(1); }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const WEBHOOK_URL = `https://dvir-army-bot.onrender.com/bot${TELEGRAM_TOKEN}`;
  const bot = new TelegramBot(TELEGRAM_TOKEN, { webHook: { port: PORT } });
  const pendingConfirmations = new Map();

  const send = (chatId, text, extra = {}) =>
    bot.sendMessage(chatId, text, { parse_mode: "HTML", ...extra }).catch(e => console.error("❌ send:", e.message));
  const edit = (text, extra = {}) =>
    bot.editMessageText(text, { parse_mode: "HTML", ...extra }).catch(e => console.error("❌ edit:", e.message));

  async function upsertReports(rows) {
    if (!rows.length) return;
    const { error } = await supabase.from("report_data").upsert(rows, { onConflict: "name,report_date" });
    if (error) throw error;
  }
  const rowOf = (sInfo, status, mission, date) =>
    ({ name: sInfo.name, status, mission, report_date: date, deployment_name: DEPLOYMENT_NAME });

  // --- AI fallback (אופציונלי) - רץ רק כשהמנוע הדטרמיניסטי לא הצליח ---
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_KEY;
  const LLM_PROVIDER = ANTHROPIC_KEY ? "Claude" : (GEMINI_KEY ? "Gemini" : null);

  function httpsJson(opts, bodyObj) {
    return new Promise((resolve, reject) => {
      const req = https.request(opts, res => {
        let b = ""; res.on("data", d => b += d);
        res.on("end", () => { try { resolve(JSON.parse(b)); } catch { reject(new Error("bad json: " + b.slice(0, 120))); } });
      });
      req.on("error", reject);
      req.setTimeout(12000, () => req.destroy(new Error("timeout")));
      req.write(JSON.stringify(bodyObj)); req.end();
    });
  }
  function extractJson(raw) { const a = raw.indexOf("{"), b = raw.lastIndexOf("}"); if (a < 0 || b < 0) throw new Error("no json"); return JSON.parse(raw.slice(a, b + 1)); }

  async function askLLM(text, roster) {
    try {
      const names = [...new Set((roster || []).map(s => s.name))];
      const prompt = `אתה מפענח פקודות לבוט מצבת כוח אדם (דוח 1). היום ${getIsraelDate()}.
מצבת השמות (רשימה סגורה): ${JSON.stringify(names)}.
משימות: ${JSON.stringify(MISSIONS)}. מחלקות: ${JSON.stringify(VALID_UNITS)}.
ההודעה: "${text}".
החזר אך ורק JSON. מפה כל שם - כולל כינוי (דימה=דמיטרי) או שגיאת כתיב (עומרי=עמרי, זאן=ז'אן) - לשם המדויק מהמצבת. אל תמציא שמות שלא ברשימה.
"בבית"=HOME, "בבסיס"=BASE. אם זו לא פקודה רלוונטית החזר {"type":"unknown"}.
פורמט: {"type":"update|show_report|clear|bulk_update|unknown","updates":[{"name":"שם מדויק","status":"BASE|HOME","mission":"שם משימה או ריק"}],"unit":"all|מחלקה","status":"BASE|HOME","targetDate":"YYYY-MM-DD"}`;
      let raw;
      if (ANTHROPIC_KEY) {
        const r = await httpsJson({ hostname: "api.anthropic.com", path: "/v1/messages", method: "POST", headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } },
          { model: "claude-haiku-4-5-20251001", max_tokens: 500, messages: [{ role: "user", content: prompt }] });
        if (r.error) throw new Error(r.error.message || JSON.stringify(r.error));
        raw = r.content[0].text;
      } else {
        const r = await httpsJson({ hostname: "generativelanguage.googleapis.com", path: `/v1beta/models/gemini-flash-lite-latest:generateContent?key=${GEMINI_KEY}`, method: "POST", headers: { "content-type": "application/json" } },
          { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } });
        if (r.error) throw new Error(r.error.message || JSON.stringify(r.error));
        raw = r.candidates[0].content.parts[0].text;
      }
      console.log("🤖 LLM:", raw.slice(0, 140));
      return buildActionFromLLM(extractJson(raw), roster);
    } catch (e) { console.error("⚠️ LLM fallback:", e.message); return null; }
  }

  bot.setWebHook(WEBHOOK_URL)
    .then(() => console.log(`🚀 גרסה 71 באוויר | מבצע: ${DEPLOYMENT_NAME} | AI fallback: ${LLM_PROVIDER || "כבוי"}`))
    .catch(e => console.error("❌ Webhook:", e.message));

  cron.schedule("0 18 * * 0,1,2,3,6", () =>
    send(GROUP_CHAT_ID, `⚠️ <b>תזכורת [${esc(DEPLOYMENT_NAME)}]:</b> נא לשלוח דוח 1 למחר!`),
    { timezone: "Asia/Jerusalem" });
  cron.schedule("0 18 * * 4", () =>
    send(GROUP_CHAT_ID, `⚠️ <b>תזכורת סופ"ש [${esc(DEPLOYMENT_NAME)}]:</b> נא לשלוח דוח 1 לשישי-שבת!`),
    { timezone: "Asia/Jerusalem" });

  bot.on("message", async (msg) => {
    if (!msg.text) return;
    const text = msg.text.trim();
    const chatId = msg.chat.id;
    const senderName = msg.from.first_name || "מפקד";

    if (text.startsWith("/id")) return send(chatId, `ID: <code>${chatId}</code>`);
    if (chatId > 0 && chatId !== COMMANDER_ID) return;
    if (pendingConfirmations.has(chatId)) pendingConfirmations.delete(chatId);
    if (chatId < 0 && !passesGatekeeper(text)) return;

    // ניקוי כוכביות
    let clean = text, isRosterCmd = false;
    if (text.startsWith("***")) { clean = text.slice(3).trim(); isRosterCmd = true; }
    else if (text.startsWith("*")) clean = text.slice(1).trim();

    console.log(`📥 ${senderName}: "${clean.slice(0, 40)}"`);

    try {
      const { data: roster } = await supabase.from("soldiers").select("name, unit").eq("is_active", true);
      const rosterList = roster || [];
      let ai = parseCommand(clean, rosterList, isRosterCmd);
      // AI fallback: רק אם המנוע הדטרמיניסטי לא פיצח
      if (LLM_PROVIDER && needsLLM(ai)) {
        const llm = await askLLM(clean, rosterList);
        if (llm) { ai = llm; console.log("↪️ LLM result used"); }
      }
      console.log("⚙️", JSON.stringify(ai).slice(0, 200));
      const todayDate = getIsraelDate();

      if (ai.type === "clear") {
        const date = ai.targetDate || todayDate;
        await supabase.from("report_data").delete().eq("report_date", date);
        return send(chatId, `🧹 <b>דוח 1 לתאריך ${date} [${esc(DEPLOYMENT_NAME)}] אופס!</b>`);
      }

      if (ai.type === "bulk_update") {
        const dates = ai.dates && ai.dates.length ? ai.dates : [todayDate];
        const rows = [];
        for (const date of dates)
          for (const s of rosterList) {
            if (ai.unit && ai.unit !== "all" && s.unit !== ai.unit) continue;
            rows.push(rowOf(s, ai.status || "BASE", "ללא משימה", date));
          }
        await upsertReports(rows);
        const scope = ai.unit && ai.unit !== "all" ? ai.unit : "כל הפלוגה";
        const st = (ai.status || "BASE") === "HOME" ? "בבית" : "בבסיס";
        return send(chatId, `✅ עדכון גורף: ${esc(scope)} → ${st} (${rows.length} חיילים).`);
      }

      if (ai.type === "update") {
        const dates = ai.dates && ai.dates.length ? ai.dates : [todayDate];
        if (ai.ambiguous.length) {
          pendingConfirmations.set(chatId, { ready: ai.ready, ambiguous: ai.ambiguous, resolved: [], dates, unknownNames: ai.unknown });
          const first = ai.ambiguous[0];
          const kb = first.matches.map((s, i) => [{ text: s.name, callback_data: `amb_${chatId}_${i}` }]);
          return send(chatId, `❓ <b>"${esc(first.originalName)}" - איזה מהם?</b>`, { reply_markup: { inline_keyboard: kb } });
        }
        const rows = [];
        for (const date of dates) for (const it of ai.ready) rows.push(rowOf(it.sInfo, it.status, it.mission, date));
        await upsertReports(rows);
        let txt = ai.ready.length ? `✅ נקלט ביומן [${esc(DEPLOYMENT_NAME)}] (${ai.ready.length} חיילים).` : "";
        if (ai.unknown.length) txt += `\n⚠️ לא במצבת: ${esc(ai.unknown.join(", "))}`;
        return txt ? send(chatId, txt) : send(chatId, "לא זוהו שמות מהמצבת. נסה: <code>*דני בבית</code>");
      }

      if (ai.type === "show_report") {
        const date = ai.targetDate || todayDate;
        const { data: daily } = await supabase.from("report_data").select("*").eq("report_date", date);
        const merged = rosterList.map(s => {
          const u = (daily || []).find(x => x.name === s.name);
          return { name: s.name, unit: s.unit, status: u ? u.status : "BASE", mission: u ? u.mission : "ללא משימה" };
        });
        return send(chatId, generateReport(merged, date, DEPLOYMENT_NAME));
      }

      if (ai.type === "add") {
        if (!ai.name) return send(chatId, "לא זוהה שם. דוגמה:\n<code>*הוסף דני כהן מחלקה 1</code>");
        if (!ai.unit) return send(chatId, `ציין מחלקה (${VALID_UNITS.join(" / ")}). דוגמה:\n<code>*הוסף ${esc(ai.name)} מחלקה 1</code>`);
        const exists = rosterList.find(s => s.name === ai.name);
        if (exists) return send(chatId, `⚠️ "${esc(ai.name)}" כבר במצבת (${esc(exists.unit)}).`);
        await supabase.from("soldiers").insert([{ name: ai.name, unit: ai.unit, is_active: true }]);
        return send(chatId, `✅ <b>${esc(ai.name)}</b> נוסף למצבת (${esc(ai.unit)}).`);
      }
      if (ai.type === "remove") {
        const m = matchSoldiers(rosterList, ai.name);
        if (m.length === 0) return send(chatId, `⚠️ "${esc(ai.name)}" לא נמצא במצבת.`);
        if (m.length > 1) return send(chatId, `❓ יש כמה: ${esc(m.map(s => s.name).join(", "))}.\nכתוב שם מלא: <code>*הסר ${esc(m[0].name)}</code>`);
        await supabase.from("soldiers").update({ is_active: false }).eq("name", m[0].name);
        return send(chatId, `✅ <b>${esc(m[0].name)}</b> הוסר מהמצבת.`);
      }
      if (ai.type === "rename") {
        const m = matchSoldiers(rosterList, ai.oldName);
        if (m.length === 0) return send(chatId, `⚠️ "${esc(ai.oldName)}" לא נמצא במצבת.`);
        if (m.length > 1) return send(chatId, `❓ יש כמה התאמות ל-"${esc(ai.oldName)}". כתוב שם מלא.`);
        await supabase.from("soldiers").update({ name: ai.newName }).eq("name", m[0].name);
        return send(chatId, `✅ "${esc(m[0].name)}" → "<b>${esc(ai.newName)}</b>".`);
      }

      return send(chatId, "❓ לא הבנתי. דוגמאות:\n<code>*דני בבית</code>\n<code>*כולם בבסיס</code>\n<code>*דני בסיור 1</code>\n<code>*דוח 1</code>\n<code>*תאפס דוח</code>\n<code>*הוסף דני כהן מחלקה 1</code>\n<code>*הסר דני כהן</code>");
    } catch (e) {
      console.error("🔴", e);
      send(chatId, "הייתה שגיאה בעיבוד הפקודה.");
    }
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    if (!data.startsWith("amb_")) return bot.answerCallbackQuery(query.id);
    const idx = parseInt(data.split("_").pop());
    if (!pendingConfirmations.has(chatId)) return bot.answerCallbackQuery(query.id, { text: "הפעולה פגה תוקף, שלח שוב." });
    const pending = pendingConfirmations.get(chatId);
    const current = pending.ambiguous[0];
    if (isNaN(idx) || idx < 0 || idx >= current.matches.length) return bot.answerCallbackQuery(query.id, { text: "בחירה לא תקינה." });

    pending.resolved.push({ sInfo: current.matches[idx], status: current.status, mission: current.mission });
    const chosen = current.matches[idx].name;
    pending.ambiguous.shift();

    if (pending.ambiguous.length) {
      const next = pending.ambiguous[0];
      const kb = next.matches.map((s, i) => [{ text: s.name, callback_data: `amb_${chatId}_${i}` }]);
      await edit(`✅ <b>${esc(chosen)}</b> נבחר.\n\n❓ <b>"${esc(next.originalName)}" - איזה מהם?</b>`,
        { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: kb } });
      return bot.answerCallbackQuery(query.id);
    }

    pendingConfirmations.delete(chatId);
    const all = [...pending.ready, ...pending.resolved];
    try {
      const rows = [];
      for (const date of pending.dates) for (const it of all) rows.push(rowOf(it.sInfo, it.status, it.mission, date));
      await upsertReports(rows);
      let txt = `✅ <b>${all.length} חיילים עודכנו.</b>`;
      if (pending.unknownNames.length) txt += `\n⚠️ לא במצבת: ${esc(pending.unknownNames.join(", "))}`;
      await edit(txt, { chat_id: chatId, message_id: query.message.message_id });
      bot.answerCallbackQuery(query.id);
    } catch (e) {
      console.error("🔴 callback:", e);
      bot.answerCallbackQuery(query.id, { text: "הייתה שגיאה." });
    }
  });
}

module.exports = {
  esc, stripPunct, hebNorm, hebSkel, editLE1, getIsraelDate, israelNowParts, resolveDate, addDays, nextWeekday,
  detectStatus, detectMission, matchSoldiers, tokensToNames, extractUpdates, detectBulk,
  detectRosterOp, parseCommand, buildActionFromLLM, needsLLM, generateReport, passesGatekeeper, missionMatch, VALID_UNITS, MISSIONS
};

if (require.main === module) main();
