// בדיקות לוגיקה אוף-ליין - מנוע הפענוח הדטרמיניסטי. אין רשת/DB/LLM.
// הרצה: node test-bot.js  (או npm test)
const B = require("./bot.js");

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}`); }
}
function eq(name, a, e) { check(`${name} (exp ${JSON.stringify(e)}, got ${JSON.stringify(a)})`, a === e); }

const R = [
  { name: "שקד קריו", unit: 'מפל"ג' },
  { name: "דביר גזלה", unit: 'מפל"ג' },
  { name: "שקד אורלוב", unit: "מחלקה 1" },
  { name: "עידן זרו", unit: "מחלקה 1" },
  { name: "נועה כהן", unit: "מחלקה 1" },
  { name: "אדיר אלבלה", unit: "מחלקה 1" },   // מסופח המשויך למחלקה
  { name: "יהונתן יוסף", unit: "מחלקה 2" },
  { name: "אוהד עמילני", unit: "מחלקה 3" },
  { name: "רענן קלנר", unit: "חובשים" },
  { name: "אלון ראובן", unit: 'חמ"ל' },
];

console.log("🔍 בדיקות מנוע הפענוח הדטרמיניסטי\n");

// --- שומר הסף ---
console.log("🧪 שומר הסף");
eq("חולין נחסם", B.passesGatekeeper("משה בבית"), false);
eq("כוכבית עוברת", B.passesGatekeeper("*משה בבית"), true);
eq("דוח עובר", B.passesGatekeeper("שלח דוח 1"), true);

// --- תאריכים ---
console.log("\n🧪 תאריכים");
eq("מחר", B.resolveDate("אוהד בבית מחר", "2026-10-26"), "2026-10-27");
eq("מחרתיים", B.resolveDate("מחרתיים", "2026-10-26"), "2026-10-28");
eq("היום (ברירת מחדל)", B.resolveDate("אוהד בבית", "2026-10-26"), "2026-10-26");
eq("dd/mm", B.resolveDate("דוח 31/10", "2026-10-26"), "2026-10-31");
eq("יום שישי מ-26.10(ב')", B.resolveDate("דוח ליום שישי", "2026-10-26"), "2026-10-30");

// --- התאמת שמות ---
console.log("\n🧪 התאמת שמות");
eq("שם מלא מדויק", B.matchSoldiers(R, "שקד קריו").length, 1);
eq("שם משפחה ייחודי", B.matchSoldiers(R, "עמילני")[0].name, "אוהד עמילני");
eq("שם פרטי כפול → עמימות", B.matchSoldiers(R, "שקד").length, 2);
eq("לא קיים", B.matchSoldiers(R, "משה").length, 0);

// --- parseCommand: עדכון בודד ---
console.log("\n🧪 עדכון בודד");
let a = B.parseCommand("אוהד עמילני בבית", R);
eq("type=update", a.type, "update");
eq("ready=1", a.ready.length, 1);
eq("status=HOME", a.ready[0].status, "HOME");
eq("השם הנכון", a.ready[0].sInfo.name, "אוהד עמילני");

// --- מיזוג שם מלא מול עמימות ---
console.log("\n🧪 שם מלא מול עמימות");
a = B.parseCommand("שקד קריו בבסיס", R);
eq("שקד קריו → ready 1", a.ready.length, 1);
eq("...BASE", a.ready[0].status, "BASE");
a = B.parseCommand("שקד בבית", R);
eq("שקד לבד → עמימות", a.ambiguous.length, 1);
eq("...2 אפשרויות", a.ambiguous[0].matches.length, 2);

// --- רשימה עם סטטוסים שונים (trailing) ---
console.log("\n🧪 trailing - סטטוסים שונים");
a = B.parseCommand("עידן זרו בבית נועה כהן בבסיס", R);
const byName = Object.fromEntries(a.ready.map(x => [x.sInfo.name, x.status]));
eq("עידן זרו=HOME", byName["עידן זרו"], "HOME");
eq("נועה כהן=BASE", byName["נועה כהן"], "BASE");

// --- פורמט כותרות (header list) ---
console.log("\n🧪 header list");
a = B.parseCommand("בבית:\nעידן זרו\nנועה כהן\nבבסיס:\nאוהד עמילני", R);
const hn = Object.fromEntries(a.ready.map(x => [x.sInfo.name, x.status]));
eq("עידן זרו=HOME", hn["עידן זרו"], "HOME");
eq("נועה כהן=HOME", hn["נועה כהן"], "HOME");
eq("אוהד עמילני=BASE", hn["אוהד עמילני"], "BASE");

// --- משימות ---
console.log("\n🧪 משימות");
a = B.parseCommand("אוהד עמילני בסיור 1", R);
eq("mission=סיור 1", a.ready[0] && a.ready[0].mission, "סיור 1");
eq("status=BASE עם משימה", a.ready[0] && a.ready[0].status, "BASE");
a = B.parseCommand('דביר גזלה חפ"ק מ"פ', R);
eq('חפ"ק מ"פ מזוהה', a.ready[0] && a.ready[0].mission, 'חפ"ק מ"פ');

// --- עדכון גורף ---
console.log("\n🧪 עדכון גורף");
a = B.parseCommand("כולם בבסיס", R);
eq("bulk all", a.type, "bulk_update");
eq("unit=all", a.unit, "all");
eq("status=BASE", a.status, "BASE");
a = B.parseCommand("כל מחלקה 1 בבית", R);
eq("bulk unit", a.unit, "מחלקה 1");
eq("status=HOME", a.status, "HOME");

// --- איפוס והצגה ---
console.log("\n🧪 איפוס / הצגה");
eq("תאפס דוח → clear", B.parseCommand("תאפס דוח 1", R).type, "clear");
eq("דוח → show_report", B.parseCommand("דוח 1", R).type, "show_report");
eq("שלח דוח מחר → show_report", B.parseCommand("שלח דוח מחר", R).type, "show_report");

// --- לא מזוהה ושמות לא במצבת ---
console.log("\n🧪 לא מזוהה");
eq("ג'יבריש → unknown", B.parseCommand("בלהבלה משהו", R).type, "unknown");
a = B.parseCommand("משה בבית", R);
eq("שם לא במצבת → unknown list", a.unknown.includes("משה"), true);

// --- הדוח ---
console.log("\n🧪 דוח (generateReport)");
const sol = R.map(s => ({ ...s, status: "BASE", mission: "ללא משימה" }));
sol.find(s => s.name === "עידן זרו").status = "HOME";
sol.find(s => s.name === "אוהד עמילני").mission = "סיור 1";
const rep = B.generateReport(sol, "2026-10-26", "שאגת הארי");
check("כותרת דוח 1", rep.includes("דוח 1"));
check("יום שני 26.10", rep.includes("יום שני 26.10"));
check("HTML ולא **", rep.includes("<b>") && !rep.includes("**"));
check("עידן זרו תחת בבית", /🏠 בבית.*עידן זרו/s.test(rep));
check("שיבוץ משימות מופיע", rep.includes("סיור 1") && rep.includes("אוהד עמילני"));
check("סיכום נוכחים", rep.includes('סה"כ נוכחים'));
check("כל 6 המחלקות בסדר", B.VALID_UNITS.every(u => rep.includes(u)));
check("15 משימות מוגדרות", B.MISSIONS.length === 15);
check('אין נהג משאית', !B.MISSIONS.some(m => m.includes("משאית")));

console.log(`\n${"=".repeat(40)}\n📊 תוצאות: ${passed} עברו, ${failed} נכשלו`);
process.exit(failed > 0 ? 1 : 0);
