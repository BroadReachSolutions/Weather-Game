// Oregon Sail — google-terrain-session Edge Function
//
// Proxies the Google Maps Tile API createSession POST server-side,
// bypassing the CORS block that prevents calling it directly from
// the browser. The client sends its API key in the request body;
// this function forwards it to Google and returns the session token.
//
// This is an authoring/import tool only -- not called during gameplay,
// only called from the map editor when a bulk import is being run.
//
// Deploy with: npx supabase functions deploy google-terrain-session

Deno.serve(async (req: Request) => {
  /* Allow the map editor (any origin on GitHub Pages / localhost)
     to call this function -- CORS headers on the OPTIONS preflight
     and on the actual response. */
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  let apiKey: string;
  try {
    const body = await req.json();
    apiKey = body.apiKey;
    if (!apiKey || typeof apiKey !== "string" || apiKey.length < 10) {
      return new Response(JSON.stringify({ error: "Missing or invalid apiKey" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  /* Forward to Google's createSession endpoint. Terrain requires
     layerRoadmap -- that's what gives the clean, solid color
     land/water boundaries visible on the Google Maps terrain layer. */
  const googleResp = await fetch(
    `https://tile.googleapis.com/v1/createSession?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mapType: "terrain",
        language: "en-US",
        region: "US",
        layerTypes: ["layerRoadmap"]
      })
    }
  );

  const googleData = await googleResp.json();

  if (!googleResp.ok || !googleData.session) {
    return new Response(JSON.stringify({
      error: "Google session request failed",
      status: googleResp.status,
      detail: googleData
    }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ session: googleData.session }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
});
