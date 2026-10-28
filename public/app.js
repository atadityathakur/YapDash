(() => {
  'use strict';

  /* ================================================================== */
  /* Utilities                                                           */
  /* ================================================================== */

  const app = document.getElementById('app');
  const LETTERS = ['A', 'B', 'C', 'D'];
  const TIME_CHOICES = [10, 15, 20, 30, 45, 60, 90];

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') for (const [a, b] of Object.entries(v)) el.style.setProperty(a, b);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    const add = (kid) => {
      if (kid == null || kid === false) return;
      if (Array.isArray(kid)) kid.forEach(add);
      else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    };
    kids.forEach(add);
    return el;
  }

  const ICONS = {
    back: '<path d="M15 6l-6 6 6 6"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 13l4 4L19 7"/>',
    download: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  };

  function icon(name, size = 18) {
    const span = document.createElement('span');
    span.style.display = 'inline-flex';
    span.innerHTML =
      `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return span;
  }

  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const uid = () => Math.random().toString(36).slice(2, 10);
  const spaced = (code) => (code && code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code || '');

  function ordinal(n) {
    const v = n % 100;
    const s = ['th', 'st', 'nd', 'rd'];
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage unavailable */
      }
    },
    del(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* storage unavailable */
      }
    },
  };

  let toastTimer = null;
  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 3200);
  }

  async function copyText(text, okMessage) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage);
    } catch {
      const ta = h('textarea', { 'aria-hidden': 'true', style: { position: 'fixed', opacity: '0', top: '0' } });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      toast(ok ? okMessage : 'Copy failed. Select the text and copy it manually.');
    }
  }

  /* ================================================================== */
  /* Saved quizzes (browser storage on the host's device)                */
  /* ================================================================== */

  const QUIZ_KEY = 'YapDash.quizzes.v1';
  let quizzes = store.get(QUIZ_KEY, []);
  if (!Array.isArray(quizzes)) quizzes = [];

  const saveQuizzes = () => store.set(QUIZ_KEY, quizzes);

  function blankQuestion() {
    return { uid: uid(), text: '', options: ['', '', '', ''], correct: -1, time: 20 };
  }

  function sampleQuiz() {
    const q = (text, options, correct, time = 20) => ({ uid: uid(), text, options, correct, time });
    return {
      id: uid(),
      title: 'General knowledge warm-up',
      updated: Date.now(),
      questions: [
        q('What does GDP stand for?', ['Gross Domestic Product', 'General Daily Profit', 'Global Demand Price', 'Gross Dividend Payout'], 0),
        q('Which ocean is the largest by area?', ['Atlantic', 'Indian', 'Pacific', 'Arctic'], 2),
        q('What is the chemical symbol for sodium?', ['So', 'Na', 'Sd', 'Sn'], 1, 15),
        q('Who wrote the novel Pride and Prejudice?', ['Charlotte Brontë', 'Jane Austen', 'Mary Shelley', 'George Eliot'], 1),
        q('A hexagon has how many sides?', ['5', '6', '7', '8'], 1, 10),
      ],
    };
  }

  function prepareQuiz(quiz) {
    const fail = (message, qi, field) => ({ ok: false, message, qi, field });
    if (!quiz.questions.length) return fail('Add at least one question.');
    const questions = [];
    for (let i = 0; i < quiz.questions.length; i++) {
      const x = quiz.questions[i];
      if (!x.text.trim()) return fail(`Question ${i + 1} has no text.`, i, 'text');
      const kept = [];
      let correct = -1;
      x.options.forEach((o, j) => {
        if (o.trim()) {
          if (j === x.correct) correct = kept.length;
          kept.push(o.trim());
        }
      });
      if (kept.length < 2) return fail(`Question ${i + 1} needs at least two options.`, i, 'options');
      if (correct < 0) return fail(`Choose the correct answer for question ${i + 1}.`, i, 'correct');
      questions.push({ text: x.text.trim(), options: kept, correct, time: x.time });
    }
    return { ok: true, quiz: { title: quiz.title.trim() || 'Untitled quiz', questions } };
  }

  /* Bulk text format:
       What is the capital of France?
       A) Berlin
       B) Paris *
       C) Madrid
     A blank line separates questions. Mark the right option with * or add "Answer: B". */
  function parseBulk(text) {
    const blocks = text.replace(/\r/g, '').split(/\n\s*\n+/);
    const questions = [];
    let skipped = 0;
    let unmarked = 0;

    for (const block of blocks) {
      const lines = block.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.length) continue;
      const qText = [];
      const opts = [];
      let correct = -1;
      let letter = -1;

      for (const line of lines) {
        const am = line.match(/^(?:answer|ans|correct)\s*[:=-]\s*\(?([A-Da-d])\b/i);
        if (am) {
          letter = am[1].toUpperCase().charCodeAt(0) - 65;
          continue;
        }
        const om = qText.length ? line.match(/^(\*?)\s*\(?([A-Da-d])[).:-]\s+(.*)$/) : null;
        if (om) {
          let t = om[3].trim();
          let star = om[1] === '*';
          if (/\*\s*$/.test(t)) {
            star = true;
            t = t.replace(/\s*\*+\s*$/, '');
          }
          if (opts.length < 4) {
            opts.push(t);
            if (star) correct = opts.length - 1;
          }
          continue;
        }
        if (!opts.length) qText.push(line.replace(/^(?:q(?:uestion)?\s*\d*|\d+)\s*[).:-]\s*/i, ''));
        else opts[opts.length - 1] += ` ${line}`;
      }

      if (!qText.length || opts.length < 2) {
        skipped += 1;
        continue;
      }
      if (correct < 0 && letter >= 0 && letter < opts.length) correct = letter;
      if (correct < 0) unmarked += 1;
      const padded = opts.slice();
      while (padded.length < 4) padded.push('');
      questions.push({ uid: uid(), text: qText.join(' '), options: padded, correct, time: 20 });
    }
    return { questions, skipped, unmarked };
  }

  function quizToText(quiz) {
    return quiz.questions
      .map((q) => {
        const lines = [q.text.trim()];
        q.options.forEach((o, i) => {
          if (o.trim()) lines.push(`${LETTERS[i]}) ${o.trim()}${i === q.correct ? ' *' : ''}`);
        });
        return lines.join('\n');
      })
      .join('\n\n');
  }

  /* ================================================================== */
  /* Connection                                                          */
  /* ================================================================== */

  const net = { ws: null, open: false, queue: [], retry: 0, timer: null };
  let session = store.get('YapDash.session', null);
  let game = null;
  let offset = 0;
  let view = 'home';
  let busy = null; // 'join' | 'create'
  let formError = '';
  let notice = '';
  let editing = null;
  let editorMark = null;

  function persistSession() {
    if (session) store.set('YapDash.session', session);
    else store.del('YapDash.session');
  }

  function clearSession() {
    session = null;
    game = null;
    persistSession();
  }

  function updateConn() {
    const el = document.getElementById('conn');
    const needs = !!session && !net.open;
    el.hidden = !needs;
  }

  function connect() {
    if (net.ws && net.ws.readyState <= 1) return;
    clearTimeout(net.timer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    net.ws = ws;

    ws.addEventListener('open', () => {
      net.open = true;
      net.retry = 0;
      updateConn();
      if (session) {
        if (session.role === 'host') ws.send(JSON.stringify({ type: 'host:resume', code: session.code, hostKey: session.hostKey }));
        else ws.send(JSON.stringify({ type: 'player:join', code: session.code, token: session.token, name: session.name }));
      }
      for (const m of net.queue.splice(0)) ws.send(m);
    });

    ws.addEventListener('message', onMessage);

    ws.addEventListener('close', () => {
      if (net.ws !== ws) return;
      net.open = false;
      updateConn();
      if (session || busy) scheduleReconnect();
    });

    ws.addEventListener('error', () => {});
  }

  function scheduleReconnect() {
    net.retry += 1;
    if (busy && net.retry >= 3) {
      busy = null;
      net.queue = [];
      formError = 'Could not reach the server. Check your connection and try again.';
      net.retry = 0;
      toast(formError);
      render();
      return;
    }
    const delay = Math.min(800 * 2 ** Math.min(net.retry, 4), 8000);
    clearTimeout(net.timer);
    net.timer = setTimeout(connect, delay);
  }

  function sendMsg(obj) {
    const raw = JSON.stringify(obj);
    if (net.open) net.ws.send(raw);
    else {
      net.queue.push(raw);
      connect();
    }
  }

  function onMessage(ev) {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (m.type === 'hello') {
      session =
        m.role === 'host'
          ? { role: 'host', code: m.code, hostKey: m.hostKey }
          : { role: 'player', code: m.code, token: m.token, name: m.name };
      persistSession();
      if (m.role === 'player') store.set('YapDash.name', m.name);
    } else if (m.type === 'state') {
      game = m;
      offset = m.serverNow - Date.now();
      view = m.role;
      busy = null;
      formError = '';
      render();
    } else if (m.type === 'error') {
      const wasResume = !!session;
      busy = null;
      if (m.code === 'room_not_found') {
        clearSession();
        view = 'home';
        if (wasResume) notice = m.message;
        else formError = m.message;
        render();
      } else if (view === 'home') {
        formError = m.message;
        render();
      } else {
        toast(m.message);
        if (view === 'editor') render();
      }
    } else if (m.type === 'kicked') {
      clearSession();
      view = 'home';
      notice = 'The host removed you from this quiz.';
      render();
    } else if (m.type === 'ended') {
      clearSession();
      view = 'home';
      notice = 'The host ended this quiz.';
      render();
    }
  }

  function joinRoom(code, name) {
    clearSession();
    busy = 'join';
    formError = '';
    store.set('YapDash.name', name);
    render();
    sendMsg({ type: 'player:join', code, name });
  }

  function hostQuiz(quiz) {
    const prepared = prepareQuiz(quiz);
    if (!prepared.ok) {
      toast(prepared.message);
      return prepared;
    }
    clearSession();
    busy = 'create';
    formError = '';
    if (view !== 'editor') render();
    sendMsg({ type: 'host:create', quiz: prepared.quiz });
    return prepared;
  }

  function leaveToHome() {
    view = 'home';
    game = null;
    editing = null;
    render();
  }

  function leaveAsPlayer() {
    if (net.open) net.ws.send(JSON.stringify({ type: 'player:leave' }));
    clearSession();
    leaveToHome();
  }

  function endAsHost() {
    if (net.open) net.ws.send(JSON.stringify({ type: 'host:end' }));
    clearSession();
    leaveToHome();
  }

  /* ================================================================== */
  /* Chrome                                                              */
  /* ================================================================== */

  function mark() {
    const span = document.createElement('span');
    span.style.display = 'inline-flex';
    span.innerHTML =
      '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><rect class="mark-bg" width="24" height="24" rx="6"/><circle class="mark-fg" cx="11.5" cy="11.5" r="5" fill="none" stroke-width="2.2"/><path class="mark-fg" d="M14.8 14.8l3.6 3.6" stroke-width="2.2" stroke-linecap="round"/></svg>';
    return span;
  }

  function wordmark(linked) {
    const inner = [mark(), h('span', null, 'YapDash')];
    if (!linked) return h('span', { class: 'wordmark' }, inner);
    return h(
      'a',
      {
        class: 'wordmark',
        href: '/',
        onclick: (e) => {
          e.preventDefault();
          if (view !== 'home') leaveToHome();
        },
      },
      inner
    );
  }

  function topbar({ linked = true, title = '', right = [] } = {}) {
    return h(
      'header',
      { class: 'topbar' },
      h(
        'div',
        { class: 'wrap topbar-in' },
        wordmark(linked),
        h('div', { class: 'topbar-right' }, title ? h('span', { class: 'topbar-title' }, title) : null, right)
      )
    );
  }

  function shell(bar, content, pageClass = '') {
    return h('div', null, bar, h('main', { class: `wrap page ${pageClass}` }, content));
  }

  function setScreen(node) {
    app.replaceChildren(node);
  }

  /* ================================================================== */
  /* Home                                                                */
  /* ================================================================== */

  const joinDraft = { code: null, name: null };

  function renderHome() {
    const params = new URLSearchParams(location.search);
    const prefill = (params.get('room') || '').replace(/\D/g, '').slice(0, 6);
    const savedName = store.get('YapDash.name', '');

    const codeInput = h('input', {
      class: 'input code-input',
      id: 'room-code',
      inputmode: 'numeric',
      autocomplete: 'off',
      maxlength: '7',
      placeholder: '000 000',
      value: joinDraft.code != null ? joinDraft.code : spaced(prefill),
      'aria-describedby': 'join-error',
    });
    codeInput.addEventListener('input', () => {
      const d = codeInput.value.replace(/\D/g, '').slice(0, 6);
      codeInput.value = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
      joinDraft.code = codeInput.value;
    });

    const nameInput = h('input', {
      class: 'input',
      id: 'player-name',
      maxlength: '20',
      autocomplete: 'off',
      placeholder: 'How you appear on the leaderboard',
      value: joinDraft.name != null ? joinDraft.name : savedName,
      oninput: (e) => {
        joinDraft.name = e.target.value;
      },
    });

    const form = h(
      'form',
      {
        class: 'stack',
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          const code = codeInput.value.replace(/\D/g, '');
          const name = nameInput.value.trim();
          if (code.length !== 6) {
            formError = 'Enter the 6-digit room code shown by your host.';
            return render();
          }
          if (!name) {
            formError = 'Enter a name to join.';
            return render();
          }
          joinRoom(code, name);
        },
      },
      h('div', { class: 'field' }, h('label', { for: 'room-code' }, 'Room code'), codeInput),
      h('div', { class: 'field' }, h('label', { for: 'player-name' }, 'Your name'), nameInput),
      formError ? h('div', { class: 'form-error', id: 'join-error', role: 'alert' }, formError) : null,
      h(
        'button',
        { class: 'btn btn-primary btn-lg btn-block', type: 'submit', disabled: busy === 'join' },
        busy === 'join' ? 'Joining…' : 'Join quiz'
      )
    );

    const joinCard = h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Join a quiz')),
      h('div', { class: 'card-body' }, form)
    );

    let hostBody;
    if (!quizzes.length) {
      hostBody = h(
        'div',
        { class: 'empty' },
        h('p', { class: 'muted' }, 'Write your questions once and run them live as many times as you like. Quizzes are saved in this browser.'),
        h(
          'div',
          { class: 'inline' },
          h('button', { class: 'btn btn-primary', onclick: () => openEditor(null) }, icon('plus'), 'Create a quiz'),
          h(
            'button',
            {
              class: 'btn btn-secondary',
              onclick: () => {
                const q = sampleQuiz();
                quizzes.unshift(q);
                saveQuizzes();
                render();
              },
            },
            'Add a sample quiz'
          )
        )
      );
    } else {
      hostBody = h('div', null, quizzes.map(quizRow));
    }

    const hostCard = h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h2', { class: 'card-title' }, 'Host a quiz'),
        quizzes.length ? h('button', { class: 'btn btn-secondary btn-sm', onclick: () => openEditor(null) }, icon('plus', 16), 'New quiz') : null
      ),
      hostBody
    );

    const content = [
      notice
        ? h(
            'div',
            { class: 'notice', role: 'status' },
            h('span', null, notice),
            h('button', { class: 'icon-btn', 'aria-label': 'Dismiss', onclick: () => { notice = ''; render(); } }, icon('x', 16))
          )
        : null,
      h(
        'div',
        { class: 'hero' },
        h('h1', null, 'Live quizzes, scored as the answers come in.'),
        h('p', null, 'Build a quiz in minutes, share a six-digit room code, and everyone plays from their own device.')
      ),
      h('div', { class: 'home-grid' }, joinCard, hostCard),
    ];

    setScreen(shell(topbar({ linked: false }), content));
    if (prefill && joinDraft.code == null) nameInput.focus();
  }

  const confirmDelete = new Set();

  function quizRow(q) {
    const n = q.questions.length;
    const meta = `${n} ${n === 1 ? 'question' : 'questions'} · edited ${new Date(q.updated || Date.now()).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
    const del = confirmDelete.has(q.id);
    return h(
      'div',
      { class: 'qrow' },
      h('div', { style: { 'min-width': '0' } }, h('div', { class: 'qrow-title' }, q.title || 'Untitled quiz'), h('div', { class: 'qrow-meta' }, meta)),
      h(
        'div',
        { class: 'qrow-actions' },
        h(
          'button',
          {
            class: 'btn btn-primary btn-sm',
            disabled: busy === 'create',
            onclick: () => {
              const r = hostQuiz(q);
              if (!r.ok) openEditor(q.id, r);
            },
          },
          'Host'
        ),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openEditor(q.id) }, 'Edit'),
        del
          ? h(
              'button',
              {
                class: 'btn btn-danger btn-sm',
                onclick: () => {
                  quizzes = quizzes.filter((x) => x.id !== q.id);
                  confirmDelete.delete(q.id);
                  saveQuizzes();
                  render();
                },
              },
              'Confirm delete'
            )
          : h(
              'button',
              {
                class: 'icon-btn',
                'aria-label': `Delete ${q.title || 'quiz'}`,
                onclick: () => {
                  confirmDelete.add(q.id);
                  render();
                  setTimeout(() => {
                    confirmDelete.delete(q.id);
                    if (view === 'home') render();
                  }, 4000);
                },
              },
              icon('trash', 17)
            )
      )
    );
  }

  /* ================================================================== */
  /* Editor                                                              */
  /* ================================================================== */

  let saveTimer = null;
  let saveLabel = null;

  function openEditor(id, failure) {
    if (id) {
      const found = quizzes.find((q) => q.id === id);
      editing = found || null;
    }
    if (!editing || !id) {
      editing = { id: uid(), title: '', updated: Date.now(), questions: [blankQuestion()] };
      quizzes.unshift(editing);
      saveQuizzes();
    }
    view = 'editor';
    editorMark = failure && !failure.ok ? failure : null;
    render();
    if (editorMark && editorMark.qi != null) {
      const card = document.querySelector(`[data-q="${editorMark.qi}"]`);
      if (card) card.scrollIntoView({ block: 'center' });
    }
  }

  function touch() {
    editing.updated = Date.now();
    if (saveLabel) saveLabel.textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveQuizzes();
      if (saveLabel) saveLabel.textContent = 'All changes saved';
    }, 350);
  }

  function renderEditor() {
    const quiz = editing;
    saveLabel = h('span', { class: 'save-state' }, 'All changes saved');
    const list = h('div', { id: 'qlist' });
    const count = h('span', { class: 'muted small' });

    const titleInput = h('input', {
      class: 'title-input',
      id: 'quiz-title',
      placeholder: 'Untitled quiz',
      maxlength: '80',
      'aria-label': 'Quiz title',
      value: quiz.title,
      oninput: (e) => {
        quiz.title = e.target.value;
        touch();
      },
    });

    function fillList(focusSel) {
      list.replaceChildren(...quiz.questions.map((q, i) => questionCard(q, i, fillList)));
      count.textContent = `${quiz.questions.length} ${quiz.questions.length === 1 ? 'question' : 'questions'}`;
      if (focusSel) {
        const el = list.querySelector(focusSel);
        if (el) {
          el.focus();
          el.scrollIntoView({ block: 'center' });
        }
      }
    }

    const dialog = pasteDialog((parsed) => {
      // Replace the lone empty starter question rather than leaving it behind.
      if (quiz.questions.length === 1 && !quiz.questions[0].text.trim() && quiz.questions[0].options.every((o) => !o.trim())) quiz.questions = [];
      quiz.questions.push(...parsed);
      touch();
      fillList();
      toast(`Added ${parsed.length} ${parsed.length === 1 ? 'question' : 'questions'}`);
    });

    const dock = h(
      'div',
      { class: 'dock' },
      h(
        'div',
        { class: 'dock-in' },
        h(
          'div',
          { class: 'dock-group' },
          h(
            'button',
            {
              class: 'btn btn-secondary',
              onclick: () => {
                quiz.questions.push(blankQuestion());
                touch();
                fillList(`[data-q="${quiz.questions.length - 1}"] textarea`);
              },
            },
            icon('plus', 16),
            'Add question'
          ),
          h('button', { class: 'btn btn-secondary', onclick: () => dialog.open() }, 'Paste questions'),
          h(
            'button',
            {
              class: 'btn btn-ghost',
              onclick: () => {
                const text = quizToText(quiz);
                if (!text.trim()) return toast('Nothing to copy yet.');
                copyText(text, 'Questions copied as text');
              },
            },
            icon('copy', 16),
            'Copy as text'
          )
        ),
        h(
          'button',
          {
            class: 'btn btn-primary',
            disabled: busy === 'create',
            onclick: () => {
              saveQuizzes();
              const r = hostQuiz(quiz);
              if (!r.ok) {
                editorMark = r;
                fillList();
                const card = list.querySelector(`[data-q="${r.qi}"]`);
                if (card) card.scrollIntoView({ block: 'center' });
              }
            },
          },
          busy === 'create' ? 'Starting…' : 'Host live'
        )
      )
    );

    const content = h(
      'div',
      { class: 'editor' },
      h(
        'div',
        { class: 'ed-head' },
        h(
          'button',
          {
            class: 'icon-btn',
            'aria-label': 'Back to quizzes',
            onclick: () => {
              const blank = !quiz.title.trim() && quiz.questions.every((x) => !x.text.trim() && x.options.every((o) => !o.trim()));
              if (blank) quizzes = quizzes.filter((x) => x.id !== quiz.id);
              saveQuizzes();
              leaveToHome();
            },
          },
          icon('back', 20)
        ),
        titleInput,
        saveLabel
      ),
      h('div', { style: { 'margin-bottom': '16px' } }, count),
      list,
      dialog.el,
      dock
    );

    setScreen(shell(topbar({ linked: true, title: 'Editing quiz' }), content, 'has-dock'));
    fillList();
    if (!quiz.title && quiz.questions.length === 1 && !quiz.questions[0].text) titleInput.focus();
  }

  function questionCard(q, i, refill) {
    const quiz = editing;
    const mark = editorMark && editorMark.qi === i ? editorMark.field : null;
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= quiz.questions.length) return;
      [quiz.questions[i], quiz.questions[j]] = [quiz.questions[j], quiz.questions[i]];
      touch();
      refill();
    };

    const optRows = h('div', { class: mark === 'correct' ? 'invalid' : '' });
    function drawOptions() {
      const rows = [
        ...q.options.map((o, j) =>
          h(
            'div',
            { class: 'optrow' },
            h('button', {
              class: 'correct-btn',
              type: 'button',
              role: 'radio',
              'aria-checked': String(q.correct === j),
              'aria-label': `Mark option ${LETTERS[j]} as the correct answer`,
              title: 'Mark as correct',
              onclick: () => {
                q.correct = j;
                optRows.classList.remove('invalid');
                touch();
                drawOptions();
              },
            }, icon('check', 16)),
            h('span', { class: 'letter' }, LETTERS[j]),
            h('input', {
              class: `input${mark === 'options' && !o.trim() ? ' invalid' : ''}`,
              maxlength: '120',
              placeholder: `Option ${LETTERS[j]}`,
              'aria-label': `Option ${LETTERS[j]}`,
              value: o,
              oninput: (e) => {
                q.options[j] = e.target.value;
                e.target.classList.remove('invalid');
                touch();
              },
            }),
            q.options.length > 2
              ? h(
                  'button',
                  {
                    class: 'icon-btn',
                    type: 'button',
                    'aria-label': `Remove option ${LETTERS[j]}`,
                    onclick: () => {
                      q.options.splice(j, 1);
                      if (q.correct === j) q.correct = -1;
                      else if (q.correct > j) q.correct -= 1;
                      touch();
                      drawOptions();
                    },
                  },
                  icon('x', 16)
                )
              : h('span')
          )
        ),
        q.options.length < 4
          ? h(
              'button',
              {
                class: 'btn btn-ghost btn-sm',
                type: 'button',
                style: { 'margin-top': '8px' },
                onclick: () => {
                  q.options.push('');
                  touch();
                  drawOptions();
                },
              },
              icon('plus', 14),
              'Add option'
            )
          : null,
      ];
      optRows.replaceChildren(...rows.filter(Boolean));
    }
    drawOptions();

    const timeSel = h(
      'select',
      {
        class: 'input',
        id: `time-${q.uid}`,
        onchange: (e) => {
          q.time = Number(e.target.value);
          touch();
        },
      },
      TIME_CHOICES.map((t) => h('option', { value: String(t), selected: t === q.time }, `${t} seconds`))
    );

    return h(
      'section',
      { class: 'card qcard', 'data-q': String(i) },
      h(
        'div',
        { class: 'qcard-head' },
        h('span', { class: 'qnum' }, `Question ${i + 1}`),
        h(
          'div',
          { class: 'qtools' },
          h('button', { class: 'icon-btn', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(-1) }, icon('up')),
          h('button', { class: 'icon-btn', 'aria-label': 'Move down', disabled: i === quiz.questions.length - 1, onclick: () => move(1) }, icon('down')),
          h(
            'button',
            {
              class: 'icon-btn',
              'aria-label': 'Duplicate question',
              onclick: () => {
                quiz.questions.splice(i + 1, 0, { ...q, uid: uid(), options: q.options.slice() });
                touch();
                refill();
              },
            },
            icon('copy')
          ),
          h(
            'button',
            {
              class: 'icon-btn',
              'aria-label': 'Delete question',
              onclick: () => {
                quiz.questions.splice(i, 1);
                if (!quiz.questions.length) quiz.questions.push(blankQuestion());
                touch();
                refill();
              },
            },
            icon('trash')
          )
        )
      ),
      h(
        'div',
        { class: 'qcard-body' },
        h(
          'div',
          { class: 'field' },
          h('label', { for: `text-${q.uid}` }, 'Question'),
          h('textarea', {
            class: `input${mark === 'text' ? ' invalid' : ''}`,
            id: `text-${q.uid}`,
            maxlength: '300',
            rows: '2',
            placeholder: 'Type your question',
            value: q.text,
            oninput: (e) => {
              q.text = e.target.value;
              e.target.classList.remove('invalid');
              touch();
            },
          })
        ),
        h(
          'div',
          null,
          h('div', { class: 'label' }, 'Answers'),
          h('div', { class: 'hint' }, 'Select the circle beside the correct answer. Leave unused options empty.'),
          optRows
        ),
        h(
          'div',
          { class: 'qcard-foot' },
          h('label', { class: 'inline small muted', for: `time-${q.uid}` }, 'Time limit', timeSel),
          h(
            'button',
            {
              class: 'btn btn-ghost btn-sm',
              type: 'button',
              onclick: () => {
                q.options = ['True', 'False'];
                q.correct = -1;
                touch();
                drawOptions();
              },
            },
            'Use True / False'
          )
        )
      )
    );
  }

  function pasteDialog(onAdd) {
    const area = h('textarea', {
      class: 'input mono-area',
      id: 'bulk-text',
      spellcheck: 'false',
      placeholder: 'What is the capital of France?\nA) Berlin\nB) Paris *\nC) Madrid\nD) Rome\n\nWhich planet is closest to the Sun?\nA) Mercury\nB) Venus\nAnswer: A',
    });
    const status = h('p', { class: 'small muted', role: 'status' }, 'Paste questions to see how many were found.');
    let parsed = { questions: [] };
    const addBtn = h(
      'button',
      {
        class: 'btn btn-primary',
        disabled: true,
        onclick: () => {
          onAdd(parsed.questions);
          area.value = '';
          area.dispatchEvent(new Event('input'));
          dlg.close();
        },
      },
      'Add questions'
    );

    area.addEventListener('input', () => {
      parsed = parseBulk(area.value);
      const n = parsed.questions.length;
      const bits = [`${n} ${n === 1 ? 'question' : 'questions'} found`];
      if (parsed.unmarked) bits.push(`${parsed.unmarked} without a marked answer`);
      if (parsed.skipped) bits.push(`${parsed.skipped} skipped (need a question and two or more options)`);
      status.textContent = area.value.trim() ? bits.join(' · ') : 'Paste questions to see how many were found.';
      addBtn.disabled = n === 0;
    });

    const dlg = h(
      'dialog',
      { 'aria-labelledby': 'bulk-title' },
      h(
        'div',
        { class: 'dialog-body' },
        h('h2', { class: 'card-title', id: 'bulk-title' }, 'Paste questions'),
        h('p', { class: 'small muted' }, 'One question per block, separated by a blank line. Options start with A), B), C), D). Mark the correct option with * at the end, or add a line like “Answer: B”.'),
        area,
        status
      ),
      h('div', { class: 'dialog-foot' }, h('button', { class: 'btn btn-secondary', onclick: () => dlg.close() }, 'Cancel'), addBtn)
    );

    return {
      el: dlg,
      open() {
        dlg.showModal();
        area.focus();
      },
    };
  }

  /* ================================================================== */
  /* Game rendering                                                      */
  /* ================================================================== */

  function renderGame() {
    if (!game) {
      setScreen(
        shell(
          topbar({ linked: false }),
          h('div', { class: 'spinner-screen' }, h('p', null, 'Connecting to your quiz…'))
        )
      );
      return;
    }
    if (game.role === 'host') renderHost();
    else renderPlayer();
    ensureTicker();
  }

  /* ---------- timer ---------- */

  let tickRaf = null;

  function ensureTicker() {
    if (tickRaf || !game || game.phase !== 'question') return;
    const step = () => {
      tickRaf = null;
      if (!game || game.phase !== 'question') return;
      const total = game.question.time;
      const left = Math.max(0, (game.endsAt - (Date.now() + offset)) / 1000);
      const secs = Math.ceil(left);
      const low = left <= 5;
      const fill = document.querySelector('[data-timer]');
      const num = document.querySelector('[data-clock]');
      if (fill) {
        fill.style.setProperty('--t', String(Math.min(1, left / total)));
        fill.classList.toggle('low', low);
      }
      if (num) {
        if (num.textContent !== String(secs)) num.textContent = String(secs);
        num.classList.toggle('low', low);
      }
      tickRaf = requestAnimationFrame(step);
    };
    tickRaf = requestAnimationFrame(step);
  }

  function timerBlock(label, extra) {
    return [
      h('div', { class: 'stage-head' }, h('span', { class: 'progress-label' }, label), h('div', { class: 'inline' }, extra, h('span', { class: 'clock', 'data-clock': '', 'aria-label': 'Seconds left' }, ''))),
      h('div', { class: 'timer', 'data-timer': '' }, h('i')),
    ];
  }

  /* ---------- shared pieces ---------- */

  function optionNode(i, text, { tag = 'div', cls = '', count = null, pct = null, onclick = null, disabled = false } = {}) {
    return h(
      tag,
      Object.assign({ class: `opt ${cls}`.trim() }, tag === 'button' ? { type: 'button', onclick, disabled } : {}),
      pct != null ? h('span', { class: 'fill', style: { '--pct': String(pct) } }) : null,
      h('span', { class: 'badge' }, LETTERS[i]),
      h('span', null, text),
      count != null ? h('span', { class: 'count' }, String(count)) : h('span')
    );
  }

  function boardList(rows, meId) {
    return h(
      'ol',
      { class: 'board' },
      rows.map((p) =>
        h(
          'li',
          { class: `${p.rank === 1 ? 'first' : ''} ${p.id === meId ? 'me' : ''} ${p.connected === false ? 'off' : ''}`.trim() },
          h('span', { class: 'rk' }, String(p.rank)),
          h('span', { class: 'nm' }, p.id === meId ? `${p.name} (you)` : p.name),
          h('span', { class: 'sc' }, fmt(p.score))
        )
      )
    );
  }

  /* ================================================================== */
  /* Host screens                                                        */
  /* ================================================================== */

  function hostBar(g) {
    return topbar({
      linked: false,
      title: g.title,
      right: [
        h('span', { class: 'room-chip', title: 'Room code' }, spaced(g.code)),
        hostEndButton(),
      ],
    });
  }

  let confirmEnd = false;
  function hostEndButton() {
    if (confirmEnd) {
      return h('button', { class: 'btn btn-danger btn-sm', onclick: () => { confirmEnd = false; endAsHost(); } }, 'Confirm end');
    }
    return h(
      'button',
      {
        class: 'btn btn-secondary btn-sm',
        onclick: () => {
          confirmEnd = true;
          render();
          setTimeout(() => {
            if (confirmEnd) {
              confirmEnd = false;
              if (view === 'host') render();
            }
          }, 4000);
        },
      },
      'End room'
    );
  }

  function renderHost() {
    const g = game;
    if (g.phase === 'lobby') return renderHostLobby(g);
    if (g.phase === 'question') return renderHostQuestion(g);
    if (g.phase === 'reveal') return renderHostReveal(g);
    return renderHostFinal(g);
  }

  function renderHostLobby(g) {
    const link = `${location.origin}/?room=${g.code}`;
    const joinCard = h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-body join-info' },
        h('div', null, h('div', { class: 'label' }, 'Go to'), h('div', { class: 'join-url' }, location.host)),
        h('div', null, h('div', { class: 'label' }, 'Enter room code'), h('div', { class: 'room-code' }, spaced(g.code))),
        h('button', { class: 'btn btn-secondary', onclick: () => copyText(link, 'Invite link copied') }, icon('link', 16), 'Copy invite link')
      )
    );

    const n = g.players.length;
    const playersCard = h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Players'), h('span', { class: 'mono muted' }, String(n))),
      h(
        'div',
        { class: 'card-body' },
        n
          ? h(
              'div',
              { class: 'chips' },
              g.players.map((p) =>
                h(
                  'span',
                  { class: `chip${p.connected ? '' : ' off'}` },
                  h('span', null, p.name),
                  h('button', { class: 'icon-btn', 'aria-label': `Remove ${p.name}`, onclick: () => sendMsg({ type: 'host:kick', id: p.id }) }, icon('x', 14))
                )
              )
            )
          : h('p', { class: 'muted' }, 'Waiting for players. Share the room code or invite link and their names will appear here.')
      )
    );

    const total = g.total;
    const content = [
      h(
        'div',
        { class: 'page-head' },
        h('div', null, h('p', { class: 'progress-label' }, 'Lobby'), h('h1', { class: 'page-title' }, g.title), h('p', { class: 'muted small' }, `${total} ${total === 1 ? 'question' : 'questions'}`)),
        h(
          'button',
          { class: 'btn btn-primary btn-lg', disabled: n === 0, onclick: () => sendMsg({ type: 'host:start' }) },
          n === 0 ? 'Start quiz' : `Start quiz with ${n} ${n === 1 ? 'player' : 'players'}`
        )
      ),
      h('div', { class: 'lobby-grid' }, joinCard, playersCard),
    ];
    setScreen(shell(hostBar(g), content));
  }

  function renderHostQuestion(g) {
    const q = g.question;
    const online = Math.max(g.connectedCount, g.answered);
    const pct = online ? Math.round((g.answered / online) * 100) : 0;
    const content = [
      ...timerBlock(`Question ${g.qIndex + 1} of ${g.total}`),
      h('h1', { class: 'q-text' }, q.text),
      h('div', { class: `opts${q.options.length > 2 ? ' two' : ''}` }, q.options.map((o, i) => optionNode(i, o, { cls: 'big' }))),
      h(
        'div',
        { class: 'stage-foot' },
        h('div', { class: 'meter' }, h('span', { class: 'mono small' }, `${g.answered} of ${online} answered`), h('div', { class: 'meter-bar' }, h('i', { style: { '--pct': String(pct) } }))),
        h('button', { class: 'btn btn-secondary', onclick: () => sendMsg({ type: 'host:skip' }) }, 'Show results now')
      ),
    ];
    setScreen(shell(hostBar(g), content));
  }

  function renderHostReveal(g) {
    const q = g.question;
    const totalPlayers = g.players.length;
    const right = g.counts[q.correct];
    const pct = totalPlayers ? Math.round((right / totalPlayers) * 100) : 0;
    const maxCount = Math.max(1, ...g.counts);
    const last = g.qIndex + 1 >= g.total;

    const left = h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-body' },
        h('p', { class: 'progress-label', style: { 'margin-bottom': '12px' } }, `Question ${g.qIndex + 1} of ${g.total} · Results`),
        h('h1', { class: 'reveal-q' }, q.text),
        h('p', { class: 'stat-line' }, h('b', null, `${pct}%`), ` answered correctly (${right} of ${totalPlayers})`),
        h(
          'div',
          { class: 'opts' },
          q.options.map((o, i) =>
            optionNode(i, o, {
              cls: i === q.correct ? 'ok' : 'dim',
              count: g.counts[i],
              pct: Math.round((g.counts[i] / maxCount) * 100),
            })
          )
        )
      )
    );

    const board = h(
      'aside',
      { class: 'card' },
      h('div', { class: 'board-head' }, 'Leaderboard'),
      g.top.length ? boardList(g.top) : h('p', { class: 'muted', style: { padding: '16px' } }, 'No players.')
    );

    const content = [
      h('div', { class: 'reveal-grid' }, left, board),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn btn-primary btn-lg', onclick: () => sendMsg({ type: 'host:next' }) }, last ? 'Show final results' : 'Next question')
      ),
    ];
    setScreen(shell(hostBar(g), content));
  }

  function csvCell(v) {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formulas in player names
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function downloadResults(g) {
    const rows = [['Rank', 'Name', 'Score', 'Correct answers', 'Questions', 'Accuracy']];
    for (const p of g.players) rows.push([p.rank, p.name, p.score, p.correct, g.total, g.total ? `${Math.round((p.correct / g.total) * 100)}%` : '0%']);
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: `${(g.title || 'quiz').replace(/[^\w-]+/g, '-').toLowerCase()}-results.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function renderHostFinal(g) {
    const top = g.players.slice(0, 3);
    const slot = (idx, cls) => {
      const p = top[idx];
      if (!p) return h('div', { class: `pod ${cls} empty` }, h('div', { class: 'pod-block' }));
      return h('div', { class: `pod ${cls}` }, h('div', { class: 'pod-name' }, p.name), h('div', { class: 'pod-score' }, `${fmt(p.score)} pts`), h('div', { class: 'pod-block' }, String(p.rank)));
    };

    const standings = h(
      'section',
      { class: 'card table-wrap' },
      g.players.length
        ? h(
            'table',
            { class: 'data' },
            h('thead', null, h('tr', null, h('th', null, 'Rank'), h('th', null, 'Player'), h('th', { class: 'num' }, 'Score'), h('th', { class: 'num' }, 'Correct'), h('th', { class: 'num' }, 'Accuracy'))),
            h(
              'tbody',
              null,
              g.players.map((p) =>
                h(
                  'tr',
                  null,
                  h('td', { class: 'mono' }, String(p.rank)),
                  h('td', null, p.name),
                  h('td', { class: 'num' }, fmt(p.score)),
                  h('td', { class: 'num' }, `${p.correct} / ${g.total}`),
                  h('td', { class: 'num' }, `${g.total ? Math.round((p.correct / g.total) * 100) : 0}%`)
                )
              )
            )
          )
        : h('p', { class: 'muted', style: { padding: '16px' } }, 'No players took part.')
    );

    const breakdown = (g.breakdown || []).filter(Boolean);
    const bd = breakdown.length
      ? h(
          'section',
          { class: 'section' },
          h('h2', null, 'Question breakdown'),
          h(
            'div',
            { class: 'card' },
            breakdown.map((b, i) => {
              const p = b.total ? Math.round((b.correct / b.total) * 100) : 0;
              return h(
                'div',
                { class: 'bd-row' },
                h('span', { class: 'mono muted' }, `Q${i + 1}`),
                h('span', { class: 'q', title: b.text }, b.text),
                h('div', { class: 'bd-bar' }, h('i', { style: { '--pct': String(p) } })),
                h('span', { class: 'mono', style: { 'text-align': 'right' } }, `${p}%`)
              );
            })
          )
        )
      : null;

    const content = [
      h('div', { class: 'page-head' }, h('div', null, h('p', { class: 'progress-label' }, 'Final results'), h('h1', { class: 'page-title' }, g.title))),
      h('div', { class: 'podium' }, slot(1, 'p2'), slot(0, 'p1'), slot(2, 'p3')),
      h('section', null, h('h2', { class: 'card-title', style: { 'margin-bottom': '12px' } }, 'Standings'), standings),
      bd,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn btn-primary', onclick: () => downloadResults(g) }, icon('download', 16), 'Download results (CSV)'),
        h('button', { class: 'btn btn-secondary', onclick: () => sendMsg({ type: 'host:restart' }) }, 'Play again with the same players'),
        h('button', { class: 'btn btn-ghost btn-danger', onclick: endAsHost }, 'Close room')
      ),
    ];
    setScreen(shell(hostBar(g), content));
  }

  /* ================================================================== */
  /* Player screens                                                      */
  /* ================================================================== */

  function playerBar(g) {
    return topbar({
      linked: false,
      right: [
        h('span', { class: 'room-chip' }, spaced(g.code)),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: leaveAsPlayer }, 'Leave'),
      ],
    });
  }

  function playerHead(g) {
    return h('div', { class: 'pbar' }, h('span', { class: 'pname' }, g.me.name), h('span', { class: 'pscore' }, `${fmt(g.me.score)} pts`));
  }

  function renderPlayer() {
    const g = game;
    let body;
    if (g.phase === 'lobby') body = playerLobby(g);
    else if (g.phase === 'question') body = playerQuestion(g);
    else if (g.phase === 'reveal') body = playerReveal(g);
    else body = playerFinal(g);
    setScreen(shell(playerBar(g), h('div', { class: 'player' }, body)));
  }

  function waiting(text) {
    return h('div', { class: 'wait' }, h('p', null, text, h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))));
  }

  function playerLobby(g) {
    return [
      h(
        'section',
        { class: 'card' },
        h(
          'div',
          { class: 'card-body stack' },
          h('p', { class: 'progress-label' }, 'You’re in'),
          h('h1', { class: 'page-title' }, g.me.name),
          h('p', { class: 'muted' }, g.title),
          h('p', { class: 'small muted' }, `${g.playerCount} ${g.playerCount === 1 ? 'player' : 'players'} in the room · ${g.total} ${g.total === 1 ? 'question' : 'questions'}`),
          waiting(g.hostOnline ? 'Waiting for the host to start' : 'Waiting for the host to reconnect')
        )
      ),
    ];
  }

  function answer(i) {
    if (!game || game.phase !== 'question' || game.myChoice != null) return;
    game = { ...game, myChoice: i };
    if (navigator.vibrate) navigator.vibrate(15);
    render();
    sendMsg({ type: 'player:answer', q: game.qIndex, choice: i });
  }

  function playerQuestion(g) {
    const q = g.question;
    const locked = g.myChoice != null;
    return [
      playerHead(g),
      ...timerBlock(`Question ${g.qIndex + 1} / ${g.total}`),
      h('h1', { class: 'q-text' }, q.text),
      h(
        'div',
        { class: 'opts' },
        q.options.map((o, i) =>
          optionNode(i, o, {
            tag: 'button',
            cls: locked ? (g.myChoice === i ? 'sel' : 'dim') : '',
            disabled: locked,
            onclick: () => answer(i),
          })
        )
      ),
      locked ? waiting('Answer locked in. Waiting for the others') : null,
    ];
  }

  function playerReveal(g) {
    const q = g.question;
    const last = g.last;
    const answered = last.choice != null;
    const cls = last.correct ? 'ok' : 'no';
    const headline = last.correct ? 'Correct' : answered ? 'Not quite' : 'Time’s up';
    const result = h(
      'div',
      { class: `result ${cls}`, role: 'status' },
      h('div', { class: 'big' }, headline),
      last.correct
        ? h('div', { class: 'pts' }, `+${fmt(last.points)} pts`, last.bonus ? h('span', { class: 'small muted', style: { 'margin-left': '8px', 'font-family': 'var(--sans)', 'font-weight': '500' } }, `includes ${last.bonus} streak bonus`) : null)
        : h('div', { class: 'small muted' }, answered ? 'The correct answer is highlighted below.' : 'You did not answer this one.')
    );

    const opts = h(
      'div',
      { class: 'opts' },
      q.options.map((o, i) => {
        let c = 'dim';
        if (i === q.correct) c = 'ok';
        else if (i === last.choice) c = 'no';
        return optionNode(i, o, { cls: c });
      })
    );

    const me = g.me;
    const standing = h(
      'section',
      { class: 'card standing' },
      h('div', { class: 'rank' }, ordinal(me.rank)),
      h('div', { style: { 'font-weight': '600' } }, `${fmt(me.score)} points`),
      h('div', { class: 'small muted' }, me.rank === 1 ? `Leading, out of ${g.playerCount}` : g.behind != null ? `${fmt(g.behind)} behind the next place` : `Out of ${g.playerCount}`),
      me.streak >= 2 ? h('div', { class: 'small muted', style: { 'grid-column': '1 / -1' } }, `${me.streak} correct in a row`) : null
    );

    const board = h('section', { class: 'card' }, h('div', { class: 'board-head' }, 'Top 5'), boardList(g.top, me.id));

    return [playerHead(g), result, opts, standing, board, waiting(g.qIndex + 1 >= g.total ? 'Waiting for the final results' : 'Waiting for the next question')];
  }

  function playerFinal(g) {
    const me = g.me;
    const accuracy = g.total ? Math.round((me.correct / g.total) * 100) : 0;
    return [
      h(
        'section',
        { class: 'final-hero' },
        h('div', { class: 'label' }, 'Final result'),
        h('div', { class: 'rank' }, ordinal(me.rank)),
        h('div', { class: 'of' }, `of ${g.playerCount} ${g.playerCount === 1 ? 'player' : 'players'}`),
        h('dl', null, h('div', null, h('dt', null, 'Score'), h('dd', null, fmt(me.score))), h('div', null, h('dt', null, 'Correct'), h('dd', null, `${me.correct} / ${g.total} (${accuracy}%)`)))
      ),
      h('section', { class: 'card' }, h('div', { class: 'board-head' }, 'Leaderboard'), boardList(g.top, me.id)),
      waiting('The host may start another round'),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-secondary', onclick: leaveAsPlayer }, 'Leave room')),
    ];
  }

  /* ================================================================== */
  /* Router                                                              */
  /* ================================================================== */

  function render() {
    updateConn();
    if (view === 'editor' && editing) return renderEditor();
    if (view === 'host' || view === 'player') return renderGame();
    view = 'home';
    return renderHome();
  }

  if (session) {
    view = session.role;
    render();
    connect();
  } else {
    render();
  }

  window.addEventListener('online', () => {
    if (session && !net.open) connect();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && session && !net.open) connect();
  });
})();
