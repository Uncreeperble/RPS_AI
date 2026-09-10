"""
app.py
======
Flask server: glues the CV pipeline (hand_detection + state_detection)
and the AI opponent (ai_module) together, and serves the frontend.

Flow: the browser POSTs webcam frames to /process_frame continuously;
its own JS state machine detects a stable gesture and the "shake to
throw", then POSTs the final move to /play_round. /reset_game clears
the AI's memory when a new session starts. /ai_stats and
/set_difficulty power the frontend's AI-insight panel and mode switch.

Run from the backend directory:  python app.py
Serves the frontend at http://127.0.0.1:5050/ (port 5000 is avoided
deliberately -- it's often taken by macOS AirPlay; override with PORT).
"""

from __future__ import annotations

import base64
import os
import time
import traceback

from flask import Flask, jsonify, render_template, request, send_from_directory

from ai_module import (
    DIFFICULTY_LEVELS,
    VALID_MOVES,
    determine_ai_move,
    get_difficulty,
    get_stats,
    reset_history,
    set_difficulty,
)
from hand_detection import process_image as detect_hand_image
from state_detection import detect_state

# The frontend lives in ../frontend instead of Flask's conventional
# static/templates folders. static_url_path='' serves assets from the
# site root (e.g. /style.css), matching the paths used in index.html.
app = Flask(
    __name__,
    static_folder="../frontend",
    template_folder="../frontend",
    static_url_path="",
)


@app.route("/")
def home():
    """Serve the game's single-page frontend."""
    return render_template("index.html")


@app.route("/health")
def health():
    """Health check: confirms the server is up and the AI module loaded."""
    return jsonify(
        {
            "status": "ok",
            "difficulty": get_difficulty(),
            "available_difficulties": list(DIFFICULTY_LEVELS.keys()),
        }
    )


@app.route("/ai_stats")
def ai_stats():
    """Snapshot of the AI's state (see ai_module.get_stats) for the
    frontend's AI-insight panel."""
    try:
        return jsonify(get_stats())
    except Exception as exc:  # noqa: BLE001
        print(f"[app] An error occurred in /ai_stats: {exc}")
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


