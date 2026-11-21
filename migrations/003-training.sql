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
