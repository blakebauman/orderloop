-- Payments through Stripe (PAYMENTS_MODE=stripe). Each payment row records who processed it and
-- the processor's id for it (a PaymentIntent or Refund), so a void, capture or refund reaches the
-- same object. Existing rows were made by the mock gateway.
ALTER TABLE payments ADD COLUMN provider TEXT NOT NULL DEFAULT 'mock';
ALTER TABLE payments ADD COLUMN external_id TEXT;
ALTER TABLE payments ADD COLUMN currency TEXT;
CREATE INDEX payments_external ON payments(external_id) WHERE external_id IS NOT NULL;

-- A customer's Stripe customer and the card a `verify` authorization saved for later charges.
ALTER TABLE customers ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE customers ADD COLUMN stripe_payment_method_id TEXT;
CREATE UNIQUE INDEX customers_stripe_customer ON customers(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
