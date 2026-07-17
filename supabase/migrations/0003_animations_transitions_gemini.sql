-- ============================================================
-- 0003_animations_transitions_gemini.sql
-- Animaciones (Ken Burns) y transiciones por segmento, + Gemini
-- como opción de generación de imágenes.
-- Pegar y ejecutar en el SQL Editor de Supabase (Dashboard).
-- ============================================================

alter table public.segments
  add column animation text not null default 'zoom_in'
    check (animation in (
      'none', 'zoom_in', 'zoom_out',
      'pan_left', 'pan_right', 'pan_up', 'pan_down'
    )),
  add column transition text not null default 'cut'
    check (transition in ('cut', 'crossfade'));

alter table public.projects
  drop constraint if exists projects_media_preference_check;
alter table public.projects
  add constraint projects_media_preference_check
    check (media_preference in ('image', 'video', 'gemini'));
