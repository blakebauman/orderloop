/** The periods the Performance page offers, in days; shared by its loader and its control. */
export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];
export const toRange = (v: string | null): Range => RANGES.find((r) => String(r) === v) ?? 30;
