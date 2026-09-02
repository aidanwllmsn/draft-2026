const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/scoring.js');

/* helper: a normalized player */
let seq = 0;
const P = (pos, proj, value, age) => ({ id: 'p' + (++seq), pos, proj, value: value ?? 1000, age: age ?? 26 });
const STD = ['QB','RB','RB','WR','WR','WR','TE','FLEX','K','DEF','BN','BN','BN'];

test('startingSlots drops bench and taxi entries', () => {
  assert.deepStrictEqual(S.startingSlots(['QB','RB','FLEX','BN','IR','TAXI']), ['QB','RB','FLEX']);
});
test('startingSlots falls back to a standard lineup when given nothing useful', () => {
  assert.deepStrictEqual(S.startingSlots(['BN','BN']), S.DEFAULT_SLOTS);
  assert.deepStrictEqual(S.startingSlots([]), S.DEFAULT_SLOTS);
});

test('bestLineup fills every slot with the highest projection available', () => {
  const qb = P('QB', 20), rb1 = P('RB', 15), rb2 = P('RB', 10), rb3 = P('RB', 5);
  const l = S.bestLineup([qb, rb3, rb1, rb2], ['QB','RB','RB']);
  assert.deepStrictEqual(l.slots.map(s => s.player.proj), [20, 15, 10]);
  assert.strictEqual(l.total, 45);
});

test('a scarce slot claims its player before FLEX can take him', () => {
  // One TE on the roster. FLEX is listed first, but TE must still be filled.
  const te = P('TE', 14), wr = P('WR', 12);
  const l = S.bestLineup([te, wr], ['FLEX','TE']);
  const bySlot = Object.fromEntries(l.slots.map(s => [s.slot, s.player && s.player.pos]));
  assert.strictEqual(bySlot.TE, 'TE', 'TE slot must get the only tight end');
  assert.strictEqual(bySlot.FLEX, 'WR');
});

test('FLEX takes the best leftover across RB/WR/TE', () => {
  const l = S.bestLineup([P('RB',20), P('RB',18), P('WR',9)], ['RB','FLEX']);
  assert.strictEqual(l.slots.find(s => s.slot === 'FLEX').player.proj, 18);
});

test('SUPER_FLEX can start a quarterback', () => {
  const l = S.bestLineup([P('QB',25), P('QB',22), P('RB',10)], ['QB','SUPER_FLEX']);
  assert.deepStrictEqual(l.slots.map(s => s.player.pos), ['QB','QB']);
});

test('an unfillable slot is left empty rather than throwing', () => {
  const l = S.bestLineup([P('RB', 10)], ['QB','RB']);
  assert.strictEqual(l.slots[0].player, null);
  assert.strictEqual(l.total, 10);
});

test('no player is started in two slots at once', () => {
  const only = P('WR', 30);
  const l = S.bestLineup([only], ['WR','WR','FLEX']);
  const started = l.slots.filter(s => s.player).map(s => s.player.id);
  assert.strictEqual(started.length, new Set(started).size);
  assert.strictEqual(l.total, 30);
});

test('needs: surplus is negative when short and positive when deep', () => {
  const thin = S.needs([P('RB',10), P('WR',10), P('WR',10)], STD);
  assert.ok(thin.surplus.RB < 0, 'one RB against two RB slots is thin');
  const deep = S.needs(Array.from({length: 8}, () => P('RB', 10)), STD);
  assert.ok(deep.surplus.RB >= 1.5, 'eight RBs is a genuine surplus');
});

test('needs counts FLEX demand once, spread across RB/WR/TE', () => {
  const n = S.needs([], ['QB','RB','WR','TE','FLEX']);
  assert.strictEqual(n.req.FLEX, 1);
  assert.strictEqual(n.req.RB, 1);
});

