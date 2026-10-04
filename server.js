const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');
const WORDS = require('./words');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 3;
const COLORS = [
  '#E8453C', '#2F7DE1', '#F2A12E', '#2FAE66', '#8B5CF6',
  '#EC4899', '#0EA5B7', '#8A5A3B', '#475569', '#F97316'
];

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

/* ---------- utils ---------- */
const rand = (a) => a[Math.floor(Math.random() * a.length)];
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do c = Array.from({ length: 4 }, () => rand(A)).join('');
  while (rooms.has(c));
  return c;
}
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Artiste';
const validPid = (p) => typeof p === 'string' && p.length > 0 && p.length <= 64;

function normalize(s) {
  let t = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/œ/g, 'oe').replace(/[^a-z0-9]+/g, ' ').trim();
  t = t.replace(/^(le|la|les|l|un|une|des|du|de)\s+/, '');
  return t.replace(/\s+/g, '').replace(/s$/, '');
}
function lev(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
function isCorrect(guess, word) {
  const g = normalize(guess), w = normalize(word);
  if (!g) return false;
  return g === w || (w.length >= 5 && lev(g, w) <= 1);
}
function cleanPoints(pts) {
  if (!Array.isArray(pts) || pts.length % 2 || pts.length > 4000) return null;
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const v = Number(pts[i]);
    if (!Number.isFinite(v)) return null;
    out[i] = Math.min(1, Math.max(0, Math.round(v * 10000) / 10000));
  }
  return out;
}

/* ---------- room helpers ---------- */
function createRoom() {
  const room = {
    code: makeCode(), hostId: null, players: [], phase: 'lobby', game: 0,
    settings: { rounds: 2, category: 'mix' }, used: new Set(),
    word: null, category: null, imposterId: null, order: [], turnIndex: 0,
    strokes: [], live: null, votes: {}, accusedId: null, result: null, cleanup: null
  };
  rooms.set(room.code, room);
  return room;
}
const getP = (room, id) => room.players.find((p) => p.id === id);
const online = (room) => room.players.filter((p) => p.connected);
const totalTurns = (room) => room.order.length * room.settings.rounds;
const currentPid = (room) => (room.phase === 'drawing' ? room.order[room.turnIndex % room.order.length] : null);

function stateFor(room, pid) {
  const s = {
    code: room.code, me: pid, hostId: room.hostId, phase: room.phase, game: room.game,
    settings: room.settings, categories: Object.keys(WORDS),
    players: room.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, connected: p.connected, score: p.score,
      ready: p.ready, voted: room.phase === 'voting' && !!room.votes[p.id]
    })),
    order: room.order, turnIndex: room.turnIndex, totalTurns: totalTurns(room),
    currentPid: currentPid(room), strokes: room.strokes
  };
  if (room.phase !== 'lobby') {
    const imp = pid === room.imposterId;
    s.role = { isImposter: imp, category: room.category, word: imp ? null : room.word };
    if (room.votes[pid]) s.myVote = room.votes[pid];
  }
  if (room.phase === 'guess') s.accusedId = room.accusedId;
  if (room.phase === 'results') s.result = room.result;
  return s;
}
function broadcast(room) {
  for (const p of room.players) if (p.socketId) io.to(p.socketId).emit('state', stateFor(room, p.id));
}

/* ---------- game flow ---------- */
function startGame(room) {
  room.players = online(room);
  const cats = room.settings.category === 'mix' ? Object.keys(WORDS) : [room.settings.category];
  room.category = rand(cats);
  let pool = WORDS[room.category].filter((w) => !room.used.has(w));
  if (!pool.length) {
    WORDS[room.category].forEach((w) => room.used.delete(w));
    pool = WORDS[room.category];
  }
  room.word = rand(pool);
  room.used.add(room.word);
  room.imposterId = rand(room.players).id;
  // L'imposteur ne commence jamais : il doit d'abord voir au moins un trait.
  const order = shuffle(room.players.map((p) => p.id));
  if (order[0] === room.imposterId) order.push(order.shift());
  room.order = order;
  room.players.forEach((p) => { p.ready = false; });
  room.turnIndex = 0;
  room.strokes = [];
  room.live = null;
  room.votes = {};
  room.accusedId = null;
  room.result = null;
  room.game++;
  room.phase = 'reveal';
}

