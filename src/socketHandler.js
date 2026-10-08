/**
 * src/socketHandler.js - Authoritative Real-Time WebSocket Gateway & Event Registry
 * OLFU IT Olympics LAN Quiz Bee System (ITPM 311)
 *
 * Coordinates:
 * - Socket.io role rooms (room:quizmaster, room:contestants, room:projector, room:judges, contestant:${pin})
 * - NTP-lite LAN clock sync with ±1ms precision (sync:ping / sync:pong)
 * - Contestant PIN authentication, session re-attachment, and duplicate socket eviction
 * - Authoritative tournament control event routing (reading, countdown, lock, reveal, leaderboard)
 * - Contestant submission ingestion, late-submission gating, and grading
 * - Anti-cheat incident debouncing and telemetry broadcasting
 * - Judge dispute review queue and real-time score recalculation
 */

const { TIMING } = require('./config');
const TelemetryManager = require('./telemetryManager');

class SocketHandler {
  /**
   * @param {import('socket.io').Server} io - Socket.io server instance
   * @param {import('./gameEngine')} gameEngine - Authoritative GameEngine instance
   * @param {Object} db - Authoritative SQLite DB module (src/db.js)
   * @param {TelemetryManager|Object} [telemetryManager] - TelemetryManager instance or options
   * @param {Object} [options={}] - Additional configuration options
   */
  constructor(io, gameEngine, db, telemetryManager = null, options = {}) {
    this.io = io;
    this.engine = gameEngine;
    this.db = (db && typeof db.getContestantByPin === 'function') ? db : require('./db');

    // Resolve TelemetryManager instance
    if (telemetryManager instanceof TelemetryManager || (telemetryManager && typeof telemetryManager.ingestIncident === 'function')) {
      this.telemetryManager = telemetryManager;
      this.options = options || {};
    } else {
      const opts = (telemetryManager && typeof telemetryManager === 'object') ? telemetryManager : (options || {});
      this.options = opts;
      this.telemetryManager = new TelemetryManager({ db: this.db, ...opts });
    }

    this.graceWindowMs = this.options.graceWindowMs || TIMING?.GRACE_WINDOW_MS || 300;

    // Active session registries
    this.activeSocketsByPin = new Map(); // pin -> Socket
    this.socketToPin = new Map();        // socket.id -> pin
    this.submissionCounts = new Set();   // pins that submitted for the current question

    this._bindEngineEvents();
    this._bindSocketConnection();
  }

  // =========================================================================
  // 1. GAME ENGINE STATE BROADCAST HOOKS
  // =========================================================================

  _bindEngineEvents() {
    // Authoritative Phase Change Hook
    this.engine.on('phase:change', ({ prevPhase, newPhase, state, autoExpired }) => {
      if (newPhase === 'READING') {
        this.submissionCounts.clear();
        this.telemetryManager.resetSubmissions();
      }

      // 1. Broadcast unredacted state to Quizmaster
      this.io.to('room:quizmaster').emit('game:phase:change', {
        prevPhase,
        newPhase,
        autoExpired: !!autoExpired,
        state
      });

      // 2. Broadcast unredacted state to Judges
      this.io.to('room:judges').emit('game:phase:change', {
        prevPhase,
        newPhase,
        autoExpired: !!autoExpired,
        state
      });

      // 3. Broadcast sanitized state to Contestants & Projector
      const sanitizedState = this._sanitizeGameState(state);
      this.io.to('room:contestants').to('room:projector').emit('game:phase:change', {
        prevPhase,
        newPhase,
        autoExpired: !!autoExpired,
        state: sanitizedState
      });

      // Phase-specific dispatch
      if (newPhase === 'LOCKED') {
        const questionId = state.currentQuestion ? state.currentQuestion.id : null;
        this.io.emit('game:question:lock', {
          questionId,
          reason: autoExpired ? 'TIMEOUT' : 'FORCE_LOCK'
        });
      } else if (newPhase === 'REVEAL' && state.currentQuestion) {
        this.io.emit('game:answer:reveal', {
          questionId: state.currentQuestion.id,
          correctAnswer: state.currentQuestion.correct_answer,
          explanation: state.currentQuestion.explanation || ''
        });
      } else if (newPhase === 'LEADERBOARD') {
        const leaderboard = this.db.getLeaderboard(state.roundId);
        this.io.emit('game:leaderboard', {
          roundId: state.roundId,
          leaderboard
        });
        this.io.emit('leaderboard:update', { leaderboard });
      }
    });

    // Authoritative Timer Tick Heartbeat
    this.engine.on('tick', (tickData) => {
      this.io.emit('game:tick', tickData);
    });
  }

