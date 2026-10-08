/**
 * Unit Tests: SocketHandler (src/socketHandler.js)
 * OLFU IT Olympics LAN Quiz Bee System (ITPM 311)
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const dbMod = require('../../src/db');
const GameEngine = require('../../src/gameEngine');
const TelemetryManager = require('../../src/telemetryManager');
const { SocketHandler } = require('../../src/socketHandler');
const { createTempDbPath, cleanupDb } = require('../harness');

// Mock Socket.io Server & Client
class MockSocket extends EventEmitter {
  constructor(id = 'sock_1') {
    super();
    this.id = id;
    this.rooms = new Set();
    this.connected = true;
    this.data = {};
    this.handshake = { address: '192.168.1.101' };
    this.emittedEvents = [];
  }

  join(room) {
    this.rooms.add(room);
  }

  leave(room) {
    this.rooms.delete(room);
  }

  emit(event, ...args) {
    this.emittedEvents.push({ event, payload: args[0], args });
    return super.emit(event, ...args);
  }

  disconnect(close = true) {
    this.connected = false;
    this.emit('disconnect', 'client_disconnected');
  }
}

class MockIO extends EventEmitter {
  constructor() {
    super();
    this.sockets = { sockets: new Map() };
    this.roomEmissions = [];
    this.engine = { clientsCount: 0 };
  }

  to(room) {
    const self = this;
    const rooms = [room];
    const chain = {
      to(nextRoom) {
        rooms.push(nextRoom);
        return chain;
      },
      emit(event, ...args) {
        for (const r of rooms) {
          self.roomEmissions.push({ room: r, event, payload: args[0], args });
        }
      }
    };
    return chain;
  }

  emit(event, ...args) {
    this.roomEmissions.push({ room: 'ALL', event, payload: args[0], args });
    return super.emit(event, ...args);
  }

  connectSocket(socket) {
    this.sockets.sockets.set(socket.id, socket);
    this.engine.clientsCount++;
    this.emit('connection', socket);
  }
}

describe('SocketHandler Unit Tests', () => {
  let tempDb;
  let db;
  let engine;
  let telemetryManager;
  let io;
  let handler;

  beforeEach(() => {
    tempDb = createTempDbPath('sock_handler_test');
    dbMod.initDb(tempDb);

    // Seed test round, question, and contestants
    const dbInstance = dbMod.getDb();

    dbInstance.prepare(`
      INSERT INTO ROUNDS (id, name, weight_points, default_timer_sec, sequence_order)
      VALUES (1, 'Easy', 1, 15, 1)
    `).run();

    dbInstance.prepare(`
      INSERT INTO QUESTIONS (id, round_id, question_text, code_snippet, question_type, options_json, correct_answer, acceptable_synonyms_json, points, timer_seconds)
      VALUES 
        (1, 1, 'Which tag is used for stylesheet?', '', 'MCQ', '{"A":"<script>","B":"<style>","C":"<link>","D":"<css>"}', 'C', '[]', 1, 15),
        (2, 1, 'What is the full form of CSS?', '', 'IDENTIFICATION', '{}', 'Cascading Style Sheets', '["Cascading Style Sheet","CSS"]', 2, 30)
    `).run();

    // Insert 5 test contestants (PIN 1001 to 1005)
    for (let i = 1; i <= 5; i++) {
      dbInstance.prepare(`
        INSERT INTO CONTESTANTS (id, pin, terminal_number, student_id, full_name, department_or_section, total_score)
        VALUES (?, ?, ?, ?, ?, 'BSIT', 0)
      `).run(i, String(1000 + i), i, `2024-OLFU-${String(i).padStart(4, '0')}`, `Contestant ${i}`);
    }

    engine = new GameEngine({ graceWindowMs: 300, tickIntervalMs: 1000 });
    telemetryManager = new TelemetryManager({ db: dbMod, totalTerminals: 5, pinStart: 1001 });
    io = new MockIO();
    handler = new SocketHandler(io, engine, dbMod, telemetryManager);
  });

  afterEach(() => {
    if (engine && typeof engine._clearTimers === 'function') {
      engine._clearTimers();
    }
    dbMod.closeDb();
    cleanupDb(tempDb);
  });

  it('1. NTP-lite clock sync protocol responds to sync:ping with t1, t2, t3', () => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('NTP sync:pong timed out after 2000ms')), 2000);
      const socket = new MockSocket('client_ntp');
      io.connectSocket(socket);

      socket.on('sync:pong', (pong) => {
        clearTimeout(timer);
        try {
          assert.equal(pong.t1, 1234567);
          assert.ok(pong.t2 > 0);
          assert.ok(pong.t3 >= pong.t2);
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      socket.emit('sync:ping', { t1: 1234567 });
    });
  });

  it('2. Role join events place sockets into correct rooms and return state snapshots', () => {
    const qmSock = new MockSocket('qm_sock');
    io.connectSocket(qmSock);
    qmSock.emit('qm:join', {}, (res) => {
      assert.equal(res.success, true);
      assert.ok(res.gameState);
      assert.ok(Array.isArray(res.telemetryGrid));
    });
    assert.ok(qmSock.rooms.has('room:quizmaster'));

    const projSock = new MockSocket('proj_sock');
    io.connectSocket(projSock);
    projSock.emit('projector:join', {}, (res) => {
      assert.equal(res.success, true);
      assert.ok(res.gameState);
    });
    assert.ok(projSock.rooms.has('room:projector'));

    const judgeSock = new MockSocket('judge_sock');
    io.connectSocket(judgeSock);
    judgeSock.emit('judge:join', {}, (res) => {
      assert.equal(res.success, true);
      assert.ok(Array.isArray(res.pendingDisputes));
    });
    assert.ok(judgeSock.rooms.has('room:judges'));
  });

  it('3. Contestant authentication joins rooms, updates presence, and redacts correct answer from state', () => {
    // Stage question 1
    const q1 = dbMod.getQuestion(1);
    engine.stageQuestion(q1);

    const client = new MockSocket('client_c1');
    io.connectSocket(client);

    let ackReceived = null;
    client.emit('contestant:auth', { pin: '1001' }, (res) => {
      ackReceived = res;
    });

    assert.ok(ackReceived);
    assert.equal(ackReceived.success, true);
    assert.equal(ackReceived.contestant.pin, '1001');
    assert.equal(ackReceived.contestant.terminalNumber, 1);
    assert.ok(client.rooms.has('room:contestants'));
    assert.ok(client.rooms.has('contestant:1001'));

    // Security check: correct_answer and acceptable_synonyms must NOT be in contestant gameState!
    const stagedQ = ackReceived.gameState.currentQuestion;
    assert.ok(stagedQ);
    assert.equal(stagedQ.id, 1);
    assert.equal(stagedQ.correct_answer, undefined);
    assert.equal(stagedQ.acceptable_synonyms_json, undefined);
    assert.equal(stagedQ.synonyms, undefined);

    // Database connection status check
    const cDb = dbMod.getContestantByPin('1001');
    assert.equal(cDb.is_connected, 1);
    assert.equal(cDb.last_socket_id, 'client_c1');

    // Telemetry check
    const term = telemetryManager.terminals.get('1001');
    assert.equal(term.status, 'ONLINE');
    assert.equal(term.socketId, 'client_c1');
  });

  it('4. Rejects invalid PINs on contestant:auth', () => {
    const client = new MockSocket('client_bad');
    io.connectSocket(client);

    let ackReceived = null;
    client.emit('contestant:auth', { pin: '9999' }, (res) => {
      ackReceived = res;
    });

    assert.equal(ackReceived.success, false);
    assert.equal(ackReceived.error, 'INVALID_PIN');
    assert.equal(client.rooms.has('room:contestants'), false);
  });

  it('5. Duplicate PIN authentication kicks and disconnects older socket connection', () => {
    const sock1 = new MockSocket('sock_seat_1');
    const sock2 = new MockSocket('sock_seat_2');

    io.connectSocket(sock1);
    sock1.emit('contestant:auth', { pin: '1002' }, () => {});
    assert.equal(sock1.connected, true);

    let kickedEvent = null;
    sock1.on('contestant:kicked', (payload) => {
      kickedEvent = payload;
    });

    io.connectSocket(sock2);
    let sock2Ack = null;
    sock2.emit('contestant:auth', { pin: '1002' }, (res) => {
      sock2Ack = res;
    });

    assert.ok(kickedEvent);
    assert.equal(kickedEvent.reason, 'DUPLICATE_LOGIN');
    assert.equal(sock1.connected, false);

    assert.ok(sock2Ack);
    assert.equal(sock2Ack.success, true);
    assert.equal(handler.activeSocketsByPin.get('1002'), sock2);
  });

  it('6. Rejects submissions when game is not in active countdown', () => {
    const client = new MockSocket('client_sub1');
    io.connectSocket(client);
    client.emit('contestant:auth', { pin: '1001' }, () => {});

    // Engine is in LOBBY
    let subAck = null;
    client.emit('contestant:submit', { pin: '1001', questionId: 1, answer: 'C' }, (res) => {
      subAck = res;
    });

    assert.equal(subAck.success, false);
    assert.ok(subAck.error.includes('SUBMISSIONS_PROHIBITED') || subAck.error.includes('LOCKED'));
  });

  it('7. Processes valid MCQ submission during COUNTDOWN and awards base points', () => {
    const q1 = dbMod.getQuestion(1);
    engine.stageQuestion(q1);
    engine.startCountdown(15);

    const client = new MockSocket('client_mcq');
    io.connectSocket(client);
    client.emit('contestant:auth', { pin: '1001' }, () => {});

    let ack = null;
    client.emit('contestant:submit', { pin: '1001', questionId: 1, answer: 'C' }, (res) => {
      ack = res;
    });

    assert.ok(ack);
    assert.equal(ack.success, true);
    assert.equal(ack.pointsAwarded, 1);
    assert.equal(ack.judgeStatus, 'AUTO');
    assert.equal(ack.totalScore, 1);

    // Verify DB persistence
    const sub = dbMod.getSubmission(1, 1);
    assert.ok(sub);
    assert.equal(sub.submitted_answer, 'C');
    assert.equal(sub.is_correct, 1);
    assert.equal(sub.awarded_points, 1);

    // Contestant score in DB
    const c1 = dbMod.getContestantByPin('1001');
    assert.equal(c1.total_score, 1);

    // Duplicate submission attempt
    let dupAck = null;
    client.emit('contestant:submit', { pin: '1001', questionId: 1, answer: 'C' }, (res) => {
      dupAck = res;
    });
    assert.equal(dupAck.success, false);
    assert.equal(dupAck.error, 'DUPLICATE_SUBMISSION');
  });

  it('8. Processes Identification submission with synonym matching and auto-scores', () => {
    const q2 = dbMod.getQuestion(2);
    engine.stageQuestion(q2);
    engine.startCountdown(30);

    const client = new MockSocket('client_id_syn');
    io.connectSocket(client);
    client.emit('contestant:auth', { pin: '1002' }, () => {});

    let ack = null;
    // 'CSS' is an acceptable synonym for 'Cascading Style Sheets'
    client.emit('contestant:submit', { pin: '1002', questionId: 2, answer: 'CSS' }, (res) => {
      ack = res;
    });

    assert.ok(ack);
    assert.equal(ack.success, true);
    assert.equal(ack.pointsAwarded, 2);
    assert.equal(ack.judgeStatus, 'AUTO');

    const c2 = dbMod.getContestantByPin('1002');
    assert.equal(c2.total_score, 2);
  });

  it('9. Empty Identification answer is auto-failed and NEVER sent to judge queue', () => {
    const q2 = dbMod.getQuestion(2);
    engine.stageQuestion(q2);
    engine.startCountdown(30);

    const client = new MockSocket('client_empty');
    io.connectSocket(client);
    client.emit('contestant:auth', { pin: '1003' }, () => {});

    let ack = null;
    client.emit('contestant:submit', { pin: '1003', questionId: 2, answer: '   ' }, (res) => {
      ack = res;
    });

    assert.ok(ack);
    assert.equal(ack.success, true);
    assert.equal(ack.pointsAwarded, 0);
    assert.equal(ack.judgeStatus, 'AUTO');

    const pending = dbMod.getPendingRulings();
    assert.equal(pending.length, 0, 'Empty answer must not enter judge queue');
  });

  it('10. Non-matching Identification answer routes to Judge review queue as PENDING', () => {
    const q2 = dbMod.getQuestion(2);
    engine.stageQuestion(q2);
    engine.startCountdown(30);

    const client = new MockSocket('client_dispute');
    io.connectSocket(client);
    client.emit('contestant:auth', { pin: '1004' }, () => {});

    let ack = null;
    // 'Cascaded Style Sheet' is close but not exact or in synonyms -> should be PENDING
    client.emit('contestant:submit', { pin: '1004', questionId: 2, answer: 'Cascaded Style Sheet' }, (res) => {
      ack = res;
    });

    assert.ok(ack);
    assert.equal(ack.success, true);
    assert.equal(ack.pointsAwarded, 0);
    assert.equal(ack.judgeStatus, 'PENDING');

    const pending = dbMod.getPendingRulings();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].submitted_answer, 'Cascaded Style Sheet');
  });

  it('10b. Obviously far-off Identification answer (e.g. "yes") is auto-failed and NEVER sent to judge queue', () => {
    const q2 = dbMod.getQuestion(2); // "Cascading Style Sheets"
    engine.stageQuestion(q2);
    engine.startCountdown(30);

    const client = new MockSocket('client_far_off');
    io.connectSocket(client);
    client.emit('contestant:auth', { pin: '1002' }, () => {});

    let ack = null;
    // 'yes' has 0% similarity to 'Cascading Style Sheets' -> auto-fail, never sent to judge
    client.emit('contestant:submit', { pin: '1002', questionId: 2, answer: 'yes' }, (res) => {
      ack = res;
    });

    assert.ok(ack);
    assert.equal(ack.success, true);
    assert.equal(ack.pointsAwarded, 0);
    assert.equal(ack.judgeStatus, 'AUTO', 'Far-off answer must be auto-graded as AUTO');

    // Only the previous test's pending item should exist; "yes" must NOT be in pending rulings
    const pending = dbMod.getPendingRulings();
    const yesDispute = pending.find(p => p.submitted_answer === 'yes');
    assert.equal(yesDispute, undefined, 'Obviously far-off answer "yes" must NOT enter judge queue');
  });

  it('11. Judge dispute action APPROVED updates submission and awards points dynamically', () => {
    const q2 = dbMod.getQuestion(2);
    engine.stageQuestion(q2);
    engine.startCountdown(30);

    const client = new MockSocket('client_for_judge');
    io.connectSocket(client);
    client.emit('contestant:auth', { pin: '1005' }, () => {});

    let subId = null;
    client.emit('contestant:submit', { pin: '1005', questionId: 2, answer: 'Style Sheets' }, (res) => {
      subId = res.submissionId;
    });
    assert.ok(subId);

    const judgeSock = new MockSocket('judge_panel');
    io.connectSocket(judgeSock);
    judgeSock.emit('judge:join', {}, () => {});

    let judgeAck = null;
    judgeSock.emit('judge:dispute:action', { submissionId: subId, status: 'APPROVED' }, (res) => {
      judgeAck = res;
    });

    assert.ok(judgeAck);
    assert.equal(judgeAck.success, true);
    assert.equal(judgeAck.status, 'APPROVED');
    assert.equal(judgeAck.awardedPoints, 2);

    const c5 = dbMod.getContestantByPin('1005');
    assert.equal(c5.total_score, 2);
  });

  it('12. Ingests anti-cheat telemetry and broadcasts alert to Quizmaster room', () => {
    const client = new MockSocket('client_cheat');
    io.connectSocket(client);
    client.emit('contestant:auth', { pin: '1001' }, () => {});

    client.emit('contestant:incident', { pin: '1001', type: 'FULLSCREEN_EXIT', details: 'F11 pressed' });

    // Verify alert emitted to room:quizmaster
    const alertEmitted = io.roomEmissions.find(
      e => e.room === 'room:quizmaster' && e.event === 'qm:telemetry:alert'
    );
    assert.ok(alertEmitted);
    assert.equal(alertEmitted.payload.pin, '1001');
    assert.equal(alertEmitted.payload.incidentType, 'FULLSCREEN_EXIT');
  });

  it('13. Quizmaster controls stage question, start timer, pause, resume, lock, and reveal', () => {
    const qmSock = new MockSocket('qm_controls');
    io.connectSocket(qmSock);
    qmSock.emit('qm:join', {}, () => {});

    // Stage question
    let stageRes = null;
    qmSock.emit('qm:question:stage', { questionId: 1 }, (res) => { stageRes = res; });
    assert.equal(stageRes.success, true);
    assert.equal(engine.state.phase, 'READING');

    // Start timer
    let startRes = null;
    qmSock.emit('qm:timer:start', { durationSeconds: 15 }, (res) => { startRes = res; });
    assert.equal(startRes.success, true);
    assert.equal(engine.state.phase, 'COUNTDOWN');

    // Pause timer
    let pauseRes = null;
    qmSock.emit('qm:timer:pause', (res) => { pauseRes = res; });
    assert.equal(pauseRes.success, true);
    assert.equal(engine.state.phase, 'PAUSED');

    // Resume timer
    let resumeRes = null;
    qmSock.emit('qm:timer:resume', (res) => { resumeRes = res; });
    assert.equal(resumeRes.success, true);
    assert.equal(engine.state.phase, 'COUNTDOWN');

    // Force lock
    let lockRes = null;
    qmSock.emit('qm:question:lock', (res) => { lockRes = res; });
    assert.equal(lockRes.success, true);
    assert.equal(engine.state.phase, 'LOCKED');

    // Reveal answer
    let revealRes = null;
    qmSock.emit('qm:answer:reveal', (res) => { revealRes = res; });
    assert.equal(revealRes.success, true);
    assert.equal(engine.state.phase, 'REVEAL');

    // Show leaderboard
    let lbRes = null;
    qmSock.emit('qm:leaderboard:show', (res) => { lbRes = res; });
    assert.equal(lbRes.success, true);
    assert.equal(engine.state.phase, 'LEADERBOARD');
  });

  it('14. Quizmaster score override updates contestant score and broadcasts updates', () => {
    const qmSock = new MockSocket('qm_override');
    io.connectSocket(qmSock);
    qmSock.emit('qm:join', {}, () => {});

    let ack = null;
    qmSock.emit('qm:score:override', { pin: '1001', newScore: 20, reason: 'Manual Adjustment' }, (res) => {
      ack = res;
    });

    assert.ok(ack);
    assert.equal(ack.success, true);

    const c1 = dbMod.getContestantByPin('1001');
    assert.equal(c1.total_score, 20);
    assert.equal(telemetryManager.terminals.get('1001').score, 20);
  });
});
