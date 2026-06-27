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

/* Load an existing boat for this device — returns null if none exists yet.
   Does NOT auto-create; that happens explicitly via OS.createBoat() after
   the player completes the main menu setup. */
OS.loadBoatOnly = async function () {
  const deviceId = OS.getDeviceId();
  const { data, error } = await sbClient
    .from("boats")
    .select("*")
    .eq("device_id", deviceId)
    .maybeSingle();
  if (error) { console.error("Oregon Sail: failed to fetch boat", error); return null; }
  if (data) OS.boat = data;
  return data || null;
};

/* Legacy alias — kept so any remaining call sites don't break */
OS.loadOrCreateBoat = OS.loadBoatOnly;

/* Create a brand-new boat row in Supabase with captain name, vessel name,
   and the stats from the chosen boat preset (hull speed, sail area, etc).
   Called once from the main menu when the player clicks Begin Voyage. */
OS.createBoat = async function (fields) {
  const deviceId = OS.getDeviceId();
  const { data, error } = await sbClient
    .from("boats")
    .insert({ device_id: deviceId, ...fields })
    .select()
    .single();
  if (error) { console.error("Oregon Sail: failed to create boat", error); return null; }
  OS.boat = data;
  return data;
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
   PUSH SIMULATED STATE
   The client now runs the live simulation while the app is open
   (see game-ui.js's simulation loop). Every 10 minutes we push that
   simulated state up to Supabase, stamping last_tick_at so the
   server's own cron tick — which keeps the boat moving while the
   app is closed — knows this boat was just updated by the client
   and can skip redundantly re-simulating the same time window.
   --------------------------------------------------------------- */
OS.pushSimulatedState = async function (fields) {
  if (!OS.boat) return;
  const { data, error } = await sbClient
    .from("boats")
    .update({ ...fields, last_tick_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (error) { console.error("Oregon Sail: failed to push simulated state", error); return; }
  if (data) OS.boat = data;
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
  const update = {
    destination_lat: destLat,
    destination_lon: destLon,
    course_bearing: bearing,
    course_mode: mode || "sailing",   /* legacy field, kept in sync during transition */
    sailing_active: true,              /* setting a course raises the sails by default */
    autopilot_on: true,                /* tapping a destination engages autopilot */
    updated_at: new Date().toISOString()
  };
  Object.assign(OS.boat, update); /* in-memory first — see note in setEngine */

  const { data, error } = await sbClient
    .from("boats")
    .update(update)
    .eq("id", OS.boat.id)
    .select()
    .single();

  if (error) console.error("Oregon Sail: setCourse failed", error);
  return { data, error };
};

/* ---------------------------------------------------------------
   MANUAL STEERING — grabbing the wheel disengages autopilot and
   gives the player direct rudder control. rudder_angle is -45..45,
   negative = port, positive = starboard.
   --------------------------------------------------------------- */
OS.setRudder = async function (angle) {
  if (!OS.boat) return;
  OS.boat.rudder_angle = angle; /* update immediately for responsive UI; persisted on release */
  return { data: OS.boat, error: null };
};

OS.setAutopilot = async function (on) {
  if (!OS.boat) return;
  OS.boat.autopilot_on = on; /* in-memory first — see note in setEngine */

  const { data, error } = await sbClient
    .from("boats")
    .update({ autopilot_on: on, updated_at: new Date().toISOString() })
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (error) console.error("Oregon Sail: setAutopilot failed", error);
  return { data, error };
};

/* Marks this boat's owner as having developer console access. Set
   automatically when captain/vessel are both named "Sonic". */
OS.setDeveloperFlag = async function (isDeveloper) {
  if (!OS.boat) return;
  OS.boat.is_developer = isDeveloper;

  const { data, error } = await sbClient
    .from("boats")
    .update({ is_developer: isDeveloper, updated_at: new Date().toISOString() })
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (error) console.error("Oregon Sail: setDeveloperFlag failed", error);
  return { data, error };
};

OS.dropAnchor = async function () {
  if (!OS.boat) return;
  OS.boat.course_mode = "anchored"; /* in-memory first — see note in setEngine */

  const { data, error } = await sbClient
    .from("boats")
    .update({ course_mode: "anchored", updated_at: new Date().toISOString() })
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (error) console.error("Oregon Sail: dropAnchor failed", error);
  return { data, error };
};

/* ---------------------------------------------------------------
   ENGINE CONTROL — independent of sailing. Throttle is 800 (idle)
   to 3200 (max) RPM, set as a -1..1 slider value mapped by the UI.
   --------------------------------------------------------------- */
OS.setEngine = async function (engineOn, throttleRpm, gear) {
  if (!OS.boat) return;
  const update = { engine_on: engineOn, updated_at: new Date().toISOString() };
  if (throttleRpm != null) update.throttle_rpm = throttleRpm;
  if (gear != null) update.engine_gear = gear;

  /* Apply immediately in-memory so the client simulation's current
     lat/lon/fuel/etc aren't lost — only merge the fields we actually
     changed, don't replace OS.boat wholesale with the server's
     response (which reflects whatever lat/lon was there as of the
     last 10-min sync, not the client's live simulated position). */
  Object.assign(OS.boat, update);

  const { data, error } = await sbClient
    .from("boats")
    .update(update)
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (error) console.error("Oregon Sail: setEngine failed", error);
  return { data, error };
};

/* ---------------------------------------------------------------
   SAILING STATE — boom trim + sails up/down, independent of engine.
   --------------------------------------------------------------- */
OS.setBoomAngle = async function (angle) {
  if (!OS.boat) return;
  OS.boat.boom_angle = angle; /* in-memory first, see note in setEngine */

  const { data, error } = await sbClient
    .from("boats")
    .update({ boom_angle: angle, updated_at: new Date().toISOString() })
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (error) console.error("Oregon Sail: setBoomAngle failed", error);
  return { data, error };
};

/* Main sail reef level: 0 = full sail, 1 = first reef, 2 = second reef.
   Each step reduces main sail area (see physics.js effectiveAreaRatio)
   and raises the safe wind ceiling before risking overpowered damage. */
OS.setReefLevel = async function (level) {
  if (!OS.boat) return;
  OS.boat.reef_level = level; /* in-memory first, see note in setEngine */

  const { data, error } = await sbClient
    .from("boats")
    .update({ reef_level: level, updated_at: new Date().toISOString() })
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (error) console.error("Oregon Sail: setReefLevel failed", error);
  return { data, error };
};

/* Jib furl percentage: 0 = fully furled (no jib drive), 100 = full
   jib out. Continuous, unlike the main's two reef steps. */
OS.setJibFurl = async function (pct) {
  if (!OS.boat) return;
  OS.boat.jib_furl_pct = pct; /* in-memory first, see note in setEngine */

  const { data, error } = await sbClient
    .from("boats")
    .update({ jib_furl_pct: pct, updated_at: new Date().toISOString() })
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (error) console.error("Oregon Sail: setJibFurl failed", error);
  return { data, error };
};

/* Spinnaker furl: 0 = doused/in its sock, 100 = fully flying. Only
   actually contributes to speed on a downwind point of sail (Broad
   Reach or Running) — see physics.js's effectiveAreaRatio. */
OS.setSpinnakerFurl = async function (pct) {
  if (!OS.boat) return;
  OS.boat.spinnaker_furl_pct = pct; /* in-memory first, see note in setEngine */

  const { data, error } = await sbClient
    .from("boats")
    .update({ spinnaker_furl_pct: pct, updated_at: new Date().toISOString() })
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (error) console.error("Oregon Sail: setSpinnakerFurl failed", error);
  return { data, error };
};

/* Toggles one of the five DC-panel light switches: anchor, nav,
   steaming, deck, cockpit. Mirrors directly to a light_<key> column. */
OS.setLight = async function (key, isOn) {
  if (!OS.boat) return;
  const column = "light_" + key;
  OS.boat[column] = isOn; /* in-memory first, see note in setEngine */

  const { data, error } = await sbClient
    .from("boats")
    .update({ [column]: isOn, updated_at: new Date().toISOString() })
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (error) console.error("Oregon Sail: setLight failed", error);
  return { data, error };
};

/* ---------------------------------------------------------------
   ELECTRICAL SYSTEM — Phase 1: batteries.
   Each battery role (start, house, generator, bow-thruster) has an
   enabled flag, a capacity in watt-hours, and a live charge in
   watt-hours. setBatteryCharge is the one function that actually
   updates charge state, called periodically by the real-time power
   simulation (added in a later phase) -- for now it's also callable
   directly for testing/dev purposes.
   --------------------------------------------------------------- */
/* Toggles the generator on/off (player-controlled, like the engine).
   Fuel consumption and power output only apply while running. */
OS.setGeneratorRunning = async function (isRunning) {
  if (!OS.boat) return;
  OS.boat.generator_running = isRunning;

  const { data, error } = await sbClient
    .from("boats")
    .update({ generator_running: isRunning, updated_at: new Date().toISOString() })
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (error) console.error("Oregon Sail: setGeneratorRunning failed", error);
  return { data, error };
};

OS.setBatteryCharge = async function (batteryKey, chargeWh) {
  if (!OS.boat) return;
  const column = batteryKey + "_battery_charge_wh";
  const capacityColumn = batteryKey + "_battery_capacity_wh";
  const capacity = batteryKey === "house"
    ? (OS.boat.house_battery_capacity_wh || 1200) * (OS.boat.house_battery_bank_count || 1)
    : (OS.boat[capacityColumn] || 0);
  const clamped = Math.max(0, Math.min(capacity, chargeWh));
  OS.boat[column] = clamped; /* in-memory first, see note in setEngine */

  const { data, error } = await sbClient
    .from("boats")
    .update({ [column]: clamped, updated_at: new Date().toISOString() })
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (error) console.error("Oregon Sail: setBatteryCharge failed", error);
  return { data, error };
};

/* Toggles whether a battery slot exists on the boat at all (a boat-
   design-time choice) -- separate from charge state, which is live
   gameplay state. Used by the dev console / boat creation flow. */
OS.setBatterySlotEnabled = async function (batteryKey, enabled) {
  if (!OS.boat) return;
  const column = "has_" + batteryKey + "_battery";
  OS.boat[column] = enabled;

  const { data, error } = await sbClient
    .from("boats")
    .update({ [column]: enabled, updated_at: new Date().toISOString() })
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (error) console.error("Oregon Sail: setBatterySlotEnabled failed", error);
  return { data, error };
};

/* House battery bank size (1+ batteries wired together as one bank,
   per request) -- changing this also rescales current charge
   proportionally so adding/removing a battery from the bank doesn't
   instantly create energy from nothing or destroy it outright. */
OS.setHouseBatteryBankCount = async function (count) {
  if (!OS.boat) return;
  const newCount = Math.max(1, Math.round(count));
  const oldCount = OS.boat.house_battery_bank_count || 1;
  const perBatteryCapacity = OS.boat.house_battery_capacity_wh || 1200;
  const oldTotalCapacity = perBatteryCapacity * oldCount;
  const newTotalCapacity = perBatteryCapacity * newCount;
  const currentChargeRatio = oldTotalCapacity > 0 ? (OS.boat.house_battery_charge_wh || 0) / oldTotalCapacity : 1;
  const newCharge = newTotalCapacity * currentChargeRatio;

  OS.boat.house_battery_bank_count = newCount;
  OS.boat.house_battery_charge_wh = newCharge;

  const { data, error } = await sbClient
    .from("boats")
    .update({
      house_battery_bank_count: newCount,
      house_battery_charge_wh: newCharge,
      updated_at: new Date().toISOString()
    })
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (error) console.error("Oregon Sail: setHouseBatteryBankCount failed", error);
  return { data, error };
};

OS.setSailingActive = async function (active) {
  if (!OS.boat) return;
  OS.boat.sailing_active = active; /* in-memory first, see note in setEngine */

  const { data, error } = await sbClient
    .from("boats")
    .update({ sailing_active: active, updated_at: new Date().toISOString() })
    .eq("id", OS.boat.id)
    .select()
    .single();
  if (error) console.error("Oregon Sail: setSailingActive failed", error);
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
