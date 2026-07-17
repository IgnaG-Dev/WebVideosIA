"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  searchDifferentMedia,
  downloadMedia,
  extractKeywords,
  extensionFromContentType,
  type MediaType,
} from "@/lib/stock-media";
import { generateImageWithGemini, buildImagePrompt } from "@/lib/gemini";
import type {
  MediaPreference,
  SegmentAnimation,
  SegmentTransition,
} from "@/lib/types";

const ASSETS_BUCKET = "project-assets";

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

/**
 * Reordena un conjunto arbitrario de segmentos (drag & drop), no solo un
 * swap entre vecinos. Pasa por índices temporales negativos para no chocar
 * con el unique(project_id, order_index) sea cual sea el nuevo orden.
 */
export async function reorderSegments(projectId: string, orderedIds: string[]) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  for (let i = 0; i < orderedIds.length; i++) {
    await supabase
      .from("segments")
      .update({ order_index: -(i + 1) })
      .eq("id", orderedIds[i]);
  }
  for (let i = 0; i < orderedIds.length; i++) {
    await supabase
      .from("segments")
      .update({ order_index: i })
      .eq("id", orderedIds[i]);
  }

  await markProjectStaleIfDone(supabase, projectId);

  revalidatePath(`/projects/${projectId}`);
}

// Si el proyecto ya estaba "done" y se edita algo (texto, orden, imagen),
// el video existente queda desactualizado: se vuelve a "script_ready" para
// que aparezca el botón de regenerar y se oculte el reproductor viejo.
async function markProjectStaleIfDone(
  supabase: SupabaseClient,
  projectId: string,
) {
  const { data: project } = await supabase
    .from("projects")
    .select("status")
    .eq("id", projectId)
    .maybeSingle();

  if (project?.status === "done") {
    await supabase
      .from("projects")
      .update({ status: "script_ready", video_url: null })
      .eq("id", projectId);
  }
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

  const { data: currentRows } = await supabase
    .from("segments")
    .select("id, text, audio_url")
    .in(
      "id",
      segments.map((s) => s.id),
    );
  const currentById = new Map((currentRows ?? []).map((s) => [s.id, s]));

  for (const segment of segments) {
    const current = currentById.get(segment.id);
    const textChanged = current && current.text !== segment.text.trim();

    const update: Record<string, unknown> = {
      text: segment.text.trim(),
      status: "pending",
    };
    // La duración real siempre la termina marcando el audio (ffmpeg usa
    // -shortest). Antes de generar audio todavía es solo una estimación y
    // se puede ajustar; una vez que hay audio real, no se toca acá — la
    // actualiza el worker con la duración medida.
    if (!current?.audio_url) {
      update.estimated_duration_seconds = segment.estimated_duration_seconds;
    }
    // El audio narra el texto viejo — si el texto cambió, hay que
    // regenerarlo (el worker lo hace de nuevo porque audio_url queda null).
    if (textChanged) {
      update.audio_url = null;
    }

    const { error } = await supabase
      .from("segments")
      .update(update)
      .eq("id", segment.id);

    if (error) {
      return { error: "No se pudieron guardar los cambios." };
    }
  }

  await markProjectStaleIfDone(supabase, projectId);

  revalidatePath(`/projects/${projectId}`);
  return { error: null };
}

export type ReplaceImageState = { error: string | null };

/** Busca de nuevo una imagen o video de stock para este segmento (misma keyword). */
export async function replaceSegmentImage(
  projectId: string,
  segmentId: string,
  preferredType: MediaType = "image",
): Promise<ReplaceImageState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: segment } = await supabase
    .from("segments")
    .select("text")
    .eq("id", segmentId)
    .maybeSingle();
  if (!segment) return { error: "Segmento no encontrado." };

  const keywords = extractKeywords(segment.text);
  const result = await searchDifferentMedia(keywords, preferredType);
  if (!result) {
    return { error: `No se encontró contenido nuevo para "${keywords}".` };
  }

  try {
    const { bytes, contentType } = await downloadMedia(result.url);
    const extension = extensionFromContentType(contentType);
    const admin = createAdminClient();
    const storagePath = `${projectId}/segments/${segmentId}/image-${Date.now()}.${extension}`;

    const { error: uploadError } = await admin.storage
      .from(ASSETS_BUCKET)
      .upload(storagePath, bytes, { contentType, upsert: true });
    if (uploadError) {
      return { error: "No se pudo subir la nueva imagen." };
    }

    const { data: publicUrlData } = admin.storage
      .from(ASSETS_BUCKET)
      .getPublicUrl(storagePath);

    await supabase
      .from("segments")
      .update({
        image_url: publicUrlData.publicUrl,
        media_type: result.type,
        media_provider: result.provider,
        status: "pending",
      })
      .eq("id", segmentId);

    await markProjectStaleIfDone(supabase, projectId);

    revalidatePath(`/projects/${projectId}`);
    return { error: null };
  } catch {
    return { error: "No se pudo descargar/subir la nueva imagen." };
  }
}

