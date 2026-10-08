/**
 * public/js/judge.js
 * OLFU IT Olympics LAN Quiz Bee System (ITPM 311)
 * Judge / Tabulator Evaluation Panel Client Controller (Zero-CDN)
 */

(function () {
  'use strict';

  let socket = null;
  const pendingDisputes = new Map(); // submissionId -> dispute item data
  let resolvedCount = 0;

  // DOM Elements
  const elStatusDot = document.getElementById('judge-status-dot');
  const elStatusText = document.getElementById('judge-status-text');
  const btnRefreshQueue = document.getElementById('btn-refresh-queue');
  const elPendingCount = document.getElementById('pending-count');
  const elResolvedCount = document.getElementById('resolved-count-badge');
  const elQueueContainer = document.getElementById('judge-queue');
  const elEmptyQueue = document.getElementById('empty-queue');
  const elResolvedContainer = document.getElementById('resolved-queue');

  function init() {
    setupButtons();
    initSocketConnection();
  }

  function setupButtons() {
    if (btnRefreshQueue) {
      btnRefreshQueue.addEventListener('click', () => {
        if (socket && socket.connected) {
          socket.emit('judge:queue:get', (res) => {
            if (res && res.success && Array.isArray(res.items)) {
              syncQueue(res.items);
            }
          });
        }
      });
    }
  }

  function initSocketConnection() {
    if (typeof io === 'undefined') return;

    socket = io();

    socket.on('connect', () => {
      elStatusDot.className = 'status-dot online';
      elStatusText.textContent = 'Connected (LAN)';
      socket.emit('judge:join');
    });

    socket.on('disconnect', () => {
      elStatusDot.className = 'status-dot offline';
      elStatusText.textContent = 'Disconnected';
    });

    socket.on('judge:init', (data) => {
      if (!data || !data.success) return;
      if (Array.isArray(data.pendingDisputes)) {
        syncQueue(data.pendingDisputes);
      }
    });

    socket.on('judge:queue:response', (data) => {
      if (data && data.success && Array.isArray(data.items)) {
        syncQueue(data.items);
      }
    });

    // Inbound new dispute
    socket.on('judge:dispute:new', (dispute) => {
      addDisputeCard(dispute);
    });

    // Dispute resolved by any judge in lab
    socket.on('judge:dispute:resolved', (resolution) => {
      removeDisputeCard(resolution.submissionId, resolution);
    });
  }

  function syncQueue(items) {
    pendingDisputes.clear();
    // Clear all existing cards except empty-queue
    const existingCards = elQueueContainer.querySelectorAll('.dispute-card');
    existingCards.forEach((c) => c.remove());

    items.forEach((item) => {
      addDisputeCard(item);
    });

    updateQueueDisplay();
  }

  function addDisputeCard(item) {
    const subId = item.submissionId || item.id;
    if (!subId || pendingDisputes.has(subId)) return;

    pendingDisputes.set(subId, item);

    const padNum = String(item.terminalNumber || item.terminal_number || '??').padStart(2, '0');
    const name = item.fullName || item.full_name || 'Contestant';
    const pin = item.pin || '----';
    const qText = item.questionText || item.question || 'Identification Question';
    const expected = item.correctAnswer || item.correct_answer || '';
    const submitted = item.submittedAnswer || item.submitted_answer || '';
    const maxPoints = item.maxPoints !== undefined ? item.maxPoints : (item.points !== undefined ? item.points : 2);

    // Parse synonyms if present
    let syns = [];
    if (item.acceptableSynonyms || item.acceptable_synonyms) {
      const raw = item.acceptableSynonyms || item.acceptable_synonyms;
      syns = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : []);
    }

    const card = document.createElement('div');
    card.className = 'dispute-card';
    card.id = `dispute-${subId}`;
    card.textContent = `${name} T${padNum} PIN: ${pin} ${qText} ${expected} ${submitted} ${syns.join(' ')}`;

    card.innerHTML = `
      <div class="dispute-header">
        <div class="dispute-contestant-info">
          <span class="dispute-terminal-tag">T${escapeHtml(padNum)}</span>
          <span style="font-weight: 700; font-size: 1.05rem;">${escapeHtml(name)}</span>
          <span style="font-size: 0.8125rem; color: var(--text-muted); font-family: var(--font-mono);">PIN: ${escapeHtml(pin)}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          ${item.similarity !== undefined ? `<span class="badge" style="background: rgba(14, 165, 233, 0.15); color: #38bdf8; border: 1px solid rgba(14, 165, 233, 0.3);">Match: ${item.similarity}%</span>` : ''}
          <span class="badge badge-gold">SUBMISSION #${subId}</span>
        </div>
      </div>

      <div class="dispute-question-box">
        <div class="dispute-question-label">Question Prompt</div>
        <div class="dispute-question-prompt">${escapeHtml(qText)}</div>
      </div>

      <div class="dispute-comparison-grid">
        <div class="comparison-box expected-box">
          <div class="comparison-label">Canonical Expected Answer</div>
          <div class="comparison-val text-emerald">${escapeHtml(expected)}</div>
          ${
            syns.length > 0
              ? `<div class="synonyms-row">
                  ${syns.map((s) => `<span class="synonym-pill">${escapeHtml(s)}</span>`).join('')}
                </div>`
              : ''
          }
        </div>

        <div class="comparison-box submitted-box">
          <div class="comparison-label">Contestant's Submitted Answer</div>
          <div class="comparison-val text-gold">${escapeHtml(submitted)}</div>
        </div>
      </div>

      <div class="dispute-actions-row">
        <div class="points-selector">
          <label for="pts-${subId}">Points:</label>
          <input type="number" id="pts-${subId}" class="points-input" value="${maxPoints}" min="0" max="10">
        </div>
        <button class="btn btn-danger btn-reject" data-id="${subId}">Reject (0 Pts)</button>
        <button class="btn btn-primary btn-approve" data-id="${subId}">Approve Answer</button>
      </div>
    `;

    // Button event bindings
    let btnApprove = card.querySelector('.btn-approve');
    let btnReject = card.querySelector('.btn-reject');
    let inputPoints = card.querySelector(`#pts-${subId}`);

    if (!btnApprove) {
      btnApprove = document.createElement('button');
      btnApprove.className = 'btn btn-primary btn-approve';
      btnApprove.textContent = 'Approve Answer';
      btnApprove.dataset.id = String(subId);
      card.appendChild(btnApprove);
    }
    if (!btnReject) {
      btnReject = document.createElement('button');
      btnReject.className = 'btn btn-danger btn-reject';
      btnReject.textContent = 'Reject (0 Pts)';
      btnReject.dataset.id = String(subId);
      card.appendChild(btnReject);
    }
    if (!inputPoints) {
      inputPoints = document.createElement('input');
      inputPoints.id = `pts-${subId}`;
      inputPoints.className = 'points-input';
      inputPoints.value = String(maxPoints);
      card.appendChild(inputPoints);
    }

    if (typeof document.register === 'function') {
      document.register(card);
      document.register(inputPoints);
    }

    btnApprove.addEventListener('click', () => {
      const pts = Number(inputPoints.value) || maxPoints;
      sendRuling(subId, 'APPROVED', pts, btnApprove, btnReject);
    });

    btnReject.addEventListener('click', () => {
      sendRuling(subId, 'REJECTED', 0, btnApprove, btnReject);
    });

    elQueueContainer.appendChild(card);
    updateQueueDisplay();
  }

  function sendRuling(submissionId, status, points, btnA, btnR) {
    if (!socket) return;
    if (btnA) btnA.disabled = true;
    if (btnR) btnR.disabled = true;

    socket.emit('judge:dispute:action', {
      submissionId,
      status,
      points
    }, (ack) => {
      if (ack && ack.success) {
        removeDisputeCard(submissionId, { status, awardedPoints: points });
      } else {
        alert('Action failed: ' + (ack?.error || 'Unknown error'));
        if (btnA) btnA.disabled = false;
        if (btnR) btnR.disabled = false;
      }
    });
  }

  function removeDisputeCard(submissionId, resolution) {
    const card = document.getElementById(`dispute-${submissionId}`);
    if (card) {
      card.classList.add('fade-out');
      if (typeof setTimeout === 'function') {
        setTimeout(() => {
          card.remove();
          updateQueueDisplay();
        }, 250);
      } else {
        card.remove();
        updateQueueDisplay();
      }
    }

    const item = pendingDisputes.get(submissionId);
    pendingDisputes.delete(submissionId);

    // Add to resolved log
    if (item && elResolvedContainer) {
      resolvedCount++;
      if (elResolvedCount) elResolvedCount.textContent = `${resolvedCount} Resolved`;

      const resolvedCard = document.createElement('div');
      resolvedCard.className = 'dispute-card';
      const statusBadge = resolution.status === 'APPROVED' ? 'badge-emerald' : 'badge-danger';
      const statusText = resolution.status === 'APPROVED' ? `APPROVED (+${resolution.awardedPoints} PTS)` : 'REJECTED (0 PTS)';

      const termNum = item.terminalNumber || item.terminal_number || resolution?.terminalNumber || '??';
      const studentName = item.fullName || item.full_name || 'Contestant';
      const subAns = item.submittedAnswer || item.submitted_answer || '';
      const expAns = item.correctAnswer || item.correct_answer || '';

      resolvedCard.textContent = `Submission #${submissionId} Station ${termNum} (${studentName}) ${statusText}`;

      resolvedCard.innerHTML = `
        <div class="flex justify-between items-center">
          <span style="font-weight: 700;">Submission #${submissionId} &bull; Station ${escapeHtml(termNum)} (${escapeHtml(studentName)})</span>
          <span class="badge ${statusBadge}">${statusText}</span>
        </div>
        <div style="font-size: 0.875rem; color: var(--text-secondary); margin-top: 0.25rem;">
          Submitted: "<strong>${escapeHtml(subAns)}</strong>" | Expected: "${escapeHtml(expAns)}"
        </div>
      `;
      elResolvedContainer.prepend(resolvedCard);
    }
  }

  function updateQueueDisplay() {
    const count = pendingDisputes.size;
    if (elPendingCount) elPendingCount.textContent = `${count} Pending`;

    if (count === 0) {
      if (elEmptyQueue) elEmptyQueue.classList.remove('hidden');
    } else {
      if (elEmptyQueue) elEmptyQueue.classList.add('hidden');
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Auto-run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
