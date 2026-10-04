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

  const GRID = 1000;        // doit correspondre au serveur (sur chaque axe)
  const MAX_COORDS = 4000;
  const ASPECT = 5 / 4;     // hauteur / largeur de la feuille de dessin
  const fmt = (n) => n.toLocaleString('fr-FR');

  const ROLE_INFO = {
    artist: { emoji: '🎨', name: 'Artiste' },
    imposter: { emoji: '🕵️', name: 'Imposteur', bad: true },
    detective: { emoji: '🔎', name: 'Détective', desc: 'Enquête une fois sur un joueur pour savoir s\'il est suspect.',
      card: 'Une fois dans la partie, tu peux enquêter sur un joueur pour savoir s\'il est suspect.' },
    aveugle: { emoji: '🙈', name: 'Aveugle', desc: 'Connaît le mot mais dessine sans voir la feuille.',
      card: 'Quand viendra ton tour, la feuille sera cachée : tu dessineras à l\'aveugle !' },
    complice: { emoji: '🤝', name: 'Complice', bad: true, desc: 'Connaît le mot et l\'imposteur. Gagne avec lui.',
      card: 'Aide-le discrètement : tu gagnes si l\'imposteur s\'en sort.' },
    bouffon: { emoji: '🃏', name: 'Bouffon', desc: 'Connaît le mot. Gagne seul s\'il se fait accuser.',
      card: 'Tu gagnes seul si tu te fais accuser. Dessine de façon louche… mais pas trop !' },
    gardien: { emoji: '🛡️', name: 'Gardien', desc: 'S\'il est accusé, le vote est annulé (une fois).',
      card: 'Si tu es accusé, ton rôle est dévoilé et le vote est annulé (une seule fois).' },
    saboteur: { emoji: '🧨', name: 'Saboteur', bad: true, desc: 'Connaît le mot, gagne si l\'imposteur s\'en sort.',
      card: 'Tu ne sais pas qui est l\'imposteur, mais tu gagnes s\'il s\'en sort. Sème le doute !' },
    duo: { emoji: '👥', name: 'Deux imposteurs', desc: 'Deux imposteurs qui ne se connaissent pas.' },
    voisin: { emoji: '🔀', name: 'Mot voisin', desc: 'L\'imposteur reçoit un autre mot et ne sait pas qu\'il est l\'imposteur.' }
  };
  const ROLE_KEYS = ['detective', 'aveugle', 'complice', 'bouffon', 'gardien', 'saboteur', 'duo', 'voisin'];
  function roleTag(r) {
    if (!r || r === 'artist') return '';
    const i = ROLE_INFO[r];
    return `<span class="tag ${i.bad ? 'bad' : 'role'}">${r === 'imposter' ? 'imposteur' : `${i.emoji} ${i.name}`}</span>`;
  }

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
  let voteHidden = false;
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
      if (s.phase !== 'voting') voteHidden = false;
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
    const total = S.categories.reduce((n, c) => n + (S.wordCounts[c] || 0), 0);
    $('#catChips').innerHTML = cats.map((c) =>
      `<button class="chip ${S.settings.category === c ? 'on' : ''}" data-c="${esc(c)}">${c === 'mix' ? '🎲 Aléatoire' : esc(c)}<small>${fmt(c === 'mix' ? total : S.wordCounts[c] || 0)}</small></button>`).join('');
    $$('#catChips .chip').forEach((b) => b.onclick = () => socket.emit('settings', { category: b.dataset.c }));
    $('#roleOpts').innerHTML = ROLE_KEYS.map((k) => {
      const i = ROLE_INFO[k];
      const enabled = S.settings.roles[k];
      const enough = on >= S.roleMin[k];
      return `<button class="role-opt ${enabled ? 'on' : ''} ${enough ? '' : 'short'}" data-role="${k}">
        <span class="ro-emoji">${i.emoji}</span>
        <span class="ro-text"><b>${i.name}</b><small>${i.desc}</small></span>
        <span class="ro-min">${S.roleMin[k]}+</span>
      </button>`;
    }).join('');
    $$('#roleOpts [data-role]').forEach((b) => b.onclick = () =>
      socket.emit('settings', { roles: { [b.dataset.role]: !S.settings.roles[b.dataset.role] } }));

    const startBtn = $('#startBtn');
    startBtn.style.display = host ? '' : 'none';
    startBtn.disabled = on < 3;
    const hostP = player(S.hostId);
    $('#lobbyHint').textContent = host
      ? (on < 3 ? `Il faut au moins 3 joueurs connectés (${on}/3)` : `${on} joueurs prêts à dessiner${activeRoles(on)}`)
      : `En attente que ${hostP ? hostP.name : "l'hôte"} lance la partie…`;
  }

  function activeRoles(on) {
    const list = ROLE_KEYS.filter((k) => S.settings.roles[k] && on >= S.roleMin[k]).map((k) => ROLE_INFO[k].emoji);
    return list.length ? ` · ${list.join(' ')}` : '';
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
      case 'validate': return 'Validation';
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
      const tag = r.id !== 'artist' ? `${ROLE_INFO[r.id].emoji} ` : '';
      chip.innerHTML = `<span class="lbl">${tag}${esc(r.category)} ·</span><b>${esc(r.word)}</b>${eye}`;
    }
  }
  $('#roleChip').onclick = () => { wordMasked = !wordMasked; renderRoleChip(); };

  function renderStatus() {
    const st = $('#status');
    const p = player(S.currentPid);
    let html = '';
    if (S.phase === 'reveal') html = 'Découvrez vos rôles…';
    else if (S.phase === 'drawing') {
      if (myTurn()) html = cur && !drawingNow ? 'Valide ton trait ou recommence' : blind() ? 'À toi ! Dessine à l\'aveugle 🙈' : 'À toi ! Trace un seul trait';
      else if (p) html = `<span class="dot" style="background:${p.color}"></span>${esc(p.name)} dessine…`;
    } else if (S.phase === 'voting') html = S.myVote ? 'Vote enregistré — tu peux encore changer' : "Qui est l'imposteur ?";
    else if (S.phase === 'guess') {
      const a = player(S.accusedId);
      html = S.accusedId === pid ? 'Devine le mot secret !' : `${a ? esc(a.name) : "L'imposteur"} tente de deviner le mot…`;
    } else if (S.phase === 'validate') {
      const j = player(S.pending.judgeId);
      html = S.pending.judgeId === pid ? 'À toi de valider le mot proposé'
        : `${j ? esc(j.name) : "L'arbitre"} valide « ${esc(S.pending.guess)} »…`;
    } else if (S.phase === 'results') html = verdictOf(S.result)[1];
    st.innerHTML = html;

    const wrap = $('#boardWrap');
    const mine = myTurn();
    wrap.classList.toggle('mine', mine);
    wrap.classList.toggle('blind', blind());
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
    $('#sideExtra').innerHTML = inspectBlock();

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
        const safe = S.excluded.includes(id);
        return `<li class="player clickable ${highlight === id ? 'hl' : ''} ${S.myVote === id ? 'picked' : ''} ${p.connected ? '' : 'off'}" data-hl="${esc(id)}">
          ${avatar(p)}
          <span class="name">${esc(p.name)}${self ? '<small>toi</small>' : ''}</span>
          ${safe ? roleTag('gardien') : ''}
          ${p.voted ? '<span class="tag good">a voté</span>' : ''}
          ${self || safe ? '' : `<button class="vote-btn" data-vote="${esc(id)}">${S.myVote === id ? 'Voté' : 'Voter'}</button>`}
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
        const tag = S.phase === 'results' ? roleTag(S.result.roles[id]) : '';
        return `<li class="player clickable ${highlight === id ? 'hl' : ''}" data-hl="${esc(id)}">
          ${avatar(p)}
          <span class="name">${esc(p.name)}${id === pid ? '<small>toi</small>' : ''}</span>
          ${tag}
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
    bindInspect();
  }

  // Enquête du Détective : une seule fois, pendant le dessin ou le vote.
  function inspectBlock() {
    if (!S.role || S.role.id !== 'detective' || !['drawing', 'voting'].includes(S.phase)) return '';
    const done = S.role.inspect;
    if (done) {
      const t = player(done.target);
      return `<div class="inspect">🔎 ${esc(t ? t.name : '?')} est <b class="${done.suspect ? 'bad' : 'good'}">${done.suspect ? 'suspect' : 'innocent'}</b>
        <small>${done.suspect ? 'Imposteur, complice, saboteur ou bouffon.' : 'Un artiste honnête.'}</small></div>`;
    }
    const others = S.order.filter((id) => id !== pid).map(player).filter(Boolean);
    return `<div class="inspect"><span>🔎 Enquête (une seule fois) :</span>
      <div class="chips">${others.map((p) => `<button class="chip" data-inspect="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div></div>`;
  }
  function bindInspect() {
    $$('[data-inspect]').forEach((b) => b.onclick = () => {
      const t = player(b.dataset.inspect);
      if (t && confirm(`Enquêter sur ${t.name} ? Tu ne pourras le faire qu'une fois.`)) socket.emit('inspect', t.id);
    });
  }
  const blind = () => myTurn() && S.role && S.role.id === 'aveugle';

  function renderReveal() {
    const ov = $('#revealOv');
    const show = S.phase === 'reveal';
    ov.classList.toggle('show', show);
    if (!show) return;
    const r = S.role;
    const back = $('#roleBack');
    const duo = S.settings.roles.duo && S.order.length >= S.roleMin.duo;
    const neighbor = r.neighbor ? '<p class="note">🔀 Mot voisin : l\'imposteur a reçu un autre mot… et ne le sait pas.</p>' : '';
    if (r.isImposter) {
      back.className = 'face back imp';
      back.innerHTML = `<div class="imp-icon">🕵️</div><span class="eyebrow">Ton rôle</span>
        <div class="secret-word">Imposteur</div><span class="cat">Catégorie : ${esc(r.category)}</span>
        <p>Tu ne connais pas le mot. Observe les traits des autres et dessine comme si tu savais.</p>
        ${duo ? '<p class="note">👥 Un autre imposteur rôde aussi, mais tu ne sais pas qui.</p>' : ''}`;
    } else {
      const i = ROLE_INFO[r.id];
      let text = i.card || 'Dessine-le subtilement : assez pour prouver que tu le connais, pas assez pour aider l\'imposteur.';
      if (r.id === 'complice') {
        const names = (r.partners || []).map(player).filter(Boolean).map((p) => `<b>${esc(p.name)}</b>`).join(' et ');
        text = `${(r.partners || []).length > 1 ? 'Les imposteurs sont' : 'L\'imposteur est'} ${names}. ${text}`;
      }
      back.className = 'face back' + (i.bad ? ' bad' : '');
      back.innerHTML = `<span class="eyebrow">${r.id === 'artist' ? 'Le mot secret' : `${i.emoji} Tu es ${i.name}`}</span>
        <div class="secret-word">${esc(r.word)}</div><span class="cat">${esc(r.category)}</span>
        <p>${text}</p>${neighbor}`;
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
    const show = S.phase === 'guess' && S.accusedId === pid;
    const ov = $('#guessOv');
    const was = ov.classList.contains('show');
    ov.classList.toggle('show', show);
    if (show) {
      $('#guessCat').innerHTML = `Catégorie : <b>${esc(S.role.category)}</b>`;
      $('#guessIntro').innerHTML = S.role.decoy
        ? `Surprise : tu étais l'imposteur ! Ton mot « ${esc(S.role.decoy)} » n'était pas le bon. Devine le vrai mot pour voler la victoire.`
        : "Les autres t'ont trouvé. Devine le mot secret pour voler la victoire.";
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
    const two = R.imposterIds.length > 1;
    const impNames = R.imposterIds.map(player).filter(Boolean).map((p) => esc(p.name)).join(' et ') || '?';
    const wasImp = two ? `${impNames} étaient les imposteurs` : `${impNames} était l'imposteur`;
    const accused = player(R.accusedId);
    const accName = esc(accused ? accused.name : '?');
    const iWon = !!R.deltas[pid];

    const judge = player(R.judgeId);
    const judgedBy = judge ? ` (arbitre : ${esc(judge.name)})` : '';
    let detail;
    if (R.winner === 'bouffon') detail = `${accName} était le Bouffon et voulait justement se faire accuser ! ${wasImp}.`;
    else if (R.tie) detail = `Égalité dans les votes : personne n'est accusé et ${impNames} s'échappe${two ? 'nt' : ''}.`;
    else if (!R.caught) detail = `Vous avez accusé ${accName} à tort. ${wasImp} !`;
    else if (R.guessCorrect) detail = `${accName} a été démasqué·e mais a proposé « ${esc(R.guess)} »${judgedBy} : accepté. Bien joué !`;
    else if (R.guess) detail = `${accName} a été démasqué·e et a proposé « ${esc(R.guess)} »${judgedBy} : refusé !`;
    else detail = `${accName} a été démasqué·e et n'a pas trouvé le mot.`;
    if (R.caught && two) detail += ` L'autre imposteur : ${R.imposterIds.filter((id) => id !== R.accusedId).map(player).filter(Boolean).map((p) => esc(p.name)).join('')}.`;
    if (R.decoy) detail += ` Le mot voisin de l'imposteur était « ${esc(R.decoy)} ».`;
    const g = player(R.gardienId);
    if (g) detail += ` 🛡️ ${esc(g.name)}, le Gardien, a fait annuler un vote.`;

    const ranking = S.players.slice().sort((a, b) => b.score - a.score);
    const delta = (p) => (R.deltas[p.id] ? `+${R.deltas[p.id]}` : '');
    const [badge, title, cls] = verdictOf(R);

    const host = isHost();
    $('#resultBox').innerHTML = `
      <div class="verdict ${cls}">
        <div class="badge">${badge}</div>
        <span class="eyebrow">${iWon ? 'Tu as gagné' : 'Tu as perdu'}</span>
        <h2>${title}</h2>
        <p>${detail}</p>
      </div>
      <div class="word-reveal"><span>Le mot était · ${esc(R.category)}</span><b>${esc(R.word)}</b></div>
      <ul class="players scoreboard">${ranking.map((p, i) => `
        <li class="player">
          <span class="pos">${i + 1}</span>${avatar(p)}
          <span class="name">${esc(p.name)}${p.id === pid ? '<small>toi</small>' : ''}</span>
          ${roleTag(R.roles[p.id])}
          <span class="delta">${delta(p)}</span>
          <span class="score">${p.score}</span>
        </li>`).join('')}
      </ul>
      <div class="result-actions">
        <button class="btn ghost full" id="exportBtn">
          <svg viewBox="0 0 24 24"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>Enregistrer le dessin
        </button>
        <button class="btn ghost ${host ? '' : 'full'}" id="seeDrawing">Voir le dessin</button>
        ${host ? '<button class="btn primary" id="againBtn">Rejouer</button><button class="btn ghost full sm" id="lobbyBtn">Retour au salon</button>'
               : ''}
      </div>
      ${host ? '' : '<p class="hint">En attente de l\'hôte pour la manche suivante…</p>'}
    `;
    $('#seeDrawing').onclick = () => { resultsHidden = true; renderResults(); };
    $('#exportBtn').onclick = exportDrawing;
    if (host) {
      $('#againBtn').onclick = () => socket.emit('start', (res) => { if (res && res.error) toast(res.error); });
      $('#lobbyBtn').onclick = () => socket.emit('toLobby');
    }
  }
  $('#reopenResults').onclick = () => { resultsHidden = false; renderResults(); };
  function verdictOf(R) {
    if (R.winner === 'bouffon') return ['🃏', 'Le Bouffon gagne !', 'imp'];
    if (R.winner === 'imposters') return ['🕵️', R.imposterIds.length > 1 ? "Les imposteurs l'emportent" : "L'imposteur l'emporte", 'imp'];
    return ['🎨', 'Les artistes gagnent', ''];
  }

  function renderScorebar() {
    const ranking = S.players.slice().sort((a, b) => b.score - a.score);
    const top = ranking[0] && ranking[0].score;
    const leaders = ranking.filter((p) => p.score === top).length;
    $('#scorebar').innerHTML = ranking.map((p) => `
      <span class="sb-item ${p.id === pid ? 'me' : ''} ${p.connected ? '' : 'off'}">
        ${top > 0 && leaders === 1 && p.score === top ? '<span class="crown">👑</span>' : ''}
        <span class="sb-dot" style="background:${p.color}"></span>
        <span class="sb-name">${esc(p.name)}</span><b>${p.score}</b>
      </span>`).join('');
  }

  function renderVote() {
    const show = S.phase === 'voting';
    $('#voteOv').classList.toggle('show', show && !voteHidden);
    $('#reopenVote').classList.toggle('show', show && voteHidden);
    if (!show || voteHidden) return;
    const voters = S.players.filter((p) => p.connected);
    $('#voteMeta').textContent = `${voters.filter((p) => p.voted).length} / ${voters.length} votes`
      + (S.myVote ? ' · tu peux encore changer' : '');
    $('#voteGrid').innerHTML = S.order.map((id) => {
      const p = player(id); if (!p) return '';
      const self = id === pid;
      const safe = S.excluded.includes(id);
      return `<li><button class="vote-card ${S.myVote === id ? 'picked' : ''} ${p.connected ? '' : 'off'}" data-vote="${esc(id)}" ${self || safe ? 'disabled' : ''}>
        ${avatar(p)}<span class="vc-name">${esc(p.name)}</span>
        <small>${safe ? '🛡️ Gardien' : self ? 'toi' : S.myVote === id ? 'ton vote' : p.voted ? 'a voté' : '&nbsp;'}</small>
      </button></li>`;
    }).join('');
    $$('#voteGrid [data-vote]').forEach((b) => b.onclick = () => socket.emit('vote', b.dataset.vote));
    const g = player(S.gardienId);
    $('#voteNotice').innerHTML = g ? `<p class="notice">🛡️ ${esc(g.name)} était le Gardien : vote annulé, revotez !</p>` : '';
    $('#voteExtra').innerHTML = inspectBlock();
    bindInspect();
    drawThumb();
  }
  function drawThumb() {
    const c = $('#voteThumb');
    const w = Math.round(c.clientWidth * Math.min(window.devicePixelRatio || 1, 2));
    if (!w) return;
    c.width = w; c.height = Math.round(w * ASPECT);
    const t = c.getContext('2d');
    for (const st of strokes) strokePath(t, st.points, st.color);
    t.globalAlpha = 1;
  }
  $('#hideVote').onclick = () => { voteHidden = true; renderVote(); };
  $('#reopenVote').onclick = () => { voteHidden = false; renderVote(); };

  function renderJudge() {
    const P = S.pending;
    const isJudge = S.phase === 'validate' && P.judgeId === pid;
    const isImp = S.phase === 'validate' && S.accusedId === pid;
    $('#judgeOv').classList.toggle('show', isJudge || isImp);
    if (!isJudge && !isImp) return;
    const imp = player(S.accusedId);
    const judge = player(P.judgeId);
    if (isJudge) {
      $('#judgeBox').innerHTML = `
        <span class="eyebrow">Tu es l'arbitre</span>
        <h2>« ${esc(P.guess)} »</h2>
        <p class="muted">${esc(imp ? imp.name : "L'imposteur")} propose ce mot. Est-ce assez proche du mot secret ?</p>
        <div class="word-reveal"><span>Le mot secret</span><b>${esc(S.role.word)}</b></div>
        <p class="auto ${P.auto ? 'good' : 'bad'}">${P.auto ? '✓ Très proche, ça devrait passer' : '✗ Assez différent du mot secret'}</p>
        <div class="result-actions">
          <button class="btn ghost" id="judgeNo">Refuser</button>
          <button class="btn primary" id="judgeYes">Accepter</button>
        </div>`;
      $('#judgeNo').onclick = () => socket.emit('judge', false);
      $('#judgeYes').onclick = () => socket.emit('judge', true);
    } else {
      $('#judgeBox').innerHTML = `
        <span class="eyebrow">Mot proposé</span>
        <h2>« ${esc(P.guess)} »</h2>
        <p class="muted">${esc(judge ? judge.name : "L'arbitre")} vérifie si ton mot est assez proche du mot secret…</p>
        <div class="spinner" aria-hidden="true"></div>`;
    }
  }

  const normWord = (w) => w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  /* ---------- export du dessin ---------- */
  function exportDrawing() {
    const W = 1200, H = Math.round(W * ASPECT), PAD = 56;
    const R = S.result;
    const art = document.createElement('canvas');
    art.width = W; art.height = H;
    const a = art.getContext('2d');
    for (const st of strokes) strokePath(a, st.points, st.color);

    // Légende : un point de couleur par artiste, sur plusieurs lignes si besoin.
    const out = document.createElement('canvas');
    const c = out.getContext('2d');
    const legendFont = '600 26px Inter, system-ui, sans-serif';
    c.font = legendFont;
    const rows = [[]];
    let x = 0;
    for (const id of S.order) {
      const p = player(id); if (!p) continue;
      const w = 30 + c.measureText(p.name).width + 28;
      if (x + w > W && rows[rows.length - 1].length) { rows.push([]); x = 0; }
      rows[rows.length - 1].push({ p, x });
      x += w;
    }
    const FOOT = 110 + rows.length * 40 + 50;
    out.width = W + PAD * 2; out.height = H + PAD * 2 + FOOT;

    c.fillStyle = '#fbf8f1';
    c.fillRect(0, 0, out.width, out.height);
    c.fillStyle = 'rgba(0, 0, 0, .07)';
    for (let gx = PAD + 13; gx < PAD + W; gx += 26) for (let gy = PAD + 13; gy < PAD + H; gy += 26) {
      c.beginPath(); c.arc(gx, gy, 1.6, 0, Math.PI * 2); c.fill();
    }
    c.drawImage(art, PAD, PAD);
    c.strokeStyle = 'rgba(0, 0, 0, .1)'; c.lineWidth = 2;
    c.strokeRect(PAD, PAD, W, H);

    let y = PAD + H + 84;
    c.fillStyle = '#1a1a1f';
    c.font = '800 60px "Bricolage Grotesque", Inter, sans-serif';
    c.fillText(R ? R.word : 'Gribouille', PAD, y);
    c.font = legendFont;
    y += 22;
    for (const row of rows) {
      y += 40;
      for (const { p, x: lx } of row) {
        c.fillStyle = p.color;
        c.beginPath(); c.arc(PAD + lx + 11, y - 9, 11, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#3a3830';
        c.fillText(p.name, PAD + lx + 30, y);
      }
    }
    c.fillStyle = '#8a8578';
    c.font = '500 24px Inter, system-ui, sans-serif';
    const date = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    c.fillText(`Gribouille · ${R ? R.category + ' · ' : ''}${date}`, PAD, y + 52);

    // Conversion synchrone : le partage doit partir dans la foulée du clic (Safari).
    const bin = atob(out.toDataURL('image/png').split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    const slug = normWord(R ? R.word : 'dessin').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const name = `gribouille-${slug || 'dessin'}.png`;
    const download = () => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = name;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      toast('Dessin téléchargé');
    };
    const file = new File([blob], name, { type: 'image/png' });
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Mon Gribouille' }).catch((e) => { if (e.name !== 'AbortError') download(); });
    } else download();
  }

  function renderGame() {
    $('#gCode').textContent = S.code;
    $('#gPhase').textContent = phaseLabel();
    renderScorebar();
    renderRoleChip();
    renderStatus();
    renderSide();
    renderReveal();
    renderGuess();
    renderVote();
    renderJudge();
    renderResults();
    resizeBoard();
  }

  function render() {
    const screen = !S ? 'home' : S.phase === 'lobby' ? 'lobby' : 'game';
    $$('.screen').forEach((el) => el.classList.toggle('active', el.id === screen));
    if (screen === 'lobby') renderLobby();
    if (screen === 'game') renderGame();
    if (screen !== 'game') {
      $$('#game .overlay, #game .fab').forEach((o) => o.classList.remove('show'));
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
    const h = Math.round(w * ASPECT);
    if (w !== board.width || h !== board.height) { board.width = w; board.height = h; }
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
    const sx = c.canvas.width / GRID, sy = c.canvas.height / GRID;
    const lw = c.canvas.width * 0.012;
    c.globalAlpha = alpha;
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = lw;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    if (n === 1) {
      c.arc(pts[0] * sx, pts[1] * sy, lw / 2, 0, Math.PI * 2);
      c.fill();
      return;
    }
    c.moveTo(pts[0] * sx, pts[1] * sy);
    for (let i = 1; i < n - 1; i++) {
      const x = pts[i * 2] * sx, y = pts[i * 2 + 1] * sy;
      const nx = pts[i * 2 + 2] * sx, ny = pts[i * 2 + 3] * sy;
      c.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    c.lineTo(pts[(n - 1) * 2] * sx, pts[(n - 1) * 2 + 1] * sy);
    c.stroke();
  }

  function drawBoard() {
    drawQueued = false;
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, board.width, board.height);
    if (!S || S.phase === 'lobby' || blind()) return;
    if (layer.width !== board.width || layer.height !== board.height) { layer.width = board.width; layer.height = board.height; layerDirty = true; }
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
