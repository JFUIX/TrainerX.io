
CREATE TABLE IF NOT EXISTS member_profiles (user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, gym_id uuid NOT NULL REFERENCES gyms(id), membership_no bigint NOT NULL, joined_on date NOT NULL, full_name text NOT NULL, phone text NOT NULL, age integer NOT NULL CHECK(age BETWEEN 1 AND 120), residential_address text NOT NULL, amount numeric(12,2) NOT NULL CHECK(amount>=0), UNIQUE(gym_id,membership_no), FOREIGN KEY(gym_id,user_id) REFERENCES users(gym_id,id));
CREATE SEQUENCE IF NOT EXISTS member_number_seq;

ALTER TABLE member_profiles ADD COLUMN IF NOT EXISTS trainer_id uuid REFERENCES users(id);
ALTER TABLE member_profiles ADD COLUMN IF NOT EXISTS membership_months integer CHECK(membership_months BETWEEN 1 AND 120);

ALTER TABLE member_profiles ADD COLUMN IF NOT EXISTS emergency_name text;
ALTER TABLE member_profiles ADD COLUMN IF NOT EXISTS emergency_phone text;
ALTER TABLE member_profiles ADD COLUMN IF NOT EXISTS staff_notes text;

ALTER TABLE memberships ADD COLUMN IF NOT EXISTS total_price numeric(12,2) CHECK(total_price >= 0);
