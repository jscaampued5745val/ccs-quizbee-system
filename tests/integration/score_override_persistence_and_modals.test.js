/**
 * tests/integration/score_override_persistence_and_modals.test.js
 * Comprehensive Verification of R1 (Modal Viewport Display) and R2 (Score Override Persistence)
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('fs');
const os = require('os');
const dbMod = require('../../src/db');
const { GameEngine } = require('../../src/gameEngine');
const TelemetryManager = require('../../src/telemetryManager');
const { initSocketHandler } = require('../../src/socketHandler');
const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');

describe('R1 & R2: Quizmaster Modal Display & Manual Score Override Persistence', () => {
  let tempDbPath;

  beforeEach(() => {
    const rand = Math.random().toString(36).substring(2, 8);
    tempDbPath = path.join(os.tmpdir(), `quizbee_test_${Date.now()}_${rand}.db`);
  });

  afterEach(() => {
    dbMod.closeDb();
    for (const ext of ['', '-wal', '-shm']) {
      const file = `${tempDbPath}${ext}`;
      if (fs.existsSync(file)) {
        try { fs.unlinkSync(file); } catch (_) {}
      }
    }
  });

  // =========================================================================
  // R1. Quizmaster Modals CSS & Viewport Display Integrity
  // =========================================================================
  describe('R1: Modal Viewport Display and Centering Attributes', () => {
    const publicDir = path.join(__dirname, '../../public');
    const qmHtml = fs.readFileSync(path.join(publicDir, 'quizmaster.html'), 'utf-8');
    const qmCss = fs.readFileSync(path.join(publicDir, 'css/quizmaster.css'), 'utf-8');
    const sharedCss = fs.readFileSync(path.join(publicDir, 'css/shared.css'), 'utf-8');
    const qmJs = fs.readFileSync(path.join(publicDir, 'js/quizmaster.js'), 'utf-8');

    it('1.1 HTML defines override-modal and import-modal with modal-overlay and modal-backdrop classes', () => {
      assert.match(qmHtml, /id="override-modal"[^>]*class="[^"]*modal-backdrop[^"]*modal-overlay[^"]*hidden[^"]*"/);
      assert.match(qmHtml, /id="import-modal"[^>]*class="[^"]*modal-backdrop[^"]*modal-overlay[^"]*hidden[^"]*"/);
    });

    it('1.2 CSS defines centered fixed modal-backdrop / modal-overlay over viewport', () => {
      // Must have fixed positioning covering viewport
      assert.match(qmCss, /\.modal-backdrop,\s*\.modal-overlay/);
      assert.match(qmCss, /position:\s*fixed/);
      assert.match(qmCss, /top:\s*0/);
      assert.match(qmCss, /inset:\s*0/);
      assert.match(qmCss, /display:\s*flex/);
      assert.match(qmCss, /align-items:\s*center/);
      assert.match(qmCss, /justify-content:\s*center/);
      assert.match(qmCss, /z-index:\s*1000/);
    });

    it('1.3 CSS defines modal-content with background, border, padding, and max-width', () => {
      assert.match(qmCss, /\.modal-content,\s*\.override-modal-content/);
      assert.match(qmCss, /background-color:\s*var\(--bg-card\)/);
      assert.match(qmCss, /max-width:\s*480px/);
    });

    it('1.4 JavaScript binds modal dismissals (close, cancel, backdrop click, Escape key)', () => {
      assert.match(qmJs, /modalOverride\.classList\.remove\('hidden'\)/);
      assert.match(qmJs, /modalOverride\.classList\.add\('hidden'\)/);
      assert.match(qmJs, /modalImport\.classList\.remove\('hidden'\)/);
      assert.match(qmJs, /modalImport\.classList\.add\('hidden'\)/);
      // Escape key binding
      assert.match(qmJs, /e\.key === 'Escape'/);
    });
  });

  // =========================================================================
  // R2. Score Override Persistence & Leaderboard Reflection (Database Layer)
  // =========================================================================
  describe('R2: Score Override Database Persistence & Leaderboard Reflection', () => {
    it('2.1 Manual score override updates total_score and reflects in getLeaderboard', () => {
      const db = dbMod.initDb(tempDbPath);

      // Seed 2 contestants
      db.prepare(`
        INSERT INTO CONTESTANTS (id, pin, terminal_number, student_id, full_name, department_or_section)
        VALUES (1, '1001', 1, '2024-OLFU-0001', 'Alice', 'BSIT'),
               (2, '1002', 2, '2024-OLFU-0002', 'Bob', 'BSIT')
      `).run();

      // Initial score is 0
      assert.equal(dbMod.getContestantByPin('1001').total_score, 0);

      // Apply override to 15
      dbMod.overrideContestantScore('1001', 15);

      const c1 = dbMod.getContestantByPin('1001');
      assert.equal(c1.total_score, 15, 'total_score in database must be 15');

      // Leaderboard must reflect override immediately
      const lb = dbMod.getLeaderboard();
      const alice = lb.find(c => c.pin === '1001');
      assert.ok(alice, 'Alice must be in leaderboard');
      assert.equal(alice.score, 15, 'Alice score in leaderboard must be 15');
      assert.equal(alice.rank, 1, 'Alice must be rank 1');
    });

    it('2.2 Score override persists across subsequent submissions without reverting', () => {
      const db = dbMod.initDb(tempDbPath);

      // Seed round, question, and contestant
      db.prepare(`
        INSERT INTO ROUNDS (id, name, weight_points, default_timer_sec, sequence_order)
        VALUES (1, 'Easy', 1, 15, 1)
      `).run();
      db.prepare(`
        INSERT INTO QUESTIONS (id, round_id, question_text, question_type, correct_answer, points, timer_seconds)
        VALUES (101, 1, 'Q1', 'MCQ', 'A', 2, 15),
               (102, 1, 'Q2', 'MCQ', 'B', 3, 15)
      `).run();
      db.prepare(`
        INSERT INTO CONTESTANTS (id, pin, terminal_number, student_id, full_name, department_or_section)
        VALUES (1, '1001', 1, '2024-OLFU-0001', 'Alice', 'BSIT')
      `).run();

      // 1. First submission: awards 2 points
      dbMod.saveSubmission(1, 101, 'A', 1000, 1, 'AUTO', 2);
      assert.equal(dbMod.getContestantByPin('1001').total_score, 2);

      // 2. Quizmaster overrides score to 10 (adjustment +8)
      dbMod.overrideContestantScore('1001', 10);
      assert.equal(dbMod.getContestantByPin('1001').total_score, 10);
      assert.equal(dbMod.getLeaderboard()[0].score, 10);

      // 3. Second submission with INCORRECT answer (0 points awarded)
      // Must NOT revert score back to 2!
      dbMod.saveSubmission(1, 102, 'C', 2000, 0, 'AUTO', 0);
      const afterIncorrect = dbMod.getContestantByPin('1001');
      assert.equal(afterIncorrect.total_score, 10, 'Score must persist at 10 after incorrect submission');
      assert.equal(dbMod.getLeaderboard()[0].score, 10, 'Leaderboard must persist at 10');
    });

    it('2.3 Subsequent correct submissions add points on top of the override', () => {
      const db = dbMod.initDb(tempDbPath);

      db.prepare(`
        INSERT INTO ROUNDS (id, name, weight_points, default_timer_sec, sequence_order)
        VALUES (1, 'Easy', 1, 15, 1)
      `).run();
      db.prepare(`
        INSERT INTO QUESTIONS (id, round_id, question_text, question_type, correct_answer, points, timer_seconds)
        VALUES (101, 1, 'Q1', 'MCQ', 'A', 2, 15),
               (102, 1, 'Q2', 'MCQ', 'B', 5, 15)
      `).run();
      db.prepare(`
        INSERT INTO CONTESTANTS (id, pin, terminal_number, student_id, full_name, department_or_section)
        VALUES (1, '1001', 1, '2024-OLFU-0001', 'Alice', 'BSIT')
      `).run();

      // Quizmaster overrides initial score to 20
      dbMod.overrideContestantScore('1001', 20);
      assert.equal(dbMod.getContestantByPin('1001').total_score, 20);

      // Alice correctly answers Q102 earning 5 points
      dbMod.saveSubmission(1, 102, 'B', 1500, 1, 'AUTO', 5);
      const afterCorrect = dbMod.getContestantByPin('1001');
      assert.equal(afterCorrect.total_score, 25, 'Score must be 20 + 5 = 25');
      assert.equal(dbMod.getLeaderboard()[0].score, 25, 'Leaderboard must show 25');
    });

    it('2.4 Score override persists across judge rulings', () => {
      const db = dbMod.initDb(tempDbPath);

      db.prepare(`
        INSERT INTO ROUNDS (id, name, weight_points, default_timer_sec, sequence_order)
        VALUES (1, 'Easy', 1, 15, 1)
      `).run();
      db.prepare(`
        INSERT INTO QUESTIONS (id, round_id, question_text, question_type, correct_answer, points, timer_seconds)
        VALUES (101, 1, 'Q1', 'IDENTIFICATION', 'Java', 3, 15)
      `).run();
      db.prepare(`
        INSERT INTO CONTESTANTS (id, pin, terminal_number, student_id, full_name, department_or_section)
        VALUES (1, '1001', 1, '2024-OLFU-0001', 'Alice', 'BSIT')
      `).run();

      // Submit identification pending review
      const sub = dbMod.saveSubmission(1, 101, 'Javva', 1000, 0, 'PENDING', 0);
      assert.equal(dbMod.getContestantByPin('1001').total_score, 0);

      // Quizmaster applies manual score override of 8
      dbMod.overrideContestantScore('1001', 8);
      assert.equal(dbMod.getContestantByPin('1001').total_score, 8);

      // Judge rejects submission -> score must NOT revert to 0
      dbMod.updateSubmissionRuling(sub.id, 'REJECTED', 0);
      assert.equal(dbMod.getContestantByPin('1001').total_score, 8, 'Score must remain 8 after rejected ruling');
      assert.equal(dbMod.getLeaderboard()[0].score, 8);

      // If judge later approves with 3 points -> 8 + 3 = 11
      dbMod.updateSubmissionRuling(sub.id, 'APPROVED', 3);
      assert.equal(dbMod.getContestantByPin('1001').total_score, 11, 'Score must be 8 + 3 = 11');
      assert.equal(dbMod.getLeaderboard()[0].score, 11);
    });

    it('2.5 resetTournamentScores wipes submissions and resets total_score and adjustments', () => {
      const db = dbMod.initDb(tempDbPath);
      db.prepare(`
        INSERT INTO CONTESTANTS (id, pin, terminal_number, student_id, full_name, department_or_section)
        VALUES (1, '1001', 1, '2024-OLFU-0001', 'Alice', 'BSIT')
      `).run();

      dbMod.overrideContestantScore('1001', 30);
      assert.equal(dbMod.getContestantByPin('1001').total_score, 30);

      dbMod.resetTournamentScores();
      const resetC = dbMod.getContestantByPin('1001');
      assert.equal(resetC.total_score, 0);
      assert.equal(resetC.score_adjustment, 0);
      assert.equal(dbMod.getLeaderboard()[0].score, 0);
    });
  });

  // =========================================================================
  // R2. End-to-End WebSocket Flow: Override -> Telemetry -> Leaderboard
  // =========================================================================
  describe('R2: End-to-End Socket.io Override, Telemetry & Broadcast Suite', () => {
    let server, io, port, baseUrl;
    let engine, tm;
    let qmClient, contestantClient;

    beforeEach(async () => {
      const dbInstance = dbMod.initDb(tempDbPath);

      // Seed 2 workstations
      dbInstance.prepare(`
        INSERT INTO CONTESTANTS (id, pin, terminal_number, student_id, full_name, department_or_section)
        VALUES (1, '1001', 1, '2024-OLFU-0001', 'Alice', 'BSIT'),
               (2, '1002', 2, '2024-OLFU-0002', 'Bob', 'BSIT')
      `).run();

      engine = new GameEngine();
      tm = new TelemetryManager({ db: dbMod, totalTerminals: 2, pinStart: 1001 });

      const httpServer = http.createServer();
      io = new Server(httpServer, { cors: { origin: '*' } });
      initSocketHandler(io, engine, dbMod, tm);

      await new Promise(resolve => {
        httpServer.listen(0, '127.0.0.1', () => {
          port = httpServer.address().port;
          baseUrl = `http://127.0.0.1:${port}`;
          server = httpServer;
          resolve();
        });
      });
    });

    afterEach(async () => {
      if (engine && typeof engine._clearTimers === 'function') {
        engine._clearTimers();
      }
      if (qmClient && qmClient.connected) qmClient.disconnect();
      if (contestantClient && contestantClient.connected) contestantClient.disconnect();
      if (io) io.close();
      if (server) await new Promise(resolve => server.close(resolve));
    });

    it('2.6 qm:score:override updates DB, broadcasts to contestant, updates leaderboard & telemetry', async () => {
      // Connect QM client
      qmClient = ioClient(baseUrl, { reconnection: false });
      await new Promise(resolve => qmClient.on('connect', resolve));
      await new Promise(resolve => qmClient.emit('qm:join', {}, resolve));

      // Connect Contestant client
      contestantClient = ioClient(baseUrl, { reconnection: false });
      await new Promise(resolve => contestantClient.on('connect', resolve));
      await new Promise(resolve => contestantClient.emit('contestant:auth', { pin: '1001' }, resolve));

      // Setup listeners for broadcasts
      let contestantScoreUpdate = null;
      contestantClient.on('contestant:score:update', data => {
        contestantScoreUpdate = data;
      });

      let broadcastLeaderboard = null;
      qmClient.on('leaderboard:update', data => {
        broadcastLeaderboard = data;
      });

      let qmTelemetryUpdate = null;
      qmClient.on('qm:telemetry:update', data => {
        qmTelemetryUpdate = data;
      });

      // QM executes score override to 50
      const ack = await new Promise(resolve => {
        qmClient.emit('qm:score:override', { pin: '1001', newScore: 50, reason: 'Special Bonus' }, resolve);
      });

      assert.equal(ack.success, true);
      assert.equal(ack.pin, '1001');
      assert.equal(ack.newScore, 50);

      // Verify Database was updated
      const updatedC = dbMod.getContestantByPin('1001');
      assert.equal(updatedC.total_score, 50);

      // Verify Telemetry Manager was updated
      assert.equal(tm.terminals.get('1001').score, 50);

      // Wait brief moment for socket events
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify Contestant received score update
      assert.ok(contestantScoreUpdate, 'Contestant must receive contestant:score:update');
      assert.equal(contestantScoreUpdate.totalScore, 50);

      // Verify QM received telemetry update
      assert.ok(qmTelemetryUpdate, 'QM must receive qm:telemetry:update');
      assert.equal(qmTelemetryUpdate.score, 50);

      // Verify Leaderboard was broadcast with score 50
      assert.ok(broadcastLeaderboard, 'Leaderboard must be broadcast');
      const lbAlice = broadcastLeaderboard.leaderboard.find(c => c.pin === '1001');
      assert.ok(lbAlice);
      assert.equal(lbAlice.score, 50);
    });

    it('2.7 Multiple consecutive overrides on same contestant persist correctly across different rounds and recalculations', async () => {
      const db = dbMod.getDb();

      // Seed 2 rounds and 2 questions
      db.prepare(`
        INSERT INTO ROUNDS (id, name, weight_points, default_timer_sec, sequence_order)
        VALUES (1, 'Easy', 1, 15, 1),
               (2, 'Moderate', 2, 20, 2)
      `).run();
      db.prepare(`
        INSERT INTO QUESTIONS (id, round_id, question_text, question_type, correct_answer, points, timer_seconds)
        VALUES (101, 1, 'Q1', 'MCQ', 'A', 5, 15),
               (201, 2, 'Q2', 'MCQ', 'B', 10, 20)
      `).run();

      // Q1 submission: 5 pts
      dbMod.saveSubmission(1, 101, 'A', 1000, 1, 'AUTO', 5);
      assert.equal(dbMod.getContestantByPin('1001').total_score, 5);

      // First override: override to 20
      dbMod.overrideContestantScore('1001', 20);
      assert.equal(dbMod.getContestantByPin('1001').total_score, 20);
      assert.equal(dbMod.getLeaderboard()[0].score, 20);

      // Q2 submission in Round 2: 10 pts awarded -> total should be 20 + 10 = 30
      dbMod.saveSubmission(1, 201, 'B', 2000, 1, 'AUTO', 10);
      assert.equal(dbMod.getContestantByPin('1001').total_score, 30);
      assert.equal(dbMod.getLeaderboard()[0].score, 30);

      // Second override back-to-back: override downward to 12
      dbMod.overrideContestantScore('1001', 12);
      assert.equal(dbMod.getContestantByPin('1001').total_score, 12);
      assert.equal(dbMod.getLeaderboard()[0].score, 12);

      // Third override back-to-back: override upward to 55
      dbMod.overrideContestantScore('1001', 55);
      assert.equal(dbMod.getContestantByPin('1001').total_score, 55);
      assert.equal(dbMod.getLeaderboard()[0].score, 55);
    });

    it('2.8 qm:score:override rejects invalid payload, negative score, and non-existent contestant', async () => {
      qmClient = ioClient(baseUrl, { reconnection: false });
      await new Promise(resolve => qmClient.on('connect', resolve));
      await new Promise(resolve => qmClient.emit('qm:join', {}, resolve));

      // Missing payload / non-existent PIN
      const resNonExistent = await new Promise(resolve => {
        qmClient.emit('qm:score:override', { pin: '9999', newScore: 10 }, resolve);
      });
      assert.equal(resNonExistent.success, false);
      assert.equal(resNonExistent.error, 'CONTESTANT_NOT_FOUND');

      // Negative score rejected
      const resNegative = await new Promise(resolve => {
        qmClient.emit('qm:score:override', { pin: '1001', newScore: -5 }, resolve);
      });
      assert.equal(resNegative.success, false);
      assert.equal(resNegative.error, 'INVALID_OVERRIDE_PAYLOAD');

      // NaN score rejected
      const resNaN = await new Promise(resolve => {
        qmClient.emit('qm:score:override', { pin: '1001', newScore: 'invalid' }, resolve);
      });
      assert.equal(resNaN.success, false);
      assert.equal(resNaN.error, 'INVALID_OVERRIDE_PAYLOAD');
    });
  });
});
