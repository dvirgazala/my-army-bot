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
  { name: "דמיטרי רוזט", unit: "מחלקה 1" },
  { name: "עמרי ג'אן", unit: "מחלקה 2" },
  { name: "אלכסנדר סטוק", unit: 'מפל"ג' },
  { name: "אלכסנדר סטיליק", unit: "מחלקה 3" },
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

// --- ניהול מצבת ---
console.log("\n🧪 ניהול מצבת (הוספה/הסרה/שינוי שם)");
a = B.parseCommand("הוסף דני כהן מחלקה 1", R);
eq("הוסף → type=add", a.type, "add");
eq("...name", a.name, "דני כהן");
eq("...unit", a.unit, "מחלקה 1");
a = B.parseCommand("הוסף דני כהן", R);
eq("הוספה ללא מחלקה → unit null", a.unit, null);
a = B.parseCommand("הסר אוהד עמילני", R);
eq("הסר → type=remove", a.type, "remove");
check("...name כולל עמילני", a.name.includes("עמילני"));
a = B.parseCommand("שנה אוהד עמילני לאוהד לוי", R);
eq("שנה → type=rename", a.type, "rename");
check("...oldName", a.oldName.includes("אוהד עמילני"));
check("...newName", a.newName.includes("אוהד לוי"));
eq("עדכון רגיל לא נתפס כפעולת מצבת", B.parseCommand("אוהד עמילני בבית", R).type, "update");
eq('"תמחק דוח" עדיין clear (לא remove)', B.parseCommand("תמחק דוח", R).type, "clear");

// --- ואריאציות "חכמות" ---
console.log("\n🧪 ואריאציות טבעיות");
const st = t => { const a = B.parseCommand(t, R); return a.ready && a.ready[0] ? a.ready[0].status : a.type; };
eq("בחופש → HOME", st("אוהד עמילני בחופש"), "HOME");
eq("בגימלים → HOME", st("אוהד עמילני בגימלים"), "HOME");
eq("לא מגיע → HOME", st("אוהד עמילני לא מגיע"), "HOME");
eq("נשאר בבית → HOME", st("אוהד עמילני נשאר בבית"), "HOME");
eq("פה → BASE", st("אוהד עמילני פה"), "BASE");
eq("חזר לבסיס → BASE", st("אוהד עמילני חזר לבסיס"), "BASE");
eq("עלה לקו → BASE", st("אוהד עמילני עלה לקו"), "BASE");
check("ללא רעש unknown ב'נשאר בבית'", B.parseCommand("אוהד עמילני נשאר בבית", R).unknown.length === 0);
eq("ו' החיבור: 'עידן זרו ונועה כהן בבית' שניהם HOME",
  B.parseCommand("עידן זרו ונועה כהן בבית", R).ready.filter(x => x.status === "HOME").length, 2);
eq("'בוקר טוב לכולם' → לא עדכון גורף", B.parseCommand("בוקר טוב לכולם", R).type, "unknown");
eq("'מה המצב' → show_report", B.parseCommand("מה המצב", R).type, "show_report");
let rn = B.parseCommand("שנה אוהד עמילני לאוהד לוי", R);
eq("rename old נכון מול המצבת", rn.oldName, "אוהד עמילני");
eq("rename new נכון (לא נשבר על ל')", rn.newName, "אוהד לוי");

// --- התאמת שמות חכמה (גרסאות כתיב + כינויים) ---
console.log("\n🧪 התאמת שמות חכמה");
check("עומרי → עמרי ג'אן (ו' עודפת)", B.matchSoldiers(R, "עומרי").some(s => s.name === "עמרי ג'אן"));
check("זאן → עמרי ג'אן (ז במקום ג)", B.matchSoldiers(R, "זאן").some(s => s.name === "עמרי ג'אן"));
check("דימה → דמיטרי רוזט (כינוי)", B.matchSoldiers(R, "דימה").some(s => s.name === "דמיטרי רוזט"));
check("מישה → (אין מיכאל, לא מתאים)", B.matchSoldiers(R, "מישה").length === 0 || !B.matchSoldiers(R, "מישה").some(s => s.name.includes("מיכאל")));
eq("אלכס → 2 אלכסנדרים (עמימות)", B.matchSoldiers(R, "אלכס").length, 2);
eq("יוני → יהונתן יוסף", (B.matchSoldiers(R, "יוני")[0] || {}).name, "יהונתן יוסף");
let sm = B.parseCommand("עומרי זאן בבית", R);
eq("'עומרי זאן בבית' → עמרי ג'אן", (sm.ready[0] || {}).sInfo && sm.ready[0].sInfo.name, "עמרי ג'אן");
eq("...HOME", (sm.ready[0] || {}).status, "HOME");
eq("...בלי רעש unknown", sm.unknown.length, 0);
eq("'דימה בבית' → דמיטרי רוזט HOME", (B.parseCommand("דימה בבית", R).ready[0] || {}).sInfo.name, "דמיטרי רוזט");

