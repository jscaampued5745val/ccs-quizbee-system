/**
 * public/js/quizmaster.js
 * OLFU IT Olympics LAN Quiz Bee System (ITPM 311)
 * Quizmaster Client Controller & Telemetry Grid Handler (Zero-CDN)
 */

(function () {
  'use strict';

  // State
  let socket = null;
  let questions = [];
  let currentGameState = null;
  const terminalMap = new Map(); // pin -> tile DOM element

  // DOM Elements
  const elConnectionDot = document.getElementById('qm-connection-dot');
  const elConnectionStatus = document.getElementById('qm-connection-status');
  const elPhaseBadge = document.getElementById('current-phase-badge');
  const elTimerDisplay = document.getElementById('timer-display');
  const elTimerHint = document.getElementById('timer-status-hint');

  // Controls
  const btnStage = document.getElementById('btn-stage');
  const btnStartTimer = document.getElementById('btn-start-timer');
  const btnPauseTimer = document.getElementById('btn-pause-timer');
  const btnResumeTimer = document.getElementById('btn-resume-timer');
  const btnForceLock = document.getElementById('btn-force-lock');
  const btnReveal = document.getElementById('btn-reveal');
  const btnLeaderboard = document.getElementById('btn-leaderboard');
  const btnReset = document.getElementById('btn-reset');

  // Question Selector & Preview
  const selectQuestion = document.getElementById('question-select');
  const badgeQuestionCount = document.getElementById('question-count-badge');
  const previewRoundBadge = document.getElementById('preview-round-badge');
  const previewPointsBadge = document.getElementById('preview-points-badge');
  const previewQuestionText = document.getElementById('preview-question-text');
  const previewCodeBlock = document.getElementById('preview-code-block');
  const previewCodeContent = document.getElementById('preview-code-content');
  const previewOptionsContainer = document.getElementById('preview-options-container');

  // Telemetry Grid & Stats
  const elTelemetryGrid = document.getElementById('telemetry-grid');
  const statOnline = document.getElementById('stat-online');
  const statOffline = document.getElementById('stat-offline');
  const statIncidents = document.getElementById('stat-incidents');
  const elSubmissionCount = document.getElementById('submission-count');
  const elAlertFeed = document.getElementById('alert-feed');
  const btnClearAlerts = document.getElementById('btn-clear-alerts');

  // Override Modal
  const modalOverride = document.getElementById('override-modal');
  const btnOpenOverride = document.getElementById('btn-open-override');
  const btnCloseOverride = document.getElementById('btn-close-override');
  const btnCancelOverride = document.getElementById('btn-cancel-override');
  const btnSubmitOverride = document.getElementById('btn-submit-override');
  const inputOverridePin = document.getElementById('override-pin');
  const inputOverrideScore = document.getElementById('override-score');
  const inputOverrideReason = document.getElementById('override-reason');

  // Import Modal
  const modalImport = document.getElementById('import-modal');
  const btnOpenImport = document.getElementById('btn-open-import');
  const btnCloseImport = document.getElementById('btn-close-import');
  const btnCancelImport = document.getElementById('btn-cancel-import');
  const btnSubmitImport = document.getElementById('btn-submit-import');
  const inputCsvFile = document.getElementById('csv-file-input');
  const selectImportMode = document.getElementById('import-mode-select');
  const boxImportStatus = document.getElementById('import-status-box');

  // Audio Controls
  const btnAudioMute = document.getElementById('btn-audio-mute');
  const sliderAudioVolume = document.getElementById('audio-volume-slider');

  // Initialize
  function init() {
    setupAudioListeners();
    initTelemetryGridSkeleton();
    setupControlListeners();
    fetchQuestionBank();
    initSocketConnection();
  }

  // Audio UI
  function setupAudioListeners() {
    if (btnAudioMute && window.QuizAudio) {
      btnAudioMute.addEventListener('click', () => {
        const isMuted = window.QuizAudio.toggleMute();
        btnAudioMute.style.opacity = isMuted ? '0.4' : '1';
      });
    }
    if (sliderAudioVolume && window.QuizAudio) {
      sliderAudioVolume.addEventListener('input', (e) => {
        window.QuizAudio.setVolume(parseFloat(e.target.value));
      });
    }
  }

  // Render initial 60 workstation tiles
  function initTelemetryGridSkeleton() {
    if (!elTelemetryGrid) return;
    elTelemetryGrid.innerHTML = '';

    for (let i = 1; i <= 60; i++) {
      const pin = String(1000 + i);
      const padNum = String(i).padStart(2, '0');

      const tile = document.createElement('div');
      tile.className = 'terminal-tile offline';
      tile.id = `terminal-${pin}`;
      tile.dataset.pin = pin;

      tile.innerHTML = `
        <div class="tile-top">
          <span class="tile-terminal-num">T${padNum}</span>
          <span class="status-dot offline" id="dot-${pin}"></span>
        </div>
        <div class="tile-name" id="name-${pin}">Station ${padNum}</div>
        <div class="tile-pin">PIN: ${pin}</div>
        <div class="tile-bottom">
          <span class="tile-score" id="score-${pin}">0 PTS</span>
          <div class="tile-badges" id="badges-${pin}"></div>
        </div>
      `;

      tile.addEventListener('click', () => {
        if (inputOverridePin) {
          inputOverridePin.value = pin;
          modalOverride.classList.remove('hidden');
        }
      });

      terminalMap.set(pin, tile);
      elTelemetryGrid.appendChild(tile);
    }
  }

  // Socket setup
  function initSocketConnection() {
    if (typeof io === 'undefined') {
      console.warn('Socket.io client not available');
      return;
    }

    socket = io();

    socket.on('connect', () => {
      elConnectionDot.className = 'status-dot online';
      elConnectionStatus.textContent = 'Connected (LAN)';
      socket.emit('qm:join');
    });

    socket.on('disconnect', () => {
      elConnectionDot.className = 'status-dot offline';
      elConnectionStatus.textContent = 'Disconnected';
    });

    // QM Initial Snapshot
    socket.on('qm:init', (data) => {
      if (!data || !data.success) return;
      currentGameState = data.gameState;
      updatePhaseView(data.gameState.phase);
      if (data.telemetryGrid) {
        updateTelemetryMatrix(data.telemetryGrid, data.summary);
      }
      if (data.gameState.currentQuestion) {
        renderQuestionPreview(data.gameState.currentQuestion);
      }
    });

    // Telemetry updates
    socket.on('qm:telemetry:snapshot', (snapshot) => {
      if (snapshot && snapshot.terminals) {
        updateTelemetryMatrix(snapshot.terminals, snapshot.summary);
      }
    });

    socket.on('qm:telemetry:connection', (data) => {
      handlePresenceChange(data.pin, data.isConnected);
    });

    socket.on('qm:telemetry:presence', (data) => {
      handlePresenceChange(data.pin, data.isConnected);
    });

    socket.on('qm:telemetry:submission', (data) => {
      markTerminalSubmitted(data.pin, true);
    });

    socket.on('qm:submission:update', (data) => {
      if (data.pin) markTerminalSubmitted(data.pin, true);
      if (data.totalSubmissions !== undefined && elSubmissionCount) {
        const expected = data.totalExpected || 60;
        elSubmissionCount.textContent = `${data.totalSubmissions} / ${expected}`;
      }
    });

    socket.on('qm:telemetry:alert', (alert) => {
      handleTelemetryAlert(alert);
    });

    socket.on('qm:questions:updated', () => {
      fetchQuestionBank();
    });

    // Game lifecycle events
    socket.on('game:phase:change', (data) => {
      const newPhase = data.newPhase || data.phase;
      currentGameState = data.state || currentGameState;
      updatePhaseView(newPhase);

      if (window.QuizAudio) {
        if (newPhase === 'READING') window.QuizAudio.playPhaseChime();
        else if (newPhase === 'LOCKED') window.QuizAudio.playLock();
        else if (newPhase === 'REVEAL') window.QuizAudio.playCorrect();
        else if (newPhase === 'LEADERBOARD') window.QuizAudio.playFanfare();
      }

      if (data.state && data.state.currentQuestion) {
        renderQuestionPreview(data.state.currentQuestion);
      }
      if (newPhase === 'READING') {
        resetSubmissionsOnGrid();
      }
    });

    socket.on('game:tick', (data) => {
      const remaining = data.remainingSeconds !== undefined ? data.remainingSeconds : Math.ceil(data.remainingMs / 1000);
      updateTimerDisplay(remaining);
      if (window.QuizAudio) {
        if (remaining <= 5 && remaining > 0) {
          window.QuizAudio.playWarningTick();
        } else if (remaining > 5) {
          window.QuizAudio.playTick();
        }
      }
    });

    socket.on('game:question:lock', () => {
      updateTimerDisplay(0);
      if (window.QuizAudio) window.QuizAudio.playLock();
    });

    socket.on('game:answer:reveal', () => {
      if (window.QuizAudio) window.QuizAudio.playCorrect();
    });

    socket.on('game:leaderboard', () => {
      if (window.QuizAudio) window.QuizAudio.playFanfare();
    });
  }

  // Update telemetry matrix from snapshot
  function updateTelemetryMatrix(terminals, summary) {
    let onlineCount = 0;
    let alertCount = 0;

    terminals.forEach((term) => {
      const pin = term.pin;
      const tile = terminalMap.get(pin);
      if (!tile) return;

      const isOnline = term.status === 'ONLINE' || term.isConnected;
      if (isOnline) onlineCount++;
      if (term.incidentCount > 0) alertCount += term.incidentCount;

      tile.className = `terminal-tile ${isOnline ? 'online' : 'offline'} ${term.hasSubmitted ? 'submitted' : ''} ${term.incidentCount > 0 ? 'has-alert' : ''}`;

      const dot = document.getElementById(`dot-${pin}`);
      if (dot) dot.className = `status-dot ${isOnline ? 'online' : 'offline'}`;

      const nameEl = document.getElementById(`name-${pin}`);
      if (nameEl && term.fullName) nameEl.textContent = term.fullName;

      const scoreEl = document.getElementById(`score-${pin}`);
      if (scoreEl && term.score !== undefined) scoreEl.textContent = `${term.score} PTS`;

      const badgesContainer = document.getElementById(`badges-${pin}`);
      if (badgesContainer) {
        let badgesHtml = '';
        if (term.hasSubmitted) badgesHtml += '<span class="badge-sub">&#10003;</span>';
        if (term.incidentCount > 0) badgesHtml += `<span class="badge-inc">⚠ ${term.incidentCount}</span>`;
        badgesContainer.innerHTML = badgesHtml;
      }
    });

    if (statOnline) statOnline.textContent = onlineCount;
    if (statOffline) statOffline.textContent = Math.max(0, 60 - onlineCount);
    if (statIncidents) statIncidents.textContent = summary?.totalIncidents ?? alertCount;
  }

  function handlePresenceChange(pin, isConnected) {
    const tile = terminalMap.get(pin);
    if (!tile) return;
    if (isConnected) {
      tile.classList.remove('offline');
      tile.classList.add('online');
    } else {
      tile.classList.remove('online');
      tile.classList.add('offline');
    }
    const dot = document.getElementById(`dot-${pin}`);
    if (dot) dot.className = `status-dot ${isConnected ? 'online' : 'offline'}`;
  }

  function markTerminalSubmitted(pin, submitted) {
    const tile = terminalMap.get(pin);
    if (!tile) return;
    if (submitted) tile.classList.add('submitted');
    else tile.classList.remove('submitted');

    const badgesContainer = document.getElementById(`badges-${pin}`);
    if (badgesContainer && submitted && !badgesContainer.querySelector('.badge-sub')) {
      const subBadge = document.createElement('span');
      subBadge.className = 'badge-sub';
      subBadge.innerHTML = '&#10003;';
      badgesContainer.appendChild(subBadge);
    }
  }

  function resetSubmissionsOnGrid() {
    terminalMap.forEach((tile, pin) => {
      tile.classList.remove('submitted');
      const badgesContainer = document.getElementById(`badges-${pin}`);
      if (badgesContainer) {
        const sub = badgesContainer.querySelector('.badge-sub');
        if (sub) sub.remove();
      }
    });
    if (elSubmissionCount) elSubmissionCount.textContent = '0 / 60';
  }

  function handleTelemetryAlert(alert) {
    if (!alert) return;
    if (window.QuizAudio) window.QuizAudio.playAlert();

    const pin = alert.pin;
    const tile = terminalMap.get(pin);
    if (tile) {
      tile.classList.add('has-alert');
      const badgesContainer = document.getElementById(`badges-${pin}`);
      if (badgesContainer) {
        let inc = badgesContainer.querySelector('.badge-inc');
        if (!inc) {
          inc = document.createElement('span');
          inc.className = 'badge-inc';
          badgesContainer.appendChild(inc);
        }
        inc.textContent = `⚠ ${alert.totalIncidents || 1}`;
      }
    }

    if (statIncidents) {
      const current = parseInt(statIncidents.textContent, 10) || 0;
      statIncidents.textContent = current + 1;
    }

    if (elAlertFeed) {
      const placeholder = elAlertFeed.querySelector('.alert-item:only-child');
      if (placeholder && placeholder.textContent.includes('No cheat incidents')) {
        elAlertFeed.innerHTML = '';
      }

      const item = document.createElement('div');
      item.className = 'alert-item alert-danger';
      const timeStr = new Date().toLocaleTimeString();
      const padNum = String(alert.terminalNumber || pin).padStart(2, '0');
      const incType = alert.incidentType || alert.type || 'UNKNOWN';
      item.textContent = `T${padNum} (PIN: ${pin}): ${incType} ${timeStr}`;
      item.innerHTML = `
        <div>
          <strong>T${padNum} (PIN: ${pin})</strong>: ${incType}
        </div>
        <span style="font-size:0.75rem; color:var(--text-muted);">${timeStr}</span>
      `;
      elAlertFeed.prepend(item);
    }
  }

  // Phase transition state guarding
  function updatePhaseView(phase) {
    if (!elPhaseBadge) return;
    elPhaseBadge.textContent = phase;

    // Reset button states
    btnStage.disabled = true;
    btnStartTimer.disabled = true;
    btnPauseTimer.disabled = true;
    btnResumeTimer.disabled = true;
    btnForceLock.disabled = true;
    btnReveal.disabled = true;
    btnLeaderboard.disabled = false;

    switch (phase) {
      case 'LOBBY':
        elPhaseBadge.className = 'phase-pill badge-emerald';
        elTimerHint.textContent = 'Tournament Standby — Select and Stage Question';
        btnStage.disabled = false;
        break;
      case 'READING':
        elPhaseBadge.className = 'phase-pill badge-info';
        elTimerHint.textContent = 'Contestants are reading prompt — Inputs locked';
        btnStartTimer.disabled = false;
        btnStage.disabled = false;
        break;
      case 'COUNTDOWN':
        elPhaseBadge.className = 'phase-pill badge-gold';
        elTimerHint.textContent = 'Countdown active — Submissions open!';
        btnPauseTimer.disabled = false;
        btnForceLock.disabled = false;
        break;
      case 'PAUSED':
        elPhaseBadge.className = 'phase-pill badge-slate';
        elTimerHint.textContent = 'Timer paused — Contestant inputs frozen';
        btnResumeTimer.disabled = false;
        btnForceLock.disabled = false;
        break;
      case 'LOCKED':
        elPhaseBadge.className = 'phase-pill badge-danger';
        elTimerHint.textContent = 'Submissions closed — Ready to reveal answer';
        btnReveal.disabled = false;
        btnStage.disabled = false;
        break;
      case 'REVIEW':
        elPhaseBadge.className = 'phase-pill badge-purple';
        elTimerHint.textContent = 'Judges evaluating open identification answers';
        btnReveal.disabled = false;
        btnStage.disabled = false;
        break;
      case 'REVEAL':
        elPhaseBadge.className = 'phase-pill badge-emerald';
        elTimerHint.textContent = 'Correct answer revealed on spectator stage';
        btnLeaderboard.disabled = false;
        btnStage.disabled = false;
        break;
      case 'LEADERBOARD':
        elPhaseBadge.className = 'phase-pill badge-gold';
        elTimerHint.textContent = 'Tournament standings displayed';
        btnStage.disabled = false;
        break;
    }
  }

  function updateTimerDisplay(remainingSeconds) {
    if (!elTimerDisplay) return;
    const sec = Math.max(0, remainingSeconds);
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    elTimerDisplay.textContent = `${m}:${s}`;

    if (sec <= 5 && sec > 0) {
      elTimerDisplay.className = 'timer-digits danger';
    } else if (sec <= 10 && sec > 5) {
      elTimerDisplay.className = 'timer-digits warning';
    } else {
      elTimerDisplay.className = 'timer-digits';
    }
  }

  // Fetch Questions from API
  async function fetchQuestionBank() {
    try {
      const res = await fetch('/api/questions');
      const data = await res.json();
      if (data && data.success && Array.isArray(data.questions)) {
        questions = data.questions;
        if (badgeQuestionCount) badgeQuestionCount.textContent = `${questions.length} Questions`;
        populateQuestionSelect();
      }
    } catch (err) {
      console.error('Failed to load questions:', err);
    }
  }

  function populateQuestionSelect() {
    if (!selectQuestion) return;
    selectQuestion.innerHTML = '<option value="">-- Select a Question to Stage --</option>';

    questions.forEach((q) => {
      const opt = document.createElement('option');
      opt.value = q.id;
      const text = q.question_text || q.question || '';
      const previewText = text.length > 55 ? text.substring(0, 52) + '...' : text;
      const roundLabel = q.round_name || q.round || (q.round_id ? 'Round ' + q.round_id : 'Round');
      const itemLabel = q.item_number ? `Item ${q.item_number} (#${q.id})` : `#${q.id}`;
      opt.textContent = `[${roundLabel}] ${itemLabel}: ${previewText}`;
      selectQuestion.appendChild(opt);
    });

    selectQuestion.addEventListener('change', () => {
      const qId = Number(selectQuestion.value);
      const q = questions.find((item) => item.id === qId);
      if (q) renderQuestionPreview(q);
    });
  }

  function renderQuestionPreview(q) {
    if (!q) return;
    const itemStr = q.item_number ? ` • ITEM ${q.item_number}${q.total_items ? ' OF ' + q.total_items : ''}` : '';
    previewRoundBadge.textContent = `${(q.round_name || q.round || 'ROUND').toUpperCase()}${itemStr}`;
    previewPointsBadge.textContent = `${q.points !== undefined ? q.points : 1} PTS`;
    previewQuestionText.textContent = q.question_text || q.question || '';

    if (q.code_snippet) {
      previewCodeBlock.classList.remove('hidden');
      previewCodeContent.textContent = q.code_snippet;
    } else {
      previewCodeBlock.classList.add('hidden');
    }

    if (q.type === 'MCQ' && q.options) {
      previewOptionsContainer.classList.remove('hidden');
      previewOptionsContainer.innerHTML = '';
      const opts = typeof q.options === 'string' ? JSON.parse(q.options) : q.options;
      Object.entries(opts).forEach(([letter, text]) => {
        const div = document.createElement('div');
        const isCorrect = q.correct_answer && String(q.correct_answer).toUpperCase() === letter;
        div.className = `preview-option ${isCorrect ? 'correct' : ''}`;
        div.textContent = `${letter}: ${text}`;
        previewOptionsContainer.appendChild(div);
      });
    } else {
      previewOptionsContainer.classList.add('hidden');
    }
  }

  // Button Controls Binding
  function setupControlListeners() {
    btnStage.addEventListener('click', () => {
      const qId = Number(selectQuestion.value);
      if (!qId) {
        alert('Please select a question from the dropdown first.');
        return;
      }
      socket.emit('qm:question:stage', { questionId: qId }, (res) => {
        if (res && res.success === false) {
          alert(`Unable to stage question: ${res.message || res.error || 'Unknown error'}.\nThe question list will be refreshed.`);
          fetchQuestionBank();
        }
      });
    });

    btnStartTimer.addEventListener('click', () => {
      socket.emit('qm:timer:start');
    });

    btnPauseTimer.addEventListener('click', () => {
      socket.emit('qm:timer:pause');
    });

    btnResumeTimer.addEventListener('click', () => {
      socket.emit('qm:timer:resume');
    });

    btnForceLock.addEventListener('click', () => {
      socket.emit('qm:force:lock');
    });

    btnReveal.addEventListener('click', () => {
      socket.emit('qm:answer:reveal');
    });

    btnLeaderboard.addEventListener('click', () => {
      socket.emit('qm:leaderboard:show');
    });

    btnReset.addEventListener('click', () => {
      if (confirm('Reset round back to LOBBY standby?')) {
        socket.emit('qm:round:reset');
      }
    });

    btnClearAlerts.addEventListener('click', () => {
      if (elAlertFeed) {
        elAlertFeed.innerHTML = '<div class="alert-item" style="color:var(--text-muted); justify-content:center;">No cheat incidents detected.</div>';
      }
    });

    // Score Override Modal Handlers
    btnOpenOverride.addEventListener('click', () => {
      modalOverride.classList.remove('hidden');
    });
    btnCloseOverride.addEventListener('click', () => {
      modalOverride.classList.add('hidden');
    });
    btnCancelOverride.addEventListener('click', () => {
      modalOverride.classList.add('hidden');
    });
    if (modalOverride) {
      modalOverride.addEventListener('click', (e) => {
        if (e.target === modalOverride) {
          modalOverride.classList.add('hidden');
        }
      });
    }

    btnSubmitOverride.addEventListener('click', () => {
      const pin = inputOverridePin.value.trim();
      const score = Number(inputOverrideScore.value);
      const reason = inputOverrideReason.value.trim() || 'Manual score correction';

      if (!pin) {
        alert('PIN is required.');
        return;
      }
      if (isNaN(score) || score < 0) {
        alert('Valid non-negative score is required.');
        return;
      }

      socket.emit('qm:score:override', { pin, newScore: score, reason }, (res) => {
        if (res && res.success) {
          alert(`Score updated for PIN ${pin} to ${score} PTS.`);
          modalOverride.classList.add('hidden');
          const scoreEl = document.getElementById(`score-${pin}`);
          if (scoreEl) scoreEl.textContent = `${score} PTS`;
        } else {
          alert('Failed to override score: ' + (res?.error || 'Unknown error'));
        }
      });
    });

    // Import CSV Modal Handlers
    function showImportStatus(msg, type) {
      if (!boxImportStatus) return;
      boxImportStatus.className = type === 'danger'
        ? 'alert-item alert-danger'
        : (type === 'success' ? 'alert-item alert-emerald' : 'alert-item');
      boxImportStatus.style.display = 'block';
      boxImportStatus.innerHTML = msg;
    }

    if (btnOpenImport) {
      btnOpenImport.addEventListener('click', () => {
        if (boxImportStatus) {
          boxImportStatus.className = 'hidden';
          boxImportStatus.style.display = 'none';
          boxImportStatus.innerHTML = '';
        }
        if (inputCsvFile) inputCsvFile.value = '';
        if (modalImport) modalImport.classList.remove('hidden');
      });
    }

    if (btnCloseImport) {
      btnCloseImport.addEventListener('click', () => {
        if (modalImport) modalImport.classList.add('hidden');
      });
    }

    if (btnCancelImport) {
      btnCancelImport.addEventListener('click', () => {
        if (modalImport) modalImport.classList.add('hidden');
      });
    }

    if (modalImport) {
      modalImport.addEventListener('click', (e) => {
        if (e.target === modalImport) {
          modalImport.classList.add('hidden');
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (modalOverride && !modalOverride.classList.contains('hidden')) {
          modalOverride.classList.add('hidden');
        }
        if (modalImport && !modalImport.classList.contains('hidden')) {
          modalImport.classList.add('hidden');
        }
      }
    });

    if (btnSubmitImport) {
      btnSubmitImport.addEventListener('click', () => {
        if (!inputCsvFile || !inputCsvFile.files || !inputCsvFile.files[0]) {
          showImportStatus('Please select a CSV file from your computer or flash drive.', 'danger');
          return;
        }

        const file = inputCsvFile.files[0];
        const mode = selectImportMode ? selectImportMode.value : 'replace';

        btnSubmitImport.disabled = true;
        btnSubmitImport.textContent = 'Uploading...';
        showImportStatus('Reading and validating question data...', 'info');

        const reader = new FileReader();
        reader.onload = async (e) => {
          try {
            const csvContent = e.target.result;
            const res = await fetch('/api/questions/import', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Role': 'quizmaster'
              },
              body: JSON.stringify({ csvContent, mode })
            });

            const result = await res.json();
            if (result && result.success) {
              showImportStatus(`✓ Success! Staged ${result.importedCount} questions into tournament engine.`, 'success');
              await fetchQuestionBank();
              setTimeout(() => {
                if (modalImport) modalImport.classList.add('hidden');
              }, 1200);
            } else {
              const errs = Array.isArray(result.errors) && result.errors.length > 0
                ? result.errors.slice(0, 5).join('<br>')
                : (result.error || 'Failed to parse CSV file.');
              showImportStatus(`Error importing questions:<br>${errs}`, 'danger');
            }
          } catch (err) {
            showImportStatus(`Import failed: ${err.message}`, 'danger');
          } finally {
            btnSubmitImport.disabled = false;
            btnSubmitImport.textContent = 'Upload & Stage';
          }
        };

        reader.onerror = () => {
          showImportStatus('Could not read the selected local file.', 'danger');
          btnSubmitImport.disabled = false;
          btnSubmitImport.textContent = 'Upload & Stage';
        };

        reader.readAsText(file);
      });
    }
  }

  // Auto-run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