  /**
   * Sanitizes game state to prevent leaking correct answers and synonyms to contestant clients
   * @param {Object} state
   * @returns {Object|null}
   */
  _sanitizeGameState(state) {
    if (!state) return null;
    const sanitized = {
      phase: state.phase,
      roundId: state.roundId,
      timer: { ...state.timer },
      currentQuestion: null
    };

    if (state.currentQuestion) {
      const q = state.currentQuestion;
      sanitized.currentQuestion = {
        id: q.id,
        round_id: q.round_id || q.roundId || 1,
        round: q.round || q.round_name || (q.round_id ? `Round ${q.round_id}` : 'Round'),
        round_name: q.round_name || q.round || '',
        question: q.question || q.question_text || q.questionText || q.text || '',
        question_text: q.question_text || q.question || q.questionText || q.text || '',
        code_snippet: q.code_snippet || q.codeSnippet || '',
        question_type: q.question_type || q.questionType || q.type || 'MCQ',
        type: q.type || q.question_type || 'MCQ',
        options: typeof q.options === 'string' ? JSON.parse(q.options) : (q.options || {}),
        points: q.points !== undefined ? q.points : 1,
        timer_seconds: q.timer_seconds || q.timerSeconds || 15,
        item_number: q.item_number || q.itemNumber || null,
        total_items: q.total_round_questions || q.total_items || null,
        overall_item_number: q.overall_item_number || null,
        total_questions: q.total_questions || null
      };
    }

    return sanitized;
  }

  /**
   * Helper to verify socket role before administrative actions
   * @private
   */
  _requireRole(socket, expectedRole, callback) {
    const ack = typeof callback === 'function' ? callback : () => {};
    if (socket.data?.role !== expectedRole) {
      const errRes = {
        success: false,
        error: 'UNAUTHORIZED_ROLE',
        message: `Action requires ${expectedRole} role`
      };
      ack(errRes);
      socket.emit('error', errRes);
      return false;
    }
    return true;
  }

  // =========================================================================
  // 2. SOCKET CONNECTION & ROLE ROUTING
  // =========================================================================

  _bindSocketConnection() {
    this.io.on('connection', (socket) => {
      // 1. NTP-Lite LAN Clock Sync (±1ms precision)
      socket.on('sync:ping', (payload) => {
        const serverReceiptTime = Date.now();
        const clientT1 = payload ? payload.t1 : 0;
        socket.emit('sync:pong', {
          t1: clientT1,
          t2: serverReceiptTime,
          t3: Date.now()
        });
      });

      // 2. Role Join: Quizmaster
      socket.on('qm:join', (payloadOrCallback, maybeCallback) => {
        const callback = typeof maybeCallback === 'function' ? maybeCallback : (typeof payloadOrCallback === 'function' ? payloadOrCallback : null);

        // Security Guard: Contestant sockets cannot join Quizmaster room
        if (socket.data?.role === 'CONTESTANT') {
          const errRes = { success: false, error: 'UNAUTHORIZED_ROLE', message: 'Contestants cannot join Quizmaster room' };
          if (callback) callback(errRes);
          socket.emit('error', errRes);
          return;
        }

        socket.join('room:quizmaster');
        socket.data = socket.data || {};
        socket.data.role = 'QUIZMASTER';
        socket.data.authenticated = true;

        const snapshot = this.telemetryManager.getSnapshot();
        const response = {
          success: true,
          gameState: this.engine.getState(),
          telemetryGrid: snapshot.terminals,
          summary: snapshot.summary
        };

        if (callback) callback(response);
        socket.emit('qm:init', response);
      });

      // Quizmaster manual telemetry refresh request
      socket.on('qm:telemetry:request', (payloadOrCallback, maybeCallback) => {
        const callback = typeof maybeCallback === 'function' ? maybeCallback : (typeof payloadOrCallback === 'function' ? payloadOrCallback : () => {});
        if (!this._requireRole(socket, 'QUIZMASTER', callback)) return;

        const snapshot = this.telemetryManager.getSnapshot();
        callback(snapshot);
        socket.emit('qm:telemetry:snapshot', snapshot);
      });

      // 3. Role Join: Projector Display
      socket.on('projector:join', (payloadOrCallback, maybeCallback) => {
        const callback = typeof maybeCallback === 'function' ? maybeCallback : (typeof payloadOrCallback === 'function' ? payloadOrCallback : null);

        // Security Guard: Contestants cannot switch to Projector role
        if (socket.data?.role === 'CONTESTANT') {
          const errRes = { success: false, error: 'UNAUTHORIZED_ROLE', message: 'Contestants cannot join Projector room' };
          if (callback) callback(errRes);
          return;
        }

        socket.join('room:projector');
        socket.data = socket.data || {};
        socket.data.role = 'PROJECTOR';

        const sanitizedState = this._sanitizeGameState(this.engine.getState());
        const response = { success: true, gameState: sanitizedState };
        if (callback) callback(response);
        socket.emit('projector:init', response);
      });

      // 4. Role Join: Judge / Tabulator Panel
      socket.on('judge:join', (payloadOrCallback, maybeCallback) => {
        const callback = typeof maybeCallback === 'function' ? maybeCallback : (typeof payloadOrCallback === 'function' ? payloadOrCallback : null);

        // Security Guard: Contestants cannot join Judge room
        if (socket.data?.role === 'CONTESTANT') {
          const errRes = { success: false, error: 'UNAUTHORIZED_ROLE', message: 'Contestants cannot join Judge room' };
          if (callback) callback(errRes);
          socket.emit('error', errRes);
          return;
        }

        socket.join('room:judges');
        socket.data = socket.data || {};
        socket.data.role = 'JUDGE';
        socket.data.authenticated = true;

        const pendingRaw = typeof this.db.getPendingRulings === 'function' ? this.db.getPendingRulings() : [];
        const pending = this._formatPendingDisputes(pendingRaw);
        const response = {
          success: true,
          gameState: this.engine.getState(),
          pendingDisputes: pending
        };
        if (callback) callback(response);
        socket.emit('judge:init', response);
      });

      // Judge queue request
      socket.on('judge:queue:get', (payloadOrCallback, maybeCallback) => {
        const callback = typeof maybeCallback === 'function' ? maybeCallback : (typeof payloadOrCallback === 'function' ? payloadOrCallback : () => {});
        if (!this._requireRole(socket, 'JUDGE', callback)) return;
        const pendingRaw = typeof this.db.getPendingRulings === 'function' ? this.db.getPendingRulings() : [];
        const pending = this._formatPendingDisputes(pendingRaw);
        const response = { success: true, items: pending };
        callback(response);
        socket.emit('judge:queue:response', response);
      });

      // 5. Contestant Authentication & Session Re-attachment
      socket.on('contestant:auth', (payload, callback) => {
        this._handleContestantAuth(socket, payload, callback);
      });

      // 6. Contestant Answer Submission
      socket.on('contestant:submit', (payload, callback) => {
        this._handleContestantSubmit(socket, payload, callback);
      });

      // 7. Contestant Anti-Cheat Telemetry Ingestion
      socket.on('contestant:incident', (payload) => {
        this._handleContestantIncident(socket, payload);
      });

      // 8. Judge Dispute Ruling Action
      socket.on('judge:dispute:action', (payload, callback) => {
        this._handleJudgeAction(socket, payload, callback);
      });

      // 9. Authoritative Tournament FSM Controls
      this._bindQuizmasterControls(socket);

      // 10. Disconnection Handling
      socket.on('disconnect', (reason) => {
        this._handleDisconnect(socket, reason);
      });
    });
  }

