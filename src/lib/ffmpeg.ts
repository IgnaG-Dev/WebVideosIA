import "server-only";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import path from "node:path";

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 25;
const THREADS = Math.max(1, cpus().length || 2);

export type SegmentAsset = {
  mediaType: "image" | "video";
  mediaBytes: Uint8Array;
  mediaExtension: string;
  audioBytes: Uint8Array;
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

function runFfprobe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      reject(new Error(`No se pudo ejecutar ffprobe: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (code === 0) {
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
 * Arma el video final en un único proceso de ffmpeg, usando el filtro
 * `concat` (no el demuxer + archivos intermedios): cada segmento se
 * decodifica y concatena a nivel de frames dentro del mismo grafo de
 * filtros, y recién ahí se codifica una sola vez. Armar un mp4 por
 * segmento y después concatenarlos (aunque sea re-codificando) arrastra
 * desfasajes de encoder entre archivos que se van acumulando segmento a
 * segmento — con videos de 30-60+ segmentos terminaba notándose la imagen
 * atrasada respecto del audio. Este enfoque no tiene ese problema porque
 * nunca hay un límite de archivo entre un segmento y el siguiente.
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

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const mediaPath = path.join(
        workDir,
        `segment-${i}-media.${segment.mediaExtension}`,
      );
      const audioPath = path.join(workDir, `segment-${i}-audio.mp3`);
      await writeFile(mediaPath, segment.mediaBytes);
      await writeFile(audioPath, segment.audioBytes);

      // El filtro concat necesita que cada rama tenga una duración finita
      // y exacta: se le pone como límite la duración real del audio de
      // ese segmento (medida con ffprobe), no una estimación.
      const duration = await probeDurationSeconds(audioPath);

      const videoInputIndex = i * 2;
      if (segment.mediaType === "video") {
        inputArgs.push(
          "-stream_loop", "-1",
          "-t", duration.toFixed(3),
          "-i", mediaPath,
        );
      } else {
        inputArgs.push(
          "-loop", "1",
          "-t", duration.toFixed(3),
          "-i", mediaPath,
        );
      }
      inputArgs.push("-i", audioPath);
      const audioInputIndex = videoInputIndex + 1;

      const vLabel = `v${i}`;
      const aLabel = `a${i}`;
      filterLines.push(
        `[${videoInputIndex}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[${vLabel}]`,
      );
      filterLines.push(
        `[${audioInputIndex}:a]aresample=44100,asetpts=PTS-STARTPTS[${aLabel}]`,
      );
      videoLabels.push(`[${vLabel}]`);
      audioLabels.push(`[${aLabel}]`);
    }

    const concatInputs = videoLabels
      .map((v, i) => `${v}${audioLabels[i]}`)
      .join("");
    filterLines.push(
      `${concatInputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`,
    );

    const filterScriptPath = path.join(workDir, "filter.txt");
    await writeFile(filterScriptPath, filterLines.join(";\n"));

    const finalPath = path.join(workDir, "final.mp4");
    await runFfmpeg([
      "-y",
      ...inputArgs,
      "-filter_complex_script", filterScriptPath,
      "-map", "[outv]",
      "-map", "[outa]",
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
