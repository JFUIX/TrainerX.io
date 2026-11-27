const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const isoDate = value => typeof value === 'string' && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const owner = (req,res,next) => req.user.role === 'owner' ? next() : res.sendStatus(403);
const staff = (req,res,next) => ['owner','reception'].includes(req.user.role) ? next() : res.sendStatus(403);
const platform = (req,res,next) => req.user.role === 'superadmin' ? next() : res.sendStatus(403);
const categories = ['Rent','Payroll','Utilities','Equipment','Marketing','Other'];
const phoneNumber = value => typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value);

export const gymAccess = 'g.active AND (g.subscription_until IS NULL OR g.subscription_until >= (now() AT TIME ZONE g.timezone)::date)';
export const memberCanCheckIn = (gym,member) => `NOT EXISTS (
  SELECT 1 FROM member_freezes f
  WHERE f.gym_id=${gym} AND f.member_id=${member} AND gym_today(${gym}) BETWEEN f.starts_on AND f.ends_on
)`;

// The claim and the financial write must commit in the same transaction.
export async function claimFinancialRequest(client,req,operation,payload){
  const requestId=req.body.request_id;
  if(requestId===undefined)return {};
  const key=[req.user.gym_id,operation,requestId,req.user.id,JSON.stringify(payload)];
  const claim=await client.query(
    `INSERT INTO financial_requests(gym_id,operation,request_id,actor_id,payload)
     VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`, key);
  if(claim.rowCount)return {key:key.slice(0,3)};
  const {rows:[previous]}=await client.query(
    `SELECT response,actor_id=$4 AND payload=$5::jsonb AS matches FROM financial_requests
     WHERE gym_id=$1 AND operation=$2 AND request_id=$3`,key);
  return previous?.matches?{response:previous.response}:{conflict:true};
}

export async function completeFinancialRequest(client,claim,response){
  if(claim.key)await client.query(
    'UPDATE financial_requests SET response=$4::jsonb WHERE gym_id=$1 AND operation=$2 AND request_id=$3',
    [...claim.key,JSON.stringify(response)]);
}