  // =========================================================================
  // 3. CONTESTANT AUTHENTICATION & DUPLICATE EVICTION
  // =========================================================================

  _handleContestantAuth(socket, payload, callback) {
    const ack = typeof callback === 'function' ? callback : () => {};

    if (!payload || !payload.pin) {
      const errRes = { success: false, error: 'INVALID_PIN' };
      ack(errRes);
      socket.emit('contestant:auth:ack', errRes);
      return;
    }

    const pin = String(payload.pin).trim();
    const contestant = this.db.getContestantByPin(pin);

    if (!contestant) {
      const errRes = { success: false, error: 'INVALID_PIN' };
      ack(errRes);
      socket.emit('contestant:auth:ack', errRes);
      return;
    }

    // 1. Authoritative Duplicate Session Eviction Protocol
    const existingSocket = this.activeSocketsByPin.get(pin);
    if (existingSocket && existingSocket.id !== socket.id) {
      existingSocket.emit('contestant:kicked', {
        reason: 'DUPLICATE_LOGIN',
        message: 'Your session has been resumed from another workstation or browser window.',
        timestamp: Date.now()
      });

      existingSocket.leave('room:contestants');
      existingSocket.leave(`contestant:${pin}`);
      existingSocket.disconnect(true);

      this.socketToPin.delete(existingSocket.id);
    }

    // 2. Bind new socket to workstation session
    this.activeSocketsByPin.set(pin, socket);
    this.socketToPin.set(socket.id, pin);

    socket.data = socket.data || {};
    socket.data.authenticated = true;
    socket.data.role = 'CONTESTANT';
    socket.data.pin = pin;
    socket.data.contestantId = contestant.id;
    socket.data.terminalNumber = contestant.terminal_number;

    socket.join('room:contestants');
    socket.join(`contestant:${pin}`);

    // Update database connection state
    this.db.updateContestantConnection(pin, true, socket.id);

    // Update Telemetry Engine presence
    this.telemetryManager.handleConnect(pin, socket.id, socket.handshake?.address);

    // 3. Session Rehydration
    const engineState = this.engine.getState();
    const sanitizedState = this._sanitizeGameState(engineState);

    let submittedAnswer = null;
    let hasSubmitted = false;
    let judgeStatus = null;
    let awardedPoints = 0;

    if (engineState.currentQuestion) {
      const priorSub = typeof this.db.getSubmission === 'function'
        ? this.db.getSubmission(contestant.id, engineState.currentQuestion.id)
        : null;

      if (priorSub) {
        hasSubmitted = true;
        submittedAnswer = priorSub.submitted_answer;
        judgeStatus = priorSub.judge_status;
        awardedPoints = priorSub.awarded_points;
      }
    }

    const restorePayload = {
      success: true,
      contestant: {
        id: contestant.id,
        pin: contestant.pin,
        terminalNumber: contestant.terminal_number,
        studentId: contestant.student_id,
        fullName: contestant.full_name,
        department: contestant.department_or_section,
        totalScore: contestant.total_score
      },
      gameState: sanitizedState,
      submissionStatus: {
        hasSubmitted,
        submittedAnswer,
        judgeStatus,
        awardedPoints
      },
      session: {
        hasSubmitted,
        submittedAnswer,
        judgeStatus,
        awardedPoints
      }
    };

    ack(restorePayload);
    socket.emit('contestant:session:restore', restorePayload);
    socket.emit('contestant:auth:ack', restorePayload);

    // Broadcast presence update to Quizmaster
    this.io.to('room:quizmaster').emit('qm:telemetry:connection', {
      pin: contestant.pin,
      terminalNumber: contestant.terminal_number,
      isConnected: true,
      socketId: socket.id,
      timestamp: Date.now()
    });
    this.io.to('room:quizmaster').emit('qm:telemetry:presence', {
      pin: contestant.pin,
      terminalNumber: contestant.terminal_number,
      isConnected: true,
      timestamp: Date.now()
    });
  }

