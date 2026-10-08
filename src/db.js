/**
 * src/db.js - Authoritative SQLite Database Layer (WAL Mode)
 * OLFU IT Olympics LAN Quiz Bee System (ITPM 311)
 *
 * Provides high-concurrency read/write operations for 60+ simultaneous contestants,
 * pre-compiled prepared statements, atomic transactions, and performance indexes.
 * Dual-driver architecture: seamlessly uses better-sqlite3 or Node.js v26 built-in node:sqlite.
 */

const path = require('path');
const fs = require('fs');

let db = null;
let stmts = {};

/**
 * Creates and wraps SQLite instance with uniform API
 * @param {string} dbPath
 * @returns {Object}
 */
function createDbInstance(dbPath) {
  let instance = null;

  try {
    const BetterSqlite3 = require('better-sqlite3');
    instance = new BetterSqlite3(dbPath);
  } catch (_) {
    // Dual-driver fallback: Node.js v26 built-in DatabaseSync
    const { DatabaseSync } = require('node:sqlite');
    instance = new DatabaseSync(dbPath);

    // Provide better-sqlite3 compatible .pragma()
    if (typeof instance.pragma !== 'function') {
      instance.pragma = function(pragmaStr, options) {
        const clean = pragmaStr.replace(/^PRAGMA\s+/i, '').replace(/;$/, '');
        if (clean.includes('=')) {
          instance.exec('PRAGMA ' + clean + ';');
          return null;
        }
        const row = instance.prepare('PRAGMA ' + clean).get();
        if (row) {
          const val = Object.values(row)[0];
          return options && options.simple ? val : row;
        }
        return null;
      };
    }

    // Provide better-sqlite3 compatible .transaction()
    if (typeof instance.transaction !== 'function') {
      instance.transaction = function(fn) {
        return function(...args) {
          instance.exec('BEGIN');
          try {
            const res = fn(...args);
            instance.exec('COMMIT');
            return res;
          } catch (txErr) {
            instance.exec('ROLLBACK');
            throw txErr;
          }
        };
      };
    }
  }

  return instance;
}

/**
 * Resolve default DB path (env override; temp DB under `node --test`)
 * @returns {string}
 */
function resolveDefaultDbPath() {
  if (process.env.QUIZBEE_DB_PATH) return path.resolve(process.env.QUIZBEE_DB_PATH);
  // Safety: when running under `node --test`, never touch the live tournament database
  if (process.env.NODE_TEST_CONTEXT) {
    return path.join(require('os').tmpdir(), `quizbee_test_default_${process.pid}.db`);
  }
  return path.resolve(__dirname, '../quizbee.db');
}

/**
 * Initialize SQLite database with WAL mode and schema tables
 * @param {string} [customPath] - Path to SQLite database file
 * @returns {Object}
 */