/** Genera una imagen con Gemini para este segmento a partir de su texto. */
export async function generateSegmentImageWithGemini(
  projectId: string,
  segmentId: string,
): Promise<ReplaceImageState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: segment } = await supabase
    .from("segments")
    .select("text")
    .eq("id", segmentId)
    .maybeSingle();
  if (!segment) return { error: "Segmento no encontrado." };

  try {
    const { bytes, contentType } = await generateImageWithGemini(
      buildImagePrompt(segment.text),
    );
    const extension = extensionFromContentType(contentType);
    const admin = createAdminClient();
    const storagePath = `${projectId}/segments/${segmentId}/image-${Date.now()}.${extension}`;

    const { error: uploadError } = await admin.storage
      .from(ASSETS_BUCKET)
      .upload(storagePath, bytes, { contentType, upsert: true });
    if (uploadError) {
      return { error: "No se pudo subir la imagen generada." };
    }

    const { data: publicUrlData } = admin.storage
      .from(ASSETS_BUCKET)
      .getPublicUrl(storagePath);

    await supabase
      .from("segments")
      .update({
        image_url: publicUrlData.publicUrl,
        media_type: "image",
        media_provider: "gemini",
        status: "pending",
      })
      .eq("id", segmentId);

    await markProjectStaleIfDone(supabase, projectId);

    revalidatePath(`/projects/${projectId}`);
    return { error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `No se pudo generar la imagen con Gemini: ${message}` };
  }
}

/** Sube una imagen propia para reemplazar la de un segmento. */
export async function uploadSegmentImage(
  projectId: string,
  segmentId: string,
  formData: FormData,
): Promise<ReplaceImageState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Elegí un archivo de imagen." };
  }
  if (!file.type.startsWith("image/")) {
    return { error: "El archivo tiene que ser una imagen." };
  }
  if (file.size > 8 * 1024 * 1024) {
    return { error: "La imagen no puede superar los 8MB." };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const extension = extensionFromContentType(file.type);
  const admin = createAdminClient();
  const storagePath = `${projectId}/segments/${segmentId}/image-${Date.now()}.${extension}`;

  const { error: uploadError } = await admin.storage
    .from(ASSETS_BUCKET)
    .upload(storagePath, bytes, { contentType: file.type, upsert: true });
  if (uploadError) {
    return { error: "No se pudo subir la imagen." };
  }

  const { data: publicUrlData } = admin.storage
    .from(ASSETS_BUCKET)
    .getPublicUrl(storagePath);

  await supabase
    .from("segments")
    .update({
      image_url: publicUrlData.publicUrl,
      media_type: "image",
      media_provider: null,
      status: "pending",
    })
    .eq("id", segmentId);

  await markProjectStaleIfDone(supabase, projectId);

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

export async function updateMediaPreference(
  projectId: string,
  mediaPreference: MediaPreference,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase
    .from("projects")
    .update({ media_preference: mediaPreference })
    .eq("id", projectId);

  revalidatePath(`/projects/${projectId}`);
}

export async function updateSegmentAnimation(
  projectId: string,
  segmentId: string,
  animation: SegmentAnimation,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase.from("segments").update({ animation }).eq("id", segmentId);
  await markProjectStaleIfDone(supabase, projectId);
  revalidatePath(`/projects/${projectId}`);
}

export async function updateSegmentTransition(
  projectId: string,
  segmentId: string,
  transition: SegmentTransition,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase.from("segments").update({ transition }).eq("id", segmentId);
  await markProjectStaleIfDone(supabase, projectId);
  revalidatePath(`/projects/${projectId}`);
}

/** Aplica la misma animación a todos los segmentos del proyecto. */
export async function applyAnimationToAllSegments(
  projectId: string,
  animation: SegmentAnimation,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase
    .from("segments")
    .update({ animation })
    .eq("project_id", projectId);
  await markProjectStaleIfDone(supabase, projectId);
  revalidatePath(`/projects/${projectId}`);
}

/** Aplica la misma transición a todos los segmentos del proyecto. */
export async function applyTransitionToAllSegments(
  projectId: string,
  transition: SegmentTransition,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase
    .from("segments")
    .update({ transition })
    .eq("project_id", projectId);
  await markProjectStaleIfDone(supabase, projectId);
  revalidatePath(`/projects/${projectId}`);
}
