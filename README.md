# Loot Bin
A slot-machine-style trash bin: when the IR sensor sees something drop in, the front-end spins a three.js slot. If it lands on three of a kind the stepper fires for 3 seconds to release a prize. Wins are pre-planned (casino-style) to match the configured win ratio.

## Hardware mapping
- IR sensor: GPIO4 (BCM)
- Stepper (ULN2003 + 28BYJ-48):
  - IN1 → GPIO14
  - IN2 → GPIO15
  - IN3 → GPIO18
  - IN4 → GPIO23

The code keeps all GPIO setup in place but will gracefully no-op on Windows so you can test the UI and simulator without errors.

## Quick start (Windows or Pi)
```bash
python -m venv .venv
. .venv/Scripts/activate  # PowerShell: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```
Then open http://localhost:5000.

## How it works
- Backend: Flask serves the UI and exposes APIs. A rigged outcome planner builds a fixed cycle (20 slots by default) where the number of wins matches your configured `win_ratio`. Each trigger just walks the cycle in order, so the win/loss pattern is predetermined rather than random.
- IR sensor: On a rising edge at GPIO4, a spin is queued. (If GPIO is unavailable, the listener quietly disables.)
- Slot animation: Front-end polls `/api/next-event` and spins the reels with three.js. It shows a WIN banner on three-of-a-kind.
- Stepper: On a win, ULN2003 pins pulse for ~3 seconds to release the prize.

## Settings + simulator
Visit `/settings` to:
- Set the win ratio (0.00–1.00). Example: 0.25 → about 5 wins every 20 triggers.
- Toggle simulator mode. When enabled, press the spacebar on the settings page to mimic the IR sensor. You can also hit the "Test Spin" button on the main page to queue a spin.

Settings are persisted in `config.json`.