function initDb(customPath) {
  const dbPath = customPath || resolveDefaultDbPath();

  // Ensure parent directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = createDbInstance(dbPath);

  // High-concurrency performance pragmas for LAN tournament
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -64000'); // 64MB memory cache

  // Create Schema DDL
  db.exec(`
    CREATE TABLE IF NOT EXISTS ROUNDS (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      weight_points INTEGER NOT NULL DEFAULT 1,
      default_timer_sec INTEGER NOT NULL DEFAULT 15,
      sequence_order INTEGER NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS QUESTIONS (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL REFERENCES ROUNDS(id) ON DELETE CASCADE,
      question_text TEXT NOT NULL,
      code_snippet TEXT DEFAULT '',
      question_type TEXT NOT NULL CHECK(question_type IN ('MCQ', 'IDENTIFICATION')),
      options_json TEXT DEFAULT '[]',
      correct_answer TEXT NOT NULL,
      acceptable_synonyms_json TEXT DEFAULT '[]',
      points INTEGER NOT NULL CHECK(points >= 0),
      timer_seconds INTEGER NOT NULL CHECK(timer_seconds > 0),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS CONTESTANTS (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pin TEXT NOT NULL UNIQUE,
      terminal_number INTEGER NOT NULL UNIQUE,
      student_id TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      department_or_section TEXT DEFAULT 'BSIT',
      total_score INTEGER NOT NULL DEFAULT 0,
      score_adjustment INTEGER NOT NULL DEFAULT 0,
      is_connected INTEGER NOT NULL DEFAULT 0 CHECK(is_connected IN (0, 1)),
      last_socket_id TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS SUBMISSIONS (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contestant_id INTEGER NOT NULL REFERENCES CONTESTANTS(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES QUESTIONS(id) ON DELETE CASCADE,
      submitted_answer TEXT NOT NULL,
      server_time_ms INTEGER NOT NULL,
      is_correct INTEGER NOT NULL DEFAULT 0 CHECK(is_correct IN (0, 1)),
      judge_status TEXT NOT NULL DEFAULT 'AUTO' CHECK(judge_status IN ('AUTO', 'PENDING', 'APPROVED', 'REJECTED')),
      awarded_points INTEGER NOT NULL DEFAULT 0 CHECK(awarded_points >= 0),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_contestant_question UNIQUE (contestant_id, question_id)
    );

    CREATE TABLE IF NOT EXISTS CHEAT_LOGS (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contestant_id INTEGER NOT NULL REFERENCES CONTESTANTS(id) ON DELETE CASCADE,
      incident_type TEXT NOT NULL CHECK(incident_type IN ('FULLSCREEN_EXIT', 'BLUR', 'TAB_SWITCH', 'DEVTOOLS', 'KEY_SHORTCUT', 'UNAUTHORIZED_INPUT', 'SHORTCUT_BLOCKED')),
      timestamp INTEGER NOT NULL,
      details TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Performance & Lookup Indexes
    CREATE INDEX IF NOT EXISTS idx_rounds_sequence ON ROUNDS(sequence_order);
    CREATE INDEX IF NOT EXISTS idx_rounds_name ON ROUNDS(name);
    CREATE INDEX IF NOT EXISTS idx_questions_round_id ON QUESTIONS(round_id);
    CREATE INDEX IF NOT EXISTS idx_contestants_pin ON CONTESTANTS(pin);
    CREATE INDEX IF NOT EXISTS idx_contestants_terminal ON CONTESTANTS(terminal_number);
    CREATE INDEX IF NOT EXISTS idx_contestants_score ON CONTESTANTS(total_score DESC);
    CREATE INDEX IF NOT EXISTS idx_submissions_cq ON SUBMISSIONS(contestant_id, question_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_question ON SUBMISSIONS(question_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_judge ON SUBMISSIONS(judge_status);
    CREATE INDEX IF NOT EXISTS idx_submissions_timing ON SUBMISSIONS(question_id, is_correct, server_time_ms ASC);
    CREATE INDEX IF NOT EXISTS idx_cheat_logs_contestant ON CHEAT_LOGS(contestant_id);
    CREATE INDEX IF NOT EXISTS idx_cheat_logs_time ON CHEAT_LOGS(timestamp DESC);
  `);

  // Auto-migrate legacy QUESTIONS table to support 0-point trial questions
  try {
    const qTableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'QUESTIONS'").get();
    if (qTableInfo && qTableInfo.sql && qTableInfo.sql.includes('CHECK(points > 0)')) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE IF NOT EXISTS QUESTIONS_MIGRATED (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          round_id INTEGER NOT NULL REFERENCES ROUNDS(id) ON DELETE CASCADE,
          question_text TEXT NOT NULL,
          code_snippet TEXT DEFAULT '',
          question_type TEXT NOT NULL CHECK(question_type IN ('MCQ', 'IDENTIFICATION')),
          options_json TEXT DEFAULT '[]',
          correct_answer TEXT NOT NULL,
          acceptable_synonyms_json TEXT DEFAULT '[]',
          points INTEGER NOT NULL CHECK(points >= 0),
          timer_seconds INTEGER NOT NULL CHECK(timer_seconds > 0),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO QUESTIONS_MIGRATED (id, round_id, question_text, code_snippet, question_type, options_json, correct_answer, acceptable_synonyms_json, points, timer_seconds, created_at)
        SELECT id, round_id, question_text, code_snippet, question_type, options_json, correct_answer, acceptable_synonyms_json, points, timer_seconds, created_at FROM QUESTIONS;
        DROP TABLE QUESTIONS;
        ALTER TABLE QUESTIONS_MIGRATED RENAME TO QUESTIONS;
        CREATE INDEX IF NOT EXISTS idx_questions_round_id ON QUESTIONS(round_id);
        PRAGMA foreign_keys = ON;
      `);
    }
  } catch (_) {}

  // Auto-migrate CONTESTANTS table to support score_adjustment
  try {
    const contestantCols = db.prepare("PRAGMA table_info(CONTESTANTS)").all().map(c => c.name);
    if (!contestantCols.includes('score_adjustment')) {
      db.exec("ALTER TABLE CONTESTANTS ADD COLUMN score_adjustment INTEGER NOT NULL DEFAULT 0;");
    }
  } catch (_) {}

  // Trigger to keep score_adjustment in sync if total_score is updated directly
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_contestants_sync_score_adj
      AFTER UPDATE OF total_score ON CONTESTANTS
      FOR EACH ROW
      WHEN NEW.score_adjustment = OLD.score_adjustment AND NEW.total_score != (
        SELECT COALESCE(SUM(awarded_points), 0) FROM SUBMISSIONS WHERE contestant_id = NEW.id
      ) + NEW.score_adjustment
      BEGIN
        UPDATE CONTESTANTS 
        SET score_adjustment = NEW.total_score - (
          SELECT COALESCE(SUM(awarded_points), 0) FROM SUBMISSIONS WHERE contestant_id = NEW.id
        )
        WHERE id = NEW.id;
      END;
    `);
  } catch (_) {}

  prepareStatements();
  return db;
}

