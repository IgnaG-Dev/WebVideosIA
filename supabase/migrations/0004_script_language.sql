-- ============================================================
-- 0004_script_language.sql
-- Idioma del guion generado con IA (español o inglés).
-- Pegar y ejecutar en el SQL Editor de Supabase (Dashboard).
-- ============================================================

alter table public.projects
  add column script_language text not null default 'es'
    check (script_language in ('es', 'en'));