export function registerGymOperations(app,db,auth) {
  const privateData = (req,res,next) => {res.set('Cache-Control','no-store');next()};

  app.get('/gym-account',auth,owner,privateData,async (req,res) => {
    const {rows:[gym]} = await db.query(`SELECT name,currency,timezone,subscription_plan,
      subscription_until::text,whatsapp_enabled FROM gyms WHERE id=$1`,[req.user.gym_id]);
    res.json({...gym,...await reminderStatus(req.user.gym_id)});
  });

  async function reminderStatus(gymId){
    const {rows:reminders}=await db.query(`SELECT CASE WHEN status='failed' AND next_attempt_at IS NOT NULL
      THEN 'retrying' ELSE status END AS status,count(*)::int AS total FROM whatsapp_deliveries
      WHERE gym_id=$1 AND attempted_at>=now()-interval '30 days' GROUP BY 1 ORDER BY 1`,[gymId]);
    const config=whatsappConfig();
    return {reminders,whatsapp_configured:Boolean(config),whatsapp_fee_due_configured:Boolean(config?.templates.fee_due)};
  }

  app.get('/reminder-status',auth,staff,privateData,async (req,res)=>{
    res.json(await reminderStatus(req.user.gym_id));
  });

  app.patch('/gym-account',auth,owner,privateData,async (req,res) => {
    const name=typeof req.body?.name==='string'?req.body.name.trim():'';
    if(!name||name.length>120||/[\r\n\t]/.test(name))return res.status(400).json({error:'Enter a gym name up to 120 characters.'});
    const {rows:[gym]}=await db.query('UPDATE gyms SET name=$2 WHERE id=$1 RETURNING name',[req.user.gym_id,name]);
    if(!gym)return res.sendStatus(404);
    res.json(gym);
  });

  app.put('/gym-account/timezone',auth,owner,privateData,async (req,res) => {
    const {timezone}=req.body||{};
    if(typeof timezone!=='string'||timezone.length>80)return res.status(400).json({error:'Enter a valid time zone.'});
    const result=await db.query(`UPDATE gyms SET timezone=$2 WHERE id=$1
      AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=$2) RETURNING timezone`,[req.user.gym_id,timezone]);
    if(!result.rowCount)return res.status(400).json({error:'Enter an IANA time zone, such as Asia/Karachi.'});
    res.json(result.rows[0]);
  });

  app.patch('/gyms/:id/subscription',auth,platform,async (req,res) => {
    const {plan,paid_through,active} = req.body || {};
    if (!uuid(req.params.id) || typeof plan !== 'string' || !plan.trim() || plan.length > 80 ||
        (paid_through !== null && !isoDate(paid_through)) || typeof active !== 'boolean') return res.sendStatus(400);
    const result = await db.query(`UPDATE gyms SET subscription_plan=$2,subscription_until=$3,active=$4
      WHERE id=$1 RETURNING id,subscription_plan,subscription_until::text,active`,
    [req.params.id,plan.trim(),paid_through,active]);
    if (!result.rowCount) return res.sendStatus(404);
    res.json(result.rows[0]);
  });

  app.patch('/staff/:id',auth,owner,async (req,res) => {
    const {role,active} = req.body || {};
    if (!uuid(req.params.id) || !['reception','trainer'].includes(role) || typeof active !== 'boolean') return res.sendStatus(400);
    const result = await db.query(`WITH updated AS (
      UPDATE users SET role=$3,active=$4 WHERE gym_id=$1 AND id=$2 AND role IN ('reception','trainer')
      RETURNING id,email,role,active
    ), invalidated AS (DELETE FROM sessions WHERE user_id IN (SELECT id FROM updated))
    SELECT * FROM updated`,[req.user.gym_id,req.params.id,role,active]);
    if (!result.rowCount) return res.sendStatus(404);
    res.json(result.rows[0]);
  });

  app.get('/members/:id/freeze',auth,staff,privateData,async (req,res) => {
    if (!uuid(req.params.id)) return res.sendStatus(400);
    const result = await db.query(`SELECT f.starts_on::text,f.ends_on::text FROM users u
      LEFT JOIN member_freezes f ON f.gym_id=u.gym_id AND f.member_id=u.id
      WHERE u.gym_id=$1 AND u.id=$2 AND u.role='member'`,[req.user.gym_id,req.params.id]);
    if (!result.rowCount) return res.sendStatus(404);
    res.json(result.rows[0]);
  });

  app.put('/members/:id/freeze',auth,staff,async (req,res) => {
    const {starts_on,ends_on} = req.body || {};
    if (!uuid(req.params.id) || !isoDate(starts_on) || !isoDate(ends_on) || ends_on < starts_on) return res.sendStatus(400);
    const result = await db.query(`INSERT INTO member_freezes(gym_id,member_id,starts_on,ends_on)
      SELECT gym_id,id,$3,$4 FROM users WHERE gym_id=$1 AND id=$2 AND role='member'
      ON CONFLICT (gym_id,member_id) DO UPDATE SET starts_on=EXCLUDED.starts_on,ends_on=EXCLUDED.ends_on
      RETURNING starts_on::text,ends_on::text`,[req.user.gym_id,req.params.id,starts_on,ends_on]);
    if (!result.rowCount) return res.sendStatus(404);
    res.json(result.rows[0]);
  });

  app.patch('/members/:id/freeze',auth,staff,async (req,res) => {
    const {frozen}=req.body||{};
    if (!uuid(req.params.id) || typeof frozen!=='boolean') return res.sendStatus(400);
    const args=[req.user.gym_id,req.params.id];
    if (frozen) {
      const result=await db.query(`WITH eligible AS (
        SELECT u.gym_id,u.id,max(m.ends_on) AS ends_on
        FROM users u JOIN memberships m ON m.gym_id=u.gym_id AND m.member_id=u.id
        WHERE u.gym_id=$1 AND u.id=$2 AND u.role='member' AND u.active
          AND m.cancelled_on IS NULL AND gym_today($1) BETWEEN m.starts_on AND m.ends_on
        GROUP BY u.gym_id,u.id
      ), archived AS (
        INSERT INTO member_freeze_history(gym_id,member_id,starts_on,ends_on)
        SELECT f.gym_id,f.member_id,f.starts_on,f.ends_on
        FROM member_freezes f JOIN eligible e ON e.gym_id=f.gym_id AND e.id=f.member_id
        WHERE f.ends_on<gym_today($1)
        ON CONFLICT DO NOTHING
      )
        INSERT INTO member_freezes(gym_id,member_id,starts_on,ends_on)
        SELECT gym_id,id,gym_today($1),ends_on FROM eligible
        ON CONFLICT (gym_id,member_id) DO UPDATE SET
          starts_on=CASE WHEN gym_today($1) BETWEEN member_freezes.starts_on AND member_freezes.ends_on
            THEN member_freezes.starts_on ELSE EXCLUDED.starts_on END,
          ends_on=GREATEST(member_freezes.ends_on,EXCLUDED.ends_on)`,args);
      if (!result.rowCount) return res.status(404).json({error:'No active membership to freeze'});
    } else {
      const result=await db.query(`WITH shortened AS (
        UPDATE member_freezes SET ends_on=gym_today($1)-1
        WHERE gym_id=$1 AND member_id=$2 AND starts_on<gym_today($1) AND ends_on>=gym_today($1)
      ), cleared AS (
        DELETE FROM member_freezes WHERE gym_id=$1 AND member_id=$2 AND starts_on=gym_today($1)
      )
      SELECT 1 FROM users WHERE gym_id=$1 AND id=$2 AND role='member'`,args);
      if (!result.rowCount) return res.sendStatus(404);
    }
    res.json({frozen});
  });

  app.delete('/members/:id/freeze',auth,staff,async (req,res) => {
    if (!uuid(req.params.id)) return res.sendStatus(400);
    await db.query('DELETE FROM member_freezes WHERE gym_id=$1 AND member_id=$2',[req.user.gym_id,req.params.id]);
    res.sendStatus(204);
  });

  app.get('/alerts',auth,staff,privateData,async (req,res) => {
    const {rows} = await db.query(`SELECT a.member_id,a.kind,a.due_on::text,a.amount,a.email,a.full_name,g.currency
      FROM gym_member_alerts a JOIN gyms g ON g.id=a.gym_id WHERE a.gym_id=$1 ORDER BY a.kind,a.due_on,a.email`,[req.user.gym_id]);
    res.json(rows);
  });

  const reminderKinds=['expiry','overdue','fee_due'];
  const reminderQuery=`SELECT membership_id,member_id,kind,due_on,amount,full_name
    FROM gym_member_alerts WHERE gym_id=$1
    UNION ALL
    SELECT membership_id,member_id,kind,due_on,amount,full_name
    FROM gym_whatsapp_alerts WHERE gym_id=$1 AND kind='fee_due'`;

  app.get('/owner-notifications',auth,owner,privateData,async (req,res) => {
    const {rows:[{disabled_owner_reminders:disabled}]}=await db.query(
      'SELECT disabled_owner_reminders FROM users WHERE gym_id=$1 AND id=$2',[req.user.gym_id,req.user.id]);
    const {rows}=await db.query(`WITH reminders AS (${reminderQuery}), matched AS (
      SELECT r.membership_id,r.member_id,r.kind,r.due_on::text,r.amount,
        COALESCE(NULLIF(r.full_name,''),'Member '||COALESCE(p.membership_no::text,'(no profile)')) AS member,
        g.currency,COALESCE(s.status,'unread') AS status
      FROM reminders r CROSS JOIN gyms g
      LEFT JOIN member_profiles p ON p.gym_id=g.id AND p.user_id=r.member_id
      LEFT JOIN owner_reminder_state s ON s.gym_id=g.id AND s.owner_id=$2
        AND (s.membership_id,s.kind,s.due_on)=(r.membership_id,r.kind,r.due_on)
      WHERE g.id=$1 AND NOT (r.kind=ANY($3::text[]))
    )
    SELECT *,count(*) OVER ()::int AS reminder_count,
      (count(*) FILTER (WHERE status='unread') OVER ())::int AS unread_count
    FROM matched WHERE CASE WHEN $4::boolean THEN status='done' ELSE status<>'done' END
    ORDER BY (status='unread') DESC,CASE kind WHEN 'overdue' THEN 1 WHEN 'fee_due' THEN 2 ELSE 3 END,
      due_on,membership_id LIMIT 60`,[req.user.gym_id,req.user.id,disabled,req.query.done==='true']);
    res.json({total:rows[0]?.reminder_count??0,unread:rows[0]?.unread_count??0,disabled,
      items:rows.map(({reminder_count,unread_count,...item})=>item)});
  });

  app.put('/owner-notifications/preferences',auth,owner,privateData,async (req,res) => {
    const {disabled}=req.body||{};
    if(!Array.isArray(disabled)||disabled.length>reminderKinds.length||
      new Set(disabled).size!==disabled.length||disabled.some(kind=>!reminderKinds.includes(kind)))
      return res.status(400).json({error:'Invalid reminder preferences'});
    await db.query('UPDATE users SET disabled_owner_reminders=$3 WHERE gym_id=$1 AND id=$2',
      [req.user.gym_id,req.user.id,disabled]);
    res.json({disabled});
  });

  app.put('/owner-notifications/status',auth,owner,privateData,async (req,res) => {
    const {membership_id,kind,due_on,status}=req.body||{};
    if(typeof membership_id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(membership_id)||
      !reminderKinds.includes(kind)||!isoDate(due_on)||!['read','unread','done'].includes(status))
      return res.status(400).json({error:'Invalid reminder status'});
    const result=await db.query(`WITH reminders AS (${reminderQuery})
      INSERT INTO owner_reminder_state(gym_id,owner_id,membership_id,kind,due_on,status)
      SELECT $1,$2,membership_id,kind,due_on,$6 FROM reminders
      WHERE membership_id=$3 AND kind=$4 AND due_on=$5
      ON CONFLICT (gym_id,owner_id,membership_id,kind,due_on) DO UPDATE SET status=EXCLUDED.status`,
      [req.user.gym_id,req.user.id,membership_id,kind,due_on,status]);
    if(!result.rowCount)return res.status(404).json({error:'This reminder is no longer active'});
    res.json({status});
  });

  app.post('/expenses',auth,owner,async (req,res) => {
    const {incurred_on,category,description='',amount} = req.body || {};
    if (!isoDate(incurred_on) || !categories.includes(category) || typeof description !== 'string' ||
        description.length > 500 || typeof amount !== 'number' || !Number.isFinite(amount) ||
        amount < 0.01 || amount > 100000000 || Number(amount.toFixed(2)) !== amount) return res.sendStatus(400);
    if(req.body.request_id!==undefined&&!uuid(req.body.request_id))return res.sendStatus(400);
    const payload={incurred_on,category,description:description.trim(),amount};
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      const claim=await claimFinancialRequest(client,req,'expense',payload);
      if(claim.conflict){
        await client.query('ROLLBACK');
        return res.status(409).json({error:'This submission ID was already used for a different expense.'});
      }
      if(claim.response){
        await client.query('COMMIT');
        return res.status(201).json(claim.response);
      }
      const {rows:[expense]}=await client.query(`INSERT INTO gym_expenses(gym_id,recorded_by,incurred_on,category,description,amount)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,[req.user.gym_id,req.user.id,incurred_on,category,payload.description,amount]);
      await completeFinancialRequest(client,claim,expense);
      await client.query('COMMIT');
      res.status(201).json(expense);
    }catch(error){
      await client.query('ROLLBACK');
      throw error;
    }finally{client.release()}
  });

  app.get('/financial-report',auth,owner,privateData,async (req,res) => {
    const {from,to} = req.query;
    if (!isoDate(from) || !isoDate(to) || to < from || Date.parse(to)-Date.parse(from) > 365*86400000) return res.sendStatus(400);
    const {rows} = await db.query(`SELECT * FROM (
      SELECT (f.paid_at AT TIME ZONE gym_timezone($1))::date::text AS date,'Payment' AS type,f.id,f.method AS category,u.email AS description,f.amount
      FROM fee_payments f JOIN memberships m ON m.gym_id=f.gym_id AND m.id=f.membership_id
      JOIN users u ON u.gym_id=m.gym_id AND u.id=m.member_id
      WHERE f.gym_id=$1 AND f.paid_at >= ($2::date::timestamp AT TIME ZONE gym_timezone($1))
        AND f.paid_at < (($3::date+1)::timestamp AT TIME ZONE gym_timezone($1))
      UNION ALL
      SELECT incurred_on::text,'Expense',id,category,description,amount FROM gym_expenses
      WHERE gym_id=$1 AND incurred_on BETWEEN $2 AND $3
    ) entries ORDER BY date DESC,id`,[req.user.gym_id,from,to]);
    const totals = rows.reduce((sum,row) => {
      sum[row.type] += Math.round(Number(row.amount)*100);
      return sum;
    },{Payment:0,Expense:0});
    res.json({entries:rows,revenue:totals.Payment/100,expenses:totals.Expense/100,net:(totals.Payment-totals.Expense)/100});
  });

  app.get('/membership-trends',auth,owner,privateData,async (req,res) => {
    const {rows} = await db.query(`WITH months AS (
      SELECT start::date AS month,(start-interval '1 day')::date AS opening,
             LEAST((start+interval '1 month - 1 day')::date,gym_today($1)) AS closing
      FROM generate_series(date_trunc('month',gym_today($1))-interval '5 months',
                           date_trunc('month',gym_today($1)),interval '1 month') start
    )
    SELECT to_char(d.month,'YYYY-MM') AS month,
      (SELECT count(*)::int FROM member_profiles p WHERE p.gym_id=$1 AND p.joined_on BETWEEN d.month AND d.closing) AS joined,
      (SELECT count(*)::int FROM attendance a WHERE a.gym_id=$1 AND a.checked_at >= (d.month::timestamp AT TIME ZONE gym_timezone($1))
        AND a.checked_at < ((d.closing+1)::timestamp AT TIME ZONE gym_timezone($1))) AS visits,
      cohort.opening,cohort.retained
    FROM months d CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE at_open)::int AS opening,
             count(*) FILTER (WHERE at_open AND at_close)::int AS retained
      FROM (
        SELECT m.member_id,
               bool_or(d.opening BETWEEN m.starts_on AND m.ends_on AND (m.cancelled_on IS NULL OR d.opening<m.cancelled_on)) AS at_open,
               bool_or(d.closing BETWEEN m.starts_on AND m.ends_on AND (m.cancelled_on IS NULL OR d.closing<m.cancelled_on)) AS at_close
        FROM memberships m WHERE m.gym_id=$1 AND m.ends_on>=d.opening AND m.starts_on<=d.closing
        GROUP BY m.member_id
      ) active
    ) cohort ORDER BY d.month`,[req.user.gym_id]);
    res.json(rows);
  });

  app.put('/gym-account/whatsapp',auth,owner,async (req,res) => {
    const {enabled} = req.body || {};
    if (typeof enabled !== 'boolean') return res.sendStatus(400);
    if (enabled && !whatsappConfig()) return res.status(409).json({error:'WhatsApp is not configured for this installation.'});
    await db.query('UPDATE gyms SET whatsapp_enabled=$2 WHERE id=$1',[req.user.gym_id,enabled]);
    res.sendStatus(204);
  });

  app.put('/members/:id/whatsapp',auth,staff,async (req,res) => {
    const {phone} = req.body || {};
    if (!uuid(req.params.id) || (phone !== null && !phoneNumber(phone))) return res.sendStatus(400);
    const result = await db.query('UPDATE member_profiles SET whatsapp_phone=$3 WHERE gym_id=$1 AND user_id=$2',
      [req.user.gym_id,req.params.id,phone]);
    res.sendStatus(result.rowCount ? 204 : 404);
  });
}

function whatsappConfig() {
  const {WHATSAPP_TOKEN:token,WHATSAPP_PHONE_ID:phone,WHATSAPP_API_VERSION:version,
    WHATSAPP_EXPIRY_TEMPLATE:expiry,WHATSAPP_OVERDUE_TEMPLATE:overdue,WHATSAPP_FEE_DUE_TEMPLATE:fee_due,
    WHATSAPP_PERSONALIZED_FEE_DUE_TEMPLATE:personalizedFee,WHATSAPP_TEMPLATE_LANGUAGE:language='en'} = process.env;
  const templates={expiry,overdue,fee_due:personalizedFee||fee_due};
  const kinds=Object.keys(templates).filter(kind=>templates[kind]);
  if (!token || !/^\d+$/.test(phone||'') || !/^v\d+\.\d+$/.test(version||'') || !kinds.length) return null;
  return {token,phone,version,templates,kinds,personalizedFee:Boolean(personalizedFee),language};
}

export function startWhatsAppReminders(db) {
  const config = whatsappConfig();
  if (!config) return;
  const maxAttempts=4;
  const retryable=`d.attempts<$2 AND (
    (d.status='failed' AND d.next_attempt_at<=now()) OR
    (d.status='sending' AND d.attempted_at<=now()-interval '15 minutes')
  )`;
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    try {
      await db.query(`UPDATE whatsapp_deliveries SET status='failed',next_attempt_at=NULL
        WHERE status='sending' AND attempts>=$1 AND attempted_at<=now()-interval '15 minutes'`,[maxAttempts]);
      const {rows} = await db.query(`SELECT a.*,a.due_on::text AS due_date,g.name,g.currency FROM gym_whatsapp_alerts a
        JOIN gyms g ON g.id=a.gym_id AND ${gymAccess} AND g.whatsapp_enabled
        LEFT JOIN whatsapp_deliveries d ON (d.gym_id,d.membership_id,d.kind,d.due_on)=
          (a.gym_id,a.membership_id,a.kind,a.due_on)
        WHERE a.whatsapp_phone IS NOT NULL AND a.kind=ANY($1::text[])
          AND (d.gym_id IS NULL OR (${retryable}))
        ORDER BY a.due_on,a.membership_id LIMIT 50`,[config.kinds,maxAttempts]);
      for (const alert of rows) {
        const key = [alert.gym_id,alert.membership_id,alert.kind,alert.due_date];
        const claim = await db.query(`INSERT INTO whatsapp_deliveries AS d(gym_id,membership_id,kind,due_on)
          SELECT a.gym_id,a.membership_id,a.kind,a.due_on FROM gym_whatsapp_alerts a
          JOIN gyms g ON g.id=a.gym_id AND ${gymAccess} AND g.whatsapp_enabled
          WHERE (a.gym_id,a.membership_id,a.kind,a.due_on)=($1,$2,$3,$4) AND a.whatsapp_phone=$5
          ON CONFLICT (gym_id,membership_id,kind,due_on) DO UPDATE
          SET attempts=d.attempts+1,status='sending',attempted_at=now(),next_attempt_at=NULL
          WHERE d.attempts<$6 AND (
            (d.status='failed' AND d.next_attempt_at<=now()) OR
            (d.status='sending' AND d.attempted_at<=now()-interval '15 minutes')
          ) RETURNING attempts`,[...key,alert.whatsapp_phone,maxAttempts]);
        if (!claim.rowCount) continue;
        const attempt=claim.rows[0].attempts;
        let status='failed',retryMinutes=null;
        try {
          const amount=alert.currency+' '+Number(alert.amount).toFixed(2);
          const gymName=alert.name.trim().replace(/\s+/g,' ');
          const memberName=alert.full_name?.trim().replace(/\s+/g,' ')||'member';
          const values=alert.kind==='fee_due'&&config.personalizedFee?
            [memberName,amount,alert.due_date,gymName]:
            [gymName,...(alert.kind==='expiry'?[alert.due_date]:alert.kind==='fee_due'?[alert.due_date,amount]:[amount])];
          const result = await fetch(`https://graph.facebook.com/${config.version}/${config.phone}/messages`,{
            method:'POST',signal:AbortSignal.timeout(10000),
            headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},
            body:JSON.stringify({messaging_product:'whatsapp',to:alert.whatsapp_phone.slice(1),type:'template',
              template:{name:config.templates[alert.kind],language:{code:config.language},
                components:[{type:'body',parameters:values.map(text=>({type:'text',text}))}]}})
          });
          if(result.ok)status='sent';
          else if(result.status===408||result.status===429||result.status>=500)retryMinutes=5*3**(attempt-1);
          await result.body?.cancel().catch(()=>{});
        } catch {
          retryMinutes=5*3**(attempt-1);
          console.error('WhatsApp reminder delivery request failed');
        }
        await db.query(`UPDATE whatsapp_deliveries SET status=$5,
          next_attempt_at=CASE WHEN $7::int IS NULL THEN NULL ELSE now()+make_interval(mins=>$7) END
          WHERE (gym_id,membership_id,kind,due_on)=($1,$2,$3,$4) AND attempts=$6 AND status='sending'`,
          [...key,status,attempt,attempt<maxAttempts?retryMinutes:null]);
      }
    } catch (error) {
      console.error('WhatsApp reminder job failed',error.code||'request error');
    } finally {
      running = false;
    }
  }
  void run();
  setInterval(run,60_000).unref();
}
