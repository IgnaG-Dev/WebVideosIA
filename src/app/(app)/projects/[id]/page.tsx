import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PROJECT_STATUS_LABEL } from "@/lib/status-labels";
import type { Project, Segment } from "@/lib/types";
import { deleteProject, startVideoGeneration } from "./actions";
import { SegmentsEditor } from "./segments-editor";
import { ProjectProgress } from "./progress";
import { MediaPreferenceSelector } from "./media-preference-selector";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .maybeSingle<Project>();

  if (!project) {
    notFound();
  }

  const { data: segments } = await supabase
    .from("segments")
    .select("*")
    .eq("project_id", id)
    .order("order_index", { ascending: true })
    .returns<Segment[]>();

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{project.title}</h1>
        <span className="rounded-full bg-black/5 px-3 py-1 text-xs font-medium">
          {PROJECT_STATUS_LABEL[project.status]}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-foreground/60">Modo</dt>
          <dd>{project.script_mode === "ia" ? "Con IA" : "Manual"}</dd>
        </div>
        <div>
          <dt className="text-foreground/60">Duración objetivo</dt>
          <dd>{project.target_duration_minutes} min</dd>
        </div>
        <div>
          <dt className="text-foreground/60">Contenido visual</dt>
          <dd>
            {project.media_preference === "video"
              ? "Videos"
              : project.media_preference === "ai"
                ? "Generado con IA"
                : "Imágenes"}
          </dd>
        </div>
        <div>
          <dt className="text-foreground/60">Creado</dt>
          <dd>{new Date(project.created_at).toLocaleString()}</dd>
        </div>
      </dl>

      {project.script_mode === "ia" && (
        <div className="flex flex-col gap-1 text-sm">
          <p>
            <span className="text-foreground/60">Tema:</span> {project.topic}
          </p>
          <p>
            <span className="text-foreground/60">Tono:</span> {project.tone}
          </p>
          <p>
            <span className="text-foreground/60">Público:</span>{" "}
            {project.audience}
          </p>
        </div>
      )}

      {project.status === "done" && project.video_url && (
        <div className="flex flex-col gap-2">
          <span className="text-sm text-foreground/60">Video final</span>
          <video
            controls
            src={project.video_url}
            className="w-full rounded-md border border-black/10"
          />
        </div>
      )}

      {(() => {
        const hasSegments = !!segments && segments.length > 0;
        const canEdit =
          hasSegments &&
          (project.status === "script_ready" ||
            project.status === "error" ||
            project.status === "done");

        if (canEdit) {
          return (
            <>
              <SegmentsEditor projectId={project.id} segments={segments!} />
              <MediaPreferenceSelector
                projectId={project.id}
                mediaPreference={project.media_preference}
              />
              <form action={startVideoGeneration}>
                <input type="hidden" name="projectId" value={project.id} />
                <button
                  type="submit"
                  className="self-start rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background"
                >
                  {project.status === "done"
                    ? "Regenerar video"
                    : "Generar video"}
                </button>
              </form>
            </>
          );
        }

        if (hasSegments) {
          return (
            <div className="flex flex-col gap-2 text-sm">
              <span className="text-foreground/60">
                Segmentos ({segments!.length})
              </span>
              <ol className="flex flex-col gap-2">
                {segments!.map((segment) => (
                  <li
                    key={segment.id}
                    className="flex gap-3 rounded-md border border-black/10 px-3 py-2"
                  >
                    <span className="shrink-0 text-foreground/40">
                      {segment.order_index + 1}
                    </span>
                    <p className="flex-1 whitespace-pre-wrap">
                      {segment.text}
                    </p>
                  </li>
                ))}
              </ol>
            </div>
          );
        }

        return (
          project.full_script && (
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-foreground/60">Guion</span>
              <p className="whitespace-pre-wrap rounded-md border border-black/10 px-3 py-2">
                {project.full_script}
              </p>
            </div>
          )
        );
      })()}

      <ProjectProgress projectId={project.id} initialStatus={project.status} />

      {project.error_message && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {project.error_message}
        </p>
      )}

      <form action={deleteProject}>
        <input type="hidden" name="id" value={project.id} />
        <button type="submit" className="text-sm text-red-600 underline">
          Eliminar proyecto
        </button>
      </form>
    </div>
  );
}
