-- ============================================================
-- 0002_media_preference.sql
-- Elegir imagen o video del banco de stock para los segmentos.
-- Pegar y ejecutar en el SQL Editor de Supabase (Dashboard).
-- ============================================================

alter table public.projects
  add column media_preference text not null default 'image'
    check (media_preference in ('image', 'video'));
