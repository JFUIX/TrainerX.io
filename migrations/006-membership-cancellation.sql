ALTER TABLE memberships ADD COLUMN IF NOT EXISTS cancelled_on date;

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
 WHERE m.cancelled_on IS NULL AND m.ends_on BETWEEN CURRENT_DATE AND CURRENT_DATE+7
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
