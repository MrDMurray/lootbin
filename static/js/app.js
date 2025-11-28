import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

const page = document.body.dataset.page;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJSON(url, options = {}) {
  const opts = { headers: { "Content-Type": "application/json" }, ...options };
  const res = await fetch(url, opts);
  if (!res.ok) {
    const message = await res.text();
    throw new Error(message || "Request failed");
  }
  return res.json();
}

// HOME PAGE
async function initHome() {
  const SYMBOL_EMOJI = {
    CHERRY: "🍒",
    LEMON: "🍋",
    STAR: "⭐",
    BELL: "🔔",
    DIAMOND: "💎",
    SEVEN: "7️⃣",
  };
  const SYMBOL_ORDER = Object.keys(SYMBOL_EMOJI);

  const canvas = document.getElementById("slotCanvas");
  const winBanner = document.getElementById("winBanner");
  const statusMessage = document.getElementById("statusMessage");
  const eventLog = document.getElementById("eventLog");
  const testSpin = document.getElementById("testSpin");
  winBanner.hidden = true;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12040a);
  renderer.setClearColor(scene.background, 1);
  const camera = new THREE.PerspectiveCamera(
    45,
    canvas.clientWidth / canvas.clientHeight,
    0.1,
    100
  );
  camera.position.set(0, 1.4, 4.5);
  camera.lookAt(0, 0, 0);

  const light = new THREE.DirectionalLight(0xffffff, 1.2);
  light.position.set(-2, 6, 5);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffe6c7, 0.45));
  const rimLight = new THREE.DirectionalLight(0xffb347, 0.9);
  rimLight.position.set(3, 3, -2);
  scene.add(rimLight);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 8),
    new THREE.MeshStandardMaterial({
      color: 0x1a0a12,
      emissive: 0x320815,
      metalness: 0.35,
      roughness: 0.6,
    })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.5;
  scene.add(floor);

  const reels = [];
  const reelSpacing = 1.6;
  for (let i = 0; i < 3; i++) {
    const reel = createReel();
    reel.position.x = (i - 1) * reelSpacing;
    scene.add(reel);
    reels.push(reel);
  }

  const spinState = {
    active: false,
    start: 0,
    durations: [3200, 6400, 9600],
    locked: [false, false, false],
    targets: ["CHERRY", "LEMON", "STAR"],
    isWin: false,
    settleDelay: 350,
    maxDuration: 0,
  };

  const audioPrefs = {
    music: true,
    sfx: true,
  };

  async function loadAudioPrefs() {
    try {
      const data = await fetchJSON("/api/config");
      audioPrefs.music = data.music_enabled !== false;
      audioPrefs.sfx = data.sfx_enabled !== false;
    } catch {
      // Keep defaults if config cannot be loaded.
    }
  }

  function playAudio(url, volume = 0.75) {
    const audio = new Audio(url);
    audio.volume = volume;
    audio.play().catch(() => {});
  }

  function playMusic(kind) {
    if (!audioPrefs.music) return;
    playAudio(`/media/${kind}?t=${Date.now()}`, kind === "victory" ? 0.9 : 0.6);
  }

  function playSfx(kind) {
    if (!audioPrefs.sfx) return;
    playAudio(`/media/${kind}?t=${Date.now()}`, 0.85);
  }

  await loadAudioPrefs();

  function createSymbolTexture(symbolKey) {
    const symbol = SYMBOL_EMOJI[symbolKey] || symbolKey;
    const size = 256;
    const canvasTex = document.createElement("canvas");
    canvasTex.width = canvasTex.height = size;
    const ctx = canvasTex.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    const sheen = ctx.createRadialGradient(
      size * 0.5,
      size * 0.3,
      size * 0.15,
      size * 0.5,
      size * 0.5,
      size * 0.8
    );
    sheen.addColorStop(0, "rgba(255,255,255,0.8)");
    sheen.addColorStop(1, "rgba(255,255,255,0.2)");
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, size, size);
    ctx.lineWidth = 18;
    ctx.strokeStyle = "#f5c542";
    ctx.strokeRect(12, 12, size - 24, size - 24);
    ctx.fillStyle = "#b40024";
    ctx.font = "800 92px 'Space Grotesk', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(symbol, size / 2, size / 2);
    return new THREE.CanvasTexture(canvasTex);
  }

  function materialsForFaces(faceSymbols) {
    return faceSymbols.map((sym) => new THREE.MeshBasicMaterial({ map: createSymbolTexture(sym) }));
  }

  function shuffledSymbols(exclude) {
    const pool = SYMBOL_ORDER.filter((sym) => sym !== exclude);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool;
  }

  function createReel() {
    const geometry = new THREE.BoxGeometry(1.2, 1.2, 1.2, 4, 4, 4);
    const mesh = new THREE.Mesh(geometry, materialsForFaces(buildFaces("CHERRY")));
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.7, 0.06, 12, 40),
      new THREE.MeshBasicMaterial({ color: 0xf5c542 })
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.z = 0.65;
    mesh.add(rim);
    const rimBack = rim.clone();
    rimBack.position.z = -0.65;
    mesh.add(rimBack);
    return mesh;
  }

  function buildFaces(targetSymbol) {
    const others = shuffledSymbols(targetSymbol);
    // BoxGeometry face order: +x, -x, +y, -y, +z(front), -z(back)
    return [others[0], others[1], others[2], others[3], targetSymbol, others[4]];
  }

  function setReelSymbol(reel, symbol) {
    reel.material = materialsForFaces(buildFaces(symbol));
  }

  function resizeRenderer() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const needResize =
      canvas.width !== Math.floor(width * window.devicePixelRatio) ||
      canvas.height !== Math.floor(height * window.devicePixelRatio);
    if (needResize) {
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
  }

  function updateSpin(now) {
    if (!spinState.active) return;
    const elapsed = now - spinState.start;
    let allLocked = true;
    reels.forEach((reel, idx) => {
      if (spinState.locked[idx]) {
        return;
      }
      allLocked = false;
      const duration = spinState.durations[idx];
      const progress = Math.min(1, elapsed / duration);
      const decay = 1 - Math.log1p(progress * 9) / Math.log(10);
      const spinSpeed = 18 * decay + 0.8;
      reel.rotation.x += 0.05 * spinSpeed;
      if (elapsed >= duration && !spinState.locked[idx]) {
        setReelSymbol(reel, spinState.targets[idx]);
        reel.rotation.x = Math.round(reel.rotation.x / (Math.PI * 2)) * (Math.PI * 2);
        spinState.locked[idx] = true;
      }
    });
    if (allLocked && elapsed >= spinState.maxDuration + spinState.settleDelay) {
      spinState.active = false;
      playSfx("ching");
      winBanner.hidden = !spinState.isWin;
      statusMessage.textContent = spinState.isWin
        ? "Jackpot! Stepper fired for 3 seconds."
        : "No luck. Waiting for the next drop.";
      if (spinState.isWin) {
        playMusic("victory");
      }
    }
  }

  function spin(result) {
    spinState.active = true;
    spinState.start = performance.now();
    spinState.locked = [false, false, false];
    const firstDuration = 3200 + Math.random() * 250;
    const secondDuration = firstDuration * 2 + Math.random() * 180;
    const thirdDuration = firstDuration * 3 + Math.random() * 200;
    spinState.durations = [firstDuration, secondDuration, thirdDuration];
    spinState.maxDuration = Math.max(...spinState.durations);
    spinState.targets = result.reels;
    spinState.isWin = result.win;
    winBanner.hidden = true;
    statusMessage.textContent = `Spinning (${result.source})...`;
    playMusic(result.win ? "win" : "loose");
  }

  function logEvent(event) {
    const ts = new Date(event.created_at * 1000).toLocaleTimeString();
    const text = `${ts} · ${event.source.toUpperCase()} · ${event.win ? "WIN" : "LOSS"} · ${event.reels.join(" | ")}`;
    const line = document.createElement("div");
    line.textContent = text;
    eventLog.prepend(line);
    while (eventLog.childElementCount > 5) {
      eventLog.removeChild(eventLog.lastChild);
    }
  }

  async function pollEvents() {
    while (true) {
      try {
        const data = await fetchJSON("/api/next-event");
        if (data.eventAvailable) {
          spin(data);
          logEvent(data);
        }
      } catch (err) {
        statusMessage.textContent = "Unable to reach backend.";
      }
      await sleep(900);
    }
  }

  testSpin?.addEventListener("click", async () => {
    statusMessage.textContent = "Queued manual test spin...";
    try {
      await fetchJSON("/api/test-spin", { method: "POST", body: "{}" });
    } catch {
      statusMessage.textContent = "Could not queue test spin.";
    }
  });

  function render(now) {
    resizeRenderer();
    updateSpin(now);
    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
  pollEvents();
}

