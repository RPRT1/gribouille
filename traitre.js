// Traître : un Maître du jeu connaît le mot, les innocents le cherchent par des
// questions fermées, et un Traître qui connaît aussi le mot les aide en secret.
const WORDS = require('./words');
const { COLORS, rand, shuffle, makeCode, cleanName, validPid, normalize } = require('./lib/common');

const MAX_PLAYERS = 10;
const MIN_PLAYERS = 4;
const TIMERS = [3, 5, 8];          // minutes pour trouver le mot
const VOTE_MS = 90 * 1000;         // discussion + vote
const MAX_QUESTIONS = 200;
// Les verbes d'action se devinent mal par oui/non : on les écarte.
const CATS = Object.keys(WORDS).filter((c) => c !== 'Actions');
const WORD_COUNTS = Object.fromEntries(CATS.map((c) => [c, WORDS[c].length]));

module.exports = function setupTraitre(io) {
  const rooms = new Map();

  /* ---------- room helpers ---------- */
  function createRoom() {
    const room = {
      code: makeCode(rooms), hostId: null, players: [], phase: 'lobby', round: 0,
      settings: { timer: 5, category: 'mix' }, used: new Set(),
      word: null, category: null, masterId: null, traitreId: null, masterIdx: -1,
      questions: [], qSeq: 0, finderId: null, votes: {}, deadline: null, timerH: null,
      result: null, cleanup: null
    };
    rooms.set(room.code, room);
    return room;
  }
  const getP = (room, id) => room.players.find((p) => p.id === id);
  const online = (room) => room.players.filter((p) => p.connected);

  function roleOf(room, id) {
    if (id === room.masterId) return 'master';
    if (id === room.traitreId) return 'traitre';
    return 'innocent';
  }

  function stateFor(room, pid) {
    const s = {
      code: room.code, me: pid, hostId: room.hostId, phase: room.phase, round: room.round,
      settings: room.settings, now: Date.now(), deadline: room.deadline,
      players: room.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, connected: p.connected, score: p.score,
        ready: p.ready, voted: room.phase === 'vote' && !!room.votes[p.id]
      })),
      masterId: room.masterId, finderId: room.finderId
    };
    if (room.phase === 'lobby') { s.categories = CATS; s.wordCounts = WORD_COUNTS; }
    else {
      const r = roleOf(room, pid);
      // Une fois le mot trouvé, tout le monde le connaît.
      const known = r !== 'innocent' || ['vote', 'results'].includes(room.phase) && room.finderId;
      s.role = { id: r, category: room.category, word: known ? room.word : null };
      const hint = r === 'master' ? normalize(room.word) : null;
      s.questions = room.questions.map((q) => ({
        ...q, hint: !!hint && q.a === null && normalize(q.text).includes(hint)
      }));
      if (room.votes[pid]) s.myVote = room.votes[pid];
    }
    if (room.phase === 'results') s.result = room.result;
    return s;
  }
  function broadcast(room) {
    for (const p of room.players) if (p.socketId) io.to(p.socketId).emit('state', stateFor(room, p.id));
  }

  /* ---------- chrono ---------- */
  function setTimer(room, ms, fn) {
    clearTimeout(room.timerH);
    room.deadline = ms ? Date.now() + ms : null;
    room.timerH = ms ? setTimeout(() => { fn(); broadcast(room); }, ms) : null;
  }

  /* ---------- déroulement ---------- */
  function startRound(room) {
    room.players = online(room);
    const n = room.players.length;
    const cats = room.settings.category === 'mix' ? CATS : [room.settings.category];
    room.category = rand(cats);
    let pool = WORDS[room.category].filter((w) => !room.used.has(w));
    if (!pool.length) {
      WORDS[room.category].forEach((w) => room.used.delete(w));
      pool = WORDS[room.category];
    }
    room.word = rand(pool);
    room.used.add(room.word);
    // Le rôle de Maître tourne d'une manche à l'autre.
    room.masterIdx = (room.masterIdx + 1) % n;
    room.masterId = room.players[room.masterIdx].id;
    room.traitreId = rand(room.players.filter((p) => p.id !== room.masterId)).id;
    room.players.forEach((p) => { p.ready = false; });
    room.questions = [];
    room.finderId = null;
    room.votes = {};
    room.result = null;
    room.round++;
    room.phase = 'reveal';
    setTimer(room, 0);
  }

  function checkAllReady(room) {
    if (room.phase !== 'reveal' || !online(room).every((p) => p.ready)) return;
    room.phase = 'questions';
    setTimer(room, room.settings.timer * 60 * 1000, () => finish(room, false));
  }

  function wordFound(room, finderId) {
    room.finderId = finderId;
    room.phase = 'vote';
    room.votes = {};
    setTimer(room, VOTE_MS, () => tally(room));
  }

  function checkVotes(room) {
    if (room.phase === 'vote' && online(room).every((p) => room.votes[p.id])) tally(room);
  }

  function tally(room) {
    if (room.phase !== 'vote') return;
    const counts = {};
    Object.values(room.votes).forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
    const max = Math.max(0, ...Object.values(counts));
    const tops = Object.keys(counts).filter((k) => counts[k] === max);
    finish(room, true, tops.length === 1 ? tops[0] : null);
  }

  function finish(room, found, accusedId = null) {
    const caught = found && accusedId === room.traitreId;
    const winner = !found ? 'nobody' : caught ? 'innocents' : 'traitre';
    const deltas = {};
    for (const p of room.players) {
      let d = 0;
      if (winner === 'innocents' && p.id !== room.traitreId) d = 1;
      if (winner === 'traitre' && p.id === room.traitreId) d = 3;
      if (d) { p.score += d; deltas[p.id] = d; }
    }
    room.result = {
      word: room.word, category: room.category, masterId: room.masterId, traitreId: room.traitreId,
      finderId: room.finderId, found, accusedId, tie: found && accusedId === null,
      votes: { ...room.votes }, winner, deltas, asked: room.questions.length
    };
    room.phase = 'results';
    setTimer(room, 0);
  }

  function onPlayerGone(room, p) {
    if (room.hostId === p.id) {
      const next = online(room)[0];
      if (next) room.hostId = next.id;
    }
    if (!online(room).length) {
      setTimer(room, 0);
      clearTimeout(room.cleanup);
      room.cleanup = setTimeout(() => rooms.delete(room.code), 15 * 60 * 1000);
      return;
    }
    if (['reveal', 'questions', 'vote'].includes(room.phase) && online(room).length < 3) {
      room.phase = 'lobby';
      setTimer(room, 0);
    } else if (room.phase === 'reveal') checkAllReady(room);
    else if (room.phase === 'vote') checkVotes(room);
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
        if (p.socketId && p.socketId !== socket.id) io.sockets.get(p.socketId)?.leave(room.code);
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
      if (room.phase === 'reveal') checkAllReady(room);
      broadcast(room);
    });

    socket.on('leave', () => leave(true));
    socket.on('disconnect', () => leave(false));

    socket.on('settings', (s = {}) => {
      const { room, me } = ctx();
      if (!room || !isHost(room, me) || room.phase !== 'lobby') return;
      if (TIMERS.includes(s.timer)) room.settings.timer = s.timer;
      if (s.category === 'mix' || CATS.includes(s.category)) room.settings.category = s.category;
      broadcast(room);
    });

    socket.on('kick', (target) => {
      const { room, me } = ctx();
      if (!room || !isHost(room, me) || room.phase !== 'lobby' || target === me.id) return;
      const p = getP(room, target);
      if (!p) return;
      if (p.socketId) {
        const s = io.sockets.get(p.socketId);
        if (s) { s.leave(room.code); s.data = {}; s.emit('kicked'); }
      }
      room.players = room.players.filter((x) => x !== p);
      broadcast(room);
    });

    socket.on('start', (cb = () => {}) => {
      const { room, me } = ctx();
      if (!room || !isHost(room, me) || !['lobby', 'results'].includes(room.phase)) return;
      if (online(room).length < MIN_PLAYERS) return cb({ error: `Il faut au moins ${MIN_PLAYERS} joueurs.` });
      startRound(room);
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

    // Question fermée posée par un joueur (pas le Maître).
    socket.on('ask', (text) => {
      const { room, me } = ctx();
      if (!room || room.phase !== 'questions' || me.id === room.masterId) return;
      text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!text) return;
      room.questions.push({ id: ++room.qSeq, pid: me.id, text, a: null });
      if (room.questions.length > MAX_QUESTIONS) room.questions.shift();
      broadcast(room);
    });

    // Réponse du Maître : oui, non, je ne sais pas… ou « trouvé ! ».
    socket.on('answer', ({ id, a } = {}) => {
      const { room, me } = ctx();
      if (!room || room.phase !== 'questions' || me.id !== room.masterId) return;
      const q = room.questions.find((x) => x.id === id);
      if (!q || !['oui', 'non', 'nsp', 'found'].includes(a)) return;
      q.a = a;
      if (a === 'found') wordFound(room, q.pid);
      broadcast(room);
    });

    // Le Maître désigne directement qui a trouvé (utile quand on joue à l'oral).
    socket.on('found', (target) => {
      const { room, me } = ctx();
      if (!room || room.phase !== 'questions' || me.id !== room.masterId) return;
      if (target === room.masterId || !getP(room, target)) return;
      wordFound(room, target);
      broadcast(room);
    });

    socket.on('vote', (target) => {
      const { room, me } = ctx();
      if (!room || room.phase !== 'vote' || target === me.id || target === room.masterId || !getP(room, target)) return;
      room.votes[me.id] = target;
      checkVotes(room);
      broadcast(room);
    });
  });
};
