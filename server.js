const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const compression = require('compression');
const { Server } = require('socket.io');
const WORDS = require('./words');
const { COLORS, rand, shuffle, makeCode, cleanName, validPid, isClose } = require('./lib/common');
const setupTraitre = require('./traitre');
const WORD_COUNTS = Object.fromEntries(Object.entries(WORDS).map(([c, l]) => [c, l.length]));

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 3;
// Coordonnées entières sur une grille 0..GRID (plus compact qu'un flottant en JSON).
const GRID = 1000;
const MAX_COORDS = 4000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  // Seuls les gros messages (resynchronisation des traits) sont compressés.
  perMessageDeflate: { threshold: 1024 },
  httpCompression: { threshold: 1024 }
});
app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function cleanCoords(arr, from) {
  const n = arr.length - from;
  if (n < 0 || n % 2) return null;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = arr[from + i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[i] = Math.min(GRID, Math.max(0, Math.round(v)));
  }
  return out;
}

/* ---------- rôles ---------- */
// Nombre minimum de joueurs connectés pour que l'option s'applique.
const ROLE_MIN = {
  detective: 4, aveugle: 4, complice: 5, bouffon: 5, gardien: 5, saboteur: 6, duo: 7, voisin: 3
};
const EXTRA_ROLES = ['complice', 'saboteur', 'detective', 'aveugle', 'bouffon', 'gardien'];
const IMP_TEAM = ['imposter', 'complice', 'saboteur'];

/* ---------- room helpers ---------- */
function createRoom() {
  const room = {
    code: makeCode(rooms), hostId: null, players: [], phase: 'lobby', game: 0,
    settings: { rounds: 2, category: 'mix', roles: Object.fromEntries(Object.keys(ROLE_MIN).map((k) => [k, false])) },
    used: new Set(), word: null, decoy: null, category: null, roles: {}, imposterIds: [], order: [], turnIndex: 0,
    strokes: [], live: null, votes: {}, accusedId: null, excluded: [], gardienId: null, inspect: null,
    pending: null, result: null, cleanup: null
  };
  rooms.set(room.code, room);
  return room;
}
const getP = (room, id) => room.players.find((p) => p.id === id);
const online = (room) => room.players.filter((p) => p.connected);
const totalTurns = (room) => room.order.length * room.settings.rounds;
const currentPid = (room) => (room.phase === 'drawing' ? room.order[room.turnIndex % room.order.length] : null);
const roleOf = (room, id) => room.roles[id] || 'artist';
// Celui qui valide le mot proposé par l'imposteur : l'hôte, sauf s'il est dans l'équipe de l'imposteur.
function judgeId(room) {
  const fair = (p) => p && p.connected && !IMP_TEAM.includes(roleOf(room, p.id));
  const host = getP(room, room.hostId);
  if (fair(host)) return host.id;
  const p = room.players.find(fair);
  return p ? p.id : null;
}

function stateFor(room, pid) {
  const s = {
    code: room.code, me: pid, hostId: room.hostId, phase: room.phase, game: room.game,
    settings: room.settings, roleMin: ROLE_MIN,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, connected: p.connected, score: p.score,
      ready: p.ready, voted: room.phase === 'voting' && !!room.votes[p.id]
    })),
    order: room.order, turnIndex: room.turnIndex, totalTurns: totalTurns(room),
    currentPid: currentPid(room), sc: room.strokes.length
  };
  if (room.phase === 'lobby') { s.categories = Object.keys(WORDS); s.wordCounts = WORD_COUNTS; }
  if (room.phase !== 'lobby') {
    const r = roleOf(room, pid);
    const revealed = ['guess', 'validate', 'results'].includes(room.phase);
    // En mode « mot voisin », l'imposteur croit être un artiste jusqu'au dénouement.
    const hidden = r === 'imposter' && room.decoy && !revealed;
    s.role = {
      id: hidden ? 'artist' : r, isImposter: r === 'imposter' && !hidden, category: room.category,
      word: r === 'imposter' ? (hidden ? room.decoy : null) : room.word, neighbor: !!room.decoy
    };
    if (r === 'imposter' && !hidden && room.decoy) s.role.decoy = room.decoy;
    if (r === 'complice') s.role.partners = room.imposterIds;
    if (r === 'detective') s.role.inspect = room.inspect;
    if (room.votes[pid]) s.myVote = room.votes[pid];
    s.excluded = room.excluded;
    s.gardienId = room.gardienId;
  }
  if (room.phase === 'guess' || room.phase === 'validate') s.accusedId = room.accusedId;
  if (room.phase === 'validate') s.pending = { ...room.pending, judgeId: judgeId(room) };
  if (room.phase === 'results') s.result = room.result;
  return s;
}
function broadcast(room) {
  for (const p of room.players) if (p.socketId) io.to(p.socketId).emit('state', stateFor(room, p.id));
}
// Envoi complet des traits : uniquement à l'arrivée d'un joueur ou en cas de désynchronisation.
function sendStrokes(socket, room) {
  const live = room.live && room.live.turn === room.turnIndex ? room.live : null;
  socket.emit('strokes', { game: room.game, list: room.strokes, live });
}

