"""
hand_detection.py
=================
Computer-vision layer: turns a base64 webcam frame into MediaPipe hand
landmarks plus a transparent skeleton overlay for the frontend.

Gesture classification (rock/paper/scissors) lives in state_detection.py
-- this module only "sees", it doesn't "think".
"""

from __future__ import annotations

import base64
import io
from typing import Optional

import cv2
import mediapipe as mp
import numpy as np
from PIL import Image

# The model load is expensive, so create one shared instance at import
# time and reuse it for every frame.
mp_hands = mp.solutions.hands
hands = mp_hands.Hands(
    model_complexity=0,        # 0 = fastest/lightest model variant (good for real-time webcam use)
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5,
)
mp_drawing = mp.solutions.drawing_utils

# BGR colours for the skeleton overlay (bright = visible over any background).
_LANDMARK_COLOR_BGR = (0, 255, 255)    # bright yellow dots for each joint
_CONNECTION_COLOR_BGR = (0, 200, 255)  # bright orange lines between joints

# Any drawn pixel darker than this (on all three channels) is treated as
# "background" and made transparent when building the overlay PNG, since
# we draw the skeleton on a solid black canvas.
_TRANSPARENCY_THRESHOLD = 5


def process_image(
    image_data: str,
) -> tuple[Optional["mp.framework.formats.landmark_pb2.NormalizedLandmarkList"], Optional[str], str, int, int]:
    """Detect the largest hand in a base64-encoded webcam frame.

    Args:
        image_data: Data URL from the browser's ``canvas.toDataURL()``.
            Only the part after the comma is decoded.

    Returns:
        ``(landmarks, handedness, overlay_base64, width, height)`` where
        ``landmarks``/``handedness`` are ``None`` and ``overlay_base64``
        is ``''`` if no hand was found or the image failed to decode.
        ``width``/``height`` are the frame's pixel dimensions (needed by
        state_detection to convert normalised coordinates).
    """
    # 1. Decode the base64 image. A single bad frame shouldn't crash the
    # game loop, so decode failures fail soft.
    try:
        image_bytes = base64.b64decode(image_data.split(",")[1])
        np_arr = np.frombuffer(image_bytes, np.uint8)
        img_cv = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if img_cv is None:
            return (None, None, "", 0, 0)
    except Exception as exc:  # noqa: BLE001 - we deliberately want to catch *any* decode failure here
        print(f"[hand_detection] Error decoding image: {exc}")
        return (None, None, "", 0, 0)

    height, width, _ = img_cv.shape

    # 2. Run MediaPipe (expects RGB; OpenCV decodes BGR).
    rgb_image = cv2.cvtColor(img_cv, cv2.COLOR_BGR2RGB)
    results = hands.process(rgb_image)

    largest_hand_landmarks = None
    largest_hand_handedness = None

    # 3. Keep only the largest hand -- bounding-box area is a decent proxy
    # for "closest to the camera", i.e. the player's hand.
    if results.multi_hand_landmarks and results.multi_handedness:
        max_area = 0.0
        for hand_landmarks, handedness_info in zip(
            results.multi_hand_landmarks, results.multi_handedness
        ):
            x_coords = [lm.x for lm in hand_landmarks.landmark]
            y_coords = [lm.y for lm in hand_landmarks.landmark]
            area = (max(x_coords) - min(x_coords)) * (max(y_coords) - min(y_coords))

            if area > max_area:
                max_area = area
                largest_hand_landmarks = hand_landmarks
                largest_hand_handedness = handedness_info.classification[0].label

    # 4. Build the skeleton overlay (empty when no hand was found).
    overlay_image_base64 = (
        _generate_overlay_image(largest_hand_landmarks, height, width)
        if largest_hand_landmarks
        else ""
    )

    return (largest_hand_landmarks, largest_hand_handedness, overlay_image_base64, width, height)


def _generate_overlay_image(largest_hand_landmarks, height: int, width: int) -> str:
    """Render the hand skeleton as a transparent, base64-encoded PNG.

    MediaPipe's drawing utilities need an existing image buffer, so the
    skeleton is drawn onto a black canvas first; near-black pixels are
    then made transparent, leaving only the coloured skeleton visible
    when layered over the webcam feed in the browser.
    """
    drawing_image_bgr = np.zeros((height, width, 3), dtype=np.uint8)

    landmark_drawing_spec = mp_drawing.DrawingSpec(
        color=_LANDMARK_COLOR_BGR, thickness=3, circle_radius=5
    )
    connection_drawing_spec = mp_drawing.DrawingSpec(
        color=_CONNECTION_COLOR_BGR, thickness=4
    )

    mp_drawing.draw_landmarks(
        image=drawing_image_bgr,
        landmark_list=largest_hand_landmarks,
        connections=mp_hands.HAND_CONNECTIONS,
        landmark_drawing_spec=landmark_drawing_spec,
        connection_drawing_spec=connection_drawing_spec,
    )

    overlay_pil = Image.fromarray(cv2.cvtColor(drawing_image_bgr, cv2.COLOR_BGR2RGBA))

    # Knock out the black background so only the skeleton is visible.
    pixels = overlay_pil.getdata()
    transparent_pixels = [
        (0, 0, 0, 0)
        if (r < _TRANSPARENCY_THRESHOLD and g < _TRANSPARENCY_THRESHOLD and b < _TRANSPARENCY_THRESHOLD)
        else (r, g, b, a)
        for (r, g, b, a) in pixels
    ]
    overlay_pil.putdata(transparent_pixels)

    buffered = io.BytesIO()
    overlay_pil.save(buffered, format="PNG")
    return base64.b64encode(buffered.getvalue()).decode("utf-8")