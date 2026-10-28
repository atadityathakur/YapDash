'use strict';

/**
 * Quorum — live quiz rooms.
 *
 * One Node process serves the static site from ./public and runs every quiz
 * room in memory over a single WebSocket endpoint (/ws). The server owns the
 * clock and the scoring; browsers only send intents (create, join, answer).
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const LIMITS = {
  maxRooms: 500,
  maxPlayers: 400,
  maxQuestions: 100,
  maxQuestionChars: 300,
  maxOptionChars: 120,
  maxTitleChars: 80,
  nameChars: 20,
  roomIdleMs: 3 * 60 * 60 * 1000,
  answerGraceMs: 400, // network latency allowance after the timer hits zero
};

/* ------------------------------------------------------------------ */
/* Static files                                                        */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const rooms = new Map();

const newId = () => crypto.randomBytes(6).toString('hex');
const newSecret = () => crypto.randomBytes(16).toString('hex');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function makeCode() {
  for (let i = 0; i < 60; i++) {
    const code = String(crypto.randomInt(100000, 1000000));
    if (!rooms.has(code)) return code;
  }
  return null;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const flat = value
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(flat).slice(0, max).join('');
}

function parseQuiz(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.questions)) return null;
  if (raw.questions.length < 1 || raw.questions.length > LIMITS.maxQuestions) return null;

  const questions = [];
  for (const rq of raw.questions) {
    if (!rq || typeof rq !== 'object' || !Array.isArray(rq.options)) return null;
    const text = cleanText(rq.text, LIMITS.maxQuestionChars);
    const options = rq.options.map((o) => cleanText(o, LIMITS.maxOptionChars));
    const correct = Number(rq.correct);
    if (!text || options.length < 2 || options.length > 4 || options.some((o) => !o)) return null;
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) return null;
    let time = Number(rq.time);
    if (!Number.isFinite(time)) time = 20;
    time = Math.min(120, Math.max(5, Math.round(time)));
    questions.push({ text, options, correct, time });
  }
  return { title: cleanText(raw.title, LIMITS.maxTitleChars) || 'Untitled quiz', questions };
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function sendError(ws, code, message) {
  send(ws, { type: 'error', code, message });
}

/* ------------------------------------------------------------------ */
/* Room model                                                          */
/* ------------------------------------------------------------------ */

function createRoom(quiz) {
  const code = makeCode();
  if (!code) return null;
  const room = {
    code,
    hostKey: newSecret(),
    quiz,
    phase: 'lobby', // lobby | question | reveal | final
    players: new Map(),
    hosts: new Set(),
    qIndex: -1,
    qStart: 0,
    qEnd: 0,
    answers: new Map(),
    counts: null,
    qStats: [],
    timer: null,
    earlyTimer: null,
    hostTimer: null,
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function clearTimers(room) {
  clearTimeout(room.timer);
  clearTimeout(room.earlyTimer);
  room.timer = null;
  room.earlyTimer = null;
}

function standings(room) {
  const list = [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    correct: p.correct,
  }));
  list.sort((a, b) => b.score - a.score || b.correct - a.correct || a.name.localeCompare(b.name));
  let rank = 0;
  let prevScore = null;
  let prevCorrect = null;
  list.forEach((p, i) => {
    if (p.score !== prevScore || p.correct !== prevCorrect) {
      rank = i + 1;
      prevScore = p.score;
      prevCorrect = p.correct;
    }
    p.rank = rank;
  });
  return list;
}

function publicQuestion(room, withAnswer) {
  const q = room.quiz.questions[room.qIndex];
  if (!q) return null;
  const out = { text: q.text, options: q.options, time: q.time };
  if (withAnswer) out.correct = q.correct;
  return out;
}

function baseState(room, role) {
  return {
    type: 'state',
    role,
    code: room.code,
    phase: room.phase,
    title: room.quiz.title,
    total: room.quiz.questions.length,
    qIndex: room.qIndex,
    serverNow: Date.now(),
    endsAt: room.phase === 'question' ? room.qEnd : 0,
  };
}

