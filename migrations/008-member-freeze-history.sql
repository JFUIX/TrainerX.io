CREATE TABLE IF NOT EXISTS member_freeze_history (
  gym_id uuid NOT NULL,
  member_id uuid NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL CHECK (ends_on >= starts_on),
  PRIMARY KEY (gym_id, member_id, starts_on, ends_on),
  FOREIGN KEY (gym_id, member_id) REFERENCES users(gym_id, id) ON DELETE CASCADE
);
