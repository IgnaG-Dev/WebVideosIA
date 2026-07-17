import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

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
    },
  );
}
