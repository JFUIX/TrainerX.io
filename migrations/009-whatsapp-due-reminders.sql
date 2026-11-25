ALTER TABLE whatsapp_deliveries DROP CONSTRAINT IF EXISTS whatsapp_deliveries_kind_check;
ALTER TABLE whatsapp_deliveries ADD CONSTRAINT whatsapp_deliveries_kind_check
  CHECK (kind IN ('expiry','overdue','fee_due'));

CREATE OR REPLACE VIEW gym_whatsapp_alerts AS
WITH billing_windows AS (
  SELECT start::date AS month_start,(start+interval '1 month - 1 day')::date AS month_end
  FROM generate_series(date_trunc('month',CURRENT_DATE),
    date_trunc('month',CURRENT_DATE+3),interval '1 month') AS windows(start)
), due_fees AS (
  SELECT m.gym_id,m.member_id,m.id AS membership_id,'fee_due'::text AS kind,
    LEAST(w.month_end,m.ends_on) AS due_on,
    LEAST(remaining.total,installment.amount-paid.month_paid) AS amount
  FROM billing_windows w
  JOIN memberships m ON m.starts_on<=CURRENT_DATE AND m.starts_on<=w.month_end
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
  WHERE LEAST(w.month_end,m.ends_on) BETWEEN CURRENT_DATE AND CURRENT_DATE+3
)
SELECT gym_id,member_id,membership_id,kind,due_on,amount,email,full_name,whatsapp_phone
FROM gym_member_alerts WHERE kind='overdue' OR due_on<=CURRENT_DATE+3
UNION ALL
SELECT f.gym_id,f.member_id,f.membership_id,f.kind,f.due_on,f.amount,u.email,p.full_name,p.whatsapp_phone
FROM due_fees f
JOIN users u ON u.gym_id=f.gym_id AND u.id=f.member_id AND u.role='member' AND u.active
JOIN member_profiles p ON p.gym_id=f.gym_id AND p.user_id=f.member_id
WHERE f.amount>0;
