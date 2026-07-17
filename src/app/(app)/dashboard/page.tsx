import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PROJECT_STATUS_LABEL } from "@/lib/status-labels";
import type { Project } from "@/lib/types";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: projects, error } = await supabase
    .from("projects")
    .select("*")
    .order("created_at", { ascending: false })
    .returns<Project[]>();

  const projectIds = projects?.map((p) => p.id) ?? [];
  const { data: thumbnails } = projectIds.length
    ? await supabase
        .from("segments")
        .select("project_id, image_url")
        .eq("order_index", 0)
        .in("project_id", projectIds)
    : { data: [] as { project_id: string; image_url: string | null }[] };

  const thumbnailByProject = new Map(
    (thumbnails ?? []).map((t) => [t.project_id, t.image_url]),
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Mis proyectos</h1>
        <Link
          href="/projects/new"
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background"
        >
          Nuevo proyecto
        </Link>
      </div>

      {error && (
        <p className="text-sm text-red-600">
          No se pudieron cargar los proyectos.
        </p>
      )}

      {!error && projects && projects.length === 0 && (
        <div className="rounded-lg border border-dashed border-black/10 px-6 py-12 text-center text-sm text-foreground/60">
          Todavía no creaste ningún proyecto.
        </div>
      )}

      {!error && projects && projects.length > 0 && (
        <ul className="flex flex-col gap-3">
          {projects.map((project) => {
            const thumbnail = thumbnailByProject.get(project.id);
            return (
              <li key={project.id}>
                <Link
                  href={`/projects/${project.id}`}
                  className="flex items-center gap-4 rounded-lg border border-black/10 px-4 py-3 hover:bg-black/[.02]"
                >
                  <div className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md bg-black/5">
                    {thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumbnail}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-xs text-foreground/30">
                        Sin miniatura
                      </span>
                    )}
                  </div>
                  <div className="flex-1">
                    <p className="font-medium">{project.title}</p>
                    <p className="text-xs text-foreground/60">
                      {project.script_mode === "ia" ? "Con IA" : "Manual"} ·{" "}
                      {project.target_duration_minutes} min ·{" "}
                      {new Date(project.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <span className="rounded-full bg-black/5 px-3 py-1 text-xs font-medium">
                    {PROJECT_STATUS_LABEL[project.status] ?? project.status}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
