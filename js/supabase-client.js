export const SUPABASE_URL = 'https://ivkycrfpuegfhoesspqg.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_-QWw_0qyPzqAqxJNO1iVIg_kh3-TYNl';

let clientPromise;

export function getSupabase() {
  if (!clientPromise) {
    clientPromise = import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm')
      .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      }));
  }
  return clientPromise;
}

export async function ensureAnonymousSession() {
  const supabase = await getSupabase();
  const { data: current, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (current.session) return { supabase, session: current.session };
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return { supabase, session: data.session };
}
