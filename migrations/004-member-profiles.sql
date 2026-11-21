
CREATE TABLE IF NOT EXISTS member_profiles (user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, gym_id uuid NOT NULL REFERENCES gyms(id), membership_no bigint NOT NULL, joined_on date NOT NULL, full_name text NOT NULL, phone text NOT NULL, age integer NOT NULL CHECK(age BETWEEN 1 AND 120), residential_address text NOT NULL, amount numeric(12,2) NOT NULL CHECK(amount>=0), UNIQUE(gym_id,membership_no), FOREIGN KEY(gym_id,user_id) REFERENCES users(gym_id,id));
CREATE SEQUENCE IF NOT EXISTS member_number_seq;