  _handleDisconnect(socket, reason) {
    const pin = this.socketToPin.get(socket.id);
    if (!pin) return;

    if (this.activeSocketsByPin.get(pin) === socket) {
      this.activeSocketsByPin.delete(pin);
      this.socketToPin.delete(socket.id);

      this.db.updateContestantConnection(pin, false, null);
      this.telemetryManager.handleDisconnect(pin, socket.id);

      const contestant = this.db.getContestantByPin(pin);
      const terminalNumber = contestant ? contestant.terminal_number : null;

      this.io.to('room:quizmaster').emit('qm:telemetry:connection', {
        pin,
        terminalNumber,
        isConnected: false,
        timestamp: Date.now(),
        reason
      });
      this.io.to('room:quizmaster').emit('qm:telemetry:presence', {
        pin,
        terminalNumber,
        isConnected: false,
        timestamp: Date.now()
      });
    }
  }

  // =========================================================================
  // 4. SUBMISSION INGESTION & EVALUATION
  // =========================================================================

  _handleContestantSubmit(socket, payload, callback) {
    const ack = typeof callback === 'function' ? callback : () => {};
    const serverTimestamp = Date.now();

    // 1. Authoritative Late Submission Gate
    const gate = this.engine.canAcceptSubmission(serverTimestamp);
    if (!gate.allowed) {
      const errRes = {
        success: false,
        error: gate.reason || 'SUBMISSIONS_LOCKED',
        pointsAwarded: 0,
        serverTimeMs: serverTimestamp
      };
      ack(errRes);
      socket.emit('contestant:submit:ack', errRes);
      return;
    }

    // Enforce authenticated contestant session
    if (!socket.data?.authenticated || socket.data?.role !== 'CONTESTANT' || !socket.data?.pin) {
      const errRes = { success: false, error: 'UNAUTHORIZED', pointsAwarded: 0, serverTimeMs: serverTimestamp };
      ack(errRes);
      socket.emit('contestant:submit:ack', errRes);
      return;
    }

    const pin = socket.data.pin;
    // Reject any payload that attempts to submit on behalf of a different PIN
    if (payload?.pin && String(payload.pin) !== String(pin)) {
      const errRes = { success: false, error: 'PIN_MISMATCH', pointsAwarded: 0, serverTimeMs: serverTimestamp };
      ack(errRes);
      socket.emit('contestant:submit:ack', errRes);
      return;
    }

    const contestant = typeof this.db.getContestantByPin === 'function'
      ? this.db.getContestantByPin(pin)
      : null;
    if (!contestant) {
      const errRes = { success: false, error: 'CONTESTANT_NOT_FOUND', pointsAwarded: 0, serverTimeMs: serverTimestamp };
      ack(errRes);
      socket.emit('contestant:submit:ack', errRes);
      return;
    }

    const currentQ = this.engine.state.currentQuestion;
    const targetQId = Number(payload ? payload.questionId : null);
    if (!currentQ || currentQ.id !== targetQId) {
      const errRes = { success: false, error: 'INVALID_QUESTION_ID', pointsAwarded: 0, serverTimeMs: serverTimestamp };
      ack(errRes);
      socket.emit('contestant:submit:ack', errRes);
      return;
    }

    // 2. Duplicate submission check (with defensive fallback if getSubmission not exported)
    let existingSub = null;
    if (typeof this.db.getSubmission === 'function') {
      existingSub = this.db.getSubmission(contestant.id, currentQ.id);
    } else if (typeof this.db.getDb === 'function' && this.db.getDb()) {
      existingSub = this.db.getDb().prepare('SELECT * FROM SUBMISSIONS WHERE contestant_id = ? AND question_id = ?').get(contestant.id, currentQ.id);
    }
    if (existingSub) {
      const errRes = {
        success: false,
        error: 'DUPLICATE_SUBMISSION',
        pointsAwarded: 0,
        serverTimeMs: existingSub.server_time_ms
      };
      ack(errRes);
      socket.emit('contestant:submit:ack', errRes);
      return;
    }

    // 3. Evaluate Submission
    const rawAnswer = String(payload.answer ?? '').trim();
    let isCorrect = 0;
    let judgeStatus = 'AUTO';
    let awardedPoints = 0;

    const qType = currentQ.question_type || currentQ.type || 'MCQ';

    if (qType === 'MCQ') {
      const userClean = rawAnswer.toUpperCase();
      const correctClean = String(currentQ.correct_answer || currentQ.correctAnswer || '').trim().toUpperCase();
      isCorrect = userClean !== '' && userClean === correctClean ? 1 : 0;
      awardedPoints = isCorrect ? (currentQ.points || 1) : 0;
      judgeStatus = 'AUTO';
    } else {
      // IDENTIFICATION
      if (!rawAnswer) {
        // Empty or whitespace answers auto-fail and are NEVER queued to judges
        isCorrect = 0;
        awardedPoints = 0;
        judgeStatus = 'AUTO';
      } else {
        const normalize = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const userClean = normalize(rawAnswer);
        const correctClean = normalize(currentQ.correct_answer || currentQ.correctAnswer || '');

        const synonyms = this._extractSynonyms(currentQ);

        if (userClean === correctClean || synonyms.includes(userClean)) {
          isCorrect = 1;
          awardedPoints = currentQ.points || 2;
          judgeStatus = 'AUTO';
        } else {
          // Check similarity: only route plausible candidates (>= 30% match) to Judge review queue
          const maxSimilarity = this._calculateMaxSimilarity(userClean, correctClean, synonyms);
          if (maxSimilarity >= 0.30) {
            // Plausible candidate -> Enter Judge Review Queue
            isCorrect = 0;
            awardedPoints = 0;
            judgeStatus = 'PENDING';
          } else {
            // Obvious mismatch or far-off answer -> Auto-fail without cluttering judge queue
            isCorrect = 0;
            awardedPoints = 0;
            judgeStatus = 'AUTO';
          }
        }
      }
    }

    // 4. Atomically persist to SQLite
    let savedSub;
    try {
      savedSub = this.db.saveSubmission(
        contestant.id,
        currentQ.id,
        rawAnswer,
        serverTimestamp,
        isCorrect,
        judgeStatus,
        awardedPoints
      );
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        const errRes = { success: false, error: 'DUPLICATE_SUBMISSION', pointsAwarded: 0, serverTimeMs: serverTimestamp };
        ack(errRes);
        socket.emit('contestant:submit:ack', errRes);
        return;
      }
      const errRes = { success: false, error: 'SAVE_FAILED', details: err.message, serverTimeMs: serverTimestamp };
      ack(errRes);
      socket.emit('contestant:submit:ack', errRes);
      return;
    }

