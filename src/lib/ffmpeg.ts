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
 * Arma el video final en un único proceso de ffmpeg con el filtro `concat`
 * (no el demuxer + archivos intermedios — ver historial: concatenar
 * archivos ya codificados arrastra desfasajes de audio/video que se
 * acumulan). Cada segmento se decodifica y se procesa (escala + animación
 * Ken Burns opcional) dentro del mismo grafo de filtros, y los cortes entre
 * segmentos son un `concat` directo o un `xfade`/`acrossfade` (crossfade)
 * según `segment.transition`. Devuelve los bytes del mp4 resultante; quien
 * llama es responsable de subirlos a Storage.
 */
export async function assembleSegmentsToVideo(
  segments: SegmentAsset[],
): Promise<Uint8Array> {
  if (segments.length === 0) {
    throw new Error("No hay segmentos para armar el video.");
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "video-ia-"));
  try {
    const inputArgs: string[] = [];
    const filterLines: string[] = [];
    const videoLabels: string[] = [];
    const audioLabels: string[] = [];
    const durations: number[] = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const mediaPath = path.join(
        workDir,
        `segment-${i}-media.${segment.mediaExtension}`,
      );
      const audioPath = path.join(workDir, `segment-${i}-audio.mp3`);
      await writeFile(mediaPath, segment.mediaBytes);
      await writeFile(audioPath, segment.audioBytes);

      const duration = await probeDurationSeconds(audioPath);
      durations.push(duration);

      const videoInputIndex = i * 2;
      const audioInputIndex = videoInputIndex + 1;

      if (segment.mediaType === "video") {
        inputArgs.push(
          "-stream_loop", "-1",
          "-t", duration.toFixed(3),
          "-i", mediaPath,
        );
      } else if (segment.animation !== "none") {
        // Sin -t acá a propósito: con zoompan, ponerle -t al -loop 1
        // termina multiplicando frames (cada frame del loop dispara su
        // propio ciclo de zoompan). El corte exacto lo hace el
        // trim=duration= dentro del filtro (ver buildVideoFilter).
        inputArgs.push("-loop", "1", "-i", mediaPath);
      } else {
        inputArgs.push(
          "-loop", "1",
          "-t", duration.toFixed(3),
          "-i", mediaPath,
        );
      }
      inputArgs.push("-i", audioPath);

      const vLabel = `v${i}`;
      const aLabel = `a${i}`;
      const videoFilter = buildVideoFilter(
        segment.animation,
        segment.mediaType,
        duration,
      );
      filterLines.push(`[${videoInputIndex}:v]${videoFilter}[${vLabel}]`);
      filterLines.push(
        `[${audioInputIndex}:a]aresample=44100,asetpts=PTS-STARTPTS[${aLabel}]`,
      );
      videoLabels.push(vLabel);
      audioLabels.push(aLabel);
    }

    // Encadena los segmentos de a uno: corte duro (concat) o crossfade
    // (xfade + acrossfade), según la transición con la que entra cada
    // segmento desde el anterior.
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
        combinedDuration = combinedDuration + durations[i] - TRANSITION_SECONDS;
      } else {
        filterLines.push(
          `[${combinedV}][${combinedA}][${videoLabels[i]}][${audioLabels[i]}]concat=n=2:v=1:a=1[${nextV}][${nextA}]`,
        );
        combinedDuration = combinedDuration + durations[i];
      }

      combinedV = nextV;
      combinedA = nextA;
    }

    const filterScriptPath = path.join(workDir, "filter.txt");
    await writeFile(filterScriptPath, filterLines.join(";\n"));

    const finalPath = path.join(workDir, "final.mp4");
    await runFfmpeg([
      "-y",
      ...inputArgs,
      "-filter_complex_script", filterScriptPath,
      "-map", `[${combinedV}]`,
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

    return new Uint8Array(await readFile(finalPath));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
