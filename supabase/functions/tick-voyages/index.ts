// ============================================================
// Oregon Sail — tick-voyages Edge Function (v2: real physics)
//
// Runs on a schedule (every 10 min via Supabase Cron) and advances
// every boat that has sailing_active OR engine_on:
//   1. Fetch real wind data for the boat's current lat/lon
//   2. Calculate sail speed (point of sail, trim quality, reef level)
//   3. Calculate engine speed (RPM curve, independent of sailing)
//   4. Combine into one speed, capped at hull_speed_kt
//   5. Roll for overpowered-sail damage risk if wind exceeds the
//      current reef level's safe ceiling
//   6. Consume food/water/fuel
//   7. Check ICWW shallow-water risk if applicable
//   8. Write the new position + speed_over_ground + a tick_log entry
//
// Deploy with: npx supabase functions deploy tick-voyages
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const TICK_MINUTES = 10;
const FOOD_PER_TICK = 0.15;
const WATER_PER_TICK = 0.2;

const FUEL_PER_TICK_AT_IDLE = 0.05;
const FUEL_PER_TICK_AT_MAX = 0.6;

Deno.serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: boats, error } = await supabase
    .from("boats")
    .select("*")
    .or("sailing_active.eq.true,engine_on.eq.true");

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  /* If the player's phone/browser is open, its client-side simulation
     loop pushes fresh state every 10 min (see game-ui.js's
     syncStateToServer + OS.pushSimulatedState). That push stamps
     last_tick_at. If it's recent, the client is actively keeping this
     boat up to date — skip it here to avoid double-applying the same
     time window's movement/consumption. If last_tick_at is stale (or
     missing), the app is closed and this tick is the only thing
     moving the boat, so we proceed normally. */
  const SKIP_IF_TICKED_WITHIN_MS = 8 * 60 * 1000; /* 8 min, just under the 10-min cycle */
  const now = Date.now();
  const dueBoats = boats.filter((boat) => {
    if (!boat.last_tick_at) return true;
    const lastTickMs = new Date(boat.last_tick_at).getTime();
    return (now - lastTickMs) > SKIP_IF_TICKED_WITHIN_MS;
  });

  const results = [];
  for (const boat of dueBoats) {
    try {
      const outcome = await tickBoat(supabase, boat);
      results.push({ boat_id: boat.id, ...outcome });
    } catch (e) {
      results.push({ boat_id: boat.id, error: String(e) });
    }
  }

  return new Response(JSON.stringify({ ticked: results.length, skipped: boats.length - dueBoats.length, results }), {
    headers: { "Content-Type": "application/json" }
  });
});

const POINTS_OF_SAIL = [
  { max: 45,  name: "No-Go Zone",   idealBoom: null, speedFactor: 0 },
  { max: 60,  name: "Close-Hauled", idealBoom: 15,   speedFactor: 0.7 },
  { max: 80,  name: "Close Reach",  idealBoom: 28,   speedFactor: 0.9 },
  { max: 120, name: "Beam Reach",   idealBoom: 45,   speedFactor: 1.0 },
  { max: 150, name: "Broad Reach",  idealBoom: 65,   speedFactor: 0.9 },
  { max: 181, name: "Running",      idealBoom: 85,   speedFactor: 0.75 }
];

