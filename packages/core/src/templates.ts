/**
 * Seeded flows, one per order type. Each is a normal editable flow; the seed publishes version 1.
 */

import { withDefaults } from './catalog';
import { LOOP_INPUT } from './graph';
import { autoLayout } from './layout';
import type { Flow, FlowEdge, FlowNode, OrderType } from './types';

class Builder {
  nodes: FlowNode[] = [];
  edges: FlowEdge[] = [];
  n(id: string, type: string, label: string, config: Record<string, unknown> = {}) {
    this.nodes.push({
      id,
      type,
      label,
      config: withDefaults(type, config),
      position: { x: 0, y: 0 },
    });
    return this;
  }
  /** `from` may be "node" or "node.branch". */
  e(from: string, to: string, targetHandle?: string) {
    const [source, sourceHandle] = from.split('.') as [string, string | undefined];
    this.edges.push({
      id: `${source}${sourceHandle ? `.${sourceHandle}` : ''}-${to}${targetHandle ? `.${targetHandle}` : ''}`,
      source,
      target: to,
      sourceHandle: sourceHandle ?? null,
      targetHandle: targetHandle ?? null,
    });
    return this;
  }
  build(meta: Omit<Flow, 'nodes' | 'edges'>): Flow {
    return autoLayout({ ...meta, nodes: this.nodes, edges: this.edges });
  }
}

const gt = (path: string, n: number) => ({ '>': [{ var: path }, n] });

export function purchaseRequestFlow(): Flow {
  return new Builder()
    .n('request', 'trigger.manual', 'Purchase request')
    .n('classify', 'ai.classify', 'Classify spend')
    .n('price', 'commerce.price', 'Price lines', { useContracts: false })
    .n('budget', 'commerce.budget_check', 'Budget check', { budget: 25000 })
    .n('needs_mgr', 'control.condition', 'Over $5k?', { expression: gt('order.total', 5000) })
    .n('mgr', 'control.approval', 'Manager approval', {
      title: 'Approve purchase {{order.id}} ({{vars.category}})',
      assignee: 'manager',
      timeout: '2 days',
    })
    .n('needs_fin', 'control.condition', 'Over $20k?', { expression: gt('order.total', 20000) })
    .n('fin', 'control.approval', 'Finance approval', {
      title: 'Finance sign-off for {{order.id}}',
      assignee: 'finance',
      timeout: '3 days',
    })
    .n('po', 'commerce.generate_po', 'Generate PO', { supplier: 'Acme Supply Co.' })
    .n('send', 'commerce.notify', 'Send PO to supplier', {
      to: 'supplier',
      subject: 'Purchase order {{order.id}}',
    })
    .n('ack', 'control.wait_event', 'Supplier acknowledges', {
      event: 'supplier.ack',
      timeout: '5 days',
    })
    .n('goods', 'control.wait_event', 'Goods received', {
      event: 'goods.received',
      timeout: '30 days',
    })
    .n('match', 'commerce.three_way_match', '3-way match')
    .n('mismatch', 'control.approval', 'Resolve mismatch', {
      title: 'Invoice mismatch on {{order.id}}',
      assignee: 'ap',
      timeout: '5 days',
    })
    .n('pay', 'commerce.pay_supplier', 'Pay supplier')
    .n('erp', 'commerce.erp_sync', 'Post to ERP')
    .n('done', 'control.end', 'Closed', { outcome: 'completed' })
    .n('reject_note', 'commerce.notify', 'Tell requester', {
      to: 'team',
      subject: 'Purchase {{order.id}} was not approved',
    })
    .n('rejected', 'control.end', 'Rejected', { outcome: 'cancelled', reason: 'Not approved' })
    .n('stalled', 'control.end', 'Supplier unresponsive', {
      outcome: 'failed',
      reason: 'Supplier did not respond',
    })
    .e('request', 'classify')
    .e('classify', 'price')
    .e('price', 'budget')
    .e('budget.within', 'needs_mgr')
    .e('budget.over', 'fin')
    .e('needs_mgr.true', 'mgr')
    .e('needs_mgr.false', 'po')
    .e('mgr.approved', 'needs_fin')
    .e('mgr.escalated', 'fin')
    .e('mgr.rejected', 'reject_note')
    .e('needs_fin.true', 'fin')
    .e('needs_fin.false', 'po')
    .e('fin.approved', 'po')
    .e('fin.rejected', 'reject_note')
    .e('fin.escalated', 'reject_note')
    .e('reject_note', 'rejected')
    .e('po', 'send')
    .e('send', 'ack')
    .e('ack.received', 'goods')
    .e('ack.timeout', 'stalled')
    .e('goods.received', 'match')
    .e('goods.timeout', 'stalled')
    .e('match.match', 'pay')
    .e('match.mismatch', 'mismatch')
    .e('mismatch.approved', 'pay')
    .e('mismatch.rejected', 'reject_note')
    .e('mismatch.escalated', 'reject_note')
    .e('pay', 'erp')
    .e('erp', 'done')
    .build({
      id: 'tpl-purchase-request',
      name: 'Purchase request',
      description:
        'Internal procurement: AI spend classification, budget check, tiered approvals, PO, supplier acknowledgement, goods receipt, 3-way match and payment.',
      orderType: 'purchase_request',
    });
}

