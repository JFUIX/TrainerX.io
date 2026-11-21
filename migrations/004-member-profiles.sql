
CREATE TABLE IF NOT EXISTS member_profiles (user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, gym_id uuid NOT NULL REFERENCES gyms(id), membership_no bigint NOT NULL, joined_on date NOT NULL, full_name text NOT NULL, phone text NOT NULL, age integer NOT NULL CHECK(age BETWEEN 1 AND 120), residential_address text NOT NULL, amount numeric(12,2) NOT NULL CHECK(amount>=0), UNIQUE(gym_id,membership_no), FOREIGN KEY(gym_id,user_id) REFERENCES users(gym_id,id));
CREATE SEQUENCE IF NOT EXISTS member_number_seq;

ALTER TABLE member_profiles ADD COLUMN IF NOT EXISTS trainer_id uuid REFERENCES users(id);
ALTER TABLE member_profiles ADD COLUMN IF NOT EXISTS membership_months integer CHECK(membership_months BETWEEN 1 AND 120);

ALTER TABLE member_profiles ADD COLUMN IF NOT EXISTS emergency_name text;
ALTER TABLE member_profiles ADD COLUMN IF NOT EXISTS emergency_phone text;
ALTER TABLE member_profiles ADD COLUMN IF NOT EXISTS staff_notes text;

ALTER TABLE memberships ADD COLUMN IF NOT EXISTS total_price numeric(12,2) CHECK(total_price >= 0);

-- Track the billing month separately from payment timestamp; preserve historical payment records.
ALTER TABLE fee_payments ADD COLUMN IF NOT EXISTS billing_month date;
ALTER TABLE fee_payments DROP CONSTRAINT IF EXISTS fee_payments_method_check;
ALTER TABLE fee_payments ADD CONSTRAINT fee_payments_method_check CHECK (method IN ('cash','bank_transfer','online_payment','upi','other'));
CREATE INDEX IF NOT EXISTS fee_payments_billing_month_idx ON fee_payments(gym_id,membership_id,billing_month);

ALTER TABLE member_profiles ADD COLUMN IF NOT EXISTS attendance_code char(4);
CREATE UNIQUE INDEX IF NOT EXISTS member_profiles_gym_attendance_code_idx ON member_profiles(gym_id,attendance_code) WHERE attendance_code IS NOT NULL;

-- Assign unique four-digit codes to members registered before code-based check-in.
WITH missing AS (
 SELECT user_id,gym_id,row_number() OVER(PARTITION BY gym_id ORDER BY membership_no,user_id) AS rn
 FROM member_profiles WHERE attendance_code IS NULL
), available AS (
 SELECT g.id AS gym_id,lpad(n::text,4,'0') AS code,
 row_number() OVER(PARTITION BY g.id ORDER BY n) AS rn
 FROM gyms g CROSS JOIN generate_series(0,9999) n
 WHERE NOT EXISTS (SELECT 1 FROM member_profiles mp WHERE mp.gym_id=g.id AND mp.attendance_code=lpad(n::text,4,'0'))
)
UPDATE member_profiles mp SET attendance_code=a.code
FROM missing m JOIN available a ON a.gym_id=m.gym_id AND a.rn=m.rn
WHERE mp.user_id=m.user_id;
