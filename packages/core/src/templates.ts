/**
 * Seeded flows, at least one per commerce model. Each is a normal editable flow; the seed publishes version 1.
 */

import { withDefaults } from './catalog';
import { LOOP_INPUT } from './graph';
import { autoLayout } from './layout';
import type { Flow, FlowEdge, FlowNode, OrderModel } from './types';

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
    .n('rejected', 'control.end', 'Rejected', { outcome: 'declined', reason: 'Not approved' })
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
      model: 'procurement',
      channels: ['manual', 'email', 'api'],
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
      // No customer in the title: the approvals inbox shows it beside each row, and an order from an
      // unknown sender has none to show.
      title: 'Approve B2B order {{order.id}}',
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
    .n('declined', 'control.end', 'Declined', { outcome: 'declined', reason: 'Not approved' })
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
      model: 'b2b',
      channels: ['email', 'api', 'manual'],
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
    .n('skip', 'control.end', 'Not approved', { outcome: 'declined', reason: 'Not approved' })
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
      model: 'replenishment',
      channels: ['schedule', 'manual'],
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
        model: 'subscription',
        channels: ['web', 'mobile', 'api'],
      })
  );
}

export function storefrontOrderFlow(): Flow {
  return (
    new Builder()
      .n('checkout', 'trigger.webhook', 'Storefront checkout', { source: 'storefront' })
      .n('validate', 'commerce.validate', 'Validate')
      .n('price', 'commerce.price', 'List price', { useContracts: false })
      .n('tax', 'commerce.tax', 'Tax')
      .n('policy', 'commerce.policy', 'Store policy', {
        rules: [
          { rule: 'min_order_amount', amount: 25 },
          { rule: 'max_qty_per_sku', qty: 10 },
          { rule: 'no_po_box' },
        ],
      })
      .n('reject', 'commerce.notify', 'Explain rejection', {
        to: 'customer',
        subject: 'We couldn’t accept order {{order.id}}',
        body: '{{vars.policyFailures}}',
      })
      .n('rejected', 'control.end', 'Rejected', {
        outcome: 'declined',
        reason: 'Failed store policy',
      })
      .n('authorize', 'commerce.authorize_payment', 'Authorize card', { method: 'card' })
      .n('reserve', 'commerce.reserve_inventory', 'Reserve stock')
      .n('ship', 'commerce.ship', 'Ship', { carrier: 'ups' })
      .n('capture', 'commerce.capture_payment', 'Capture payment')
      .n('shipped', 'commerce.notify', 'Shipping confirmation', {
        to: 'customer',
        subject: 'Order {{order.id}} is on its way ({{vars.tracking}})',
      })
      .n('window', 'control.wait_event', 'Return window', {
        event: 'return.requested',
        timeout: '30 days',
      })
      .n('rma', 'commerce.return_label', 'Return label', { carrier: 'ups' })
      .n('send_label', 'commerce.notify', 'Send return label', {
        to: 'customer',
        subject: 'Your return label for {{order.id}}: {{vars.returnTracking}}',
      })
      .n('back', 'control.wait_event', 'Return received', {
        event: 'return.received',
        timeout: '14 days',
      })
      // Only the returned lines come back; without a list in the request, the whole order does.
      .n('restock', 'commerce.restock', 'Restock', {
        lines: { var: 'vars.return_requested.lines' },
      })
      // A partial refund comes from the return request's payload; the connector caps it.
      .n('refund', 'commerce.refund', 'Refund', {
        amount: { or: [{ var: 'vars.return_requested.amount' }, { var: 'order.total' }] },
        reason: '{{vars.return_requested.reason}}',
      })
      .n('refunded', 'commerce.notify', 'Refund confirmation', {
        to: 'customer',
        subject: 'We refunded {{vars.refunded}} for {{order.id}}',
      })
      .n('review', 'commerce.notify', 'Refund needs review', {
        to: 'team',
        subject: 'Refund for {{order.id}} failed; please review',
      })
      .n('done', 'control.end', 'Fulfilled', { outcome: 'completed' })
      .n('returned', 'control.end', 'Returned', { outcome: 'completed', reason: 'Returned' })
      .n('lost', 'control.end', 'Return not received', {
        outcome: 'completed',
        reason: 'Return label issued but goods never arrived',
      })
      .n('declined', 'control.end', 'Card declined', { outcome: 'failed', reason: 'Card declined' })
      .n('short', 'control.end', 'Out of stock', {
        outcome: 'failed',
        reason: 'Insufficient stock; authorization voided',
      })
      .n('uncaptured', 'control.end', 'Capture failed', {
        outcome: 'failed',
        reason: 'Payment capture failed',
      })
      .e('checkout', 'validate')
      .e('validate', 'price')
      .e('price', 'tax')
      .e('tax', 'policy')
      .e('policy.pass', 'authorize')
      .e('policy.fail', 'reject')
      .e('reject', 'rejected')
      .e('authorize.ok', 'reserve')
      .e('authorize.declined', 'declined')
      .e('reserve.ok', 'ship')
      .e('reserve.backorder', 'short')
      .e('ship', 'capture')
      .e('capture.ok', 'shipped')
      .e('capture.failed', 'uncaptured')
      .e('shipped', 'window')
      .e('window.timeout', 'done')
      .e('window.received', 'rma')
      .e('rma', 'send_label')
      .e('send_label', 'back')
      .e('back.received', 'restock')
      .e('back.timeout', 'lost')
      .e('restock', 'refund')
      .e('refund.ok', 'refunded')
      .e('refund.failed', 'review')
      .e('refunded', 'returned')
      .e('review', 'returned')
      .build({
        id: 'tpl-storefront-order',
        name: 'Storefront order',
        description:
          'Card checkout: store policy, authorize, reserve, ship and capture, then a 30-day return window: RMA label, goods received, restock and a full or partial refund.',
        model: 'b2c',
        channels: ['web', 'mobile', 'api'],
      })
  );
}

