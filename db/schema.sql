-- סכמת מסד הנתונים לבוט הסמב"ץ (Supabase / PostgreSQL)
-- בטוח ל-commit: אין כאן PII. הרץ ב-Supabase SQL Editor.

create table if not exists soldiers (
  id bigint generated always as identity primary key,
  name text not null,
  unit text not null,
  is_active boolean not null default true
);

create table if not exists report_data (
  id bigint generated always as identity primary key,
  name text not null,
  status text not null default 'BASE',   -- BASE / HOME
  mission text default 'ללא משימה',
  report_date date not null,
  deployment_name text,
  unique (name, report_date)             -- נדרש ל-onConflict של ה-upsert
);

create index if not exists idx_report_date on report_data(report_date);
create index if not exists idx_soldiers_active on soldiers(is_active);
