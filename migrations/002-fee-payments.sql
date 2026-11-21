-- Run against existing databases before deploying the payment API.
CREATE TABLE IF NOT EXISTS fee_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 gym_id uuid NOT NULL REFERENCES gyms(id),
 membership_id uuid NOT NULL REFERENCES memberships(id),
 amount numeric(12,2) NOT NULL CHECK (amount > 0),
 method text NOT NULL CHECK (method IN ('cash','bank_transfer','upi','other')),
 reference text,
 recorded_by uuid NOT NULL REFERENCES users(id),
 paid_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fee_payments_gym_paid_at_idx ON fee_payments(gym_id,paid_at);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_gym_id_id_idx ON memberships(gym_id,id);
ALTER TABLE fee_payments DROP CONSTRAINT IF EXISTS fee_payments_tenant_membership_fk;
ALTER TABLE fee_payments ADD CONSTRAINT fee_payments_tenant_membership_fk FOREIGN KEY (gym_id,membership_id) REFERENCES memberships(gym_id,id);