export function marketplaceOrderFlow(): Flow {
  return (
    new Builder()
      .n('checkout', 'trigger.webhook', 'Marketplace checkout', { source: 'marketplace' })
      .n('validate', 'commerce.validate', 'Validate')
      .n('price', 'commerce.price', 'List price', { useContracts: false })
      .n('tax', 'commerce.tax', 'Tax')
      .n('risk', 'ai.risk_score', 'Fraud check', { threshold: 70 })
      .n('trust', 'control.approval', 'Trust & safety review', {
        title: 'Review risky marketplace order {{order.id}}',
        assignee: 'trust_safety',
        timeout: '1 day',
      })
      .n('authorize', 'commerce.authorize_payment', 'Authorize card', { method: 'card' })
      .n('split', 'commerce.split_by_seller', 'Split by seller')
      .n('ask', 'commerce.notify', 'Ask sellers', {
        to: 'seller',
        subject: 'New order {{order.id}} to accept',
        body: 'Accept or reject your part of order {{order.id}} within 2 days.',
      })
      .n('accepting', 'control.loop', 'Seller responses', { while: true, maxIterations: 10 })
      .n('responded', 'control.wait_event', 'Seller responds', {
        event: 'seller.responded',
        timeout: '2 days',
      })
      .n('record', 'commerce.seller_accept', 'Record response', { decision: 'from_event' })
      .n('expire', 'commerce.seller_accept', 'Reject unanswered', { decision: 'expire_pending' })
      .n('reserve', 'commerce.reserve_inventory', 'Reserve stock')
      .n('ship', 'commerce.ship', 'Ship', { carrier: 'ups' })
      .n('capture', 'commerce.capture_payment', 'Capture payment')
      .n('shipped', 'commerce.notify', 'Shipping confirmation', {
        to: 'customer',
        subject: 'Order {{order.id}} is on its way ({{vars.tracking}})',
      })
      .n('window', 'control.wait_event', 'Return window', {
        event: 'return.requested',
        timeout: '14 days',
      })
      .n('rma', 'commerce.return_label', 'Return label', { carrier: 'ups' })
      .n('back', 'control.wait_event', 'Return received', {
        event: 'return.received',
        timeout: '14 days',
      })
      .n('restock', 'commerce.restock', 'Restock', {
        lines: { var: 'vars.return_requested.lines' },
      })
      .n('refund', 'commerce.refund', 'Refund', {
        amount: { or: [{ var: 'vars.return_requested.amount' }, { var: 'order.total' }] },
        reason: '{{vars.return_requested.reason}}',
      })
      .n('payout', 'commerce.payout', 'Seller payouts')
      .n('done', 'control.end', 'Fulfilled', { outcome: 'completed' })
      .n('blocked', 'control.end', 'Blocked', {
        outcome: 'declined',
        reason: 'Failed fraud review',
      })
      .n('declined', 'control.end', 'Card declined', { outcome: 'failed', reason: 'Card declined' })
      .n('no_sellers', 'control.end', 'No seller accepted', {
        outcome: 'failed',
        reason: 'No seller accepted; authorization voided',
      })
      .n('unanswered', 'control.end', 'Sellers did not answer', {
        outcome: 'failed',
        reason: 'Sellers kept the order pending; authorization voided',
      })
      .n('short', 'control.end', 'Out of stock', {
        outcome: 'failed',
        reason: 'Insufficient stock; authorization voided',
      })
      .n('uncaptured', 'control.end', 'Capture failed', {
        outcome: 'failed',
        reason: 'Payment capture failed',
      })
      .e('checkout', 'validate')
      .e('validate', 'price')
      .e('price', 'tax')
      .e('tax', 'risk')
      .e('risk.low', 'authorize')
      .e('risk.high', 'trust')
      .e('trust.approved', 'authorize')
      .e('trust.rejected', 'blocked')
      .e('trust.escalated', 'blocked')
      .e('authorize.ok', 'split')
      .e('authorize.declined', 'declined')
      .e('split.accepted', 'reserve')
      .e('split.awaiting', 'ask')
      .e('ask', 'accepting')
      // One response per pass; the loop goes round until no seller is left to answer.
      .e('accepting.body', 'responded')
      .e('responded.received', 'record')
      .e('responded.timeout', 'expire')
      .e('record.pending', 'accepting', LOOP_INPUT)
      .e('record.accepted', 'reserve')
      .e('record.partial', 'reserve')
      .e('record.rejected', 'no_sellers')
      .e('expire.accepted', 'reserve')
      .e('expire.partial', 'reserve')
      .e('expire.rejected', 'no_sellers')
      // Exits from the loop body join at reserve, so its "done" exit can only end the order.
      .e('accepting.done', 'unanswered')
      .e('reserve.ok', 'ship')
      .e('reserve.backorder', 'short')
      .e('ship', 'capture')
      .e('capture.ok', 'shipped')
      .e('capture.failed', 'uncaptured')
      .e('shipped', 'window')
      .e('window.timeout', 'payout')
      .e('window.received', 'rma')
      .e('rma', 'back')
      .e('back.received', 'restock')
      .e('back.timeout', 'payout')
      .e('restock', 'refund')
      .e('refund.ok', 'payout')
      .e('refund.failed', 'payout')
      .e('payout', 'done')
      .build({
        id: 'tpl-marketplace-order',
        name: 'Marketplace order',
        description:
          'Multi-seller checkout: fraud check, authorize, split by seller and wait for each seller to accept, ship and capture what was accepted, a return window, then seller payouts net of commission and refunds.',
        model: 'marketplace',
        channels: ['marketplace', 'web', 'mobile', 'api'],
      })
  );
}

