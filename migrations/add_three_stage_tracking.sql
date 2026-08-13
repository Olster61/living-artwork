-- Three-stage AR tracking + artwork identifier
-- Run in the Supabase SQL Editor:
-- https://app.supabase.com/project/adwluvwvemzrfpgukhtc/sql/new
--
-- Replaces the single ar_loaded boolean with three granular stage booleans.
-- Also adds artwork_slug (which artwork was scanned) and the failure columns
-- from the previous migration that was never applied to the live database.

ALTER TABLE visitor_analytics
  ADD COLUMN IF NOT EXISTS scanner_loaded      boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS artwork_recognized  boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS animation_played    boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS artwork_slug        text,
  ADD COLUMN IF NOT EXISTS failure_reason      text,
  ADD COLUMN IF NOT EXISTS failure_error       text;
