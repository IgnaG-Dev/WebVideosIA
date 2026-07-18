import "server-only";
import { fetchWithTimeout } from "./fetch-with-timeout";
import type { ScriptLanguage } from "./types";
import type { ScriptSegment, ScriptProgress } from "./openai";

const IMAGE_MODEL = "gemini-2.5-flash-image";
const TEXT_MODEL = "gemini-2.5-flash";
const IMAGE_TIMEOUT_MS = 45000;
const TEXT_TIMEOUT_MS = 120000;

/**
 * Genera una imagen con Gemini a partir de un prompt de texto. Se usa como
 * fallback cuando la generación con OpenAI (lib/openai.ts) falla, por ejemplo
 * por cuota agotada (429).
 */
export async function generateImageWithGemini(
  prompt: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const apiKey = requireApiKey();

  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    },
    IMAGE_TIMEOUT_MS,
  );

  if (!res.ok) {
    const message = await res.text().catch(() => "");
    throw new Error(
      `La generación de imagen con Gemini falló (${res.status}): ${message.slice(0, 300)}`,
    );
  }

  const json = (await res.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ inlineData?: { mimeType: string; data: string } }>;
      };
    }>;
  };

  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart?.inlineData) {
    throw new Error("Gemini no devolvió ninguna imagen.");
  }

  const bytes = Uint8Array.from(
    Buffer.from(imagePart.inlineData.data, "base64"),
  );
  return { bytes, contentType: imagePart.inlineData.mimeType || "image/png" };
}

function requireApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Falta configurar GEMINI_API_KEY.");
  }
  return apiKey;
}

async function callGeminiText(input: {
  system: string;
  user: string;
  jsonMode?: boolean;
  temperature?: number;
}): Promise<string> {
  const apiKey = requireApiKey();

  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: "user", parts: [{ text: input.user }] }],
        generationConfig: {
          temperature: input.temperature ?? 0.8,
          ...(input.jsonMode ? { responseMimeType: "application/json" } : {}),
        },
      }),
    },
    TEXT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const message = await res.text().catch(() => "");
    throw new Error(`Gemini falló (${res.status}): ${message.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("");
  if (!text) {
    throw new Error("Gemini no devolvió contenido de texto.");
  }
  return text.trim();
}

// Ritmo de narración promedio, usado para estimar duraciones (igual que en
// lib/openai.ts).
const WORDS_PER_MINUTE = 140;
const MIN_WORDS_RATIO = 0.95;
const MAX_CONTINUATIONS = 8;

const LANGUAGE_NAME: Record<ScriptLanguage, string> = {
  es: "español",
  en: "inglés",
};

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Igual que generateScript de lib/openai.ts pero usando Gemini. */
export async function generateScriptWithGemini(input: {
  topic: string;
  tone: string;
  audience: string;
  targetDurationMinutes: number;
  language?: ScriptLanguage;
  onProgress?: (progress: ScriptProgress) => void;
}): Promise<string> {
  const { topic, tone, audience, targetDurationMinutes, onProgress } = input;
  const language = input.language ?? "es";
  const languageName = LANGUAGE_NAME[language];
  const targetWords = Math.round(targetDurationMinutes * WORDS_PER_MINUTE);
  const minWords = Math.round(targetWords * MIN_WORDS_RATIO);

  let script = await callGeminiText({
    system:
      "Sos un guionista profesional de videos narrados. Escribís guiones completos, listos para narrar en voz alta, sin acotaciones de escena ni marcas de tiempo — solo el texto que se lee. Cuando te piden una extensión larga, la cumplís desarrollando el tema en profundidad (ejemplos, contexto, subtemas) en vez de quedarte corto.",
    user: `Escribí el guion completo de un video sobre "${topic}".
Tono: ${tone}.
Público objetivo: ${audience}.
Duración objetivo: ${targetDurationMinutes} minutos. Tiene que tener **como mínimo ${targetWords} palabras** (a ritmo de ${WORDS_PER_MINUTE} palabras por minuto) — es muy importante que no quede corto, desarrollá el tema con la profundidad necesaria para llegar a esa extensión.
Devolvé únicamente el texto del guion, en ${languageName}, sin títulos ni numeración.`,
  });

  let attempts = 0;
  while (countWords(script) < minWords && attempts < MAX_CONTINUATIONS) {
    onProgress?.({ attempt: attempts + 1, maxAttempts: MAX_CONTINUATIONS });
    const missingWords = targetWords - countWords(script);
    const continuation = await callGeminiText({
      system:
        "Continuás guiones de video ya empezados. Seguís el mismo tono y estilo, sin repetir ideas ya dichas y sin resumir lo anterior — solo agregás contenido nuevo que continúa naturalmente donde terminó el texto.",
      user: `Este guion sobre "${topic}" (tono: ${tone}, público: ${audience}) quedó corto. Continualo desde donde termina, agregando contenido nuevo y relevante (no repitas nada de lo ya escrito) hasta sumar aproximadamente ${missingWords} palabras más.
Devolvé únicamente el texto que continúa, en ${languageName}, sin repetir el guion anterior.

Guion hasta ahora:
"""
${script}
"""`,
    });
    script = `${script}\n\n${continuation}`.trim();
    attempts++;
  }

  return script;
}

/** Igual que segmentScript de lib/openai.ts pero usando Gemini. */
export async function segmentScriptWithGemini(input: {
  fullScript: string;
  targetDurationMinutes: number;
}): Promise<ScriptSegment[]> {
  const { fullScript, targetDurationMinutes } = input;

  const raw = await callGeminiText({
    system:
      "Dividís guiones de video en segmentos narrativos cortos (una idea visual por segmento), preservando el texto original palabra por palabra, sin reescribirlo ni resumirlo ni traducirlo. Respondés únicamente JSON.",
    user: `Dividí el siguiente guion en segmentos de entre 5 y 15 segundos de narración cada uno (a ritmo de ${WORDS_PER_MINUTE} palabras por minuto). No agregues, quites ni traduzcas contenido, solo cortá el texto en los puntos naturales, en el mismo idioma del guion original. La suma de las duraciones debe aproximarse a ${targetDurationMinutes * 60} segundos.

Devolvé un objeto JSON con esta forma exacta:
{"segments": [{"text": "...", "estimated_duration_seconds": 8}, ...]}

Guion:
"""
${fullScript}
"""`,
    jsonMode: true,
    temperature: 0.2,
  });

  const parsed = JSON.parse(raw) as {
    segments?: Array<{ text?: string; estimated_duration_seconds?: number }>;
  };
  const rawSegments = parsed.segments ?? [];

  const segments = rawSegments
    .map((segment, index) => {
      const text = String(segment.text ?? "").trim();
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const fallbackDuration = Math.max(
        3,
        Math.round((wordCount / WORDS_PER_MINUTE) * 60),
      );
      const estimatedDuration =
        Number(segment.estimated_duration_seconds) > 0
          ? Number(segment.estimated_duration_seconds)
          : fallbackDuration;

      return {
        order_index: index,
        text,
        estimated_duration_seconds: estimatedDuration,
      };
    })
    .filter((segment) => segment.text.length > 0);

  if (segments.length === 0) {
    throw new Error("La segmentación devuelta está vacía.");
  }

  return segments;
}