/* ---------- game flow ---------- */
function assignRoles(room) {
  const n = room.players.length;
  const on = (k) => room.settings.roles[k] && n >= ROLE_MIN[k];
  const ids = shuffle(room.players.map((p) => p.id));
  const nImp = on('duo') ? 2 : 1;
  room.roles = {};
  room.imposterIds = ids.slice(0, nImp);
  room.imposterIds.forEach((id) => { room.roles[id] = 'imposter'; });
  let next = nImp;
  let impTeam = nImp;
  for (const r of EXTRA_ROLES.filter(on)) {
    if (next >= n - 1) break; // toujours au moins un artiste ordinaire
    const bad = r === 'complice' || r === 'saboteur';
    if (bad && (impTeam + 1) * 2 >= n) continue; // l'équipe de l'imposteur reste minoritaire
    room.roles[ids[next++]] = r;
    if (bad) impTeam++;
  }
  const others = WORDS[room.category].filter((w) => w !== room.word);
  room.decoy = on('voisin') && others.length ? rand(others) : null;
}

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
  assignRoles(room);
  // L'imposteur ne commence jamais : il doit d'abord voir au moins un trait.
  const order = shuffle(room.players.map((p) => p.id));
  while (room.imposterIds.includes(order[0])) order.push(order.shift());
  room.order = order;
  room.players.forEach((p) => { p.ready = false; });
  room.turnIndex = 0;
  room.strokes = [];
  room.live = null;
  room.votes = {};
  room.accusedId = null;
  room.excluded = [];
  room.gardienId = null;
  room.inspect = null;
  room.pending = null;
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
  const accused = tops.length === 1 ? tops[0] : null;
  // Le Gardien accusé se dévoile : le vote est annulé et on revote sans lui.
  if (accused && roleOf(room, accused) === 'gardien' && !room.gardienId) {
    room.gardienId = accused;
    room.excluded.push(accused);
    room.votes = {};
    return;
  }
  room.accusedId = accused;
  if (accused && room.imposterIds.includes(accused) && getP(room, accused)?.connected) {
    room.phase = 'guess';
  } else {
    finish(room);
  }
}

