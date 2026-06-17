/* ============================================================
   Oregon Sail — Game Core
   Handles: device identity, boat load/create, live interpolated
   position between server ticks, course setting.
   ============================================================ */

const OS = {}; /* Oregon Sail namespace, attached to window */

/* ---------------------------------------------------------------
   DEVICE IDENTITY
   No accounts yet — a random id stored in localStorage identifies
   "this device's boat". Swap for real auth.uid() later without
   changing the rest of the game logic.
   --------------------------------------------------------------- */
OS.getDeviceId = function () {
  let id = localStorage.getItem("oregonSailDeviceId");
  if (!id) {
    id = "dev_" + crypto.randomUUID();
    localStorage.setItem("oregonSailDeviceId", id);
  }
  return id;
};

/* ---------------------------------------------------------------
   BOAT LOAD / CREATE
   --------------------------------------------------------------- */
OS.boat = null; /* current boat row, kept in memory */

OS.loadOrCreateBoat = async function () {
  const deviceId = OS.getDeviceId();

  const { data: existing, error: fetchErr } = await sbClient
    .from("boats")
    .select("*")
    .eq("device_id", deviceId)
    .maybeSingle();

  if (fetchErr) {
    console.error("Oregon Sail: failed to fetch boat", fetchErr);
    return null;
  }

  if (existing) {
    OS.boat = existing;
    return existing;
  }

  /* First time on this device — create a new boat at the starting port */
  const { data: created, error: insertErr } = await sbClient
    .from("boats")
    .insert({ device_id: deviceId })
    .select()
    .single();

  if (insertErr) {
    console.error("Oregon Sail: failed to create boat", insertErr);
    return null;
  }

  OS.boat = created;
  return created;
};

OS.refreshBoat = async function () {
  if (!OS.boat) return null;
  const { data, error } = await sbClient
    .from("boats")
    .select("*")
    .eq("id", OS.boat.id)
    .single();
  if (!error && data) OS.boat = data;
  return OS.boat;
};

/* ---------------------------------------------------------------
   COURSE SETTING
   Player picks a destination port; we calculate bearing and store
   it. The backend tick function does the actual moving.
   --------------------------------------------------------------- */
OS.NM_PER_DEGREE_LAT = 60; /* 1 degree latitude ≈ 60 nautical miles */

OS.haversineNm = function (lat1, lon1, lat2, lon2) {
  const R = 3440.065; /* Earth radius in nautical miles */
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

OS.bearingDeg = function (lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

OS.setCourse = async function (destLat, destLon, mode) {
  if (!OS.boat) return;
  const bearing = OS.bearingDeg(OS.boat.lat, OS.boat.lon, destLat, destLon);

  const { data, error } = await sbClient
    .from("boats")
    .update({
      destination_lat: destLat,
      destination_lon: destLon,
      course_bearing: bearing,
      course_mode: mode || "sailing",
      updated_at: new Date().toISOString()
    })
    .eq("id", OS.boat.id)
    .select()
    .single();

  if (!error && data) OS.boat = data;
  return { data, error };
};

OS.dropAnchor = async function () {
  if (!OS.boat) return;
  const { data, error } = await sbClient
    .from("boats")
    .update({ course_mode: "anchored", updated_at: new Date().toISOString() })
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (!error && data) OS.boat = data;
  return { data, error };
};

/* ---------------------------------------------------------------
   LIVE POSITION INTERPOLATION
   The backend only moves the boat once per tick (every 10 min).
   To make the app feel alive while open, we estimate the boat's
   *current* position client-side by projecting forward from
   last_tick_at using the boat's last known speed/bearing — purely
   visual, corrected back to truth on every refresh from the server.
   --------------------------------------------------------------- */
OS.estimateLiveLatLon = function (boat, assumedSpeedKt) {
  if (!boat || boat.course_mode !== "sailing" && boat.course_mode !== "motoring") {
    return { lat: boat.lat, lon: boat.lon };
  }
  const secondsSinceTick = (Date.now() - new Date(boat.last_tick_at).getTime()) / 1000;
  const hoursSinceTick = Math.min(secondsSinceTick / 3600, 10 / 60); /* cap at one tick interval */
  const speedKt = assumedSpeedKt || 4; /* conservative default cruising speed */
  const nmTravelled = speedKt * hoursSinceTick;

  if (nmTravelled <= 0 || boat.course_bearing == null) return { lat: boat.lat, lon: boat.lon };

  const bearingRad = boat.course_bearing * Math.PI / 180;
  const dLat = (nmTravelled / 60) * Math.cos(bearingRad);
  const dLon = (nmTravelled / 60) * Math.sin(bearingRad) / Math.cos(boat.lat * Math.PI / 180);

  return { lat: boat.lat + dLat, lon: boat.lon + dLon };
};

window.OS = OS;
