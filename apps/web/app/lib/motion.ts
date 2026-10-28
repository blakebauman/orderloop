/**
 * The motion tokens in app.css (`--motion-*`, `--ease-*`), for animations run from script (the Web
 * Animations API). tests/motion.test.ts keeps the two in step.
 */
export const MOTION = { instant: 100, move: 180, travel: 240 } as const;
export const EASE = {
  arrive: 'cubic-bezier(0.16, 1, 0.3, 1)',
  leave: 'cubic-bezier(0.4, 0, 1, 1)',
} as const;
