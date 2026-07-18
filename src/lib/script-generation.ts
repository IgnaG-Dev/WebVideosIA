import "server-only";
import {
  generateScript,
  segmentScript,
  type ScriptProgress,
  type ScriptSegment,
} from "./openai";
import { generateScriptWithGemini, segmentScriptWithGemini } from "./gemini";
import type { ScriptLanguage } from "./types";

function combinedError(what: string, openaiErr: unknown, geminiErr: unknown): Error {
  const openaiMessage = openaiErr instanceof Error ? openaiErr.message : String(openaiErr);
  const geminiMessage = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
  return new Error(
    `OpenAI falló generando ${what} (${openaiMessage}) y Gemini también falló (${geminiMessage}).`,
  );
}

/**
 * Genera el guion completo probando OpenAI primero y cayendo a Gemini si
 * OpenAI falla (ej. cuota agotada / 429).
 */
export async function generateScriptWithAI(input: {
  topic: string;
  tone: string;
  audience: string;
  targetDurationMinutes: number;
  language?: ScriptLanguage;
  onProgress?: (progress: ScriptProgress) => void;
}): Promise<string> {
  try {
    return await generateScript(input);
  } catch (openaiError) {
    try {
      return await generateScriptWithGemini(input);
    } catch (geminiError) {
      throw combinedError("el guion", openaiError, geminiError);
    }
  }
}

/**
 * Segmenta un guion probando OpenAI primero y cayendo a Gemini si OpenAI
 * falla (ej. cuota agotada / 429).
 */
export async function segmentScriptWithAI(input: {
  fullScript: string;
  targetDurationMinutes: number;
}): Promise<ScriptSegment[]> {
  try {
    return await segmentScript(input);
  } catch (openaiError) {
    try {
      return await segmentScriptWithGemini(input);
    } catch (geminiError) {
      throw combinedError("la segmentación", openaiError, geminiError);
    }
  }
}
