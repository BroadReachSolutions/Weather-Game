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

    const overpowered = windSpeedMph > currentCeiling;
    const overFactor = overpowered ? (windSpeedMph - currentCeiling) / currentCeiling : 0;

    /* Effective sail area: main scaled by its reef factor, jib scaled
       continuously by how much is furled in, and — when sailing deep
       downwind (Broad Reach or Running) — a spinnaker contributes its
       own area too. A spinnaker provides essentially no benefit on
       any other point of sail (a real cruising chute collapses or
       has to be doused before turning upwind), so it's deliberately
       excluded from the area total outside those two zones rather
       than just being weaker — this creates a real tactical choice
       about when to fly it. */
    const mainArea = boat.main_sail_area_sqft ?? 245;
    const jibArea = boat.jib_sail_area_sqft ?? 105;
    const spinnakerArea = boat.spinnaker_sail_area_sqft ?? 0;
    const spinnakerFurlFactor = Math.max(0, Math.min(100, boat.spinnaker_furl_pct ?? 0)) / 100;
    const isDownwind = pos.name === "Broad Reach" || pos.name === "Running";
    const effectiveSpinnakerArea = isDownwind ? spinnakerArea * spinnakerFurlFactor : 0;

    const totalFullArea = mainArea + jibArea + spinnakerArea;
    const mainReefFactor = reefPenalties[reefLevel] ?? 1.0;
    const jibFurlFactor = Math.max(0, Math.min(100, boat.jib_furl_pct ?? 100)) / 100;
    const effectiveAreaRatio = totalFullArea > 0
      ? (mainArea * mainReefFactor + jibArea * jibFurlFactor + effectiveSpinnakerArea) / totalFullArea
      : 1.0;

    const hullSpeed = boat.hull_speed_kt ?? 6.5;
    let speedKt = hullSpeed * pos.speedFactor * trimFactor * windFactor * effectiveAreaRatio;
    speedKt = Math.max(0, Math.min(hullSpeed, speedKt));

    return { speedKt, pointOfSail: pos.name, overpowered, overFactor, reefLevel, effectiveAreaRatio };
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

  function bearingDeg(lat1, lon1, lat2, lon2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function shortestAngleDelta(from, to) {
    let delta = ((to - from + 540) % 360) - 180;
    return delta;
  }

  /* ---------------------------------------------------------------
     STEERING
     Two modes:
     - Autopilot ON: heading eases toward the bearing to the
       destination (like a real autopilot holding a course)
     - Autopilot OFF: rudder_angle directly drives the turn rate.
       No steerage without speed — a becalmed boat with the wheel
       hard over doesn't spin in place, matching real sailing.
     Returns the new heading after elapsedHours of turning.
     --------------------------------------------------------------- */
  const AUTOPILOT_TURN_RATE_DEG_PER_HOUR = 32400; /* autopilot corrects a 90° heading error in about 10 seconds */
  const MAX_TURN_RATE_DEG_PER_HOUR_PER_KT = 72000; /* full rudder deflection completes a 360° turn in about 18 seconds, in line with how quickly a small sailboat actually turns */

  function updateHeading(boat, speedKt, elapsedHours) {
    const currentHeading = boat.course_bearing ?? 0;

    if (boat.autopilot_on && boat.destination_lat != null) {
      const targetBearing = bearingDeg(boat.lat, boat.lon, boat.destination_lat, boat.destination_lon);
      const delta = shortestAngleDelta(currentHeading, targetBearing);
      const maxStep = AUTOPILOT_TURN_RATE_DEG_PER_HOUR * elapsedHours;
      const step = Math.max(-maxStep, Math.min(maxStep, delta));
      return (currentHeading + step + 360) % 360;
    }

    /* Manual steering: turn rate depends on both rudder deflection
       and boat speed — no way on, no steerage */
    const rudder = boat.rudder_angle ?? 0; /* -45..45, negative = port */
    const speedFactor = Math.min(1, Math.abs(speedKt) / 3); /* full authority by ~3kt */
    const turnRateDegPerHour = (rudder / 45) * MAX_TURN_RATE_DEG_PER_HOUR_PER_KT * Math.max(0.15, speedFactor);
    const newHeading = (currentHeading + turnRateDegPerHour * elapsedHours + 360) % 360;
    return newHeading;
  }

  /* ---------------------------------------------------------------
     ADVANCE — the core simulation step. Given the boat's current
     state, the wind, and an elapsed time in hours, returns the new
     position/resources after that much time has passed. Used by
     the client loop with small elapsed times (~1s) for smooth
     real-time movement.
     --------------------------------------------------------------- */
  /* ---------------------------------------------------------------
     INERTIA
     The formulas above give the boat's EQUILIBRIUM speed for its
     current trim/wind/reef — but a real boat doesn't snap to that
     speed instantly. It accelerates as the sails load up and
     decelerates gradually from hull drag/momentum when conditions
     ease off. Without this, every small trim adjustment or wind gust
     made the boat's speed visibly teleport, which read as twitchy
     and lifeless rather than something with real mass moving through
     water. boat.speed_over_ground_kt is used as the persistent
     "current" speed across ticks; targetSpeedKt is the instantaneous
     equilibrium value the formulas compute.
     --------------------------------------------------------------- */
  const ACCEL_TIME_CONSTANT_SEC = 3;   /* speeding up: ~3s to close most of the gap */
  const DECEL_TIME_CONSTANT_SEC = 7;   /* slowing down: slower, like coasting off momentum */

  function applyInertia(currentSpeedKt, targetSpeedKt, elapsedHours) {
    const elapsedSec = elapsedHours * 3600;
    const speedingUp = targetSpeedKt > currentSpeedKt;
    const timeConstant = speedingUp ? ACCEL_TIME_CONSTANT_SEC : DECEL_TIME_CONSTANT_SEC;
    /* Exponential approach — closes a consistent FRACTION of the
       remaining gap per unit time, so it eases in/out instead of
       moving at a constant rate (which would overshoot or feel robotic) */
    const alpha = 1 - Math.exp(-elapsedSec / timeConstant);
    return currentSpeedKt + (targetSpeedKt - currentSpeedKt) * alpha;
  }

  function advance(boat, windSpeedKt, windDirDeg, elapsedHours) {
    const windSpeedMph = windSpeedKt * 1.15078;
    const sail = calculateSailSpeed(boat, windSpeedMph, windDirDeg);
    const engineKt = calculateEngineSpeed(boat);
    const hullSpeed = boat.hull_speed_kt ?? 6.5;
    let targetSpeedKt = combineSpeed(sail.speedKt, engineKt, hullSpeed);

    /* Testing easter egg: captain "Sonic" sailing vessel "Sonic"
       gets a 100x speed multiplier for rapid playtesting */
    const isSonic = (boat.captain_name || "").trim().toLowerCase() === "sonic" &&
                     (boat.vessel_name || "").trim().toLowerCase() === "sonic";
    if (isSonic) targetSpeedKt *= 100;

    /* Ease the boat's actual speed toward the target instead of
       snapping to it — see INERTIA block above. Reversing (negative
       target, e.g. engine in reverse) skips easing since that's a
       deliberate gear change, not a drift in conditions. */
    const currentSpeedKt = boat.speed_over_ground_kt ?? 0;
    const speedKt = (targetSpeedKt < 0 || currentSpeedKt < 0)
      ? targetSpeedKt
      : applyInertia(currentSpeedKt, targetSpeedKt, elapsedHours);

    /* Steer before moving, so this tick's movement reflects the
       updated heading (autopilot correction or manual rudder turn) */
    const newHeading = updateHeading(boat, speedKt, elapsedHours);
    boat.course_bearing = newHeading;

    const nmMoved = speedKt * elapsedHours;

    let newLat = boat.lat;
    let newLon = boat.lon;
    if (nmMoved !== 0) {
      const bearingRad = (newHeading * Math.PI) / 180;
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
      heading: newHeading,
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

  /* ---------------------------------------------------------------
     ELECTRICAL SYSTEM — Phase 2: generation sources. All real-world
     wattage math, feeding the house battery bank per the original
     design spec (solar/wind/generator all charge the house bank;
     dedicated batteries like start/generator-start/bow-thruster
     aren't charged by these sources in this phase).
     --------------------------------------------------------------- */

  /* Solar output follows a smooth bell curve through the day: zero
     before sunrise and after sunset, peaking at the panel's full
     rated wattage at solar noon. Uses a half-wave sine shape (clean,
     smooth ramp-up/down) rather than a literal Gaussian, which is a
     close enough real-world approximation for gameplay purposes and
     much simpler to reason about. */
  function calculateSolarOutput(ratedWatts, hourOfDay) {
    if (!ratedWatts || ratedWatts <= 0) return 0;
    const sunriseHour = 6, sunsetHour = 18; /* simple fixed daylight window */
    if (hourOfDay <= sunriseHour || hourOfDay >= sunsetHour) return 0;
    const dayLength = sunsetHour - sunriseHour;
    const t = (hourOfDay - sunriseHour) / dayLength; /* 0..1 across the daylight window */
    const bellCurve = Math.sin(t * Math.PI); /* 0 at sunrise/sunset, 1 at solar noon */
    return ratedWatts * bellCurve;
  }

  /* Wind generator output scales with real wind speed: negligible
     below a cut-in speed (most small marine wind generators need
     ~6-8kt before producing meaningful power), ramping up through
     the useful range, then capped at the unit's rated max once wind
     is strong enough — real wind generators don't keep producing
     more and more power linearly forever, they're governed/capped. */
  function calculateWindGeneratorOutput(ratedWatts, windSpeedKt) {
    if (!ratedWatts || ratedWatts <= 0) return 0;
    const cutInKt = 6;
    const ratedAtKt = 25; /* wind speed at which the unit hits its full rated output */
    if (windSpeedKt <= cutInKt) return 0;
    const t = Math.min(1, (windSpeedKt - cutInKt) / (ratedAtKt - cutInKt));
    /* Cubic ramp — wind generator output realistically scales closer
       to the cube of wind speed in the real (uncapped) regime, which
       gives a more authentic slow-start/fast-ramp feel than a
       straight line, before being capped at 1.0 (rated max). */
    return ratedWatts * Math.pow(t, 1.6);
  }

  /* Generator: flat rated output while running, zero otherwise.
     Fuel consumption scales with the configured gal/hr rating
     (itself proportional to the generator's rated wattage when the
     boat was configured), only burning fuel while actually running. */
  function calculateGeneratorOutput(ratedWatts, isRunning) {
    if (!ratedWatts || ratedWatts <= 0 || !isRunning) return 0;
    return ratedWatts;
  }
  function calculateGeneratorFuelBurnPerHour(fuelConsumptionGph, isRunning) {
    if (!isRunning) return 0;
    return fuelConsumptionGph || 0;
  }

  /* Alternator: charges while the engine is running, scaled by
     throttle (an idling engine's alternator puts out much less than
     one being run hard) — uses the same throttleRpm/engine-on state
     the rest of the physics already tracks, not a separate input. */
  function calculateAlternatorOutput(ratedWatts, engineOn, throttlePct) {
    if (!ratedWatts || ratedWatts <= 0 || !engineOn) return 0;
    const throttleFactor = Math.max(0.25, Math.min(1, (throttlePct || 0) / 100)); /* even idle produces SOME charge, ~25% of rated */
    return ratedWatts * throttleFactor;
  }


  window.OSPhysics = {
    calculatePointOfSail,
    trimQualityFactor,
    calculateSailSpeed,
    calculateEngineSpeed,
    combineSpeed,
    calculateFuelBurnPerHour,
    haversineNm,
    bearingDeg,
    updateHeading,
    advance,
    calculateSolarOutput,
    calculateWindGeneratorOutput,
    calculateGeneratorOutput,
    calculateGeneratorFuelBurnPerHour,
    calculateAlternatorOutput
  };
})();
