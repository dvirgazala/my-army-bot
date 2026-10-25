# הפעלת הבוט מאפס

הבוט צריך 4 ערכים כדי לרוץ. הם **לא נמצאים על אף מחשב** — הם חיים בלוחות הבקרה בענן
שמקושרים לחשבונות שלך. אפשר לשחזר אותם או ליצור חדשים בכ-10 דקות.

## 1. הערכים שצריך (`.env`)

העתק את `.env.example` ל-`.env` ומלא:

| משתנה | מאיפה משיגים |
|---|---|
| `TELEGRAM_TOKEN` | טלגרם → `@BotFather` → `/mybots` → הבוט הקיים → **API Token**. (אם אבד — `/newbot` ליצירת חדש) |
| `GEMINI_KEY` | https://aistudio.google.com/apikey → **Create API key** (חינם) |
| `SUPABASE_URL` + `SUPABASE_KEY` | https://supabase.com → הפרויקט → **Project Settings → API**. `URL` = Project URL, `KEY` = service_role key |
| `DEPLOYMENT_NAME` | שם המבצע הנוכחי, למשל `שאגת הארי` |

> אם ה-Web Service הישן עדיין קיים ב-Render — כל הערכים כבר שם:
> Render → השירות → **Environment**. פשוט תעתיק משם.

## 2. מסד הנתונים (Supabase)

אם זה פרויקט Supabase **חדש**, ב-**SQL Editor** הרץ לפי הסדר:

1. `db/schema.sql` — יוצר את הטבלאות `soldiers` ו-`report_data`.
2. `db/seed_soldiers.sql` — טוען את מצבת 77 החיילים (נוצר אוטומטית מגיליון "כוח אדם").

> `seed_soldiers.sql` מכיל שמות אמיתיים ולכן **מוחרג מ-git** (הריפו ציבורי). הוא קיים רק מקומית.

אם ה-Supabase **הישן** עדיין חי — הנתונים כבר שם, דלג על שלב זה (או הרץ רק את ה-seed אם רוצים לרענן מצבת).

## 3. הרצה

### מקומית (לבדיקה)
```bash
npm install
npm test        # בדיקות לוגיקה - לא צריך מפתחות
npm start       # מריץ את הבוט (צריך .env מלא)
```

### בענן (24/7) — Render
1. Render → **New → Web Service** → חבר את ריפו `my-army-bot`.
2. Build: `npm install` · Start: `node bot.js`.
3. **Environment** → הוסף את 4 המשתנים מ-`.env`.
4. כל `git push` ל-`main` → deploy אוטומטי.
5. **Keep-alive:** ב-cron-job.org הגדר ping כל 10 דקות ל-URL של השירות (Render חינמי נרדם בלי זה).

## 4. אחרי העלייה
- ודא שה-Webhook נרשם (בלוג מופיע `🚀 גרסה 63 באוויר`).
- אם צריך לרשום ידנית מחדש, ראה את הפקודה ב-`CLAUDE.md` תחת Deployment.
- שלח `*דוח 1` בקבוצה כדי לבדוק שהכל עובד.