function angleDiff180(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function calculatePointOfSail(headingDeg, windFromDeg) {
  const windAngle = angleDiff180(headingDeg, windFromDeg);
  const pos = POINTS_OF_SAIL.find(p => windAngle <= p.max) || POINTS_OF_SAIL[POINTS_OF_SAIL.length - 1];
  const relative = ((windFromDeg - headingDeg) + 360) % 360;
  const windOnPort = relative > 180;
  const idealBoomSigned = pos.idealBoom == null ? 0 : (windOnPort ? pos.idealBoom : -pos.idealBoom);
  return { windAngle, ...pos, idealBoomSigned };
}

function trimQualityFactor(actualBoomAngle, idealBoomSigned, isNoGoZone) {
  if (isNoGoZone) return 0;
  const diff = Math.abs(actualBoomAngle - idealBoomSigned);
  if (diff <= 6)  return 1.0;
  if (diff <= 14) return 0.85;
  if (diff <= 25) return 0.6;
  if (diff <= 40) return 0.35;
  return 0.1;
}

function calculateSailSpeed(boat, windSpeedMph, windFromDeg) {
  if (!boat.sailing_active) return { speedKt: 0, pointOfSail: null, overpowered: false, overFactor: 0 };

  const heading = boat.course_bearing ?? 0;
  const pos = calculatePointOfSail(heading, windFromDeg);
  const isNoGo = pos.name === "No-Go Zone";
  const trimFactor = trimQualityFactor(boat.boom_angle ?? 0, pos.idealBoomSigned, isNoGo);

  const ratedWindMph = boat.rated_wind_mph ?? 15;
  const windFactor = Math.min(1, windSpeedMph / ratedWindMph);

  const reefLevel = boat.reef_level ?? 0;
  const reefLimits = boat.reef_wind_limits_mph ?? [25, 30, 35];
  const reefPenalties = boat.reef_speed_penalty ?? [1.0, 0.85, 0.65];
  const currentCeiling = reefLimits[reefLevel] ?? reefLimits[reefLimits.length - 1];

  const overpowered = windSpeedMph > currentCeiling;
  const overFactor = overpowered ? (windSpeedMph - currentCeiling) / currentCeiling : 0;

  /* Effective sail area: main scaled by its reef factor, jib scaled
     continuously by how much is furled in. Mirrors the client-side
     physics.js formula exactly — keep both in sync. */
  const mainArea = boat.main_sail_area_sqft ?? 245;
  const jibArea = boat.jib_sail_area_sqft ?? 105;
  const totalFullArea = mainArea + jibArea;
  const mainReefFactor = reefPenalties[reefLevel] ?? 1.0;
  const jibFurlFactor = Math.max(0, Math.min(100, boat.jib_furl_pct ?? 100)) / 100;
  const effectiveAreaRatio = totalFullArea > 0
    ? (mainArea * mainReefFactor + jibArea * jibFurlFactor) / totalFullArea
    : 1.0;

  const hullSpeed = boat.hull_speed_kt ?? 6.5;
  let speedKt = hullSpeed * pos.speedFactor * trimFactor * windFactor * effectiveAreaRatio;
  speedKt = Math.max(0, Math.min(hullSpeed, speedKt));

  return { speedKt, pointOfSail: pos.name, overpowered, overFactor, reefLevel };
}

function calculateEngineSpeed(boat) {
  if (!boat.engine_on) return 0;
  const rpm = boat.throttle_rpm ?? 800;
  const gear = boat.engine_gear ?? "neutral";
  if (gear === "neutral") return 0;

  let speedKt;
  if (rpm <= 1800) {
    speedKt = ((rpm - 800) / (1800 - 800)) * 4;
  } else {
    speedKt = 4 + ((rpm - 1800) / (3200 - 1800)) * 1;
  }
  speedKt = Math.max(0, Math.min(5, speedKt));

  return gear === "reverse" ? -speedKt : speedKt;
}

function combineSpeed(sailKt, engineKt, hullSpeedKt) {
  if (engineKt < 0) {
    return engineKt;
  }
  const primary = Math.max(sailKt, engineKt);
  const secondary = Math.min(sailKt, engineKt);
  const combined = primary + secondary * 0.3;
  return Math.max(0, Math.min(hullSpeedKt, combined));
}

async function tickBoat(supabase, boat) {
  const weather = await fetchWind(boat.lat, boat.lon);
  const windSpeedMph = weather.windSpeedKt * 1.15078;

  const fuelNeeded = boat.engine_on;
  if (boat.food <= 0 || boat.water <= 0 || (fuelNeeded && boat.fuel <= 0)) {
    await logTick(supabase, boat, weather, {
      nm_moved: 0,
      event_type: "stranded",
      event_message: "Out of supplies — voyage halted until restocked."
    });
    return { event: "stranded" };
  }

  const sail = calculateSailSpeed(boat, windSpeedMph, weather.windDirDeg);
  const engineKt = calculateEngineSpeed(boat);
  const hullSpeed = boat.hull_speed_kt ?? 6.5;
  const speedKt = combineSpeed(sail.speedKt, engineKt, hullSpeed);

  const hours = TICK_MINUTES / 60;
  let nmMoved = speedKt * hours;

  let hullDamage = 0;
  let eventType = "normal";
  let eventMessage = null;

  if (sail.overpowered && boat.sailing_active) {
    const damageChance = Math.min(0.6, sail.overFactor * 0.5);
    if (Math.random() < damageChance) {
      hullDamage = randRange(2, 6) * (1 + sail.overFactor);
      eventType = "overpowered";
      eventMessage = `Overpowered! Wind ${Math.round(windSpeedMph)}mph exceeds your reef setting's safe limit — sail/rigging strain caused damage.`;
    }
  }

  if (weather.waveHeightFt >= 8 && eventType === "normal") {
    hullDamage += randRange(1, 4);
    eventType = "storm";
    eventMessage = `Rough seas: ${weather.waveHeightFt.toFixed(1)}ft waves.`;
    nmMoved *= 0.7;
  }

  if (boat.leg_name && boat.leg_name.toLowerCase().includes("icww")) {
    const tideRisk = await checkLowTideRisk(boat.lat, boat.lon);
    if (tideRisk.isLow) {
      eventType = "low_tide_grounding";
      eventMessage = `Low tide (${tideRisk.heightFt.toFixed(1)}ft) in the ICWW — ran aground briefly.`;
      nmMoved *= 0.3;
      hullDamage += randRange(0, 2);
    }
  }

  let newLat = boat.lat;
  let newLon = boat.lon;
  if (boat.course_bearing != null && nmMoved !== 0) {
    const bearingRad = (boat.course_bearing * Math.PI) / 180;
    const dLat = (nmMoved / 60) * Math.cos(bearingRad);
    const dLon = (nmMoved / 60) * Math.sin(bearingRad) / Math.cos((boat.lat * Math.PI) / 180);
    newLat = boat.lat + dLat;
    newLon = boat.lon + dLon;
  }

  let fuelUsed = 0;
  if (boat.engine_on) {
    const rpm = boat.throttle_rpm ?? 800;
    const rpmFactor = Math.max(0, Math.min(1, (rpm - 800) / (3200 - 800)));
    fuelUsed = FUEL_PER_TICK_AT_IDLE + rpmFactor * (FUEL_PER_TICK_AT_MAX - FUEL_PER_TICK_AT_IDLE);
  }

  const newFood = Math.max(0, boat.food - FOOD_PER_TICK);
  const newWater = Math.max(0, boat.water - WATER_PER_TICK);
  const newFuel = Math.max(0, boat.fuel - fuelUsed);
  const newHull = Math.max(0, boat.hull_health - hullDamage);

  let sailingActive = boat.sailing_active;
  if (boat.destination_lat != null) {
    const distToDest = haversineNm(newLat, newLon, boat.destination_lat, boat.destination_lon);
    if (distToDest < 2) {
      sailingActive = false;
      eventType = "arrived";
      eventMessage = "Arrived at destination!";
    }
  }

  await supabase
    .from("boats")
    .update({
      lat: newLat,
      lon: newLon,
      food: newFood,
      water: newWater,
      fuel: newFuel,
      hull_health: newHull,
      sailing_active: sailingActive,
      speed_over_ground_kt: speedKt,
      total_nm_traveled: (boat.total_nm_traveled || 0) + Math.abs(nmMoved),
      last_tick_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", boat.id);

  await logTick(supabase, boat, weather, {
    nm_moved: nmMoved,
    food_consumed: FOOD_PER_TICK,
    water_consumed: WATER_PER_TICK,
    fuel_consumed: fuelUsed,
    hull_damage: hullDamage,
    event_type: eventType,
    event_message: eventMessage
  });

  return { event: eventType, nmMoved, speedKt, sailSpeedKt: sail.speedKt, engineKt, pointOfSail: sail.pointOfSail };
}

async function logTick(supabase, boat, weather, fields) {
  await supabase.from("tick_log").insert({
    boat_id: boat.id,
    wind_speed_kt: weather?.windSpeedKt ?? null,
    wind_dir_deg: weather?.windDirDeg ?? null,
    wave_height_ft: weather?.waveHeightFt ?? null,
    ...fields
  });
}

async function fetchWind(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&timezone=UTC`;
  const res = await fetch(url);
  const data = await res.json();

  const windSpeedKt = data?.current?.wind_speed_10m ?? 10;
  const windDirDeg = data?.current?.wind_direction_10m ?? 0;
  const waveHeightFt = Math.max(0.5, (windSpeedKt / 10) * 1.8);

  return { windSpeedKt, windDirDeg, waveHeightFt };
}

async function checkLowTideRisk(lat, lon) {
  return { isLow: false, heightFt: 2.0 };
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}
