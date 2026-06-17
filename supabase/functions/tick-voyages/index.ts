// ============================================================
// Oregon Sail — tick-voyages Edge Function
//
// Runs on a schedule (every 10 min via Supabase Cron) and advances
// every boat that's currently "sailing" or "motoring":
//   1. Fetch real wind data for the boat's current lat/lon
//   2. Calculate how far it moves this tick based on wind + heading
//   3. Consume food/water/fuel
//   4. Roll for storm/becalmed events
//   5. Check ICWW shallow-water risk if applicable
//   6. Write the new position + a tick_log entry
//
// Deploy with: supabase functions deploy tick-voyages
// Schedule with: supabase functions schedule (or SQL cron — see
// supabase/schedule.sql)
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const TICK_MINUTES = 10;
const FOOD_PER_TICK = 0.15;   /* tune these consumption rates as you balance the game */
const WATER_PER_TICK = 0.2;
const FUEL_PER_NM_MOTORING = 0.8;

Deno.serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: boats, error } = await supabase
    .from("boats")
    .select("*")
    .in("course_mode", ["sailing", "motoring"]);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const results = [];

  for (const boat of boats) {
    try {
      const outcome = await tickBoat(supabase, boat);
      results.push({ boat_id: boat.id, ...outcome });
    } catch (e) {
      results.push({ boat_id: boat.id, error: String(e) });
    }
  }

  return new Response(JSON.stringify({ ticked: results.length, results }), {
    headers: { "Content-Type": "application/json" }
  });
});

async function tickBoat(supabase, boat) {
  /* 1. Fetch real wind for the boat's current position */
  const weather = await fetchWind(boat.lat, boat.lon);

  /* 2. Out of supplies? Boat is stuck — log and bail before moving */
  if (boat.food <= 0 || boat.water <= 0 || (boat.course_mode === "motoring" && boat.fuel <= 0)) {
    await logTick(supabase, boat, weather, {
      nm_moved: 0,
      event_type: "stranded",
      event_message: "Out of supplies — voyage halted until restocked."
    });
    return { event: "stranded" };
  }

  /* 3. Determine speed for this tick */
  let speedKt;
  let fuelUsed = 0;

  if (boat.course_mode === "motoring") {
    speedKt = 6; /* steady motor speed regardless of wind */
  } else {
    /* Sailing speed depends on wind strength and angle to course.
       Simplified model: stronger wind = faster, until it's too strong (storm). */
    const windKt = weather.windSpeedKt;
    const angleToWind = angleDiff(boat.course_bearing ?? 0, weather.windDirDeg);
    const anglePenalty = angleToWind > 150 ? 0.3 : angleToWind < 30 ? 0.5 : 1; /* into-wind or dead-downwind is slow */
    speedKt = Math.min(windKt * 0.4, 8) * anglePenalty;
    if (windKt < 3) speedKt = Math.max(speedKt, 0.5); /* becalmed crawl */
  }

  const hours = TICK_MINUTES / 60;
  let nmMoved = speedKt * hours;

  let hullDamage = 0;
  let eventType = "normal";
  let eventMessage = null;

  /* 4. Storm check — high wind/wave damages hull and can push off course */
  if (weather.windSpeedKt >= 30 || weather.waveHeightFt >= 8) {
    hullDamage = randRange(2, 8);
    eventType = "storm";
    eventMessage = `Storm! ${Math.round(weather.windSpeedKt)}kt winds, ${weather.waveHeightFt.toFixed(1)}ft seas. Hull took damage.`;
    /* storms knock the boat off its planned bearing somewhat */
    nmMoved *= 0.6;
  } else if (weather.windSpeedKt < 3) {
    eventType = "becalmed";
    eventMessage = "Becalmed — barely any wind.";
  }

  /* 5. ICWW shallow water check (only matters if boat is flagged as in ICWW) */
  if (boat.leg_name && boat.leg_name.toLowerCase().includes("icww")) {
    const tideRisk = await checkLowTideRisk(boat.lat, boat.lon);
    if (tideRisk.isLow) {
      eventType = "low_tide_grounding";
      eventMessage = `Low tide (${tideRisk.heightFt.toFixed(1)}ft) in the ICWW — proceed with caution, ran aground briefly.`;
      nmMoved *= 0.3;
      hullDamage += randRange(0, 2);
    }
  }

  /* 6. Project new position along course bearing */
  let newLat = boat.lat;
  let newLon = boat.lon;
  if (boat.course_bearing != null && nmMoved > 0) {
    const bearingRad = (boat.course_bearing * Math.PI) / 180;
    const dLat = (nmMoved / 60) * Math.cos(bearingRad);
    const dLon = (nmMoved / 60) * Math.sin(bearingRad) / Math.cos((boat.lat * Math.PI) / 180);
    newLat = boat.lat + dLat;
    newLon = boat.lon + dLon;
  }

  if (boat.course_mode === "motoring") {
    fuelUsed = nmMoved * FUEL_PER_NM_MOTORING;
  }

  const newFood = Math.max(0, boat.food - FOOD_PER_TICK);
  const newWater = Math.max(0, boat.water - WATER_PER_TICK);
  const newFuel = Math.max(0, boat.fuel - fuelUsed);
  const newHull = Math.max(0, boat.hull_health - hullDamage);

  /* 7. Arrived at destination? */
  let courseMode = boat.course_mode;
  if (boat.destination_lat != null) {
    const distToDest = haversineNm(newLat, newLon, boat.destination_lat, boat.destination_lon);
    if (distToDest < 2) {
      courseMode = "anchored";
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
      course_mode: courseMode,
      total_nm_traveled: (boat.total_nm_traveled || 0) + nmMoved,
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

  return { event: eventType, nmMoved };
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

  /* Wave height isn't in open-meteo's basic forecast — approximate from
     wind speed using a simplified sea-state relationship. Swap for a
     real marine API (e.g. NOAA buoy / Open-Meteo Marine API) later. */
  const windSpeedKt = data?.current?.wind_speed_10m ?? 10;
  const windDirDeg = data?.current?.wind_direction_10m ?? 0;
  const waveHeightFt = Math.max(0.5, (windSpeedKt / 10) * 1.8);

  return { windSpeedKt, windDirDeg, waveHeightFt };
}

async function checkLowTideRisk(lat, lon) {
  /* Placeholder — wire to NOAA tide station data for the boat's
     nearest station once we map ICWW legs to station IDs. */
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

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}
