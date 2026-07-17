import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Todas las llamadas del cliente admin (Storage y Postgrest) pasan por
 * fetch sin timeout por defecto — una sola request colgada (un upload a
 * Storage, un update de tabla) deja esa promesa esperando para siempre y
 * traba el segmento entero del worker (visto en producción: la generación
 * queda pegada en el último segmento aunque los fetch externos ya tengan
 * timeout, ver src/lib/fetch-with-timeout.ts). Se envuelve con el mismo
 * mecanismo de AbortController acá para cubrir también estas llamadas.
 */
const ADMIN_FETCH_TIMEOUT_MS = 120000;

function timedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ADMIN_FETCH_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timeout),
  );
}

/**
 * Privileged client using the service role key — bypasses RLS.
 * Only for the worker and trusted server-side Route Handlers.
 * The "server-only" import makes any accidental client-bundle
 * import fail at build time instead of leaking the key.
 */
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        fetch: timedFetch,
      },
    },
  );
}
