-- ============================================================
-- 0001_init_schema.sql
-- Plataforma de generación de videos con IA — esquema inicial
-- Pegar y ejecutar en el SQL Editor de Supabase (Dashboard).
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- Trigger helper: mantiene updated_at al día en cada UPDATE
-- ------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ------------------------------------------------------------
-- Tabla: projects
-- ------------------------------------------------------------
create table public.projects (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users(id) on delete cascade,
  title                     text not null,
  script_mode               text not null check (script_mode in ('manual', 'ia')),
  status                    text not null default 'draft' check (status in (
                              'draft', 'generating_script', 'script_ready', 'queued',
                              'generating_images', 'generating_audio', 'assembling',
                              'done', 'error'
                            )),
  target_duration_minutes  int not null check (target_duration_minutes between 5 and 30),
  topic                     text,
  tone                      text,
  audience                  text,
  full_script               text,
  video_url                 text,
  error_message             text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index projects_user_id_idx on public.projects (user_id);

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- Tabla: segments
-- ------------------------------------------------------------
create table public.segments (
  id                          uuid primary key default gen_random_uuid(),
  project_id                  uuid not null references public.projects(id) on delete cascade,
  order_index                  int not null,
  text                         text not null,
  estimated_duration_seconds   numeric not null,
  image_url                    text,
  media_type                   text check (media_type in ('image', 'video')),
  media_provider                text check (media_provider in ('pexels', 'pixabay', 'gemini')),
  audio_url                    text,
  status                       text not null default 'pending' check (status in (
                                 'pending', 'image_ready', 'audio_ready', 'ready', 'error'
                               )),
  error_message                text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  unique (project_id, order_index)
);

create index segments_project_id_idx on public.segments (project_id, order_index);

create trigger segments_set_updated_at
  before update on public.segments
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- Tabla: job_queue  (reemplaza a n8n — cola simple para el worker)
-- ------------------------------------------------------------
create table public.job_queue (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  task_type    text not null check (task_type in ('generate_script', 'generate_video')),
  status       text not null default 'pending' check (status in (
                 'pending', 'processing', 'done', 'error'
               )),
  attempts     int not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index job_queue_status_idx on public.job_queue (status, created_at);

create trigger job_queue_set_updated_at
  before update on public.job_queue
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- RLS: projects — el usuario solo ve/edita sus propios proyectos
-- ------------------------------------------------------------
alter table public.projects enable row level security;

create policy "projects_select_own"
  on public.projects for select
  using (auth.uid() = user_id);

create policy "projects_insert_own"
  on public.projects for insert
  with check (auth.uid() = user_id);

create policy "projects_update_own"
  on public.projects for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "projects_delete_own"
  on public.projects for delete
  using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- RLS: segments — accesibles solo si el proyecto es del usuario
-- ------------------------------------------------------------
alter table public.segments enable row level security;

create policy "segments_select_own"
  on public.segments for select
  using (
    exists (
      select 1 from public.projects
      where projects.id = segments.project_id
        and projects.user_id = auth.uid()
    )
  );

create policy "segments_insert_own"
  on public.segments for insert
  with check (
    exists (
      select 1 from public.projects
      where projects.id = segments.project_id
        and projects.user_id = auth.uid()
    )
  );

create policy "segments_update_own"
  on public.segments for update
  using (
    exists (
      select 1 from public.projects
      where projects.id = segments.project_id
        and projects.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects
      where projects.id = segments.project_id
        and projects.user_id = auth.uid()
    )
  );

create policy "segments_delete_own"
  on public.segments for delete
  using (
    exists (
      select 1 from public.projects
      where projects.id = segments.project_id
        and projects.user_id = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- RLS: job_queue — sin policies para anon/authenticated.
-- Solo el worker (cliente con SUPABASE_SERVICE_ROLE_KEY, que
-- bypassea RLS) puede leer/escribir. Los inserts desde la app
-- se hacen siempre desde Route Handlers server-side con el
-- cliente admin, nunca desde el browser.
-- ------------------------------------------------------------
alter table public.job_queue enable row level security;

-- ------------------------------------------------------------
-- Storage: bucket para imágenes/audio/video de cada proyecto.
-- Lectura pública (para poder reproducir el video final con
-- <video src>), escritura solo vía service_role.
-- Convención de paths:
--   {project_id}/segments/{segment_id}/image.*
--   {project_id}/segments/{segment_id}/audio.mp3
--   {project_id}/final/video.mp4
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('project-assets', 'project-assets', true)
on conflict (id) do nothing;

create policy "project_assets_public_read"
  on storage.objects for select
  using (bucket_id = 'project-assets');
