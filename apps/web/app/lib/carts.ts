/** What the Carts list can tell about a cart from its D1 row alone. */

/**
 * Whether a CartAgent holds this cart, judged by its id: the engine names every cart it makes
 * `newId('cart')` (`cart_` then one run of base-36), and writes the index row from that agent.
 * A row written straight to D1 under any other id (the volume seed's `cart_bench_…`) has no agent
 * behind it, so its page would only say "Not found". Asking each agent would wake one Durable
 * Object per row of a 200-row list; the id answers for free.
 */
export const cartOpens = (id: string) => /^cart_[0-9a-z]+$/.test(id);
