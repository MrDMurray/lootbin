import json
import os
import queue
import random
import threading
import time
import uuid
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file


BASE_DIR = Path(__file__).parent
CONFIG_PATH = BASE_DIR / "config.json"

# Hardware wiring
IR_PIN = 4
STEPPER_PINS = [14, 15, 18, 23]
SOUNDS_DIR = BASE_DIR / "sounds"
LOOSE_DIR = SOUNDS_DIR / "loose"
WIN_DIR = SOUNDS_DIR / "win"
GONA_WIN_FILE = WIN_DIR / "gona_win.mp3"
VICTORY_FILE = WIN_DIR / "victory.mp3"
CHING_FILE = SOUNDS_DIR / "ching.wav"

DEFAULT_CONFIG = {
    "win_ratio": 0.25,
    "simulator_mode": True,
    "music_enabled": True,
    "sfx_enabled": True,
}

# Simple cycle that pre-determines wins ahead of time rather than relying on randomness.
class RiggedOutcomePlanner:
    def __init__(self, win_ratio: float, cycle_size: int = 20):
        self.cycle_size = max(1, cycle_size)
        self._lock = threading.Lock()
        self._index = 0
        self._pattern = []
        self.set_ratio(win_ratio)

    def set_ratio(self, win_ratio: float):
        with self._lock:
            ratio = min(1.0, max(0.0, win_ratio))
            wins = round(self.cycle_size * ratio)
            pattern = [False] * self.cycle_size
            if wins:
                step = self.cycle_size / wins
                used = set()
                for i in range(wins):
                    pos = int(round(i * step)) % self.cycle_size
                    # Avoid duplicates by walking forward if necessary.
                    while pos in used:
                        pos = (pos + 1) % self.cycle_size
                    used.add(pos)
                    pattern[pos] = True
            self._pattern = pattern
            self._index = self._index % len(self._pattern)

    def next(self) -> bool:
        with self._lock:
            if not self._pattern:
                return False
            result = self._pattern[self._index]
            self._index = (self._index + 1) % len(self._pattern)
            return result


class SymbolWheel:
    SYMBOLS = ["CHERRY", "LEMON", "STAR", "BELL", "DIAMOND", "SEVEN"]

    def __init__(self):
        self._lock = threading.Lock()
        self._cursor = 0

    def _next_symbol(self):
        symbol = self.SYMBOLS[self._cursor % len(self.SYMBOLS)]
        self._cursor = (self._cursor + 1) % len(self.SYMBOLS)
        return symbol

    def next_reels(self, is_win: bool):
        with self._lock:
            base = self._next_symbol()
            if is_win:
                return [base, base, base]
            second = self._next_symbol()
            third = self._next_symbol()
            # Ensure we do not accidentally show three of a kind on a loss.
            if third == base:
                third = self._next_symbol()
            return [base, second, third]


class ConfigStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._data = DEFAULT_CONFIG.copy()
        self._load()

    def _load(self):
        if self.path.exists():
            try:
                raw = json.loads(self.path.read_text())
                self._data.update(raw)
            except Exception:
                # Use defaults if the config is malformed.
                pass
        else:
            self.save(self._data)

    def get(self):
        with self._lock:
            return dict(self._data)

    def save(self, data: dict):
        with self._lock:
            self._data.update(data)
            self.path.write_text(json.dumps(self._data, indent=2))


class StepperMotor:
    # Half-step sequence for ULN2003 + 28BYJ-48 stepper.
    SEQUENCE = [
        [1, 0, 0, 0],
        [1, 1, 0, 0],
        [0, 1, 0, 0],
        [0, 1, 1, 0],
        [0, 0, 1, 0],
        [0, 0, 1, 1],
        [0, 0, 0, 1],
        [1, 0, 0, 1],
    ]

    def __init__(self, pins):
        self.pins = pins
        self.gpio = None
        self._available = False
        self._spin_lock = threading.Lock()
        self._setup_gpio()

    def _setup_gpio(self):
        try:
            import RPi.GPIO as GPIO

            self.gpio = GPIO
            GPIO.setmode(GPIO.BCM)
            for pin in self.pins:
                GPIO.setup(pin, GPIO.OUT)
                GPIO.output(pin, 0)
            self._available = True
        except Exception:
            # Running on non-RPi hardware.
            self._available = False

    def cleanup(self):
        if self._available and self.gpio:
            self.gpio.cleanup()

    def _step_once(self):
        for seq in self.SEQUENCE:
            for pin, value in zip(self.pins, seq):
                self.gpio.output(pin, value)
            time.sleep(0.002)

    def spin_for_seconds(self, duration=3.0):
        if not self._available:
            # Still sleep a little to mimic timing for tests.
            time.sleep(duration)
            return
        if not self._spin_lock.acquire(blocking=False):
            return

        def _spin():
            end_time = time.time() + duration
            try:
                while time.time() < end_time:
                    self._step_once()
            finally:
                self._spin_lock.release()

        threading.Thread(target=_spin, daemon=True).start()