export function b2bOrderFlow(): Flow {
  return new Builder()
    .n('po_in', 'trigger.email_po', 'PO received')
    .n('extract', 'ai.extract', 'Extract order')
    .n('validate', 'commerce.validate', 'Validate')
    .n('price', 'commerce.price', 'Contract pricing', { useContracts: true })
    .n('tax', 'commerce.tax', 'Tax', { rate: 0.0825 })
    .n('credit', 'commerce.credit_check', 'Credit check')
    .n('router', 'ai.router', 'Agent: triage', {
      instructions:
        'You triage B2B orders. Choose auto_approve for routine orders from customers in good standing; needs_approval for unusual quantities, new SKUs, big jumps versus their history or totals above $10,000; ask_customer if the PO is ambiguous or lines could not be matched.',
      routes: ['auto_approve', 'needs_approval', 'ask_customer'],
    })
    .n('clarify', 'commerce.notify', 'Ask customer', {
      to: 'customer',
      subject: 'Question about your PO {{order.id}}',
      body: '{{nodes.router.reason}}',
    })
    .n('reply', 'control.wait_event', 'Customer replies', {
      event: 'customer.reply',
      timeout: '3 days',
    })
    .n('approval', 'control.approval', 'Sales approval', {
      title: 'Approve B2B order {{order.id}} for {{order.customerId}}',
      assignee: 'sales_ops',
      timeout: '1 day',
    })
    .n('reserve', 'commerce.reserve_inventory', 'Reserve stock')
    .n('invoice', 'commerce.invoice', 'Invoice', { terms: 'net_30' })
    .n('ship', 'commerce.ship', 'Ship', { carrier: 'freight' })
    .n('erp', 'commerce.erp_sync', 'Post to ERP')
    .n('paid', 'control.wait_event', 'Payment received', {
      event: 'payment.received',
      timeout: '30 days',
    })
    .n('dunning', 'control.loop', 'Dunning', { while: true, maxIterations: 3 })
    .n('remind', 'commerce.notify', 'Payment reminder', {
      to: 'customer',
      subject: 'Invoice for {{order.id}} is overdue',
    })
    .n('paid_late', 'control.wait_event', 'Payment received', {
      event: 'payment.received',
      timeout: '7 days',
    })
    .n('collections', 'commerce.notify', 'Send to collections', {
      to: 'team',
      subject: '{{order.id}} unpaid after 3 reminders',
    })
    .n('done', 'control.end', 'Paid', { outcome: 'completed' })
    .n('unpaid', 'control.end', 'Unpaid', { outcome: 'cancelled', reason: 'Sent to collections' })
    .n('decline', 'commerce.notify', 'Decline order', {
      to: 'customer',
      subject: 'We could not accept PO {{order.id}}',
    })
    .n('declined', 'control.end', 'Declined', { outcome: 'cancelled' })
    .n('backorder', 'control.end', 'Out of stock', {
      outcome: 'failed',
      reason: 'Insufficient stock; reservations released',
    })
    .e('po_in', 'extract')
    .e('extract', 'validate')
    .e('validate', 'price')
    .e('price', 'tax')
    .e('tax', 'credit')
    .e('credit.ok', 'router')
    .e('credit.over_limit', 'approval')
    .e('router.auto_approve', 'reserve')
    .e('router.needs_approval', 'approval')
    .e('router.ask_customer', 'clarify')
    .e('clarify', 'reply')
    .e('reply.received', 'approval')
    .e('reply.timeout', 'decline')
    .e('approval.approved', 'reserve')
    .e('approval.rejected', 'decline')
    .e('approval.escalated', 'decline')
    .e('decline', 'declined')
    .e('reserve.ok', 'invoice')
    .e('reserve.backorder', 'backorder')
    .e('invoice', 'ship')
    .e('ship', 'erp')
    .e('erp', 'paid')
    .e('paid.received', 'done')
    .e('paid.timeout', 'dunning')
    .e('dunning.body', 'remind')
    .e('remind', 'paid_late')
    .e('paid_late.received', 'done')
    .e('paid_late.timeout', 'dunning', LOOP_INPUT)
    .e('dunning.done', 'collections')
    .e('collections', 'unpaid')
    .build({
      id: 'tpl-b2b-order',
      name: 'B2B order',
      description:
        'Inbound PO by email: AI extraction, contract pricing, credit check, an agent that triages to auto-approve / approval / clarify, stock reservation, net-30 invoice, shipment and a dunning loop.',
      orderType: 'b2b_order',
    });
}

