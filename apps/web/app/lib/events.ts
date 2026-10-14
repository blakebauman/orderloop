/**
 * Outside events in the words of the people who handle them. A flow names an event with a key
 * (`pickup.collected`); staff see what it means and what to do. Keys a custom flow invents fall
 * back to the key itself.
 */
const EVENTS: Record<string, { waiting: string; short: string; action?: string }> = {
  'payment.received': {
    waiting: 'the customer’s payment',
    short: 'Payment',
    action: 'Record payment',
  },
  'pickup.collected': {
    waiting: 'the customer to collect the order',
    short: 'Customer collects',
    action: 'Mark as collected',
  },
  'return.requested': {
    waiting: 'a return request from the customer',
    short: 'Return request',
    action: 'Record a return request',
  },
  'return.received': {
    waiting: 'the returned goods to arrive',
    short: 'Returned goods',
    action: 'Mark return received',
  },
  'supplier.ack': {
    waiting: 'the supplier to acknowledge the order',
    short: 'Supplier acknowledgement',
    action: 'Record acknowledgement',
  },
  'goods.received': {
    waiting: 'the goods to arrive',
    short: 'Goods receipt',
    action: 'Mark goods received',
  },
  'customer.reply': {
    waiting: 'the customer’s reply',
    short: 'Customer reply',
    action: 'Record the reply',
  },
  'seller.responded': { waiting: 'each seller to accept their part', short: 'Seller responses' },
};

/** "Waiting for {this}": the customer's payment. */
export const eventWaiting = (key: string) => EVENTS[key]?.waiting ?? key;
/** A list label: "Payment". */
export const eventShort = (key: string) => EVENTS[key]?.short ?? key;
/** The button that records it by hand: "Record payment". */
export const eventAction = (key: string) => EVENTS[key]?.action ?? `Record ${key}`;
