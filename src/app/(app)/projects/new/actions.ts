"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { segmentScriptWithAI } from "@/lib/script-generation";
import type { MediaPreference, ScriptLanguage, ScriptMode } from "@/lib/types";

export type CreateProjectState = { error: string | null };

export async function createProject(
  _prevState: CreateProjectState,
  formData: FormData,
): Promise<CreateProjectState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const title = String(formData.get("title") ?? "").trim();
  const scriptMode = String(formData.get("script_mode") ?? "") as ScriptMode;
  const targetDurationMinutes = Number(
    formData.get("target_duration_minutes"),
  );
  const mediaPreferenceRaw = String(formData.get("media_preference") ?? "");
  const mediaPreference: MediaPreference =
    mediaPreferenceRaw === "video" || mediaPreferenceRaw === "ai"
      ? mediaPreferenceRaw
      : "image";
  const subtitlesEnabled = formData.get("subtitles_enabled") === "on";

  if (!title) {
    return { error: "El título es obligatorio." };
  }
  if (scriptMode !== "manual" && scriptMode !== "ia") {
    return { error: "Elegí un modo de guion válido." };
  }
  if (
    !Number.isFinite(targetDurationMinutes) ||
    targetDurationMinutes < 5 ||
    targetDurationMinutes > 30
  ) {
    return { error: "La duración debe estar entre 5 y 30 minutos." };
  }

  let projectId: string;

  if (scriptMode === "manual") {
    const fullScript = String(formData.get("full_script") ?? "").trim();
    if (!fullScript) {
      return { error: "Pegá el guion completo." };
    }

    let segments;
    try {
      segments = await segmentScriptWithAI({ fullScript, targetDurationMinutes });
    } catch {
      return {
        error: "No se pudo procesar el guion. Probá de nuevo en unos segundos.",
      };
    }

    const { data: project, error: insertError } = await supabase
      .from("projects")
      .insert({
        user_id: user.id,
        title,
        script_mode: "manual",
        target_duration_minutes: targetDurationMinutes,
        media_preference: mediaPreference,
        subtitles_enabled: subtitlesEnabled,
        full_script: fullScript,
        status: "script_ready",
      })
      .select("id")
      .single();

    if (insertError || !project) {
      return { error: "No se pudo crear el proyecto. Probá de nuevo." };
    }

    const { error: segmentsError } = await supabase.from("segments").insert(
      segments.map((segment) => ({
        project_id: project.id,
        order_index: segment.order_index,
        text: segment.text,
        estimated_duration_seconds: segment.estimated_duration_seconds,
        status: "pending",
      })),
    );

    if (segmentsError) {
      await supabase
        .from("projects")
        .update({
          status: "error",
          error_message: "No se pudieron guardar los segmentos del guion.",
        })
        .eq("id", project.id);
    }

    projectId = project.id;
  } else {
    const topic = String(formData.get("topic") ?? "").trim();
    const tone = String(formData.get("tone") ?? "").trim();
    const audience = String(formData.get("audience") ?? "").trim();
    if (!topic || !tone || !audience) {
      return { error: "Completá tema, tono y público." };
    }
    const scriptLanguage: ScriptLanguage =
      String(formData.get("script_language") ?? "") === "en" ? "en" : "es";

    const { data: project, error: insertError } = await supabase
      .from("projects")
      .insert({
        user_id: user.id,
        title,
        script_mode: "ia",
        target_duration_minutes: targetDurationMinutes,
        media_preference: mediaPreference,
        subtitles_enabled: subtitlesEnabled,
        script_language: scriptLanguage,
        topic,
        tone,
        audience,
        status: "generating_script",
      })
      .select("id")
      .single();

    if (insertError || !project) {
      return { error: "No se pudo crear el proyecto. Probá de nuevo." };
    }

    // job_queue no tiene policies para authenticated/anon (ver migración
    // 0001_init_schema.sql) — el insert se hace con el cliente admin.
    const admin = createAdminClient();
    const { error: queueError } = await admin.from("job_queue").insert({
      project_id: project.id,
      task_type: "generate_script",
      status: "pending",
    });

    if (queueError) {
      await supabase
        .from("projects")
        .update({
          status: "error",
          error_message: "No se pudo encolar la generación del guion.",
        })
        .eq("id", project.id);
    }

    projectId = project.id;
  }

  redirect(`/projects/${projectId}`);
}