    // 5. Update state and telemetry
    this.submissionCounts.add(pin);
    this.telemetryManager.markSubmitted(pin);

    const updatedContestant = this.db.getContestantById(contestant.id);
    if (updatedContestant) {
      this.telemetryManager.updateScore(pin, updatedContestant.total_score);
    }

    // 6. Acknowledge contestant
    const ackPayload = {
      success: true,
      submissionId: savedSub ? savedSub.id : null,
      questionId: currentQ.id,
      submittedAnswer: rawAnswer,
      serverTimeMs: serverTimestamp,
      pointsAwarded: awardedPoints,
      judgeStatus,
      totalScore: updatedContestant ? updatedContestant.total_score : contestant.total_score
    };

    ack(ackPayload);
    socket.emit('contestant:submit:ack', ackPayload);

    // 7. Stream dispute to Judge Panel if PENDING
    if (judgeStatus === 'PENDING') {
      const syns = this._extractSynonyms(currentQ);
      const userClean = String(rawAnswer || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const correctClean = String(currentQ.correct_answer || currentQ.correctAnswer || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const similarityScore = this._calculateMaxSimilarity(userClean, correctClean, syns);

      this.io.to('room:judges').emit('judge:dispute:new', {
        submissionId: savedSub ? savedSub.id : null,
        contestantId: contestant.id,
        pin: contestant.pin,
        terminalNumber: contestant.terminal_number,
        fullName: contestant.full_name,
        questionId: currentQ.id,
        questionText: currentQ.question_text || currentQ.text,
        correctAnswer: currentQ.correct_answer || currentQ.correctAnswer,
        acceptableSynonyms: syns,
        synonyms: syns,
        submittedAnswer: rawAnswer,
        similarity: Math.round(similarityScore * 100),
        maxPoints: currentQ.points || 2,
        serverTimeMs: serverTimestamp,
        status: 'PENDING'
      });
    }

    // 8. Update Quizmaster submission counter
    const totalSubs = this.submissionCounts.size;
    this.io.to('room:quizmaster').emit('qm:telemetry:submission', {
      pin: contestant.pin,
      terminalNumber: contestant.terminal_number,
      hasSubmitted: true,
      totalSubmissions: totalSubs,
      serverTimeMs: serverTimestamp
    });
    this.io.to('room:quizmaster').emit('qm:submission:update', {
      questionId: currentQ.id,
      totalSubmissions: totalSubs,
      totalExpected: this.telemetryManager.totalTerminals,
      terminalNumber: contestant.terminal_number,
      pin: contestant.pin,
      judgeStatus,
      hasSubmitted: true,
      serverTimeMs: serverTimestamp
    });
  }

  _extractSynonyms(q) {
    if (!q) return [];
    const normalize = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

    if (Array.isArray(q.synonyms)) {
      return q.synonyms.map(normalize).filter(Boolean);
    }
    if (typeof q.acceptable_synonyms_json === 'string') {
      try {
        const parsed = JSON.parse(q.acceptable_synonyms_json);
        if (Array.isArray(parsed)) return parsed.map(normalize).filter(Boolean);
      } catch (_) {}
    }
    const raw = q.synonymsStr || q.synonyms;
    if (typeof raw === 'string') {
      return raw.split(';').map(normalize).filter(Boolean);
    }
    return [];
  }

  /**
   * Calculate string similarity between two strings (0.0 to 1.0)
   * Combines Levenshtein distance, substring containment, and word token overlap
   * @param {string} str1
   * @param {string} str2
   * @returns {number}
   */
  _calculateSimilarity(str1, str2) {
    const s1 = String(str1 || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const s2 = String(str2 || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s1 || !s2) return 0.0;
    if (s1 === s2) return 1.0;

    // Substring containment
    let substringScore = 0.0;
    if (s1.includes(s2) || s2.includes(s1)) {
      const minLen = Math.min(s1.length, s2.length);
      const maxLen = Math.max(s1.length, s2.length);
      substringScore = minLen / maxLen;
    }

    // Levenshtein edit distance using rolling buffers
    const m = s1.length;
    const n = s2.length;
    let prev = new Uint8Array(n + 1);
    let curr = new Uint8Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        curr[j] = s1[i - 1] === s2[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
      }
      prev.set(curr);
    }

    const editDistance = prev[n];
    const maxLen = Math.max(m, n);

    // For short words (<= 3 chars), changing 2 or more characters means a completely different word
    let levScore = 0.0;
    if (maxLen <= 3 && editDistance >= 2) {
      levScore = 0.0;
    } else {
      levScore = maxLen === 0 ? 1.0 : Math.max(0.0, 1.0 - (editDistance / maxLen));
    }

    // Word token overlap (Jaccard similarity on tokens)
    const words1 = s1.split(/\s+/).filter(Boolean);
    const words2 = s2.split(/\s+/).filter(Boolean);
    let wordScore = 0.0;
    if (words1.length > 0 && words2.length > 0) {
      const set2 = new Set(words2);
      const common = words1.filter(w => set2.has(w)).length;
      const union = new Set([...words1, ...words2]).size;
      wordScore = union === 0 ? 0 : (common / union);
    }

    return Math.max(levScore, substringScore, wordScore);
  }

  /**
   * Calculate maximum similarity between user input and target/synonyms
   * @param {string} userClean
   * @param {string} correctClean
   * @param {string[]} synonyms
   * @returns {number}
   */
  _calculateMaxSimilarity(userClean, correctClean, synonyms = []) {
    let max = this._calculateSimilarity(userClean, correctClean);
    for (const syn of synonyms) {
      const s = this._calculateSimilarity(userClean, syn);
      if (s > max) max = s;
      if (max >= 1.0) break;
    }
    return max;
  }

  /**
   * Enrich raw database pending rulings with calculated similarity
   * @param {Array<Object>} rows
   * @returns {Array<Object>}
   */
  _formatPendingDisputes(rows = []) {
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      let syns = [];
      if (row.acceptable_synonyms_json) {
        try {
          const parsed = JSON.parse(row.acceptable_synonyms_json);
          syns = Array.isArray(parsed) ? parsed : [];
        } catch (_) {}
      }
      const userClean = String(row.submitted_answer || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const correctClean = String(row.correct_answer || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const sim = this._calculateMaxSimilarity(userClean, correctClean, syns);
      return {
        ...row,
        similarity: Math.round(sim * 100)
      };
    });
  }

  // =========================================================================
  // 5. ANTI-CHEAT TELEMETRY INGESTION
  // =========================================================================

  _handleContestantIncident(socket, payload) {
    if (!payload) return;

    // Reject unauthenticated sockets or non-contestant roles
    if (!socket.data?.authenticated || socket.data?.role !== 'CONTESTANT' || !socket.data?.pin) {
      return;
    }

    const pin = socket.data.pin;
    // Reject spoofed incidents attempting to attribute incidents to other PINs
    if (payload.pin && String(payload.pin) !== String(pin)) {
      return;
    }

    // Always use authoritative server timestamp
    const serverTimestamp = Date.now();
    const result = this.telemetryManager.ingestIncident({
      pin,
      type: payload.type || payload.incidentType,
      details: payload.details,
      timestamp: serverTimestamp
    });

    if (result.accepted && result.alert) {
      this.io.to('room:quizmaster').emit('qm:telemetry:alert', result.alert);
      this.io.to('room:quizmaster').emit('qm:telemetry:update', result.alert);
    }
  }

  // =========================================================================
  // 6. JUDGE DISPUTE RESOLUTION
  // =========================================================================

  _handleJudgeAction(socket, payload, callback) {
    const ack = typeof callback === 'function' ? callback : () => {};

    if (!this._requireRole(socket, 'JUDGE', ack)) return;

    if (!payload || !payload.submissionId || !payload.status) {
      return ack({ success: false, error: 'INVALID_PAYLOAD' });
    }

    const submissionId = Number(payload.submissionId);
    const status = String(payload.status).toUpperCase();

    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return ack({ success: false, error: 'INVALID_STATUS', message: 'Status must be APPROVED or REJECTED' });
    }

    try {
      const sub = typeof this.db.getSubmissionById === 'function'
        ? this.db.getSubmissionById(submissionId)
        : null;

      if (!sub) {
        return ack({ success: false, error: 'SUBMISSION_NOT_FOUND' });
      }

      if (sub.judge_status !== 'PENDING') {
        return ack({ success: false, error: 'SUBMISSION_ALREADY_RULED', currentStatus: sub.judge_status });
      }

      const question = this.db.getQuestion(sub.question_id);
      const maxPoints = question ? question.points : 2;
      const awardedPoints = status === 'APPROVED'
        ? (payload.points !== undefined || payload.customPoints !== undefined
            ? Number(payload.points ?? payload.customPoints)
            : maxPoints)
        : 0;

      const updated = this.db.updateSubmissionRuling(submissionId, status, awardedPoints);
      const updatedContestant = this.db.getContestantById(sub.contestant_id);

      if (updatedContestant) {
        this.telemetryManager.updateScore(updatedContestant.pin, updatedContestant.total_score);
      }

      const resPayload = {
        success: true,
        submissionId,
        status,
        awardedPoints,
        contestantPin: updatedContestant ? updatedContestant.pin : null,
        terminalNumber: updatedContestant ? updatedContestant.terminal_number : null,
        contestantTotalScore: updatedContestant ? updatedContestant.total_score : 0,
        updated
      };

      ack(resPayload);

      // Broadcast resolution to all judges
      this.io.to('room:judges').emit('judge:dispute:resolved', {
        submissionId,
        status,
        awardedPoints,
        contestantId: sub.contestant_id,
        contestantPin: updatedContestant ? updatedContestant.pin : null,
        terminalNumber: updatedContestant ? updatedContestant.terminal_number : null
      });

      // Notify contestant privately
      if (updatedContestant) {
        const updateMsg = {
          submissionId,
          questionId: sub.question_id,
          status,
          awardedPoints,
          totalScore: updatedContestant.total_score
        };
        this.io.to(`contestant:${updatedContestant.pin}`).emit('contestant:score:update', updateMsg);
        this.io.to(`contestant:${updatedContestant.pin}`).emit('contestant:ruling:update', updateMsg);
      }

      // Dynamic Leaderboard Recalculation
      const roundId = this.engine.state.roundId;
      const updatedLeaderboard = this.db.getLeaderboard(roundId);
      this.io.emit('leaderboard:update', { leaderboard: updatedLeaderboard });
      this.io.emit('game:leaderboard', { roundId, leaderboard: updatedLeaderboard });

    } catch (err) {
      ack({ success: false, error: err.message });
    }
  }