function advance(room) {
  room.live = null;
  const total = totalTurns(room);
  room.turnIndex++;
  while (room.turnIndex < total && !getP(room, room.order[room.turnIndex % room.order.length])?.connected) {
    room.turnIndex++;
  }
  if (room.turnIndex >= total) {
    room.phase = 'voting';
    room.votes = {};
  }
}

function checkAllReady(room) {
  if (room.phase !== 'reveal' || !online(room).every((p) => p.ready)) return;
  room.phase = 'drawing';
  room.turnIndex = -1;
  advance(room);
}

function checkVotes(room) {
  if (room.phase !== 'voting') return;
  const voters = online(room);
  if (!voters.every((p) => room.votes[p.id])) return;
  const counts = {};
  Object.values(room.votes).forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
  const max = Math.max(0, ...Object.values(counts));
  const tops = Object.keys(counts).filter((k) => counts[k] === max);
  room.accusedId = tops.length === 1 ? tops[0] : null;
  if (room.accusedId === room.imposterId && getP(room, room.imposterId)?.connected) {
    room.phase = 'guess';
  } else {
    finish(room, null);
  }
}

function finish(room, guess) {
  const caught = room.accusedId === room.imposterId;
  const guessCorrect = guess != null && isCorrect(guess, room.word);
  const imposterWins = !caught || guessCorrect;
  for (const p of room.players) {
    if (p.id === room.imposterId) { if (imposterWins) p.score += 2; }
    else if (!imposterWins) p.score += 1;
  }
  room.result = {
    imposterId: room.imposterId, word: room.word, category: room.category,
    votes: { ...room.votes }, accusedId: room.accusedId, tie: room.accusedId === null,
    caught, guess, guessCorrect, imposterWins
  };
  room.phase = 'results';
}

function onPlayerGone(room, p) {
  if (room.hostId === p.id) {
    const next = online(room)[0];
    if (next) room.hostId = next.id;
  }
  if (!online(room).length) {
    clearTimeout(room.cleanup);
    room.cleanup = setTimeout(() => rooms.delete(room.code), 15 * 60 * 1000);
    return;
  }
  if (['reveal', 'drawing', 'voting', 'guess'].includes(room.phase) && online(room).length < 2) {
    room.phase = 'lobby';
  } else if (room.phase === 'reveal') checkAllReady(room);
  else if (room.phase === 'drawing' && currentPid(room) === p.id) advance(room);
  else if (room.phase === 'voting') checkVotes(room);
  else if (room.phase === 'guess' && p.id === room.imposterId) finish(room, null);
  broadcast(room);
}

