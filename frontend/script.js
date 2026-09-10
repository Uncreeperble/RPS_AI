/**
 * script.js
 * ==========
 * Frontend game logic for Rock · Paper · Scissors AI.
 *
 * Sections:
 *   1. DOM references & configuration constants
 *   2. Theme + sound + help panel (UI preferences)
 *   3. Difficulty selector (talks to /set_difficulty)
 *   4. AI Insight panel (talks to /ai_stats)
 *   5. Webcam lifecycle (start/stop) + Quick Play (no camera)
 *   6. Frame capture + backend polling loop
 *   7. Gesture stability & "shake to throw" detection
 *   8. The status banner (the ONE place all announcements live)
 *   9. Game state machine (wait -> ready -> countdown -> playing)
 *  10. Backend communication (play a round / reset match)
 *  11. UI rendering helpers (scoreboard, history log, highlights, sound)
 *
 * High-level flow
 * ----------------
 * The browser owns the *game state machine* (are we waiting for a rock,
 * counting down, mid-round, etc). The Python backend owns the *computer
 * vision* (what gesture is the camera currently seeing?) and the *AI
 * opponent logic* (what should the computer play, who won?). Every
 * animation frame, this script grabs a still frame from the webcam,
 * ships it to `/process_frame`, and reacts to the gesture that comes
 * back. Once a full "scissors-paper-rock" countdown completes, it POSTs
 * the player's final move to `/play_round` and displays the result.
 *
 * IMPORTANT: every code path that can start a round (the webcam
 * countdown AND the Quick Play buttons) funnels through the single
 * `playGame()` function, which *always* re-validates that the move is
 * actually 'rock', 'paper', or 'scissors' before contacting the
 * backend. This guards against the classic "You played undefined" bug,
 * which happened when a noisy/ambiguous camera frame let a non-move
 * (e.g. 'wait') slip through to the AI on the final countdown beat.
 */

