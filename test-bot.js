require("dotenv").config();
const https = require("https");
const { createClient } = require("@supabase/supabase-js");

const OPENQUARRY_KEY = process.env.OPENQUARRY_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const VALID_UNITS = ['מפל"ג', "מחלקה 1", "מחלקה 2", "מחלקה 3", "חובשים"];
const RLM = "\u200f";

async function runTests() {
  console.log("🔍 [V3] מתחיל בסדרת בדיקות לוגיקה עמוקה...");

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data: roster } = await supabase.from("soldiers").select("name, unit");

  // --- טסט 1: שומר הסף ---
  console.log("\n🧪 טסט 1: שומר הסף (Gatekeeper)");
  const gatekeeperTests = [
    { text: "משה בבית", isGroup: true, expected: false }, // אמור להיחסם (אין כוכבית)
    { text: "*משה בבית", isGroup: true, expected: true }, // אמור לעבור
    { text: "***איפוס דוח", isGroup: true, expected: true }, // אמור לעבור
    { text: "בבסיס: אברהם\nבבית: יצחק", isGroup: true, expected: true }, // דוח מלא - אמור לעבור
    { text: "/id", isGroup: true, expected: true } // פקודה - אמור לעבור
  ];

  gatekeeperTests.forEach(t => {
    const isAsteriskStart = t.text.startsWith("*");
    const isFullReport = (t.text.includes("בבית:") || t.text.includes("בבסיס:")) && t.text.includes("\n");
    const isSlashCommand = t.text.startsWith("/");
    const passed = !t.isGroup || isAsteriskStart || isFullReport || isSlashCommand;
    console.log(`${passed === t.expected ? "✅" : "❌"} הודעה: "${t.text.substring(0,15)}..." | צפי: ${t.expected} | תוצאה: ${passed}`);
  });

  // --- טסט 2: AI עם שמות אמיתיים ---
  console.log("\n🧪 טסט 2: AI עם שמות מהמצבת");
  try {
    const testInput = "יוסי בבית, משה בבסיס";
    const aiResponse = await mockAskAi(testInput, roster.slice(0, 10));
    console.log("✅ תגובת ה-AI:", JSON.stringify(aiResponse));
    if (aiResponse.updates && aiResponse.updates.length > 0) {
        console.log(`   נמצאו ${aiResponse.updates.length} עדכונים.`);
    } else {
        console.warn("   ⚠️ AI לא זיהה עדכונים.");
    }
  } catch (e) { console.error("❌ טסט 2 נכשל:", e); }

  // --- טסט 3: תאריכים (ישראל) ---
  console.log("\n🧪 טסט 3: תאריכים (ישראל)");
  function getIsraelDateTest() {
    const now = new Date();
    const israelTime = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Jerusalem"}));
    return israelTime.toISOString().split('T')[0];
  }
  const dateStr = getIsraelDateTest();
  console.log(`   תאריך נוכחי בישראל: ${dateStr}`);
  if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
      console.log("✅ פורמט התאריך תקין.");
  } else {
      console.error("❌ פורמט התאריך לא תקין.");
  }
}

async function mockAskAi(input, data) {
  const prompt = `אתה סמב"ץ פלוגתי. מאגר: ${JSON.stringify(data.map(s => s.name))}.
  הודעה: "${input}". 
  JSON בלבד: {"type":"update", "updates":[{"name":"...", "status":"BASE/HOME", "mission":"..."}]}`;

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
        "X-Title": "Test-Bot"
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let b = ""; res.on("data", d => b += d);
      res.on("end", () => {
        try {
          const json = JSON.parse(b);
          if (json.error) return reject(json.error.message);
          const raw = json.choices[0].message.content;
          resolve(JSON.parse(raw.substring(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
        } catch (e) { reject("Parsing error: " + b); }
      });
    });
    req.on("error", reject);
    req.write(postData); req.end();
  });
}

function generateFixedReport(soldiers, dateString) {
  const dateObj = new Date(dateString);
  const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const d = String(dateObj.getDate()).padStart(2, '0'), m = String(dateObj.getMonth() + 1).padStart(2, '0');
  let r = `**דוח כ"א ליום ${days[dateObj.getDay()]} ${d}.${m}**\n\n`;
  VALID_UNITS.forEach((u) => {
    const unitSolds = soldiers.filter(s => s.unit === u);
    r += `*${u}:*\n`;
    if (unitSolds.length === 0) { r += `${RLM}--- \n`; return; }
    const inB = unitSolds.filter(s => s.status === "BASE"), inH = unitSolds.filter(s => s.status === "HOME");
    if (inB.length > 0) r += `🏡 בבסיס: ${inB.map(s => s.name).join(", ")}\n`;
    if (inH.length > 0) r += `🏠 בבית: ${inH.map(s => s.name).join(", ")}\n`;
  });
  return r;
}

runTests();
