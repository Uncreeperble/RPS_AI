"""
ai_module.py
============
Game logic and AI opponent: picks the AI's move, judges round winners,
and tracks the player's move history.

Two modes (see DIFFICULTY_LEVELS):
* "random"     -- uniform random play (Nash equilibrium).
* "predictive" -- adaptive blend of frequency counting, a first-order
  Markov chain, anti-counter play on losing streaks, and random noise.

Strategies are small, side-effect-free functions in _STRATEGIES, so new
ones (e.g. a trained classifier) can be added and swapped in easily.
"""

from __future__ import annotations

import random
from collections import Counter, deque
from typing import Optional

# ---------------------------------------------------------------------------
# Game constants
# ---------------------------------------------------------------------------

#: The three valid moves recognised by the game.
VALID_MOVES: tuple[str, str, str] = ("rock", "paper", "scissors")

#: Maps a move to the move that *beats* it, e.g. ``COUNTER_MOVES['rock']``
#: is ``'paper'`` because paper beats rock. Used to pick the AI's move once
#: we've decided (or guessed) what the player is about to throw.
COUNTER_MOVES: dict[str, str] = {
    "rock": "paper",
    "paper": "scissors",
    "scissors": "rock",
}

#: Maps each move to the move it *beats* (the inverse of COUNTER_MOVES).
#: Used by :func:`calculate_winner` to decide who won a round.
BEATS: dict[str, str] = {
    "rock": "scissors",
    "scissors": "paper",
    "paper": "rock",
}

#: How many of the player's most recent moves to remember. A small window
#: keeps the AI reactive to the player's *current* pattern rather than
#: getting "stuck" on habits from much earlier in a long play session.
HISTORY_LENGTH: int = 10

#: The available AI modes. Each maps to a strategy name (see the module
#: docstring). The mode can be changed at runtime via :func:`set_difficulty`
#: (called from the ``/set_difficulty`` Flask route).
#:
#: * ``random``     -- plays uniformly at random (Nash equilibrium).
#: * ``predictive`` -- the full adaptive blend (frequency + Markov +
#:   anti-counter play + noise), i.e. the AI actively tries to predict
#:   and counter the player.
DIFFICULTY_LEVELS: dict[str, str] = {
    "predictive": "adaptive",
    "random": "random",
}

#: Default mode used when the server starts. Can be overridden via
#: the ``RPS_DIFFICULTY`` environment variable.
DEFAULT_DIFFICULTY: str = "predictive"

#: Exponential decay factor used by the frequency strategy. Each move in
#: history contributes ``DECAY ** age`` to its count, so a move played 5
#: rounds ago counts ~60% as much as one played this round.
DECAY: float = 0.85

#: Probability that the "adaptive" strategy falls back to a uniformly
#: random move on any given round, to stay unpredictable.
ADAPTIVE_RANDOM_PROB: float = 0.15

# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------
# Process-global state: fine for this single-player local demo. If this
# ever supports multiple simultaneous players, move the history into a
# per-session object instead.

#: Rolling history of the player's last ``HISTORY_LENGTH`` valid moves.
#: Newest moves are appended to the right; once full, the oldest move
#: (leftmost) is automatically discarded by the ``deque``'s ``maxlen``.
player_move_history: "deque[str]" = deque(maxlen=HISTORY_LENGTH)

#: Rolling history of round outcomes (``'player'``, ``'ai'``, or ``'tie'``)
#: so strategies can react to win/loss streaks. Capped at the same length
#: as the move history for consistency.
round_outcome_history: "deque[str]" = deque(maxlen=HISTORY_LENGTH)

#: Current AI mode (one of the keys of :data:`DIFFICULTY_LEVELS`).
#: Mutated by :func:`set_difficulty`.
_current_difficulty: str = DEFAULT_DIFFICULTY


def reset_history() -> None:
    """Clear move/outcome history (call when a new game session starts)."""
    player_move_history.clear()
    round_outcome_history.clear()