export function reorderFlow(): Flow {
  return new Builder()
    .n('schedule', 'trigger.schedule', 'Daily stock review', { cron: '0 6 * * *' })
    .n('forecast', 'ai.forecast', 'Forecast demand', { horizonDays: 30 })
    .n('any', 'control.condition', 'Anything to order?', {
      expression: { '>': [{ len: [{ var: 'order.lines' }] }, 0] },
    })
    .n('price', 'commerce.price', 'Supplier cost', { useContracts: false })
    .n('po', 'commerce.generate_po', 'Replenishment PO', { supplier: 'Acme Supply Co.' })
    .n('big', 'control.condition', 'Over $10k?', { expression: gt('order.total', 10000) })
    .n('approval', 'control.approval', 'Buyer approval', {
      title: 'Approve replenishment {{order.id}}',
      assignee: 'buyer',
      timeout: '1 day',
    })
    .n('submit', 'commerce.notify', 'Submit to supplier', {
      to: 'supplier',
      subject: 'Replenishment order {{order.id}}',
    })
    .n('ack', 'control.wait_event', 'Supplier acknowledges', {
      event: 'supplier.ack',
      timeout: '3 days',
    })
    .n('receipt', 'control.wait_event', 'Goods received', {
      event: 'goods.received',
      timeout: '14 days',
    })
    .n('restock', 'commerce.restock', 'Restock')
    .n('erp', 'commerce.erp_sync', 'Post to ERP')
    .n('done', 'control.end', 'Restocked', { outcome: 'completed' })
    .n('nothing', 'control.end', 'Nothing to order', { outcome: 'completed' })
    .n('skip', 'control.end', 'Not approved', { outcome: 'cancelled' })
    .n('late', 'control.end', 'Supplier late', {
      outcome: 'failed',
      reason: 'Supplier did not deliver',
    })
    .e('schedule', 'forecast')
    .e('forecast', 'any')
    .e('any.true', 'price')
    .e('any.false', 'nothing')
    .e('price', 'po')
    .e('po', 'big')
    .e('big.true', 'approval')
    .e('big.false', 'submit')
    .e('approval.approved', 'submit')
    .e('approval.rejected', 'skip')
    .e('approval.escalated', 'submit')
    .e('submit', 'ack')
    .e('ack.received', 'receipt')
    .e('ack.timeout', 'late')
    .e('receipt.received', 'restock')
    .e('receipt.timeout', 'late')
    .e('restock', 'erp')
    .e('erp', 'done')
    .build({
      id: 'tpl-reorder',
      name: 'Reorder',
      description:
        'Scheduled replenishment: AI demand forecast for SKUs at their reorder point, PO generation, approval above $10k, supplier acknowledgement, receipt and restock.',
      orderType: 'reorder',
    });
}

