# RPS AI — Technical Project Guide

This document explains the current implementation of the project, how the files interact, and where to look when changing or debugging the application.

> The saved training images are currently a labelled dataset and library. They are not automatically used to train a new machine-learning classifier. Runtime gesture detection still uses the geometric rules in `backend/state_detection.py`.

---

## 1. System overview

RPS AI is a local Rock, Paper, Scissors game with two input methods:

- **Webcam mode:** the browser sends frames to Flask, MediaPipe detects hand landmarks, the backend classifies the pose, and the browser submits the final move.
- **Quick Play mode:** the user clicks a move and bypasses the camera, but still uses the same backend AI and winner calculation.

The application is intentionally divided into frontend and backend responsibilities.

```text
Browser
  ├── HTML structure
  ├── CSS layout and themes
  └── JavaScript game state, webcam loop, and rendering

Flask backend
  ├── HTTP routes
  ├── OpenCV image decoding
  ├── MediaPipe hand detection
  ├── landmark-based gesture classification
  └── AI strategy and round evaluation
```

The browser owns the interactive game state machine. The Python backend owns computer vision and AI decisions.

---

## 2. Project structure

```text
RPS/
├── README.md
├── PROJECT_TECHNICAL_GUIDE.md
├── run.py
├── run.sh
├── run.bat
├── environment.yml
│
├── backend/
│   ├── app.py
│   ├── ai_module.py
│   ├── hand_detection.py
│   ├── state_detection.py
│   └── requirements.txt
│
├── frontend/
│   ├── index.html
│   ├── script.js
│   ├── style.css
│   └── resources/
│       └── ai_hand.jpg
│
└── utils/
```

Runtime-labelled frames are saved in:

```text
training_data/<label>/
```

`training_data/` is ignored by Git because it contains local user-generated data.

### File responsibilities

| File | Responsibility |
|---|---|
| `run.py` | Creates or uses a virtual environment, installs packages, starts Flask, and can open the browser |
| `run.sh` | macOS/Linux wrapper around `run.py` |
| `run.bat` | Windows wrapper around `run.py` |
| `backend/app.py` | Flask application, API routes, validation, static frontend serving, and training-image storage |
| `backend/ai_module.py` | AI strategies, history, winner calculation, difficulty, and statistics |
| `backend/hand_detection.py` | Base64 decoding, MediaPipe inference, largest-hand selection, and skeleton overlay |
| `backend/state_detection.py` | Converts landmarks into `rock`, `paper`, `scissors`, or `wait` |
| `frontend/index.html` | Page structure and controls |
| `frontend/script.js` | Browser state machine, webcam loop, requests, training review, carousel, and UI updates |
| `frontend/style.css` | Layout, themes, responsive rules, animations, and component styling |

---

## 3. Running the project

### One-click launcher

From the project root:

```bash
python run.py
```

macOS/Linux:

```bash
./run.sh
```

Windows:

```bat
run.bat
```

The default URL is:

```text
http://127.0.0.1:5050/
```

### Manual setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend
python app.py
```

On Windows, activate the environment with:

```bat
.venv\Scripts\activate
```

### Configuration

The server reads:

```text
PORT
RPS_DIFFICULTY
```

Example:

```bash
PORT=8080 RPS_DIFFICULTY=random python app.py
```

The current difficulty values are:

```text
predictive
random
```

Port 5050 is used instead of port 5000 because port 5000 is frequently occupied on macOS.

### Camera requirement

Camera permissions normally work on:

- `localhost`
- `127.0.0.1`
- HTTPS sites

Use the local Flask URL instead of opening `index.html` directly from the filesystem.

---

## 4. Request flow

A webcam frame follows this path:

```text
<video>
  ↓
Canvas captures a mirrored JPEG
  ↓
POST /process_frame
  ↓
hand_detection.process_image()
  ↓
MediaPipe landmarks
  ↓
state_detection.detect_state()
  ↓
{ status, overlay_image_base64, hand_mean_y }
  ↓
Frontend stability and shake logic
```

When the browser decides that a round should be played:

```text
playGame(move)
  ↓
POST /play_round
  ↓
ai_module.determine_ai_move()
  ↓
AI move + winner
  ↓
