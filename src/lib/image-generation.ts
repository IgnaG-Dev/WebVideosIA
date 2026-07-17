import "server-only";
import { generateImageWithOpenAI, buildImagePrompt } from "./openai";
import { generateImageWithGemini } from "./gemini";

export { buildImagePrompt };

export type GeneratedImage = {
  bytes: Uint8Array;
  contentType: string;
  provider: "openai" | "gemini";
};

/**
 * Genera una imagen con IA a partir de un prompt, probando OpenAI primero y
 * cayendo a Gemini si OpenAI falla (ej. cuota agotada / 429). Así un solo
 * proveedor caído no tumba la generación de imágenes.
 */
export async function generateImageWithAI(prompt: string): Promise<GeneratedImage> {
  try {
    const result = await generateImageWithOpenAI(prompt);
    return { ...result, provider: "openai" };
  } catch (openaiError) {
    try {
      const result = await generateImageWithGemini(prompt);
      return { ...result, provider: "gemini" };
    } catch (geminiError) {
      const openaiMessage =
        openaiError instanceof Error ? openaiError.message : String(openaiError);
      const geminiMessage =
        geminiError instanceof Error ? geminiError.message : String(geminiError);
      throw new Error(
        `OpenAI falló (${openaiMessage}) y Gemini también falló (${geminiMessage}).`,
      );
    }
  }
}
