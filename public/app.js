(() => {
  'use strict';

  // WebSocket direct (pas de phase de polling HTTP), avec repli automatique si bloqué.
  const socket = io({ transports: ['websocket', 'polling'], tryAllTransports: true });
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
  };
  // Identité et partie propres à chaque onglet (survivent à un rechargement).
  const tab = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } }
  };

  const GRID = 1000;        // doit correspondre au serveur
  const MAX_COORDS = 4000;

  let pid = tab.get('fa_pid');
  if (!pid) {
    pid = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
    tab.set('fa_pid', pid);
  }

  /* ---------- état ---------- */
  let S = null;            // état serveur
  let live = null;         // trait en cours d'un autre joueur : { turn, points, bad }
  let strokes = [];        // traits validés, tenus localement (le serveur n'envoie que les nouveaux)
  let strokesGame = -1;
  let syncing = false;
  let cur = null;          // mon trait (en cours ou en attente de validation)
  let drawingNow = false;
  let highlight = null;    // joueur dont on met les traits en avant
  let flipped = false;
  let wordMasked = false;
  let resultsHidden = false;
  let lastKey = '';

  const player = (id) => S && S.players.find((p) => p.id === id);
  const me = () => player(pid);
  const isHost = () => S && S.hostId === pid;
  const myTurn = () => S && S.phase === 'drawing' && S.currentPid === pid;
  const initial = (n) => esc((n || '?').trim().charAt(0).toUpperCase());
  const avatar = (p) => `<span class="avatar" style="background:${p.color}">${initial(p.name)}</span>`;

  /* ---------- toast ---------- */
  let toastT;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 2600);
  }
  async function copy(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg); }
    catch {
      const i = document.createElement('textarea');
      i.value = text; document.body.appendChild(i); i.select();
      try { document.execCommand('copy'); toast(msg); } catch { toast(text); }
      i.remove();
    }
  }

  /* ---------- socket ---------- */
  socket.on('connect', () => {
    const code = tab.get('fa_room');
    if (code) {
      socket.emit('join', { code, pid, name: store.get('fa_name') || '' }, (res) => {
        if (res && res.error) { tab.del('fa_room'); S = null; render(); }
      });
    }
  });
  socket.on('disconnect', () => { if (S) toast('Connexion perdue… reconnexion en cours'); });

  socket.on('state', (s) => {
    const prevTurnMine = myTurn();
    S = s;
    tab.set('fa_room', s.code);
    const key = `${s.game}:${s.phase}:${s.turnIndex}`;
    if (key !== lastKey) {
      const prevGame = lastKey.split(':')[0];
      lastKey = key;
      live = null; cur = null; drawingNow = false;
      sentLen = 0; clearTimeout(liveTimer); liveTimer = null; layerDirty = true;
      if (String(s.game) !== prevGame) { flipped = false; wordMasked = false; highlight = null; }
      if (s.phase !== 'results') resultsHidden = false;
      if (s.phase === 'results') highlight = null;
    }
    if (s.game !== strokesGame) { strokes = []; strokesGame = s.game; layerDirty = true; }
    if (s.sc !== strokes.length) requestSync();
    if (!prevTurnMine && myTurn() && navigator.vibrate) navigator.vibrate(60);
    render();
  });

  function requestSync() {
    if (syncing) return;
    syncing = true;
    socket.emit('sync');
  }
  socket.on('strokes', (d) => {
    syncing = false;
    strokes = d.list;
    strokesGame = d.game;
    layerDirty = true;
    if (d.live && d.live.pid !== pid) live = { turn: d.live.turn, points: d.live.points, bad: false };
    if (S) render();
  });

  // Dessin en direct d'un autre joueur : [tour, début, x1, y1, …].
  socket.on('l', (m) => {
    if (!S || m[0] !== S.turnIndex) return;
    const start = m[1];
    if (start === 0) live = { turn: m[0], points: m.slice(2), bad: false };
    else if (live && live.turn === m[0] && start === live.points.length) {
      for (let i = 2; i < m.length; i++) live.points.push(m[i]);
    } else if (live) live.bad = true;
    else return;
    requestDraw();
  });

  // Trait validé : on le reconstruit à partir des points déjà reçus en direct.
  socket.on('k', (k) => {
    const src = k.pid === pid ? cur : (live && live.turn === k.turn && !live.bad ? live.points : null);
    if (src && src.length === k.n && k.i === strokes.length) {
      strokes.push({ pid: k.pid, color: k.color, points: src.slice() });
      layerDirty = true;
    } else requestSync();
  });

  // Le serveur a perdu le fil de mon trait : tout renvoyer.
  socket.on('lr', () => { sentLen = 0; sendLive(true); });

  socket.on('kicked', () => {
    tab.del('fa_room'); S = null; render();
    toast("L'hôte t'a retiré de la partie.");
  });

  /* ---------- accueil ---------- */
  const nameInput = $('#nameInput');
  const codeInput = $('#codeInput');
  nameInput.value = store.get('fa_name') || '';
  const urlCode = new URLSearchParams(location.search).get('code');
  if (urlCode) codeInput.value = urlCode.toUpperCase().slice(0, 4);

  function getName() {
    const n = nameInput.value.trim();
    if (!n) { nameInput.focus(); toast('Choisis un pseudo pour jouer'); return null; }
    store.set('fa_name', n);
    return n;
  }
  $('#createBtn').onclick = () => {
    const name = getName(); if (!name) return;
    socket.emit('create', { name, pid }, (res) => { if (res && res.error) toast(res.error); });
  };
  function join() {
    const name = getName(); if (!name) return;
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 4) { codeInput.focus(); toast('Le code fait 4 lettres'); return; }
    socket.emit('join', { code, name, pid }, (res) => { if (res && res.error) toast(res.error); });
  }
  $('#joinBtn').onclick = join;
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') (codeInput.value.length === 4 ? join() : $('#createBtn').click()); });

  $$('[data-leave]').forEach((b) => b.onclick = () => {
    if (S && S.phase !== 'lobby' && S.phase !== 'results' && !confirm('Quitter la partie en cours ?')) return;
    socket.emit('leave');
    tab.del('fa_room');
    S = null; lastKey = '';
    history.replaceState(null, '', location.pathname);
    render();
  });

  /* ---------- salon ---------- */
  const shareUrl = () => `${location.origin}${location.pathname}?code=${S.code}`;
  $('#codeBig').onclick = $('#copyCode').onclick = () => copy(S.code, 'Code copié');
  $('#copyLink').onclick = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: 'Gribouille', text: `Rejoins ma partie de Gribouille ! Code : ${S.code}`, url: shareUrl() }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    copy(shareUrl(), 'Lien copié');
  };
  $('#startBtn').onclick = () => socket.emit('start', (res) => { if (res && res.error) toast(res.error); });

  function renderLobby() {
    $('#codeBig').textContent = S.code;
    const on = S.players.filter((p) => p.connected).length;
    $('#playerCount').textContent = `${S.players.length}/10`;

    const rows = S.players.map((p) => `
      <li class="player ${p.connected ? '' : 'off'}">
        ${avatar(p)}
        <span class="name">${esc(p.name)}${p.id === pid ? '<small>toi</small>' : ''}</span>
        ${p.id === S.hostId ? '<span class="tag host">Hôte</span>' : ''}
        ${!p.connected ? '<span class="tag">hors ligne</span>' : ''}
        ${p.score ? `<span class="score">${p.score} pt${p.score > 1 ? 's' : ''}</span>` : ''}
        ${isHost() && p.id !== pid ? `<button class="kick" data-kick="${esc(p.id)}" title="Retirer">×</button>` : ''}
      </li>`);
    if (S.players.length < 3) rows.push(`<li class="player slot">En attente de joueurs… partage le code !</li>`);
    $('#playerList').innerHTML = rows.join('');
    $$('[data-kick]').forEach((b) => b.onclick = () => socket.emit('kick', b.dataset.kick));

    const host = isHost();
    $('#settingsPanel').classList.toggle('locked', !host);
    $('#settingsNote').textContent = host ? '' : "Choisis par l'hôte";
    $('#roundsSeg').innerHTML = [1, 2, 3, 4].map((n) =>
      `<button class="${S.settings.rounds === n ? 'on' : ''}" data-r="${n}">${n}</button>`).join('');
    $$('#roundsSeg button').forEach((b) => b.onclick = () => socket.emit('settings', { rounds: +b.dataset.r }));
    const cats = ['mix', ...S.categories];
    $('#catChips').innerHTML = cats.map((c) =>
      `<button class="chip ${S.settings.category === c ? 'on' : ''}" data-c="${esc(c)}">${c === 'mix' ? '🎲 Aléatoire' : esc(c)}</button>`).join('');
    $$('#catChips .chip').forEach((b) => b.onclick = () => socket.emit('settings', { category: b.dataset.c }));

    const startBtn = $('#startBtn');
    startBtn.style.display = host ? '' : 'none';
    startBtn.disabled = on < 3;
    const hostP = player(S.hostId);
    $('#lobbyHint').textContent = host
      ? (on < 3 ? `Il faut au moins 3 joueurs connectés (${on}/3)` : `${on} joueurs prêts à dessiner`)
      : `En attente que ${hostP ? hostP.name : "l'hôte"} lance la partie…`;
  }

  /* ---------- jeu : rendu ---------- */
  function phaseLabel() {
    switch (S.phase) {
      case 'reveal': return 'Préparation';
      case 'drawing': {
        const n = S.order.length;
        return `Tour ${Math.floor(S.turnIndex / n) + 1} / ${S.settings.rounds}`;
      }
      case 'voting': return 'Vote';
      case 'guess': return 'Dernière chance';
      case 'results': return 'Résultats';
      default: return '';
    }
  }

  function renderRoleChip() {
    const chip = $('#roleChip');
    const r = S.role;
    if (!r) { chip.style.display = 'none'; return; }
    chip.style.display = '';
    const eye = `<svg class="eye" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>${wordMasked ? '<path d="M3 3l18 18"/>' : ''}</svg>`;
    if (r.isImposter) {
      chip.className = 'role-chip imp' + (wordMasked ? ' masked' : '');
      chip.innerHTML = `<span class="lbl">Imposteur ·</span><b>${esc(r.category)}</b>${eye}`;
    } else {
      chip.className = 'role-chip' + (wordMasked ? ' masked' : '');
      chip.innerHTML = `<span class="lbl">${esc(r.category)} ·</span><b>${esc(r.word)}</b>${eye}`;
    }
  }
  $('#roleChip').onclick = () => { wordMasked = !wordMasked; renderRoleChip(); };

  function renderStatus() {
    const st = $('#status');
    const p = player(S.currentPid);
    let html = '';
    if (S.phase === 'reveal') html = 'Découvrez vos rôles…';
    else if (S.phase === 'drawing') {
      if (myTurn()) html = cur && !drawingNow ? 'Valide ton trait ou recommence' : 'À toi ! Trace un seul trait';
      else if (p) html = `<span class="dot" style="background:${p.color}"></span>${esc(p.name)} dessine…`;
    } else if (S.phase === 'voting') html = S.myVote ? 'Vote enregistré — tu peux encore changer' : "Qui est l'imposteur ?";
    else if (S.phase === 'guess') {
      const a = player(S.accusedId);
      html = S.role.isImposter ? 'Devine le mot secret !' : `${a ? esc(a.name) : "L'imposteur"} tente de deviner le mot…`;
    } else if (S.phase === 'results') html = S.result.imposterWins ? "Victoire de l'imposteur" : 'Victoire des artistes';
    st.innerHTML = html;

    const wrap = $('#boardWrap');
    const mine = myTurn();
    wrap.classList.toggle('mine', mine);
    if (mine) wrap.style.setProperty('--turn-color', me().color);
    const badge = $('#boardBadge');
    if (S.phase === 'drawing' && p && !mine) {
      badge.innerHTML = `${avatar(p)}${esc(p.name)}<span class="pulse"></span>`;
      badge.classList.add('show');
    } else badge.classList.remove('show');

    $('#actions').classList.toggle('show', mine);
    $('#submitBtn').disabled = !cur || drawingNow;
    $('#clearBtn').disabled = !cur || drawingNow;
    document.title = mine ? '✏️ À toi ! — Gribouille' : 'Gribouille';
  }

  function strokeCount(id) { return strokes.filter((s) => s.pid === id).length; }
  function votesFor(id, votes) { return Object.entries(votes || {}).filter(([, t]) => t === id).map(([v]) => player(v)).filter(Boolean); }

  function renderSide() {
    const list = $('#sideList');
    const title = $('#sideTitle');
    const meta = $('#sideMeta');
    const hint = $('#sideHint');
    hint.textContent = '';

    if (S.phase === 'reveal' || S.phase === 'drawing') {
      title.textContent = 'Ordre de passage';
      meta.textContent = `${strokes.length} / ${S.totalTurns} traits`;
      list.innerHTML = S.order.map((id, i) => {
        const p = player(id); if (!p) return '';
        const done = strokeCount(id);
        const pips = Array.from({ length: S.settings.rounds }, (_, k) =>
          `<span class="pip ${k < done ? 'on' : ''}" style="${k < done ? `background:${p.color}` : ''}"></span>`).join('');
        const isCur = S.currentPid === id;
        return `<li class="player ${isCur ? 'current' : ''} ${p.connected ? '' : 'off'}">
          <span class="pos">${i + 1}</span>${avatar(p)}
          <span class="name">${esc(p.name)}${id === pid ? '<small>toi</small>' : ''}</span>
          ${isCur ? '<span class="tag live">dessine</span>' : S.phase === 'reveal' ? (p.ready ? '<span class="tag good">prêt</span>' : '') : `<span class="pips">${pips}</span>`}
        </li>`;
      }).join('');
    } else if (S.phase === 'voting') {
      const voters = S.players.filter((p) => p.connected);
      title.textContent = 'Votez';
      meta.textContent = `${voters.filter((p) => p.voted).length} / ${voters.length} votes`;
      hint.textContent = 'Touche un joueur pour isoler ses traits sur le dessin.';
      list.innerHTML = S.order.map((id) => {
        const p = player(id); if (!p) return '';
        const self = id === pid;
        return `<li class="player clickable ${highlight === id ? 'hl' : ''} ${S.myVote === id ? 'picked' : ''} ${p.connected ? '' : 'off'}" data-hl="${esc(id)}">
          ${avatar(p)}
          <span class="name">${esc(p.name)}${self ? '<small>toi</small>' : ''}</span>
          ${p.voted ? '<span class="tag good">a voté</span>' : ''}
          ${self ? '' : `<button class="vote-btn" data-vote="${esc(id)}">${S.myVote === id ? 'Voté' : 'Voter'}</button>`}
        </li>`;
      }).join('');
    } else {
      const votes = S.phase === 'results' ? S.result.votes : null;
      title.textContent = S.phase === 'results' ? 'Les artistes' : 'Votes';
      meta.textContent = '';
      hint.textContent = 'Touche un joueur pour isoler ses traits.';
      list.innerHTML = S.order.map((id) => {
        const p = player(id); if (!p) return '';
        const got = votes ? votesFor(id, votes) : [];
        const imp = S.phase === 'results' && S.result.imposterId === id;
        return `<li class="player clickable ${highlight === id ? 'hl' : ''}" data-hl="${esc(id)}">
          ${avatar(p)}
          <span class="name">${esc(p.name)}${id === pid ? '<small>toi</small>' : ''}</span>
          ${imp ? '<span class="tag bad">imposteur</span>' : ''}
          <span class="votes-count">${got.map((v) => `<i title="${esc(v.name)}" style="background:${v.color}"></i>`).join('')}</span>
        </li>`;
      }).join('');
    }

    list.querySelectorAll('[data-hl]').forEach((li) => li.onclick = (e) => {
      if (e.target.closest('[data-vote]')) return;
      highlight = highlight === li.dataset.hl ? null : li.dataset.hl;
      layerDirty = true;
      renderSide(); requestDraw();
    });
    list.querySelectorAll('[data-vote]').forEach((b) => b.onclick = () => socket.emit('vote', b.dataset.vote));
  }

  function renderReveal() {
    const ov = $('#revealOv');
    const show = S.phase === 'reveal';
    ov.classList.toggle('show', show);
    if (!show) return;
    const r = S.role;
    const back = $('#roleBack');
    if (r.isImposter) {
      back.className = 'face back imp';
      back.innerHTML = `<div class="imp-icon">🕵️</div><span class="eyebrow">Ton rôle</span>
        <div class="secret-word">Imposteur</div><span class="cat">Catégorie : ${esc(r.category)}</span>
        <p>Tu ne connais pas le mot. Observe les traits des autres et dessine comme si tu savais.</p>`;
    } else {
      back.className = 'face back';
      back.innerHTML = `<span class="eyebrow">Le mot secret</span>
        <div class="secret-word">${esc(r.word)}</div><span class="cat">${esc(r.category)}</span>
        <p>Dessine-le subtilement : assez pour prouver que tu le connais, pas assez pour aider l'imposteur.</p>`;
    }
    $('#flipCard').classList.toggle('open', flipped);
    const ready = me() && me().ready;
    const btn = $('#readyBtn');
    btn.disabled = !flipped || ready;
    btn.textContent = ready ? 'En attente des autres…' : "C'est noté, je suis prêt";
    const on = S.players.filter((p) => p.connected);
    $('#readyInfo').textContent = `${on.filter((p) => p.ready).length} / ${on.length} joueurs prêts`;
  }
  $('#flipCard').onclick = () => { flipped = !flipped; renderReveal(); };
  $('#readyBtn').onclick = () => socket.emit('ready');

  function renderGuess() {
    const show = S.phase === 'guess' && S.role.isImposter;
    const ov = $('#guessOv');
    const was = ov.classList.contains('show');
    ov.classList.toggle('show', show);
    if (show) {
      $('#guessCat').innerHTML = `Catégorie : <b>${esc(S.role.category)}</b>`;
      if (!was) { $('#guessInput').value = ''; setTimeout(() => $('#guessInput').focus(), 50); }
    }
  }
  $('#guessForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#guessInput').value.trim();
    if (!v) return;
    socket.emit('guess', v);
  };

  function renderResults() {
    const isRes = S.phase === 'results';
    $('#resultOv').classList.toggle('show', isRes && !resultsHidden);
    $('#reopenResults').classList.toggle('show', isRes && resultsHidden);
    if (!isRes) return;
    const R = S.result;
    const imp = player(R.imposterId) || { name: '?', color: '#666' };
    const accused = player(R.accusedId);
    const iAmImp = R.imposterId === pid;
    const iWon = iAmImp ? R.imposterWins : !R.imposterWins;

    let detail;
    if (R.tie) detail = `Égalité dans les votes : personne n'est accusé et ${esc(imp.name)} s'échappe.`;
    else if (!R.caught) detail = `Vous avez accusé ${esc(accused ? accused.name : '?')} à tort. ${esc(imp.name)} était l'imposteur !`;
    else if (R.guessCorrect) detail = `${esc(imp.name)} a été démasqué·e mais a deviné « ${esc(R.guess)} ». Bien joué !`;
    else if (R.guess) detail = `${esc(imp.name)} a été démasqué·e et a proposé « ${esc(R.guess)} »… raté !`;
    else detail = `${esc(imp.name)} a été démasqué·e et n'a pas trouvé le mot.`;

    const ranking = S.players.slice().sort((a, b) => b.score - a.score);
    const delta = (p) => {
      const isImp = p.id === R.imposterId;
      if (isImp && R.imposterWins) return '+2';
      if (!isImp && !R.imposterWins) return '+1';
      return '';
    };

    const host = isHost();
    $('#resultBox').innerHTML = `
      <div class="verdict ${R.imposterWins ? 'imp' : ''}">
        <div class="badge">${R.imposterWins ? '🕵️' : '🎨'}</div>
        <span class="eyebrow">${iWon ? 'Tu as gagné' : 'Tu as perdu'}</span>
        <h2>${R.imposterWins ? "L'imposteur l'emporte" : 'Les artistes gagnent'}</h2>
        <p>${detail}</p>
      </div>
      <div class="word-reveal"><span>Le mot était · ${esc(R.category)}</span><b>${esc(R.word)}</b></div>
      <ul class="players scoreboard">${ranking.map((p, i) => `
        <li class="player">
          <span class="pos">${i + 1}</span>${avatar(p)}
          <span class="name">${esc(p.name)}${p.id === pid ? '<small>toi</small>' : ''}</span>
          ${p.id === R.imposterId ? '<span class="tag bad">imposteur</span>' : ''}
          <span class="delta">${delta(p)}</span>
          <span class="score">${p.score}</span>
        </li>`).join('')}
      </ul>
      <div class="result-actions">
        <button class="btn ghost ${host ? '' : 'full'}" id="seeDrawing">Voir le dessin</button>
        ${host ? '<button class="btn primary" id="againBtn">Rejouer</button><button class="btn ghost full sm" id="lobbyBtn">Retour au salon</button>'
               : ''}
      </div>
      ${host ? '' : '<p class="hint">En attente de l\'hôte pour la manche suivante…</p>'}
    `;
    $('#seeDrawing').onclick = () => { resultsHidden = true; renderResults(); };
    if (host) {
      $('#againBtn').onclick = () => socket.emit('start', (res) => { if (res && res.error) toast(res.error); });
      $('#lobbyBtn').onclick = () => socket.emit('toLobby');
    }
  }
  $('#reopenResults').onclick = () => { resultsHidden = false; renderResults(); };

  function renderGame() {
    $('#gCode').textContent = S.code;
    $('#gPhase').textContent = phaseLabel();
    renderRoleChip();
    renderStatus();
    renderSide();
    renderReveal();
    renderGuess();
    renderResults();
    resizeBoard();
  }

  function render() {
    const screen = !S ? 'home' : S.phase === 'lobby' ? 'lobby' : 'game';
    $$('.screen').forEach((el) => el.classList.toggle('active', el.id === screen));
    if (screen === 'lobby') renderLobby();
    if (screen === 'game') renderGame();
    if (screen !== 'game') {
      $$('.overlay').forEach((o) => o.classList.remove('show'));
      $('#reopenResults').classList.remove('show');
      document.title = 'Gribouille';
    }
  }

  /* ---------- canvas ---------- */
  const board = $('#board');
  const ctx = board.getContext('2d');
  let drawQueued = false;

  function resizeBoard() {
    const r = board.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.round(r.width * dpr);
    if (w !== board.width) { board.width = w; board.height = w; }
    requestDraw();
  }
  new ResizeObserver(resizeBoard).observe(board);

  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(drawBoard);
  }

  // Les traits validés sont dessinés une seule fois dans un calque hors écran ;
  // à chaque image on ne redessine que le trait en cours par-dessus.
  const layer = document.createElement('canvas');
  const lctx = layer.getContext('2d');
  let layerDirty = true;

  function strokePath(c, pts, color, alpha = 1) {
    const n = pts.length / 2;
    if (!n) return;
    const s = c.canvas.width / GRID;
    const lw = c.canvas.width * 0.012;
    c.globalAlpha = alpha;
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = lw;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    if (n === 1) {
      c.arc(pts[0] * s, pts[1] * s, lw / 2, 0, Math.PI * 2);
      c.fill();
      return;
    }
    c.moveTo(pts[0] * s, pts[1] * s);
    for (let i = 1; i < n - 1; i++) {
      const x = pts[i * 2] * s, y = pts[i * 2 + 1] * s;
      const nx = pts[i * 2 + 2] * s, ny = pts[i * 2 + 3] * s;
      c.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    c.lineTo(pts[(n - 1) * 2] * s, pts[(n - 1) * 2 + 1] * s);
    c.stroke();
  }

  function drawBoard() {
    drawQueued = false;
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, board.width, board.height);
    if (!S || S.phase === 'lobby') return;
    if (layer.width !== board.width) { layer.width = board.width; layer.height = board.height; layerDirty = true; }
    if (layerDirty) {
      layerDirty = false;
      lctx.clearRect(0, 0, layer.width, layer.height);
      for (const st of strokes) strokePath(lctx, st.points, st.color, highlight && st.pid !== highlight ? 0.12 : 1);
      lctx.globalAlpha = 1;
    }
    ctx.drawImage(layer, 0, 0);
    const curP = player(S.currentPid);
    if (live && live.points.length && curP && S.currentPid !== pid) strokePath(ctx, live.points, curP.color);
    if (cur && cur.length && me()) strokePath(ctx, cur, me().color);
    ctx.globalAlpha = 1;
  }

  /* ---------- dessin ---------- */
  // Seuls les nouveaux points partent, toutes les 50 ms au plus.
  let liveAt = 0, liveTimer = null, sentLen = 0;
  function sendLive(force) {
    const now = performance.now();
    if (force || now - liveAt >= 50) {
      liveAt = now;
      clearTimeout(liveTimer); liveTimer = null;
      const pts = cur || [];
      if (sentLen > 0 && sentLen === pts.length) return;
      socket.emit('l', [sentLen, ...pts.slice(sentLen)]);
      sentLen = pts.length;
    } else if (!liveTimer) {
      liveTimer = setTimeout(() => sendLive(true), 50 - (now - liveAt));
    }
  }

  function addPoint(e) {
    if (cur.length >= MAX_COORDS) return;
    const r = board.getBoundingClientRect();
    const x = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * GRID);
    const y = Math.round(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * GRID);
    const n = cur.length;
    if (n) {
      const dx = x - cur[n - 2], dy = y - cur[n - 1];
      if (dx * dx + dy * dy < 6) return;
    }
    cur.push(x, y);
  }

  board.addEventListener('pointerdown', (e) => {
    if (!myTurn() || drawingNow) return;
    e.preventDefault();
    board.setPointerCapture(e.pointerId);
    drawingNow = true;
    cur = [];
    sentLen = 0;
    addPoint(e);
    requestDraw();
    sendLive(true);
    renderStatus();
  });
  board.addEventListener('pointermove', (e) => {
    if (!drawingNow) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    (evs.length ? evs : [e]).forEach(addPoint);
    requestDraw();
    sendLive(false);
  });
  const endStroke = () => {
    if (!drawingNow) return;
    drawingNow = false;
    sendLive(true);
    renderStatus();
  };
  board.addEventListener('pointerup', endStroke);
  board.addEventListener('pointercancel', endStroke);
  board.addEventListener('lostpointercapture', endStroke);

  $('#clearBtn').onclick = () => {
    cur = null;
    sentLen = 0;
    sendLive(true);
    requestDraw();
    renderStatus();
  };
  $('#submitBtn').onclick = () => {
    if (!cur || !cur.length || drawingNow) return;
    $('#submitBtn').disabled = true;
    sendLive(true);
    socket.emit('submit', cur.length, (res) => {
      if (!res || !res.resync || !cur) return;
      sentLen = 0;
      sendLive(true);
      socket.emit('submit', cur.length);
    });
  };
  document.addEventListener('keydown', (e) => {
    if (!myTurn() || e.target.tagName === 'INPUT') return;
    if (e.key === 'Enter') $('#submitBtn').click();
    if (e.key === 'Escape' || e.key === 'Backspace') $('#clearBtn').click();
  });

  render();
})();