score, history, banner, AI insight
```

The backend does not run the visual countdown. The frontend does.

---

## 5. Flask application: `backend/app.py`

`app.py` connects the frontend, computer vision, and AI.

Flask is configured to serve the sibling `frontend/` directory:

```python
app = Flask(
    __name__,
    static_folder="../frontend",
    template_folder="../frontend",
    static_url_path="",
)
```

This makes paths such as `/style.css` and `/script.js` work without a `/static/` prefix.

### Current routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/` | Serves `index.html` |
| `GET` | `/health` | Server health check |
| `GET` | `/ai_stats` | AI history and prediction data |
| `POST` | `/set_difficulty` | Changes AI mode |
| `POST` | `/process_frame` | Analyses one webcam frame |
| `POST` | `/play_round` | Plays one RPS round |
| `POST` | `/save_training_image` | Saves a labelled frame |
| `GET` | `/training_images` | Lists saved frame metadata |
| `GET` | `/training_image/<path>` | Serves one saved frame |
| `POST` | `/reset_game` | Clears AI history |

### `/health`

```bash
curl http://127.0.0.1:5050/health
```

Example response:

```json
{
  "status": "ok",
  "difficulty": "predictive",
  "available_difficulties": ["predictive", "random"]
}
```

### `/process_frame`

Request:

```json
{
  "image": "data:image/jpeg;base64,..."
}
```

Response:

```json
{
  "status": "rock",
  "overlay_image_base64": "iVBORw0KGgo...",
  "hand_mean_y": 0.52
}
```

- `status` is `rock`, `paper`, `scissors`, or `wait`.
- `overlay_image_base64` is a transparent PNG without a Data URL prefix.
- `hand_mean_y` is the normalised average vertical hand position.

### `/play_round`

Request:

```json
{
  "player_move": "rock"
}
```

Only these values are accepted:

```text
rock
paper
scissors
```

Invalid values such as `wait` or `undefined` receive HTTP 400. This is important because the vision layer can return `wait`, but `wait` is not a playable move.

Response:

```json
{
  "ai_move": "paper",
  "winner": "ai",
  "difficulty": "predictive",
  "logs": {
    "difficulty": "predictive",
    "strategy": "adaptive",
    "history": ["rock"],
    "winner": "ai"
  }
}
```

### `/set_difficulty`

Request:

```json
{
  "difficulty": "predictive"
}
```

or:

```json
{
  "difficulty": "random"
}
```

`app.py` passes the value to `ai_module.set_difficulty()`, which normalises it and raises an error for unknown values.

### `/ai_stats`

This returns the data displayed by the AI Insight panel:

```json
{
  "difficulty": "predictive",
  "strategy": "adaptive",
  "history": ["rock", "paper"],
  "outcomes": ["player", "ai"],
  "weighted_counts": {
    "rock": 1.85,
    "paper": 0.85,
    "scissors": 0.0
  },
  "predicted_next_move": "rock",
  "player_win_rate": 0.5,
  "ai_win_rate": 0.5,
  "tie_rate": 0.0,
  "total_weighted": 2.7
}
```

### Training image routes

`/save_training_image` accepts:

```json
{
  "image": "data:image/jpeg;base64,...",
  "label": "scissors",
  "detected": "rock"
}
```

Valid labels are:

```text
rock
paper
scissors
no_move
```

Files are saved using:

```text
<label>_<timestamp>.jpg
<label>_was-<detected>_<timestamp>.jpg
```

Example:

```text
training_data/scissors/scissors_was-rock_1789008042774.jpg
```

`/training_images` returns metadata:

```json
{
  "images": [
    {
      "label": "scissors",
      "detected": "rock",
      "url": "/training_image/scissors/scissors_was-rock_....jpg"
    }
  ]
}
```

The frontend uses the URL to load each image into the carousel.

### Error handling

Expected input problems return HTTP 400. Unexpected exceptions are logged with a traceback and return JSON with HTTP 500.

The application currently uses Flask's development server with debug mode. This is appropriate for local development, not public deployment.

---

## 6. Computer vision: `backend/hand_detection.py`

This file detects hands. It does not classify the gesture.

Its pipeline is:

```text
Data URL
  ↓
base64 decode
  ↓
NumPy byte buffer
  ↓
OpenCV BGR image
  ↓
BGR → RGB
  ↓
MediaPipe Hands
  ↓
largest hand selection
  ↓
transparent skeleton PNG
```