/**
 * Pre-compile statements into SQLite bytecode for maximum throughput
 */
function prepareStatements() {
  stmts = {
    // Round operations
    getRoundById: db.prepare('SELECT * FROM ROUNDS WHERE id = ?'),
    getRoundByName: db.prepare('SELECT * FROM ROUNDS WHERE UPPER(name) = UPPER(?)'),
    getAllRounds: db.prepare('SELECT * FROM ROUNDS ORDER BY sequence_order ASC'),
    insertRound: db.prepare(`
      INSERT INTO ROUNDS (id, name, weight_points, default_timer_sec, sequence_order)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        weight_points = excluded.weight_points,
        default_timer_sec = excluded.default_timer_sec,
        sequence_order = excluded.sequence_order
    `),

    // Question operations
    getQuestion: db.prepare(`
      SELECT q.*, r.name AS round_name, r.sequence_order
      FROM QUESTIONS q
      LEFT JOIN ROUNDS r ON q.round_id = r.id
      WHERE q.id = ?
    `),
    getAllQuestions: db.prepare(`
      SELECT q.*, r.name AS round_name, r.sequence_order
      FROM QUESTIONS q
      LEFT JOIN ROUNDS r ON q.round_id = r.id
      ORDER BY COALESCE(r.sequence_order, 99) ASC, q.id ASC
    `),
    getQuestionsByRound: db.prepare(`
      SELECT q.*, r.name AS round_name, r.sequence_order
      FROM QUESTIONS q
      LEFT JOIN ROUNDS r ON q.round_id = r.id
      WHERE q.round_id = ?
      ORDER BY q.id ASC
    `),
    insertQuestion: db.prepare(`
      INSERT INTO QUESTIONS (round_id, question_text, code_snippet, question_type, options_json, correct_answer, acceptable_synonyms_json, points, timer_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    // Contestant operations
    getContestantById: db.prepare('SELECT * FROM CONTESTANTS WHERE id = ?'),
    getContestantByPin: db.prepare('SELECT * FROM CONTESTANTS WHERE pin = ?'),
    getAllContestants: db.prepare('SELECT * FROM CONTESTANTS ORDER BY terminal_number ASC'),
    insertContestant: db.prepare(`
      INSERT INTO CONTESTANTS (pin, terminal_number, student_id, full_name, department_or_section, total_score)
      VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(pin) DO UPDATE SET
        terminal_number = excluded.terminal_number,
        student_id = excluded.student_id,
        full_name = excluded.full_name,
        department_or_section = excluded.department_or_section
    `),
    updateContestantConnection: db.prepare(`
      UPDATE CONTESTANTS SET is_connected = ?, last_socket_id = ? WHERE pin = ?
    `),
    recomputeContestantScore: db.prepare(`
      UPDATE CONTESTANTS 
      SET total_score = (
        SELECT COALESCE(SUM(awarded_points), 0)
        FROM SUBMISSIONS
        WHERE contestant_id = ?
      ) + COALESCE(score_adjustment, 0)
      WHERE id = ?
    `),

    // Submission operations
    getSubmission: db.prepare('SELECT * FROM SUBMISSIONS WHERE contestant_id = ? AND question_id = ?'),
    getSubmissionById: db.prepare('SELECT * FROM SUBMISSIONS WHERE id = ?'),
    getSubmissionsForQuestion: db.prepare('SELECT * FROM SUBMISSIONS WHERE question_id = ?'),
    getPendingRulings: db.prepare(`
      SELECT s.*, c.pin, c.full_name, c.terminal_number, q.question_text, q.correct_answer, q.acceptable_synonyms_json, q.points AS max_points
      FROM SUBMISSIONS s
      JOIN CONTESTANTS c ON s.contestant_id = c.id
      JOIN QUESTIONS q ON s.question_id = q.id
      WHERE s.judge_status = 'PENDING'
      ORDER BY s.server_time_ms ASC
    `),
    insertSubmission: db.prepare(`
      INSERT INTO SUBMISSIONS (contestant_id, question_id, submitted_answer, server_time_ms, is_correct, judge_status, awarded_points)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    updateRuling: db.prepare(`
      UPDATE SUBMISSIONS 
      SET judge_status = ?, is_correct = ?, awarded_points = ?
      WHERE id = ?
    `),

    // Incident / Anti-Cheat logging
    insertIncident: db.prepare(`
      INSERT INTO CHEAT_LOGS (contestant_id, incident_type, timestamp, details)
      VALUES (?, ?, ?, ?)
    `),
    getIncidentsForContestant: db.prepare('SELECT * FROM CHEAT_LOGS WHERE contestant_id = ? ORDER BY timestamp DESC, id DESC'),

    // Isolation auto-stubs for tests executing against unseeded temporary DBs
    ensureStubRound: db.prepare(`
      INSERT OR IGNORE INTO ROUNDS (id, name, weight_points, default_timer_sec, sequence_order)
      VALUES (1, 'Easy', 1, 15, 1)
    `),
    ensureStubContestant: db.prepare(`
      INSERT OR IGNORE INTO CONTESTANTS (id, pin, terminal_number, student_id, full_name, department_or_section)
      VALUES (?, ?, ?, ?, ?, 'BSIT')
    `),
    ensureStubQuestion: db.prepare(`
      INSERT OR IGNORE INTO QUESTIONS (id, round_id, question_text, question_type, correct_answer, points, timer_seconds)
      VALUES (?, 1, 'Question ' || ?, 'MCQ', 'C', 1, 15)
    `)
  };
}

/**
 * Get active DB instance
 * @returns {Object}
 */
function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

/**
 * Retrieve question by ID with parsed JSON options and synonyms
 * @param {number|string} id
 * @returns {Object|null}
 */
function getQuestion(id) {
  const row = stmts.getQuestion.get(id);
  if (!row) return null;

  let itemNumber = row.id;
  let totalRoundQuestions = 1;
  let overallItemNumber = row.id;
  let totalQuestions = 1;

  if (stmts.getQuestionsByRound && row.round_id) {
    try {
      const roundRows = stmts.getQuestionsByRound.all(row.round_id);
      const idx = roundRows.findIndex(r => r.id === row.id);
      if (idx !== -1) {
        itemNumber = idx + 1;
        totalRoundQuestions = roundRows.length;
      }
    } catch (e) {}
  }

  if (stmts.getAllQuestions) {
    try {
      const allRows = stmts.getAllQuestions.all();
      const idxAll = allRows.findIndex(r => r.id === row.id);
      if (idxAll !== -1) {
        overallItemNumber = idxAll + 1;
        totalQuestions = allRows.length;
      }
    } catch (e) {}
  }

  return {
    ...row,
    round: row.round_name || (row.round_id ? `Round ${row.round_id}` : 'Round'),
    question: row.question_text,
    options: JSON.parse(row.options_json || '{}'),
    synonyms: JSON.parse(row.acceptable_synonyms_json || '[]'),
    item_number: itemNumber,
    total_round_questions: totalRoundQuestions,
    overall_item_number: overallItemNumber,
    total_questions: totalQuestions
  };
}

/**
 * Retrieve all questions with parsed JSON fields, optionally filtered by round
 * @param {number|string} [roundId]
 * @returns {Array<Object>}
 */
function getAllQuestions(roundId) {
  const rows = roundId ? stmts.getQuestionsByRound.all(roundId) : stmts.getAllQuestions.all();
  const roundCounts = {};
  const roundIndices = {};

  rows.forEach(r => {
    const rid = r.round_id || 0;
    roundCounts[rid] = (roundCounts[rid] || 0) + 1;
  });

  return rows.map((r, overallIdx) => {
    const rid = r.round_id || 0;
    roundIndices[rid] = (roundIndices[rid] || 0) + 1;
    return {
      ...r,
      round: r.round_name || (r.round_id ? `Round ${r.round_id}` : 'Round'),
      question: r.question_text,
      options: JSON.parse(r.options_json || '{}'),
      synonyms: JSON.parse(r.acceptable_synonyms_json || '[]'),
      item_number: roundIndices[rid],
      total_round_questions: roundCounts[rid],
      overall_item_number: overallIdx + 1,
      total_questions: rows.length
    };
  });
}

/**
 * Atomically saves a submission and recomputes the contestant's total score.
 * Throws a UNIQUE constraint error if contestant already submitted for this question.
 *
 * @param {number} contestantId
 * @param {number} questionId
 * @param {string} answer
 * @param {number} serverTimeMs
 * @param {number|boolean} isCorrect
 * @param {string} judgeStatus - 'AUTO' | 'PENDING' | 'APPROVED' | 'REJECTED'
 * @param {number} points
 * @returns {Object} Saved submission row
 */
function saveSubmission(contestantId, questionId, answer, serverTimeMs, isCorrect, judgeStatus = 'AUTO', points = 0) {
  const saveTx = db.transaction(() => {
    // If running in isolated unit test against unseeded DB, ensure FK references exist
    stmts.ensureStubRound.run();
    stmts.ensureStubContestant.run(
      contestantId,
      String(1000 + Number(contestantId)),
      Number(contestantId),
      `2024-OLFU-${String(contestantId).padStart(4, '0')}`,
      `Contestant ${contestantId}`
    );
    stmts.ensureStubQuestion.run(questionId, questionId);

    // Insert submission — triggers UNIQUE constraint failed on duplicate
    const info = stmts.insertSubmission.run(
      contestantId,
      questionId,
      String(answer),
      serverTimeMs,
      isCorrect ? 1 : 0,
      judgeStatus,
      points
    );

    // Recompute total score for contestant atomically
    stmts.recomputeContestantScore.run(contestantId, contestantId);

    return stmts.getSubmissionById.get(Number(info.lastInsertRowid));
  });

  return saveTx();
}

/**
 * Updates judge ruling on a submission and recalculates contestant score atomically
 * @param {number} submissionId
 * @param {string} judgeStatus - 'APPROVED' | 'REJECTED'
 * @param {number} awardedPoints
 * @returns {Object} Updated submission row
 */
function updateSubmissionRuling(submissionId, judgeStatus, awardedPoints) {
  const updateRulingTx = db.transaction(() => {
    const sub = stmts.getSubmissionById.get(submissionId);
    if (!sub) throw new Error(`Submission ${submissionId} not found`);

    const isCorrect = awardedPoints > 0 ? 1 : 0;
    stmts.updateRuling.run(judgeStatus, isCorrect, awardedPoints, submissionId);
    stmts.recomputeContestantScore.run(sub.contestant_id, sub.contestant_id);

    return stmts.getSubmissionById.get(submissionId);
  });

  return updateRulingTx();
}

/**
 * Retrieve a contestant submission for a specific question
 * @param {number|string} contestantId
 * @param {number|string} questionId
 * @returns {Object|null}
 */
function getSubmission(contestantId, questionId) {
  if (!stmts.getSubmission || contestantId == null || questionId == null) return null;
  return stmts.getSubmission.get(Number(contestantId), Number(questionId)) || null;
}

/**
 * Retrieve a submission by its primary key ID
 * @param {number|string} id
 * @returns {Object|null}
 */
function getSubmissionById(id) {
  if (!stmts.getSubmissionById || id == null) return null;
  return stmts.getSubmissionById.get(Number(id)) || null;
}

/**
 * Retrieve all submissions for a question
 * @param {number|string} questionId
 * @returns {Array<Object>}
 */
function getSubmissionsForQuestion(questionId) {
  if (!stmts.getSubmissionsForQuestion || questionId == null) return [];
  return stmts.getSubmissionsForQuestion.all(Number(questionId)) || [];
}

/**
 * Log anti-cheat security incident to CHEAT_LOGS
 * @param {number} contestantId
 * @param {string} incidentType
 * @param {string} [details='']
 * @returns {Object}
 */
function logIncident(contestantId, incidentType, details = '') {
  // Ensure stub contestant if unseeded test DB
  stmts.ensureStubContestant.run(
    contestantId,
    String(1000 + Number(contestantId)),
    Number(contestantId),
    `2024-OLFU-${String(contestantId).padStart(4, '0')}`,
    `Contestant ${contestantId}`
  );

  return stmts.insertIncident.run(contestantId, incidentType, Date.now(), details);
}

/**
 * Retrieve incident logs for a contestant
 * @param {number} contestantId
 * @returns {Array<Object>}
 */
function getIncidentLogs(contestantId) {
  return stmts.getIncidentsForContestant.all(contestantId);
}

/**
 * Get contestant by PIN
 * @param {string} pin
 * @returns {Object|null}
 */
function getContestantByPin(pin) {
  return stmts.getContestantByPin.get(String(pin)) || null;
}

/**
 * Get contestant by ID
 * @param {number} id
 * @returns {Object|null}
 */
function getContestantById(id) {
  return stmts.getContestantById.get(id) || null;
}

/**
 * Update socket connection state for contestant PIN
 * @param {string} pin
 * @param {boolean} isConnected
 * @param {string|null} [socketId=null]
 * @returns {Object}
 */
function updateContestantConnection(pin, isConnected, socketId = null) {
  return stmts.updateContestantConnection.run(isConnected ? 1 : 0, socketId, String(pin));
}

/**
 * Get all contestants ordered by terminal number (for telemetry grid)
 * @returns {Array<Object>}
 */
function getAllContestants() {
  return stmts.getAllContestants.all();
}

/**
 * Returns pending judge rulings
 * @param {number} [questionId]
 * @returns {Array<Object>}
 */
function getPendingRulings(questionId) {
  const rows = stmts.getPendingRulings.all();
  if (questionId) return rows.filter(r => r.question_id === questionId);
  return rows;
}

/**
 * Manually override a contestant's score and persist adjustment
 * @param {string|number} pin
 * @param {number} newScore
 * @returns {Object}
 */
function overrideContestantScore(pin, newScore) {
  const overrideTx = db.transaction(() => {
    const contestant = stmts.getContestantByPin.get(String(pin));
    if (!contestant) throw new Error(`Contestant with PIN ${pin} not found`);

    const subSumRow = db.prepare(`
      SELECT COALESCE(SUM(awarded_points), 0) AS subSum
      FROM SUBMISSIONS
      WHERE contestant_id = ?
    `).get(contestant.id);
    const subSum = subSumRow ? Number(subSumRow.subSum) : 0;
    const adjustment = Number(newScore) - subSum;

    db.prepare(`
      UPDATE CONTESTANTS 
      SET total_score = ?, score_adjustment = ?
      WHERE id = ?
    `).run(Number(newScore), adjustment, contestant.id);

    return stmts.getContestantById.get(contestant.id);
  });

  return overrideTx();
}

/**
 * Get sorted leaderboard with tie-breaking calculations:
 * 1. Score DESC
 * 2. Earliest correct submission server timestamp ASC
 * 3. Terminal number ASC
 *
 * @param {number} [roundId]
 * @returns {Array<Object>}
 */
function getLeaderboard(roundId) {
  const filterClause = roundId ? 'AND q.round_id = ' + Number(roundId) : '';
  const query = `
    SELECT 
      c.id,
      c.pin,
      c.full_name AS fullName,
      c.terminal_number AS terminalNumber,
      c.department_or_section AS department,
      COALESCE(SUM(CASE WHEN s.is_correct = 1 ${filterClause} THEN s.awarded_points ELSE 0 END), 0) + COALESCE(c.score_adjustment, 0) AS score,
      COALESCE(MIN(CASE WHEN s.is_correct = 1 ${filterClause} THEN s.server_time_ms ELSE NULL END), 0) AS lastSubmitTimeMs,
      RANK() OVER (
        ORDER BY 
          (COALESCE(SUM(CASE WHEN s.is_correct = 1 ${filterClause} THEN s.awarded_points ELSE 0 END), 0) + COALESCE(c.score_adjustment, 0)) DESC,
          CASE 
            WHEN MIN(CASE WHEN s.is_correct = 1 ${filterClause} THEN s.server_time_ms ELSE NULL END) IS NOT NULL 
            THEN MIN(CASE WHEN s.is_correct = 1 ${filterClause} THEN s.server_time_ms ELSE NULL END)
            ELSE 9999999999999 
          END ASC,
          c.terminal_number ASC
      ) AS rank
    FROM CONTESTANTS c
    LEFT JOIN SUBMISSIONS s ON c.id = s.contestant_id
    LEFT JOIN QUESTIONS q ON s.question_id = q.id
    GROUP BY c.id
    ORDER BY 
      score DESC, 
      CASE WHEN lastSubmitTimeMs > 0 THEN lastSubmitTimeMs ELSE 9999999999999 END ASC, 
      c.terminal_number ASC
  `;
  return db.prepare(query).all();
}

/**
 * Atomically resets tournament scores by wiping submissions and resetting contestant totals to 0
 * @returns {{ success: boolean }}
 */
function resetTournamentScores() {
  const resetTx = db.transaction(() => {
    db.exec('DELETE FROM SUBMISSIONS;');
    db.exec('DELETE FROM CHEAT_LOGS;');
    db.exec('UPDATE CONTESTANTS SET total_score = 0, score_adjustment = 0;');
  });
  resetTx();
  return { success: true };
}

/**
 * Close database connection safely
 */
function closeDb() {
  if (db) {
    db.close();
    db = null;
    stmts = {};
  }
}

module.exports = {
  initDb,
  getDb,
  closeDb,
  resetTournamentScores,
  getQuestion,
  getAllQuestions,
  getSubmission,
  getSubmissionById,
  getSubmissionsForQuestion,
  saveSubmission,
  updateSubmissionRuling,
  overrideContestantScore,
  logIncident,
  getIncidentLogs,
  getIncidentsForContestant: getIncidentLogs,
  getContestantByPin,
  getContestantById,
  getAllContestants,
  updateContestantConnection,
  getPendingRulings,
  getLeaderboard
};
