-- ============================================================
-- 0009_allow_gemini_provider.sql
-- La generación de imágenes con IA ahora prueba OpenAI primero y cae a
-- Gemini si OpenAI falla (ej. cuota agotada). Se vuelve a permitir 'gemini'
-- como valor de segments.media_provider para poder registrar ese fallback.
-- Pegar y ejecutar en el SQL Editor de Supabase (Dashboard).
-- ============================================================

alter table public.segments
  drop constraint if exists segments_media_provider_check;
alter table public.segments
  add constraint segments_media_provider_check
    check (media_provider in ('pexels', 'pixabay', 'openai', 'gemini'));
