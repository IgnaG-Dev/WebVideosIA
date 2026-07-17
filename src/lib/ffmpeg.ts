import "server-only";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import path from "node:path";
import type { SegmentAnimation, SegmentTransition } from "./types";

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 25;
const THREADS = Math.max(1, cpus().length || 2);

// Ken Burns: cuánto llega a acercar/alejar el zoom, y el zoom fijo que usan
// los paneos (necesitan algo de zoom para tener margen hacia dónde moverse).
const MAX_ZOOM = 1.3;
const PAN_ZOOM = 1.15;

const TRANSITION_SECONDS = 0.5;

export type SegmentAsset = {
  mediaType: "image" | "video";
  mediaBytes: Uint8Array;
  mediaExtension: string;
  audioBytes: Uint8Array;
  animation: SegmentAnimation;
  // Transición con la que este segmento entra desde el anterior (se ignora
  // en el primer segmento, no hay nada antes).
  transition: SegmentTransition;
  // Texto narrado del segmento — solo se usa para el subtítulo (si está
  // activado), no afecta el audio ni la imagen.
  text: string;
};

export type AssembleProgress =
  | { step: "clips"; current: number; total: number }
  | { step: "encoding"; current: number; total: number };

export type AssembleOptions = {
  subtitlesEnabled?: boolean;
  onProgress?: (progress: AssembleProgress) => void;
};

// Igual que con los fetch externos: un proceso hijo que nunca termina (ej.
// ffmpeg colgado con un input corrupto) deja la promesa esperando para
// siempre y traba el job. Se fuerza un límite duro con SIGKILL.
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
const FFPROBE_TIMEOUT_MS = 30 * 1000;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, FFMPEG_TIMEOUT_MS);
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`No se pudo ejecutar ffmpeg: ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `ffmpeg superó los ${FFMPEG_TIMEOUT_MS / 1000}s y se canceló.`,
          ),
        );
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg terminó con código ${code}: ${stderr.slice(-2000)}`));
      }
    });
  });
}

function runFfprobe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, FFPROBE_TIMEOUT_MS);
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`No se pudo ejecutar ffprobe: ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `ffprobe superó los ${FFPROBE_TIMEOUT_MS / 1000}s y se canceló.`,
          ),
        );
      } else if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`ffprobe terminó con código ${code}: ${stderr.slice(-2000)}`));
      }
    });
  });
}

async function probeDurationSeconds(filePath: string): Promise<number> {
  const stdout = await runFfprobe([
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const seconds = parseFloat(stdout);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe devolvió una duración inválida: "${stdout}"`);
  }
  return seconds;
}

