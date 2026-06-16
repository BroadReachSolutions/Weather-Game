/* ============================================================
   Weather Game — game.js
   Screen management, live weather data, score persistence
   ============================================================ */

'use strict';

/* ── Config ─────────────────────────────────────────────── */
const NOAA_PROXY   = 'https://noaa-proxy.lanceburkin.workers.dev';
const DEFAULT_LAT  = 29.938;
const DEFAULT_LON  = -81.302;
const DEFAULT_STATION_ID = '8720554'; // Vilano Beach ICWW

const HIGH_SCORE_KEY = 'weatherGame_highScores_v1';
const MAX_HIGH_SCORES = 10;

/* ── Live weather state ─────────────────────────────────── */
let liveWeather = {
  windMph: null,
  tempF:   null,
  tideStatus: null,   // 'Rising', 'Falling', or null
  tideFt:  null,
};

/* ── Game state ─────────────────────────────────────────── */
let gameScore    = 0;
let gameTimer    = 60;
let gameInterval = null;
let gamePaused   = false;

/* ── Screen router ──────────────────────────────────────── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ── Weather fetching (reuses AppV1 API endpoints) ──────── */
async function fetchLiveWeather() {
  try {
    // Wind + Temp from open-meteo
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${DEFAULT_LAT}&longitude=${DEFAULT_LON}&current=temperature_2m,wind_speed_10m&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=America%2FNew_York`;
    const wRes  = await fetch(weatherUrl);
    const wData = await wRes.json();
    liveWeather.windMph = Math.round(wData.current.wind_speed_10m);
    liveWeather.tempF   = Math.round(wData.current.temperature_2m);
  } catch (e) {
    console.warn('Weather fetch failed:', e);
  }

  try {
    // Tide from NOAA proxy
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const tideUrl = `${NOAA_PROXY}/api/datagetter?station=${DEFAULT_STATION_ID}&product=water_level&datum=MLLW&time_zone=lst_ldt&units=english&format=json&date=today`;
    const tRes  = await fetch(tideUrl);
    const tData = await tRes.json();
    if (tData.data && tData.data.length >= 2) {
      const last = tData.data[tData.data.length - 1];
      const prev = tData.data[tData.data.length - 2];
      liveWeather.tideFt     = parseFloat(last.v).toFixed(1);
      liveWeather.tideStatus = parseFloat(last.v) > parseFloat(prev.v) ? 'Rising' : 'Falling';
    }
  } catch (e) {
    console.warn('Tide fetch failed:', e);
  }

  updateWeatherSnapshot();
}

function updateWeatherSnapshot() {
  const snapWind = document.getElementById('snapWind');
  const snapTemp = document.getElementById('snapTemp');
  const snapTide = document.getElementById('snapTide');

  snapWind.textContent = liveWeather.windMph !== null ? `${liveWeather.windMph} mph` : '-- mph';
  snapTemp.textContent = liveWeather.tempF   !== null ? `${liveWeather.tempF}°F`     : '--°F';

  if (liveWeather.tideStatus && liveWeather.tideFt) {
    const arrow = liveWeather.tideStatus === 'Rising' ? '↑' : '↓';
    snapTide.textContent = `${liveWeather.tideFt} ft ${arrow}`;
    snapTide.style.color = liveWeather.tideStatus === 'Rising' ? '#69f0ae' : '#4fc3f7';
  } else {
    snapTide.textContent = '--';
    snapTide.style.color = '';
  }
}

/* ── High score system ──────────────────────────────────── */
function loadHighScores() {
  try {
    return JSON.parse(localStorage.getItem(HIGH_SCORE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveHighScore(score) {
  const scores = loadHighScores();
  scores.push({ score, date: new Date().toLocaleDateString() });
  scores.sort((a, b) => b.score - a.score);
  scores.splice(MAX_HIGH_SCORES); // keep top 10
  localStorage.setItem(HIGH_SCORE_KEY, JSON.stringify(scores));
}

function renderHighScores() {
  const list   = document.getElementById('highScoreList');
  const scores = loadHighScores();

  if (!scores.length) {
    list.innerHTML = '<p class="empty-state">No scores yet. Play a round!</p>';
    return;
  }

  list.innerHTML = scores.map((entry, i) => `
    <div class="score-entry">
      <span class="score-rank">#${i + 1}</span>
      <span class="score-points">${entry.score}</span>
      <span class="score-date">${entry.date}</span>
    </div>
  `).join('');
}

/* ── Game loop (placeholder — swap in your mechanics) ───── */
function startGame() {
  gameScore  = 0;
  gameTimer  = 60;
  gamePaused = false;

  document.getElementById('hudScore').textContent = gameScore;
  document.getElementById('hudTimer').textContent = gameTimer;

  showScreen('screenGame');

  // TODO: initialise your game mechanics here
  // e.g. spawnObstacles(), setupCanvas(), etc.

  gameInterval = setInterval(() => {
    if (gamePaused) return;
    gameTimer--;
    document.getElementById('hudTimer').textContent = gameTimer;
    if (gameTimer <= 0) endGame();
  }, 1000);
}

function endGame() {
  clearInterval(gameInterval);
  gameInterval = null;
  saveHighScore(gameScore);
  document.getElementById('finalScore').textContent = gameScore;
  showScreen('screenGameOver');
}

function pauseGame() {
  gamePaused = !gamePaused;
  document.getElementById('btnPause').textContent = gamePaused ? '▶' : '⏸';
}

/* Helper called by your game mechanics to add points */
function addScore(points) {
  gameScore += points;
  document.getElementById('hudScore').textContent = gameScore;
}

/* ── Wire up UI ─────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {

  // Navigation buttons
  document.getElementById('btnPlay').addEventListener('click', startGame);
  document.getElementById('btnPlayAgain').addEventListener('click', startGame);
  document.getElementById('btnBackHome').addEventListener('click', () => showScreen('screenHome'));
  document.getElementById('btnPause').addEventListener('click', pauseGame);

  document.getElementById('btnHowTo').addEventListener('click', () => showScreen('screenHowTo'));
  document.getElementById('btnHighScores').addEventListener('click', () => {
    renderHighScores();
    showScreen('screenHighScores');
  });

  // Generic back buttons
  document.querySelectorAll('.back-btn').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.target));
  });

  // Disable pull-to-refresh and overscroll on game area
  document.addEventListener('touchmove', e => {
    if (e.target.closest('#gameArea')) e.preventDefault();
  }, { passive: false });

  // Boot sequence
  showScreen('screenLoading');
  fetchLiveWeather().finally(() => {
    // Short delay so the loading animation doesn't flash
    setTimeout(() => showScreen('screenHome'), 600);
  });
});
