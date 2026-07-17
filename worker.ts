import { config } from "dotenv";
config({ path: ".env.local" });

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "./src/lib/supabase/admin";
import { generateScript, segmentScript } from "./src/lib/openai";
import { searchMedia, downloadMedia } from "./src/lib/stock-media";
import { synthesizeSpeech } from "./src/lib/tts";
import { assembleSegmentsToVideo, type SegmentAsset } from "./src/lib/ffmpeg";

const POLL_INTERVAL_MS = 5000;
const SEGMENT_CONCURRENCY = 3;
const ASSETS_BUCKET = "project-assets";

const SPANISH_STOPWORDS = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al",
  "a", "en", "y", "o", "u", "que", "es", "son", "para", "por", "con", "su",
  "sus", "se", "lo", "le", "les", "como", "mas", "pero", "si", "no", "ya",
  "muy", "esto", "esta", "este", "estos", "estas", "eso", "esa", "ese",
  "tambien", "cuando", "donde", "porque", "sobre", "entre", "hay", "ser",
  "estar", "asi", "sin", "todo", "toda", "todos", "todas", "nos", "les",
]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractKeywords(text: string, maxWords = 6): string {
  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !SPANISH_STOPWORDS.has(w));

  const keywords = words.slice(0, maxWords).join(" ");
  return keywords || text.slice(0, 60);
}

function extensionFromContentType(contentType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
  };
  return map[contentType] ?? contentType.split("/")[1]?.split(";")[0] ?? "bin";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await task(items[current], current);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

type JobRow = {
  id: string;
  project_id: string;
  task_type: "generate_script" | "generate_video";
  attempts: number;
};

async function claimNextJob(admin: SupabaseClient): Promise<JobRow | null> {
  const { data: candidates } = await admin
    .from("job_queue")
    .select("id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1);

  if (!candidates || candidates.length === 0) return null;

  const { data: claimed } = await admin
    .from("job_queue")
    .update({ status: "processing" })
    .eq("id", candidates[0].id)
    .eq("status", "pending")
    .select("id, project_id, task_type, attempts")
    .maybeSingle<JobRow>();

  return claimed ?? null;
}

// ---------------------------------------------------------------------------
// generate_script
// ---------------------------------------------------------------------------

async function processGenerateScript(admin: SupabaseClient, projectId: string) {
  const { data: project, error } = await admin
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error || !project) throw new Error("Proyecto no encontrado.");

  if (!project.topic || !project.tone || !project.audience) {
    throw new Error("Faltan tema, tono o público para generar el guion.");
  }

  const fullScript = await generateScript({
    topic: project.topic,
    tone: project.tone,
    audience: project.audience,
    targetDurationMinutes: project.target_duration_minutes,
  });

  const segments = await segmentScript({
    fullScript,
    targetDurationMinutes: project.target_duration_minutes,
  });

  const { error: projectUpdateError } = await admin
    .from("projects")
    .update({ full_script: fullScript, status: "script_ready" })
    .eq("id", projectId);
  if (projectUpdateError) {
    throw new Error("No se pudo guardar el guion generado.");
  }

  const { error: segmentsError } = await admin.from("segments").insert(
    segments.map((segment) => ({
      project_id: projectId,
      order_index: segment.order_index,
      text: segment.text,
      estimated_duration_seconds: segment.estimated_duration_seconds,
      status: "pending",
    })),
  );
  if (segmentsError) {
    throw new Error("No se pudieron guardar los segmentos del guion.");
  }
}

// ---------------------------------------------------------------------------
// generate_video
// ---------------------------------------------------------------------------

type SegmentRow = {
  id: string;
  text: string;
};

async function fetchAndUploadImage(
  admin: SupabaseClient,
  projectId: string,
  segment: SegmentRow,
) {
  const keywords = extractKeywords(segment.text);
  const result = await searchMedia(keywords);
  if (!result) {
    throw new Error(
      `No se encontró imagen/video para las palabras clave: "${keywords}".`,
    );
  }

  const { bytes, contentType } = await downloadMedia(result.url);
  const extension = extensionFromContentType(contentType);
  const path = `${projectId}/segments/${segment.id}/image.${extension}`;

  const { error: uploadError } = await admin.storage
    .from(ASSETS_BUCKET)
    .upload(path, bytes, { contentType, upsert: true });
  if (uploadError) {
    throw new Error(
      `No se pudo subir el media a Storage: ${uploadError.message}`,
    );
  }

  const { data: publicUrlData } = admin.storage
    .from(ASSETS_BUCKET)
    .getPublicUrl(path);

  await admin
    .from("segments")
    .update({
      image_url: publicUrlData.publicUrl,
      media_type: result.type,
      media_provider: result.provider,
    })
    .eq("id", segment.id);
}

async function fetchAndUploadAudio(
  admin: SupabaseClient,
  projectId: string,
  segment: SegmentRow,
) {
  const { bytes, contentType } = await synthesizeSpeech(segment.text);
  const path = `${projectId}/segments/${segment.id}/audio.mp3`;

  const { error: uploadError } = await admin.storage
    .from(ASSETS_BUCKET)
    .upload(path, bytes, { contentType, upsert: true });
  if (uploadError) {
    throw new Error(
      `No se pudo subir el audio a Storage: ${uploadError.message}`,
    );
  }

  const { data: publicUrlData } = admin.storage
    .from(ASSETS_BUCKET)
    .getPublicUrl(path);

  await admin
    .from("segments")
    .update({ audio_url: publicUrlData.publicUrl })
    .eq("id", segment.id);
}