def set_difficulty(level: str) -> str:
    """Switch the AI's mode ('predictive' or 'random', case-insensitive).

    Raises ValueError on unknown modes. Returns the normalised name."""
    global _current_difficulty
    normalised = (level or "").strip().lower()
    if normalised not in DIFFICULTY_LEVELS:
        raise ValueError(
            f"Unknown difficulty '{level}'. Expected one of: "
            f"{', '.join(DIFFICULTY_LEVELS)}."
        )
    _current_difficulty = normalised
    return _current_difficulty


def get_difficulty() -> str:
    """Return the current AI mode (one of :data:`DIFFICULTY_LEVELS`'s keys)."""
    return _current_difficulty


def get_stats() -> dict:
    """Snapshot of the AI's state for the frontend's insight panel."""
    history_list = list(player_move_history)
    outcomes_list = list(round_outcome_history)

    # Recency-weighted frequency counts, matching the frequency strategy.
    weighted_counts = {move: 0.0 for move in VALID_MOVES}
    for idx, move in enumerate(reversed(history_list)):
        if move in weighted_counts:
            weighted_counts[move] += DECAY ** idx

    total_weighted = sum(weighted_counts.values())
    predicted = _frequency_predict()

    return {
        "difficulty": _current_difficulty,
        "strategy": DIFFICULTY_LEVELS[_current_difficulty],
        "history": history_list,
        "outcomes": outcomes_list,
        "weighted_counts": weighted_counts,
        "predicted_next_move": predicted,
        "player_win_rate": (
            outcomes_list.count("player") / len(outcomes_list)
            if outcomes_list
            else None
        ),
        "ai_win_rate": (
            outcomes_list.count("ai") / len(outcomes_list)
            if outcomes_list
            else None
        ),
        "tie_rate": (
            outcomes_list.count("tie") / len(outcomes_list)
            if outcomes_list
            else None
        ),
        "total_weighted": total_weighted,
    }


def calculate_winner(player_choice: str, cpu_choice: str) -> str:
    """Return 'tie', 'player', or 'ai' for a round.

    An unrecognised player choice (e.g. an ambiguous gesture) counts as
    a win for the AI, since no valid move was thrown."""
    if player_choice == cpu_choice:
        return "tie"
    return "player" if BEATS.get(player_choice) == cpu_choice else "ai"


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------
# Each strategy is a small function that returns the move the AI should
# play this round, given the current history. They are deliberately
# side-effect free (they don't mutate the history) so the orchestrator
# :func:`determine_ai_move` can update the history exactly once and then
# try multiple strategies if needed (e.g. for the adaptive blend).


def _random_strategy() -> str:
    """Uniform random play -- the Nash equilibrium, impossible to exploit."""
    return random.choice(VALID_MOVES)


def _frequency_predict() -> Optional[str]:
    """Predict the player's next move via recency-weighted frequency.

    Each historical move contributes DECAY**age to its score. Returns
    None when there's no history yet."""
    if not player_move_history:
        return None

    weighted = {move: 0.0 for move in VALID_MOVES}
    for idx, move in enumerate(reversed(player_move_history)):
        if move in weighted:
            weighted[move] += DECAY ** idx

    if sum(weighted.values()) == 0:
        return None
    return max(weighted, key=weighted.get)


def _frequency_strategy() -> str:
    """Counter the player's most-frequent recent move (with decay)."""
    predicted = _frequency_predict()
    if predicted is None:
        return _random_strategy()
    return COUNTER_MOVES[predicted]


def _markov_predict() -> Optional[str]:
    """Predict the player's next move via a first-order Markov chain.

    Counts how often each move followed the player's last move in
    history. Returns None with fewer than 2 moves of history."""
    history = list(player_move_history)
    if len(history) < 2:
        return None

    # Build the transition counts: transitions[last_move][next_move] = count
    transitions: dict[str, Counter] = {m: Counter() for m in VALID_MOVES}
    for prev, nxt in zip(history, history[1:]):
        if prev in transitions and nxt in VALID_MOVES:
            transitions[prev][nxt] += 1

    last_move = history[-1]
    next_moves = transitions.get(last_move)
    if not next_moves:
        return None

    # Most common transition out of the last move.
    return next_moves.most_common(1)[0][0]


