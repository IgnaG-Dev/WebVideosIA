import "server-only";
import OpenAI from "openai";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

export type ScriptSegment = {
  order_index: number;
  text: string;
  estimated_duration_seconds: number;
};

// Ritmo de narración promedio en español, usado para estimar duraciones.
const WORDS_PER_MINUTE = 140;

// Los modelos suelen quedarse cortos cuando se les pide un texto muy largo
// en una sola respuesta. Se acepta hasta un 5% menos del objetivo; si no
// llega, se le pide que siga escribiendo (sin repetirse) hasta acercarse.
const MIN_WORDS_RATIO = 0.95;
const MAX_CONTINUATIONS = 8;

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export async function generateScript(input: {
  topic: string;
  tone: string;
  audience: string;
  targetDurationMinutes: number;
}): Promise<string> {
  const { topic, tone, audience, targetDurationMinutes } = input;
  const targetWords = Math.round(targetDurationMinutes * WORDS_PER_MINUTE);
  const minWords = Math.round(targetWords * MIN_WORDS_RATIO);

  const completion = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.8,
    messages: [
      {
        role: "system",
        content:
          "Sos un guionista profesional de videos narrados. Escribís guiones completos, listos para narrar en voz alta, sin acotaciones de escena ni marcas de tiempo — solo el texto que se lee. Cuando te piden una extensión larga, la cumplís desarrollando el tema en profundidad (ejemplos, contexto, subtemas) en vez de quedarte corto.",
      },
      {
        role: "user",
        content: `Escribí el guion completo de un video sobre "${topic}".
Tono: ${tone}.
Público objetivo: ${audience}.
Duración objetivo: ${targetDurationMinutes} minutos. Tiene que tener **como mínimo ${targetWords} palabras** (a ritmo de ${WORDS_PER_MINUTE} palabras por minuto) — es muy importante que no quede corto, desarrollá el tema con la profundidad necesaria para llegar a esa extensión.
Devolvé únicamente el texto del guion, en español, sin títulos ni numeración.`,
      },
    ],
  });

  let script = completion.choices[0]?.message?.content?.trim();
  if (!script) {
    throw new Error("OpenAI no devolvió contenido para el guion.");
  }

  let attempts = 0;
  while (countWords(script) < minWords && attempts < MAX_CONTINUATIONS) {
    const missingWords = targetWords - countWords(script);
    const continuation = await requestScriptContinuation({
      scriptSoFar: script,
      topic,
      tone,
      audience,
      missingWords,
    });
    script = `${script}\n\n${continuation}`.trim();
    attempts++;
  }

  return script;
}

async function requestScriptContinuation(input: {
  scriptSoFar: string;
  topic: string;
  tone: string;
  audience: string;
  missingWords: number;
}): Promise<string> {
  const { scriptSoFar, topic, tone, audience, missingWords } = input;

  const completion = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.8,
    messages: [
      {
        role: "system",
        content:
          "Continuás guiones de video ya empezados. Seguís el mismo tono y estilo, sin repetir ideas ya dichas y sin resumir lo anterior — solo agregás contenido nuevo que continúa naturalmente donde terminó el texto.",
      },
      {
        role: "user",
        content: `Este guion sobre "${topic}" (tono: ${tone}, público: ${audience}) quedó corto. Continualo desde donde termina, agregando contenido nuevo y relevante (no repitas nada de lo ya escrito) hasta sumar aproximadamente ${missingWords} palabras más.
Devolvé únicamente el texto que continúa, en español, sin repetir el guion anterior.

Guion hasta ahora:
"""
${scriptSoFar}
"""`,
      },
    ],
  });

  const continuation = completion.choices[0]?.message?.content?.trim();
  if (!continuation) {
    throw new Error("OpenAI no devolvió la continuación del guion.");
  }
  return continuation;
}

export async function segmentScript(input: {
  fullScript: string;
  targetDurationMinutes: number;
}): Promise<ScriptSegment[]> {
  const { fullScript, targetDurationMinutes } = input;

  const completion = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Dividís guiones de video en segmentos narrativos cortos (una idea visual por segmento), preservando el texto original palabra por palabra, sin reescribirlo ni resumirlo. Respondés únicamente JSON.",
      },
      {
        role: "user",
        content: `Dividí el siguiente guion en segmentos de entre 5 y 15 segundos de narración cada uno (a ritmo de ${WORDS_PER_MINUTE} palabras por minuto). No agregues ni quites contenido, solo cortá el texto en los puntos naturales. La suma de las duraciones debe aproximarse a ${targetDurationMinutes * 60} segundos.

Devolvé un objeto JSON con esta forma exacta:
{"segments": [{"text": "...", "estimated_duration_seconds": 8}, ...]}

Guion:
"""
${fullScript}
"""`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    throw new Error("OpenAI no devolvió la segmentación.");
  }

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
