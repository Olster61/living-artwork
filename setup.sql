-- Run this in the Supabase SQL Editor (Project → SQL Editor → New query)
-- URL: https://supabase.com/dashboard/project/adwluvwvemzrfpgukhtc/sql

-- Customers table
CREATE TABLE IF NOT EXISTS public.customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Artworks table
CREATE TABLE IF NOT EXISTS public.artworks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  trigger_url text,
  video_url   text,
  mind_url    text,
  created_at  timestamptz DEFAULT now()
);

-- Enable RLS (service role key bypasses this, anon key will be blocked)
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.artworks ENABLE ROW LEVEL SECURITY;

-- Optional: allow all for now (restrict later per customer auth)
-- CREATE POLICY "allow all" ON public.customers FOR ALL USING (true);
-- CREATE POLICY "allow all" ON public.artworks FOR ALL USING (true);