### MediaPipe instance

A single shared MediaPipe object is created at import time:

```python
hands = mp_hands.Hands(
    model_complexity=0,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5,
)
```

Creating it once is important because model initialisation is expensive.

### Image decoding

The frontend sends:

```text
data:image/jpeg;base64,<encoded-data>
```

The backend removes everything before the comma and decodes the remainder. Failed decoding returns an empty result rather than crashing the frame loop.

### Colour order

OpenCV uses BGR, while MediaPipe expects RGB:

```python
rgb_image = cv2.cvtColor(img_cv, cv2.COLOR_BGR2RGB)
```

### Largest-hand selection

If MediaPipe detects multiple hands, the code calculates each hand's normalised bounding-box area and selects the largest.

This is a practical approximation for “the player's hand,” but it is not identity tracking. If another hand is closer or larger, it can be selected.

### Skeleton overlay

MediaPipe draws landmarks and connections onto a black canvas. Near-black pixels are changed to transparent, leaving only the coloured hand skeleton.

The returned image is a base64-encoded PNG. The frontend places it over the mirrored video element.

---

## 7. Gesture classification: `backend/state_detection.py`

This module converts a MediaPipe hand into:

```text
rock
paper
scissors
wait
```

MediaPipe supplies 21 landmarks. The classifier uses these pairs:

| Finger | Tip | Comparison joint |
|---|---:|---:|
| Thumb | 4 | 3 (`IP`) |
| Index | 8 | 6 (`PIP`) |
| Middle | 12 | 10 (`PIP`) |
| Ring | 16 | 14 (`PIP`) |
| Pinky | 20 | 18 (`PIP`) |

For non-thumb fingers:

```python
tip_y < pip_y
```

means the finger is extended, because smaller image Y values are higher on the screen.

The thumb uses X instead of Y because it folds sideways. The direction changes based on whether MediaPipe reports a left or right hand.

### Classification rules

**Paper**

```text
index up
middle up
ring up
pinky up
thumb up
```

**Scissors**

```text
index up
middle up
ring down
pinky down
```

Thumb position is ignored for Scissors.

**Rock**

```text
index down
middle down
ring down
pinky down
```

Thumb position is ignored for Rock.

Anything else becomes `wait`. This prevents transitional or unclear poses from becoming a committed move.

`detect_state()` also calculates the average normalised position of all landmarks:

```json
{
  "x": 0.48,
  "y": 0.53
}
```

The frontend uses the Y value for shake detection.

---

## 8. AI opponent: `backend/ai_module.py`

The AI stores state in process-global deques:

```python
player_move_history
round_outcome_history
```

The last ten valid player moves and outcomes are retained:

```python
HISTORY_LENGTH = 10
```

This works for a single local player. Multiple users would currently share the same AI history.

### Constants

```python
VALID_MOVES = ("rock", "paper", "scissors")
DECAY = 0.85
ADAPTIVE_RANDOM_PROB = 0.15
```

### Move mappings

```python
COUNTER_MOVES = {
    "rock": "paper",
    "paper": "scissors",
    "scissors": "rock",
}
```

This maps a move to the move that beats it.

```python
BEATS = {
    "rock": "scissors",
    "scissors": "paper",
    "paper": "rock",
}
```

This maps a move to the move it defeats.

### Current modes

```python
DIFFICULTY_LEVELS = {
    "predictive": "adaptive",
    "random": "random",
}
```

The current frontend therefore exposes two modes:

- **Random:** uniform random play
- **Predictive:** adaptive strategy

The README still contains older Easy/Medium/Hard/Insane terminology. The source code above is the current behaviour.

### Random strategy

```python
random.choice(VALID_MOVES)
```

Every move has equal probability. This is theoretically unexploitable if it is truly random.

### Frequency prediction

Recent moves receive exponentially decreasing weights:

```text
weight = DECAY ** age
```

With `DECAY = 0.85`:

```text
newest move: 1.0
one move old: 0.85
two moves old: 0.7225
```

The move with the highest weighted total is predicted as the next player move. The frequency strategy plays its counter.

### Markov prediction

The first-order Markov predictor counts transitions such as:

```text
rock → paper
paper → scissors
```