class IRListener:
    def __init__(self, pin, on_trigger):
        self.pin = pin
        self.on_trigger = on_trigger
        self.gpio = None
        self._available = False
        self._setup()

    def _setup(self):
        try:
            import RPi.GPIO as GPIO

            self.gpio = GPIO
            GPIO.setmode(GPIO.BCM)
            GPIO.setup(self.pin, GPIO.IN, pull_up_down=GPIO.PUD_DOWN)
            self.gpio.add_event_detect(
                self.pin,
                self.gpio.RISING,
                callback=lambda channel: self.on_trigger("ir"),
                bouncetime=400,
            )
            self._available = True
        except Exception:
            self._available = False

    def cleanup(self):
        if self._available and self.gpio:
            self.gpio.cleanup()


class Runtime:
    def __init__(self):
        self.config = ConfigStore(CONFIG_PATH)
        current_config = self.config.get()
        self.rigged = RiggedOutcomePlanner(current_config["win_ratio"])
        self.symbol_wheel = SymbolWheel()
        self.events = queue.Queue()
        self.stepper = StepperMotor(STEPPER_PINS)
        self.ir_listener = IRListener(IR_PIN, self.register_trigger)
        self.started = False
        self._start_lock = threading.Lock()

    def ensure_started(self):
        with self._start_lock:
            if self.started:
                return
            # No continuous loop required; IR listener uses interrupts.
            self.started = True

    def register_trigger(self, source: str = "ir"):
        is_win = self.rigged.next()
        reels = self.symbol_wheel.next_reels(is_win)
        event = {
            "id": str(uuid.uuid4()),
            "win": is_win,
            "reels": reels,
            "source": source,
            "created_at": time.time(),
        }
        self.events.put(event)
        if is_win:
            self.stepper.spin_for_seconds()

    def get_next_event(self):
        if self.events.empty():
            return None
        try:
            return self.events.get_nowait()
        except queue.Empty:
            return None

    def update_config(self, win_ratio: float, simulator_mode: bool, music_enabled: bool, sfx_enabled: bool):
        self.rigged.set_ratio(win_ratio)
        self.config.save(
            {
                "win_ratio": win_ratio,
                "simulator_mode": simulator_mode,
                "music_enabled": music_enabled,
                "sfx_enabled": sfx_enabled,
            }
        )

    def cleanup(self):
        self.ir_listener.cleanup()
        self.stepper.cleanup()


runtime = Runtime()
app = Flask(__name__)


@app.before_request
def _start_runtime():
    # Flask 3 dropped before_first_request, so ensure on every request instead.
    runtime.ensure_started()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/settings")
def settings():
    return render_template("settings.html")


@app.route("/api/config", methods=["GET", "POST"])
def api_config():
    if request.method == "GET":
        return jsonify(runtime.config.get())

    payload = request.get_json(force=True, silent=True) or {}
    win_ratio = payload.get("win_ratio", DEFAULT_CONFIG["win_ratio"])
    simulator_mode = payload.get("simulator_mode", DEFAULT_CONFIG["simulator_mode"])
    music_enabled = payload.get("music_enabled", DEFAULT_CONFIG["music_enabled"])
    sfx_enabled = payload.get("sfx_enabled", DEFAULT_CONFIG["sfx_enabled"])

    try:
        win_ratio_value = float(win_ratio)
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid win_ratio"}), 400

    runtime.update_config(
        win_ratio_value,
        bool(simulator_mode),
        bool(music_enabled),
        bool(sfx_enabled),
    )
    return jsonify(runtime.config.get())


@app.route("/api/next-event")
def api_next_event():
    event = runtime.get_next_event()
    if not event:
        return jsonify({"eventAvailable": False})
    return jsonify({"eventAvailable": True, **event})


@app.route("/api/simulate-hit", methods=["POST"])
def api_simulate_hit():
    config = runtime.config.get()
    if not config.get("simulator_mode", False):
        return jsonify({"error": "Simulator mode disabled"}), 400
    runtime.register_trigger("simulator")
    return jsonify({"status": "queued"})


@app.route("/api/test-spin", methods=["POST"])
def api_test_spin():
    # Quick endpoint to trigger a spin without touching hardware (used by UI button).
    runtime.register_trigger("manual")
    return jsonify({"status": "queued"})


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


def _pick_audio_file(directory: Path, exclude: set[str] | None = None):
    if not directory.exists() or not directory.is_dir():
        return None
    exclude = exclude or set()
    candidates = [
        p for p in directory.iterdir() if p.suffix.lower() == ".mp3" and p.is_file() and p.name not in exclude
    ]
    if not candidates:
        return None
    return random.choice(candidates)


@app.route("/media/<kind>")
def media(kind: str):
    kind = kind.lower()
    path = None
    mimetype = "audio/mpeg"
    if kind == "victory":
        path = VICTORY_FILE
    elif kind == "ching":
        path = CHING_FILE
        mimetype = "audio/wav"
    elif kind == "win":
        if GONA_WIN_FILE.exists():
            path = GONA_WIN_FILE
        else:
            path = _pick_audio_file(WIN_DIR, exclude={VICTORY_FILE.name})
    elif kind == "loose":
        path = _pick_audio_file(LOOSE_DIR)

    if not path or not path.exists():
        return jsonify({"error": "Audio not found"}), 404

    return send_file(path, mimetype=mimetype, conditional=True)


def _shutdown():
    runtime.cleanup()


import atexit

atexit.register(_shutdown)


if __name__ == "__main__":
    runtime.ensure_started()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