// --- עזרי נרמול ---
console.log("\n🧪 נרמול");
eq("hebSkel עומרי=עמרי", B.hebSkel("עומרי"), B.hebSkel("עמרי"));
check("editLE1 החלפה בודדת", B.editLE1("זאן", "גאן"));
check("editLE1 רחוק=false", !B.editLE1("אבג", "זחט"));

// --- מעטפת LLM (buildActionFromLLM + needsLLM) ---
console.log("\n🧪 מעטפת LLM");
check("needsLLM על unknown", B.needsLLM({ type: "unknown" }));
check("needsLLM=false על עדכון תקין", !B.needsLLM({ type: "update", ready: [1], ambiguous: [], unknown: [] }));
let la = B.buildActionFromLLM({ type: "update", updates: [{ name: "דמיטרי רוזט", status: "HOME" }] }, R);
eq("buildActionFromLLM ממפה שם מדויק", (la.ready[0] || {}).sInfo.name, "דמיטרי רוזט");
eq("...status", la.ready[0].status, "HOME");
eq("buildActionFromLLM show_report", B.buildActionFromLLM({ type: "show_report" }, R).type, "show_report");
eq("LLM לא יכול להפעיל גורף (בטיחות)", B.buildActionFromLLM({ type: "bulk_update", unit: "all", status: "BASE" }, R), null);
eq("LLM לא יכול לאפס (בטיחות)", B.buildActionFromLLM({ type: "clear" }, R), null);

// --- פורמט חופשי: סטטוסים, הערות, אימוג'י (דוח רב-שורתי אמיתי) ---
console.log("\n🧪 פורמט חופשי - סטטוסים והערות");
// תוויות הערה
eq("noteOf נפקד", B.noteOf("נפקד"), "נפקד");
eq("noteOf שחרור (משוחרר)", B.noteOf("משוחרר"), "שחרור");
eq('noteOf חו"ל → חופש', B.noteOf('חו"ל'), "חופש");
eq("noteOf חול → חופש", B.noteOf("חול"), "חופש");
eq("noteOf גימלים", B.noteOf("גימלים"), "גימלים");
eq("noteOf מתייצב בהמשך", B.noteOf("מתייצב בהמשך"), "יתייצב בהמשך");
eq("noteOf מתחיל ב28", B.noteOf("מתחיל ב28 אלת"), "מתחיל ב-28");
eq("noteOf דחיית צו", B.noteOf("דחיית צו"), "דחיית צו");
eq("noteOf רגיל → ריק", B.noteOf("נוכח"), "");
// אימוג'י
eq("✅ → BASE", B.emojiStatus("חיים קורקוס✅").status, "BASE");
eq("🚔 → HOME", B.emojiStatus("x 🚔").status, "HOME");
eq("🚔 → note נפקד", B.emojiStatus("x 🚔").note, "נפקד");
eq("✈️ → HOME/חופש", B.emojiStatus("x ✈️").note, "חופש");
eq("⚕️ → HOME/גימלים", B.emojiStatus("x 👨🏻‍⚕️").note, "גימלים");

const RF = [
  { name: "רענן קלנר", unit: "חובשים" },
  { name: "דניאל צדוק", unit: "מחלקה 1" },
  { name: "אור בלומנטל", unit: "מחלקה 1" },
  { name: "דולב מיכאלי", unit: "מחלקה 3" },
  { name: "אופיר חי", unit: "מחלקה 3" },
  { name: "חיים מר קורקוס", unit: "מחלקה 3" },
  { name: "וואניו זרו", unit: "מחלקה 2" },
  { name: "אלכסנדר סטיליק", unit: "מחלקה 3" },
  { name: "כפיר קירלי", unit: "מחלקה 2" },
];
const report = `27.10.26
מחלקה 1: 27.10
רענן קלנר - נ
דניאל צדוק- חול
אור בלומנטל- בית
מחלקה 3
חיים קורקוס✅
אופיר חי👨🏻‍⚕️גימלים
דולב מיכאלי - נפקד 🚔
אלכס סטיליק✅
זרו וואניו- נוכח
*לא נמצאים* :
כפיר קירלי -שחרור`;

const rf = B.parseCommand(report, RF);
eq("דוח עם 'רענן' → update ולא clear", rf.type, "update");
const fn = Object.fromEntries(rf.ready.map(x => [x.sInfo.name, x]));
eq('"נ" → BASE (רענן קלנר)', (fn["רענן קלנר"] || {}).status, "BASE");
eq("חול → HOME", (fn["דניאל צדוק"] || {}).status, "HOME");
eq("חול → note חופש", (fn["דניאל צדוק"] || {}).note, "חופש");
eq("בית → HOME", (fn["אור בלומנטל"] || {}).status, "HOME");
eq("✅ → BASE (חיים מר קורקוס)", (fn["חיים מר קורקוס"] || {}).status, "BASE");
eq("גימלים (אימוג'י+טקסט מודבק)", (fn["אופיר חי"] || {}).note, "גימלים");
eq("נפקד 🚔 → HOME", (fn["דולב מיכאלי"] || {}).status, "HOME");
eq("נפקד 🚔 → note נפקד", (fn["דולב מיכאלי"] || {}).note, "נפקד");
eq("אלכס סטיליק → אלכסנדר סטיליק (כינוי במילה ראשונה)", !!fn["אלכסנדר סטיליק"], true);
eq("זרו וואניו → וואניו זרו (סדר הפוך, תת-קבוצה)", !!fn["וואניו זרו"], true);
eq('כותרת "לא נמצאים" → HOME', (fn["כפיר קירלי"] || {}).status, "HOME");
eq("שחרור → note שחרור", (fn["כפיר קירלי"] || {}).note, "שחרור");

