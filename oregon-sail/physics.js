/* ============================================================
   Oregon Sail — Shared Physics
   Browser-safe port of the speed/consumption formulas that live
   server-side in supabase/functions/tick-voyages/index.ts. Keeping
   this as a literal copy (not a reference) is intentional — the
   server function can't import browser JS, so we maintain both,
   but they MUST stay in sync. If you change the formula in one,
   change it in the other.

   Used by the client-side simulation loop (game-ui.js) to advance
   the boat smoothly in real time between server ticks.
   ============================================================ */

(function () {
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
    const reefPenalty = reefPenalties[reefLevel] ?? 1.0;

    const overpowered = windSpeedMph > currentCeiling;
    const overFactor = overpowered ? (windSpeedMph - currentCeiling) / currentCeiling : 0;

    const hullSpeed = boat.hull_speed_kt ?? 6.5;
    let speedKt = hullSpeed * pos.speedFactor * trimFactor * windFactor * reefPenalty;
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
    if (engineKt < 0) return engineKt;
    const primary = Math.max(sailKt, engineKt);
    const secondary = Math.min(sailKt, engineKt);
    const combined = primary + secondary * 0.3;
    return Math.max(0, Math.min(hullSpeedKt, combined));
  }

  /* Fuel burn rate, per hour (matches the per-10-min rate in the
     server tick function, scaled up: tick used 0.05-0.6 per 10 min,
     so per hour that's ×6) */
  const FUEL_PER_HOUR_AT_IDLE = 0.05 * 6;
  const FUEL_PER_HOUR_AT_MAX = 0.6 * 6;
  const FOOD_PER_HOUR = 0.15 * 6;
  const WATER_PER_HOUR = 0.2 * 6;

  function calculateFuelBurnPerHour(boat) {
    if (!boat.engine_on) return 0;
    const rpm = boat.throttle_rpm ?? 800;
    const rpmFactor = Math.max(0, Math.min(1, (rpm - 800) / (3200 - 800)));
    return FUEL_PER_HOUR_AT_IDLE + rpmFactor * (FUEL_PER_HOUR_AT_MAX - FUEL_PER_HOUR_AT_IDLE);
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

  /* ---------------------------------------------------------------
     ADVANCE — the core simulation step. Given the boat's current
     state, the wind, and an elapsed time in hours, returns the new
     position/resources after that much time has passed. Used by
     the client loop with small elapsed times (~1s) for smooth
     real-time movement.
     --------------------------------------------------------------- */
  function advance(boat, windSpeedKt, windDirDeg, elapsedHours) {
    const windSpeedMph = windSpeedKt * 1.15078;
    const sail = calculateSailSpeed(boat, windSpeedMph, windDirDeg);
    const engineKt = calculateEngineSpeed(boat);
    const hullSpeed = boat.hull_speed_kt ?? 6.5;
    const speedKt = combineSpeed(sail.speedKt, engineKt, hullSpeed);

    const nmMoved = speedKt * elapsedHours;

    let newLat = boat.lat;
    let newLon = boat.lon;
    if (boat.course_bearing != null && nmMoved !== 0) {
      const bearingRad = (boat.course_bearing * Math.PI) / 180;
      const dLat = (nmMoved / 60) * Math.cos(bearingRad);
      const dLon = (nmMoved / 60) * Math.sin(bearingRad) / Math.cos((boat.lat * Math.PI) / 180);
      newLat = boat.lat + dLat;
      newLon = boat.lon + dLon;
    }

    const fuelUsed = calculateFuelBurnPerHour(boat) * elapsedHours;
    const foodUsed = FOOD_PER_HOUR * elapsedHours;
    const waterUsed = WATER_PER_HOUR * elapsedHours;

    return {
      lat: newLat,
      lon: newLon,
      speedKt,
      sailSpeedKt: sail.speedKt,
      engineKt,
      pointOfSail: sail.pointOfSail,
      overpowered: sail.overpowered,
      overFactor: sail.overFactor,
      nmMoved,
      fuelUsed,
      foodUsed,
      waterUsed
    };
  }

  window.OSPhysics = {
    calculatePointOfSail,
    trimQualityFactor,
    calculateSailSpeed,
    calculateEngineSpeed,
    combineSpeed,
    calculateFuelBurnPerHour,
    haversineNm,
    advance
  };
})();