It examines what historically followed the player's latest move. It needs at least two moves and a known transition.

The Markov strategy counters the predicted next move. If there is insufficient transition data, it falls back to frequency prediction.

### Adaptive strategy

The predictive mode uses the adaptive strategy:

1. 15% of rounds are random.
2. Otherwise, inspect the last five outcomes.
3. If the player won at least three of those five rounds, assume they may be counter-predicting the AI.
4. During that winning streak, play the predicted player move instead of the normal counter.
5. Otherwise, prefer Markov prediction, then frequency prediction.

The random component prevents the strategy from becoming fully predictable.

### Round calculation

`determine_ai_move()`:

1. Adds the valid player move to history.
2. Selects the AI move.
3. Records available frequency and Markov predictions in logs.
4. Calculates `player`, `ai`, or `tie`.
5. Adds the result to outcome history.
6. Returns the round data.

The frontend uses the `logs` field for console debugging and the AI Insight panel uses `/ai_stats`.

---

## 9. Frontend: `frontend/index.html`

The page is a single-page application.

```text
#app-shell
├── #site-header
├── #help-panel
├── #game-layout
│   ├── #arena-column
│   │   ├── #status-banner
│   │   ├── #player-ui
│   │   ├── #gesture-strip
│   │   ├── #game-controls
│   │   ├── #quick-play
│   │   ├── #training-review
│   │   └── #training-carousel
│   └── #dashboard-column
│       ├── #top-stats
│       ├── #difficulty-bar
│       ├── #insight-column
│       └── #history-column
└── #site-footer
```

The status banner is the central user message area. The player arena contains the video and overlay. The dashboard contains score, difficulty, AI insight, and history.

The training review panel shows the current unlabeled frame. The training carousel shows previously saved frames.

---

## 10. Frontend logic: `frontend/script.js`

The script runs after `DOMContentLoaded`.

### Main browser state

```javascript
let playerWins = 0;
let aiWins = 0;
let gamesPlayed = 0;
let currentStream = null;
let gameStage = "wait";
```

The game stages are:

| Stage | Meaning |
|---|---|
| `wait` | Waiting for stable Rock |
| `ready_to_start` | Rock detected; waiting for shake |
| `countdown` | Countdown is running |
| `playing` | Round is resolving |

### Webcam startup

`startWebcam()`:

1. checks `getUserMedia`
2. requests the camera
3. assigns the stream to the video
4. starts the frame loop when playable
5. resets AI memory
6. clears old gesture and shake history

The camera may provide a high-resolution stream, but frames are reduced to approximately 320×240 before upload.

`stopWebcam()` stops every media track, clears the video, removes the overlay, hides controls, and returns the stage to `wait`.

### Frame loop

`captureAndProcessFrame()`:

1. verifies that the stream is still active
2. draws the video into a canvas
3. mirrors the frame
4. encodes JPEG
5. posts to `/process_frame`
6. calls `handleFrameResult()`
7. schedules the next frame with `requestAnimationFrame`

The video and canvas are both mirrored so the skeleton is aligned with the user's view.

### Stability filtering

The raw backend result can fluctuate. The frontend stores states for approximately:

```javascript
STABLE_STATE_WINDOW_MS = 500;
```

A gesture must make up at least:

```javascript
STABILITY_THRESHOLD_PERCENT = 0.7;
```

of the window to be treated as stable.

A recent stable pose can linger for:

```javascript
POSE_LINGER_MS = 1200;
```

This prevents one missed frame from causing visual jitter.

The overlay itself is cleared only after several consecutive misses:

```javascript
MAX_FRAMES_WITHOUT_HAND = 8;
```

### Shake detection

The player must show stable Rock first.

The frontend stores recent hand Y positions and calculates the current deviation from the recent average. A deviation larger than:

```javascript
Y_MOVEMENT_THRESHOLD = 0.05;
```

is considered a shake.

The shake is only checked while the stable gesture is Rock.

### Countdown

The countdown uses:

```javascript
GET_READY_DELAY_MS = 700;
COUNTDOWN_STEP_MS = 900;
```

The browser displays:

```text
Get Ready
Scissors
Paper
Rock
```

At the final beat, it uses the stable gesture rather than a single raw frame. It retries briefly if the classifier temporarily returns `wait`.

