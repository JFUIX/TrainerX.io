ALTER TABLE users ADD COLUMN disabled_owner_reminders text[] NOT NULL DEFAULT '{}';

CREATE TABLE owner_reminder_state (
  gym_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('expiry','overdue','fee_due')),
  due_on date NOT NULL,
  status text NOT NULL CHECK (status IN ('read','unread','done')),
  PRIMARY KEY (gym_id,owner_id,membership_id,kind,due_on),
  FOREIGN KEY (gym_id,owner_id) REFERENCES users(gym_id,id) ON DELETE CASCADE,
  FOREIGN KEY (gym_id,membership_id) REFERENCES memberships(gym_id,id) ON DELETE CASCADE
);