function hostState(room, st) {
  const s = baseState(room, 'host');
  const connectedCount = [...room.players.values()].filter((p) => p.connected).length;

  if (room.phase === 'lobby') {
    s.players = [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
    }));
  } else {
    s.players = st.map((p) => {
      const pl = room.players.get(p.id);
      return {
        id: p.id,
        name: p.name,
        score: p.score,
        rank: p.rank,
        correct: p.correct,
        connected: pl.connected,
        answered: room.phase === 'question' && room.answers.has(p.id),
      };
    });
  }
  s.connectedCount = connectedCount;

  if (room.phase === 'question') {
    s.question = publicQuestion(room, false);
    s.answered = room.answers.size;
  } else if (room.phase === 'reveal') {
    s.question = publicQuestion(room, true);
    s.counts = room.counts;
    s.top = s.players.slice(0, 5);
  } else if (room.phase === 'final') {
    s.breakdown = room.qStats;
  }
  return s;
}

function pointsBehind(st, idx) {
  const me = st[idx];
  if (!me || me.rank === 1) return null;
  const firstOfRank = st.findIndex((x) => x.rank === me.rank);
  return firstOfRank > 0 ? st[firstOfRank - 1].score - me.score : null;
}

function playerState(room, p, st) {
  const idx = st.findIndex((x) => x.id === p.id);
  const me = st[idx];
  const s = baseState(room, 'player');
  s.hostOnline = room.hosts.size > 0;
  s.playerCount = room.players.size;
  s.me = { id: p.id, name: p.name, score: p.score, rank: me ? me.rank : 0, correct: p.correct, streak: p.streak };

  const pub = (x) => ({ id: x.id, name: x.name, score: x.score, rank: x.rank });

  if (room.phase === 'question') {
    s.question = publicQuestion(room, false);
    const a = room.answers.get(p.id);
    s.myChoice = a ? a.choice : null;
  } else if (room.phase === 'reveal') {
    s.question = publicQuestion(room, true);
    s.counts = room.counts;
    s.last =
      p.last && p.last.q === room.qIndex
        ? p.last
        : { q: room.qIndex, choice: null, correct: false, points: 0, bonus: 0 };
    s.top = st.slice(0, 5).map(pub);
    s.behind = pointsBehind(st, idx);
  } else if (room.phase === 'final') {
    s.top = st.slice(0, 10).map(pub);
    s.behind = pointsBehind(st, idx);
  }
  return s;
}

function broadcast(room) {
  room.lastActivity = Date.now();
  clearTimeout(room.hostTimer);
  room.hostTimer = null;
  const st = standings(room);
  const hs = hostState(room, st);
  for (const ws of room.hosts) send(ws, hs);
  for (const p of room.players.values()) {
    if (p.ws) send(p.ws, playerState(room, p, st));
  }
}

// Host-only refresh, coalesced so a burst of joins or answers is one message.
function scheduleHostUpdate(room) {
  room.lastActivity = Date.now();
  if (room.hostTimer) return;
  room.hostTimer = setTimeout(() => {
    room.hostTimer = null;
    if (room.hosts.size === 0) return;
    const hs = hostState(room, standings(room));
    for (const ws of room.hosts) send(ws, hs);
  }, 150);
}

/* ------------------------------------------------------------------ */
/* Game flow                                                           */
/* ------------------------------------------------------------------ */

function startQuestion(room, index) {
  clearTimers(room);
  const q = room.quiz.questions[index];
  room.phase = 'question';
  room.qIndex = index;
  room.answers = new Map();
  room.counts = null;
  room.qStart = Date.now();
  room.qEnd = room.qStart + q.time * 1000;
  room.timer = setTimeout(() => reveal(room), q.time * 1000 + LIMITS.answerGraceMs + 100);
  broadcast(room);
}

function reveal(room) {
  if (room.phase !== 'question') return;
  clearTimers(room);

  const q = room.quiz.questions[room.qIndex];
  const counts = q.options.map(() => 0);
  let correctCount = 0;

  for (const p of room.players.values()) {
    const a = room.answers.get(p.id);
    let result = { q: room.qIndex, choice: null, correct: false, points: 0, bonus: 0 };
    if (a) {
      counts[a.choice] += 1;
      result.choice = a.choice;
      if (a.choice === q.correct) {
        const remaining = 1 - (a.at - room.qStart) / (q.time * 1000);
        const base = Math.round(500 + 500 * Math.max(0, Math.min(1, remaining)));
        p.streak += 1;
        const bonus = Math.min((p.streak - 1) * 50, 250);
        result = { ...result, correct: true, points: base + bonus, bonus };
        p.score += base + bonus;
        p.correct += 1;
        correctCount += 1;
      } else {
        p.streak = 0;
      }
    } else {
      p.streak = 0;
    }
    p.last = result;
  }

  room.counts = counts;
  room.qStats[room.qIndex] = {
    text: q.text,
    correct: correctCount,
    answered: room.answers.size,
    total: room.players.size,
  };
  room.phase = 'reveal';
  broadcast(room);
}

