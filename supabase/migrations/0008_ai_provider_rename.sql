-- ============================================================
-- 0008_ai_provider_rename.sql
-- La generación de imágenes con IA pasa de Gemini a OpenAI (gpt-image-1).
-- Se renombran los valores internos 'gemini' -> 'ai' (projects.media_preference)
-- y 'gemini' -> 'openai' (segments.media_provider) para que dejen de ser
-- confusos ahora que ya no llaman a la API de Gemini.
-- Pegar y ejecutar en el SQL Editor de Supabase (Dashboard).
-- ============================================================

update public.projects set media_preference = 'ai' where media_preference = 'gemini';
update public.segments set media_provider = 'openai' where media_provider = 'gemini';

alter table public.projects
  drop constraint if exists projects_media_preference_check;
alter table public.projects
  add constraint projects_media_preference_check
    check (media_preference in ('image', 'video', 'ai'));

alter table public.segments
  drop constraint if exists segments_media_provider_check;
alter table public.segments
  add constraint segments_media_provider_check
    check (media_provider in ('pexels', 'pixabay', 'openai'));
