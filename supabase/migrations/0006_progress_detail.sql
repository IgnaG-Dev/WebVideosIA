-- ============================================================
-- 0006_progress_detail.sql
-- Detalle de progreso para pasos que hoy son una caja negra para
-- el usuario (continuación del guion, render de clips, armado
-- final del video, subida a Storage).
-- Pegar y ejecutar en el SQL Editor de Supabase (Dashboard).
-- ============================================================

alter table public.projects
  add column progress_step text,
  add column progress_current integer not null default 0,
  add column progress_total integer not null default 0;
