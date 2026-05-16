-- Run this in the Supabase SQL Editor:
-- https://app.supabase.com/project/adwluvwvemzrfpgukhtc/sql

CREATE TABLE IF NOT EXISTS ideas (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text        NOT NULL,
  category   text        NOT NULL,
  notes      text,
  file_url   text,
  file_type  text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE ideas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all" ON ideas FOR ALL USING (true) WITH CHECK (true);