def _markov_strategy() -> str:
    """Counter the player's most-likely next move based on transition patterns."""
    predicted = _markov_predict()
    if predicted is None:
        # Not enough transition data yet -- fall back to frequency.
        return _frequency_strategy()
    return COUNTER_MOVES[predicted]


def _adaptive_strategy() -> str:
    """Blend frequency + Markov with anti-counter play and random noise.

    Uses the strongest available prediction (Markov, else frequency),
    but plays randomly with probability ADAPTIVE_RANDOM_PROB so the
    pattern can't be exploited. If the player is on a winning streak
    they're probably counter-predicting us, so we play our predicted
    move instead of its counter."""
    # Random noise round -- stay unpredictable.
    if random.random() < ADAPTIVE_RANDOM_PROB:
        return _random_strategy()

    # If the player has been winning heavily in the last few rounds,
    # they're likely counter-predicting us. Switch to "anti-counter":
    # play the move that beats the move that beats our predicted play.
    recent = list(round_outcome_history)[-5:]
    if recent.count("player") >= 3:
        # Play our predicted move: it ties their predicted throw and
        # beats the counter they were likely expecting.
        predicted = _markov_predict() or _frequency_predict()
        if predicted:
            return predicted
        return _random_strategy()

    # Default: prefer Markov (richer signal) when available.
    predicted = _markov_predict()
    if predicted:
        return COUNTER_MOVES[predicted]
    return _frequency_strategy()


#: Dispatch table mapping strategy name -> strategy function.
_STRATEGIES = {
    "random": _random_strategy,
    "frequency": _frequency_strategy,
    "markov": _markov_strategy,
    "adaptive": _adaptive_strategy,
}


def _pick_ai_move() -> str:
    """Run the currently-selected strategy and return the AI's move."""
    strategy_name = DIFFICULTY_LEVELS.get(_current_difficulty, "adaptive")
    strategy_fn = _STRATEGIES.get(strategy_name, _adaptive_strategy)
    move = strategy_fn()
    # Defensive: never let a strategy return something invalid.
    if move not in VALID_MOVES:
        move = _random_strategy()
    return move


def determine_ai_move(player_move: str, game_history: Optional[list] = None) -> dict:
    """Choose the AI's move for this round and judge the winner.

    Main entry point for the /play_round route. Records the player's
    move in the rolling history, runs the current strategy, compares
    against the player's actual move, and stores the outcome so the
    adaptive strategy can react to streaks.

    Args:
        player_move: The detected move ('rock'/'paper'/'scissors').
            Anything else (e.g. 'wait') leaves the history unchanged.
        game_history: Reserved for future strategies; unused.

    Returns:
        dict with 'ai_move', 'winner', 'difficulty', and 'logs' (debug
        info about how the decision was reached).
    """
    logs: dict = {"difficulty": _current_difficulty}

    # 1. Record the player's move (ignoring junk like 'wait').
    if player_move in VALID_MOVES:
        player_move_history.append(player_move)
        logs["history"] = list(player_move_history)
    else:
        logs["history_note"] = (
            f"'{player_move}' is not a valid move; history left unchanged."
        )

    # 2. Pick the AI's move using the currently-selected strategy.
    ai_move = _pick_ai_move()
    strategy_name = DIFFICULTY_LEVELS.get(_current_difficulty, "adaptive")
    logs["strategy"] = strategy_name

    # Log the predictions used so the decision is explainable.
    freq_pred = _frequency_predict()
    markov_pred = _markov_predict()
    if freq_pred:
        logs["frequency_prediction"] = freq_pred
    if markov_pred:
        logs["markov_prediction"] = markov_pred

    # 3. Compare the player's *actual* move this round to the AI's move.
    winner = calculate_winner(player_move, ai_move)
    logs["winner"] = winner

    # 4. Record the outcome for streak-aware play.
    if player_move in VALID_MOVES:
        round_outcome_history.append(winner)

    return {
        "ai_move": ai_move,
        "winner": winner,
        "difficulty": _current_difficulty,
        "logs": logs,
    }