function checkAllAnswered(room) {
  if (room.phase !== 'question' || room.earlyTimer) return;
  const online = [...room.players.values()].filter((p) => p.connected);
  if (online.length > 0 && online.every((p) => room.answers.has(p.id))) {
    room.earlyTimer = setTimeout(() => reveal(room), 700);
  }
}

function restart(room) {
  clearTimers(room);
  room.phase = 'lobby';
  room.qIndex = -1;
  room.answers = new Map();
  room.counts = null;
  room.qStats = [];
  for (const p of room.players.values()) {
    p.score = 0;
    p.streak = 0;
    p.correct = 0;
    p.last = null;
  }
  broadcast(room);
}

function endRoom(room) {
  clearTimers(room);
  clearTimeout(room.hostTimer);
  for (const p of room.players.values()) {
    if (p.ws) {
      send(p.ws, { type: 'ended' });
      p.ws.ctx = null;
    }
  }
  for (const ws of room.hosts) {
    send(ws, { type: 'ended' });
    ws.ctx = null;
  }
  rooms.delete(room.code);
}

/* ------------------------------------------------------------------ */
/* Message handling                                                    */
/* ------------------------------------------------------------------ */

function detach(ws) {
  const ctx = ws.ctx;
  if (!ctx) return;
  ws.ctx = null;
  const room = ctx.room;
  if (ctx.role === 'host') {
    room.hosts.delete(ws);
    if (rooms.has(room.code)) broadcast(room);
  } else {
    const p = room.players.get(ctx.playerId);
    if (p && p.ws === ws) {
      p.ws = null;
      p.connected = false;
      scheduleHostUpdate(room);
      checkAllAnswered(room);
    }
  }
}

function handleHostCreate(ws, msg) {
  detach(ws);
  const quiz = parseQuiz(msg.quiz);
  if (!quiz) return sendError(ws, 'invalid_quiz', 'That quiz could not be read. Check every question has text, two or more options and a correct answer.');
  if (rooms.size >= LIMITS.maxRooms) return sendError(ws, 'server_busy', 'The server is at capacity. Try again in a few minutes.');
  const room = createRoom(quiz);
  if (!room) return sendError(ws, 'server_busy', 'Could not allocate a room code. Try again.');
  room.hosts.add(ws);
  ws.ctx = { role: 'host', room };
  send(ws, { type: 'hello', role: 'host', code: room.code, hostKey: room.hostKey });
  broadcast(room);
}

function handleHostResume(ws, msg) {
  detach(ws);
  const room = rooms.get(String(msg.code || ''));
  if (!room || !safeEqual(msg.hostKey, room.hostKey)) {
    return sendError(ws, 'room_not_found', 'That room has ended.');
  }
  room.hosts.add(ws);
  ws.ctx = { role: 'host', room };
  send(ws, { type: 'hello', role: 'host', code: room.code, hostKey: room.hostKey });
  broadcast(room);
}

function handlePlayerJoin(ws, msg) {
  detach(ws);
  const room = rooms.get(String(msg.code || '').replace(/\D/g, ''));
  if (!room) return sendError(ws, 'room_not_found', 'No quiz found with that room code.');

  let player = null;
  if (typeof msg.token === 'string' && msg.token) {
    for (const p of room.players.values()) {
      if (safeEqual(p.token, msg.token)) {
        player = p;
        break;
      }
    }
  }

  if (!player) {
    const name = cleanText(msg.name, LIMITS.nameChars);
    if (!name) return sendError(ws, 'name_required', 'Enter a name to join.');
    const lower = name.toLowerCase();
    const same = [...room.players.values()].find((p) => p.name.toLowerCase() === lower);
    if (same) {
      if (same.connected) return sendError(ws, 'name_taken', 'Someone in this room already has that name. Try another.');
      player = same; // a dropped player coming back without their saved token
    } else {
      if (room.players.size >= LIMITS.maxPlayers) return sendError(ws, 'room_full', 'This room is full.');
      player = {
        id: newId(),
        token: newSecret(),
        name,
        ws: null,
        connected: false,
        score: 0,
        streak: 0,
        correct: 0,
        last: null,
      };
      room.players.set(player.id, player);
    }
  }

  if (player.ws && player.ws !== ws) {
    player.ws.ctx = null;
    try {
      player.ws.close();
    } catch {
      /* already closed */
    }
  }
  player.ws = ws;
  player.connected = true;
  ws.ctx = { role: 'player', room, playerId: player.id };

  send(ws, { type: 'hello', role: 'player', code: room.code, id: player.id, token: player.token, name: player.name });
  send(ws, playerState(room, player, standings(room)));
  scheduleHostUpdate(room);
}

