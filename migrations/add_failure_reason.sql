-- Run this in the Supabase SQL Editor:
-- https://app.supabase.com/project/adwluvwvemzrfpgukhtc/sql

ALTER TABLE visitor_analytics
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS failure_error  text;
