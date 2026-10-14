import { describe, expect, it } from 'vitest';
import {
  answerConfidence,
  assessBranch,
  assessOutputs,
  assessQuestionsSchema,
  clampAnswers,
  describeAnswers,
  nodeOutputs,
  validateConfig,
} from '../src';

const questions = assessQuestionsSchema.parse({
  route: {
    type: 'choice',
    instructions: 'How should this order be handled?',
    criteria: { approve: 'Routine', review: 'Unusual', ask: null },
  },
  urgent: { type: 'noul', instructions: 'Is it urgent?' },
  damage: { type: 'score', instructions: 'How damaged?', criteria: ['None', 'Minor', 'Major'] },
});

describe('assess questions', () => {
  it('accepts the three Clef question types', () => {
    expect(Object.keys(questions)).toEqual(['route', 'urgent', 'damage']);
  });

  it('holds questions to Clef’s limits', () => {
    const q = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'x' }]),
      );
    expect(assessQuestionsSchema.safeParse(q(64)).success).toBe(true);
    expect(assessQuestionsSchema.safeParse(q(65)).success).toBe(false);
    expect(assessQuestionsSchema.safeParse({}).success).toBe(false);
    expect(
      assessQuestionsSchema.safeParse({ 'bad id': { type: 'noul', instructions: 'x' } }).success,
    ).toBe(false);
    expect(
      assessQuestionsSchema.safeParse({
        s: { type: 'score', instructions: 'x', criteria: ['only one'] },
      }).success,
    ).toBe(false);
    expect(
      assessQuestionsSchema.safeParse({
        s: { type: 'score', instructions: 'x', criteria: Array(11).fill('l') },
      }).success,
    ).toBe(false);
    expect(
      assessQuestionsSchema.safeParse({
        c: { type: 'choice', instructions: 'x', criteria: { one: null } },
      }).success,
    ).toBe(false);
    expect(
      assessQuestionsSchema.safeParse({ n: { type: 'noul', instructions: ' ' } }).success,
    ).toBe(false);
  });
});

describe('assess outputs and branches', () => {
  it('branches on a choice’s options, yes/no for noul, and not on a score', () => {
    expect(assessOutputs(questions, 'route', 0)).toEqual(['approve', 'review', 'ask']);
    expect(assessOutputs(questions, 'urgent', 0)).toEqual(['yes', 'no']);
    expect(assessOutputs(questions, 'damage', 0)).toEqual(['out']);
    expect(assessOutputs(questions, '', 0)).toEqual(['out']);
    expect(assessOutputs(questions, 'missing', 0)).toEqual(['out']);
    expect(assessOutputs({ broken: true }, 'route', 0)).toEqual(['out']);
  });

  it('adds “unsure” with a confidence floor', () => {
    expect(assessOutputs(questions, 'route', 0.6)).toEqual(['approve', 'review', 'ask', 'unsure']);
    expect(assessOutputs(questions, 'damage', 0.6)).toEqual(['out']);
  });

  it('the node’s handles follow its config', () => {
    expect(nodeOutputs('ai.assess', { questions, branchOn: 'urgent', minConfidence: 0.5 })).toEqual(
      ['yes', 'no', 'unsure'],
    );
    expect(nodeOutputs('ai.assess', {})).toEqual(['out']);
  });

  it('picks the chosen option, or unsure below the floor', () => {
    const a = clampAnswers(questions, {
      route: { probabilities: { approve: 0.2, review: 0.7, ask: 0.1 }, confidence: 0.55 },
      urgent: { noul: 0.9 },
    });
    expect(assessBranch(a.route)).toBe('review');
    expect(assessBranch(a.route, 0.6)).toBe('unsure');
    expect(assessBranch(a.urgent)).toBe('yes');
    expect(answerConfidence(a.urgent!)).toBeCloseTo(0.8);
    expect(assessBranch(a.urgent, 0.9)).toBe('unsure');
    expect(assessBranch({ type: 'noul', noul: 0.2 })).toBe('no');
    expect(assessBranch(a.damage)).toBe('out');
    expect(assessBranch(undefined)).toBe('out');
  });
});

describe('clampAnswers', () => {
  it('keeps only allowed options, renormalises and recomputes the choice', () => {
    const a = clampAnswers(questions, {
      route: { choice: 'nope', probabilities: { approve: 0.2, review: 0.2, nope: 0.6 } },
      extra: { type: 'noul', noul: 1 },
    });
    expect(Object.keys(a)).toEqual(['route', 'urgent', 'damage']);
    expect(a.route).toMatchObject({
      type: 'choice',
      probabilities: { approve: 0.5, review: 0.5, ask: 0 },
      choice: 'approve',
      confidence: 0.5,
    });
  });

  it('fills skipped questions with an uninformed answer and clamps to [0, 1]', () => {
    const a = clampAnswers(questions, { urgent: { noul: 4 } });
    expect(a.urgent).toEqual({ type: 'noul', noul: 1 });
    expect(a.route).toMatchObject({ choice: 'approve' });
    expect(a.damage).toMatchObject({
      type: 'score',
      score: 1,
      legend: { 0: 'None', 1: 'Minor', 2: 'Major' },
    });
    const p = (a.damage as { probabilities: Record<string, number> }).probabilities;
    expect(Object.values(p).reduce((x, y) => x + y)).toBeCloseTo(1);
  });

  it('keeps Clef’s 4 decimals without float noise', () => {
    // Live Clef output, which sums to 1 only approximately.
    const a = clampAnswers(questions, {
      route: {
        probabilities: { approve: 0.0084, review: 0.9559, ask: 0.0357 },
        confidence: 0.8727,
      },
    });
    expect(a.route).toMatchObject({
      choice: 'review',
      probabilities: { approve: 0.0084, review: 0.9559, ask: 0.0357 },
      confidence: 0.8727,
    });
  });

  it('scores are the probability-weighted level', () => {
    const a = clampAnswers(questions, { damage: { probabilities: { 1: 0.5, 2: 0.5 } } });
    expect(a.damage).toMatchObject({ score: 1.5 });
    expect(describeAnswers(a)).toBe('route → approve (33%) · urgent 0.50 · damage 1.5/2');
  });
});

describe('ai.assess config', () => {
  it('is valid with its defaults', () => {
    expect(validateConfig('ai.assess', {})).toEqual([]);
  });

  it('requires branchOn to name a question it can branch on', () => {
    expect(validateConfig('ai.assess', { questions, branchOn: 'nope' })).toEqual([
      'Branch on: no question “nope”',
    ]);
    expect(validateConfig('ai.assess', { questions, branchOn: 'damage' })[0]).toMatch(/score/);
    expect(validateConfig('ai.assess', { questions, branchOn: '' })).toEqual([]);
  });

  it('reports invalid questions', () => {
    expect(validateConfig('ai.assess', { questions: { q: { type: 'maybe' } } })[0]).toMatch(
      /^Questions:/,
    );
  });
});
