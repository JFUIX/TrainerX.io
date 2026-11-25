const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const isoDate = value => typeof value === 'string' && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const owner = (req,res,next) => req.user.role === 'owner' ? next() : res.sendStatus(403);
const staff = (req,res,next) => ['owner','reception'].includes(req.user.role) ? next() : res.sendStatus(403);
const platform = (req,res,next) => req.user.role === 'superadmin' ? next() : res.sendStatus(403);
const categories = ['Rent','Payroll','Utilities','Equipment','Marketing','Other'];
const phoneNumber = value => typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value);

export const gymAccess = 'g.active AND (g.subscription_until IS NULL OR g.subscription_until >= CURRENT_DATE)';
export const memberCanCheckIn = (gym,member) => `NOT EXISTS (
  SELECT 1 FROM member_freezes f
  WHERE f.gym_id=${gym} AND f.member_id=${member} AND CURRENT_DATE BETWEEN f.starts_on AND f.ends_on
)`;

export function registerGymOperations(app,db,auth) {
  const privateData = (req,res,next) => {res.set('Cache-Control','no-store');next()};

  app.get('/gym-account',auth,owner,privateData,async (req,res) => {
    const {rows:[gym]} = await db.query(`SELECT name,currency,subscription_plan,
      subscription_until::text,whatsapp_enabled FROM gyms WHERE id=$1`,[req.user.gym_id]);
    const {rows:reminders} = await db.query(`SELECT status,count(*)::int AS total FROM whatsapp_deliveries
      WHERE gym_id=$1 AND attempted_at>=now()-interval '30 days' GROUP BY status`,[req.user.gym_id]);
    const config=whatsappConfig();
    res.json({...gym,reminders,whatsapp_configured:Boolean(config),whatsapp_fee_due_configured:Boolean(config?.templates.fee_due)});
  });

  app.patch('/gym-account',auth,owner,privateData,async (req,res) => {
    const name=typeof req.body?.name==='string'?req.body.name.trim():'';
    if(!name||name.length>120||/[\r\n\t]/.test(name))return res.status(400).json({error:'Enter a gym name up to 120 characters.'});
    const {rows:[gym]}=await db.query('UPDATE gyms SET name=$2 WHERE id=$1 RETURNING name',[req.user.gym_id,name]);
    if(!gym)return res.sendStatus(404);
    res.json(gym);
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
          AND m.cancelled_on IS NULL AND CURRENT_DATE BETWEEN m.starts_on AND m.ends_on
        GROUP BY u.gym_id,u.id
      ), archived AS (
        INSERT INTO member_freeze_history(gym_id,member_id,starts_on,ends_on)
        SELECT f.gym_id,f.member_id,f.starts_on,f.ends_on
        FROM member_freezes f JOIN eligible e ON e.gym_id=f.gym_id AND e.id=f.member_id
        WHERE f.ends_on<CURRENT_DATE
        ON CONFLICT DO NOTHING
      )
        INSERT INTO member_freezes(gym_id,member_id,starts_on,ends_on)
        SELECT gym_id,id,CURRENT_DATE,ends_on FROM eligible
        ON CONFLICT (gym_id,member_id) DO UPDATE SET
          starts_on=CASE WHEN CURRENT_DATE BETWEEN member_freezes.starts_on AND member_freezes.ends_on
            THEN member_freezes.starts_on ELSE EXCLUDED.starts_on END,
          ends_on=GREATEST(member_freezes.ends_on,EXCLUDED.ends_on)`,args);
      if (!result.rowCount) return res.status(404).json({error:'No active membership to freeze'});
    } else {
      const result=await db.query(`WITH shortened AS (
        UPDATE member_freezes SET ends_on=CURRENT_DATE-1
        WHERE gym_id=$1 AND member_id=$2 AND starts_on<CURRENT_DATE AND ends_on>=CURRENT_DATE
      ), cleared AS (
        DELETE FROM member_freezes WHERE gym_id=$1 AND member_id=$2 AND starts_on=CURRENT_DATE
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

  app.post('/expenses',auth,owner,async (req,res) => {
    const {incurred_on,category,description='',amount} = req.body || {};
    if (!isoDate(incurred_on) || !categories.includes(category) || typeof description !== 'string' ||
        description.length > 500 || typeof amount !== 'number' || !Number.isFinite(amount) ||
        amount < 0.01 || amount > 100000000 || Number(amount.toFixed(2)) !== amount) return res.sendStatus(400);
    const {rows:[expense]} = await db.query(`INSERT INTO gym_expenses(gym_id,recorded_by,incurred_on,category,description,amount)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,[req.user.gym_id,req.user.id,incurred_on,category,description.trim(),amount]);
    res.status(201).json(expense);
  });

  app.get('/financial-report',auth,owner,privateData,async (req,res) => {
    const {from,to} = req.query;
    if (!isoDate(from) || !isoDate(to) || to < from || Date.parse(to)-Date.parse(from) > 365*86400000) return res.sendStatus(400);
    const {rows} = await db.query(`SELECT * FROM (
      SELECT f.paid_at::date::text AS date,'Payment' AS type,f.id,f.method AS category,u.email AS description,f.amount
      FROM fee_payments f JOIN memberships m ON m.gym_id=f.gym_id AND m.id=f.membership_id
      JOIN users u ON u.gym_id=m.gym_id AND u.id=m.member_id
      WHERE f.gym_id=$1 AND f.paid_at >= $2::date AND f.paid_at < $3::date+1
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
             LEAST((start+interval '1 month - 1 day')::date,CURRENT_DATE) AS closing
      FROM generate_series(date_trunc('month',CURRENT_DATE)-interval '5 months',
                           date_trunc('month',CURRENT_DATE),interval '1 month') start
    )
    SELECT to_char(d.month,'YYYY-MM') AS month,
      (SELECT count(*)::int FROM member_profiles p WHERE p.gym_id=$1 AND p.joined_on BETWEEN d.month AND d.closing) AS joined,
      (SELECT count(*)::int FROM attendance a WHERE a.gym_id=$1 AND a.attended_on BETWEEN d.month AND d.closing) AS visits,
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
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    try {
      const {rows} = await db.query(`SELECT a.*,a.due_on::text AS due_date,g.name,g.currency FROM gym_whatsapp_alerts a
        JOIN gyms g ON g.id=a.gym_id AND ${gymAccess} AND g.whatsapp_enabled
        WHERE a.whatsapp_phone IS NOT NULL AND a.kind=ANY($1::text[]) AND NOT EXISTS (
          SELECT 1 FROM whatsapp_deliveries d WHERE (d.gym_id,d.membership_id,d.kind,d.due_on)=
            (a.gym_id,a.membership_id,a.kind,a.due_on)
        ) ORDER BY a.due_on,a.membership_id LIMIT 50`,[config.kinds]);
      for (const alert of rows) {
        const key = [alert.gym_id,alert.membership_id,alert.kind,alert.due_date];
        const claim = await db.query(`INSERT INTO whatsapp_deliveries(gym_id,membership_id,kind,due_on)
          SELECT a.gym_id,a.membership_id,a.kind,a.due_on FROM gym_whatsapp_alerts a
          JOIN gyms g ON g.id=a.gym_id AND ${gymAccess} AND g.whatsapp_enabled
          WHERE (a.gym_id,a.membership_id,a.kind,a.due_on)=($1,$2,$3,$4) AND a.whatsapp_phone=$5
          ON CONFLICT DO NOTHING`,[...key,alert.whatsapp_phone]);
        if (!claim.rowCount) continue;
        let status = 'failed';
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
          status = result.ok ? 'sent' : 'failed';
          await result.body?.cancel();
        } catch {
          console.error('WhatsApp reminder delivery request failed');
        }
        await db.query(`UPDATE whatsapp_deliveries SET status=$5
          WHERE (gym_id,membership_id,kind,due_on)=($1,$2,$3,$4)`,[...key,status]);
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
