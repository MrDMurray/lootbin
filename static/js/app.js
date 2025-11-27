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
  const canvas = document.getElementById("slotCanvas");
  const winBanner = document.getElementById("winBanner");
  const statusMessage = document.getElementById("statusMessage");
  const eventLog = document.getElementById("eventLog");
  const testSpin = document.getElementById("testSpin");

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b101a);
  const camera = new THREE.PerspectiveCamera(
    45,
    canvas.clientWidth / canvas.clientHeight,
    0.1,
    100
  );
  camera.position.set(0, 1.4, 4.5);
  camera.lookAt(0, 0, 0);

  const light = new THREE.DirectionalLight(0xffffff, 1.2);
  light.position.set(0, 5, 4);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.3));

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 8),
    new THREE.MeshBasicMaterial({ color: 0x0f1622 })
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
    durations: [1800, 2100, 2400],
    locked: [false, false, false],
    targets: ["CHERRY", "LEMON", "STAR"],
    isWin: false,
  };

  function createSymbolTexture(symbol) {
    const size = 256;
    const canvasTex = document.createElement("canvas");
    canvasTex.width = canvasTex.height = size;
    const ctx = canvasTex.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, "#00d2a6");
    gradient.addColorStop(1, "#ff9f1c");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#0b0f18";
    ctx.fillRect(8, 8, size - 16, size - 16);
    ctx.fillStyle = "#e7ecf2";
    ctx.font = "bold 82px 'Space Grotesk', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(symbol, size / 2, size / 2);
    return new THREE.CanvasTexture(canvasTex);
  }

  function materialForSymbol(symbol) {
    const texture = createSymbolTexture(symbol);
    const material = new THREE.MeshBasicMaterial({ map: texture });
    return [material, material, material, material, material, material];
  }

  function createReel() {
    const geometry = new THREE.BoxGeometry(1.2, 1.2, 1.2, 4, 4, 4);
    const mesh = new THREE.Mesh(geometry, materialForSymbol("CHERRY"));
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.7, 0.06, 12, 40),
      new THREE.MeshBasicMaterial({ color: 0x182033 })
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.z = 0.65;
    mesh.add(rim);
    const rimBack = rim.clone();
    rimBack.position.z = -0.65;
    mesh.add(rimBack);
    return mesh;
  }

  function setReelSymbol(reel, symbol) {
    reel.material = materialForSymbol(symbol);
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
      const duration = spinState.durations[idx];
      const progress = Math.min(1, elapsed / duration);
      const speed = 12 - progress * 8;
      reel.rotation.y += 0.12 * speed;
      if (elapsed >= duration && !spinState.locked[idx]) {
        setReelSymbol(reel, spinState.targets[idx]);
        reel.rotation.y = Math.round(reel.rotation.y / (Math.PI * 2)) * (Math.PI * 2);
        spinState.locked[idx] = true;
      }
      allLocked = allLocked && spinState.locked[idx];
    });
    if (allLocked) {
      spinState.active = false;
      winBanner.hidden = !spinState.isWin;
      statusMessage.textContent = spinState.isWin
        ? "Jackpot! Stepper fired for 3 seconds."
        : "No luck. Waiting for the next drop.";
    }
  }

  function spin(result) {
    spinState.active = true;
    spinState.start = performance.now();
    spinState.locked = [false, false, false];
    spinState.targets = result.reels;
    spinState.isWin = result.win;
    winBanner.hidden = true;
    statusMessage.textContent = `Spinning (${result.source})...`;
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
