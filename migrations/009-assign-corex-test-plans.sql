DO $$
DECLARE
  target_gym uuid;
  plan_count integer;
  member_count integer;
  active_count integer;
BEGIN
  SELECT id INTO STRICT target_gym FROM gyms WHERE name='CoreX' AND active;
  PERFORM pg_advisory_xact_lock(hashtext(target_gym::text));

  SELECT count(*) INTO plan_count FROM plans WHERE gym_id=target_gym AND months BETWEEN 1 AND 120;
  IF plan_count=0 THEN RAISE EXCEPTION 'CoreX has no plans available'; END IF;

  SELECT count(*) INTO member_count
  FROM users u JOIN member_profiles p ON p.user_id=u.id AND p.gym_id=u.gym_id
  WHERE u.gym_id=target_gym AND u.role='member' AND u.active
    AND u.email ~ '^trainerx-corex-test-(0[1-9]|[1-4][0-9]|50)@example[.]invalid$';
  IF member_count<>50 THEN RAISE EXCEPTION 'Expected 50 CoreX test members, found %',member_count; END IF;

  WITH eligible_plans AS (
    SELECT id,months,price,row_number() OVER (ORDER BY name,id) AS position
    FROM plans WHERE gym_id=target_gym AND months BETWEEN 1 AND 120
  ), members_to_assign AS (
    SELECT u.id,row_number() OVER (ORDER BY u.email) AS position
    FROM users u JOIN member_profiles p ON p.user_id=u.id AND p.gym_id=u.gym_id
    WHERE u.gym_id=target_gym AND u.role='member' AND u.active
      AND u.email ~ '^trainerx-corex-test-(0[1-9]|[1-4][0-9]|50)@example[.]invalid$'
      AND NOT EXISTS (SELECT 1 FROM memberships m
        WHERE m.gym_id=target_gym AND m.member_id=u.id AND m.cancelled_on IS NULL
          AND CURRENT_DATE BETWEEN m.starts_on AND m.ends_on)
  ), assigned AS (
    INSERT INTO memberships(gym_id,member_id,plan_id,starts_on,ends_on,total_price)
    SELECT target_gym,u.id,p.id,CURRENT_DATE,
      (CURRENT_DATE+make_interval(months=>p.months)-interval '1 day')::date,p.price*p.months
    FROM members_to_assign u
    JOIN eligible_plans p ON p.position=(u.position-1)%plan_count+1
    RETURNING member_id,plan_id,total_price
  )
  UPDATE member_profiles profile SET amount=a.total_price,membership_months=p.months
  FROM assigned a JOIN eligible_plans p ON p.id=a.plan_id
  WHERE profile.gym_id=target_gym AND profile.user_id=a.member_id;

  SELECT count(*) INTO active_count
  FROM users u JOIN member_profiles p ON p.user_id=u.id AND p.gym_id=u.gym_id
  WHERE u.gym_id=target_gym AND u.role='member' AND u.active AND p.attendance_code IS NOT NULL
    AND u.email ~ '^trainerx-corex-test-(0[1-9]|[1-4][0-9]|50)@example[.]invalid$'
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.gym_id=target_gym AND m.member_id=u.id
      AND m.cancelled_on IS NULL AND CURRENT_DATE BETWEEN m.starts_on AND m.ends_on);
  IF active_count<>50 THEN RAISE EXCEPTION 'Expected 50 current test memberships with codes, found %',active_count; END IF;
END $$;