// התאמת תת-קבוצת טוקנים (שם עם מילה אמצעית / מקף)
console.log("\n🧪 התאמת שם - מילה אמצעית / סדר / מקף");
eq("חיים קורקוס ⊆ חיים מר קורקוס", (B.matchSoldiers(RF, "חיים קורקוס")[0] || {}).name, "חיים מר קורקוס");
eq("זרו וואניו ⊆ וואניו זרו", (B.matchSoldiers(RF, "זרו וואניו")[0] || {}).name, "וואניו זרו");

// הדוח מציג הערה ליד השם
console.log("\n🧪 דוח - הערה ליד השם");
const solN = [
  { name: "דולב מיכאלי", unit: "מחלקה 3", status: "HOME", mission: "ללא משימה", note: "נפקד" },
  { name: "כפיר קירלי", unit: "מחלקה 2", status: "HOME", mission: "ללא משימה", note: "שחרור" },
];
const repN = B.generateReport(solN, "2026-10-27", "בחן");
check("הדוח כולל 'דולב מיכאלי (נפקד)'", repN.includes("דולב מיכאלי (נפקד)"));
check("הדוח כולל 'כפיר קירלי (שחרור)'", repN.includes("כפיר קירלי (שחרור)"));

// --- פרסר עוגן-שמות: כמה חיילים באותה שורה (הפורמט האמיתי של דביר) ---
console.log("\n🧪 כמה שמות בשורה אחת (extractByScan)");
const RS = [
  { name: "רענן קלנר", unit: "חובשים" },
  { name: "דניאל צדוק", unit: "מחלקה 1" },
  { name: "אור בלומנטל", unit: "מחלקה 1" },
  { name: "חיים מר קורקוס", unit: "מחלקה 3" },
  { name: "אופיר חי", unit: "מחלקה 3" },
  { name: "דולב מיכאלי", unit: "מחלקה 3" },
  { name: "יהונתן יוסף", unit: "מחלקה 2" },
  { name: "עמית מזרחי", unit: "מחלקה 2" },
  { name: "איתי חניה", unit: "מחלקה 2" },
  { name: "כפיר קירלי", unit: "מחלקה 2" },
];
// בלוק בשורה אחת, מופרד במקף/רווח/אימוג'י + כותרות
const blockMsg = `רענן קלנר - נ דניאל צדוק- חול אור בלומנטל- בית
חיים קורקוס✅ אופיר חי👨🏻‍⚕️גימלים דולב מיכאלי - נפקד 🚔
נוכחים :
יהונתן יוסף עמית מזרחי איתי חניה
לא נמצאים :
כפיר קירלי -שחרור`;
const rs = B.parseCommand(blockMsg, RS);
const fm = Object.fromEntries(rs.ready.map(x => [x.sInfo.name, x]));
eq("כמה בשורה → update", rs.type, "update");
eq("זוהו 10 חיילים מכל הבלוקים", rs.ready.length, 10);
eq("אפס מקלדות עמימות", rs.ambiguous.length, 0);
eq('"נ" בשורה משותפת → רענן BASE', (fm["רענן קלנר"] || {}).status, "BASE");
eq("חול בשורה משותפת → HOME", (fm["דניאל צדוק"] || {}).status, "HOME");
eq("✅ בשורה משותפת → חיים מר קורקוס BASE", (fm["חיים מר קורקוס"] || {}).status, "BASE");
eq("אימוג'י רפואי מודבק → אופיר חי גימלים", (fm["אופיר חי"] || {}).note, "גימלים");
eq("נפקד בשורה משותפת", (fm["דולב מיכאלי"] || {}).note, "נפקד");
eq("כותרת נוכחים → יהונתן יוסף BASE", (fm["יהונתן יוסף"] || {}).status, "BASE");
eq("3 שמות ברצף בלי מפריד → כולם נקלטו", ["יהונתן יוסף", "עמית מזרחי", "איתי חניה"].every(n => fm[n]), true);
eq("כותרת לא נמצאים → כפיר HOME", (fm["כפיר קירלי"] || {}).status, "HOME");
eq("כפיר note שחרור", (fm["כפיר קירלי"] || {}).note, "שחרור");

console.log(`\n${"=".repeat(40)}\n📊 תוצאות: ${passed} עברו, ${failed} נכשלו`);
process.exit(failed > 0 ? 1 : 0);