### `playGame()`

Both webcam rounds and Quick Play call `playGame()`.

It first validates:

```javascript
VALID_MOVES.includes(playerMove)
```

This is a second line of defence against sending `wait`, `undefined`, or another invalid value to Flask.

For valid moves it:

1. changes the stage to `playing`
2. highlights the player's move
3. captures a training frame when the webcam is active
4. shows the player's move overlay
5. requests `/play_round`
6. validates the returned AI move
7. updates score and history
8. reveals the AI move
9. shows the result
10. refreshes AI statistics
11. returns to the waiting stage after the result delay

### Quick Play

Quick Play buttons have `data-move` attributes:

```html
<button data-move="rock">...</button>
```

Their clicks call the same `playGame()` function used by the camera. This prevents the two input methods from developing separate game logic.

### AI Insight polling

The frontend calls `/ai_stats`:

- immediately on startup
- every four seconds
- after a round
- after changing difficulty

The response updates:

- strategy label
- predicted move
- player win rate
- weighted Rock/Paper/Scissors bars
- active difficulty button

---

## 11. Training review and carousel

### Review queue

The frontend stores pending frames in:

```javascript
trainingQueue
```

Each item has:

```javascript
{
    image: "data:image/jpeg;base64,...",
    detected: "rock"
}
```

Frames are queued instead of replacing one another, so playing another round does not silently lose an unlabelled example.

The user can:

- confirm the detected move
- relabel as Rock
- relabel as Paper
- relabel as Scissors
- choose `no_move`

When the user chooses a label, the frame is posted to `/save_training_image`.

### `no_move`

`no_move` represents:

- no hand in frame
- unclear hand
- a frame where the detector reported `wait`
- a negative example for future classifier work

It is stored separately:

```text
training_data/no_move/
```

### Carousel

When the page loads, `loadExistingTrainingImages()` calls:

```javascript
fetch("/training_images")
```

For every returned item, it creates a labelled thumbnail and adds it to `#training-log`.

The carousel:

- hides itself if there are no saved images
- displays the number of frames
- shows previous/next buttons only when the strip overflows
- scrolls smoothly by several thumbnail widths
- keeps corrected frames marked with a red border
- immediately adds newly saved frames

The carousel is a library and browser for the dataset. It does not train the gesture recogniser by itself.

### Future machine-learning integration

To make saved images affect classification, a future system would need to:

1. load images from `training_data`
2. define image or landmark features
3. train a model
4. save/load model weights
5. call the model from `state_detection.py`
6. define how `no_move` is used
7. validate accuracy on held-out examples
8. retain a fallback when confidence is low

---

## 12. Styling: `frontend/style.css`

The stylesheet uses CSS variables for colors, spacing-related values, shadows, and borders.

Themes are selected through:

```html
<html data-theme="dark">
```

or:

```html
<html data-theme="light">
```

The preference is stored in:

```text
localStorage["rps-theme"]
```

Sound preference is stored in:

```text
localStorage["rps-sound"]
```

The layout uses two columns on larger screens and collapses to one column around 980px. Around 640px:

- the subtitle is hidden
- the dashboard becomes one column
- arena boxes shrink
- training review content stacks
- status text may wrap

The project also includes focus styles, ARIA labels, live regions, and reduced-motion handling.

---

## 13. Debugging commands

Check the server:

```bash
curl http://127.0.0.1:5050/health
```

Check JavaScript syntax:

```bash
node --check frontend/script.js
```

Check Python syntax:

```bash
python -m py_compile \
  backend/app.py \
  backend/ai_module.py \
  backend/hand_detection.py \
  backend/state_detection.py
```

Test a round:

```bash
curl -X POST http://127.0.0.1:5050/play_round \
  -H "Content-Type: application/json" \
  -d '{"player_move":"rock"}'
```

List saved images:

```bash
curl http://127.0.0.1:5050/training_images
```

Test a saved image:

```bash
curl -I http://127.0.0.1:5050/training_image/scissors/<filename>.jpg
```

Use the browser Network tab to inspect:

- `/process_frame`
- `/play_round`
- `/ai_stats`
- `/training_images`
- `/save_training_image`

Use the browser console for JavaScript warnings and the Flask terminal for backend tracebacks.

### Debugging by responsibility