test('playerValue decreases monotonically with rank', () => {
  const v = [1, 5, 20, 60].map(rank => S.playerValue({ rank, onBoard: true }));
  for (let i = 1; i < v.length; i++) assert.ok(v[i] < v[i-1], `rank ${i} should be worth less`);
});
test('playerValue never returns a negative or zero price', () => {
  assert.ok(S.playerValue({ rank: 500, onBoard: true }) >= 60);
  assert.ok(S.playerValue({ onBoard: false }) > 0);
  assert.ok(S.playerValue({ dynasty: true, adp: 400, onBoard: true }) >= 60);
});
test('dynasty valuation uses dynasty rank, not board rank', () => {
  const redraft = S.playerValue({ rank: 1, onBoard: true });
  const dyn = S.playerValue({ dynasty: true, dynRank: 1, onBoard: true });
  assert.notStrictEqual(redraft, dyn);
  assert.ok(S.playerValue({ dynasty: true, dynRank: 1 }) > S.playerValue({ dynasty: true, dynRank: 30 }));
});

/* ---- sideScore ---- */
const roster = () => [
  P('QB', 20, 3000), P('RB', 15, 6000), P('RB', 8, 1500), P('WR', 16, 7000),
  P('WR', 12, 4000), P('WR', 9, 1200), P('TE', 11, 2000), P('K', 0, 60), P('DST', 0, 60)
];

test('a strictly better player for a worse one scores positive', () => {
  const r = roster();
  const give = r[2];                       // the 8-proj RB2
  const get = P('RB', 18, 6500);
  const s = S.sideScore({ roster: r, gives: [give], gets: [get], rosterPositions: STD });
  assert.ok(s.score > 0, 'upgrading a starter should score positive');
  assert.ok(s.lu > 0, 'lineup points should rise');
  assert.strictEqual(s.vIn - s.vOut, 6500 - 1500);
});

test('giving away your best player for scraps scores negative', () => {
  const r = roster();
  const s = S.sideScore({ roster: r, gives: [r[3]], gets: [P('WR', 2, 100)], rosterPositions: STD });
  assert.ok(s.score < 0);
  assert.ok(s.lu < 0);
});

test('the two sides of one trade disagree in sign', () => {
  const mine = roster(), theirs = roster();
  const give = mine[3], get = theirs[1];
  const me = S.sideScore({ roster: mine, gives: [give], gets: [get], rosterPositions: STD });
  const them = S.sideScore({ roster: theirs, gives: [get], gets: [give], rosterPositions: STD });
  assert.ok(Math.sign(me.pct) !== Math.sign(them.pct) || me.pct === 0,
    'a value edge for one side is a deficit for the other');
});

test('lineup impact ignores players who never crack the lineup', () => {
  const r = roster();
  const benchWarmer = P('WR', 1, 50);
  const s = S.sideScore({ roster: r.concat(benchWarmer), gives: [benchWarmer], gets: [P('WR', 1, 50)], rosterPositions: STD });
  assert.strictEqual(s.lu, 0);
});

test('roster fit rewards selling from depth to fill a hole', () => {
  // No RBs, seven WRs: the classic trade-from-surplus shape.
  const lopsided = [P('QB',20,3000), P('TE',11,2000)]
    .concat(Array.from({length: 7}, (_, i) => P('WR', 16 - i, 7000 - i * 800)));
  const n = S.needs(lopsided, STD);
  assert.ok(n.surplus.RB < 0 && n.surplus.WR >= 1.5, 'fixture really is RB-poor and WR-rich');
  const s = S.sideScore({ roster: lopsided, gives: [lopsided[4]], gets: [P('RB',12,1200)], rosterPositions: STD });
  assert.ok(s.fit > 0, 'spending spare WR on a missing RB is a good fit');
});

