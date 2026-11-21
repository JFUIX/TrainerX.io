CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE gyms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, currency char(3) NOT NULL DEFAULT 'PKR', active boolean NOT NULL DEFAULT true);
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), gym_id uuid REFERENCES gyms, email text UNIQUE NOT NULL, password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('superadmin','owner','reception','trainer','member')), CHECK ((role='superadmin')=(gym_id IS NULL)), active boolean NOT NULL DEFAULT true);
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, expires_at timestamptz NOT NULL);
CREATE INDEX ON sessions(expires_at);
CREATE TABLE plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), gym_id uuid NOT NULL REFERENCES gyms, name text NOT NULL, months integer NOT NULL CHECK(months>0), price numeric(12,2) NOT NULL CHECK(price>=0), UNIQUE(gym_id,id));
CREATE TABLE memberships (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), gym_id uuid NOT NULL REFERENCES gyms, member_id uuid NOT NULL REFERENCES users, plan_id uuid NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL CHECK(ends_on>=starts_on), FOREIGN KEY(gym_id,plan_id) REFERENCES plans(gym_id,id));
CREATE TABLE attendance (gym_id uuid NOT NULL REFERENCES gyms, member_id uuid NOT NULL REFERENCES users, attended_on date NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(gym_id,member_id,attended_on));
ALTER TABLE users ADD UNIQUE(gym_id,id);
ALTER TABLE memberships ADD FOREIGN KEY(gym_id,member_id) REFERENCES users(gym_id,id);
ALTER TABLE attendance ADD FOREIGN KEY(gym_id,member_id) REFERENCES users(gym_id,id);

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

CREATE TABLE IF NOT EXISTS workout_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), gym_id uuid NOT NULL REFERENCES gyms(id),
 member_id uuid NOT NULL, trainer_id uuid NOT NULL, title text NOT NULL CHECK(length(title)<=120),
 exercises jsonb NOT NULL CHECK(jsonb_typeof(exercises)='array'),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(gym_id,member_id) REFERENCES users(gym_id,id),
 FOREIGN KEY(gym_id,trainer_id) REFERENCES users(gym_id,id)
);
CREATE INDEX IF NOT EXISTS workout_member_idx ON workout_plans(gym_id,member_id);
CREATE TABLE IF NOT EXISTS diet_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), gym_id uuid NOT NULL REFERENCES gyms(id),
 member_id uuid NOT NULL, trainer_id uuid NOT NULL, title text NOT NULL CHECK(length(title)<=120),
 meals jsonb NOT NULL CHECK(jsonb_typeof(meals)='array'),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(gym_id,member_id) REFERENCES users(gym_id,id),
 FOREIGN KEY(gym_id,trainer_id) REFERENCES users(gym_id,id)
);
CREATE INDEX IF NOT EXISTS diet_member_idx ON diet_plans(gym_id,member_id);

CREATE TABLE IF NOT EXISTS member_profiles (user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, gym_id uuid NOT NULL REFERENCES gyms(id), membership_no bigint NOT NULL, joined_on date NOT NULL, full_name text NOT NULL, phone text NOT NULL, age integer NOT NULL CHECK(age BETWEEN 1 AND 120), residential_address text NOT NULL, amount numeric(12,2) NOT NULL CHECK(amount>=0), UNIQUE(gym_id,membership_no), FOREIGN KEY(gym_id,user_id) REFERENCES users(gym_id,id));
CREATE SEQUENCE IF NOT EXISTS member_number_seq;
