/**
 * public/js/contestant.js
 * OLFU IT Olympics LAN Quiz Bee System (ITPM 311)
 * Contestant Terminal Client Controller & Anti-Cheat Hooks (Zero-CDN)
 */

(function () {
  'use strict';

  // State
  let socket = null;
  let currentPin = null;
  let contestantProfile = null;
  let activeQuestion = null;
  let hasSubmittedCurrent = false;
  let submittedAnswerStatus = 'NONE'; // 'NONE' | 'PENDING' | 'CORRECT' | 'INCORRECT'
  let lastSubmittedAnswer = '';
  let currentSubmission = null; // { questionId, answer, pointsAwarded, judgeStatus, isCorrect, totalScore }
  let lastIncidentReportTime = {};
  const DEBOUNCE_INCIDENT_MS = 1500;

  // DOM Elements - Login
  const sectionLogin = document.getElementById('login-section');
  const inputPin = document.getElementById('pin-input');
  const btnLogin = document.getElementById('btn-login');
  const elLoginError = document.getElementById('login-error');
  const keypadButtons = document.querySelectorAll('.keypad-btn');

  // DOM Elements - Active Station
  const sectionActive = document.getElementById('active-section');
  const elTerminalDot = document.getElementById('terminal-dot');
  const elTerminalStatus = document.getElementById('terminal-status-text');
  const badgeTerminalNum = document.getElementById('terminal-number-badge');
  const elContestantName = document.getElementById('contestant-name');
  const elContestantDept = document.getElementById('contestant-dept');
  const elCurrentScore = document.getElementById('current-score');

  // Question & Timer
  const elQuestionCard = document.getElementById('question-section');
  const elPhaseLabel = document.getElementById('phase-label');
  const elTimerBar = document.getElementById('timer-bar');
  const elTimerValue = document.getElementById('timer-value');
  const elRoundBadge = document.getElementById('round-badge');
  const elItemBadge = document.getElementById('item-badge');
  const elPointBadge = document.getElementById('point-badge');
  const elQuestionText = document.getElementById('question-text');
  const elCodeSnippet = document.getElementById('code-snippet');
  const elCodeContent = document.getElementById('code-content');
  const elReadingLock = document.getElementById('reading-lock');
  const elSubmissionStatus = document.getElementById('submission-status');

  // MCQ & ID Forms
  const elMcqContainer = document.getElementById('mcq-container');
  const mcqOptionButtons = document.querySelectorAll('.mcq-option-btn');
  const elIdContainer = document.getElementById('id-container');
  const inputAnswer = document.getElementById('answer-input');
  const btnSubmitAnswer = document.getElementById('btn-submit-answer');
  const btnPeekAnswer = document.getElementById('btn-peek-answer');

  // Anti-Cheat Modal
  const modalFullscreenWarning = document.getElementById('fullscreen-warning');
  const btnReenterFullscreen = document.getElementById('btn-reenter-fullscreen');

  // Audio Controls
  const btnAudioMute = document.getElementById('btn-audio-mute');
  const sliderAudioVolume = document.getElementById('audio-volume-slider');

  // Initialize
  function init() {
    setupAudioListeners();
    setupKeypad();
    setupAuthEvents();
    setupSubmissionEvents();
    setupAntiCheatGuards();
    initSocketConnection();

    // Check for saved session in localStorage
    const savedPin = localStorage.getItem('quizbee_pin');
    if (savedPin && inputPin) {
      inputPin.value = savedPin;
    }
  }

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

  // Keypad
  function setupKeypad() {
    keypadButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (!inputPin) return;

        if (key === 'clear') {
          inputPin.value = '';
        } else if (key === 'backspace') {
          inputPin.value = inputPin.value.slice(0, -1);
        } else if (inputPin.value.length < 4) {
          inputPin.value += key;
        }

        if (inputPin.value.length === 4) {
          attemptLogin();
        }
      });
    });
  }

  function setupAuthEvents() {
    if (inputPin) {
      inputPin.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          attemptLogin();
        }
      });
    }

    if (btnLogin) {
      btnLogin.addEventListener('click', attemptLogin);
    }
  }

  // Authenticate
  function attemptLogin() {
    const pin = inputPin.value.trim();
    if (!pin || pin.length < 4) {
      showLoginError('Please enter a valid 4-digit PIN (1001–1060).');
      return;
    }

    // Try to trigger fullscreen on user gesture
    requestFullscreenMode();

    if (!socket || !socket.connected) {
      showLoginError('Not connected to LAN game server. Please wait...');
      return;
    }

    socket.emit('contestant:auth', { pin }, (res) => {
      handleAuthResponse(res, pin);
    });
  }

  function handleAuthResponse(res, pin) {
    if (res && res.success) {
      currentPin = pin;
      contestantProfile = res.contestant || res || {};
      localStorage.setItem('quizbee_pin', pin);

      hideLoginError();
      sectionLogin.classList.add('hidden');
      sectionActive.classList.remove('hidden');

      // Update UI Header
      const padNum = String(contestantProfile.terminalNumber || res.terminalNumber || pin).padStart(2, '0');
      badgeTerminalNum.textContent = `T${padNum}`;
      elContestantName.textContent = contestantProfile.fullName || res.fullName || `Station ${padNum}`;
      elContestantDept.textContent = contestantProfile.department || res.department || 'Computer Studies';
      elCurrentScore.textContent = `${contestantProfile.totalScore || res.totalScore || 0} PTS`;

      // Apply restored game state
      if (res.gameState) {
        applyGameState(res.gameState);
      }

      // Check if already submitted
      if (res.submissionStatus && res.submissionStatus.hasSubmitted) {
        hasSubmittedCurrent = true;
        const sub = res.submissionStatus;
        const awarded = Number(sub.awardedPoints) || 0;
        const isApproved = sub.judgeStatus === 'APPROVED' || (awarded > 0);
        currentSubmission = {
          questionId: activeQuestion ? activeQuestion.id : null,
          answer: sub.submittedAnswer || '',
          pointsAwarded: awarded,
          judgeStatus: sub.judgeStatus || 'AUTO',
          isCorrect: isApproved,
          totalScore: contestantProfile.totalScore || res.totalScore
        };
        lastSubmittedAnswer = sub.submittedAnswer || '';
        lockInputs();

        // Re-select MCQ option or fill ID input
        const isMcq = activeQuestion && (activeQuestion.type === 'MCQ' || activeQuestion.question_type === 'MCQ');
        if (isMcq) {
          const norm = (sub.submittedAnswer || '').trim().toUpperCase();
          mcqOptionButtons.forEach((btn) => {
            if ((btn.dataset.option || '').toUpperCase() === norm) {
              btn.classList.add('selected');
            }
          });
        } else if (inputAnswer) {
          inputAnswer.value = sub.submittedAnswer || '';
        }

        const currentPhase = res.gameState ? res.gameState.phase : '';
        if (currentPhase === 'REVEAL' || currentPhase === 'LEADERBOARD') {
          if (isApproved) {
            submittedAnswerStatus = 'CORRECT';
            if (elQuestionCard) elQuestionCard.className = 'question-card status-correct';
            showSubmissionStatus(`✓ Answer submitted: "${sub.submittedAnswer}" (Correct • +${awarded} PTS)`);
          } else if (sub.judgeStatus === 'PENDING') {
            submittedAnswerStatus = 'PENDING';
            if (elQuestionCard) elQuestionCard.className = 'question-card status-pending';
            showSubmissionStatus(`⏳ Answer submitted: "${sub.submittedAnswer}" (Under Judge Review)`);
          } else {
            submittedAnswerStatus = 'INCORRECT';
            if (elQuestionCard) elQuestionCard.className = 'question-card status-incorrect';
            showSubmissionStatus(`✗ Answer submitted: "${sub.submittedAnswer}" (0 PTS)`);
          }
        } else {
          if (elQuestionCard) elQuestionCard.className = 'question-card';
          if (sub.judgeStatus === 'PENDING') {
            showSubmissionStatus(`⏳ Answer Submitted: "${sub.submittedAnswer}" • Under Judge Review`);
          } else {
            showSubmissionStatus(`✓ Answer Recorded: "${sub.submittedAnswer}" • Awaiting Quizmaster reveal`);
          }
        }
      }
    } else {
      showLoginError(res?.error === 'INVALID_PIN' ? 'Invalid PIN. Station not found.' : 'Authentication failed.');
    }
  }

  function showLoginError(msg) {
    if (elLoginError) {
      elLoginError.textContent = msg;
      elLoginError.classList.remove('hidden');
    }
  }

  function hideLoginError() {
    if (elLoginError) {
      elLoginError.classList.add('hidden');
    }
  }

  // Socket Connection
  function initSocketConnection() {
    if (typeof io === 'undefined') return;

    socket = io();

    socket.on('connect', () => {
      elTerminalDot.className = 'status-dot online';
      elTerminalStatus.textContent = 'Connected (LAN)';

      // Auto-reconnect if PIN is stored
      const savedPin = localStorage.getItem('quizbee_pin');
      if (savedPin) {
        socket.emit('contestant:auth', { pin: savedPin }, (res) => {
          handleAuthResponse(res, savedPin);
        });
      }
    });

    socket.on('disconnect', () => {
      elTerminalDot.className = 'status-dot offline';
      elTerminalStatus.textContent = 'Disconnected';
    });

    // Authoritative session restore ack
    socket.on('contestant:session:restore', (res) => {
      if (res && res.success && res.contestant) {
        handleAuthResponse(res, res.contestant.pin);
      }
    });

    // Evicted if duplicate login
    socket.on('contestant:kicked', (data) => {
      localStorage.removeItem('quizbee_pin');
      alert(data.message || 'Logged in from another workstation.');
      location.reload();
    });

    // Score updates from server
    socket.on('contestant:score:update', (data) => {
      if (data && data.totalScore !== undefined) {
        elCurrentScore.textContent = `${data.totalScore} PTS`;
        if (contestantProfile) contestantProfile.totalScore = data.totalScore;
        if (currentSubmission) currentSubmission.totalScore = data.totalScore;
      }
    });

    socket.on('contestant:ruling:update', (data) => {
      if (data && data.status) {
        const isApproved = data.status === 'APPROVED';
        submittedAnswerStatus = isApproved ? 'CORRECT' : 'INCORRECT';
        if (currentSubmission) {
          currentSubmission.judgeStatus = data.status;
          currentSubmission.isCorrect = isApproved;
          if (isApproved && data.awardedPoints) {
            currentSubmission.pointsAwarded = data.awardedPoints;
          }
        }
        if (elQuestionCard) {
          elQuestionCard.className = isApproved ? 'question-card status-correct' : 'question-card status-incorrect';
        }
        const isMcq = activeQuestion && (activeQuestion.type === 'MCQ' || activeQuestion.question_type === 'MCQ');
        if (!isMcq && inputAnswer) {
          inputAnswer.style.borderColor = isApproved ? 'var(--color-success)' : 'var(--color-danger)';
        }
        showSubmissionStatus(
          isApproved
            ? `✓ Judge Approved! +${data.awardedPoints} Points Awarded.`
            : '✗ Judge Ruled: Submission not accepted.'
        );
        if (window.QuizAudio) {
          if (isApproved) window.QuizAudio.playCorrect();
          else window.QuizAudio.playIncorrect();
        }
      }
    });

    // Game lifecycle
    socket.on('game:phase:change', (data) => {
      const phase = data.newPhase || data.phase;
      if (data.state) {
        applyGameState(data.state);
      } else {
        handlePhaseTransition(phase);
      }
    });

    socket.on('game:tick', (data) => {
      const sec = data.remainingSeconds !== undefined ? data.remainingSeconds : Math.ceil(data.remainingMs / 1000);
      updateTimer(sec, data.remainingMs, data.totalDurationSeconds || 30);
      if (window.QuizAudio) {
        if (sec <= 5 && sec > 0) window.QuizAudio.playWarningTick();
        else if (sec > 5) window.QuizAudio.playTick();
      }
    });

    socket.on('game:question:lock', () => {
      lockInputs();
      if (elQuestionCard) {
        elQuestionCard.className = 'question-card';
      }
      if (!hasSubmittedCurrent) {
        submittedAnswerStatus = 'INCORRECT';
        showSubmissionStatus("Time's up! No submission recorded • Awaiting Quizmaster reveal");
      } else {
        const isMcq = activeQuestion && (activeQuestion.type === 'MCQ' || activeQuestion.question_type === 'MCQ');
        if (submittedAnswerStatus === 'PENDING') {
          showSubmissionStatus("Time's up! Answer recorded (masked) • Under Judge Review");
        } else {
          if (isMcq) {
            showSubmissionStatus("Time's up! Choice recorded & concealed • Awaiting Quizmaster reveal");
          } else {
            showSubmissionStatus("Time's up! Answer recorded (masked) • Awaiting Quizmaster reveal");
          }
        }
      }
      if (window.QuizAudio) window.QuizAudio.playLock();
    });

    socket.on('game:answer:reveal', (data) => {
      handleAnswerReveal(data);
    });
  }

  function applyGameState(state) {
    if (!state) return;
    const phase = state.phase;
    handlePhaseTransition(phase);

    if (state.currentQuestion) {
      const isNewQuestion = !activeQuestion || activeQuestion.id !== state.currentQuestion.id;
      if (isNewQuestion) {
        renderQuestion(state.currentQuestion);
      } else {
        activeQuestion = { ...activeQuestion, ...state.currentQuestion };
      }
    }
  }

  function handlePhaseTransition(phase) {
    elPhaseLabel.textContent = `${phase} PHASE`;

    switch (phase) {
      case 'LOBBY':
        elReadingLock.classList.add('hidden');
        elSubmissionStatus.classList.add('hidden');
        elMcqContainer.classList.add('hidden');
        elIdContainer.classList.add('hidden');
        elQuestionText.textContent = 'Waiting for Quizmaster to stage next question...';
        elCodeSnippet.classList.add('hidden');
        if (elQuestionCard) elQuestionCard.className = 'question-card';
        if (elItemBadge) elItemBadge.classList.add('hidden');
        activeQuestion = null;
        currentSubmission = null;
        hasSubmittedCurrent = false;
        submittedAnswerStatus = 'NONE';
        lastSubmittedAnswer = '';
        break;

      case 'READING':
        elReadingLock.classList.remove('hidden');
        elSubmissionStatus.classList.add('hidden');
        if (elQuestionCard) elQuestionCard.className = 'question-card';
        lockInputs();
        hasSubmittedCurrent = false;
        submittedAnswerStatus = 'NONE';
        currentSubmission = null;
        lastSubmittedAnswer = '';
        mcqOptionButtons.forEach((btn) => {
          btn.classList.remove('selected', 'is-correct', 'is-incorrect');
        });
        if (inputAnswer) {
          inputAnswer.value = '';
          inputAnswer.style.borderColor = '';
        }
        if (window.QuizAudio) window.QuizAudio.playPhaseChime();
        break;

      case 'COUNTDOWN':
        elReadingLock.classList.add('hidden');
        if (!hasSubmittedCurrent) {
          unlockInputs();
        } else {
          lockInputs();
        }
        break;

      case 'PAUSED':
        lockInputs();
        break;

      case 'LOCKED':
        lockInputs();
        elReadingLock.classList.add('hidden');
        break;

      case 'REVEAL':
      case 'LEADERBOARD':
        lockInputs();
        break;
    }
  }

  function renderQuestion(q) {
    if (!q) return;
    activeQuestion = q;
    hasSubmittedCurrent = false;
    currentSubmission = null;
    lastSubmittedAnswer = '';
    submittedAnswerStatus = 'NONE';

    if (elQuestionCard) {
      elQuestionCard.className = 'question-card';
    }
    if (elSubmissionStatus) {
      elSubmissionStatus.textContent = '';
      elSubmissionStatus.classList.add('hidden');
    }

    elRoundBadge.textContent = (q.round || 'ROUND').toUpperCase();

    if (elItemBadge) {
      if (q.item_number) {
        elItemBadge.textContent = `ITEM ${q.item_number}${q.total_items ? ' OF ' + q.total_items : ''}`;
        elItemBadge.classList.remove('hidden');
      } else {
        elItemBadge.classList.add('hidden');
      }
    }

    elPointBadge.textContent = `${q.points !== undefined ? q.points : 1} POINTS`;
    elQuestionText.textContent = q.question || q.question_text || '';

    if (q.code_snippet) {
      elCodeSnippet.classList.remove('hidden');
      elCodeContent.textContent = q.code_snippet;
    } else {
      elCodeSnippet.classList.add('hidden');
    }

    const isMcq = q.type === 'MCQ' || q.question_type === 'MCQ';
    if (elMcqContainer) elMcqContainer.classList.remove('is-locked');
    if (elIdContainer) elIdContainer.classList.remove('is-locked');
    if (btnPeekAnswer) {
      btnPeekAnswer.classList.add('hidden');
      btnPeekAnswer.textContent = '👁 Peek';
    }

    if (isMcq) {
      elIdContainer.classList.add('hidden');
      elMcqContainer.classList.remove('hidden');

      const opts = typeof q.options === 'string' ? JSON.parse(q.options) : (q.options || {});
      ['A', 'B', 'C', 'D'].forEach((letter) => {
        const textEl = document.getElementById(`text-opt-${letter.toLowerCase()}`);
        if (textEl) textEl.textContent = opts[letter] || `Option ${letter}`;
      });

      // Clear selections and correctness indicators
      mcqOptionButtons.forEach((btn) => {
        btn.classList.remove('selected', 'is-correct', 'is-incorrect');
      });
    } else {
      elMcqContainer.classList.add('hidden');
      elIdContainer.classList.remove('hidden');
      if (inputAnswer) {
        inputAnswer.value = '';
        inputAnswer.type = 'text';
        inputAnswer.classList.remove('is-masked');
        inputAnswer.style.borderColor = '';
      }
    }
  }

  function updateTimer(seconds, remainingMs, totalSeconds) {
    if (!elTimerValue) return;
    const sec = Math.max(0, seconds);
    elTimerValue.textContent = `${sec}s`;

    const totalMs = (totalSeconds || 30) * 1000;
    const currentMs = remainingMs !== undefined ? remainingMs : sec * 1000;
    const percent = Math.max(0, Math.min(100, (currentMs / totalMs) * 100));

    if (elTimerBar) {
      elTimerBar.style.width = `${percent}%`;
      if (sec <= 5) {
        elTimerBar.className = 'timer-bar-fill danger';
      } else if (sec <= 10) {
        elTimerBar.className = 'timer-bar-fill warning';
      } else {
        elTimerBar.className = 'timer-bar-fill';
      }
    }
  }

  // Submission Handling
  function setupSubmissionEvents() {
    // MCQ Option Clicks
    mcqOptionButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (hasSubmittedCurrent || !activeQuestion) return;
        const selectedOption = btn.dataset.option;

        mcqOptionButtons.forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');

        submitAnswer(selectedOption);
      });
    });

    // Identification Form Submit
    if (btnSubmitAnswer) {
      btnSubmitAnswer.addEventListener('click', () => {
        if (hasSubmittedCurrent || !activeQuestion) return;
        const ans = inputAnswer.value.trim();
        if (!ans) {
          alert('Please enter an answer before submitting.');
          return;
        }
        submitAnswer(ans);
      });
    }

    if (inputAnswer) {
      inputAnswer.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          btnSubmitAnswer.click();
        }
      });
    }

    // Discreet Peek Button for Identification
    if (btnPeekAnswer) {
      btnPeekAnswer.addEventListener('click', () => {
        if (!inputAnswer) return;
        if (inputAnswer.type === 'password') {
          inputAnswer.type = 'text';
          inputAnswer.classList.remove('is-masked');
          btnPeekAnswer.textContent = '🔒 Hide';
        } else {
          inputAnswer.type = 'password';
          inputAnswer.classList.add('is-masked');
          btnPeekAnswer.textContent = '👁 Peek';
        }
      });
    }
  }

  function submitAnswer(answerText) {
    if (!socket || !activeQuestion) return;

    hasSubmittedCurrent = true;
    lastSubmittedAnswer = answerText;
    lockInputs();

    const isMcq = activeQuestion && (activeQuestion.type === 'MCQ' || activeQuestion.question_type === 'MCQ');
    if (isMcq) {
      showSubmissionStatus('Submitting choice...');
    } else {
      showSubmissionStatus('Submitting answer (masked)...');
    }

    socket.emit('contestant:submit', {
      questionId: activeQuestion.id,
      answer: answerText
    }, (ack) => {
      if (ack && ack.success) {
        const isPending = ack.judgeStatus === 'PENDING';
        const isCorrect = (ack.pointsAwarded > 0);
        currentSubmission = {
          questionId: activeQuestion.id,
          answer: answerText,
          pointsAwarded: ack.pointsAwarded || 0,
          judgeStatus: ack.judgeStatus || 'AUTO',
          isCorrect: isCorrect,
          totalScore: ack.totalScore
        };

        // Keep container border neutral during countdown
        if (elQuestionCard) {
          elQuestionCard.className = 'question-card';
        }

        if (isPending) {
          submittedAnswerStatus = 'PENDING';
          showSubmissionStatus('⏳ Answer Submitted (Masked) • Under Judge Review');
        } else {
          submittedAnswerStatus = isCorrect ? 'CORRECT' : 'INCORRECT';
          if (isMcq) {
            showSubmissionStatus('✓ Choice Recorded & Concealed • Awaiting Quizmaster reveal');
          } else {
            showSubmissionStatus('✓ Answer Recorded (Masked) • Awaiting Quizmaster reveal');
          }
        }
      } else {
        showSubmissionStatus(`Submission: ${ack?.error || 'Rejected by server'}`);
      }
    });
  }

  function handleAnswerReveal(data) {
    if (!data) return;
    const officialAnswer = (data.correctAnswer || '').trim();
    const correctUpper = officialAnswer.toUpperCase();

    // Release stealth disguise on reveal
    if (elMcqContainer) elMcqContainer.classList.remove('is-locked');
    if (elIdContainer) elIdContainer.classList.remove('is-locked');
    if (inputAnswer) {
      inputAnswer.type = 'text';
      inputAnswer.classList.remove('is-masked');
    }
    if (btnPeekAnswer) {
      btnPeekAnswer.classList.add('hidden');
    }

    // 1. If MCQ, highlight the official correct option in green
    const isMcq = activeQuestion && (activeQuestion.type === 'MCQ' || activeQuestion.question_type === 'MCQ');
    if (isMcq) {
      mcqOptionButtons.forEach((btn) => {
        const opt = (btn.dataset.option || '').toUpperCase();
        if (opt === correctUpper) {
          btn.classList.add('is-correct');
        } else if (btn.classList.contains('selected') && opt !== correctUpper) {
          btn.classList.add('is-incorrect');
        }
      });
    }

    // 2. Determine contestant correctness
    const contestantAnswer = currentSubmission ? currentSubmission.answer : lastSubmittedAnswer;
    if (hasSubmittedCurrent && contestantAnswer) {
      const isMcqMatch = isMcq && contestantAnswer && correctUpper && (contestantAnswer.trim().toUpperCase() === correctUpper);
      const isCorrect = (currentSubmission && currentSubmission.pointsAwarded > 0) || isMcqMatch || (currentSubmission && currentSubmission.judgeStatus === 'APPROVED');
      const isPending = currentSubmission && currentSubmission.judgeStatus === 'PENDING';

      if (isCorrect) {
        submittedAnswerStatus = 'CORRECT';
        if (elQuestionCard) elQuestionCard.className = 'question-card status-correct';
        if (!isMcq && inputAnswer) inputAnswer.style.borderColor = 'var(--color-success)';
        const pts = (currentSubmission && currentSubmission.pointsAwarded) || (activeQuestion ? activeQuestion.points : 1);
        showSubmissionStatus(`✓ Correct! Official Answer: "${officialAnswer}" • +${pts} Points Awarded`);
        if (window.QuizAudio) window.QuizAudio.playCorrect();
        if (currentSubmission && currentSubmission.totalScore !== undefined) {
          elCurrentScore.textContent = `${currentSubmission.totalScore} PTS`;
          if (contestantProfile) contestantProfile.totalScore = currentSubmission.totalScore;
        }
      } else if (isPending) {
        submittedAnswerStatus = 'PENDING';
        if (elQuestionCard) elQuestionCard.className = 'question-card status-pending';
        showSubmissionStatus(`Official Answer: "${officialAnswer}" • Your answer ("${contestantAnswer}") is under Judge Review`);
      } else {
        submittedAnswerStatus = 'INCORRECT';
        if (elQuestionCard) elQuestionCard.className = 'question-card status-incorrect';
        if (!isMcq && inputAnswer) inputAnswer.style.borderColor = 'var(--color-danger)';
        showSubmissionStatus(`✗ Incorrect. Official Answer: "${officialAnswer}" • Your answer: "${contestantAnswer}"`);
        if (window.QuizAudio) window.QuizAudio.playIncorrect();
      }
    } else {
      submittedAnswerStatus = 'INCORRECT';
      if (elQuestionCard) elQuestionCard.className = 'question-card status-incorrect';
      showSubmissionStatus(`✗ Official Answer: "${officialAnswer}" • No submission recorded.`);
      if (window.QuizAudio) window.QuizAudio.playIncorrect();
    }
  }

  function showSubmissionStatus(msg) {
    if (elSubmissionStatus) {
      elSubmissionStatus.textContent = msg;
      elSubmissionStatus.classList.remove('hidden');
    }
  }

  function lockInputs() {
    mcqOptionButtons.forEach((btn) => {
      btn.disabled = true;
    });
    if (elMcqContainer) {
      elMcqContainer.classList.add('is-locked');
    }
    if (elIdContainer) {
      elIdContainer.classList.add('is-locked');
    }
    if (inputAnswer) {
      inputAnswer.disabled = true;
      if (hasSubmittedCurrent || inputAnswer.value) {
        inputAnswer.type = 'password';
        inputAnswer.classList.add('is-masked');
        if (btnPeekAnswer) {
          btnPeekAnswer.classList.remove('hidden');
          btnPeekAnswer.textContent = '👁 Peek';
        }
      }
    }
    if (btnSubmitAnswer) btnSubmitAnswer.disabled = true;
  }

  function unlockInputs() {
    mcqOptionButtons.forEach((btn) => {
      btn.disabled = false;
    });
    if (elMcqContainer) {
      elMcqContainer.classList.remove('is-locked');
    }
    if (elIdContainer) {
      elIdContainer.classList.remove('is-locked');
    }
    if (inputAnswer) {
      inputAnswer.disabled = false;
      inputAnswer.type = 'text';
      inputAnswer.classList.remove('is-masked');
      inputAnswer.focus();
    }
    if (btnPeekAnswer) {
      btnPeekAnswer.classList.add('hidden');
      btnPeekAnswer.textContent = '👁 Peek';
    }
    if (btnSubmitAnswer) btnSubmitAnswer.disabled = false;
  }

  // =========================================================================
  // Anti-Cheat Enforcement
  // =========================================================================

  function reportIncident(type, details = '') {
    if (!currentPin || !socket) return;
    const now = Date.now();
    if (lastIncidentReportTime[type] && now - lastIncidentReportTime[type] < DEBOUNCE_INCIDENT_MS) {
      return;
    }
    lastIncidentReportTime[type] = now;

    socket.emit('contestant:incident', {
      pin: currentPin,
      type,
      details,
      timestamp: now
    });
  }

  function requestFullscreenMode() {
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  function setupAntiCheatGuards() {
    // 1. Fullscreen Change
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && currentPin) {
        reportIncident('FULLSCREEN_EXIT', 'Contestant exited browser fullscreen mode');
        if (modalFullscreenWarning) modalFullscreenWarning.classList.remove('hidden');
      }
    });

    if (btnReenterFullscreen) {
      btnReenterFullscreen.addEventListener('click', () => {
        requestFullscreenMode();
        modalFullscreenWarning.classList.add('hidden');
      });
    }

    // 2. Window Blur & Visibility Change
    window.addEventListener('blur', () => {
      if (currentPin) reportIncident('WINDOW_BLUR', 'Window lost focus');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && currentPin) {
        reportIncident('TAB_SWITCH', 'Browser tab switched or minimized');
      }
    });

    // 3. Block Shortcuts & Developer Tools (F12, Ctrl+U, Ctrl+R, etc.)
    window.addEventListener('keydown', (e) => {
      const key = e.key;
      const ctrl = e.ctrlKey || e.metaKey;

      // DevTools
      if (key === 'F12' || (ctrl && e.shiftKey && ['I', 'J', 'C', 'i', 'j', 'c'].includes(key))) {
        e.preventDefault();
        reportIncident('DEVTOOLS', `Attempted to open DevTools: ${key}`);
        return false;
      }

      // Page inspection / refresh
      if ((ctrl && ['u', 'U', 'r', 'R', 'p', 'P', 's', 'S'].includes(key)) || key === 'F5') {
        e.preventDefault();
        reportIncident('KEY_SHORTCUT', `Blocked key combination: ${key}`);
        return false;
      }

      // Clipboard shortcuts outside input
      if (ctrl && ['c', 'C', 'v', 'V', 'x', 'X'].includes(key)) {
        if (e.target.tagName !== 'INPUT') {
          e.preventDefault();
          reportIncident(key.toLowerCase() === 'v' ? 'PASTE_ATTEMPT' : 'COPY_ATTEMPT', 'Clipboard shortcut outside input');
          return false;
        }
      }
    }, true);

    // 4. Disable Context Menu & Raw Clipboard Events
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      reportIncident('SHORTCUT_BLOCKED', 'Right-click context menu blocked');
    });

    document.addEventListener('copy', (e) => {
      if (e.target.tagName !== 'INPUT') {
        e.preventDefault();
        reportIncident('COPY_ATTEMPT', 'Copy blocked');
      }
    });

    document.addEventListener('paste', (e) => {
      if (e.target.tagName !== 'INPUT') {
        e.preventDefault();
        reportIncident('PASTE_ATTEMPT', 'Paste blocked');
      }
    });
  }

  // Auto-run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
