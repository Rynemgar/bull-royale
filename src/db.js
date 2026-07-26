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

const GROW_COOLDOWN_MS = 8 * 60 * 60 * 1000; // 8 hours

export function roundCm(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

export async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      create table if not exists pf_users (
        chat_id bigint not null,
        user_id bigint not null,
        username text,
        first_name text,
        length_cm numeric(12,2) not null default 0,
        wins integer not null default 0,
        losses integer not null default 0,
        last_grow_at timestamptz null,
        created_at timestamptz not null default now(),
        primary key (chat_id, user_id)
      );
    `);
    // Migrate legacy integer length → numeric(12,2)
    await client.query(`
      alter table pf_users
      alter column length_cm type numeric(12,2) using length_cm::numeric(12,2)
    `).catch(() => {});
    await client.query(`
      alter table pf_users
      add column if not exists last_grow_at timestamptz null
    `);
    // Migrate legacy once-per-day date into last_grow_at (midnight of that date) if needed
    await client.query(`
      update pf_users
      set last_grow_at = (last_grow_date::timestamp at time zone 'UTC')
      where last_grow_at is null and last_grow_date is not null
    `).catch(() => {});
    await client.query(`
      create table if not exists pf_challenges (
        id bigserial primary key,
        chat_id bigint not null,
        attacker_user_id bigint not null,
        bet_cm numeric(12,2) not null,
        message_id bigint,
        status text not null default 'open', -- open | resolved | cancelled
        accepted_by_user_id bigint,
        winner_user_id bigint,
        created_at timestamptz not null default now()
      );
    `);
    await client.query(`
      alter table pf_challenges
      alter column bet_cm type numeric(12,2) using bet_cm::numeric(12,2)
    `).catch(() => {});
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
    await client.query(`
      create table if not exists pf_images (
        key text primary key,
        url text not null,
        updated_at timestamptz not null default now()
      );
    `);
    await client.query(`
      create table if not exists pf_group_rewards (
        chat_id bigint primary key,
        wallet_pubkey text,
        wallet_privkey_enc text,
        reward_mint text,
        reward_amount numeric(24,8),
        winner_count integer not null default 3,
        period_hours numeric(10,2) not null default 72,
        period_started_at timestamptz,
        last_payout_at timestamptz,
        last_low_balance_alert_at timestamptz,
        updated_at timestamptz not null default now()
      );
    `);
    await client.query(`
      create table if not exists pf_user_wallets (
        user_id bigint primary key,
        solana_address text not null,
        updated_at timestamptz not null default now()
      );
    `);
    // Migrate legacy per-group wallets → one global address per user (keep newest)
    await client.query(`
      do $$
      begin
        if exists (
          select 1 from information_schema.columns
          where table_name = 'pf_user_wallets' and column_name = 'chat_id'
        ) then
          create temporary table pf_user_wallets_mig as
          select distinct on (user_id) user_id, solana_address, updated_at
          from pf_user_wallets
          order by user_id, updated_at desc nulls last;
          drop table pf_user_wallets;
          create table pf_user_wallets (
            user_id bigint primary key,
            solana_address text not null,
            updated_at timestamptz not null default now()
          );
          insert into pf_user_wallets (user_id, solana_address, updated_at)
          select user_id, solana_address, coalesce(updated_at, now()) from pf_user_wallets_mig;
          drop table pf_user_wallets_mig;
        end if;
      end $$;
    `).catch((e) => {
      console.error('pf_user_wallets migrate', e?.message || e);
    });
    await client.query(`
      create table if not exists pf_reward_blacklist (
        chat_id bigint not null,
        user_id bigint not null,
        created_by bigint,
        created_at timestamptz not null default now(),
        primary key (chat_id, user_id)
      );
    `);
    await client.query(`
      create table if not exists pf_reward_payouts (
        id bigserial primary key,
        chat_id bigint not null,
        user_id bigint not null,
        amount numeric(24,8) not null,
        signature text,
        period_started_at timestamptz,
        created_at timestamptz not null default now()
      );
    `);
    await client.query(`create index if not exists idx_pf_reward_payouts_chat on pf_reward_payouts(chat_id, created_at desc);`);
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

export async function canGrow(chatId, userId, utcNow = new Date()) {
  const res = await pool.query(
    `select last_grow_at from pf_users where chat_id=$1 and user_id=$2`,
    [chatId, userId]
  );
  if (res.rowCount === 0) return true;
  const last = res.rows[0].last_grow_at;
  if (!last) return true;
  return utcNow.getTime() - new Date(last).getTime() >= GROW_COOLDOWN_MS;
}

export async function getGrowCooldownRemainingMs(chatId, userId, utcNow = new Date()) {
  const res = await pool.query(
    `select last_grow_at from pf_users where chat_id=$1 and user_id=$2`,
    [chatId, userId]
  );
  if (res.rowCount === 0 || !res.rows[0].last_grow_at) return 0;
  const elapsed = utcNow.getTime() - new Date(res.rows[0].last_grow_at).getTime();
  return Math.max(0, GROW_COOLDOWN_MS - elapsed);
}

export async function applyGrowth(chatId, userId, delta, utcNow = new Date()) {
  const d = roundCm(delta);
  await pool.query(
    `
    update pf_users
    set length_cm = round(greatest(0, length_cm + $1)::numeric, 2),
        last_grow_at = $2
    where chat_id = $3 and user_id = $4
    `,
    [d, utcNow.toISOString(), chatId, userId]
  );
  return await getUser(chatId, userId);
}

export async function addLength(chatId, userId, delta) {
  const d = roundCm(delta);
  await pool.query(
    `
    update pf_users
    set length_cm = round(greatest(0, length_cm + $1)::numeric, 2)
    where chat_id = $2 and user_id = $3
    `,
    [d, chatId, userId]
  );
  return await getUser(chatId, userId);
}

export async function setLength(chatId, userId, lengthCm) {
  const v = roundCm(Math.max(0, lengthCm));
  await pool.query(
    `update pf_users set length_cm = $1 where chat_id = $2 and user_id = $3`,
    [v, chatId, userId]
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
  const bet = roundCm(betCm);
  const res = await pool.query(
    `
    insert into pf_challenges (chat_id, attacker_user_id, bet_cm, message_id, status)
    values ($1, $2, $3, $4, 'open')
    returning *
    `,
    [chatId, attackerUserId, bet, messageId || null]
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
    const betCm = roundCm(challenge.bet_cm);
    const acceptorId = Number(acceptorUserId);
    if (attackerId === acceptorId) {
      await client.query('rollback');
      return { ok: false, reason: 'self_accept' };
    }
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
    if (Number(attacker.length_cm) < betCm) {
      await client.query('rollback');
      return { ok: false, reason: 'attacker_insufficient' };
    }
    if (Number(acceptor.length_cm) < betCm) {
      await client.query('rollback');
      return { ok: false, reason: 'acceptor_insufficient' };
    }
    const attackerWins = rng() < 0.5;
    const winnerId = attackerWins ? attackerId : acceptorId;
    const loserId = attackerWins ? acceptorId : attackerId;
    await client.query(
      `update pf_users set length_cm = round((length_cm + $1)::numeric, 2), wins = wins + 1 where chat_id=$2 and user_id=$3`,
      [betCm, chatId, winnerId]
    );
    await client.query(
      `update pf_users set length_cm = round(greatest(0, length_cm - $1)::numeric, 2), losses = losses + 1 where chat_id=$2 and user_id=$3`,
      [betCm, chatId, loserId]
    );
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

export async function selectOrCreatePotd(chatId, utcDate) {
  const dateStr = toUtcDateString(utcDate);
  const existing = await getPotd(chatId, utcDate);
  if (existing) return existing;
  const pickRes = await pool.query(
    `select user_id from pf_users where chat_id=$1 order by random() limit 1`,
    [chatId]
  );
  if (pickRes.rowCount === 0) {
    return null;
  }
  const chosenUserId = pickRes.rows[0].user_id;
  await pool.query(
    `insert into pf_potd (chat_id, for_date, user_id) values ($1, $2::date, $3) on conflict do nothing`,
    [chatId, dateStr, chosenUserId]
  );
  return await getPotd(chatId, utcDate);
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

export async function getGlobalAverageLength() {
  const res = await pool.query(`select avg(length_cm) as avg from pf_users`);
  const v = res.rows[0] && res.rows[0].avg;
  return v === null || v === undefined ? null : Number(v);
}

export async function getGroupAverageAndRank(chatId) {
  const res = await pool.query(
    `
    with per_group as (
      select chat_id, avg(length_cm) as avg
      from pf_users
      group by chat_id
    ),
    ranked as (
      select chat_id,
             avg,
             dense_rank() over (order by avg desc) as rnk,
             count(*) over () as total_groups
      from per_group
    )
    select rnk as rank, avg, total_groups
    from ranked
    where chat_id = $1
    `,
    [chatId]
  );
  if (res.rowCount === 0) {
    return { avg: null, rank: null, total: 0 };
  }
  const row = res.rows[0];
  return {
    avg: row.avg === null || row.avg === undefined ? null : Number(row.avg),
    rank: row.rank === null || row.rank === undefined ? null : Number(row.rank),
    total: row.total_groups === null || row.total_groups === undefined ? 0 : Number(row.total_groups)
  };
}

export async function ensureImageDefaults(defaultsMap) {
  const keys = Object.keys(defaultsMap || {});
  if (keys.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const k of keys) {
      const url = defaultsMap[k];
      if (!url) continue;
      await client.query(
        `insert into pf_images (key, url) values ($1, $2) on conflict (key) do nothing`,
        [k, url]
      );
    }
    await client.query('commit');
  } catch (e) {
    try { await client.query('rollback'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

/** Force-set image keys (overwrites existing DB values). */
export async function forceImageDefaults(defaultsMap) {
  const entries = Object.entries(defaultsMap || {}).filter(([, url]) => url);
  if (entries.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const [k, url] of entries) {
      await client.query(
        `insert into pf_images (key, url, updated_at)
         values ($1, $2, now())
         on conflict (key) do update set url = excluded.url, updated_at = now()`,
        [k, url]
      );
    }
    await client.query('commit');
  } catch (e) {
    try { await client.query('rollback'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function getAllImages() {
  const res = await pool.query(`select key, url from pf_images`);
  return res.rows;
}

export async function setImageUrl(key, url) {
  const res = await pool.query(
    `insert into pf_images (key, url, updated_at)
     values ($1, $2, now())
     on conflict (key) do update set url = excluded.url, updated_at = now()
     returning key, url`,
    [key, url]
  );
  return res.rows[0];
}

function mapGroupRewards(row) {
  if (!row) return null;
  return {
    chat_id: Number(row.chat_id),
    wallet_pubkey: row.wallet_pubkey || null,
    wallet_privkey_enc: row.wallet_privkey_enc || null,
    reward_mint: row.reward_mint || null,
    reward_amount: row.reward_amount == null ? null : Number(row.reward_amount),
    winner_count: Number(row.winner_count ?? 3),
    period_hours: Number(row.period_hours ?? 72),
    period_started_at: row.period_started_at || null,
    last_payout_at: row.last_payout_at || null,
    last_low_balance_alert_at: row.last_low_balance_alert_at || null,
    updated_at: row.updated_at || null
  };
}

export async function getGroupRewards(chatId) {
  const res = await pool.query(`select * from pf_group_rewards where chat_id = $1`, [chatId]);
  return mapGroupRewards(res.rows[0]);
}

export async function ensureGroupRewards(chatId) {
  await pool.query(
    `insert into pf_group_rewards (chat_id) values ($1) on conflict (chat_id) do nothing`,
    [chatId]
  );
  return getGroupRewards(chatId);
}

export async function setGroupWallet(chatId, pubkey, privkeyEnc) {
  await ensureGroupRewards(chatId);
  const res = await pool.query(
    `update pf_group_rewards
     set wallet_pubkey = $2, wallet_privkey_enc = $3, updated_at = now()
     where chat_id = $1
     returning *`,
    [chatId, pubkey, privkeyEnc]
  );
  return mapGroupRewards(res.rows[0]);
}

export async function updateGroupRewards(chatId, fields) {
  await ensureGroupRewards(chatId);
  const allowed = [
    'reward_mint',
    'reward_amount',
    'winner_count',
    'period_hours',
    'period_started_at',
    'last_payout_at',
    'last_low_balance_alert_at'
  ];
  const sets = [];
  const vals = [chatId];
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    vals.push(fields[key]);
    sets.push(`${key} = $${vals.length}`);
  }
  if (sets.length === 0) return getGroupRewards(chatId);
  sets.push('updated_at = now()');
  const res = await pool.query(
    `update pf_group_rewards set ${sets.join(', ')} where chat_id = $1 returning *`,
    vals
  );
  return mapGroupRewards(res.rows[0]);
}

export async function listGroupsDueForRewards() {
  const res = await pool.query(
    `select * from pf_group_rewards
     where wallet_pubkey is not null
       and wallet_privkey_enc is not null
       and reward_mint is not null
       and reward_amount is not null
       and reward_amount > 0
       and winner_count >= 1
       and period_started_at is not null`
  );
  return res.rows.map(mapGroupRewards);
}

export async function setUserWallet(userId, solanaAddress) {
  const res = await pool.query(
    `insert into pf_user_wallets (user_id, solana_address, updated_at)
     values ($1, $2, now())
     on conflict (user_id) do update
       set solana_address = excluded.solana_address, updated_at = now()
     returning *`,
    [userId, solanaAddress]
  );
  return res.rows[0];
}

export async function getUserWallet(userId) {
  const res = await pool.query(
    `select * from pf_user_wallets where user_id = $1`,
    [userId]
  );
  return res.rows[0] || null;
}

export async function addRewardBlacklist(chatId, userId, createdBy = null) {
  await pool.query(
    `insert into pf_reward_blacklist (chat_id, user_id, created_by)
     values ($1, $2, $3)
     on conflict (chat_id, user_id) do nothing`,
    [chatId, userId, createdBy]
  );
}

export async function removeRewardBlacklist(chatId, userId) {
  await pool.query(
    `delete from pf_reward_blacklist where chat_id = $1 and user_id = $2`,
    [chatId, userId]
  );
}

export async function getRewardBlacklistPage(chatId, page = 0, pageSize = 5) {
  const offset = Math.max(0, page) * pageSize;
  const countRes = await pool.query(
    `select count(*)::int as n from pf_reward_blacklist where chat_id = $1`,
    [chatId]
  );
  const total = countRes.rows[0]?.n || 0;
  const res = await pool.query(
    `
    select b.user_id, b.created_at, u.username, u.first_name
    from pf_reward_blacklist b
    left join pf_users u on u.chat_id = b.chat_id and u.user_id = b.user_id
    where b.chat_id = $1
    order by b.created_at desc
    limit $2 offset $3
    `,
    [chatId, pageSize, offset]
  );
  return { total, page, pageSize, rows: res.rows };
}

export async function getEligibleRewardWinners(chatId, limit) {
  const lim = Math.max(1, Math.min(Number(limit) || 1, 50));
  const res = await pool.query(
    `
    select u.user_id, u.username, u.first_name, u.length_cm, u.wins, w.solana_address
    from pf_users u
    inner join pf_user_wallets w
      on w.user_id = u.user_id
    where u.chat_id = $1
      and not exists (
        select 1 from pf_reward_blacklist b
        where b.chat_id = u.chat_id and b.user_id = u.user_id
      )
    order by u.length_cm desc, u.wins desc, u.user_id asc
    limit $2
    `,
    [chatId, lim]
  );
  return res.rows;
}

export async function recordRewardPayout({ chatId, userId, amount, signature, periodStartedAt }) {
  const res = await pool.query(
    `insert into pf_reward_payouts (chat_id, user_id, amount, signature, period_started_at)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [chatId, userId, amount, signature || null, periodStartedAt || null]
  );
  return res.rows[0];
}

/** Maybe start the reward period once wallet + mint + amount are configured. */
export async function maybeStartRewardPeriod(chatId) {
  const row = await getGroupRewards(chatId);
  if (!row) return row;
  if (row.period_started_at) return row;
  if (!row.wallet_pubkey || !row.reward_mint || !(row.reward_amount > 0)) return row;
  return updateGroupRewards(chatId, { period_started_at: new Date() });
}
