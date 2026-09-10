# Rock · Paper · Scissors AI 🪨📄✂️

Play Rock-Paper-Scissors against an **adaptive computer opponent** using
nothing but your webcam. A Flask backend uses **MediaPipe** to track your
hand in real time, classifies your gesture, and an AI opponent picks its
move based on patterns in how you've been playing.

> **One-click run:** `python run.py` (or `./run.sh` on macOS/Linux,
> `run.bat` on Windows). The launcher creates a virtual environment,
> installs dependencies, starts the server on **port 5050**, and opens
> your browser. See [One-click run](#one-click-run) below.

---

## Table of Contents

- [Features](#features)
- [One-click run](#one-click-run)
- [Manual setup](#manual-setup)
- [How to Play](#how-to-play)
- [Difficulty Levels](#difficulty-levels)
- [How It Works (Architecture)](#how-it-works-architecture)
- [HTTP API Reference](#http-api-reference)
- [Project Structure](#project-structure)
- [Extending the AI](#extending-the-ai)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Notes & Known Limitations](#notes--known-limitations)
- [Ethics & Privacy](#ethics--privacy)

---

## Features

- 🎥 **Real-time hand tracking** — MediaPipe detects your hand and draws a
  live skeleton overlay directly on top of the webcam feed.
- ✊✋✌️ **Gesture recognition** — Rock, Paper, and Scissors are recognised
  from simple, explainable finger-position geometry (see
  `backend/state_detection.py`).
- 🤖 **Four swappable AI strategies** — switch between Random, Frequency,
  Markov chain, and Adaptive difficulty **at runtime** from the UI.
- 🧠 **AI Insight panel** — see what the AI thinks of you: its current
  strategy, the move it's predicting you'll play next, your win rate, and
  recency-weighted bars showing how often you tend to throw each move.
- 🕹️ **"Shake to throw" controls** — hold up a rock and shake it to kick
  off a classic "scissors, paper, rock... shoot!" countdown, then show
  your real move on the final beat.
- 🎨 **Light + dark themes** — toggle in the header, persisted to
  `localStorage`, defaults to your OS preference.
- 🔊 **Sound effects & polish** — lightweight WebAudio beeps, animated
  scoreboard, glowing winner highlights, and a match history log.
- 📱 **Responsive UI** — works down to small/mobile screens, with
  reduced-motion support for accessibility.
- ⚡ **Quick Play** — no webcam? No problem. Click your move and the same
  game logic runs end-to-end.
- 🩺 **Health check endpoint** — `GET /health` for smoke-testing the
  server.

---

## One-click run

The fastest way to get playing:

```bash
python run.py
```

That's it. The launcher will:

1. Verify you're on Python 3.9+.
2. Create a `.venv/` virtual environment (if one doesn't already exist).
3. Install the dependencies from `backend/requirements.txt`.
4. Start the Flask server on **http://127.0.0.1:5050/**.
5. Open your default browser at the game's URL.

Press `Ctrl+C` in the terminal to stop the server.

### Platform-specific shortcuts

| Platform | Command                                |
| -------- | -------------------------------------- |
| macOS / Linux | `./run.sh` (or `python3 run.py`)  |
| Windows  | `run.bat` (or `python run.py`)         |

### Common launcher flags

```bash
python run.py --port 8080          # use a different port
python run.py --difficulty hard    # start on Hard difficulty
python run.py --no-venv            # use the current Python, no venv
python run.py --no-open            # don't auto-open the browser
python run.py --skip-install       # assume deps are already installed
```

Run `python run.py --help` to see all options.

---

## Manual setup

If you'd rather set things up yourself (or the one-click launcher fails
for some reason), the underlying steps are:

### Option A: Conda (matches `environment.yml`)

```bash
conda env create -f environment.yml
conda activate rps_env
pip install -r backend/requirements.txt
```

### Option B: plain `venv` + pip

```bash
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt
```

### Run the server

```bash
cd backend
python app.py
```

Then open **http://127.0.0.1:5050/** in your browser (Chrome / Edge /
Firefox recommended — camera access requires either `localhost` or HTTPS)
and click **Start Webcam**.

> **Port already in use?** The server defaults to port `5050` (port
> `5000` is deliberately avoided since it's often already occupied by
> other software — e.g. macOS's AirPlay Receiver, or a router/ISP
> management page on some home networks). If `5050` is also unavailable
> on your network, override it with the `PORT` environment variable:
>
> ```bash
> PORT=8080 python app.py
> ```
>
> ...then open `http://127.0.0.1:8080/` instead.

---

## How to Play

1. Click **Start Webcam** and allow camera access.
2. Hold up a **Rock ✊** to tell the game you're ready.
3. **Shake** your rock up and down to begin the countdown.
4. On the final beat ("Rock!"), show your real move — Rock, Paper, or
   Scissors.
5. The AI reveals its move and the round's winner is scored automatically.

**No webcam?** Use the **Quick Play** buttons below the arena — they
call the exact same backend logic as the camera flow.

---

## Difficulty Levels

Switch any time from the **AI Difficulty** bar at the top of the game
card. The change takes effect immediately and is reflected in the AI
Insight panel.

| Difficulty | Strategy    | What it does                                                                                                          |
| ---------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| 🌱 Easy    | `random`    | Uniformly random play — the game-theoretic Nash equilibrium. Hardest to exploit because there's no pattern to learn. |
| ⚡ Medium  | `frequency` | Counts your recent moves with exponential decay (newer moves count more) and counters the most-frequent one.         |
| 🔥 Hard    | `markov`    | Builds a first-order Markov chain of your move *transitions* and counters the most likely next move.                 |
| 💀 Insane  | `adaptive`  | Blends Markov + frequency, injects ~15% random noise, and switches to anti-counter play if you're winning a lot.     |

You can also set the starting difficulty via the `RPS_DIFFICULTY`
environment variable (e.g. `RPS_DIFFICULTY=insane python run.py`).

---

## How It Works (Architecture)

```
 Browser (script.js)                     Flask backend
 ┌─────────────────────┐   POST /process_frame   ┌───────────────────────┐
 │ capture webcam frame │ ───────────────────────>│ hand_detection.py     │
 │                      │                          │  -> MediaPipe landmarks│
 │                      │                          │ state_detection.py    │
 │                      │<─────────────────────────│  -> gesture + location │
 │ gesture stability +  │   {status, overlay, y}   └───────────────────────┘
 │ "shake" detection    │
 │ countdown state machine
 │                      │   POST /play_round      ┌───────────────────────┐
 │ final player move    │ ───────────────────────>│ ai_module.py          │
 │                      │                          │  -> strategy picks AI │
 │                      │                          │  -> winner is judged  │
 │                      │<─────────────────────────│  -> history updated   │
 │ render result        │   {ai_move, winner, ...} └───────────────────────┘
 │                      │
 │                      │   GET  /ai_stats        ┌───────────────────────┐
 │  AI Insight panel    │ ───────────────────────>│ ai_module.get_stats() │
 │  (polls every 4s)    │<─────────────────────────│  -> snapshot of state │
 │                      │   {strategy, counts, ...}└───────────────────────┘
 │                      │   POST /set_difficulty  ┌───────────────────────┐
 │  Difficulty buttons  │ ───────────────────────>│ ai_module.set_         │
 │                      │<─────────────────────────│   difficulty()        │
 └─────────────────────┘   {difficulty, strategy} └───────────────────────┘
```

- The **frontend** owns the game *state machine* (waiting → ready →
  countdown → resolving) and all UI rendering.
- The **backend** owns computer vision (MediaPipe) and the AI opponent's
  decision-making, so those pieces can be improved/replaced independently
  of the UI.

---

## HTTP API Reference

All endpoints are JSON in / JSON out (except `/` which serves the HTML
page). All POST bodies are `application/json`.

| Method | Path                | Body / Query                       | Returns                                                                                          |
| ------ | ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| GET    | `/`                 | —                                  | The game's single-page HTML frontend.                                                            |
| GET    | `/health`           | —                                  | `{status, difficulty, available_difficulties}` — smoke test.                                     |
| GET    | `/ai_stats`         | —                                  | Snapshot of the AI's internal state (see below).                                                 |
| POST   | `/set_difficulty`   | `{difficulty: "easy"\|"medium"\|"hard"\|"insane"}` | `{status, difficulty, strategy}` or `400` on unknown difficulty.                |
| POST   | `/process_frame`    | `{image: "data:image/jpeg;base64,..."}` | `{status, overlay_image_base64, hand_mean_y}` — the gesture + skeleton overlay for one frame.   |
| POST   | `/play_round`       | `{player_move: "rock"\|"paper"\|"scissors"}` | `{ai_move, winner, difficulty, logs}` — plays a round.                                          |
| POST   | `/reset_game`       | —                                  | `{status: "ok"}` — clears the AI's memory of past player moves.                                  |

### `/ai_stats` response shape

```json
{
  "difficulty": "medium",
  "strategy": "frequency",
  "history": ["rock", "paper", "rock"],
  "outcomes": ["player", "ai", "tie"],
  "weighted_counts": {"rock": 1.87, "paper": 0.85, "scissors": 0.0},
  "predicted_next_move": "rock",
  "player_win_rate": 0.33,
  "ai_win_rate": 0.33,
  "tie_rate": 0.34,
  "total_weighted": 2.72
}
```

---

## Project Structure

```
RPS_AI/
├── run.py                  # One-click launcher (venv + pip + start server)
├── run.sh                  # macOS/Linux shell wrapper around run.py
├── run.bat                 # Windows batch wrapper around run.py
├── environment.yml         # Conda environment definition
├── README.md               # This file
├── backend/
│   ├── app.py              # Flask routes (serves frontend + API endpoints)
│   ├── hand_detection.py   # MediaPipe hand tracking + skeleton overlay rendering
│   ├── state_detection.py  # Turns landmarks into a rock/paper/scissors gesture
│   ├── ai_module.py        # AI opponent strategies + winner calculation
│   └── requirements.txt    # Python dependencies (pip)
├── frontend/
│   ├── index.html          # Page structure
│   ├── style.css           # All styling / theming (light + dark)
│   ├── script.js           # Game state machine + UI logic
│   └── resources/          # Images used by the frontend
└── utils/
```

---

## Extending the AI

The AI is intentionally modular — each strategy is a small function in
`backend/ai_module.py` that returns the move the AI should play this
round. To add your own:

1. Write a `_my_strategy()` function that returns one of
   `VALID_MOVES` (`'rock'`, `'paper'`, `'scissors'`).
2. Add it to the `_STRATEGIES` dispatch table.
3. Add a new entry to `DIFFICULTY_LEVELS` mapping a difficulty name to
   your strategy name.
4. Add a button in `frontend/index.html`'s `#difficulty-bar` with
   `data-difficulty="your_name"`.

Ideas for leveling up:

- Weight older moves even more aggressively (tune `DECAY`).
- Build a higher-order Markov chain (n-grams of length 2 or 3).
- Train a small scikit-learn classifier on collected match data.
- Track win/loss streaks and adjust the counter-strategy's
  aggressiveness (the adaptive strategy already does a simple version
  of this).
- Add a "meta-strategy" that detects when the player is themselves
  counter-predicting the AI and flips to anti-anti-counter play.

> **Note:** In Rock-Paper-Scissors the theoretical Nash equilibrium is
> simply to play uniformly at random — a *predictive* model only has an
> edge because real humans rarely play perfectly randomly.

---

## Configuration

| Variable           | Default   | Description                                                                 |
| ------------------ | --------- | --------------------------------------------------------------------------- |
| `PORT`             | `5050`    | Port the Flask server listens on. (5000 is avoided — see Troubleshooting.) |
| `RPS_DIFFICULTY`   | `medium`  | Starting difficulty: `easy` / `medium` / `hard` / `insane`.                 |

---

## Troubleshooting

**"Address already in use" on startup.**
Port 5050 is already bound by something else on your machine. Override
with `PORT=8080 python run.py` (or any free port) and open
`http://127.0.0.1:<port>/`.

**Webcam doesn't start / "Could not access webcam".**
- Browsers only allow camera access on `localhost` or over HTTPS. Use
  `http://127.0.0.1:5050/` (not your machine's LAN IP) for local testing.
- Check that no other app (Zoom, Teams, another browser tab) is holding
  the camera.
- On macOS, ensure the browser has been granted camera permission in
  *System Settings → Privacy & Security → Camera*.

**Hand isn't being detected.**
- Use even, front-on lighting. Backlighting (window behind you) makes
  the hand hard to segment.
- Hold your hand ~30–60 cm from the camera and try to fill the frame.
- The detector tracks the *largest* hand it sees, so make sure your
  hand is the biggest thing in frame.

**`mediapipe` install fails.**
The project pins to the last `mediapipe` release that ships the classic
`mediapipe.solutions` API. If pip can't find a wheel for your Python
version, try Python 3.9–3.11 (3.12+ may not have a compatible wheel
yet). The `environment.yml` is pinned to Python 3.9 for this reason.

**The AI Insight panel shows "—".**
That just means no rounds have been played yet — the panel populates
after the first round (or when you change difficulty).

---

## Notes & Known Limitations

- Works best in good, even lighting with your hand clearly in frame.
- Only the single largest hand in frame is tracked; multiple hands are
  ignored (except for choosing the largest one).
- The AI's move history is currently a single global in-memory value in
  the Flask process — fine for one local player, but would need to be
  made per-session before supporting multiple simultaneous players.
- Flask's development server is used for simplicity. For a public
  deployment, put it behind a production WSGI server (e.g. `gunicorn`)
  and a reverse proxy, and serve the frontend over HTTPS so the webcam
  works on non-localhost origins.

---

## Ethics & Privacy

- **No data leaves your machine.** Webcam frames are sent only to the
  local Flask process (`127.0.0.1`) for hand-landmark detection and are
  never stored, logged, or transmitted anywhere else.
- The AI's move history lives only in the Python process's memory and is
  cleared whenever you click **Reset Match** or restart the server.
- This is a demo/educational project — please don't deploy it as a
  public service without first reviewing the camera-access and privacy
  implications.

---

Built with Flask, MediaPipe & a little bit of magic ✨
