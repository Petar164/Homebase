-- 0005: which model answered and why, and a cloud budget that holds up
-- under crashes and requests running at the same time.

-- Why the router chose the model that wrote this message.
ALTER TABLE messages ADD COLUMN route_reason TEXT;

-- 1 when the cost of a call is an estimate, because the core stopped before
-- the real usage came back. Estimates are deliberately on the high side.
ALTER TABLE egress_log ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0;

-- Money set aside for a cloud call that is in progress. The budget check
-- counts reservations as already spent, so two requests at once cannot both
-- slip under the cap. A reservation becomes an egress_log row when the call
-- ends, with what it really cost.
CREATE TABLE cloud_reservations (
  id              TEXT PRIMARY KEY,
  at              TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  purpose         TEXT NOT NULL,
  max_sensitivity TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  estimate_micros INTEGER NOT NULL,
  conversation_id TEXT REFERENCES conversations (id)
) STRICT;