/* ---------- sockets ---------- */
io.on('connection', (socket) => {
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    const me = room && getP(room, socket.data.pid);
    return me && me.socketId === socket.id ? { room, me } : {};
  };
  const isHost = (room, me) => room.hostId === me.id;

  function leave(explicit) {
    const { room, me } = ctx();
    if (room) socket.leave(room.code);
    socket.data = {};
    if (!room) return;
    me.connected = false;
    me.socketId = null;
    if (explicit && room.phase === 'lobby') room.players = room.players.filter((p) => p !== me);
    onPlayerGone(room, me);
  }

  function attach(room, pid, name) {
    let p = getP(room, pid);
    if (p) {
      if (p.socketId && p.socketId !== socket.id) io.sockets.sockets.get(p.socketId)?.leave(room.code);
      p.connected = true;
      p.socketId = socket.id;
      if (name) p.name = cleanName(name);
    } else {
      if (room.phase !== 'lobby') return 'La partie a déjà commencé, attends la fin de la manche.';
      if (room.players.length >= MAX_PLAYERS) return 'La partie est complète (10 joueurs max).';
      const used = new Set(room.players.map((x) => x.color));
      p = {
        id: pid, name: cleanName(name), color: COLORS.find((c) => !used.has(c)) || rand(COLORS),
        connected: true, socketId: socket.id, score: 0, ready: false
      };
      room.players.push(p);
    }
    if (!getP(room, room.hostId)?.connected) room.hostId = pid;
    clearTimeout(room.cleanup);
    socket.data = { code: room.code, pid };
    socket.join(room.code);
    return null;
  }

  socket.on('create', ({ name, pid } = {}, cb = () => {}) => {
    if (!validPid(pid)) return cb({ error: 'Identifiant invalide.' });
    leave(true);
    const room = createRoom();
    attach(room, pid, name);
    room.hostId = pid;
    cb({ ok: true, code: room.code });
    broadcast(room);
  });

  socket.on('join', ({ code, name, pid } = {}, cb = () => {}) => {
    if (!validPid(pid)) return cb({ error: 'Identifiant invalide.' });
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb({ error: 'Aucune partie trouvée avec ce code.' });
    if (socket.data.code && socket.data.code !== code) leave(true);
    const err = attach(room, pid, name);
    if (err) return cb({ error: err });
    cb({ ok: true, code });
    // Un joueur qui revient pendant son tour reprend la main.
    if (room.phase === 'reveal') checkAllReady(room);
    broadcast(room);
    if (room.live) socket.emit('live', room.live);
  });

  socket.on('leave', () => leave(true));
  socket.on('disconnect', () => leave(false));

  socket.on('settings', (s = {}) => {
    const { room, me } = ctx();
    if (!room || !isHost(room, me) || room.phase !== 'lobby') return;
    if ([1, 2, 3, 4].includes(s.rounds)) room.settings.rounds = s.rounds;
    if (s.category === 'mix' || WORDS[s.category]) room.settings.category = s.category;
    broadcast(room);
  });

  socket.on('kick', (target) => {
    const { room, me } = ctx();
    if (!room || !isHost(room, me) || room.phase !== 'lobby' || target === me.id) return;
    const p = getP(room, target);
    if (!p) return;
    if (p.socketId) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) { s.leave(room.code); s.data = {}; s.emit('kicked'); }
    }
    room.players = room.players.filter((x) => x !== p);
    broadcast(room);
  });

  socket.on('start', (cb = () => {}) => {
    const { room, me } = ctx();
    if (!room || !isHost(room, me) || !['lobby', 'results'].includes(room.phase)) return;
    if (online(room).length < MIN_PLAYERS) return cb({ error: `Il faut au moins ${MIN_PLAYERS} joueurs.` });
    startGame(room);
    broadcast(room);
  });

  socket.on('toLobby', () => {
    const { room, me } = ctx();
    if (!room || !isHost(room, me) || room.phase !== 'results') return;
    room.phase = 'lobby';
    room.players = room.players.filter((p) => p.connected);
    broadcast(room);
  });

  socket.on('ready', () => {
    const { room, me } = ctx();
    if (!room || room.phase !== 'reveal') return;
    me.ready = true;
    checkAllReady(room);
    broadcast(room);
  });

  socket.on('stroke:live', (pts) => {
    const { room, me } = ctx();
    if (!room || currentPid(room) !== me.id) return;
    const points = cleanPoints(pts);
    if (!points) return;
    room.live = { pid: me.id, color: me.color, points, turn: room.turnIndex };
    socket.to(room.code).emit('live', room.live);
  });

  socket.on('stroke:submit', (pts) => {
    const { room, me } = ctx();
    if (!room || currentPid(room) !== me.id) return;
    const points = cleanPoints(pts);
    if (!points || points.length < 2) return;
    room.strokes.push({ pid: me.id, color: me.color, points });
    advance(room);
    broadcast(room);
  });

  socket.on('vote', (target) => {
    const { room, me } = ctx();
    if (!room || room.phase !== 'voting' || target === me.id || !getP(room, target)) return;
    room.votes[me.id] = target;
    checkVotes(room);
    broadcast(room);
  });

  socket.on('guess', (text) => {
    const { room, me } = ctx();
    if (!room || room.phase !== 'guess' || me.id !== room.imposterId) return;
    finish(room, String(text || '').trim().slice(0, 40));
    broadcast(room);
  });
});

server.listen(PORT, () => {
  console.log(`\n  🎨 Fake Artist est lancé !\n`);
  console.log(`  Sur cet ordinateur : http://localhost:${PORT}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  Sur le même Wi-Fi  : http://${n.address}:${PORT}`);
    }
  }
  console.log('');
});
