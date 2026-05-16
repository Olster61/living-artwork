-- Run this in the Supabase SQL Editor:
-- https://app.supabase.com/project/adwluvwvemzrfpgukhtc/sql

CREATE TABLE IF NOT EXISTS idea_categories (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE idea_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all" ON idea_categories FOR ALL USING (true) WITH CHECK (true);

-- Pre-populate with default categories (in display order)
INSERT INTO idea_categories (name) VALUES
  ('Marketing'),
  ('Technology'),
  ('Animation'),
  ('Business'),
  ('Artwork'),
  ('Research'),
  ('Other')
ON CONFLICT (name) DO NOTHING;
