/**
 * The page's two moments. Both start from the finished state the HTML already shows, so a reader
 * without script, or with reduced motion, sees everything.
 */
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Moves the token along an edge, start to end, over `ms`. */
function ride(token: SVGCircleElement, edge: SVGPathElement, ms: number) {
  const length = edge.getTotalLength();
  return new Promise<void>((done) => {
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - t) ** 2;
      const p = edge.getPointAtLength(eased * length);
      token.setAttribute('cx', String(p.x));
      token.setAttribute('cy', String(p.y));
      if (t < 1) requestAnimationFrame(frame);
      else done();
    };
    requestAnimationFrame(frame);
  });
}

/**
 * Replays the hero's run once: a token rides the run's edges, lighting each step as it arrives;
 * waits hold a beat longer. Long edges (a line's carriage return) take longer to ride.
 */
export function replayPlate() {
  if (still()) return;
  for (const svg of document.querySelectorAll<SVGSVGElement>('svg.plate')) {
    if (!svg.getClientRects().length) continue;
    const token = svg.querySelector<SVGCircleElement>('.token');
    const at = (step: number) => [...svg.querySelectorAll(`.n[data-step="${step}"]`)];
    const edge = (step: number) =>
      svg.querySelector<SVGPathElement>(`.e.run[data-step="${step}"]`) ?? undefined;
    const last = Math.max(
      ...[...svg.querySelectorAll('.n[data-step]')].map((n) => Number(n.getAttribute('data-step'))),
    );
    svg.classList.add('replaying');
    void (async () => {
      await wait(350);
      svg.classList.add('riding');
      for (let step = 0; step <= last; step++) {
        for (const n of at(step)) n.classList.add('lit');
        if (at(step).some((n) => n.querySelector('.mark.wait'))) await wait(420);
        const e = edge(step);
        if (!e || !token) continue;
        e.classList.add('lit');
        await ride(token, e, Math.min(520, 110 + e.getTotalLength() * 0.35));
      }
      await wait(500);
      svg.classList.remove('replaying', 'riding');
    })();
  }
}

/** Holds the rollback until the capture row is on screen, so the reader sees it run. */
export function holdRollback() {
  const ledger = document.querySelector<HTMLElement>('.ledger');
  const row = ledger?.querySelector('[data-row="capture"]');
  if (!ledger || !row || still() || !('IntersectionObserver' in window)) return;
  if (row.getBoundingClientRect().top < innerHeight) return;
  ledger.classList.add('pre-roll');
  const seen = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      ledger.classList.remove('pre-roll');
      seen.disconnect();
    },
    { threshold: 0.6 },
  );
  seen.observe(row);
}
