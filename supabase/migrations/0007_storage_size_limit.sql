-- ============================================================
-- 0007_storage_size_limit.sql
-- El bucket "project-assets" se creó sin file_size_limit explícito
-- (ver 0001_init_schema.sql), así que cae en el límite por defecto
-- de Supabase Storage (50MB) — muy poco para el video final de un
-- proyecto de 15-20 minutos. Se sube a 500MB.
-- Pegar y ejecutar en el SQL Editor de Supabase (Dashboard).
-- ============================================================

update storage.buckets
set file_size_limit = 524288000 -- 500 MB
where id = 'project-assets';