export function subscriptionFlow(): Flow {
  return (
    new Builder()
      .n('signup', 'trigger.webhook', 'Subscription signup', { source: 'storefront' })
      .n('validate', 'commerce.validate', 'Validate')
      .n('price', 'commerce.price', 'Plan price', { useContracts: false })
      .n('tax', 'commerce.tax', 'Tax')
      .n('authorize', 'commerce.authorize_payment', 'Authorize card', { method: 'card' })
      .n('welcome', 'commerce.notify', 'Welcome email', {
        to: 'customer',
        subject: 'Welcome! Your first box ships soon',
      })
      // Runs again after "continue as new": vars carry over, so reset the cycle and count the year.
      .n('init', 'control.set', 'Start year', {
        assign: { cycle: 0, year: { '+': [{ var: 'vars.year' }, 1] } },
      })
      .n('periods', 'control.loop', 'Billing periods', {
        while: { '<': [{ var: 'vars.cycle' }, 12] },
        maxIterations: 12,
      })
      .n('renewal', 'control.wait', 'Until renewal', { duration: '30 days' })
      .n('charge', 'commerce.charge', 'Charge renewal')
      .n('retry_wait', 'control.wait', 'Dunning delay', { duration: '3 days' })
      .n('retry', 'commerce.charge', 'Retry charge')
      .n('fulfill', 'commerce.ship', 'Ship box', { carrier: 'ups' })
      .n('next', 'control.set', 'Next cycle', {
        assign: { cycle: { '+': [{ var: 'vars.cycle' }, 1] } },
      })
      .n('pause', 'commerce.notify', 'Payment failed', {
        to: 'customer',
        subject: 'We couldn’t renew your subscription',
      })
      .n('paused', 'control.end', 'Paused', {
        outcome: 'cancelled',
        reason: 'Renewal payment failed',
      })
      .n('renew', 'control.continue_as_new', 'Next year')
      .n('declined', 'control.end', 'Card declined', { outcome: 'failed', reason: 'Card declined' })
      .e('signup', 'validate')
      .e('validate', 'price')
      .e('price', 'tax')
      .e('tax', 'authorize')
      .e('authorize.ok', 'welcome')
      .e('authorize.declined', 'declined')
      .e('welcome', 'init')
      .e('init', 'periods')
      .e('periods.body', 'renewal')
      .e('renewal', 'charge')
      .e('charge.ok', 'fulfill')
      .e('charge.failed', 'retry_wait')
      .e('retry_wait', 'retry')
      .e('retry.ok', 'fulfill')
      .e('retry.failed', 'pause')
      .e('pause', 'paused')
      .e('fulfill', 'next')
      .e('next', 'periods', LOOP_INPUT)
      .e('periods.done', 'renew')
      .build({
        id: 'tpl-subscription',
        name: 'Subscription',
        description:
          'Recurring box subscription: authorize, then a billing-period loop (wait → charge → ship) with a dunning retry, continuing as a new run after 12 cycles.',
        orderType: 'subscription',
      })
  );
}

export const TEMPLATES: Record<OrderType, () => Flow> = {
  purchase_request: purchaseRequestFlow,
  b2b_order: b2bOrderFlow,
  reorder: reorderFlow,
  subscription: subscriptionFlow,
};