export function omnichannelOrderFlow(): Flow {
  return (
    new Builder()
      .n('checkout', 'trigger.webhook', 'Checkout', { source: 'web' })
      .n('validate', 'commerce.validate', 'Validate')
      .n('price', 'commerce.price', 'List price', { useContracts: false })
      .n('tax', 'commerce.tax', 'Tax')
      .n('authorize', 'commerce.authorize_payment', 'Authorize payment', { method: 'card' })
      .n('route', 'commerce.route_fulfillment', 'Route fulfillment')
      .n('reserve_ship', 'commerce.reserve_inventory', 'Reserve stock')
      .n('ship', 'commerce.ship', 'Ship', { carrier: 'ups' })
      .n('shipped', 'commerce.notify', 'Shipping confirmation', {
        to: 'customer',
        subject: 'Order {{order.id}} is on its way ({{vars.tracking}})',
      })
      .n('reserve_pickup', 'commerce.reserve_inventory', 'Hold at store')
      .n('ready', 'commerce.pickup_ready', 'Ready for pickup')
      .n('ready_note', 'commerce.notify', 'Pickup ready', {
        to: 'customer',
        subject: 'Order {{order.id}} is ready at {{vars.fulfillmentLocation}}',
        body: 'Show code {{vars.pickupCode}} at the counter.',
      })
      .n('collect', 'control.wait_event', 'Customer collects', {
        event: 'pickup.collected',
        timeout: '5 days',
      })
      .n('handover', 'commerce.handover', 'Hand over')
      .n('deliver', 'commerce.deliver_digital', 'Deliver digital goods')
      .n('delivered', 'commerce.notify', 'Download ready', {
        to: 'customer',
        subject: 'Your downloads for {{order.id}}',
      })
      .n('capture', 'commerce.capture_payment', 'Capture payment')
      .n('done', 'control.end', 'Fulfilled', { outcome: 'completed' })
      .n('declined', 'control.end', 'Payment declined', {
        outcome: 'failed',
        reason: 'Payment declined',
      })
      .n('unavailable', 'control.end', 'Cannot fulfil', {
        outcome: 'failed',
        reason: 'No location can fulfil the order; authorization voided',
      })
      .n('short', 'control.end', 'Out of stock', {
        outcome: 'failed',
        reason: 'Insufficient stock; authorization voided',
      })
      // Failed, not cancelled: a failed end rolls back, releasing the store's stock and the payment.
      .n('uncollected', 'control.end', 'Not collected', {
        outcome: 'failed',
        reason: 'Not collected in time; stock released and authorization voided',
      })
      .n('uncaptured', 'control.end', 'Capture failed', {
        outcome: 'failed',
        reason: 'Payment capture failed',
      })
      .e('checkout', 'validate')
      .e('validate', 'price')
      .e('price', 'tax')
      .e('tax', 'authorize')
      .e('authorize.ok', 'route')
      .e('authorize.declined', 'declined')
      .e('route.ship', 'reserve_ship')
      .e('route.pickup', 'reserve_pickup')
      .e('route.carry_out', 'unavailable')
      .e('route.digital', 'deliver')
      .e('route.unavailable', 'unavailable')
      .e('reserve_ship.ok', 'ship')
      .e('reserve_ship.backorder', 'short')
      .e('ship', 'shipped')
      .e('reserve_pickup.ok', 'ready')
      .e('reserve_pickup.backorder', 'short')
      .e('ready', 'ready_note')
      .e('ready_note', 'collect')
      .e('collect.received', 'handover')
      .e('collect.timeout', 'uncollected')
      .e('deliver', 'delivered')
      // Capture joins every branch the order took: a mixed cart waits for both.
      .e('shipped', 'capture')
      .e('handover', 'capture')
      .e('delivered', 'capture')
      .e('capture.ok', 'done')
      .e('capture.failed', 'uncaptured')
      .build({
        id: 'tpl-omnichannel-order',
        name: 'Omnichannel order',
        description:
          'A brand’s own store: authorize, then route each order to shipping (from the warehouse or a store), pickup in store with a code, or digital delivery, and capture once every part is fulfilled.',
        model: 'd2c',
        channels: ['web', 'mobile', 'api'],
      })
  );
}

