DO $$
DECLARE
  target_gym uuid;
  test_count integer;
BEGIN
  SELECT id INTO STRICT target_gym FROM gyms WHERE name='CoreX' AND active;
  PERFORM pg_advisory_xact_lock(hashtext(target_gym::text));
  WITH demo AS (
    SELECT n, 'trainerx-corex-test-' || lpad(n::text,2,'0') || '@example.invalid' AS email,
      (ARRAY['Amina','Hamza','Zara','Bilal','Noor','Omar','Sana','Daniyal','Hira','Ibrahim'])[((n-1)%10)+1] ||
      ' ' || (ARRAY['Khan','Malik','Shah','Mirza','Siddiqui'])[((n-1)/10)+1] || ' (Test)' AS name
    FROM generate_series(1,50) AS seed(n)
  ), users_added AS (
    INSERT INTO users(gym_id,email,password_hash,role)
    SELECT target_gym,email,encode(gen_random_bytes(16),'hex') || ':' || encode(gen_random_bytes(64),'hex'),'member' FROM demo
    ON CONFLICT (email) DO NOTHING
    RETURNING id,email
  )
  INSERT INTO member_profiles(user_id,gym_id,membership_no,joined_on,full_name,phone,age,residential_address,amount)
  SELECT u.id,target_gym,nextval('member_number_seq'),CURRENT_DATE,d.name,'',18+(d.n*13)%43,'Test address',0
  FROM users_added u JOIN demo d USING (email);

  SELECT count(*) INTO test_count
  FROM users u JOIN member_profiles p ON p.user_id=u.id AND p.gym_id=u.gym_id
  WHERE u.gym_id=target_gym AND u.role='member'
    AND u.email ~ '^trainerx-corex-test-(0[1-9]|[1-4][0-9]|50)@example[.]invalid$';
  IF test_count<>50 THEN RAISE EXCEPTION 'Expected 50 CoreX test profiles, found %',test_count; END IF;
END $$;
