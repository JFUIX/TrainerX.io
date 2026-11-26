ALTER TABLE gyms ADD COLUMN timezone text;
UPDATE gyms SET timezone=CASE WHEN currency='PKR' THEN 'Asia/Karachi' ELSE 'UTC' END;
ALTER TABLE gyms ALTER COLUMN timezone SET DEFAULT 'UTC', ALTER COLUMN timezone SET NOT NULL;

CREATE FUNCTION gym_timezone(gym uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT timezone FROM gyms WHERE id=gym),'UTC')
$$;
CREATE FUNCTION gym_today(gym uuid) RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE gym_timezone(gym))::date
$$;

-- Preserve historical rows when a gym changes time zone.
ALTER TABLE attendance DROP CONSTRAINT attendance_pkey,
  ADD PRIMARY KEY (gym_id,member_id,checked_at);
CREATE INDEX attendance_gym_checked_at_idx ON attendance(gym_id,checked_at);

CREATE FUNCTION enforce_gym_checkin_day() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  zone text := gym_timezone(NEW.gym_id);
  local_day date := (NEW.checked_at AT TIME ZONE zone)::date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.gym_id::text || ':' || NEW.member_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM attendance a WHERE a.gym_id=NEW.gym_id AND a.member_id=NEW.member_id
      AND a.checked_at >= (local_day::timestamp AT TIME ZONE zone)
      AND a.checked_at < ((local_day+1)::timestamp AT TIME ZONE zone)
  ) THEN
    RETURN NULL;
  END IF;
  NEW.attended_on := local_day;
  RETURN NEW;
END
$$;
CREATE TRIGGER attendance_one_per_gym_day
  BEFORE INSERT ON attendance FOR EACH ROW EXECUTE FUNCTION enforce_gym_checkin_day();

CREATE TABLE financial_requests (
  gym_id uuid NOT NULL REFERENCES gyms ON DELETE CASCADE,
  operation text NOT NULL,
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  payload jsonb NOT NULL,
  response jsonb,
  PRIMARY KEY(gym_id,operation,request_id)
);

ALTER TABLE whatsapp_deliveries
  ADD COLUMN attempts integer NOT NULL DEFAULT 1,
  ADD COLUMN next_attempt_at timestamptz;
CREATE INDEX whatsapp_deliveries_retry_idx ON whatsapp_deliveries(next_attempt_at)
  WHERE status='failed' AND next_attempt_at IS NOT NULL;

CREATE OR REPLACE VIEW gym_member_alerts AS
WITH terms AS (
 SELECT m.gym_id,m.member_id,m.id,m.starts_on,m.ends_on,COALESCE(m.total_price,p.price) AS price,
        date_trunc('month',m.starts_on)::date AS first_month,
        date_trunc('month',m.ends_on)::date AS last_month,
        LEAST(date_trunc('month',gym_today(m.gym_id))::date - interval '1 month',
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
 WHERE m.cancelled_on IS NULL AND m.ends_on BETWEEN gym_today(m.gym_id) AND gym_today(m.gym_id)+7
   AND NOT EXISTS (SELECT 1 FROM memberships n WHERE n.gym_id=m.gym_id AND n.member_id=m.member_id
                   AND n.cancelled_on IS NULL AND (n.ends_on,n.id)>(m.ends_on,m.id))
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

CREATE OR REPLACE VIEW gym_whatsapp_alerts AS
WITH billing_windows AS (
  SELECT g.id AS gym_id,start::date AS month_start,(start+interval '1 month - 1 day')::date AS month_end
  FROM gyms g CROSS JOIN LATERAL generate_series(date_trunc('month',gym_today(g.id)),
    date_trunc('month',gym_today(g.id)+3),interval '1 month') AS windows(start)
), due_fees AS (
  SELECT m.gym_id,m.member_id,m.id AS membership_id,'fee_due'::text AS kind,
    LEAST(w.month_end,m.ends_on) AS due_on,
    LEAST(remaining.total,installment.amount-paid.month_paid) AS amount
  FROM billing_windows w
  JOIN memberships m ON m.gym_id=w.gym_id AND m.starts_on<=gym_today(m.gym_id) AND m.starts_on<=w.month_end
    AND m.ends_on>=w.month_start AND m.cancelled_on IS NULL
  JOIN plans p ON p.gym_id=m.gym_id AND p.id=m.plan_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(m.total_price,p.price) AS price,
      LEAST(120,1+(extract(year FROM m.ends_on)-extract(year FROM m.starts_on))*12
        +extract(month FROM m.ends_on)-extract(month FROM m.starts_on)) AS months
  ) term
  CROSS JOIN LATERAL (
    SELECT COALESCE(sum(f.amount) FILTER (WHERE f.billing_month=w.month_start),0) AS month_paid,
      COALESCE(sum(f.amount),0) AS total_paid
    FROM fee_payments f WHERE f.gym_id=m.gym_id AND f.membership_id=m.id
  ) paid
  CROSS JOIN LATERAL (SELECT term.price-paid.total_paid AS total) remaining
  CROSS JOIN LATERAL (
    SELECT CASE WHEN date_trunc('month',m.ends_on)::date=w.month_start
      THEN term.price-round(term.price/term.months*(term.months-1),2)
      ELSE round(term.price/term.months,2) END AS amount
  ) installment
  WHERE LEAST(w.month_end,m.ends_on) BETWEEN gym_today(m.gym_id) AND gym_today(m.gym_id)+3
)
SELECT gym_id,member_id,membership_id,kind,due_on,amount,email,full_name,whatsapp_phone
FROM gym_member_alerts WHERE kind='overdue' OR due_on<=gym_today(gym_id)+3
UNION ALL
SELECT f.gym_id,f.member_id,f.membership_id,f.kind,f.due_on,f.amount,u.email,p.full_name,p.whatsapp_phone
FROM due_fees f
JOIN users u ON u.gym_id=f.gym_id AND u.id=f.member_id AND u.role='member' AND u.active
JOIN member_profiles p ON p.gym_id=f.gym_id AND p.user_id=f.member_id
WHERE f.amount>0;
