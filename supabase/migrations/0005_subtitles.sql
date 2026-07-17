-- ============================================================
-- 0005_subtitles.sql
-- Subtítulos quemados en el video final, sincronizados con el
-- audio real de cada segmento.
-- Pegar y ejecutar en el SQL Editor de Supabase (Dashboard).
-- ============================================================

alter table public.projects
  add column subtitles_enabled boolean not null default false;