@app.route("/set_difficulty", methods=["POST"])
def change_difficulty():
    """Switch the AI's mode. Body: {"difficulty": "predictive" | "random"}.

    Returns the normalised mode and its strategy; 400 if unknown."""
    try:
        data = request.get_json() or {}
        level = data.get("difficulty")
        if not level:
            return jsonify({"error": "No 'difficulty' field provided."}), 400
        try:
            normalised = set_difficulty(level)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify(
            {
                "status": "ok",
                "difficulty": normalised,
                "strategy": DIFFICULTY_LEVELS[normalised],
            }
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[app] An error occurred in /set_difficulty: {exc}")
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


@app.route("/process_frame", methods=["POST"])
def process_frame():
    """Analyse one webcam frame. Body: {"image": "data:image/jpeg;base64,..."}.

    Returns {"status": gesture, "overlay_image_base64": skeleton PNG or
    "", "hand_mean_y": normalised hand height or None} for the frontend's
    shake detection. Errors return 500 with a JSON body."""
    try:
        data = request.get_json()
        image_data = data.get("image") if data else None

        if not image_data:
            return jsonify({"error": "No image data provided"}), 400

        # CV pipeline: find the largest hand, then classify its gesture.
        landmarks, handedness, overlay_b64, width, height = detect_hand_image(image_data)
        location, state = detect_state(landmarks, handedness, width, height)
        result = {
            "status": state,
            "overlay_image_base64": overlay_b64,
            "hand_mean_y": location["y"] if location else None,
        }
        return jsonify(result)

    except Exception as exc:  # noqa: BLE001 - surface *any* failure as JSON, not a stack trace page
        print(f"[app] An error occurred in /process_frame: {exc}")
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


@app.route("/play_round", methods=["POST"])
def play_round():
    """Play one round. Body: {"player_move": "rock"|"paper"|"scissors"}.

    Returns the AI's move, the winner, and debug logs (see
    ai_module.determine_ai_move). Invalid moves get a 400 so a stray
    'wait' from the frontend can never reach the AI logic."""
    try:
        data = request.get_json()
        player_move = data.get("player_move") if data else None

        if not player_move:
            return jsonify({"error": "No player move provided"}), 400

        if player_move not in VALID_MOVES:
            return jsonify(
                {
                    "error": (
                        f"'{player_move}' is not a valid move. "
                        f"Expected one of: {', '.join(VALID_MOVES)}."
                    )
                }
            ), 400

        ai_result = determine_ai_move(player_move)
        return jsonify(ai_result)

    except Exception as exc:  # noqa: BLE001
        print(f"[app] An error occurred in /play_round: {exc}")
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


@app.route("/save_training_image", methods=["POST"])
def save_training_image():
    """Save a human-labelled webcam frame for future model training.

    Body: {"image": data URL, "label": move|'no_move', "detected": guess}.
    Saved to training_data/<label>/ as a JPEG. When the player corrected
    the detection, the original guess is kept in the filename
    ("..._was-<detected>") so misclassification patterns can be analysed
    (or down-weighted) at training time. Returns the saved file's path."""
    try:
        data = request.get_json() or {}
        image_data = data.get("image")
        label = data.get("label")
        detected = data.get("detected")

        if not image_data:
            return jsonify({"error": "No image data provided"}), 400
        # 'no_move' = hand not in frame / unclear: a negative example.
        training_labels = set(VALID_MOVES) | {"no_move"}
        if label not in training_labels:
            return jsonify(
                {"error": f"'label' must be one of: {', '.join(sorted(training_labels))}."}
            ), 400

        # Strip the data-URL prefix, then decode the JPEG bytes.
        if "," in image_data:
            image_data = image_data.split(",", 1)[1]
        try:
            image_bytes = base64.b64decode(image_data)
        except Exception:
            return jsonify({"error": "Image data is not valid base64"}), 400

        label_dir = os.path.join(TRAINING_DATA_DIR, label)
        os.makedirs(label_dir, exist_ok=True)

        timestamp_ms = int(time.time() * 1000)
        if detected in VALID_MOVES and detected != label:
            filename = f"{label}_was-{detected}_{timestamp_ms}.jpg"
        else:
            filename = f"{label}_{timestamp_ms}.jpg"

        filepath = os.path.join(label_dir, filename)
        with open(filepath, "wb") as fh:
            fh.write(image_bytes)

        relative = os.path.relpath(filepath, os.path.join(os.path.dirname(__file__), ".."))
        return jsonify({"status": "ok", "path": relative})

    except Exception as exc:  # noqa: BLE001
        print(f"[app] An error occurred in /save_training_image: {exc}")
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


@app.route("/training_images")
def training_images():
    """List previously saved training images, oldest first.

    Each item has {"label", "detected", "url"}; "detected" is the CV
    pipeline's original guess when the player corrected it, else None.
    """
    items = []
    if os.path.isdir(TRAINING_DATA_DIR):
        for label in sorted(os.listdir(TRAINING_DATA_DIR)):
            label_dir = os.path.join(TRAINING_DATA_DIR, label)
            if not os.path.isdir(label_dir):
                continue
            for fname in sorted(os.listdir(label_dir)):
                if not fname.lower().endswith(".jpg"):
                    continue
                # Filenames look like "<label>[_was-<detected>]_<ts>.jpg".
                detected = None
                stem = fname[:-4]
                if "_was-" in stem:
                    detected = stem.split("_was-", 1)[1].rsplit("_", 1)[0]
                items.append(
                    {
                        "label": label,
                        "detected": detected,
                        "url": f"/training_image/{label}/{fname}",
                    }
                )
    return jsonify({"images": items})


@app.route("/training_image/<path:subpath>")
def training_image(subpath):
    """Serve a saved training image (read-only, traversal-safe)."""
    return send_from_directory(TRAINING_DATA_DIR, subpath)


@app.route("/reset_game", methods=["POST"])
def reset_game():
    """Clear the AI's memory (called when a new play session starts)."""
    try:
        reset_history()
        return jsonify({"status": "ok"})
    except Exception as exc:  # noqa: BLE001
        print(f"[app] An error occurred in /reset_game: {exc}")
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


# Where human-confirmed training frames are stored (created on demand).
TRAINING_DATA_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "training_data"
)

# Port 5000 is avoided by default (often taken by macOS AirPlay); the
# PORT env var overrides it. RPS_DIFFICULTY sets the starting AI mode.
PORT = int(os.environ.get("PORT", 5050))
_default_difficulty_env = os.environ.get("RPS_DIFFICULTY", "").strip().lower()
if _default_difficulty_env in DIFFICULTY_LEVELS:
    set_difficulty(_default_difficulty_env)


if __name__ == "__main__":
    # debug=True gives auto-reload + interactive debugger: development
    # only. Use a production WSGI server (e.g. gunicorn) when deploying.
    print(f" * RPS AI is starting at http://127.0.0.1:{PORT}/")
    print(f" * Difficulty: {get_difficulty()} (override with RPS_DIFFICULTY env var)")
    print(f" * Available difficulties: {', '.join(DIFFICULTY_LEVELS.keys())}")
    app.run(debug=True, port=PORT)