function handleHostAction(ws, room, msg) {
  switch (msg.type) {
    case 'host:start':
      if (room.phase !== 'lobby') return;
      if (room.players.size === 0) return sendError(ws, 'no_players', 'Wait for at least one player to join.');
      startQuestion(room, 0);
      break;
    case 'host:skip':
      reveal(room);
      break;
    case 'host:next':
      if (room.phase !== 'reveal') return;
      if (room.qIndex + 1 < room.quiz.questions.length) {
        startQuestion(room, room.qIndex + 1);
      } else {
        room.phase = 'final';
        broadcast(room);
      }
      break;
    case 'host:kick': {
      const p = room.players.get(String(msg.id || ''));
      if (!p) return;
      if (p.ws) {
        send(p.ws, { type: 'kicked' });
        p.ws.ctx = null;
      }
      room.players.delete(p.id);
      room.answers.delete(p.id);
      broadcast(room);
      checkAllAnswered(room);
      break;
    }
    case 'host:restart':
      restart(room);
      break;
    case 'host:end':
      endRoom(room);
      break;
    default:
  }
}

function handlePlayerAction(ws, room, playerId, msg) {
  const p = room.players.get(playerId);
  if (!p) return;

  if (msg.type === 'player:answer') {
    if (room.phase !== 'question' || msg.q !== room.qIndex || room.answers.has(p.id)) return;
    const now = Date.now();
    if (now > room.qEnd + LIMITS.answerGraceMs) return;
    const q = room.quiz.questions[room.qIndex];
    const choice = msg.choice;
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return;
    room.answers.set(p.id, { choice, at: now });
    send(ws, playerState(room, p, standings(room)));
    scheduleHostUpdate(room);
    checkAllAnswered(room);
  } else if (msg.type === 'player:leave') {
    ws.ctx = null;
    p.ws = null;
    p.connected = false;
    if (room.phase === 'lobby') room.players.delete(p.id);
    scheduleHostUpdate(room);
    checkAllAnswered(room);
  }
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'host:create':
      return handleHostCreate(ws, msg);
    case 'host:resume':
      return handleHostResume(ws, msg);
    case 'player:join':
      return handlePlayerJoin(ws, msg);
    default: {
      const ctx = ws.ctx;
      if (!ctx || !rooms.has(ctx.room.code)) return;
      if (ctx.role === 'host' && msg.type.startsWith('host:')) return handleHostAction(ws, ctx.room, msg);
      if (ctx.role === 'player' && msg.type.startsWith('player:')) return handlePlayerAction(ws, ctx.room, ctx.playerId, msg);
    }
  }
}

/* ------------------------------------------------------------------ */
/* WebSocket server                                                    */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.ctx = null;
  ws.bucket = { tokens: 40, last: Date.now() };

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    // Token bucket: 40 burst, 20 messages per second sustained.
    const now = Date.now();
    ws.bucket.tokens = Math.min(40, ws.bucket.tokens + ((now - ws.bucket.last) / 1000) * 20);
    ws.bucket.last = now;
    if (ws.bucket.tokens < 1) return;
    ws.bucket.tokens -= 1;

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error('message error:', err);
    }
  });

  ws.on('close', () => detach(ws));
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

setInterval(() => {
  const cutoff = Date.now() - LIMITS.roomIdleMs;
  for (const room of rooms.values()) {
    if (room.lastActivity < cutoff) endRoom(room);
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Quorum is running on http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`  On your network: http://${a.address}:${PORT}`);
      }
    }
  }
});
