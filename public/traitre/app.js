(() => {
  'use strict';

  const socket = io('/traitre', { transports: ['websocket', 'polling'], tryAllTransports: true });
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => n.toLocaleString('fr-FR');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
  };
  // Identité et partie propres à chaque onglet (survivent à un rechargement).
  const tab = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } }
  };

  const ROLES = {
    master: { emoji: '👑', name: 'Maître du jeu' },
    traitre: { emoji: '🗡️', name: 'Traître' },
    innocent: { emoji: '🙂', name: 'Innocent' }
  };
  const ANSWERS = { oui: 'Oui', non: 'Non', nsp: 'Je ne sais pas', found: 'Trouvé !' };

  let pid = tab.get('tr_pid');
  if (!pid) {
    pid = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
    tab.set('tr_pid', pid);
  }

  /* ---------- état ---------- */
  let S = null;
  let clockOffset = 0;     // heure serveur - heure locale
  let lastKey = '';
  let flipped = false;
  let wordMasked = false;
  let resultsHidden = false;
  let voteHidden = false;
  let lastQ = 0;

  const player = (id) => S && S.players.find((p) => p.id === id);
  const me = () => player(pid);
  const isHost = () => S && S.hostId === pid;
  const isMaster = () => S && S.masterId === pid;
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
    const code = tab.get('tr_room');
    if (code) {
      socket.emit('join', { code, pid, name: store.get('fa_name') || '' }, (res) => {
        if (res && res.error) { tab.del('tr_room'); S = null; render(); }
      });
    }
  });
  socket.on('disconnect', () => { if (S) toast('Connexion perdue… reconnexion en cours'); });

  socket.on('state', (s) => {
    S = s;
    clockOffset = s.now - Date.now();
    tab.set('tr_room', s.code);
    const key = `${s.round}:${s.phase}`;
    if (key !== lastKey) {
      const prevRound = lastKey.split(':')[0];
      lastKey = key;
      if (String(s.round) !== prevRound) { flipped = false; wordMasked = false; }
      if (s.phase !== 'results') resultsHidden = false;
      if (s.phase !== 'vote') voteHidden = false;
      if (s.phase !== 'questions') $('#finderOv').classList.remove('show');
      if (s.phase === 'vote' && navigator.vibrate) navigator.vibrate(60);
    }
    render();
  });

  socket.on('kicked', () => {
    tab.del('tr_room'); S = null; render();
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
    tab.del('tr_room');
    S = null; lastKey = '';
    history.replaceState(null, '', location.pathname);
    render();
  });

  /* ---------- salon ---------- */
  const shareUrl = () => `${location.origin}${location.pathname}?code=${S.code}`;
  $('#codeBig').onclick = $('#copyCode').onclick = () => copy(S.code, 'Code copié');
  $('#copyLink').onclick = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: 'Traître', text: `Rejoins ma partie de Traître ! Code : ${S.code}`, url: shareUrl() }); return; }
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
    if (S.players.length < 4) rows.push(`<li class="player slot">En attente de joueurs… partage le code !</li>`);
    $('#playerList').innerHTML = rows.join('');
    $$('[data-kick]').forEach((b) => b.onclick = () => socket.emit('kick', b.dataset.kick));

    const host = isHost();
    $('#settingsPanel').classList.toggle('locked', !host);
    $('#settingsNote').textContent = host ? '' : "Choisis par l'hôte";
    $('#timerSeg').innerHTML = [3, 5, 8].map((n) =>
      `<button class="${S.settings.timer === n ? 'on' : ''}" data-t="${n}">${n} min</button>`).join('');
    $$('#timerSeg button').forEach((b) => b.onclick = () => socket.emit('settings', { timer: +b.dataset.t }));
    const total = S.categories.reduce((n, c) => n + (S.wordCounts[c] || 0), 0);
    $('#catChips').innerHTML = ['mix', ...S.categories].map((c) =>
      `<button class="chip ${S.settings.category === c ? 'on' : ''}" data-c="${esc(c)}">${c === 'mix' ? '🎲 Aléatoire' : esc(c)}<small>${fmt(c === 'mix' ? total : S.wordCounts[c] || 0)}</small></button>`).join('');
    $$('#catChips .chip').forEach((b) => b.onclick = () => socket.emit('settings', { category: b.dataset.c }));

    const startBtn = $('#startBtn');
    startBtn.style.display = host ? '' : 'none';
    startBtn.disabled = on < 4;
    const hostP = player(S.hostId);
    $('#lobbyHint').textContent = host
      ? (on < 4 ? `Il faut au moins 4 joueurs connectés (${on}/4)` : `${on} joueurs prêts à enquêter`)
      : `En attente que ${hostP ? hostP.name : "l'hôte"} lance la partie…`;
  }

  /* ---------- jeu ---------- */
  function phaseLabel() {
    return { reveal: 'Préparation', questions: `Manche ${S.round}`, vote: 'Vote', results: 'Résultats' }[S.phase] || '';
  }

  function renderRoleChip() {
    const chip = $('#roleChip');
    const r = S.role;
    if (!r) { chip.style.display = 'none'; return; }
    chip.style.display = '';
    const eye = `<svg class="eye" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>${wordMasked ? '<path d="M3 3l18 18"/>' : ''}</svg>`;
    const info = ROLES[r.id];
    chip.className = 'role-chip' + (r.id === 'traitre' ? ' imp' : '') + (wordMasked ? ' masked' : '');
    chip.innerHTML = r.word
      ? `<span class="lbl">${info.emoji} ${esc(r.category)} ·</span><b>${esc(r.word)}</b>${eye}`
      : `<span class="lbl">${info.emoji} ${info.name} ·</span><b>${esc(r.category)}</b>${eye}`;
  }
  $('#roleChip').onclick = () => { wordMasked = !wordMasked; renderRoleChip(); };

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

  // Chrono : calculé localement à partir de l'échéance envoyée par le serveur.
  function remaining() {
    return S && S.deadline ? Math.max(0, S.deadline - (Date.now() + clockOffset)) : 0;
  }
  const mmss = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function tick() {
    if (!S || !S.deadline) return;
    const ms = remaining();
    const total = S.phase === 'vote' ? 90 * 1000 : S.settings.timer * 60 * 1000;
    $('#timer').textContent = mmss(ms);
    $('#timerBar').style.width = `${Math.min(100, (ms / total) * 100)}%`;
    $('#timerCard').classList.toggle('low', ms < 30 * 1000);
    $('#voteTimer').textContent = `⏱ ${mmss(ms)}`;
  }
  setInterval(tick, 250);

  function renderTimer() {
    const label = { reveal: 'Découvrez vos rôles', questions: 'Temps pour trouver le mot', vote: 'Temps pour voter', results: 'Manche terminée' }[S.phase];
    $('#timerLabel').textContent = label || '';
    if (!S.deadline) {
      $('#timer').textContent = S.phase === 'reveal' ? mmss(S.settings.timer * 60 * 1000) : '0:00';
      $('#timerBar').style.width = S.phase === 'reveal' ? '100%' : '0%';
      $('#timerCard').classList.remove('low');
    }
    tick();
  }

  function renderStatus() {
    const m = player(S.masterId);
    let html = '';
    if (S.phase === 'reveal') html = 'Découvrez vos rôles…';
    else if (S.phase === 'questions') {
      html = isMaster() ? 'Réponds aux questions par oui ou par non'
        : `Posez vos questions à <span class="dot" style="background:${m ? m.color : '#666'}"></span>${esc(m ? m.name : 'au Maître')}`;
    } else if (S.phase === 'vote') html = S.myVote ? 'Vote enregistré, tu peux encore changer' : 'Qui est le traître ?';
    else if (S.phase === 'results') html = verdictOf(S.result)[1];
    $('#status').innerHTML = html;
  }

  function renderFeed() {
    const feed = $('#feed');
    const qs = S.questions || [];
    const master = isMaster() && S.phase === 'questions';
    if (!qs.length) {
      feed.innerHTML = `<li class="feed-empty">${S.phase === 'questions'
        ? (isMaster() ? 'Les questions des joueurs apparaîtront ici.' : 'Aucune question pour l\'instant. Lance-toi !')
        : 'Les questions apparaîtront ici.'}</li>`;
    } else {
      feed.innerHTML = qs.map((q) => {
        const p = player(q.pid) || { name: '?', color: '#666' };
        const answer = q.a
          ? `<span class="ans ${q.a}">${ANSWERS[q.a]}</span>`
          : master
            ? `<span class="ans-btns">
                <button data-a="oui" data-q="${q.id}" class="ab oui">Oui</button>
                <button data-a="non" data-q="${q.id}" class="ab non">Non</button>
                <button data-a="nsp" data-q="${q.id}" class="ab nsp">?</button>
                <button data-a="found" data-q="${q.id}" class="ab found">🎯</button>
              </span>`
            : '<span class="ans wait">…</span>';
        return `<li class="q ${q.hint ? 'hint' : ''} ${q.a ? '' : 'pending'}">
          ${avatar(p)}
          <div class="q-body"><b>${esc(p.name)}${q.pid === pid ? ' <small>toi</small>' : ''}</b><span>${esc(q.text)}</span>
            ${q.hint ? '<em>Contient le mot secret !</em>' : ''}</div>
          ${answer}
        </li>`;
      }).join('');
    }
    feed.querySelectorAll('[data-a]').forEach((b) => b.onclick = () => {
      if (b.dataset.a === 'found' && !confirm('Valider : cette question a trouvé le mot ?')) return;
      socket.emit('answer', { id: +b.dataset.q, a: b.dataset.a });
    });
    const newest = qs.length ? qs[qs.length - 1].id : 0;
    if (newest !== lastQ) { lastQ = newest; feed.scrollTop = feed.scrollHeight; }

    const asking = S.phase === 'questions' && !isMaster();
    $('#askForm').style.display = asking ? '' : 'none';
    $('#foundBtn').style.display = S.phase === 'questions' && isMaster() ? '' : 'none';
  }
  $('#askForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#askInput').value.trim();
    if (!v) return;
    socket.emit('ask', v);
    $('#askInput').value = '';
  };

  function renderSide() {
    const voting = S.phase === 'vote';
    const res = S.phase === 'results' ? S.result : null;
    $('#sideTitle').textContent = 'Joueurs';
    const asked = (id) => (S.questions || []).filter((q) => q.pid === id).length;
    $('#sideMeta').textContent = voting
      ? `${S.players.filter((p) => p.connected && p.voted).length} / ${S.players.filter((p) => p.connected).length} votes`
      : `${(S.questions || []).length} question${(S.questions || []).length > 1 ? 's' : ''}`;
    $('#sideList').innerHTML = S.players.map((p) => {
      const tags = [];
      if (p.id === S.masterId) tags.push('<span class="tag host">👑 Maître</span>');
      if (res && p.id === res.traitreId) tags.push('<span class="tag bad">🗡️ Traître</span>');
      if (S.finderId === p.id) tags.push('<span class="tag good">🎯 a trouvé</span>');
      if (voting && p.voted) tags.push('<span class="tag good">a voté</span>');
      if (S.phase === 'reveal' && p.ready) tags.push('<span class="tag good">prêt</span>');
      return `<li class="player ${p.connected ? '' : 'off'}">
        ${avatar(p)}
        <span class="name">${esc(p.name)}${p.id === pid ? '<small>toi</small>' : ''}</span>
        ${tags.join('')}
        ${p.id !== S.masterId && S.phase !== 'reveal' ? `<span class="q-count" title="Questions posées">${asked(p.id)} ❓</span>` : ''}
      </li>`;
    }).join('');
  }

  function renderReveal() {
    const ov = $('#revealOv');
    const show = S.phase === 'reveal';
    ov.classList.toggle('show', show);
    if (!show) return;
    const r = S.role;
    const back = $('#roleBack');
    const m = player(S.masterId);
    if (r.id === 'traitre') {
      back.className = 'face back imp';
      back.innerHTML = `<div class="imp-icon">🗡️</div><span class="eyebrow">Tu es le Traître</span>
        <div class="secret-word">${esc(r.word)}</div><span class="cat">${esc(r.category)}</span>
        <p>Tu connais le mot. Aide discrètement les autres à le trouver… sans te faire démasquer !</p>`;
    } else if (r.id === 'master') {
      back.className = 'face back';
      back.innerHTML = `<span class="eyebrow">👑 Tu es le Maître du jeu</span>
        <div class="secret-word">${esc(r.word)}</div><span class="cat">${esc(r.category)}</span>
        <p>Réponds aux questions par oui ou par non, et valide quand quelqu'un trouve le mot.</p>`;
    } else {
      back.className = 'face back';
      back.innerHTML = `<span class="eyebrow">🙂 Tu es innocent</span>
        <div class="secret-word">???</div><span class="cat">${esc(r.category)}</span>
        <p>Pose des questions fermées à ${esc(m ? m.name : 'au Maître')} pour trouver le mot. Méfie-toi : un traître le connaît déjà.</p>`;
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

  // Le Maître désigne qui a trouvé le mot (quand on joue à voix haute).
  $('#foundBtn').onclick = () => {
    $('#finderGrid').innerHTML = S.players.filter((p) => p.id !== S.masterId).map((p) => `
      <li><button class="vote-card" data-finder="${esc(p.id)}">${avatar(p)}<span class="vc-name">${esc(p.name)}</span><small>&nbsp;</small></button></li>`).join('');
    $$('#finderGrid [data-finder]').forEach((b) => b.onclick = () => {
      socket.emit('found', b.dataset.finder);
      $('#finderOv').classList.remove('show');
    });
    $('#finderOv').classList.add('show');
  };
  $('#finderCancel').onclick = () => $('#finderOv').classList.remove('show');

  function renderVote() {
    const show = S.phase === 'vote';
    $('#voteOv').classList.toggle('show', show && !voteHidden);
    $('#reopenVote').classList.toggle('show', show && voteHidden);
    if (!show || voteHidden) return;
    const f = player(S.finderId);
    $('#voteWord').innerHTML = `<span>${esc(f ? f.name : '?')} a trouvé le mot</span><b>${esc(S.role.word || '')}</b>`;
    const voters = S.players.filter((p) => p.connected);
    $('#voteMeta').textContent = `${voters.filter((p) => p.voted).length} / ${voters.length} votes`
      + (S.myVote ? ' · tu peux encore changer' : '');
    $('#voteGrid').innerHTML = S.players.map((p) => {
      const self = p.id === pid;
      const master = p.id === S.masterId;
      return `<li><button class="vote-card ${S.myVote === p.id ? 'picked' : ''} ${p.connected ? '' : 'off'}" data-vote="${esc(p.id)}" ${self || master ? 'disabled' : ''}>
        ${avatar(p)}<span class="vc-name">${esc(p.name)}</span>
        <small>${master ? '👑 Maître' : self ? 'toi' : S.myVote === p.id ? 'ton vote' : p.id === S.finderId ? '🎯 a trouvé' : p.voted ? 'a voté' : '&nbsp;'}</small>
      </button></li>`;
    }).join('');
    $$('#voteGrid [data-vote]').forEach((b) => b.onclick = () => socket.emit('vote', b.dataset.vote));
    tick();
  }
  $('#hideVote').onclick = () => { voteHidden = true; renderVote(); };
  $('#reopenVote').onclick = () => { voteHidden = false; renderVote(); };

  function verdictOf(R) {
    if (R.winner === 'nobody') return ['⌛', 'Temps écoulé : tout le monde perd', 'imp'];
    if (R.winner === 'traitre') return ['🗡️', 'Le Traître l\'emporte', 'imp'];
    return ['🎉', 'Le Traître est démasqué', ''];
  }

  function renderResults() {
    const isRes = S.phase === 'results';
    $('#resultOv').classList.toggle('show', isRes && !resultsHidden);
    $('#reopenResults').classList.toggle('show', isRes && resultsHidden);
    if (!isRes) return;
    const R = S.result;
    const t = player(R.traitreId) || { name: '?' };
    const f = player(R.finderId);
    const acc = player(R.accusedId);
    let detail;
    if (!R.found) detail = `Personne n'a trouvé le mot à temps (${R.asked} question${R.asked > 1 ? 's' : ''} posée${R.asked > 1 ? 's' : ''}). ${esc(t.name)} était le traître.`;
    else if (R.winner === 'innocents') detail = `${esc(f ? f.name : '?')} a trouvé le mot, et vous avez démasqué ${esc(t.name)} !`;
    else if (R.tie) detail = `Égalité dans les votes : ${esc(t.name)}, le traître, s'en sort.`;
    else detail = `Vous avez accusé ${esc(acc ? acc.name : 'personne')} à tort. ${esc(t.name)} était le traître !`;
    const [badge, title, cls] = verdictOf(R);
    const ranking = S.players.slice().sort((a, b) => b.score - a.score);
    const host = isHost();
    $('#resultBox').innerHTML = `
      <div class="verdict ${cls}">
        <div class="badge">${badge}</div>
        <span class="eyebrow">${R.deltas[pid] ? 'Tu as gagné' : 'Tu as perdu'}</span>
        <h2>${title}</h2>
        <p>${detail}</p>
      </div>
      <div class="word-reveal"><span>Le mot était · ${esc(R.category)}</span><b>${esc(R.word)}</b></div>
      <ul class="players scoreboard">${ranking.map((p, i) => `
        <li class="player">
          <span class="pos">${i + 1}</span>${avatar(p)}
          <span class="name">${esc(p.name)}${p.id === pid ? '<small>toi</small>' : ''}</span>
          ${p.id === R.traitreId ? '<span class="tag bad">🗡️ traître</span>' : ''}
          ${p.id === R.masterId ? '<span class="tag host">👑 maître</span>' : ''}
          <span class="delta">${R.deltas[p.id] ? `+${R.deltas[p.id]}` : ''}</span>
          <span class="score">${p.score}</span>
        </li>`).join('')}
      </ul>
      <div class="result-actions">
        <button class="btn ghost ${host ? '' : 'full'}" id="seeFeed">Voir les questions</button>
        ${host ? '<button class="btn primary" id="againBtn">Manche suivante</button><button class="btn ghost full sm" id="lobbyBtn">Retour au salon</button>' : ''}
      </div>
      ${host ? '' : '<p class="hint">En attente de l\'hôte pour la manche suivante…</p>'}
    `;
    $('#seeFeed').onclick = () => { resultsHidden = true; renderResults(); };
    if (host) {
      $('#againBtn').onclick = () => socket.emit('start', (res) => { if (res && res.error) toast(res.error); });
      $('#lobbyBtn').onclick = () => socket.emit('toLobby');
    }
  }
  $('#reopenResults').onclick = () => { resultsHidden = false; renderResults(); };

  function renderGame() {
    $('#gCode').textContent = S.code;
    $('#gPhase').textContent = phaseLabel();
    renderScorebar();
    renderRoleChip();
    renderTimer();
    renderStatus();
    renderFeed();
    renderSide();
    renderReveal();
    renderVote();
    renderResults();
  }

  function render() {
    const screen = !S ? 'home' : S.phase === 'lobby' ? 'lobby' : 'game';
    $$('.screen').forEach((el) => el.classList.toggle('active', el.id === screen));
    if (screen === 'lobby') renderLobby();
    if (screen === 'game') renderGame();
    if (screen !== 'game') $$('#game .overlay, #game .fab').forEach((o) => o.classList.remove('show'));
    document.title = S && S.phase === 'questions' && isMaster() ? '👑 Maître — Traître' : 'Traître';
  }

  render();
})();
