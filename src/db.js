import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn('DATABASE_URL not set. Remember to configure Postgres before running in production.');
}

export const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl && !databaseUrl.includes('localhost') && !databaseUrl.includes('127.0.0.1')
    ? { rejectUnauthorized: false }
    : false
});

export async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      create table if not exists pf_users (
        chat_id bigint not null,
        user_id bigint not null,
        username text,
        first_name text,
        length_cm integer not null default 0,
        wins integer not null default 0,
        losses integer not null default 0,
        last_grow_date date null,
        created_at timestamptz not null default now(),
        primary key (chat_id, user_id)
      );
    `);
    await client.query(`
      create table if not exists pf_challenges (
        id bigserial primary key,
        chat_id bigint not null,
        attacker_user_id bigint not null,
        bet_cm integer not null,
        message_id bigint,
        status text not null default 'open', -- open | resolved | cancelled
        accepted_by_user_id bigint,
        winner_user_id bigint,
        created_at timestamptz not null default now()
      );
    `);
    await client.query(`create index if not exists idx_pf_challenges_chat_status on pf_challenges(chat_id, status);`);
    await client.query(`
      create table if not exists pf_potd (
        chat_id bigint not null,
        for_date date not null,
        user_id bigint not null,
        created_at timestamptz not null default now(),
        primary key (chat_id, for_date)
      );
    `);
  } finally {
    client.release();
  }
}

export async function ensureUser(chatId, user) {
  const username = user.username || null;
  const firstName = user.first_name || null;
  await pool.query(
    `
    insert into pf_users (chat_id, user_id, username, first_name)
    values ($1, $2, $3, $4)
    on conflict (chat_id, user_id)
    do update set username = excluded.username, first_name = excluded.first_name
    `,
    [chatId, user.id, username, firstName]
  );
}

export async function getUser(chatId, userId) {
  const res = await pool.query(`select * from pf_users where chat_id = $1 and user_id = $2`, [chatId, userId]);
  return res.rows[0] || null;
}

export async function getUserByUsername(chatId, username) {
  if (!username) return null;
  const uname = username.replace(/^@/, '');
  const res = await pool.query(
    `select * from pf_users where chat_id = $1 and lower(username) = lower($2)`,
    [chatId, uname]
  );
  return res.rows[0] || null;
}

export async function canGrowToday(chatId, userId, utcDate) {
  const res = await pool.query(
    `select last_grow_date from pf_users where chat_id=$1 and user_id=$2`,
    [chatId, userId]
  );
  if (res.rowCount === 0) return true;
  const last = res.rows[0].last_grow_date;
  if (!last) return true;
  // Compare by date string in UTC
  const lastStr = new Date(last).toISOString().slice(0, 10);
  const currStr = utcDate.toISOString().slice(0, 10);
  return lastStr !== currStr;
}

export async function applyGrowth(chatId, userId, delta, utcDate) {
  // Floor at 0 cm
  await pool.query(
    `
    update pf_users
    set length_cm = greatest(0, length_cm + $1), last_grow_date = $2
    where chat_id = $3 and user_id = $4
    `,
    [delta, utcDate.toISOString().slice(0, 10), chatId, userId]
  );
  const updated = await getUser(chatId, userId);
  return updated;
}

export async function addLength(chatId, userId, delta) {
  await pool.query(
    `
    update pf_users
    set length_cm = greatest(0, length_cm + $1)
    where chat_id = $2 and user_id = $3
    `,
    [delta, chatId, userId]
  );
  return await getUser(chatId, userId);
}

export async function getOpenChallengeByMessageId(chatId, messageId) {
  const res = await pool.query(
    `select * from pf_challenges where chat_id=$1 and message_id=$2 and status='open' order by id desc limit 1`,
    [chatId, messageId]
  );
  return res.rows[0] || null;
}

function toUtcDateString(d) {
  return new Date(d).toISOString().slice(0, 10);
}

export async function createChallenge(chatId, attackerUserId, betCm, messageId) {
  const res = await pool.query(
    `
    insert into pf_challenges (chat_id, attacker_user_id, bet_cm, message_id, status)
    values ($1, $2, $3, $4, 'open')
    returning *
    `,
    [chatId, attackerUserId, betCm, messageId || null]
  );
  return res.rows[0];
}

export async function getOpenChallengeByAttacker(chatId, attackerUserId) {
  const res = await pool.query(
    `select * from pf_challenges where chat_id=$1 and attacker_user_id=$2 and status='open' order by id desc limit 1`,
    [chatId, attackerUserId]
  );
  return res.rows[0] || null;
}

export async function cancelOpenChallengesByAttacker(chatId, attackerUserId) {
  await pool.query(
    `update pf_challenges set status='cancelled' where chat_id=$1 and attacker_user_id=$2 and status='open'`,
    [chatId, attackerUserId]
  );
}

export async function resolveChallengeTransaction(challengeId, chatId, acceptorUserId, rng = Math.random) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Lock the challenge row
    const chRes = await client.query(
      `select * from pf_challenges where id=$1 and chat_id=$2 for update`,
      [challengeId, chatId]
    );
    if (chRes.rowCount === 0) {
      await client.query('rollback');
      return { ok: false, reason: 'not_found' };
    }
    const challenge = chRes.rows[0];
    if (challenge.status !== 'open') {
      await client.query('rollback');
      return { ok: false, reason: 'already_resolved' };
    }
    const attackerId = Number(challenge.attacker_user_id);
    const betCm = Number(challenge.bet_cm);
    const acceptorId = Number(acceptorUserId);
    if (attackerId === acceptorId) {
      await client.query('rollback');
      return { ok: false, reason: 'self_accept' };
    }
    // Lock both users
    const usersRes = await client.query(
      `select * from pf_users where chat_id=$1 and user_id in ($2, $3) for update`,
      [chatId, attackerId, acceptorId]
    );
    if (usersRes.rowCount < 2) {
      await client.query('rollback');
      return { ok: false, reason: 'missing_user' };
    }
    const attacker = usersRes.rows.find(u => Number(u.user_id) === attackerId);
    const acceptor = usersRes.rows.find(u => Number(u.user_id) === acceptorId);
    if (!attacker || !acceptor) {
      await client.query('rollback');
      return { ok: false, reason: 'missing_user' };
    }
    if (attacker.length_cm < betCm) {
      await client.query('rollback');
      return { ok: false, reason: 'attacker_insufficient' };
    }
    if (acceptor.length_cm < betCm) {
      await client.query('rollback');
      return { ok: false, reason: 'acceptor_insufficient' };
    }
    const attackerWins = rng() < 0.5;
    const winnerId = attackerWins ? attackerId : acceptorId;
    const loserId = attackerWins ? acceptorId : attackerId;
    // Apply transfers and stats
    await client.query(
      `update pf_users set length_cm = length_cm + $1, wins = wins + 1 where chat_id=$2 and user_id=$3`,
      [betCm, chatId, winnerId]
    );
    await client.query(
      `update pf_users set length_cm = greatest(0, length_cm - $1), losses = losses + 1 where chat_id=$2 and user_id=$3`,
      [betCm, chatId, loserId]
    );
    // Close challenge
    await client.query(
      `update pf_challenges set status='resolved', accepted_by_user_id=$1, winner_user_id=$2 where id=$3`,
      [acceptorId, winnerId, challengeId]
    );
    await client.query('commit');
    return {
      ok: true,
      result: {
        challenge,
        winnerId,
        loserId,
        betCm,
        attacker,
        acceptor
      }
    };
  } catch (err) {
    try { await client.query('rollback'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

export async function getPotd(chatId, utcDate) {
  const dateStr = toUtcDateString(utcDate);
  const res = await pool.query(
    `
    select p.chat_id, p.for_date, p.user_id, u.username, u.first_name, u.length_cm
    from pf_potd p
    join pf_users u on u.chat_id = p.chat_id and u.user_id = p.user_id
    where p.chat_id = $1 and p.for_date = $2::date
    `,
    [chatId, dateStr]
  );
  return res.rows[0] || null;
}

export async function selectOrCreatePotd(chatId, utcDate, rng = Math.random) {
  const dateStr = toUtcDateString(utcDate);
  // If already exists, return it
  const existing = await getPotd(chatId, utcDate);
  if (existing) return existing;
  // Pick random user in chat
  const pickRes = await pool.query(
    `select user_id from pf_users where chat_id=$1 order by random() limit 1`,
    [chatId]
  );
  if (pickRes.rowCount === 0) {
    return null;
  }
  const chosenUserId = pickRes.rows[0].user_id;
  // Insert if not exists (handles races)
  await pool.query(
    `insert into pf_potd (chat_id, for_date, user_id) values ($1, $2::date, $3) on conflict do nothing`,
    [chatId, dateStr, chosenUserId]
  );
  // Return final selection
  const finalRow = await getPotd(chatId, utcDate);
  return finalRow;
}

export async function getTopUsers(chatId, limit = 10) {
  const res = await pool.query(
    `
    select user_id, username, first_name, length_cm, wins, losses
    from pf_users
    where chat_id = $1
    order by length_cm desc, wins desc, user_id asc
    limit $2
    `,
    [chatId, Math.max(1, Math.min(limit, 50))]
  );
  return res.rows;
}


