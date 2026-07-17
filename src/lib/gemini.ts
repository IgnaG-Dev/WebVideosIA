import "server-only";
import { fetchWithTimeout } from "./fetch-with-timeout";

const MODEL = "gemini-2.5-flash-image";
const TIMEOUT_MS = 45000;

/**
 * Genera una imagen con Gemini a partir de un prompt de texto. Se usa como
 * fallback cuando la generación con OpenAI (lib/openai.ts) falla, por ejemplo
 * por cuota agotada (429).
 */
export async function generateImageWithGemini(
  prompt: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Falta configurar la generación de imágenes con IA (Gemini).");
  }

  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    },
    TIMEOUT_MS,
  );

  if (!res.ok) {
    const message = await res.text().catch(() => "");
    throw new Error(
      `La generación de imagen con IA falló (${res.status}): ${message.slice(0, 300)}`,
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
    throw new Error("La IA no devolvió ninguna imagen.");
  }

  const bytes = Uint8Array.from(
    Buffer.from(imagePart.inlineData.data, "base64"),
  );
  return { bytes, contentType: imagePart.inlineData.mimeType || "image/png" };
}