document.addEventListener('DOMContentLoaded', () => {

	// =========================================================
	// 1. DOM references & configuration constants
	// =========================================================
	const startButton = document.getElementById('start-webcam');
	const stopButton = document.getElementById('stop-webcam');
	const resetButton = document.getElementById('reset-match');
	const videoFeed = document.getElementById('webcam-feed');
	const overlayContainer = document.getElementById('overlay-container');
	const idlePlaceholder = document.getElementById('player-idle-placeholder');
	const gameControls = document.getElementById('game-controls');

	const allLights = document.querySelectorAll('.traffic-light .light');
	const aiBox = document.getElementById('ai-box');
	const aiContent = document.getElementById('ai-content');
	const playerBox = document.getElementById('player-box');

	const playerMoveOverlay = document.getElementById('player-move-overlay');
	const playerMoveOverlayLabel = document.getElementById('player-move-overlay-label');
	const playerMoveOverlayEmoji = document.getElementById('player-move-overlay-emoji');

	const playerWinsEl = document.querySelector('#player-wins .stat-value');
	const aiWinsEl = document.querySelector('#ai-wins .stat-value');
	const gameCountEl = document.querySelector('#game-count .stat-value');
	const historyList = document.getElementById('history-list');

	const statusBanner = document.getElementById('status-banner');
	const statusIcon = document.getElementById('status-icon');
	const statusText = document.getElementById('status-text');

	const helpBtn = document.getElementById('help-btn');
	const closeHelpBtn = document.getElementById('close-help-btn');
	const helpPanel = document.getElementById('help-panel');
	const muteBtn = document.getElementById('mute-btn');
	const themeBtn = document.getElementById('theme-btn');

	const quickPlayButtons = document.querySelectorAll('.quick-play-btn');
	const diffButtons = document.querySelectorAll('.diff-btn');

	// Training review panel elements
	const trainingReview = document.getElementById('training-review');
	const trainingFrameImg = document.getElementById('training-frame');
	const trainingDetectedEl = document.getElementById('training-detected');
	const trainingConfirmBtn = document.getElementById('training-confirm');
	const trainingSkipBtn = document.getElementById('training-skip');
	const trainingRelabelBtns = document.querySelectorAll('.training-btn.relabel');
	const trainingLog = document.getElementById('training-log');
	const queueCountEl = document.getElementById('training-queue-count');
	const trainingCarousel = document.getElementById('training-carousel');
	const trainingCarouselCount = document.getElementById('training-carousel-count');
	const trainingPrevBtn = document.getElementById('training-prev');
	const trainingNextBtn = document.getElementById('training-next');

	// AI Insight panel elements
	const insightStrategy = document.getElementById('insight-strategy');
	const insightPrediction = document.getElementById('insight-prediction');
	const insightWinRate = document.getElementById('insight-winrate');
	const insightBarRows = document.querySelectorAll('.insight-bar-row');

	// The three real moves the game understands. Used repeatedly to
	// validate input coming from the (sometimes noisy) camera pipeline.
	const VALID_MOVES = ['rock', 'paper', 'scissors'];

	// Emoji + display name for each move, reused all over the UI (AI
	// reveal, history log, announcements, "How to play" instructions).
	const MOVE_EMOJI = { rock: '✊', paper: '✋', scissors: '✌️', no_move: '🚫' };
	const MOVE_NAME = { rock: 'Rock', paper: 'Paper', scissors: 'Scissors', no_move: 'No Move' };

	// What each move beats, and the "verb" used to describe that win,
	// e.g. "Rock crushes Scissors". Used to build a human-readable
	// explanation of the round result for the big announcement banner.
	const BEATS_VERB = {
		rock: 'crushes',      // rock crushes scissors
		paper: 'covers',      // paper covers rock
		scissors: 'cuts',     // scissors cuts paper
	};

	// Friendly labels for the AI strategies (returned by /ai_stats).
	const STRATEGY_LABELS = {
		random: 'Random 🎲',
		adaptive: 'Predictive 🧠',
		frequency: 'Frequency 📊',
		markov: 'Markov 🔗',
	};

	// --- Game score state ---
	let playerWins = 0;
	let aiWins = 0;
	let gamesPlayed = 0;

	// --- Webcam / media stream state ---
	let currentStream = null;

	// --- Game state machine ---
	// 'wait'           -> idle, watching for the player to show a rock
	// 'ready_to_start' -> rock seen; waiting for a "shake" to begin the countdown
	// 'countdown'      -> playing the "scissors, paper, rock" beat sequence
	// 'playing'        -> round is being resolved with the backend
	let gameStage = 'wait';
	let isActionInProgress = false;  // Is the hand "shaking" right now?
	let lastDetectedMove = 'wait';   // Most recent single-frame gesture
	let currentStableState = 'wait'; // Debounced/lingered gesture (much less noisy)

	// --- Gesture stability config ---
	// Raw per-frame gesture classification is noisy, so we only trust a
	// gesture once it has been the majority result over a short rolling
	// time window.
	const stateHistory = [];
	const yHistory = []; // Recent hand vertical positions, for shake detection
	const STABLE_STATE_WINDOW_MS = 500;      // Rolling window length
	const STABILITY_THRESHOLD_PERCENT = 0.7; // % of frames that must agree
	const Y_MOVEMENT_THRESHOLD = 0.05;       // Normalised Y deviation = a "shake"

	// --- Pose lingering ---
	// Hand detection occasionally fails for a few frames in a row (motion
	// blur, a marginal angle, a brief lighting change) even though the
	// player's hand hasn't actually moved. To keep the UI from jittering
	// between a pose and "no gesture", the last stable pose *lingers* for
	// POSE_LINGER_MS after detection drops. If the hand is genuinely
	// removed from the frame, the pose decays back to 'wait' once the
	// linger window expires -- so a real "hand gone" is still recognised,
	// just with a short grace period.
	let lastStablePose = null;   // Last stable non-'wait' gesture seen
	let lastStablePoseTime = 0;  // When it was last confidently seen
	const POSE_LINGER_MS = 1200;

	// --- Countdown timing ---
	// A short "Get Ready" pause happens first (so the countdown doesn't
	// feel like it ambushes the player the instant they shake), then each
	// beat (Scissors / Paper / Rock!) is spaced out at COUNTDOWN_STEP_MS.
	const GET_READY_DELAY_MS = 700;
	const COUNTDOWN_STEP_MS = 900;

	// How long the big result announcement + AI-on-player overlay stay
	// visible before the game resets for the next round.
	const RESULT_DISPLAY_MS = 3200;

	// --- Frame capture config ---
	// A smaller capture resolution + lower JPEG quality keeps each
	// request small and fast, which matters since we're sending frames
	// continuously in a tight loop.
	const CAPTURE_WIDTH = 320;
	const CAPTURE_HEIGHT = 240;
	const JPEG_QUALITY = 0.5;

	// A single reusable off-screen canvas used to grab frames from <video>.
	const captureCanvas = document.createElement('canvas');

	// A separate canvas for capturing training snapshots, so grabbing a
	// frame for labelling never races with the live detection loop's use
	// of `captureCanvas`.
	const trainingCanvas = document.createElement('canvas');

	// Queue of frames awaiting a training-label decision. Each entry is
	// { image: dataURL, detected: move }. If the player starts another
	// round before confirming, the new frame is queued behind the old one
	// instead of overwriting it, so no training data is silently lost.
	let trainingQueue = [];

	// The backend doesn't detect a hand on literally every single frame
	// (a blink, a slightly-off angle, network jitter, etc.), which would
	// otherwise make the skeleton overlay flicker on/off constantly. We
	// only clear it after a few consecutive "no hand" frames, so brief
	// misses don't cause visible flicker.
	let framesWithoutHand = 0;
	const MAX_FRAMES_WITHOUT_HAND = 8;

	// --- AI Insight refresh ---
	// We poll /ai_stats on a slow interval (and immediately after each
	// round) so the panel stays in sync without spamming the server.
	const AI_STATS_INTERVAL_MS = 4000;
	let aiStatsTimer = null;


	// =========================================================
	// 2. Theme + sound + help panel (UI preferences)
	// =========================================================
	const THEME_KEY = 'rps-theme';
	const SOUND_KEY = 'rps-sound';

	// --- Theme ---
	function applyTheme(theme) {
		const isLight = theme === 'light';
		document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark');
		themeBtn.textContent = isLight ? '☀️' : '🌙';
		themeBtn.title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
	}

	function initTheme() {
		let saved = null;
		try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
		if (saved === 'light' || saved === 'dark') {
			applyTheme(saved);
		} else {
			// Default to dark, but respect prefers-color-scheme if available.
			const prefersLight = window.matchMedia
				&& window.matchMedia('(prefers-color-scheme: light)').matches;
			applyTheme(prefersLight ? 'light' : 'dark');
		}
	}

	themeBtn.addEventListener('click', () => {
		const current = document.documentElement.getAttribute('data-theme');
		const next = current === 'light' ? 'dark' : 'light';
		applyTheme(next);
		try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
	});

	initTheme();

	// --- Sound effects (tiny WebAudio beeps, no external audio files needed) ---
	let soundEnabled = true;
	let audioCtx = null;

	// Restore mute preference.
	try {
		if (localStorage.getItem(SOUND_KEY) === 'muted') {
			soundEnabled = false;
			muteBtn.textContent = '🔇';
			muteBtn.title = 'Unmute sound';
		}
	} catch (e) { /* ignore */ }

	/** Lazily create the AudioContext (browsers require a user gesture first). */
	function getAudioContext() {
		if (!audioCtx) {
			const AudioContextClass = window.AudioContext || window.webkitAudioContext;
			audioCtx = new AudioContextClass();
		}
		return audioCtx;
	}

	/**
	 * Play a short beep tone.
	 * @param {number} frequency - Tone pitch in Hz.
	 * @param {number} durationMs - How long the tone should last.
	 */
	function playTone(frequency, durationMs = 120) {
		if (!soundEnabled) return;
		try {
			const ctx = getAudioContext();
			const oscillator = ctx.createOscillator();
			const gain = ctx.createGain();
			oscillator.type = 'sine';
			oscillator.frequency.value = frequency;
			gain.gain.setValueAtTime(0.15, ctx.currentTime);
			gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
			oscillator.connect(gain);
			gain.connect(ctx.destination);
			oscillator.start();
			oscillator.stop(ctx.currentTime + durationMs / 1000);
		} catch (err) {
			// Audio is a "nice to have" -- never let it break gameplay.
			console.warn('Could not play sound:', err);
		}
	}

	const SOUND = {
		countdownBeat: () => playTone(440, 100),
		win: () => { playTone(660, 120); setTimeout(() => playTone(880, 160), 120); },
		lose: () => { playTone(220, 200); },
		tie: () => playTone(330, 150),
		click: () => playTone(520, 60),
	};

	muteBtn.addEventListener('click', () => {
		soundEnabled = !soundEnabled;
		muteBtn.textContent = soundEnabled ? '🔊' : '🔇';
		muteBtn.title = soundEnabled ? 'Mute sound' : 'Unmute sound';
		try { localStorage.setItem(SOUND_KEY, soundEnabled ? 'on' : 'muted'); } catch (e) { /* ignore */ }
	});

	// --- Training review panel ---
	// After each webcam round, the exact frame the final move was detected
	// on is shown under the game. The player confirms the label (or picks
	// the correct one if the detection was wrong/unclear), and the frame
	// is saved to the backend's labelled training-data folder. Frames the
	// player hasn't judged yet *queue up*, so playing more rounds without
	// confirming never loses training data.
	trainingConfirmBtn.addEventListener('click', () => {
		decideTrainingFrame('detected');
	});

	trainingRelabelBtns.forEach((btn) => {
		btn.addEventListener('click', () => {
			decideTrainingFrame(btn.dataset.label);
		});
	});

	trainingSkipBtn.addEventListener('click', () => {
		// "No Move": the hand wasn't actually in frame (or the gesture was
		// unclear). Save the frame as a negative example, then show the
		// next queued one (if any).
		decideTrainingFrame('no_move');
	});

	/** Queue a captured frame for labelling and update the review panel. */
	function enqueueTrainingReview(imageData, detected) {
		trainingQueue.push({ image: imageData, detected });
		showNextTrainingReview();
	}

	/** Show the oldest queued frame, or hide the panel if none remain. */
	function showNextTrainingReview() {
		const item = trainingQueue[0];
		if (!item) {
			trainingReview.hidden = true;
			return;
		}
		trainingFrameImg.src = item.image;
		trainingDetectedEl.textContent = `${MOVE_EMOJI[item.detected] || '❓'} ${MOVE_NAME[item.detected] || 'Unknown'}`;
		// "✓ Correct — Save" only makes sense when a move was actually
		// detected; for unknown/no-move frames the player picks the real
		// label (or marks it as No Move) instead.
		trainingConfirmBtn.hidden = !VALID_MOVES.includes(item.detected);
		// Surface how many frames are waiting to be judged.
		trainingReview.classList.toggle('has-queue', trainingQueue.length > 1);
		queueCountEl.textContent = trainingQueue.length;
		document.getElementById('training-queue-badge').hidden = trainingQueue.length <= 1;
		setTrainingButtonsEnabled(true);
		trainingReview.hidden = false;
	}

	/**
	 * Resolve the currently-shown frame with a label: 'detected' means the
	 * player agreed with the automatic detection; anything else is the
	 * move the player says it actually was.
	 */
	function decideTrainingFrame(labelOrDetected) {
		const item = trainingQueue[0];
		if (!item) return;
		const label = labelOrDetected === 'detected' ? item.detected : labelOrDetected;
		trainingQueue.shift();
		saveTrainingImage(item, label);
		showNextTrainingReview();
	}

	/** Grab the current webcam frame (mirrored, same as the live loop). */
	function captureTrainingFrame() {
		if (!currentStream || videoFeed.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
			videoFeed.videoWidth === 0 || videoFeed.videoHeight === 0) {
			return null;
		}
		trainingCanvas.width = CAPTURE_WIDTH;
		trainingCanvas.height = CAPTURE_HEIGHT;
		const ctx = trainingCanvas.getContext('2d');
		// Mirror to match what the player sees (and what the detector saw).
		ctx.translate(trainingCanvas.width, 0);
		ctx.scale(-1, 1);
		ctx.drawImage(videoFeed, 0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT);
		return trainingCanvas.toDataURL('image/jpeg', 0.7);
	}

	function hideTrainingReview() {
		trainingQueue.length = 0;
		trainingReview.hidden = true;
	}

	function setTrainingButtonsEnabled(enabled) {
		trainingConfirmBtn.disabled = !enabled;
		trainingSkipBtn.disabled = !enabled;
		trainingRelabelBtns.forEach((b) => { b.disabled = !enabled; });
	}

	/** True when the frame's original detection was a real (wrong) move. */
	function wasMislabelled(item, label) {
		return VALID_MOVES.includes(item.detected) && item.detected !== label;
	}

	/** POST the confirmed frame + label to the backend's training store. */
	async function saveTrainingImage(item, label) {
		const { image, detected } = item;
		setTrainingButtonsEnabled(false);
		try {
			const resp = await fetch('/save_training_image', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ image, label, detected }),
			});
			if (!resp.ok) {
				const body = await resp.json().catch(() => ({}));
				console.warn('Could not save training image:', body.error || resp.status);
			} else {
				SOUND.click();
				// Keep the saved frame visible in the compact log: a small
				// thumbnail with the TRUE label stamped on top, plus the
				// ORIGINAL detection in red when the player corrected it.
				// (The backend also encodes this in the filename as
				// "..._was-<detected>", so a training script can down-weight
				// these likely edge-case images.)
				appendToTrainingLog(image, label, detected);
			}
		} catch (err) {
			console.warn('Could not reach /save_training_image:', err);
		}
	}

	/**
	 * Build a compact log chip: the true (human-confirmed) label stamped
	 * over the image, plus the original detection in red underneath when
	 * the player corrected it.
	 */
	function createTrainingChip(imageSrc, label, detected) {
		const wasCorrected = VALID_MOVES.includes(detected) && detected !== label;
		const chip = document.createElement('div');
		chip.className = 'training-chip' + (wasCorrected ? ' corrected' : '');
		chip.title = wasCorrected
			? `True: ${MOVE_NAME[label]} · originally detected: ${MOVE_NAME[detected]}`
			: `Labelled as ${MOVE_NAME[label] || label}`;
		chip.innerHTML =
			`<img src="${imageSrc}" alt="${MOVE_NAME[label] || label} training frame">` +
			`<span class="training-chip-label">` +
			`<span class="true-label">${MOVE_EMOJI[label] || ''} ${MOVE_NAME[label] || label}</span>` +
			(wasCorrected
				? `<span class="orig-label">was ${MOVE_EMOJI[detected] || ''} ${MOVE_NAME[detected] || detected}</span>`
				: '') +
			`</span>`;
		return chip;
	}

	/** Add a newly-saved frame to the front of the carousel. */
	function appendToTrainingLog(imageData, label, detected) {
		trainingLog.prepend(createTrainingChip(imageData, label, detected));
		updateTrainingCarousel();
	}

	/**
	 * Load previously saved training images from the backend into the
	 * carousel on page load, so existing examples are visible (and
	 * reusable) without recording new ones.
	 */
	async function loadExistingTrainingImages() {
		try {
			const resp = await fetch('/training_images');
			if (!resp.ok) return;
			const data = await resp.json();
			const images = data.images || [];
			// Oldest-to-newest so the newest ends up on the left.
			for (const item of images) {
				trainingLog.appendChild(
					createTrainingChip(item.url, item.label, item.detected)
				);
			}
			updateTrainingCarousel();
		} catch (err) {
			console.warn('Could not load existing training images:', err);
		}
	}

	// --- Carousel paging ---
	// The strip scrolls horizontally; the arrows nudge it by one
	// "page" of chips and are hidden when there's nothing to scroll.
	const CAROUSEL_PAGE_CHIPS = 4;

	function updateTrainingCarousel() {
		const count = trainingLog.children.length;
		trainingCarousel.hidden = count === 0;
		trainingCarouselCount.textContent = `${count} frame${count === 1 ? '' : 's'}`;
		updateCarouselArrows();
	}

	function updateCarouselArrows() {
		const canScroll = trainingLog.scrollWidth > trainingLog.clientWidth + 4;
		const atStart = trainingLog.scrollLeft <= 4;
		const atEnd =
			trainingLog.scrollLeft + trainingLog.clientWidth >= trainingLog.scrollWidth - 4;
		trainingPrevBtn.hidden = !canScroll || atStart;
		trainingNextBtn.hidden = !canScroll || atEnd;
	}

	function scrollTrainingCarousel(direction) {
		const chip = trainingLog.querySelector('.training-chip');
		const chipWidth = chip ? chip.offsetWidth + 6 : 90;
		trainingLog.scrollBy({
			left: direction * chipWidth * CAROUSEL_PAGE_CHIPS,
			behavior: 'smooth',
		});
	}

	trainingPrevBtn.addEventListener('click', () => {
		SOUND.click();
		scrollTrainingCarousel(-1);
	});
	trainingNextBtn.addEventListener('click', () => {
		SOUND.click();
		scrollTrainingCarousel(1);
	});
	trainingLog.addEventListener('scroll', updateCarouselArrows, { passive: true });
	window.addEventListener('resize', updateCarouselArrows);

	// --- Help panel toggle ---
	helpBtn.addEventListener('click', () => {
		helpPanel.hidden = !helpPanel.hidden;
		if (!helpPanel.hidden) SOUND.click();
	});
	closeHelpBtn.addEventListener('click', () => { helpPanel.hidden = true; });


	// =========================================================
	// 3. Difficulty selector (talks to /set_difficulty)
	// =========================================================
	diffButtons.forEach((btn) => {
		btn.addEventListener('click', async () => {
			const level = btn.dataset.difficulty;
			if (!level) return;
			// Optimistic UI update: highlight the clicked button immediately.
			diffButtons.forEach((b) => b.classList.remove('active'));
			btn.classList.add('active');
			SOUND.click();
			try {
				const resp = await fetch('/set_difficulty', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ difficulty: level }),
				});
				if (!resp.ok) {
					const body = await resp.json().catch(() => ({}));
					console.warn('Failed to set difficulty:', body.error || resp.status);
					// Revert to whatever the server reports on failure.
					refreshAiStats();
					return;
				}
				refreshAiStats();
			} catch (err) {
				console.warn('Could not reach /set_difficulty:', err);
			}
		});
	});


	// =========================================================
	// 4. AI Insight panel (talks to /ai_stats)
	// =========================================================

	/**
	 * Pull a fresh snapshot of the AI's internal state from /ai_stats and
	 * re-render the insight panel. Called on a slow timer and after each
	 * round / difficulty change.
	 */
	async function refreshAiStats() {
		try {
			const resp = await fetch('/ai_stats');
			if (!resp.ok) return;
			const data = await resp.json();
			renderAiInsight(data);
			syncDifficultyButtons(data.difficulty, data.strategy);
		} catch (err) {
			// Silent failure -- the panel is a "nice to have".
			console.warn('Could not refresh AI stats:', err);
		}
	}

	/**
	 * Render the AI insight panel from a /ai_stats response.
	 * @param {object} data - The JSON returned by /ai_stats.
	 */
	function renderAiInsight(data) {
		// Strategy name (e.g. "frequency" -> "Frequency 📊")
		const strat = data.strategy ? STRATEGY_LABELS[data.strategy] || data.strategy : '—';
		insightStrategy.textContent = strat;

		// Predicted next move (e.g. "rock" -> "✊ Rock")
		if (data.predicted_next_move && MOVE_NAME[data.predicted_next_move]) {
			insightPrediction.textContent = `${MOVE_EMOJI[data.predicted_next_move]} ${MOVE_NAME[data.predicted_next_move]}`;
		} else {
			insightPrediction.textContent = '—';
		}

		// Player win rate
		if (data.player_win_rate !== null && data.player_win_rate !== undefined) {
			const pct = Math.round(data.player_win_rate * 100);
			insightWinRate.textContent = `${pct}% (${data.outcomes.length} rounds)`;
		} else {
			insightWinRate.textContent = '—';
		}

		// Recency-weighted move frequency bars.
		const counts = data.weighted_counts || {};
		const total = data.total_weighted || 0;
		insightBarRows.forEach((row) => {
			const move = row.dataset.move;
			const value = counts[move] || 0;
			const pct = total > 0 ? (value / total) * 100 : 0;
			const fill = row.querySelector('.insight-bar-fill');
			const pctLabel = row.querySelector('.insight-bar-pct');
			if (fill) fill.style.width = `${pct.toFixed(1)}%`;
			if (pctLabel) pctLabel.textContent = `${Math.round(pct)}%`;
		});
	}

	/** Sync the difficulty button highlight to whatever the server reports. */
	function syncDifficultyButtons(difficulty, _strategy) {
		diffButtons.forEach((b) => {
			b.classList.toggle('active', b.dataset.difficulty === difficulty);
		});
	}

	// Start the slow AI stats polling timer.
	aiStatsTimer = setInterval(refreshAiStats, AI_STATS_INTERVAL_MS);
	// And do an immediate fetch on startup so the panel isn't empty.
	refreshAiStats();


	// =========================================================
	// 5. Webcam lifecycle
	// =========================================================
	startButton.addEventListener('click', startWebcam);
	stopButton.addEventListener('click', stopWebcam);
	resetButton.addEventListener('click', resetMatch);

	/**
	 * Request webcam access and start the capture/processing loop.
	 * Shows a friendly alert if the browser denies/lacks camera access.
	 */
	async function startWebcam() {
		// Reset any previous error state and tell the user we're working
		// on it -- this also makes the click feel responsive even though
		// the browser's permission prompt can take a moment.
		setStatusBanner('📷', 'Requesting camera access...', { tone: 'info' });

		if (currentStream) {
			currentStream.getTracks().forEach((track) => track.stop());
			currentStream = null;
		}

		// Feature-detect the camera API. Older browsers (and insecure
		// origins) won't have navigator.mediaDevices at all.
		if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
			console.error('getUserMedia is not supported in this browser/origin.');
			setStatusBanner(
				'📷',
				'Camera not supported here. Use a modern browser on localhost or HTTPS, or use Quick Play below.',
				{ tone: 'error', big: true }
			);
			return;
		}

		try {
			const constraints = {
				video: {
					width: { ideal: 1280 },
					height: { ideal: 720 },
					facingMode: 'user',
				},
				audio: false,
			};
			const stream = await navigator.mediaDevices.getUserMedia(constraints);
			currentStream = stream;
			videoFeed.srcObject = stream;

			// Explicitly un-hide the <video> *before* we ask it to play.
			idlePlaceholder.hidden = true;
			videoFeed.hidden = false;
			gameControls.hidden = false;

			// Register this before calling play(). Otherwise the playing event
			// can fire during await videoFeed.play(), leaving the detector loop
			// permanently stopped.
			let captureStarted = false;
			const startCapture = () => {
				if (captureStarted || !currentStream) return;
				captureStarted = true;
				captureAndProcessFrame();
			};
			videoFeed.onplaying = startCapture;

			// Some browsers won't autoplay a <video> unless you explicitly
			// call play() -- relying on the `autoplay` attribute alone is
			// unreliable once we've set srcObject programmatically.
			try {
				await videoFeed.play();
			} catch (playErr) {
				console.warn('video.play() returned an error (will retry on user gesture):', playErr);
			}

			// Starting a fresh webcam session = a fresh game session, so
			// let the backend forget any previously-observed player moves.
			resetAiMemory();

			// Reset stability/shake tracking so leftover data from a
			// previous session can't cause a false "shake" the instant
			// the new stream starts.
			stateHistory.length = 0;
			yHistory.length = 0;
			framesWithoutHand = 0;
			lastStablePose = null;
			lastStablePoseTime = 0;
			gameStage = 'wait';
			showDetectionStatus('wait');

			// The playing event may have fired before the handler above was
			// attached, or the video may already be ready. In either case,
			// start the loop explicitly.
			if (videoFeed.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !videoFeed.paused) {
				startCapture();
			} else {
				videoFeed.addEventListener('canplay', startCapture, { once: true });
			}

		} catch (error) {
			console.error('Error accessing webcam:', error);
			setStatusBanner('📷', 'Could not access webcam. Use Quick Play below!', { tone: 'error', big: true });
		}
	}

	/** Stop all webcam tracks and return the UI to its idle state. */
	function stopWebcam() {
		if (currentStream) {
			currentStream.getTracks().forEach((track) => track.stop());
			currentStream = null;
		}
		videoFeed.hidden = true;
		videoFeed.srcObject = null;
		idlePlaceholder.hidden = false;
		gameControls.hidden = true;
		overlayContainer.innerHTML = '';
		hidePlayerMoveOverlay();
		hideTrainingReview();

		gameStage = 'wait';
		lastStablePose = null;
		lastStablePoseTime = 0;
		updateTrafficLights('wait');
		setStatusBanner('👋', 'Click "Start Webcam" to begin', { tone: 'info' });
	}


	/** Reset the on-screen scoreboard/history and the backend's AI memory. */
	function resetMatch() {
		playerWins = 0;
		aiWins = 0;
		gamesPlayed = 0;
		updateScores();
		historyList.innerHTML = '<p id="history-placeholder">No games played yet.</p>';
		resetAiMemory();
		refreshAiStats();
		SOUND.click();
	}

	/** Tell the backend to forget the player's move history. */
	function resetAiMemory() {
		fetch('/reset_game', { method: 'POST' }).catch((err) =>
			console.warn('Could not reset AI memory:', err)
		);
	}


	// =========================================================
	// Quick Play (no camera required)
	// =========================================================
	// A simple, always-available way to play a round -- and to quickly
	// confirm the AI/game logic works -- without depending on the webcam
	// or hand-tracking at all. Clicking a button plays exactly the same
	// `playGame()` flow used by the camera-driven countdown, including
	// the same move-validation guard.
	quickPlayButtons.forEach((btn) => {
		btn.addEventListener('click', () => {
			if (gameStage === 'playing') return; // Ignore clicks mid-round.
			SOUND.click();
			playGame(btn.dataset.move);
		});
	});

	/** Enable/disable the Quick Play buttons (e.g. while a round resolves). */
	function setQuickPlayButtonsEnabled(enabled) {
		quickPlayButtons.forEach((btn) => { btn.disabled = !enabled; });
	}


	// =========================================================
	// 6. Frame capture + backend polling loop
	// =========================================================

	/**
	 * Grab a single still frame from the live <video>, send it to the
	 * backend for hand-gesture analysis, react to the result, then
	 * schedule itself again for the next animation frame.
	 *
	 * This function effectively *is* the game's realtime loop while the
	 * webcam is active -- it keeps re-scheduling itself via
	 * requestAnimationFrame until the stream is stopped.
	 */
		function captureAndProcessFrame() {
		if (!currentStream || videoFeed.paused || videoFeed.ended) {
			return; // Webcam stopped -- don't reschedule.
		}

		// Do not send blank frames before the browser has decoded camera data.
		if (videoFeed.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
			videoFeed.videoWidth === 0 || videoFeed.videoHeight === 0) {
			requestAnimationFrame(captureAndProcessFrame);
			return;
		}

		captureCanvas.width = CAPTURE_WIDTH;
		captureCanvas.height = CAPTURE_HEIGHT;
		const context = captureCanvas.getContext('2d');

		// Mirror the frame horizontally so the overlay lines up with the
		// mirrored <video> element (which is flipped via CSS for a more
		// intuitive "looking in a mirror" webcam experience).
		context.translate(captureCanvas.width, 0);
		context.scale(-1, 1);
		context.drawImage(videoFeed, 0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT);

		const imageData = captureCanvas.toDataURL('image/jpeg', JPEG_QUALITY);

		fetch('/process_frame', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ image: imageData }),
		})
			.then((response) => response.json())
			.then(handleFrameResult)
			.catch((error) => console.error('Error processing frame:', error))
			.finally(() => requestAnimationFrame(captureAndProcessFrame));
	}

	/**
	 * Process one backend response for a captured frame: update gesture
	 * stability tracking, shake/"action" detection, the traffic lights,
	 * the hand-skeleton overlay, and advance the game state machine.
	 */
	function handleFrameResult(data) {
		const now = Date.now();

		// --- Gesture stability tracking ---
		stateHistory.push({ state: data.status, timestamp: now });
		const cutoffTime = now - STABLE_STATE_WINDOW_MS;
		while (stateHistory.length > 0 && stateHistory[0].timestamp < cutoffTime) {
			stateHistory.shift();
		}
		const stableState = calculateStableState();
		currentStableState = stableState;

		// --- Hand vertical-movement ("shake") tracking ---
		if (data.hand_mean_y !== null) {
			yHistory.push({ y: data.hand_mean_y, timestamp: now });
		}
		while (yHistory.length > 0 && yHistory[0].timestamp < cutoffTime) {
			yHistory.shift();
		}
		checkHandAction(data.hand_mean_y, stableState);

		lastDetectedMove = data.status;

		// Only reflect live gesture feedback on the lights/banner outside
		// of the countdown/playing phases (during which they're driven by
		// the countdown sequence / round-result logic instead).
		if (gameStage !== 'countdown' && gameStage !== 'playing') {
			updateTrafficLights(stableState);
			showDetectionStatus(stableState);
		}

		// --- Game state machine transitions ---
		// "Hand actually gone" debounce: the pose linger keeps reporting a
		// stale gesture for a short grace period after detection drops, but
		// once the hand has been missing for several consecutive frames it
		// has genuinely left the frame and we must not keep treating the
		// lingering pose as "ready to throw".
		const handGone = data.hand_mean_y === null && framesWithoutHand > 2;

		if (gameStage === 'wait' && stableState === 'rock' && !handGone) {
			gameStage = 'ready_to_start';
			setStatusBanner('✊', 'Rock locked in — shake your hand up/down to throw!', { tone: 'detect' });
		} else if (gameStage === 'ready_to_start' && isActionInProgress && data.hand_mean_y !== null) {
			// Only start the countdown if the hand is *currently* visible --
			// a "shake" inferred from stale tracking data must not trigger it.
			startCountdown();
		} else if (gameStage === 'ready_to_start' && (stableState !== 'rock' || handGone)) {
			// The player lowered/changed their hand before shaking -- go
			// back to plain "waiting" instead of getting stuck.
			gameStage = 'wait';
			if (handGone) {
				// The hand truly left the frame: drop any lingering pose
				// immediately so the UI doesn't keep claiming to see a rock.
				lastStablePose = null;
				setStatusBanner('👋', 'Hand lost — show me your Rock to get ready again', { tone: 'detect' });
			} else {
				showDetectionStatus(stableState);
			}
		}

		// --- Hand skeleton overlay ---
		// Debounced: only clear the overlay after several consecutive
		// "no hand" frames, so a single missed detection doesn't cause it
		// to visibly flicker on and off.
		if (data.overlay_image_base64) {
			framesWithoutHand = 0;
			overlayContainer.innerHTML = `<img src="data:image/png;base64,${data.overlay_image_base64}" alt="" />`;
		} else {
			framesWithoutHand++;
			if (framesWithoutHand > MAX_FRAMES_WITHOUT_HAND) {
				overlayContainer.innerHTML = '';
			}
		}
	}

	/**
	 * Reduce the recent gesture history to a single "stable" state: the
	 * gesture must account for at least STABILITY_THRESHOLD_PERCENT of
	 * frames in the rolling window, otherwise we report 'wait' (i.e. "not
	 * confident enough yet").
	 *
	 * On top of that majority vote, a pose-linger layer is applied: if the
	 * window resolves to 'wait' but a confident pose was seen very
	 * recently, keep reporting that pose for POSE_LINGER_MS. This smooths
	 * over momentary detection dropouts without freezing a stale pose
	 * when the hand truly leaves the frame.
	 */
	function calculateStableState() {
		if (stateHistory.length === 0) return decayLingeringPose();

		const counts = { rock: 0, paper: 0, scissors: 0, wait: 0 };
		for (const entry of stateHistory) {
			if (Object.prototype.hasOwnProperty.call(counts, entry.state)) {
				counts[entry.state]++;
			}
		}

		for (const state in counts) {
			if (state !== 'wait' && counts[state] / stateHistory.length >= STABILITY_THRESHOLD_PERCENT) {
				// A confident pose: remember it and report it immediately.
				lastStablePose = state;
				lastStablePoseTime = Date.now();
				return state;
			}
		}
		return decayLingeringPose();
	}

	/**
	 * Handle a 'wait' resolution from the stability window: linger on the
	 * previous pose briefly (to ride out detection dropouts), then decay
	 * to 'wait' once the linger window has elapsed.
	 */
	function decayLingeringPose() {
		if (lastStablePose && Date.now() - lastStablePoseTime < POSE_LINGER_MS) {
			return lastStablePose;
		}
		lastStablePose = null;
		return 'wait';
	}


	// =========================================================
	// 7. "Shake to throw" detection
	// =========================================================

	/**
	 * Decide whether the player's hand is currently "shaking" -- i.e.
	 * moving noticeably up/down relative to its recent average position.
	 * This is only meaningful while the stable gesture is 'rock' (the
	 * player is expected to hold a rock and shake it to kick off the
	 * countdown, like a real "rock, paper, scissors, shoot!").
	 */
	function checkHandAction(currentY, stableState) {
		if (stableState !== 'rock' || currentY === null || yHistory.length < 3) {
			isActionInProgress = false;
			return;
		}

		const sumY = yHistory.reduce((acc, entry) => acc + entry.y, 0);
		const averageY = sumY / yHistory.length;
		const deviation = Math.abs(currentY - averageY);

		isActionInProgress = deviation > Y_MOVEMENT_THRESHOLD;
	}


	// =========================================================
	// 8. The status banner -- the ONE place all announcements live
	// =========================================================
	// Everything the player needs to know moment-to-moment ("what is the
	// camera seeing?", "get ready!", "SCISSORS... PAPER... ROCK!", "You
	// played Rock", and finally the big win/lose/tie result) is rendered
	// through this single, always-in-the-same-place banner. It starts out
	// small/informational and grows into a big, bold announcement (the
	// `.big` class) for the countdown and the round result -- this is
	// what "big announcements" means in this rewrite, instead of a
	// separate floating overlay that only showed up sometimes.

	// Friendly icon + copy for each gesture, shown whenever the game is
	// just idly watching the camera (not mid-countdown/mid-round).
	const DETECTION_INFO = {
		wait: { icon: '🤷', text: 'No clear gesture yet — show me Rock, Paper, or Scissors' },
		rock: { icon: '✊', text: 'Detecting: ROCK' },
		paper: { icon: '✋', text: 'Detecting: PAPER' },
		scissors: { icon: '✌️', text: 'Detecting: SCISSORS' },
	};

	/** Show the default "what the camera currently sees" banner state. */
	function showDetectionStatus(state) {
		const info = DETECTION_INFO[state] || DETECTION_INFO.wait;
		setStatusBanner(info.icon, info.text, { tone: 'detect' });
	}

	/**
	 * Update the status banner.
	 * @param {string} icon - Emoji shown to the left of the text.
	 * @param {string} text - The message itself.
	 * @param {object} [opts]
	 * @param {string} [opts.tone='info'] - Colour variant: info | detect | countdown | win | lose | tie | error
	 * @param {boolean} [opts.big=false] - Whether to render this as a BIG bold announcement.
	 */
	function setStatusBanner(icon, text, { tone = 'info', big = false } = {}) {
		const nextClassName = `tone-${tone}` + (big ? ' big' : '');

		// Camera responses arrive continuously. Do not rewrite the banner or
		// restart its animation when the visible state has not changed; doing
		// that on every frame caused the whole interface to appear jittery.
		if (
			statusIcon.textContent === icon &&
			statusText.textContent === text &&
			statusBanner.className === nextClassName
		) {
			return;
		}

		statusIcon.textContent = icon;
		statusText.textContent = text;
		statusBanner.className = nextClassName;

		// Animate only genuine state changes, such as a new gesture,
		// countdown beat, or round result.
		statusBanner.classList.remove('pulse');
		void statusBanner.offsetWidth;
		statusBanner.classList.add('pulse');
	}


	// =========================================================
	// 9. Game state machine: the countdown & round resolution
	// =========================================================

	/**
	 * Play the classic "scissors... paper... rock!" countdown beats, then
	 * resolve the round using whatever gesture was detected on the final
	 * beat.
	 */
	function startCountdown() {
		if (gameStage !== 'ready_to_start') return;
		gameStage = 'countdown';

		// Brief "Get Ready" beat before the actual scissors/paper/rock
		// sequence starts, so triggering the shake doesn't feel like it
		// instantly ambushes the player.
		setStatusBanner('👊', 'Get Ready...', { tone: 'countdown', big: true });

		setTimeout(() => {
			if (gameStage !== 'countdown') return;
			setStatusBanner('✌️', 'SCISSORS...', { tone: 'countdown', big: true });
			updateTrafficLights('scissors');
			SOUND.countdownBeat();
		}, GET_READY_DELAY_MS);

		setTimeout(() => {
			if (gameStage !== 'countdown') return;
			setStatusBanner('✋', 'PAPER...', { tone: 'countdown', big: true });
			updateTrafficLights('paper');
			SOUND.countdownBeat();
		}, GET_READY_DELAY_MS + COUNTDOWN_STEP_MS);

		setTimeout(() => {
			if (gameStage !== 'countdown') return;
			setStatusBanner('✊', 'ROCK!', { tone: 'countdown', big: true });
			updateTrafficLights('rock');
			SOUND.countdownBeat();
			// Use the *stable* (debounced + lingered) gesture rather than the
			// raw last frame -- the player's hand is usually still moving at
			// the "ROCK!" beat, so a single raw frame is often 'wait' even
			// though the move is obvious. Give it a short grace period to
			// settle before giving up.
			const finalBeatTime = Date.now();
			const tryPlay = () => {
				if (gameStage !== 'countdown') return;
				if (VALID_MOVES.includes(currentStableState)) {
					playGame(currentStableState);
				} else if (Date.now() - finalBeatTime < 600) {
					setTimeout(tryPlay, 120); // Keep sampling for ~600ms.
				} else {
					playGame(currentStableState); // Invalid -> graceful retry flow.
				}
			};
			tryPlay();
		}, GET_READY_DELAY_MS + COUNTDOWN_STEP_MS * 2);
	}


	/**
	 * Resolve a full round: validate the player's move, highlight it, ask
	 * the backend to pick the AI's move and judge the winner, then render
	 * the outcome (big banner + AI-move overlay + history log) before
	 * resetting for the next round.
	 *
	 * @param {string} playerMove - The gesture to play this round. Comes
	 *   either from the final countdown beat (webcam flow) or directly
	 *   from a Quick Play button click.
	 */
	async function playGame(playerMove) {
		if (gameStage === 'playing') return; // Never let two rounds overlap.

		// --- THE FIX for "You played undefined" -----------------------
		// The final countdown beat resolves whatever gesture the camera
		// last reported, which -- on a noisy/ambiguous frame -- might not
		// be a real move (e.g. still 'wait'). Rather than sending that
		// straight to the backend (which is exactly how the AI's move
		// used to come back missing/undefined), we bail out gracefully
		// and let the player try the shake again.
		if (!VALID_MOVES.includes(playerMove)) {
			console.warn(`playGame() called with an invalid move ('${playerMove}') -- resetting round instead of contacting the server.`);
			setStatusBanner('🙈', "Didn't catch a clear move — let's try that again!", { tone: 'error', big: true });
			// "No clear move" is itself worth labelling: queue the frame so
			// the player can mark it as No Move (negative example) or pick
			// the move the detector missed.
			if (currentStream) {
				const frame = captureTrainingFrame();
				if (frame) enqueueTrainingReview(frame, 'wait');
			}
			gameStage = 'countdown'; // Block re-triggering while we reset.
			setTimeout(() => {
				gameStage = 'wait';
				updateTrafficLights('wait');
				showDetectionStatus('wait');
			}, 1600);
			return;
		}

		gameStage = 'playing';
		highlightPlayerChoice(playerMove);
		setQuickPlayButtonsEnabled(false);
		// Stamp what the player threw over their own webcam feed so they
		// can immediately see what was detected, even before the AI moves.
		showPlayerMoveOverlay(playerMove);
		// Capture the exact frame this move came from and queue it for
		// labelling -- queued frames survive across rounds, so playing on
		// without confirming never loses training data.
		if (currentStream) {
			const frame = captureTrainingFrame();
			if (frame) enqueueTrainingReview(frame, playerMove);
		}
		setStatusBanner(
			MOVE_EMOJI[playerMove],
			`You played ${MOVE_NAME[playerMove]}! Waiting for the AI...`,
			{ tone: 'countdown', big: true }
		);

		showAiThinking();
		await wait(500); // Small "thinking" delay for suspense/pacing.

		try {
			const gameResult = await requestAiMove(playerMove);
			const { ai_move: aiMove, winner, logs: aiLogs } = gameResult;

			// Defensive check: the backend should always return one of the
			// three valid moves, but if something ever goes wrong server
			// side, fail loudly and visibly instead of rendering
			// "undefined" anywhere in the UI.
			if (!VALID_MOVES.includes(aiMove)) {
				throw new Error(`Server returned an invalid AI move: ${JSON.stringify(aiMove)}`);
			}

			if (aiLogs) console.log('AI reasoning:', aiLogs);

			gamesPlayed++;
			if (winner === 'player') playerWins++;
			if (winner === 'ai') aiWins++;

			updateScores();
			updateAiBox(aiMove);
			logGameResult(playerMove, aiMove, winner);
			highlightWinner(winner);
			playResultSound(winner);
			announceResult(playerMove, aiMove, winner);

			// Refresh the AI insight panel immediately so the new round's
			// data shows up right away (rather than waiting for the next
			// polling tick).
			refreshAiStats();

		} catch (error) {
			console.error('Error playing round:', error);
			setStatusBanner('⚠️', "Couldn't reach the server — try again!", { tone: 'error', big: true });
		} finally {
			setTimeout(() => {
				gameStage = 'wait';
				removePlayerChoiceHighlight();
				resetAiBoxToIdle();
				hidePlayerMoveOverlay();
				removeHighlights();
				updateTrafficLights('wait');
				showDetectionStatus('wait');
				setQuickPlayButtonsEnabled(true);
			}, RESULT_DISPLAY_MS);
		}
	}

	/**
	 * Render the big, bold, human-readable result banner, e.g.
	 * "🎉 Rock crushes Scissors — YOU WIN!".
	 */
	function announceResult(playerMove, aiMove, winner) {
		if (winner === 'tie') {
			setStatusBanner('🤝', `Both threw ${MOVE_NAME[playerMove]} — it's a TIE!`, { tone: 'tie', big: true });
			return;
		}

		const winningMove = winner === 'player' ? playerMove : aiMove;
		const losingMove = winner === 'player' ? aiMove : playerMove;
		const verb = BEATS_VERB[winningMove] || 'beats';
		const explanation = `${MOVE_NAME[winningMove]} ${verb} ${MOVE_NAME[losingMove]}`;

		if (winner === 'player') {
			setStatusBanner('🎉', `${explanation} — YOU WIN!`, { tone: 'win', big: true });
		} else {
			setStatusBanner('🤖', `${explanation} — AI WINS!`, { tone: 'lose', big: true });
		}
	}

	/** Small promise-based sleep helper for readable async delays. */
	function wait(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function playResultSound(winner) {
		if (winner === 'player') SOUND.win();
		else if (winner === 'ai') SOUND.lose();
		else SOUND.tie();
	}


	// =========================================================
	// 10. Backend communication
	// =========================================================

	/**
	 * Ask the backend to choose the AI's move for this round and judge
	 * the winner against the player's move.
	 * @param {string} playerMove
	 * @returns {Promise<{ai_move: string, winner: string, logs: object}>}
	 */
	async function requestAiMove(playerMove) {
		const response = await fetch('/play_round', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ player_move: playerMove }),
		});
		if (!response.ok) {
			// The backend now validates player_move itself and returns a
			// clear JSON error (rather than silently proceeding), so surface
			// that message where possible instead of a generic one.
			const body = await response.json().catch(() => ({}));
			throw new Error(body.error || `Server responded with status ${response.status}`);
		}
		return response.json();
	}


	// =========================================================
	// 11. UI rendering helpers
	// =========================================================

	/** Sync the scoreboard numbers to the current in-memory tallies. */
	function updateScores() {
		bumpAndSet(playerWinsEl, playerWins);
		bumpAndSet(aiWinsEl, aiWins);
		bumpAndSet(gameCountEl, gamesPlayed);
	}

	/** Update a stat's text and play a tiny "bump" scale animation. */
	function bumpAndSet(el, value) {
		el.textContent = value;
		el.classList.remove('bump');
		// Force reflow so the animation can be retriggered on repeated bumps.
		void el.offsetWidth;
		el.classList.add('bump');
	}

	/** Show a "thinking..." placeholder in the AI box while awaiting the server. */
	function showAiThinking() {
		aiContent.innerHTML = `<span class="ai-move-emoji" style="opacity:.4;">🤔</span>`;
	}

	/** Reveal the AI's chosen move as a large emoji in its own box. */
	function updateAiBox(move) {
		const emoji = MOVE_EMOJI[move] || '❓';
		aiContent.innerHTML = `<span class="ai-move-emoji">${emoji}</span>`;
	}

	/** Return the AI box to its idle "waiting" image between rounds. */
	function resetAiBoxToIdle() {
		aiContent.innerHTML = `<img src="resources/ai_hand.jpg" alt="AI is waiting" id="ai-placeholder">`;
	}

	/**
	 * Stamp the player's own thrown move over their webcam feed, so it's
	 * immediately obvious what the camera detected them as playing --
	 * even while the AI is still "thinking".
	 */
	function showPlayerMoveOverlay(move) {
		playerMoveOverlayEmoji.textContent = MOVE_EMOJI[move] || '❓';
		playerMoveOverlayLabel.textContent = `You played ${MOVE_NAME[move] || ''}`;
		playerMoveOverlay.hidden = false;

		// Retrigger the "stamp" pop-in animation.
		playerMoveOverlayEmoji.style.animation = 'none';
		void playerMoveOverlayEmoji.offsetWidth;
		playerMoveOverlayEmoji.style.animation = '';
	}

	function hidePlayerMoveOverlay() {
		playerMoveOverlay.hidden = true;
	}

	/**
	 * Prepend a new row to the redesigned match history log: a compact
	 * card showing the round number, both moves' emoji, and a clear
	 * colour-coded win/lose/tie tag.
	 */
	function logGameResult(playerMove, aiMove, winner) {
		const row = document.createElement('div');
		row.className = `history-row outcome-${winner}`;

		const tagText = winner === 'player' ? 'You Won' : winner === 'ai' ? 'AI Won' : 'Tie';

		row.innerHTML =
			`<span class="history-round">#${gamesPlayed}</span>` +
			`<span class="history-versus">` +
			`<span class="history-move" title="You: ${MOVE_NAME[playerMove]}">${MOVE_EMOJI[playerMove]}</span>` +
			`<span class="history-vs-text">vs</span>` +
			`<span class="history-move" title="AI: ${MOVE_NAME[aiMove]}">${MOVE_EMOJI[aiMove]}</span>` +
			`</span>` +
			`<span class="history-tag">${tagText}</span>`;

		const placeholder = historyList.querySelector('#history-placeholder');
		if (placeholder) historyList.innerHTML = '';
		historyList.prepend(row);
	}

	/** Apply a glowing highlight to whichever side won the round. */
	function highlightWinner(winner) {
		removeHighlights();
		if (winner === 'player') playerBox.classList.add('winner-highlight');
		else if (winner === 'ai') aiBox.classList.add('winner-highlight');
		else {
			playerBox.classList.add('tie-highlight');
			aiBox.classList.add('tie-highlight');
		}
	}

	function removeHighlights() {
		playerBox.classList.remove('winner-highlight', 'tie-highlight');
		aiBox.classList.remove('winner-highlight', 'tie-highlight');
	}

	/** Pulse the traffic light matching the player's final thrown gesture. */
	function highlightPlayerChoice(move) {
		const moveEl = document.getElementById(move);
		if (moveEl) moveEl.classList.add('player-throw-highlight');
	}

	function removePlayerChoiceHighlight() {
		const highlighted = document.querySelector('.player-throw-highlight');
		if (highlighted) highlighted.classList.remove('player-throw-highlight');
	}

	/** Light up exactly the traffic light matching the given gesture/status. */
	function updateTrafficLights(status) {
		allLights.forEach((light) => light.classList.remove('active'));
		const activeLight = document.querySelector(`#${status} .light`);
		if (activeLight) activeLight.classList.add('active');
	}


	// =========================================================
	// Startup
	// =========================================================
	function init() {
		historyList.innerHTML = '<p id="history-placeholder">No games played yet.</p>';
		updateTrafficLights('wait');
		setStatusBanner('👋', 'Click "Start Webcam" to begin', { tone: 'info' });
		loadExistingTrainingImages();
	}

	init();
});