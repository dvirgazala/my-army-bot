// טעינת/רענון מצבת ל-Supabase מתוך db/roster.json (מוחרג מ-git, PII).
// הרצה: node load_roster.js
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const roster = require("./db/roster.json");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

(async () => {
  const { error: delErr } = await supabase.from("soldiers").delete().neq("name", "__none__");
  if (delErr) { console.error("delete failed:", delErr.message); process.exit(1); }

  const rows = roster.map(s => ({ name: s.name, unit: s.unit, is_active: true }));
  const { error: insErr } = await supabase.from("soldiers").insert(rows);
  if (insErr) { console.error("insert failed:", insErr.message); process.exit(1); }

  const { count } = await supabase.from("soldiers").select("*", { count: "exact", head: true });
  console.log("OK — soldiers in DB:", count, "| inserted:", rows.length);
})();
