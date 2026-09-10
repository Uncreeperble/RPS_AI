"""
state_detection.py
==================
Turns MediaPipe hand landmarks into a game state: 'rock', 'paper',
'scissors', or 'wait' (no confident gesture), plus the hand's position.

Pure function library -- no webcam/Flask dependencies, so it's easy to
unit test with hand-crafted landmark lists.
"""

from __future__ import annotations

from typing import Optional

import numpy as np

# MediaPipe returns 21 landmarks per hand. Comparing each fingertip's
# position against its PIP (middle) knuckle tells us if a finger is
# extended or curled. See:
# https://google.github.io/mediapipe/solutions/hands.html
THUMB_TIP = 4
THUMB_IP = 3
INDEX_TIP = 8
INDEX_PIP = 6
MIDDLE_TIP = 12
MIDDLE_PIP = 10
RING_TIP = 16
RING_PIP = 14
PINKY_TIP = 20
PINKY_PIP = 18


def get_gesture(landmarks_list: list[list[float]], handedness: Optional[str]) -> str:
    """Classify a hand pose as rock, paper, scissors, or "wait".

    Simple geometric rules: a non-thumb finger is "up" when its tip is
    above its PIP knuckle (smaller Y). The thumb folds sideways, so it
    is judged on X, with the direction depending on handedness.

    Args:
        landmarks_list: 21 ``[x, y]`` pixel-coordinate pairs (one per
            landmark), from ``hand_detection.process_image``.
        handedness: ``"Left"``/``"Right"``; anything else conservatively
            treats the thumb as not extended.

    Returns:
        ``'rock'``, ``'paper'``, ``'scissors'``, or ``'wait'`` for poses
        that don't clearly match a game gesture.
    """
    # 1. Which of the four main fingers are extended?
    index_up = landmarks_list[INDEX_TIP][1] < landmarks_list[INDEX_PIP][1]
    middle_up = landmarks_list[MIDDLE_TIP][1] < landmarks_list[MIDDLE_PIP][1]
    ring_up = landmarks_list[RING_TIP][1] < landmarks_list[RING_PIP][1]
    pinky_up = landmarks_list[PINKY_TIP][1] < landmarks_list[PINKY_PIP][1]

    # 2. Thumb state (folds sideways, so uses X not Y).
    if handedness == "Right":
        thumb_up = landmarks_list[THUMB_TIP][0] < landmarks_list[THUMB_IP][0]
    elif handedness == "Left":
        thumb_up = landmarks_list[THUMB_TIP][0] > landmarks_list[THUMB_IP][0]
    else:
        # Unknown handedness: can't tell which way the thumb points, so
        # treat it as not extended (only affects the 'paper' check).
        thumb_up = False

    # 3. Classify the gesture. Thumb is ignored for scissors/rock since
    # both are held naturally in several ways.
    if index_up and middle_up and ring_up and pinky_up and thumb_up:
        return "paper"  # open hand

    if index_up and middle_up and not ring_up and not pinky_up:
        return "scissors"  # index + middle in a "V"

    if not index_up and not middle_up and not ring_up and not pinky_up:
        return "rock"  # fist

    return "wait"  # mid-transition or not a game gesture


def detect_state(
    landmarks,
    handedness: Optional[str],
    image_width: int,
    image_height: int,
) -> tuple[Optional[dict], str]:
    """Compute the hand's on-screen location and its game-state gesture.

    Args:
        landmarks: Raw MediaPipe ``NormalizedLandmarkList`` for one hand,
            or ``None`` if no hand was detected.
        handedness: ``'Left'``/``'Right'``, or ``None``.
        image_width / image_height: Frame size in pixels, used to scale
            normalised coordinates for :func:`get_gesture`.

    Returns:
        ``(location, state)`` where ``location`` is the mean normalised
        (0.0-1.0) landmark position (used by the frontend for shake
        detection) or ``None``, and ``state`` is the gesture string.
    """
    if not landmarks or not handedness:
        return (None, "wait")

    location = {
        "x": float(np.mean([lm.x for lm in landmarks.landmark])),
        "y": float(np.mean([lm.y for lm in landmarks.landmark])),
    }

    # get_gesture works in pixel coordinates, so scale up.
    landmarks_list = [
        [lm.x * image_width, lm.y * image_height] for lm in landmarks.landmark
    ]

    state = get_gesture(landmarks_list, handedness)

    return (location, state)
