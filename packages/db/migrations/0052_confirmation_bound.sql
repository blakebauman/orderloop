-- What a confirmation is held to besides its input, set by the server that showed the preview:
-- for submit_cart, the cart's version, so a cart changed after the preview isn't submitted on
-- that confirm. Null for every other tool and every existing code; code that predates it ignores it.
ALTER TABLE action_confirmations ADD COLUMN bound TEXT;