| Symptom | First file to inspect |
|---|---|
| No skeleton overlay | `hand_detection.py` or `/process_frame` |
| Skeleton appears but gesture is wrong | `state_detection.py` |
| Gesture is correct but AI result is wrong | `ai_module.py` |
| API response is correct but UI is wrong | `script.js` |
| Element is missing or misplaced | `index.html` |
| Colors/layout/responsiveness are wrong | `style.css` |
| Requests fail | `app.py`, browser Network tab, Flask log |

---

## 14. Limitations and important notes

### Global AI memory

The AI history is process-global. Multiple browser users would share one history. A multi-user version should move history into session-specific state and consider concurrency.

### Rule-based vision

The classifier is explainable but sensitive to:

- lighting
- camera angle
- motion blur
- hand rotation
- partial occlusion
- unusual finger positions
- incorrect handedness

### One selected hand

The largest detected hand is selected. The system does not identify the player or track hand identity.

### Local file storage

Training images remain on disk until manually removed. A large dataset will consume disk space.

### Development server

Flask debug mode is convenient locally but should be replaced with a production WSGI server and HTTPS for deployment.

### README drift

The README still describes older difficulty names such as Easy, Medium, Hard, and Insane. The current implementation exposes only:

```text
predictive
random
```

When documentation and behaviour disagree, treat the current source files as authoritative.

---

## 15. Safe extension patterns

### Change gesture classification

Edit `backend/state_detection.py`, preserve the return values:

```text
rock
paper
scissors
wait
```

Then run the Python compilation check.

### Add an AI strategy

1. Add a function returning one of `VALID_MOVES`.
2. Add it to `_STRATEGIES`.
3. Add a public entry to `DIFFICULTY_LEVELS`.
4. Add a frontend button if it should be user-selectable.
5. Test `/set_difficulty` and `/play_round`.

### Add an API route

1. Define the route in `app.py`.
2. Validate JSON input.
3. Return clear JSON.
4. Use HTTP 400 for invalid input.
5. Return HTTP 500 for unexpected errors.
6. Test with `curl`.
7. Connect it from `script.js` if required.

### Change the training format

Update these together:

- `/save_training_image`
- `/training_images`
- frontend carousel metadata
- filename parsing
- any future training script

The filename format is a data contract:

```text
<label>_<timestamp>.jpg
<label>_was-<detected>_<timestamp>.jpg
```

---

## 16. Complete webcam round walkthrough

1. The user clicks Start Webcam.
2. `startWebcam()` requests a `MediaStream`.
3. The browser starts `captureAndProcessFrame()`.
4. The frame is mirrored, resized, and encoded as JPEG.
5. The browser posts it to `/process_frame`.
6. Flask calls `hand_detection.process_image()`.
7. MediaPipe returns landmarks.
8. The largest hand is selected.
9. `state_detection.detect_state()` classifies the landmarks.
10. Flask returns gesture, overlay, and hand Y-position.
11. The browser applies stability filtering.
12. Stable Rock changes the stage from `wait` to `ready_to_start`.
13. Vertical movement starts the countdown.
14. The final stable gesture is passed to `playGame()`.
15. `playGame()` validates the move.
16. The browser posts it to `/play_round`.
17. The AI records history, selects a move, and calculates the winner.
18. Flask returns the result.
19. The browser updates score, history, banner, and AI insight.
20. The captured frame enters the training review queue.
21. The user can label it and save it locally.
22. The next round returns the browser to `wait`.

---

## 17. Core mental model

```text
hand_detection.py
    Sees the hand.
    Returns landmarks and a skeleton overlay.

state_detection.py
    Interprets landmarks.
    Returns rock/paper/scissors/wait.

ai_module.py
    Chooses the AI move.
    Calculates the winner.
    Tracks player history.

app.py
    Exposes the Python functionality through HTTP.

script.js
    Controls the browser state machine.
    Sends frames and renders results.

index.html
    Defines the page structure and controls.

style.css
    Defines visual appearance and responsive behaviour.
```

When revisiting the code, follow the data in that order. A webcam problem usually starts at the browser or `hand_detection.py`; a classification problem is usually in `state_detection.py`; an AI problem is usually in `ai_module.py`; and a display problem is usually in `script.js`, `index.html`, or `style.css`.