/** Duración real del audio en segundos, midiéndolo con ffprobe. */
export async function getAudioDurationSeconds(
  audioBytes: Uint8Array,
): Promise<number> {
  const workDir = await mkdtemp(path.join(tmpdir(), "probe-"));
  try {
    const audioPath = path.join(workDir, "audio.mp3");
    await writeFile(audioPath, audioBytes);
    return await probeDurationSeconds(audioPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// Corre tareas con concurrencia acotada — se usa para renderizar los clips
// de cada segmento en paralelo (aprovechar varios núcleos) sin lanzar todos
// los procesos de ffmpeg a la vez.
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

// Cuántos clips se renderizan en paralelo: el paso caro es zoompan sobre
// una imagen escalada, y cada proceso de ffmpeg ya usa varios threads para
// codificar — un worker por cada 2 núcleos evita saturar la CPU de
// contención en vez de ganar velocidad.
const CLIP_CONCURRENCY = Math.max(2, Math.floor(THREADS / 2));

/**
 * Filtro de video para un segmento. Sin animación (o si es un clip de
 * video, que ya tiene movimiento propio) solo escala/rellena al tamaño de
 * salida. Con animación, usa zoompan para el efecto Ken Burns.
 *
 * Importante: zoompan con `-loop 1` en el input es una trampa clásica —
 * el `d=` de zoompan solo define cuántos frames dura la RAMPA de zoom,
 * pero no corta el stream (con un loop infinito, zoompan sigue generando
 * frames para siempre sosteniendo el zoom final). Y ponerle `-t` al input
 * en cambio termina multiplicando frames (cada frame del loop dispara su
 * propio ciclo de zoompan). La forma que sí corta exacto, probada, es un
 * `trim=duration=` después del zoompan.
 */
function buildVideoFilter(
  animation: SegmentAnimation,
  mediaType: "image" | "video",
  durationSeconds: number,
): string {
  const baseScale = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`;

  if (mediaType === "video" || animation === "none") {
    return `${baseScale},setsar=1,fps=${FPS},format=yuv420p`;
  }

  const frames = Math.max(2, Math.round(durationSeconds * FPS));
  // Suficiente resolución para que el zoom no pixele sin ser tan grande
  // como para que zoompan se vuelva insoportablemente lento (8000px de
  // ancho, probado, tardaba varios minutos por segmento).
  const upscale = `scale=${WIDTH * 2}:-2`;
  const centerX = "iw/2-(iw/zoom/2)";
  const centerY = "ih/2-(ih/zoom/2)";
  const zoompanTail = `d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}`;
  const finishTail = `trim=duration=${durationSeconds.toFixed(3)},setpts=PTS-STARTPTS,setsar=1,format=yuv420p`;

  switch (animation) {
    case "zoom_in": {
      const step = ((MAX_ZOOM - 1) / frames).toFixed(6);
      return `${upscale},zoompan=z='min(zoom+${step},${MAX_ZOOM})':x='${centerX}':y='${centerY}':${zoompanTail},${finishTail}`;
    }
    case "zoom_out": {
      const step = ((MAX_ZOOM - 1) / frames).toFixed(6);
      return `${upscale},zoompan=z='if(eq(on,1),${MAX_ZOOM},max(zoom-${step},1))':x='${centerX}':y='${centerY}':${zoompanTail},${finishTail}`;
    }
    case "pan_left":
      return `${upscale},zoompan=z=${PAN_ZOOM}:x='(iw-iw/zoom)*(1-(on-1)/${frames - 1})':y='${centerY}':${zoompanTail},${finishTail}`;
    case "pan_right":
      return `${upscale},zoompan=z=${PAN_ZOOM}:x='(iw-iw/zoom)*((on-1)/${frames - 1})':y='${centerY}':${zoompanTail},${finishTail}`;
    case "pan_up":
      return `${upscale},zoompan=z=${PAN_ZOOM}:x='${centerX}':y='(ih-ih/zoom)*(1-(on-1)/${frames - 1})':${zoompanTail},${finishTail}`;
    case "pan_down":
      return `${upscale},zoompan=z=${PAN_ZOOM}:x='${centerX}':y='(ih-ih/zoom)*((on-1)/${frames - 1})':${zoompanTail},${finishTail}`;
    default:
      return `${baseScale},setsar=1,fps=${FPS},format=yuv420p`;
  }
}

/**
 * Renderiza el clip de un solo segmento (escala + Ken Burns si aplica) a un
 * mp4 sin audio, con duración exacta. Es el paso caro (zoompan sobre una
 * imagen grande) — se corre en paralelo entre segmentos vía
 * mapWithConcurrency, en vez de en serie dentro de un único proceso de
 * ffmpeg como antes, que era el cuello de botella del armado final.
 */
async function renderSegmentClip(
  workDir: string,
  index: number,
  segment: SegmentAsset,
  durationSeconds: number,
): Promise<string> {
  const mediaPath = path.join(
    workDir,
    `segment-${index}-media.${segment.mediaExtension}`,
  );
  await writeFile(mediaPath, segment.mediaBytes);

  const inputArgs: string[] = [];
  if (segment.mediaType === "video") {
    inputArgs.push(
      "-stream_loop", "-1",
      "-t", durationSeconds.toFixed(3),
      "-i", mediaPath,
    );
  } else if (segment.animation !== "none") {
    // Sin -t acá a propósito: ver buildVideoFilter.
    inputArgs.push("-loop", "1", "-i", mediaPath);
  } else {
    inputArgs.push(
      "-loop", "1",
      "-t", durationSeconds.toFixed(3),
      "-i", mediaPath,
    );
  }

  const clipPath = path.join(workDir, `segment-${index}-clip.mp4`);
  await runFfmpeg([
    "-y",
    ...inputArgs,
    "-vf", buildVideoFilter(segment.animation, segment.mediaType, durationSeconds),
    "-an",
    "-r", String(FPS),
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "18",
    "-threads", "2",
    "-pix_fmt", "yuv420p",
    clipPath,
  ]);

  return clipPath;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function formatSrtTime(totalSeconds: number): string {
  const ms = Math.max(0, Math.round(totalSeconds * 1000));
  const hh = Math.floor(ms / 3_600_000);
  const mm = Math.floor((ms % 3_600_000) / 60_000);
  const ss = Math.floor((ms % 60_000) / 1000);
  const mmm = ms % 1000;
  return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)},${pad(mmm, 3)}`;
}

/**
 * Arma el .srt con un cue por segmento, en los tiempos reales que ese
 * segmento ocupa en la línea de tiempo final (`starts`/`durations`, que ya
 * contemplan el solapamiento de los crossfade) — así el subtítulo queda
 * siempre sincronizado con el audio que se está narrando.
 */
function buildSrt(
  segments: SegmentAsset[],
  starts: number[],
  durations: number[],
): string {
  return segments
    .map((segment, i) => {
      const text = segment.text.replace(/\s+/g, " ").trim();
      if (!text) return "";
      const start = formatSrtTime(starts[i]);
      const end = formatSrtTime(starts[i] + durations[i]);
      return `${i + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .filter(Boolean)
    .join("\n");
}

// Escapa el path para usarlo dentro del argumento del filtro `subtitles=`,
// que además de la sintaxis de filtro de ffmpeg interpreta ":" como
// separador de opciones.
function escapeSubtitlesPath(filePath: string): string {
  return filePath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

const SUBTITLE_STYLE =
  "FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=40,Alignment=2";

/**
 * Arma el video final. Primero renderiza el clip (escala + Ken Burns) de
 * cada segmento EN PARALELO (ver renderSegmentClip) — es la parte cara de
 * la CPU y antes se hacía en serie dentro de un único proceso de ffmpeg.
 * Después, un único paso final liviano concatena/cruza esos clips ya
 * renderizados y el audio crudo de cada segmento en un solo filter_complex
 * (igual que antes: el audio se decodifica y se une en un solo proceso
 * para no arrastrar el desfasaje que causa concatenar archivos de audio ya
 * codificados por separado), quema los subtítulos si están activados, y
 * codifica una sola vez. Devuelve los bytes del mp4 resultante.
 */
export async function assembleSegmentsToVideo(
  segments: SegmentAsset[],
  options: AssembleOptions = {},
): Promise<Uint8Array> {
  if (segments.length === 0) {
    throw new Error("No hay segmentos para armar el video.");
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "video-ia-"));
  try {
    // 1) Audio crudo a disco + duración real de cada segmento (rápido,
    // solo lee metadata — se hace con concurrencia amplia).
    const durations = await mapWithConcurrency(segments, 8, async (segment, i) => {
      const audioPath = path.join(workDir, `segment-${i}-audio.mp3`);
      await writeFile(audioPath, segment.audioBytes);
      return probeDurationSeconds(audioPath);
    });
    const audioPaths = segments.map((_, i) =>
      path.join(workDir, `segment-${i}-audio.mp3`),
    );

    // 2) El paso caro, en paralelo: un clip (mp4 sin audio, ya con Ken
    // Burns si corresponde) por segmento.
    let clipsDone = 0;
    options.onProgress?.({ step: "clips", current: 0, total: segments.length });
    const clipPaths = await mapWithConcurrency(
      segments,
      CLIP_CONCURRENCY,
      async (segment, i) => {
        const clipPath = await renderSegmentClip(workDir, i, segment, durations[i]);
        clipsDone++;
        options.onProgress?.({
          step: "clips",
          current: clipsDone,
          total: segments.length,
        });
        return clipPath;
      },
    );

    // 3) Paso final liviano: concatena/cruza los clips ya renderizados
    // (video) y el audio crudo (audio) en un solo filter_complex, y
    // calcula en el camino en qué momento de la línea de tiempo final
    // empieza cada segmento (para los subtítulos).
    const filterLines: string[] = [];
    const videoLabels: string[] = [];
    const audioLabels: string[] = [];
    const starts: number[] = [0];

    for (let i = 0; i < segments.length; i++) {
      const vLabel = `v${i}`;
      const aLabel = `a${i}`;
      filterLines.push(`[${i}:v]setsar=1[${vLabel}]`);
      filterLines.push(
        `[${segments.length + i}:a]aresample=44100,asetpts=PTS-STARTPTS[${aLabel}]`,
      );
      videoLabels.push(vLabel);
      audioLabels.push(aLabel);
    }

    let combinedV = videoLabels[0];
    let combinedA = audioLabels[0];
    let combinedDuration = durations[0];

    for (let i = 1; i < segments.length; i++) {
      const nextV = `cv${i}`;
      const nextA = `ca${i}`;

      const useCrossfade =
        segments[i].transition === "crossfade" &&
        durations[i] > TRANSITION_SECONDS &&
        combinedDuration > TRANSITION_SECONDS;

      if (useCrossfade) {
        const offset = (combinedDuration - TRANSITION_SECONDS).toFixed(3);
        filterLines.push(
          `[${combinedV}][${videoLabels[i]}]xfade=transition=fade:duration=${TRANSITION_SECONDS}:offset=${offset}[${nextV}]`,
        );
        filterLines.push(
          `[${combinedA}][${audioLabels[i]}]acrossfade=d=${TRANSITION_SECONDS}[${nextA}]`,
        );
        starts.push(combinedDuration - TRANSITION_SECONDS);
        combinedDuration = combinedDuration + durations[i] - TRANSITION_SECONDS;
      } else {
        filterLines.push(
          `[${combinedV}][${combinedA}][${videoLabels[i]}][${audioLabels[i]}]concat=n=2:v=1:a=1[${nextV}][${nextA}]`,
        );
        starts.push(combinedDuration);
        combinedDuration = combinedDuration + durations[i];
      }

      combinedV = nextV;
      combinedA = nextA;
    }

    let finalVideoLabel = combinedV;
    if (options.subtitlesEnabled) {
      const srtPath = path.join(workDir, "subs.srt");
      await writeFile(srtPath, buildSrt(segments, starts, durations), "utf-8");
      filterLines.push(
        `[${combinedV}]subtitles=${escapeSubtitlesPath(srtPath)}:force_style='${SUBTITLE_STYLE}'[subbed]`,
      );
      finalVideoLabel = "subbed";
    }

    const filterScriptPath = path.join(workDir, "filter.txt");
    await writeFile(filterScriptPath, filterLines.join(";\n"));

    const inputArgs: string[] = [];
    for (const clipPath of clipPaths) inputArgs.push("-i", clipPath);
    for (const audioPath of audioPaths) inputArgs.push("-i", audioPath);

    options.onProgress?.({ step: "encoding", current: 0, total: 1 });
    const finalPath = path.join(workDir, "final.mp4");
    await runFfmpeg([
      "-y",
      ...inputArgs,
      "-filter_complex_script", filterScriptPath,
      "-map", `[${finalVideoLabel}]`,
      "-map", `[${combinedA}]`,
      "-r", String(FPS),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-threads", String(THREADS),
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      finalPath,
    ]);
    options.onProgress?.({ step: "encoding", current: 1, total: 1 });

    return new Uint8Array(await readFile(finalPath));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
