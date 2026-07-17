import "server-only";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import path from "node:path";

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 25;

// Varios ffmpeg corriendo a la vez compiten por CPU, así que se reparten los
// cores disponibles en vez de dejar que cada uno intente usarlos todos.
const CPU_COUNT = cpus().length || 2;
const CLIP_BUILD_CONCURRENCY = Math.max(1, Math.min(4, CPU_COUNT));
const THREADS_PER_CLIP = Math.max(1, Math.floor(CPU_COUNT / CLIP_BUILD_CONCURRENCY));

export type SegmentAsset = {
  mediaType: "image" | "video";
  mediaBytes: Uint8Array;
  mediaExtension: string;
  audioBytes: Uint8Array;
  // Duración máxima del clip en segundos. Si el audio dura menos, manda el
  // audio (-shortest); si el usuario recortó la duración a un valor menor
  // al del audio, este límite corta el clip ahí (-t).
  durationSeconds: number;
};

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      reject(new Error(`No se pudo ejecutar ffmpeg: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg terminó con código ${code}: ${stderr.slice(-2000)}`));
      }
    });
  });
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
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

async function buildSegmentClip(
  workDir: string,
  segment: SegmentAsset,
  index: number,
): Promise<string> {
  const mediaPath = path.join(workDir, `segment-${index}-media.${segment.mediaExtension}`);
  const audioPath = path.join(workDir, `segment-${index}-audio.mp3`);
  const outputPath = path.join(workDir, `segment-${index}.mp4`);

  await writeFile(mediaPath, segment.mediaBytes);
  await writeFile(audioPath, segment.audioBytes);

  const scaleFilter = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

  const args =
    segment.mediaType === "video"
      ? [
          "-y",
          "-stream_loop", "-1",
          "-i", mediaPath,
          "-i", audioPath,
          "-map", "0:v:0",
          "-map", "1:a:0",
          "-vf", scaleFilter,
          "-r", String(FPS),
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-threads", String(THREADS_PER_CLIP),
          "-pix_fmt", "yuv420p",
          "-c:a", "aac",
          "-b:a", "192k",
          "-ar", "44100",
          "-shortest",
          "-t", String(segment.durationSeconds),
          outputPath,
        ]
      : [
          "-y",
          "-loop", "1",
          "-i", mediaPath,
          "-i", audioPath,
          "-vf", scaleFilter,
          "-r", String(FPS),
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-threads", String(THREADS_PER_CLIP),
          "-tune", "stillimage",
          "-pix_fmt", "yuv420p",
          "-c:a", "aac",
          "-b:a", "192k",
          "-ar", "44100",
          "-shortest",
          "-t", String(segment.durationSeconds),
          outputPath,
        ];

  await runFfmpeg(args);
  return outputPath;
}

/**
 * Arma un clip por segmento (media + audio, con la duración del audio) y
 * concatena todos los clips en un único video final. Devuelve los bytes del
 * mp4 resultante; quien llama es responsable de subirlos a Storage.
 */
export async function assembleSegmentsToVideo(
  segments: SegmentAsset[],
): Promise<Uint8Array> {
  if (segments.length === 0) {
    throw new Error("No hay segmentos para armar el video.");
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "video-ia-"));
  try {
    const clipPaths = await mapWithConcurrency(
      segments,
      CLIP_BUILD_CONCURRENCY,
      (segment, index) => buildSegmentClip(workDir, segment, index),
    );

    const listPath = path.join(workDir, "concat.txt");
    const listContent = clipPaths
      .map((clipPath) => `file '${clipPath.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await writeFile(listPath, listContent);

    const finalPath = path.join(workDir, "final.mp4");
    // Los clips ya comparten codec/resolución/fps, así que el concat
    // demuxer puede copiar streams sin re-codificar.
    await runFfmpeg([
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      finalPath,
    ]);

    return new Uint8Array(await readFile(finalPath));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