// Imagen y audio de un segmento se buscan/generan en paralelo (son APIs
// externas independientes) en vez de en dos fases secuenciales — reduce a
// la mitad el tiempo de esta etapa.
async function processSegmentMedia(
  admin: SupabaseClient,
  projectId: string,
  segment: SegmentRow,
) {
  const [imageResult, audioResult] = await Promise.allSettled([
    fetchAndUploadImage(admin, projectId, segment),
    fetchAndUploadAudio(admin, projectId, segment),
  ]);

  if (imageResult.status === "fulfilled" && audioResult.status === "fulfilled") {
    await admin
      .from("segments")
      .update({ status: "ready", error_message: null })
      .eq("id", segment.id);
    return;
  }

  const messages: string[] = [];
  if (imageResult.status === "rejected") {
    messages.push(`Imagen: ${errorMessage(imageResult.reason)}`);
  }
  if (audioResult.status === "rejected") {
    messages.push(`Audio: ${errorMessage(audioResult.reason)}`);
  }
  await admin
    .from("segments")
    .update({ status: "error", error_message: messages.join(" | ") })
    .eq("id", segment.id);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function processGenerateVideo(admin: SupabaseClient, projectId: string) {
  const { data: segments, error } = await admin
    .from("segments")
    .select("id, text")
    .eq("project_id", projectId)
    .order("order_index", { ascending: true })
    .returns<SegmentRow[]>();

  if (error || !segments || segments.length === 0) {
    throw new Error("El proyecto no tiene segmentos para procesar.");
  }

  await admin
    .from("projects")
    .update({ status: "generating_images" })
    .eq("id", projectId);
  await mapWithConcurrency(segments, SEGMENT_CONCURRENCY, (segment) =>
    processSegmentMedia(admin, projectId, segment),
  );

  const { data: finalSegments } = await admin
    .from("segments")
    .select("id, status")
    .eq("project_id", projectId);
  const failed = (finalSegments ?? []).filter((s) => s.status === "error");
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} de ${segments.length} segmento(s) fallaron al generar imagen/audio.`,
    );
  }

  await admin
    .from("projects")
    .update({ status: "assembling" })
    .eq("id", projectId);

  await processAssembly(admin, projectId);
}

type AssemblySegmentRow = {
  order_index: number;
  media_type: "image" | "video" | null;
  image_url: string | null;
  audio_url: string | null;
};

async function processAssembly(admin: SupabaseClient, projectId: string) {
  const { data: segments, error } = await admin
    .from("segments")
    .select("order_index, media_type, image_url, audio_url")
    .eq("project_id", projectId)
    .order("order_index", { ascending: true })
    .returns<AssemblySegmentRow[]>();

  if (error || !segments || segments.length === 0) {
    throw new Error("El proyecto no tiene segmentos para armar el video.");
  }

  const assets = await mapWithConcurrency(
    segments,
    SEGMENT_CONCURRENCY,
    async (segment): Promise<SegmentAsset> => {
      if (!segment.image_url || !segment.audio_url) {
        throw new Error(
          `El segmento ${segment.order_index + 1} no tiene imagen/video o audio listos.`,
        );
      }
      const [media, audio] = await Promise.all([
        downloadMedia(segment.image_url),
        downloadMedia(segment.audio_url),
      ]);
      return {
        mediaType: segment.media_type === "video" ? "video" : "image",
        mediaBytes: media.bytes,
        mediaExtension: extensionFromContentType(media.contentType),
        audioBytes: audio.bytes,
      };
    },
  );

  const finalVideoBytes = await assembleSegmentsToVideo(assets);

  const finalPath = `${projectId}/final/video.mp4`;
  const { error: uploadError } = await admin.storage
    .from(ASSETS_BUCKET)
    .upload(finalPath, finalVideoBytes, { contentType: "video/mp4", upsert: true });
  if (uploadError) {
    throw new Error(`No se pudo subir el video final: ${uploadError.message}`);
  }

  const { data: publicUrlData } = admin.storage
    .from(ASSETS_BUCKET)
    .getPublicUrl(finalPath);

  await admin
    .from("projects")
    .update({ status: "done", video_url: publicUrlData.publicUrl })
    .eq("id", projectId);
}

// ---------------------------------------------------------------------------
// Loop principal
// ---------------------------------------------------------------------------

async function processJob(admin: SupabaseClient, job: JobRow) {
  if (job.task_type === "generate_script") {
    await processGenerateScript(admin, job.project_id);
  } else if (job.task_type === "generate_video") {
    await processGenerateVideo(admin, job.project_id);
  } else {
    throw new Error(`Tipo de tarea desconocido: ${job.task_type}`);
  }
}

async function mainLoop() {
  const admin = createAdminClient();
  console.log(`[worker] iniciado, poll cada ${POLL_INTERVAL_MS}ms`);

  for (;;) {
    try {
      const job = await claimNextJob(admin);
      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      console.log(
        `[worker] procesando job ${job.id} (${job.task_type}) — proyecto ${job.project_id}`,
      );

      try {
        await processJob(admin, job);
        await admin
          .from("job_queue")
          .update({ status: "done" })
          .eq("id", job.id);
        console.log(`[worker] job ${job.id} completado`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[worker] job ${job.id} falló:`, message);

        await admin
          .from("job_queue")
          .update({
            status: "error",
            attempts: (job.attempts ?? 0) + 1,
            last_error: message,
          })
          .eq("id", job.id);

        await admin
          .from("projects")
          .update({ status: "error", error_message: message })
          .eq("id", job.project_id);
      }
    } catch (loopErr) {
      // Un error inesperado acá no debe tirar abajo el worker entero.
      console.error("[worker] error inesperado en el loop:", loopErr);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

mainLoop();