test('robbing one thin position to fill another is not scored as a win', () => {
  // Three WRs for three WR slots plus a flex is already short, so shipping one
  // out to plug the RB hole should not read as good roster construction.
  const thin = [P('QB',20,3000), P('WR',16,7000), P('WR',12,4000), P('WR',9,1200), P('TE',11,2000)];
  const s = S.sideScore({ roster: thin, gives: [thin[3]], gets: [P('RB',12,1200)], rosterPositions: STD });
  assert.ok(s.fit <= 0, 'opening a new hole cancels out filling one');
});

test('dynasty age swing is reported, redraft leaves it null', () => {
  const r = roster();
  const young = S.sideScore({ roster: r, gives: [r[1]], gets: [P('RB',15,6000,22)], rosterPositions: STD, dynasty: true });
  assert.ok(young.age > 0, 'trading a 26-year-old for a 22-year-old gets you younger');
  assert.strictEqual(S.sideScore({ roster: r, gives: [r[1]], gets: [P('RB',15,6000,22)], rosterPositions: STD }).age, null);
});

test('an empty trade is inert, not a crash', () => {
  const s = S.sideScore({ roster: roster(), gives: [], gets: [], rosterPositions: STD });
  assert.strictEqual(s.score, 0);
  assert.strictEqual(s.lu, 0);
});

/* ---- regressions: both of these shipped as bugs ---- */
test('packageTag reads THEIR score: a happy counterparty means you overpaid', () => {
  assert.strictEqual(S.packageTag(40)[0], 'rich',  'they love it => you are overpaying');
  assert.strictEqual(S.packageTag(5)[0],  'fair');
  assert.strictEqual(S.packageTag(-6)[0], 'light', 'they barely accept => bargain for you');
});

test('chooseFixes never offers a fix that leaves a side underwater', () => {
  const mk = (m, t) => ({ me: { score: m }, them: { score: t }, worst: Math.min(m, t) });
  const cands = [mk(10, 3), mk(3, 0), mk(42, -23), mk(-21, 48)];
  const out = S.chooseFixes(cands, -30);
  assert.ok(out.length > 0);
  out.forEach(c => {
    assert.ok(c.worst >= -8, 'every offered fix must work for both managers');
    assert.ok(Math.max(c.me.score, c.them.score) <= 45, 'and must not be a gross overpay');
  });
});
test('chooseFixes still returns something when nothing lands cleanly', () => {
  const mk = (m, t) => ({ me: { score: m }, them: { score: t }, worst: Math.min(m, t) });
  const out = S.chooseFixes([mk(40, -20), mk(35, -25)], -60);
  assert.strictEqual(out.length, 2, 'fall back to the least-bad options rather than nothing');
});
test('chooseFixes rejects changes that do not improve on the current offer', () => {
  const mk = (m, t) => ({ me: { score: m }, them: { score: t }, worst: Math.min(m, t) });
  assert.strictEqual(S.chooseFixes([mk(0, 0)], 5).length, 0);
});

test('choosePackages returns distinct offers, never the same one twice', () => {
  const pk = (ids, meScore, vOut, themScore) =>
    ({ ids, me: { score: meScore, vOut }, them: { score: themScore } });
  const picks = S.choosePackages([
    pk(['a'], 30, 9000, -5), pk(['b','c'], 10, 6000, 4), pk(['d'], 5, 7000, 25)
  ]);
  const keys = picks.map(p => p.ids.join('|'));
  assert.strictEqual(keys.length, new Set(keys).size, 'no duplicate packages');
  assert.ok(picks.every(p => p.label), 'every package is labelled');
});

/* ---- survivalOdds ---- */
test('survivalOdds stays within bounds and rises with ADP', () => {
  assert.strictEqual(S.survivalOdds(50, null, 12), 1);
  const early = S.survivalOdds(5, 40, 12), late = S.survivalOdds(90, 40, 12);
  assert.ok(early < late, 'a later ADP is likelier to survive');
  [early, late, S.survivalOdds(500, 1, 12), S.survivalOdds(1, 500, 12)]
    .forEach(v => assert.ok(v >= 0.02 && v <= 0.98, 'odds stay clamped: ' + v));
});
