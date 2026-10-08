/**
 * Integration Tests: Server Bootstrap & REST / WebSocket Endpoints
 * OLFU IT Olympics LAN Quiz Bee System (ITPM 311)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: ClientIO } = require('socket.io-client');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Isolated DB: this suite performs destructive operations (replace-import, score reset),
// so it must NEVER run against the live tournament quizbee.db.
const TEST_DB_PATH = path.join(os.tmpdir(), `quizbee_server_test_${process.pid}_${Date.now()}.db`);
process.env.QUIZBEE_DB_PATH = TEST_DB_PATH;

const { startServer, stopServer, app, server, io, gameEngine, db } = require('../../src/server');
const { runSeed } = require('../../scripts/seed');

const TEST_PORT = 3199;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function fetchJsonWithHeaders(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${path}`);
    const req = http.request(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        } catch (err) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function fetchJson(path) {
  return fetchJsonWithHeaders(path, {});
}

function postJson(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${path}`);
    const dataStr = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dataStr),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(dataStr);
    req.end();
  });
}

function fetchRaw(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${path}`, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    }).on('error', reject);
  });
}

describe('Server Integration Tests (src/server.js)', () => {
  before(async () => {
    runSeed(TEST_DB_PATH);
    await startServer(TEST_PORT);
  });

  after(async () => {
    await stopServer();
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(`${TEST_DB_PATH}${ext}`); } catch (_) {}
    }
  });

  it('1. Serves offline local client library at /socket.io/socket.io.js', async () => {
    const res = await fetchRaw('/socket.io/socket.io.js');
    assert.equal(res.status, 200);
    assert.ok(
      res.headers['content-type'].includes('javascript'),
      'Content-Type must be javascript'
    );
    assert.ok(res.body.length > 1000, 'Must serve non-empty socket.io client bundle');
  });

  it('2. Serves role landing and view routes with HTTP 200', async () => {
    const views = ['/', '/quizmaster', '/contestant', '/projector', '/judge'];
    for (const viewPath of views) {
      const res = await fetchRaw(viewPath);
      assert.equal(res.status, 200, `View ${viewPath} must respond with 200 OK`);
      assert.ok(res.body.includes('OLFU IT Olympics') || res.body.includes('html'));
    }
  });

  it('3. GET /api/health returns healthy server status and SQLite WAL mode telemetry', async () => {
    const res = await fetchJson('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'healthy');
    assert.equal(res.body.service, 'fatima-quizbee-engine');
    assert.equal(res.body.database.connected, true);
    assert.equal(res.body.database.mode, 'WAL');
    assert.ok(res.body.memory.rssMb > 0);
  });

  it('4. GET /api/status returns operational tournament status and network details', async () => {
    const res = await fetchJson('/api/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'operational');
    assert.ok(res.body.game.phase);
    assert.equal(res.body.telemetry.totalTerminals, 60);
    assert.ok(res.body.network.lanIp);
    assert.ok(res.body.network.lanUrl);
  });

  it('5. GET /api/questions returns question bank records', async () => {
    const res = await fetchJson('/api/questions');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.questions));
  });

  it('6. GET /api/telemetry returns 60-workstation grid snapshot', async () => {
    const res = await fetchJson('/api/telemetry');
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.total, 60);
    assert.equal(res.body.terminals.length, 60);
  });

  it('7. GET /api/leaderboard returns ranked roster', async () => {
    const res = await fetchJson('/api/leaderboard');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.leaderboard));
  });

  it('8. GET /api/contestants returns contestant roster', async () => {
    const res = await fetchJson('/api/contestants');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.contestants));
  });

  it('9. Real Socket.io client connects, performs NTP sync, and authenticates PIN', () => {
    return new Promise((resolve, reject) => {
      const socket = ClientIO(BASE_URL, {
        transports: ['websocket'],
        forceNew: true
      });

      socket.on('connect', () => {
        // 1. NTP sync test
        socket.emit('sync:ping', { t1: Date.now() });
        socket.once('sync:pong', (pong) => {
          assert.ok(pong.t2 > 0);
          assert.ok(pong.t3 >= pong.t2);

          // 2. Contestant authentication test
          socket.emit('contestant:auth', { pin: '1001' }, (authRes) => {
            assert.equal(authRes.success, true);
            assert.equal(authRes.contestant.pin, '1001');
            assert.equal(authRes.contestant.terminalNumber, 1);

            socket.disconnect();
            resolve();
          });
        });
      });

      socket.on('connect_error', reject);
    });
  });

  it('10. GET /api/questions redacts correct_answer unless authorized with x-role: quizmaster', async () => {
    // 1. Unauthenticated request: answers and synonyms must be stripped
    const pubRes = await fetchJson('/api/questions');
    assert.equal(pubRes.status, 200);
    assert.ok(pubRes.body.questions.length > 0);
    const leakedPub = pubRes.body.questions.some(q => q.correct_answer !== undefined || q.acceptable_synonyms_json !== undefined);
    assert.equal(leakedPub, false, 'Unauthenticated /api/questions must not expose correct_answer or synonyms');

    // 2. Authorized Quizmaster request: answers preserved
    const qmRes = await fetchJsonWithHeaders('/api/questions', { 'x-role': 'quizmaster' });
    assert.equal(qmRes.status, 200);
    assert.ok(qmRes.body.questions.length > 0);
    const qmHasAnswers = qmRes.body.questions.some(q => q.correct_answer !== undefined);
    assert.equal(qmHasAnswers, true, 'Authorized Quizmaster /api/questions must include answers');
  });

  it('11. GET /api/status redacts currentQuestion answers during COUNTDOWN unless authorized or in REVEAL', async () => {
    // Stage question and start countdown
    const q = db.getAllQuestions()[0];
    assert.ok(q, 'A seeded question must exist');
    gameEngine.stageQuestion(q);
    gameEngine.startCountdown(15);

    // 1. Public request during COUNTDOWN: correct_answer must NOT be present
    const countdownRes = await fetchJson('/api/status');
    assert.equal(countdownRes.status, 200);
    assert.equal(countdownRes.body.game.phase, 'COUNTDOWN');
    assert.ok(countdownRes.body.game.currentQuestion);
    assert.equal(countdownRes.body.game.currentQuestion.correct_answer, undefined);
    assert.equal(countdownRes.body.game.currentQuestion.acceptable_synonyms_json, undefined);

    // 2. Authorized QM request during COUNTDOWN: correct_answer present
    const qmRes = await fetchJsonWithHeaders('/api/status', { 'x-role': 'quizmaster' });
    assert.equal(qmRes.status, 200);
    assert.equal(qmRes.body.game.currentQuestion.correct_answer, q.correct_answer);

    // 3. Reveal answer phase: public request receives correct_answer
    gameEngine.lockQuestion();
    gameEngine.revealAnswer();
    const revealRes = await fetchJson('/api/status');
    assert.equal(revealRes.status, 200);
    assert.equal(revealRes.body.game.phase, 'REVEAL');
    assert.equal(revealRes.body.game.currentQuestion.correct_answer, q.correct_answer);

    gameEngine.resetRound();
  });

  it('12. POST /api/questions/import rejects unauthorized requests without Quizmaster role', async () => {
    const res = await postJson('/api/questions/import', { csvContent: 'round,type,question...' });
    assert.equal(res.status, 403);
    assert.equal(res.body.success, false);
  });

  it('13. POST /api/questions/import imports questions and stages bank when authorized', async () => {
    const trialCsv = `round,type,question,code_snippet,option_a,option_b,option_c,option_d,correct_answer,synonyms,points,timer_seconds
Trial,MCQ,"Integration trial question?","",A,B,C,D,B,,0,15
Easy,MCQ,"Integration easy question?","",A,B,C,D,A,,1,15`;

    const res = await postJson('/api/questions/import', { csvContent: trialCsv, mode: 'replace' }, { 'x-role': 'quizmaster' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.importedCount, 2);

    const questions = db.getAllQuestions();
    assert.equal(questions.length, 2);
    assert.equal(questions[0].round, 'Trial');
    assert.equal(questions[0].points, 0);
  });

  it('14. POST /api/tournament/reset-scores resets contestant scores to 0', async () => {
    // Attempt unauthorized reset
    const unauthRes = await postJson('/api/tournament/reset-scores', {});
    assert.equal(unauthRes.status, 403);

    // Authorized reset
    const authRes = await postJson('/api/tournament/reset-scores', {}, { 'x-role': 'quizmaster' });
    assert.equal(authRes.status, 200);
    assert.equal(authRes.body.success, true);
  });
});
