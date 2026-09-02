// Summary statistics and significance tests for the Find V2 results panel.
// =======================================================================
// Small-sample tests only, computed EXACTLY rather than by normal approximation. With five
// observations a cell, a z-test or a chi-square is not merely imprecise — it is answering a question
// about a limit that this data is nowhere near. Fisher's exact test and the exact Mann–Whitney U
// distribution are both cheap at these sizes, so there is no reason to approximate.
//
// Everything here is pure: it takes arrays and returns numbers, so the chart layer can be read on
// its own and these can be checked on their own.

(function () {
  /** Type-7 quantile (the linear-interpolation definition numpy and R use by default). */
  function quantile(sorted, p) {
    if (!sorted.length) return NaN;
    if (sorted.length === 1) return sorted[0];
    const h = (sorted.length - 1) * p;
    const lo = Math.floor(h);
    const hi = Math.ceil(h);
    return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
  }

  /** Tukey five-number summary plus the points themselves. */
  function boxStats(values) {
    const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!v.length) return null;
    const q1 = quantile(v, 0.25);
    const med = quantile(v, 0.5);
    const q3 = quantile(v, 0.75);
    const iqr = q3 - q1;
    const lowFence = q1 - 1.5 * iqr;
    const highFence = q3 + 1.5 * iqr;
    const inside = v.filter(x => x >= lowFence && x <= highFence);
    return {
      n: v.length,
      min: v[0],
      max: v[v.length - 1],
      q1,
      med,
      q3,
      whiskerLow: inside.length ? inside[0] : v[0],
      whiskerHigh: inside.length ? inside[inside.length - 1] : v[v.length - 1],
      outliers: v.filter(x => x < lowFence || x > highFence),
      points: v,
      mean: v.reduce((a, b) => a + b, 0) / v.length,
    };
  }

  /**
   * Wilson score interval for a proportion.
   *
   * Not the textbook normal interval: at n=5 that one produces bounds below 0 and above 1, and for
   * a cell where everyone was right it collapses to zero width — reporting perfect certainty from
   * five observations. Wilson stays inside [0,1] and keeps a sane width at the extremes, which is
   * exactly the regime this study is in.
   */
  function wilson(successes, n, z = 1.96) {
    if (!n) return { p: NaN, lo: NaN, hi: NaN, n: 0, k: 0 };
    const p = successes / n;
    const d = 1 + (z * z) / n;
    const centre = p + (z * z) / (2 * n);
    const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
    return { p, lo: Math.max(0, (centre - spread) / d), hi: Math.min(1, (centre + spread) / d), n, k: successes };
  }

  function logFactorial(n) {
    let out = 0;
    for (let i = 2; i <= n; i++) out += Math.log(i);
    return out;
  }

  /** Probability of one 2x2 table under the hypergeometric, in logs to stay exact at these sizes. */
  function hyperLogP(a, b, c, d) {
    const n = a + b + c + d;
    return logFactorial(a + b) + logFactorial(c + d) + logFactorial(a + c) + logFactorial(b + d)
      - logFactorial(n) - logFactorial(a) - logFactorial(b) - logFactorial(c) - logFactorial(d);
  }

  /**
   * Fisher's exact test, two-sided by the total-probability method: sum the probability of every
   * table no more likely than the observed one. That is the definition R uses, and it does not
   * assume symmetry the way "double the one-sided tail" does.
   */
  function fisherExact(a, b, c, d) {
    const rows = [a + b, c + d];
    const cols = [a + c, b + d];
    const n = a + b + c + d;
    if (!n || !rows[0] || !rows[1] || !cols[0] || !cols[1]) return { p: 1, n };
    const observed = hyperLogP(a, b, c, d);
    const lo = Math.max(0, cols[0] - rows[1]);
    const hi = Math.min(rows[0], cols[0]);
    let p = 0;
    for (let x = lo; x <= hi; x++) {
      const lp = hyperLogP(x, rows[0] - x, cols[0] - x, rows[1] - cols[0] + x);
      // 1e-7 of slack, because two tables of genuinely equal probability can differ in the last bits.
      if (lp <= observed + 1e-7) p += Math.exp(lp);
    }
    return { p: Math.min(1, p), n };
  }

  /**
   * Mann–Whitney U with an EXACT two-sided p, by counting rank-sum arrangements.
   *
   * The normal approximation needs roughly n>=8 a group before it means anything, and every cell
   * here has five. The exact null distribution of U is a small dynamic program, so it is computed
   * rather than approximated. Ties are handled by mid-ranks, which makes the p slightly
   * conservative — the honest direction to err at this size.
   */
  function mannWhitney(xs, ys) {
    const x = xs.filter(Number.isFinite);
    const y = ys.filter(Number.isFinite);
    const n1 = x.length;
    const n2 = y.length;
    if (!n1 || !n2) return { p: NaN, u: NaN, n1, n2 };

    const all = x.map(v => ({ v, g: 0 })).concat(y.map(v => ({ v, g: 1 })))
      .sort((a, b) => a.v - b.v);
    // Mid-ranks for ties.
    const ranks = new Array(all.length);
    for (let i = 0; i < all.length;) {
      let j = i;
      while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[k] = r;
      i = j + 1;
    }
    let r1 = 0;
    all.forEach((item, i) => { if (item.g === 0) r1 += ranks[i]; });
    const u1 = r1 - (n1 * (n1 + 1)) / 2;
    const u = Math.min(u1, n1 * n2 - u1);

    // Exact null: how many of the C(n1+n2, n1) splits give each U. counts[j][u].
    const maxU = n1 * n2;
    let dp = Array.from({ length: n1 + 1 }, () => new Float64Array(maxU + 1));
    dp[0][0] = 1;
    for (let i = 1; i <= n1 + n2; i++) {
      const next = Array.from({ length: n1 + 1 }, () => new Float64Array(maxU + 1));
      for (let k = 0; k <= Math.min(i, n1); k++) {
        for (let uu = 0; uu <= maxU; uu++) {
          const c = dp[k][uu];
          if (!c) continue;
          if (k + 1 <= n1) next[k + 1][uu] += c;             // this item joins group 1
          const add = k;                                      // ...or group 2, passing k of group 1
          if (uu + add <= maxU) next[k][uu + add] += c;
        }
      }
      dp = next;
    }
    const dist = dp[n1];
    let total = 0;
    for (let uu = 0; uu <= maxU; uu++) total += dist[uu];
    let tail = 0;
    for (let uu = 0; uu <= Math.floor(u); uu++) tail += dist[uu];
    return { p: Math.min(1, (2 * tail) / total), u, n1, n2 };
  }

  /** "p = 0.032" / "p < 0.001" / "—". */
  function fmtP(p) {
    if (!Number.isFinite(p)) return '—';
    if (p < 0.001) return 'p < 0.001';
    return `p = ${p.toFixed(3)}`;
  }

  window.FindV2Stats = { quantile, boxStats, wilson, fisherExact, mannWhitney, fmtP };
}());
