import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("status, video_url, error_message")
    .eq("id", id)
    .maybeSingle();

  if (projectError || !project) {
    return NextResponse.json({ error: "Proyecto no encontrado" }, { status: 404 });
  }

  const { data: segments, error: segmentsError } = await supabase
    .from("segments")
    .select("status, image_url, audio_url")
    .eq("project_id", id);

  if (segmentsError) {
    return NextResponse.json(
      { error: "No se pudieron leer los segmentos" },
      { status: 500 },
    );
  }

  // Imagen y audio se generan en paralelo por segmento, así que cada campo
  // se cuenta por su propia presencia (no por el status general del
  // segmento) para que la barra de progreso avance en tiempo real.
  const total = segments.length;
  const imagesReady = segments.filter((s) => !!s.image_url).length;
  const audiosReady = segments.filter((s) => !!s.audio_url).length;
  const errors = segments.filter((s) => s.status === "error").length;

  return NextResponse.json({
    status: project.status,
    video_url: project.video_url,
    error_message: project.error_message,
    segments: {
      total,
      images_ready: imagesReady,
      audios_ready: audiosReady,
      errors,
    },
  });
}