export function posSaleFlow(): Flow {
  return new Builder()
    .n('sale', 'trigger.webhook', 'Till sale', { source: 'pos' })
    .n('validate', 'commerce.validate', 'Validate')
    .n('price', 'commerce.price', 'List price', { useContracts: false })
    .n('tax', 'commerce.tax', 'Tax')
    .n('authorize', 'commerce.authorize_payment', 'Take payment', { method: 'card_present' })
    .n('route', 'commerce.route_fulfillment', 'Store stock', { method: 'carry_out' })
    .n('reserve', 'commerce.reserve_inventory', 'Take from store stock')
    .n('handover', 'commerce.handover', 'Hand over')
    .n('deliver', 'commerce.deliver_digital', 'Issue codes')
    .n('capture', 'commerce.capture_payment', 'Capture payment')
    .n('has_email', 'control.condition', 'Email receipt?', {
      expression: { '!!': [{ var: 'order.contact.email' }] },
    })
    .n('receipt', 'commerce.notify', 'Email receipt', {
      to: 'customer',
      subject: 'Your receipt for {{order.id}}',
    })
    .n('done', 'control.end', 'Sold', { outcome: 'completed' })
    .n('declined', 'control.end', 'Payment declined', {
      outcome: 'failed',
      reason: 'Payment declined',
    })
    .n('unavailable', 'control.end', 'Not in stock here', {
      outcome: 'failed',
      reason: 'The store does not have every item; payment voided',
    })
    .n('uncaptured', 'control.end', 'Capture failed', {
      outcome: 'failed',
      reason: 'Payment capture failed',
    })
    .e('sale', 'validate')
    .e('validate', 'price')
    .e('price', 'tax')
    .e('tax', 'authorize')
    .e('authorize.ok', 'route')
    .e('authorize.declined', 'declined')
    .e('route.carry_out', 'reserve')
    .e('route.digital', 'deliver')
    .e('route.unavailable', 'unavailable')
    .e('reserve.ok', 'handover')
    .e('reserve.backorder', 'unavailable')
    .e('handover', 'capture')
    .e('deliver', 'capture')
    .e('capture.ok', 'has_email')
    .e('capture.failed', 'uncaptured')
    .e('has_email.true', 'receipt')
    .e('has_email.false', 'done')
    .e('receipt', 'done')
    .build({
      id: 'tpl-pos-sale',
      name: 'Point-of-sale sale',
      description:
        'A sale at the till: take payment, hand the goods over from the store’s own stock (or issue gift card and download codes), capture, and email a receipt when the buyer gives an address.',
      model: 'b2c',
      channels: ['pos'],
    });
}

export const TEMPLATES = {
  'tpl-purchase-request': purchaseRequestFlow,
  'tpl-b2b-order': b2bOrderFlow,
  'tpl-reorder': reorderFlow,
  'tpl-subscription': subscriptionFlow,
  'tpl-storefront-order': storefrontOrderFlow,
  'tpl-marketplace-order': marketplaceOrderFlow,
  'tpl-omnichannel-order': omnichannelOrderFlow,
  'tpl-pos-sale': posSaleFlow,
} satisfies Record<string, () => Flow>;
export type TemplateId = keyof typeof TEMPLATES;

/** The template a new flow for each model starts from. */
export const DEFAULT_TEMPLATE: Record<OrderModel, TemplateId> = {
  b2b: 'tpl-b2b-order',
  b2c: 'tpl-storefront-order',
  d2c: 'tpl-omnichannel-order',
  marketplace: 'tpl-marketplace-order',
  subscription: 'tpl-subscription',
  procurement: 'tpl-purchase-request',
  replenishment: 'tpl-reorder',
};

/** Every seeded template for a model. */
export function templatesFor(model: OrderModel): Flow[] {
  return Object.values(TEMPLATES)
    .map((t) => t())
    .filter((f) => f.model === model);
}
