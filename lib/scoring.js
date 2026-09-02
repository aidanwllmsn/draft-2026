/* The Front Office — pure scoring math.
 *
 * Nothing in here touches the DOM or any global app state. Every function takes
 * plain data and returns plain data, which is what makes it testable. The app
 * keeps thin wrappers in index.html that adapt its own objects to these shapes.
 *
 * Normalized player: { id, pos, proj, value, age?, name? }
 *   pos is one of QB RB WR TE K DST.
 *
 * Loads as a classic script in the browser (window.Scoring) and as a CommonJS
 * module in Node, so the same code runs in the app and under `node --test`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Scoring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SLOT_ELIG = {
    QB:['QB'], RB:['RB'], WR:['WR'], TE:['TE'], K:['K'], DEF:['DST'], DST:['DST'],
    FLEX:['RB','WR','TE'], WRRB_FLEX:['RB','WR'], REC_FLEX:['WR','TE'],
    SUPER_FLEX:['QB','RB','WR','TE']
  };
  var DEFAULT_SLOTS = ['QB','RB','RB','WR','WR','WR','TE','FLEX','K','DEF'];

  /* Bench, IR and taxi entries are not lineup slots. */
  function startingSlots(rosterPositions) {
    var rp = rosterPositions && rosterPositions.length ? rosterPositions : DEFAULT_SLOTS;
    var s = rp.filter(function (x) { return SLOT_ELIG[x] && SLOT_ELIG[x].length; });
    return s.length ? s : DEFAULT_SLOTS;
  }

  /* Greedy lineup: the scarcest slots claim their best man first, so a FLEX
   * can't steal the only startable TE out from under the TE slot. */
  function bestLineup(players, rosterPositions) {
    var slots = startingSlots(rosterPositions);
    var order = slots.map(function (s, i) { return { s: s, i: i }; })
      .sort(function (a, b) { return SLOT_ELIG[a.s].length - SLOT_ELIG[b.s].length; });
    var used = {}, filled = [];
    order.forEach(function (o) {
      var cand = players
        .filter(function (p) { return !used[p.id] && SLOT_ELIG[o.s].indexOf(p.pos) >= 0; })
        .sort(function (a, b) { return (b.proj || 0) - (a.proj || 0); })[0];
      if (cand) used[cand.id] = true;
      filled.push({ slot: o.s, idx: o.i, player: cand || null });
    });
    filled.sort(function (a, b) { return a.idx - b.idx; });
    var total = filled.reduce(function (t, x) { return t + ((x.player && x.player.proj) || 0); }, 0);
    return { slots: filled, total: round2(total) };
  }

  /* Positional surplus. Negative means short of startable bodies; 1.5+ means
   * genuinely spare. FLEX demand is spread across RB/WR/TE. */
  function needs(players, rosterPositions) {
    var rp = rosterPositions && rosterPositions.length ? rosterPositions : DEFAULT_SLOTS;
    var req = { QB:0, RB:0, WR:0, TE:0, FLEX:0, K:0, DST:0 };
    rp.forEach(function (s) {
      if (s === 'QB') req.QB++;
      else if (s === 'RB') req.RB++;
      else if (s === 'WR') req.WR++;
      else if (s === 'TE') req.TE++;
      else if (s === 'FLEX' || s === 'WRRB_FLEX' || s === 'WRRB' || s === 'REC_FLEX' || s === 'SUPER_FLEX') req.FLEX++;
      else if (s === 'K') req.K++;
      else if (s === 'DEF' || s === 'DST') req.DST++;
    });
    var have = { QB:0, RB:0, WR:0, TE:0, K:0, DST:0 };
    players.forEach(function (p) { if (have[p.pos] !== undefined) have[p.pos]++; });
    var surplus = {};
    ['QB','RB','WR','TE'].forEach(function (pos) {
      var flexShare = (pos === 'RB' || pos === 'WR' || pos === 'TE') ? req.FLEX / 3 : 0;
      surplus[pos] = round1(have[pos] - (req[pos] + flexShare + 1.5));
    });
    return { req: req, have: have, surplus: surplus };
  }

  /* Trade value. Redraft keys off overall board rank; dynasty off dynasty rank,
   * falling back to ADP for players with no dynasty ranking. */
  function playerValue(o) {
    if (o.dynasty) {
      if (o.dynRank > 0) return Math.round(10000 * Math.exp(-0.024 * (o.dynRank - 1)));
      return o.onBoard ? Math.max(60, Math.round(1400 - 4 * o.adp)) : 40;
    }
    if (o.onBoard) return Math.max(60, Math.round(9000 * Math.exp(-0.028 * (o.rank - 1))));
    return 40;
  }

  /* One team's read on a deal. Positive score = good for THIS team.
   * `roster` is that team's players before the trade. */
  function sideScore(o) {
    var roster = o.roster || [], gives = o.gives || [], gets = o.gets || [];
    var rp = o.rosterPositions;
    var vOut = sum(gives, 'value'), vIn = sum(gets, 'value');
    var pct = vOut ? Math.round(100 * (vIn - vOut) / vOut) : (vIn ? 120 : 0);

    var n = needs(roster, rp), fit = 0, notes = [];
    gets.forEach(function (p) {
      var sp = n.surplus[p.pos];
      if (sp === undefined) return;
      if (sp < 0) { fit += 1; notes.push('fills a hole at ' + p.pos); }
      else if (sp >= 1.5) { fit -= 0.5; notes.push('piles onto an existing ' + p.pos + ' surplus'); }
    });
    gives.forEach(function (p) {
      var sp = n.surplus[p.pos];
      if (sp === undefined) return;
      if (sp >= 1.5) { fit += 1; notes.push('sells from ' + p.pos + ' depth'); }
      else if (sp < 0) { fit -= 1.5; notes.push('thins ' + p.pos + ', already short'); }
    });

    var gone = {};
    gives.forEach(function (p) { gone[p.id] = true; });
    var after = roster.filter(function (p) { return !gone[p.id]; }).concat(gets);
    var beforeTotal = bestLineup(roster, rp).total;
    var afterTotal = bestLineup(after, rp).total;
    var lu = round2(afterTotal - beforeTotal);

    var age = null;
    if (o.dynasty && gives.length && gets.length) {
      age = round1(avgAge(gives) - avgAge(gets));   // positive = this side gets younger
    }
    return {
      vOut: vOut, vIn: vIn, pct: pct, fit: fit, notes: dedupe(notes),
      lu: lu, before: beforeTotal, after: afterTotal, age: age,
      score: Math.round(pct + fit * 8 + lu * 2.5)
    };
  }

  /* `themScore` is the OTHER manager's read. High means they win the deal,
   * which means you overpaid — getting this backwards mislabels every package. */
  function packageTag(themScore) {
    if (themScore >= 18) return ['rich', 'you are overpaying — instant yes'];
    if (themScore >= 0) return ['fair', 'clean two-way deal'];
    return ['light', 'a bargain for you — expect pushback'];
  }

  /* A fix that leaves either manager underwater is not a fix, and neither is a
   * gross overpay. Fall back to the best of a bad lot only if nothing lands. */
  function chooseFixes(cands, baseWorst, limit) {
    var max = limit || 3;
    var improved = cands
      .filter(function (c) { return c.worst > baseWorst + 1; })
      .sort(function (a, b) { return b.worst - a.worst; });
    var landable = improved.filter(function (c) {
      return c.worst >= -8 && Math.max(c.me.score, c.them.score) <= 45;
    });
    return (landable.length ? landable : improved.slice(0, 2)).slice(0, max);
  }

  /* Three offers that differ in kind, not by one bench player.
   * Each entry: { ids: string[], me: {score, vOut}, them: {score} }. */
  function choosePackages(scored) {
    var key = function (s) { return (s.ids || []).slice().sort().join('|'); };
    var seen = {}, picks = [];
    var take = function (s, label) {
      if (!s || seen[key(s)]) return;
      seen[key(s)] = true;
      picks.push(Object.assign({}, s, { label: label }));
    };
    take(scored.slice().sort(function (a, b) { return b.me.score - a.me.score; })[0], 'Best for you');
    take(scored.slice().filter(function (s) { return s.them.score >= -2; })
               .sort(function (a, b) { return a.me.vOut - b.me.vOut; })[0], 'Cheapest that works');
    take(scored.slice().filter(function (s) { return s.me.score >= 0; })
               .sort(function (a, b) { return b.them.score - a.them.score; })[0], 'Most likely accepted');
    return picks;
  }

  /* Odds a player is still on the board at `pick`. */
  function survivalOdds(adp, pick, teams) {
    if (pick == null) return 1;
    var spread = Math.max(7, (teams || 12) * 0.85);
    var z = (adp - pick) / spread;
    return Math.max(0.02, Math.min(0.98, 0.5 + z * 0.5));
  }

  function sum(a, k) { return a.reduce(function (t, x) { return t + (x[k] || 0); }, 0); }
  function avgAge(a) { return a.reduce(function (t, p) { return t + (p.age || 26); }, 0) / a.length; }
  function dedupe(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
  function round1(n) { return Math.round(n * 10) / 10; }
  function round2(n) { return Math.round(n * 100) / 100; }

  return {
    SLOT_ELIG: SLOT_ELIG, DEFAULT_SLOTS: DEFAULT_SLOTS,
    startingSlots: startingSlots, bestLineup: bestLineup, needs: needs,
    playerValue: playerValue, sideScore: sideScore, packageTag: packageTag,
    chooseFixes: chooseFixes, choosePackages: choosePackages, survivalOdds: survivalOdds
  };
});
