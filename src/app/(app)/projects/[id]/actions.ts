"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function deleteProject(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = await createClient();
  await supabase.from("projects").delete().eq("id", id);

  redirect("/dashboard");
}

export async function moveSegment(
  projectId: string,
  segmentId: string,
  direction: "up" | "down",
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: segments, error } = await supabase
    .from("segments")
    .select("id, order_index")
    .eq("project_id", projectId)
    .order("order_index", { ascending: true });

  if (error || !segments) return;

  const index = segments.findIndex((s) => s.id === segmentId);
  if (index === -1) return;

  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= segments.length) return;

  const current = segments[index];
  const swapWith = segments[swapIndex];

  // El unique(project_id, order_index) impide escribir el valor final
  // directamente si todavía lo tiene el otro segmento — se pasa por un
  // valor temporal que ningún segmento usa.
  await supabase
    .from("segments")
    .update({ order_index: -1 })
    .eq("id", current.id);
  await supabase
    .from("segments")
    .update({ order_index: current.order_index })
    .eq("id", swapWith.id);
  await supabase
    .from("segments")
    .update({ order_index: swapWith.order_index })
    .eq("id", current.id);

  revalidatePath(`/projects/${projectId}`);
}

export type UpdateSegmentsState = { error: string | null };

export async function updateSegmentsContent(
  projectId: string,
  segments: { id: string; text: string; estimated_duration_seconds: number }[],
): Promise<UpdateSegmentsState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  for (const segment of segments) {
    if (!segment.text.trim()) {
      return { error: "Ningún segmento puede quedar vacío." };
    }
    if (
      !Number.isFinite(segment.estimated_duration_seconds) ||
      segment.estimated_duration_seconds <= 0
    ) {
      return { error: "La duración de cada segmento debe ser mayor a 0." };
    }
  }

  for (const segment of segments) {
    const { error } = await supabase
      .from("segments")
      .update({
        text: segment.text.trim(),
        estimated_duration_seconds: segment.estimated_duration_seconds,
        status: "pending",
      })
      .eq("id", segment.id);

    if (error) {
      return { error: "No se pudieron guardar los cambios." };
    }
  }

  revalidatePath(`/projects/${projectId}`);
  return { error: null };
}

export async function startVideoGeneration(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error: updateError } = await supabase
    .from("projects")
    .update({ status: "queued", error_message: null })
    .eq("id", projectId);

  if (!updateError) {
    // job_queue no tiene policies para authenticated/anon — insert con admin.
    const admin = createAdminClient();
    await admin.from("job_queue").insert({
      project_id: projectId,
      task_type: "generate_video",
      status: "pending",
    });
  }

  revalidatePath(`/projects/${projectId}`);
}
