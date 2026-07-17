import "server-only";
import { fetchWithTimeout } from "./fetch-with-timeout";

const TTS_TIMEOUT_MS = 45000;

export type TTSResult = { bytes: Uint8Array; contentType: string };

interface TTSProviderImpl {
  synthesize(text: string): Promise<TTSResult>;
}

// Voz premade multilingüe de ElevenLabs ("Rachel"); soporta español con el
// modelo eleven_multilingual_v2. Sobreescribible con TTS_VOICE_ID.
const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

const elevenLabsProvider: TTSProviderImpl = {
  async synthesize(text) {
    const apiKey = process.env.TTS_API_KEY;
    if (!apiKey) {
      throw new Error("Falta TTS_API_KEY para el proveedor elevenlabs.");
    }
    const voiceId = process.env.TTS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE_ID;

    const res = await fetchWithTimeout(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      },
      TTS_TIMEOUT_MS,
    );

    if (!res.ok) {
      const message = await res.text().catch(() => "");
      throw new Error(`ElevenLabs TTS falló (${res.status}): ${message}`);
    }

    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: "audio/mpeg",
    };
  },
};

const openaiProvider: TTSProviderImpl = {
  async synthesize(text) {
    const apiKey = process.env.TTS_API_KEY;
    if (!apiKey) {
      throw new Error("Falta TTS_API_KEY para el proveedor openai.");
    }

    const res = await fetchWithTimeout(
      "https://api.openai.com/v1/audio/speech",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          voice: "alloy",
          input: text,
        }),
      },
      TTS_TIMEOUT_MS,
    );

    if (!res.ok) {
      const message = await res.text().catch(() => "");
      throw new Error(`OpenAI TTS falló (${res.status}): ${message}`);
    }

    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: "audio/mpeg",
    };
  },
};

const googleProvider: TTSProviderImpl = {
  async synthesize() {
    throw new Error(
      "El proveedor 'google' de TTS todavía no está implementado. Usá 'elevenlabs' u 'openai' (TTS_PROVIDER), o implementalo acá siguiendo la misma interfaz TTSProviderImpl.",
    );
  },
};

const PROVIDERS: Record<string, TTSProviderImpl> = {
  elevenlabs: elevenLabsProvider,
  openai: openaiProvider,
  google: googleProvider,
};

/**
 * Convierte texto a audio usando el proveedor configurado en TTS_PROVIDER.
 * Cambiar de proveedor (google | elevenlabs | openai) es solo cambiar esa
 * variable de entorno — el resto del flujo no depende del proveedor.
 */
export async function synthesizeSpeech(text: string): Promise<TTSResult> {
  const providerName = process.env.TTS_PROVIDER || "elevenlabs";
  const provider = PROVIDERS[providerName];
  if (!provider) {
    throw new Error(`Proveedor de TTS desconocido: "${providerName}".`);
  }
  return provider.synthesize(text);
}
