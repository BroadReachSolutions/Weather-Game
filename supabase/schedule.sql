-- ============================================================
-- Oregon Sail — Schedule the voyage tick every 10 minutes
-- Run this in the Supabase SQL Editor.
-- Requires: pg_cron + pg_net enabled, and the secret key already
-- stored in Vault as 'oregon_sail_secret_key' (done).
-- ============================================================

select cron.schedule(
  'oregon-sail-tick-voyages',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://ailcwfpjlelofhqmqzdy.supabase.co/functions/v1/tick-voyages',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'oregon_sail_secret_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