// SETTINGS PAGE
async function initSettings() {
  const winRatioInput = document.getElementById("winRatio");
  const winRatioValue = document.getElementById("winRatioValue");
  const simulatorModeInput = document.getElementById("simulatorMode");
  const musicEnabledInput = document.getElementById("musicEnabled");
  const sfxEnabledInput = document.getElementById("sfxEnabled");
  const statusInline = document.getElementById("settingsStatus");
  const form = document.getElementById("settingsForm");

  function updateLabel() {
    winRatioValue.textContent = Number(winRatioInput.value).toFixed(2);
  }

  winRatioInput.addEventListener("input", updateLabel);

  async function loadConfig() {
    try {
      const data = await fetchJSON("/api/config");
      winRatioInput.value = data.win_ratio ?? 0.25;
      simulatorModeInput.checked = Boolean(data.simulator_mode);
      musicEnabledInput.checked = data.music_enabled !== false;
      sfxEnabledInput.checked = data.sfx_enabled !== false;
      updateLabel();
    } catch {
      statusInline.textContent = "Failed to load config";
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    statusInline.textContent = "Saving...";
    try {
      await fetchJSON("/api/config", {
        method: "POST",
        body: JSON.stringify({
          win_ratio: Number(winRatioInput.value),
          simulator_mode: simulatorModeInput.checked,
          music_enabled: musicEnabledInput.checked,
          sfx_enabled: sfxEnabledInput.checked,
        }),
      });
      statusInline.textContent = "Saved";
    } catch {
      statusInline.textContent = "Unable to save";
    }
  });

  window.addEventListener("keydown", async (e) => {
    if (e.code === "Space" && simulatorModeInput.checked) {
      e.preventDefault();
      statusInline.textContent = "Simulated IR trigger";
      try {
        await fetchJSON("/api/simulate-hit", { method: "POST", body: "{}" });
      } catch {
        statusInline.textContent = "Sim trigger failed";
      }
    }
  });

  loadConfig();
}

if (page === "home") {
  initHome();
} else if (page === "settings") {
  initSettings();
}
