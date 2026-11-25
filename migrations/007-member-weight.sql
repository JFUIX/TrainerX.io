ALTER TABLE member_profiles ADD COLUMN IF NOT EXISTS weight_kg numeric(4,1)
  CHECK (weight_kg > 0 AND weight_kg <= 500);
