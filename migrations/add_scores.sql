-- Add trackability score columns to artworks table
ALTER TABLE artworks
  ADD COLUMN IF NOT EXISTS score_features     SMALLINT,
  ADD COLUMN IF NOT EXISTS score_distribution SMALLINT,
  ADD COLUMN IF NOT EXISTS score_contrast     SMALLINT,
  ADD COLUMN IF NOT EXISTS score_uniqueness   SMALLINT,
  ADD COLUMN IF NOT EXISTS score_total        SMALLINT;
