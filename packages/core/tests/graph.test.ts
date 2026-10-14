import { describe, expect, it } from 'vitest';
import {
  beginNode,
  completeLoop,
  completeNode,
  type Flow,
  type FlowGraph,
  initPlan,
  isSettled,
  nodeOutputs,
  readyNodes,
  TEMPLATES,
  validateGraph,
} from '../src';

/**
 * Drives the planner the way the Workflow interpreter does, with `choose` standing in for node
 * execution. Returns the node ids in the order they ran.
 */
function simulate(
  graph: FlowGraph,
  choose: (id: string, run: number) => string[] | boolean | undefined = () => undefined,
  limit = 1000,
) {
  const state = initPlan(graph);
  const ran: string[] = [];
  for (let i = 0; i < limit; i++) {
    const { ready } = readyNodes(graph, state);
    if (!ready.length) break;
    for (const id of ready) {
      const node = graph.nodes.find((n) => n.id === id)!;
      beginNode(state, id);
      const run = state.nodes[id]!.runs;
      ran.push(id);
      const choice = choose(id, run);
      if (node.type === 'control.loop') {
        const max = Number(node.config.maxIterations ?? 12);
        completeLoop(graph, state, id, (choice as boolean | undefined) ?? run <= max);
      } else if (node.type === 'control.end' || node.type === 'control.continue_as_new') {
        completeNode(graph, state, id, []);
        return { ran, state, ended: id };
      } else {
        const outs = nodeOutputs(node.type, node.config);
        completeNode(graph, state, id, (choice as string[] | undefined) ?? outs.slice(0, 1));
      }
    }
  }
  return { ran, state, ended: null };
}

const tpl = (k: keyof typeof TEMPLATES): Flow => TEMPLATES[k]();

describe('templates', () => {
  for (const key of Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]) {
    it(`${key} validates`, () => {
      const { errors } = validateGraph(tpl(key));
      expect(errors).toEqual([]);
    });
  }
});

describe('planner', () => {
  it('runs the cheap purchase-request path and skips approvals', () => {
    const flow = tpl('tpl-purchase-request');
    const { ran, state, ended } = simulate(flow, (id) =>
      id === 'needs_mgr' ? ['false'] : undefined,
    );
    expect(ended).toBe('done');
    expect(ran).toEqual([
      'request',
      'classify',
      'price',
      'budget',
      'needs_mgr',
      'po',
      'send',
      'ack',
      'goods',
      'match',
      'pay',
      'erp',
      'done',
    ]);
    expect(state.nodes.mgr!.status).toBe('skipped');
    expect(state.nodes.fin!.status).toBe('skipped');
  });

  it('routes a rejection to the rejected end through a join', () => {
    const flow = tpl('tpl-purchase-request');
    const { ended, state } = simulate(flow, (id) => {
      if (id === 'needs_mgr') return ['true'];
      if (id === 'mgr') return ['rejected'];
    });
    expect(ended).toBe('rejected');
    expect(state.nodes.po!.status).toBe('skipped');
    expect(state.nodes.reject_note!.status).toBe('succeeded');
  });

  it('runs the dunning loop to its limit, then exits through "done"', () => {
    const flow = tpl('tpl-b2b-order');
    const { ran, ended } = simulate(flow, (id) => {
      if (id === 'paid' || id === 'paid_late') return ['timeout'];
    });
    expect(ran.filter((id) => id === 'remind')).toHaveLength(3);
    expect(ran.filter((id) => id === 'dunning')).toHaveLength(4);
    expect(ended).toBe('unpaid');
  });

  it('leaves the dunning loop early when payment arrives', () => {
    const flow = tpl('tpl-b2b-order');
    const { ran, ended } = simulate(flow, (id, run) => {
      if (id === 'paid') return ['timeout'];
      if (id === 'paid_late') return run === 2 ? ['received'] : ['timeout'];
    });
    expect(ran.filter((id) => id === 'remind')).toHaveLength(2);
    expect(ended).toBe('done');
  });

  it('runs subscription periods with distinct step runs, then continues as new', () => {
    const flow = tpl('tpl-subscription');
    const { ran, state, ended } = simulate(flow, (id, run) => {
      if (id === 'periods') return run <= 12;
      if (id === 'charge') return run === 3 ? ['failed'] : ['ok'];
    });
    expect(ended).toBe('renew');
    expect(state.nodes.charge!.runs).toBe(12);
    expect(state.nodes.fulfill!.runs).toBe(12);
    expect(state.nodes.retry!.runs).toBe(1);
    expect(ran.filter((id) => id === 'renewal')).toHaveLength(12);
  });

  it('stops a subscription when the retry also fails', () => {
    const flow = tpl('tpl-subscription');
    const { ended, state } = simulate(flow, (id) => {
      if (id === 'charge' || id === 'retry') return ['failed'];
    });
    expect(ended).toBe('paused');
    expect(state.nodes.fulfill!.status).toBe('skipped');
  });

  it('is settled once nothing can run', () => {
    const flow = tpl('tpl-reorder');
    const { state } = simulate(flow, (id) => (id === 'any' ? ['false'] : undefined));
    expect(isSettled(flow, state)).toBe(true);
  });
});

describe('validateGraph', () => {
  const base = (): FlowGraph => ({
    nodes: [
      { id: 't', type: 'trigger.manual', label: 'T', config: {}, position: { x: 0, y: 0 } },
      { id: 'a', type: 'commerce.validate', label: 'A', config: {}, position: { x: 0, y: 0 } },
      { id: 'b', type: 'commerce.price', label: 'B', config: {}, position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: '1', source: 't', target: 'a' },
      { id: '2', source: 'a', target: 'b' },
    ],
  });

  it('rejects a forward cycle', () => {
    const g = base();
    g.edges.push({ id: '3', source: 'b', target: 'a' });
    expect(validateGraph(g).errors.some((e) => e.message.includes('cycle'))).toBe(true);
  });

  it('rejects an unknown output branch', () => {
    const g = base();
    g.edges[1]!.sourceHandle = 'nope';
    expect(validateGraph(g).errors[0]!.message).toContain('no “nope” output');
  });

  it('rejects a disconnected node and a second trigger', () => {
    const g = base();
    g.nodes.push({
      id: 'x',
      type: 'commerce.tax',
      label: 'X',
      config: {},
      position: { x: 0, y: 0 },
    });
    g.nodes.push({
      id: 't2',
      type: 'trigger.webhook',
      label: 'T2',
      config: {},
      position: { x: 0, y: 0 },
    });
    const msgs = validateGraph(g).errors.map((e) => e.message);
    expect(msgs.some((m) => m.includes('not connected'))).toBe(true);
    expect(msgs.some((m) => m.includes('exactly one trigger'))).toBe(true);
  });

  it('rejects a back-edge from outside the loop body', () => {
    const g = tpl('tpl-b2b-order');
    g.edges.push({ id: 'bad', source: 'erp', target: 'dunning', targetHandle: 'next' });
    expect(validateGraph(g).errors.some((e) => e.message.includes('inside that loop'))).toBe(true);
  });

  it('checks node config', () => {
    const g = base();
    g.nodes[1] = { ...g.nodes[1]!, type: 'control.wait', config: { duration: 'soon' } };
    expect(validateGraph(g).errors.some((e) => e.message.includes('Duration'))).toBe(true);
  });
});