function finish(room, guess = null, accepted = false, judge = null) {
  const accused = room.accusedId;
  const caught = !!accused && room.imposterIds.includes(accused);
  const guessCorrect = caught && guess != null && !!accepted;
  const winner = accused && roleOf(room, accused) === 'bouffon' ? 'bouffon'
    : !caught || guessCorrect ? 'imposters' : 'artists';
  const deltas = {};
  for (const p of room.players) {
    const r = roleOf(room, p.id);
    let d = 0;
    if (winner === 'bouffon') d = r === 'bouffon' ? 3 : 0;
    else if (winner === 'imposters') d = r === 'imposter' ? 2 : r === 'complice' || r === 'saboteur' ? 1 : 0;
    else d = IMP_TEAM.includes(r) || r === 'bouffon' ? 0 : 1;
    if (d) { p.score += d; deltas[p.id] = d; }
  }
  room.result = {
    imposterIds: room.imposterIds, roles: { ...room.roles }, word: room.word, decoy: room.decoy,
    category: room.category, votes: { ...room.votes }, accusedId: accused, tie: accused === null,
    caught, guess, guessCorrect, winner, deltas, judgeId: judge, gardienId: room.gardienId
  };
  room.pending = null;
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
  if (['reveal', 'drawing', 'voting', 'guess', 'validate'].includes(room.phase) && online(room).length < 2) {
    room.phase = 'lobby';
  } else if (room.phase === 'reveal') checkAllReady(room);
  else if (room.phase === 'drawing' && currentPid(room) === p.id) advance(room);
  else if (room.phase === 'voting') checkVotes(room);
  else if (room.phase === 'guess' && p.id === room.accusedId) finish(room);
  else if (room.phase === 'validate' && !judgeId(room)) finish(room, room.pending.guess, room.pending.auto);
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
    sendStrokes(socket, room);
  });

  socket.on('leave', () => leave(true));
  socket.on('disconnect', () => leave(false));

  socket.on('settings', (s = {}) => {
    const { room, me } = ctx();
    if (!room || !isHost(room, me) || room.phase !== 'lobby') return;
    if ([1, 2, 3, 4].includes(s.rounds)) room.settings.rounds = s.rounds;
    if (s.category === 'mix' || WORDS[s.category]) room.settings.category = s.category;
    if (s.roles && typeof s.roles === 'object') {
      for (const k of Object.keys(ROLE_MIN)) if (typeof s.roles[k] === 'boolean') room.settings.roles[k] = s.roles[k];
    }
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

  socket.on('sync', () => {
    const { room } = ctx();
    if (room) sendStrokes(socket, room);
  });

  // Dessin en direct, envoyé en différentiel : [début, x1, y1, x2, y2, …].
  // Un début à 0 remplace le trait (nouveau trait ou « Recommencer »).
  socket.on('l', (msg) => {
    const { room, me } = ctx();
    if (!room || currentPid(room) !== me.id || !Array.isArray(msg) || msg.length > MAX_COORDS + 1) return;
    const start = msg[0];
    const coords = cleanCoords(msg, 1);
    if (!coords) return;
    const live = room.live && room.live.turn === room.turnIndex ? room.live : null;
    if (start === 0) {
      room.live = { pid: me.id, color: me.color, points: coords, turn: room.turnIndex };
    } else if (live && start === live.points.length && start + coords.length <= MAX_COORDS) {
      for (const c of coords) live.points.push(c);
    } else {
      return socket.emit('lr');
    }
    socket.to(room.code).emit('l', [room.turnIndex, start, ...coords]);
  });

  // Validation : le serveur a déjà tous les points, le client n'envoie que leur nombre.
  socket.on('submit', (n, cb = () => {}) => {
    const { room, me } = ctx();
    if (!room || currentPid(room) !== me.id) return;
    const live = room.live && room.live.turn === room.turnIndex ? room.live : null;
    if (!live || live.points.length !== n || n < 2) return cb({ resync: true });
    room.strokes.push({ pid: me.id, color: me.color, points: live.points });
    io.to(room.code).emit('k', { i: room.strokes.length - 1, turn: room.turnIndex, pid: me.id, color: me.color, n });
    advance(room);
    broadcast(room);
    cb({ ok: true });
  });

  socket.on('vote', (target) => {
    const { room, me } = ctx();
    if (!room || room.phase !== 'voting' || target === me.id || !getP(room, target) || room.excluded.includes(target)) return;
    room.votes[me.id] = target;
    checkVotes(room);
    broadcast(room);
  });

  socket.on('guess', (text) => {
    const { room, me } = ctx();
    if (!room || room.phase !== 'guess' || me.id !== room.accusedId) return;
    const guess = String(text || '').trim().slice(0, 40);
    if (!guess) return;
    room.pending = { guess, auto: isClose(guess, room.word) };
    room.phase = 'validate';
    broadcast(room);
  });

  // Le Détective enquête une seule fois par partie, pendant le dessin ou le vote.
  socket.on('inspect', (target) => {
    const { room, me } = ctx();
    if (!room || !['drawing', 'voting'].includes(room.phase) || roleOf(room, me.id) !== 'detective') return;
    if (room.inspect || target === me.id || !getP(room, target)) return;
    const r = roleOf(room, target);
    room.inspect = { target, suspect: IMP_TEAM.includes(r) || r === 'bouffon' };
    broadcast(room);
  });

  socket.on('judge', (accept) => {
    const { room, me } = ctx();
    if (!room || room.phase !== 'validate' || judgeId(room) !== me.id) return;
    finish(room, room.pending.guess, accept === true, me.id);
    broadcast(room);
  });
});

setupTraitre(io.of('/traitre'));

server.listen(PORT, () => {
  console.log(`\n  🎨 Gribouille est lancé !\n`);
  console.log(`  Sur cet ordinateur : http://localhost:${PORT}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  Sur le même Wi-Fi  : http://${n.address}:${PORT}`);
    }
  }
  console.log('');
});