  // =========================================================================
  // 7. AUTHORITATIVE QUIZMASTER CONTROLS
  // =========================================================================

  _bindQuizmasterControls(socket) {
    // Stage Question -> READING
    socket.on('qm:question:stage', (payloadOrCallback, maybeCallback) => {
      const ack = typeof maybeCallback === 'function' ? maybeCallback : (typeof payloadOrCallback === 'function' ? payloadOrCallback : () => {});
      const payload = (payloadOrCallback && typeof payloadOrCallback === 'object') ? payloadOrCallback : {};

      if (!this._requireRole(socket, 'QUIZMASTER', ack)) return;

      try {
        const questionId = payload ? (payload.questionId || payload.id) : null;
        const roundId = payload ? payload.roundId : null;
        const question = typeof this.db.getQuestion === 'function' ? this.db.getQuestion(questionId) : null;

        // Never stage a stub: if the DB layer is available and the question does not exist,
        // contestants would receive an empty question (no text/options).
        if (!questionId || (typeof this.db.getQuestion === 'function' && !question)) {
          const errRes = { success: false, error: 'QUESTION_NOT_FOUND', message: `Question ${questionId} not found in question bank` };
          socket.emit('error', errRes);
          return ack(errRes);
        }

        const state = this.engine.stageQuestion(question || questionId, roundId || (question ? question.round_id : 1));
        ack({ success: true, state });
      } catch (err) {
        ack({ success: false, error: err.message });
      }
    });

    // Start Countdown -> COUNTDOWN
    socket.on('qm:timer:start', (payloadOrCallback, maybeCallback) => {
      const ack = typeof maybeCallback === 'function' ? maybeCallback : (typeof payloadOrCallback === 'function' ? payloadOrCallback : () => {});
      const payload = (payloadOrCallback && typeof payloadOrCallback === 'object') ? payloadOrCallback : {};

      if (!this._requireRole(socket, 'QUIZMASTER', ack)) return;

      try {
        const duration = payload ? payload.durationSeconds : null;
        const state = this.engine.startCountdown(duration);
        ack({ success: true, state });
      } catch (err) {
        ack({ success: false, error: err.message });
      }
    });

    // Pause Countdown -> PAUSED
    socket.on('qm:timer:pause', (payloadOrCallback, maybeCallback) => {
      const ack = typeof maybeCallback === 'function' ? maybeCallback : (typeof payloadOrCallback === 'function' ? payloadOrCallback : () => {});
      if (!this._requireRole(socket, 'QUIZMASTER', ack)) return;

      try {
        const state = this.engine.pauseCountdown();
        ack({ success: true, state });
      } catch (err) {
        ack({ success: false, error: err.message });
      }
    });

    // Resume Countdown -> COUNTDOWN
    socket.on('qm:timer:resume', (payloadOrCallback, maybeCallback) => {
      const ack = typeof maybeCallback === 'function' ? maybeCallback : (typeof payloadOrCallback === 'function' ? payloadOrCallback : () => {});
      if (!this._requireRole(socket, 'QUIZMASTER', ack)) return;

      try {
        const state = this.engine.resumeCountdown();
        ack({ success: true, state });
      } catch (err) {
        ack({ success: false, error: err.message });
      }
    });

    // Force Lock -> LOCKED (supports qm:question:lock and qm:force:lock)
    const lockHandler = (payloadOrCallback, maybeCallback) => {
      const ack = typeof maybeCallback === 'function' ? maybeCallback : (typeof payloadOrCallback === 'function' ? payloadOrCallback : () => {});
      if (!this._requireRole(socket, 'QUIZMASTER', ack)) return;

      try {
        const state = this.engine.lockQuestion({ autoExpired: false });
        ack({ success: true, state });
      } catch (err) {
        ack({ success: false, error: err.message });
      }
    };
    socket.on('qm:question:lock', lockHandler);
    socket.on('qm:force:lock', lockHandler);

    // Reveal Correct Answer -> REVEAL (supports qm:answer:reveal and qm:reveal:answer)
    const revealHandler = (payloadOrCallback, maybeCallback) => {
      const ack = typeof maybeCallback === 'function' ? maybeCallback : (typeof payloadOrCallback === 'function' ? payloadOrCallback : () => {});
      if (!this._requireRole(socket, 'QUIZMASTER', ack)) return;

      try {
        const state = this.engine.revealAnswer();
        ack({ success: true, state });
      } catch (err) {
        ack({ success: false, error: err.message });
      }
    };
    socket.on('qm:answer:reveal', revealHandler);
    socket.on('qm:reveal:answer', revealHandler);

    // Show Leaderboard -> LEADERBOARD (supports qm:leaderboard:show and qm:show:leaderboard)
    const leaderboardHandler = (payloadOrCallback, maybeCallback) => {
      const ack = typeof maybeCallback === 'function' ? maybeCallback : (typeof payloadOrCallback === 'function' ? payloadOrCallback : () => {});
      if (!this._requireRole(socket, 'QUIZMASTER', ack)) return;

      try {
        const state = this.engine.showLeaderboard();
        ack({ success: true, state });
      } catch (err) {
        ack({ success: false, error: err.message });
      }
    };
    socket.on('qm:leaderboard:show', leaderboardHandler);
    socket.on('qm:show:leaderboard', leaderboardHandler);

    // Reset Round -> LOBBY
    socket.on('qm:round:reset', (payloadOrCallback, maybeCallback) => {
      const ack = typeof maybeCallback === 'function' ? maybeCallback : (typeof payloadOrCallback === 'function' ? payloadOrCallback : () => {});
      if (!this._requireRole(socket, 'QUIZMASTER', ack)) return;

      try {
        const state = this.engine.resetRound();
        ack({ success: true, state });
      } catch (err) {
        ack({ success: false, error: err.message });
      }
    });

    // Score Override
    socket.on('qm:score:override', (payload, callback) => {
      const ack = typeof callback === 'function' ? callback : () => {};
      if (!this._requireRole(socket, 'QUIZMASTER', ack)) return;

      if (!payload || !payload.pin || payload.newScore === undefined) {
        return ack({ success: false, error: 'INVALID_OVERRIDE_PAYLOAD' });
      }

      const pin = String(payload.pin).trim();
      const newScore = Number(payload.newScore);
      if (isNaN(newScore) || newScore < 0) {
        return ack({ success: false, error: 'INVALID_OVERRIDE_PAYLOAD' });
      }

      const contestant = typeof this.db.getContestantByPin === 'function'
        ? this.db.getContestantByPin(pin)
        : null;

      if (!contestant) {
        return ack({ success: false, error: 'CONTESTANT_NOT_FOUND' });
      }

      try {
        if (typeof this.db.overrideContestantScore === 'function') {
          this.db.overrideContestantScore(pin, newScore);
        } else {
          const dbInstance = typeof this.db.getDb === 'function' ? this.db.getDb() : null;
          if (dbInstance) {
            dbInstance.prepare('UPDATE CONTESTANTS SET total_score = ? WHERE pin = ?').run(newScore, pin);
          }
        }

        if (this.telemetryManager && typeof this.telemetryManager.updateScore === 'function') {
          this.telemetryManager.updateScore(pin, newScore);
        }

        // Broadcast live telemetry updates
        if (this.telemetryManager && typeof this.telemetryManager.getSnapshot === 'function') {
          this.io.to('room:quizmaster').emit('qm:telemetry:snapshot', this.telemetryManager.getSnapshot());
        }
        this.io.to('room:quizmaster').emit('qm:telemetry:update', {
          pin,
          terminalNumber: contestant.terminal_number,
          score: newScore,
          type: 'SCORE_OVERRIDE'
        });

        // Notify contestant
        this.io.to(`contestant:${pin}`).emit('contestant:score:update', {
          totalScore: newScore,
          reason: payload.reason || 'MANUAL_OVERRIDE'
        });

        // Broadcast updated leaderboard
        const roundId = this.engine.state.roundId;
        const updatedLeaderboard = typeof this.db.getLeaderboard === 'function'
          ? this.db.getLeaderboard(roundId)
          : [];
        this.io.emit('leaderboard:update', { leaderboard: updatedLeaderboard });
        this.io.emit('game:leaderboard', { roundId, leaderboard: updatedLeaderboard });

        ack({ success: true, pin, newScore });
      } catch (err) {
        ack({ success: false, error: err.message });
      }
    });
  }
}

function initSocketHandler(io, gameEngine, db, telemetryManager, options) {
  return new SocketHandler(io, gameEngine, db, telemetryManager, options);
}

module.exports = initSocketHandler;
module.exports.initSocketHandler = initSocketHandler;
module.exports.SocketHandler = SocketHandler;
