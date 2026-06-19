-- Run this in the Supabase SQL Editor:
-- https://app.supabase.com/project/adwluvwvemzrfpgukhtc/sql

CREATE TABLE IF NOT EXISTS visitor_analytics (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_type          text,
  browser_name         text,
  browser_version      text,
  os_name              text,
  os_version           text,
  ar_loaded            boolean,
  compat_warning_shown boolean,
  created_at           timestamptz DEFAULT now()
);

ALTER TABLE visitor_analytics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all" ON visitor_analytics FOR ALL USING (true) WITH CHECK (true);
