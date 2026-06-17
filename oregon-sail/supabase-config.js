/* ============================================================
   Oregon Sail — Supabase config
   ============================================================ */

const SUPABASE_URL = "https://ailcwfpjlelofhqmqzdy.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_3QZVUGb46lWu2ubdurS2Qg_vWNMZ44e";

/* Loaded via CDN script tag in index.html:
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
   which exposes a global `supabase` factory function. */
const sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
