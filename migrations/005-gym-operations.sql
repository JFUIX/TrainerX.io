ALTER TABLE gyms ADD COLUMN IF NOT EXISTS subscription_plan text NOT NULL DEFAULT 'Standard';
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS subscription_until date;
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS whatsapp_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE member_profiles ADD COLUMN IF NOT EXISTS whatsapp_phone text;

CREATE TABLE IF NOT EXISTS member_freezes (
 gym_id uuid NOT NULL,
 member_id uuid NOT NULL,
 starts_on date NOT NULL,
 ends_on date NOT NULL CHECK (ends_on >= starts_on),
 PRIMARY KEY (gym_id,member_id),
 FOREIGN KEY (gym_id,member_id) REFERENCES users(gym_id,id)
);

CREATE TABLE IF NOT EXISTS gym_expenses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 gym_id uuid NOT NULL REFERENCES gyms(id),
 recorded_by uuid NOT NULL,
 incurred_on date NOT NULL,
 category text NOT NULL,
 description text NOT NULL DEFAULT '',
 amount numeric(12,2) NOT NULL CHECK (amount > 0),
 FOREIGN KEY (gym_id,recorded_by) REFERENCES users(gym_id,id)
);
CREATE INDEX IF NOT EXISTS gym_expenses_gym_date_idx ON gym_expenses(gym_id,incurred_on);
CREATE INDEX IF NOT EXISTS attendance_gym_date_idx ON attendance(gym_id,attended_on);
CREATE INDEX IF NOT EXISTS memberships_gym_member_end_idx ON memberships(gym_id,member_id,ends_on DESC);
CREATE INDEX IF NOT EXISTS profiles_gym_joined_idx ON member_profiles(gym_id,joined_on);

CREATE TABLE IF NOT EXISTS whatsapp_deliveries (
 gym_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('expiry','overdue')),
 due_on date NOT NULL,
 status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','sent','failed')),
 attempted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (gym_id,membership_id,kind,due_on),
 FOREIGN KEY (gym_id,membership_id) REFERENCES memberships(gym_id,id)
);

CREATE OR REPLACE VIEW gym_member_alerts AS
WITH terms AS (
 SELECT m.gym_id,m.member_id,m.id,m.starts_on,m.ends_on,COALESCE(m.total_price,p.price) AS price,
        date_trunc('month',m.starts_on)::date AS first_month,
        date_trunc('month',m.ends_on)::date AS last_month,
        LEAST(date_trunc('month',CURRENT_DATE)::date - interval '1 month',
              date_trunc('month',m.ends_on))::date AS overdue_through
 FROM memberships m JOIN plans p ON p.gym_id=m.gym_id AND p.id=m.plan_id
), months AS (
 SELECT t.*,
   (extract(year FROM last_month)-extract(year FROM first_month))*12+
    extract(month FROM last_month)-extract(month FROM first_month)+1 AS total_months,
   (extract(year FROM overdue_through)-extract(year FROM first_month))*12+
    extract(month FROM overdue_through)-extract(month FROM first_month)+1 AS overdue_months
 FROM terms t WHERE overdue_through >= first_month
), alerts AS (
 SELECT m.gym_id,m.member_id,m.id AS membership_id,'expiry'::text AS kind,m.ends_on AS due_on,
        NULL::numeric AS amount
 FROM memberships m
 WHERE m.ends_on BETWEEN CURRENT_DATE AND CURRENT_DATE+7
   AND NOT EXISTS (SELECT 1 FROM memberships n WHERE n.gym_id=m.gym_id AND n.member_id=m.member_id
                   AND (n.ends_on,n.id)>(m.ends_on,m.id))
 UNION ALL
 SELECT m.gym_id,m.member_id,m.id,'overdue',m.overdue_through,
        CASE WHEN overdue_months=total_months THEN price
             ELSE round(price/total_months,2)*overdue_months END -
        COALESCE((SELECT sum(f.amount) FROM fee_payments f WHERE f.gym_id=m.gym_id AND f.membership_id=m.id
                  AND (f.billing_month IS NULL OR f.billing_month<=m.overdue_through)),0)
 FROM months m
)
SELECT a.*,u.email,mp.full_name,mp.whatsapp_phone
FROM alerts a
JOIN users u ON u.gym_id=a.gym_id AND u.id=a.member_id AND u.active AND u.role='member'
LEFT JOIN member_profiles mp ON mp.gym_id=a.gym_id AND mp.user_id=a.member_id
WHERE a.kind='expiry' OR a.amount>0;
