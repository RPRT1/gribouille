// Outils partagés par les deux jeux (Gribouille et Traître).
const COLORS = [
  '#E8453C', '#2F7DE1', '#F2A12E', '#2FAE66', '#8B5CF6',
  '#EC4899', '#0EA5B7', '#8A5A3B', '#475569', '#F97316'
];

const rand = (a) => a[Math.floor(Math.random() * a.length)];
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function makeCode(rooms) {
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
// Comparaison tolérante (« photographie » pour « Photographe ») : ce n'est qu'une
// suggestion, c'est l'arbitre qui tranche.
function isClose(guess, word) {
  const g = normalize(guess), w = normalize(word);
  if (!g) return false;
  if (g === w) return true;
  const short = Math.min(g.length, w.length);
  const tol = w.length >= 10 ? 3 : w.length >= 7 ? 2 : w.length >= 4 ? 1 : 0;
  if (lev(g, w) <= tol) return true;
  let pre = 0;
  while (pre < short && g[pre] === w[pre]) pre++;
  return pre >= 5 && pre >= short * 0.7;
}
module.exports = { COLORS, rand, shuffle, makeCode, cleanName, validPid, normalize, lev, isClose };
