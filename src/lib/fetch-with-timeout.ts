import "server-only";

/**
 * fetch con timeout. Sin esto, una request externa que nunca responde (ni
 * éxito ni error) deja una promesa colgada para siempre — y como el worker
 * espera con Promise.allSettled/Promise.all, UN solo segmento así traba
 * el job entero (visto en producción: 63/64 audios y nunca terminaba).
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 30000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      let host = url;
      try {
        host = new URL(url).hostname;
      } catch {
        // deja "url" tal cual si no se pudo parsear
      }
      throw new Error(
        `La solicitud a ${host} tardó más de ${Math.round(timeoutMs / 1000)}s y se canceló.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
