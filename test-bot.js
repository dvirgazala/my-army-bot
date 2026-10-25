// בדיקות לוגיקה אוף-ליין - לא דורשות רשת, Supabase או Gemini.
// הרצה: node test-bot.js  (או npm test)
const {
  esc, getIsraelDate, passesGatekeeper, matchSoldiers,
  parseAiText, buildPrompt, generateFixedReport, VALID_UNITS
} = require("./bot.js");

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}`); }
}
function eq(name, actual, expected) {
  check(`${name} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`, actual === expected);
}

console.log("🔍 בדיקות לוגיקה למערכת הסמב\"ץ\n");

// --- שומר הסף ---
console.log("🧪 שומר הסף (Gatekeeper)");
eq("הודעת חולין נחסמת", passesGatekeeper("משה בבית"), false);
eq("כוכבית עוברת", passesGatekeeper("*משה בבית"), true);
eq("פקודת מצבת עוברת", passesGatekeeper("***איפוס דוח"), true);
eq("דוח מלא עובר", passesGatekeeper("בבסיס: אברהם\nבבית: יצחק"), true);
eq("פקודת / עוברת", passesGatekeeper("/id"), true);
eq("המילה דוח עוברת", passesGatekeeper("שלח דוח 1"), true);

// --- התאמת שמות ---
console.log("\n🧪 התאמת שמות (matchSoldiers)");
const roster = [
  { name: "דני כהן", unit: "מחלקה 1" },
  { name: "דני לוי", unit: "מחלקה 2" },
  { name: "דני", unit: "חובשים" },
  { name: "יוסי", unit: "מחלקה 3" }
];
eq("שם ריק → ללא התאמות", matchSoldiers(roster, "").length, 0);
eq("התאמה מדויקת יחידה גוברת על חלקית", matchSoldiers(roster, "דני").length, 1);
eq("...ומחזירה את החייל הנכון", matchSoldiers(roster, "דני")[0].name, "דני");
eq("שם חלקי → כמה התאמות (עמימות)", matchSoldiers(roster, "כהן").length, 1);
eq("שם משפחה משותף → עמימות", matchSoldiers([{ name: "דני כהן", unit: "א" }, { name: "רון כהן", unit: "ב" }], "כהן").length, 2);
eq("שם לא קיים → 0", matchSoldiers(roster, "אברהם").length, 0);
eq("שם מלא יחיד", matchSoldiers(roster, "יוסי")[0].name, "יוסי");

// --- תאריך ישראל ---
console.log("\n🧪 תאריך ישראל");
const dateStr = getIsraelDate();
check(`פורמט YYYY-MM-DD תקין (${dateStr})`, /^\d{4}-\d{2}-\d{2}$/.test(dateStr));

// --- חילוץ JSON מתשובת AI ---
console.log("\n🧪 חילוץ JSON (parseAiText)");
eq("JSON נקי", parseAiText('{"type":"update"}').type, "update");
eq("JSON עם רעש מסביב", parseAiText('הנה התשובה: {"type":"clear"} סוף').type, "clear");
check("זורק שגיאה כשאין JSON", (() => { try { parseAiText("אין כאן כלום"); return false; } catch { return true; } })());

// --- בריחת HTML ---
console.log("\n🧪 בריחת HTML (esc)");
eq("בריחת < > &", esc("a <b> & c"), "a &lt;b&gt; &amp; c");
eq("null → מחרוזת ריקה", esc(null), "");

// --- עיצוב הדוח ---
console.log("\n🧪 עיצוב הדוח (generateFixedReport)");
const soldiers = [
  { name: "דני", unit: "מחלקה 1", status: "BASE", mission: "ללא משימה" },
  { name: "רון", unit: "מחלקה 1", status: "HOME", mission: "ללא משימה" },
  { name: "גיא", unit: 'מפל"ג', status: "BASE", mission: 'חפ"ק מ"פ' }
];
const report = generateFixedReport(soldiers, "2026-10-25");
check("כולל כותרת דוח", report.includes("דוח כ"));
check("יום ראשון חושב נכון (25.10.2026 = ראשון)", report.includes("ראשון 25.10"));
check("כולל תגיות HTML ולא ** של Markdown", report.includes("<b>") && !report.includes("**"));
check("משבץ משימה לחייל הנכון", report.includes('חפ"ק מ"פ') && report.includes("גיא"));
check("סיכום: 2 בבסיס, 1 בבית", report.includes("בבסיס: 2") && report.includes("בבית: 1"));
check("מציג את כל המחלקות", VALID_UNITS.every(u => report.includes(u)));

// --- בניית פרומפט ---
console.log("\n🧪 בניית פרומפט (buildPrompt)");
const prompt = buildPrompt("דני בבית", roster, "דביר");
check("כולל את שמות המצבת", prompt.includes("דני כהן") && prompt.includes("יוסי"));
check("כולל את הודעת המשתמש", prompt.includes("דני בבית"));
check("כולל את שם השולח", prompt.includes("דביר"));

// --- סיכום ---
console.log(`\n${"=".repeat(40)}`);
console.log(`📊 תוצאות: ${passed} עברו, ${failed} נכשלו`);
process.exit(failed > 0 ? 1 : 0);
