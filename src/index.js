import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TelegramBot from 'node-telegram-bot-api';
import {
  initSchema,
  ensureUser,
  getUser,
  getUserByUsername,
  canGrow,
  getGrowCooldownRemainingMs,
  tryApplyGrowth,
  addLength,
  setLength,
  createChallenge,
  getOpenChallengeByAttacker,
  getOpenChallengeByMessageId,
  selectOrCreatePotd,
  cancelOpenChallengesByAttacker,
  getTopUsers,
  resolveChallengeTransaction,
  getGlobalAverageLength,
  getGroupAverageAndRank,
  getAllImages,
  setImageUrl,
  roundCm,
  getGroupRewards,
  ensureGroupRewards,
  updateGroupRewards,
  GROW_COOLDOWN_HOURS,
  getGiftClaimCooldownRemainingMs,
  recordGiftClaim
} from './db.js';
import {
  buildSetbullMenu,
  rememberSetbullMenu,
  handleSetbullCallback,
  handleSetbullPendingInput,
  handleSetwalletPending,
  startSetwalletFlow,
  handleNobull,
  pendingSetwallet,
  pendingSetbull,
  setbullMenuMessages,
  runRewardTick
} from './rewards.js';
import {
  decryptSecret,
  secretKeyToBase58,
  cascadingShares,
  getTokenMetadataName
} from './solana.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set.');
  process.exit(1);
}

const ADMIN_USER_ID = 6933188641;
const EXTRA_ADMIN_USER_IDS = new Set([5874630064]);
function isAdminUser(id) {
  return id === ADMIN_USER_ID || EXTRA_ADMIN_USER_IDS.has(id);
}

/** /setbull: Telegram group admin/creator, or primary owner. */
async function canManageSetbull(chatId, userId) {
  if (Number(userId) === ADMIN_USER_ID) return true;
  try {
    const member = await bot.getChatMember(chatId, userId);
    return member?.status === 'creator' || member?.status === 'administrator';
  } catch {
    return false;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const POSTER_IMAGE = path.join(ASSETS_DIR, 'poster.png');
const GROW_IMAGE = path.join(ASSETS_DIR, 'grow.png');
const SNAP_IMAGE = path.join(ASSETS_DIR, 'snap.png');
const ATTACK_VIDEO = path.join(ASSETS_DIR, 'IMG_1976.MP4');

// Local asset defaults. Can be overridden later via /update (photo or video).
const DEFAULT_IMAGES = {
  poster: POSTER_IMAGE,
  grow: GROW_IMAGE,
  snap: SNAP_IMAGE,
  shrunk: SNAP_IMAGE,
  attack: ATTACK_VIDEO,
  attack_resolved: null,
  top: null
};
let imagesCache = { ...DEFAULT_IMAGES };

function getImageUrl(key) {
  const v = imagesCache[key];
  if (v) return v;
  return DEFAULT_IMAGES[key] || null;
}

function isVideoMedia(ref) {
  if (!ref) return false;
  if (typeof ref !== 'string') return false;
  if (ref.startsWith('video:') || ref.startsWith('animation:')) return true;
  return /\.(mp4|mov|webm|m4v)$/i.test(ref);
}

/** Strip photo:/video:/animation: prefix to get the raw Telegram file_id or path/URL. */
function unwrapMediaRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (/^(photo|video|animation):/i.test(ref)) {
    return ref.replace(/^(photo|video|animation):/i, '');
  }
  return ref;
}

function isTelegramFileRef(ref) {
  return typeof ref === 'string' && /^(photo|video|animation):/i.test(ref);
}

function isRemoteMediaUrl(ref) {
  if (!ref || typeof ref !== 'string') return false;
  const raw = unwrapMediaRef(ref);
  return /^https?:\/\//i.test(raw);
}

function isLocalMediaPath(ref) {
  if (!ref || typeof ref !== 'string') return false;
  if (isTelegramFileRef(ref) || isRemoteMediaUrl(ref)) return false;
  const raw = unwrapMediaRef(ref);
  if (!raw) return false;
  const looksPath =
    raw.includes(path.sep) ||
    raw.includes('/') ||
    /^[A-Za-z]:[\\/]/.test(raw);
  return looksPath && fs.existsSync(raw);
}

/** Still needs a one-time Telegram upload (local file or http URL). */
function shouldCacheMediaFileId(ref) {
  if (!ref || isTelegramFileRef(ref)) return false;
  return isLocalMediaPath(ref) || isRemoteMediaUrl(ref);
}

/**
 * Normalize anything we store in pf_images / imagesCache.
 * Bare Telegram file_ids (from older /update) become photo:<id>.
 */
function normalizeImageRef(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (/^(photo|video|animation):/i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Filesystem path (unix, windows, or relative with extension)
  if (
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.includes(path.sep) ||
    /\.(png|jpe?g|gif|webp|mp4|mov|webm|m4v)$/i.test(trimmed)
  ) {
    return trimmed;
  }
  // Bare Telegram file_id from older saves
  return `photo:${trimmed}`;
}

function mediaInput(ref) {
  if (!ref) return null;
  if (isTelegramFileRef(ref)) return unwrapMediaRef(ref);
  if (isRemoteMediaUrl(ref)) return unwrapMediaRef(ref);
  if (isLocalMediaPath(ref)) return unwrapMediaRef(ref);
  // Fallback: treat as file_id or path string
  return unwrapMediaRef(ref);
}

function resolveMedia(key) {
  const ref = getImageUrl(key);
  if (!ref) return null;
  let type = 'photo';
  if (typeof ref === 'string') {
    if (/^animation:/i.test(ref)) type = 'animation';
    else if (/^video:/i.test(ref) || isVideoMedia(ref)) type = 'video';
    else type = 'photo';
  }
  return {
    type,
    media: mediaInput(ref)
  };
}

function fileIdRefFromSentMessage(sentMsg) {
  if (sentMsg?.video?.file_id) return `video:${sentMsg.video.file_id}`;
  if (sentMsg?.animation?.file_id) return `animation:${sentMsg.animation.file_id}`;
  if (Array.isArray(sentMsg?.photo) && sentMsg.photo.length > 0) {
    const best = sentMsg.photo.reduce((a, b) => ((a.file_size || 0) > (b.file_size || 0) ? a : b));
    return `photo:${best.file_id}`;
  }
  if (sentMsg?.document?.file_id) {
    const mime = String(sentMsg.document.mime_type || '');
    if (mime.startsWith('video/') || isVideoMedia(sentMsg.document.file_name || '')) {
      return `video:${sentMsg.document.file_id}`;
    }
    if (mime.startsWith('image/')) return `photo:${sentMsg.document.file_id}`;
  }
  return null;
}

/** After uploading a local/remote asset once, persist Telegram file_id for reuse. */
async function cacheSentMediaFileId(key, sentMsg) {
  const current = getImageUrl(key);
  if (!shouldCacheMediaFileId(current)) return getImageUrl(key);

  const stored = fileIdRefFromSentMessage(sentMsg);
  if (!stored) {
    console.error('cacheSentMediaFileId: no file_id in Telegram response for', key);
    return current;
  }

  const source = unwrapMediaRef(current);
  const keysToUpdate = new Set([key]);
  for (const [k, v] of Object.entries(imagesCache)) {
    if (!v || isTelegramFileRef(v)) continue;
    if (unwrapMediaRef(v) === source) keysToUpdate.add(k);
  }
  if (key === 'snap' || key === 'shrunk') {
    keysToUpdate.add('snap');
    keysToUpdate.add('shrunk');
  }

  for (const k of keysToUpdate) {
    imagesCache[k] = stored;
    try {
      await setImageUrl(k, stored);
      console.log(`[media] cached ${k} → ${stored.slice(0, 24)}…`);
    } catch (e) {
      console.error('Failed to cache media file_id', k, e?.message || e);
    }
  }
  return stored;
}

/** Serialize sends per media key so the first upload is cached before others run. */
const mediaSendChains = new Map(); // key -> Promise

async function sendKeyedMediaOnce(chatId, key, options = {}) {
  const use = resolveMedia(key);
  if (!use || !use.media) {
    const { caption, ...rest } = options;
    return bot.sendMessage(chatId, caption || '', {
      parse_mode: rest.parse_mode || 'HTML',
      disable_web_page_preview: true,
      reply_markup: rest.reply_markup
    });
  }

  const stillNeedsUpload = shouldCacheMediaFileId(getImageUrl(key));
  let msg;
  if (use.type === 'video') {
    msg = await bot.sendVideo(chatId, use.media, options);
  } else if (use.type === 'animation') {
    msg = await bot.sendAnimation(chatId, use.media, options);
  } else {
    msg = await bot.sendPhoto(chatId, use.media, options);
  }

  if (stillNeedsUpload && msg) {
    await cacheSentMediaFileId(key, msg);
  }
  return msg;
}

async function sendKeyedMedia(chatId, key, options = {}) {
  const prev = mediaSendChains.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  mediaSendChains.set(key, prev.then(() => mine));

  await prev;
  try {
    try {
      return await sendKeyedMediaOnce(chatId, key, options);
    } catch (err) {
      const current = getImageUrl(key);
      // Stale/invalid Telegram file_id → fall back to bundled default and retry once
      if (isTelegramFileRef(current) && isBadTelegramFileIdError(err) && DEFAULT_IMAGES[key]) {
        console.error(
          `[media] bad file_id for ${key}, reverting to default and retrying:`,
          formatTelegramError(err)
        );
        imagesCache[key] = DEFAULT_IMAGES[key];
        try {
          await setImageUrl(key, DEFAULT_IMAGES[key]);
        } catch (e) {
          console.error('failed to revert media key', key, e?.message || e);
        }
        return await sendKeyedMediaOnce(chatId, key, options);
      }
      console.error(`[media] send failed for ${key}:`, formatTelegramError(err));
      throw err;
    }
  } finally {
    release();
  }
}

function getUtcNow() {
  return new Date(new Date().toISOString());
}

function getUsernameLabel(from) {
  if (from.username) return `@${from.username}`;
  if (from.first_name || from.last_name) return `${from.first_name || ''} ${from.last_name || ''}`.trim();
  return `${from.id}`;
}

function formatCm(n) {
  return roundCm(n).toFixed(2);
}

function formatCooldown(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

function formatDuration(ms) {
  const t = Math.max(0, Math.floor(Number(ms) || 0));
  const hours = Math.floor(t / 3600000);
  const minutes = Math.floor((t % 3600000) / 60000);
  const seconds = Math.floor((t % 60000) / 1000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function placeLabel(index) {
  const n = index + 1;
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th Place`;
  if (mod10 === 1) return `${n}st Place`;
  if (mod10 === 2) return `${n}nd Place`;
  if (mod10 === 3) return `${n}rd Place`;
  return `${n}th Place`;
}

function formatPrizeAmount(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  if (Math.abs(x - Math.round(x)) < 1e-9) return String(Math.round(x));
  return String(parseFloat(x.toFixed(6)));
}

const PRIZE_COOLDOWN_MS = 30 * 60 * 1000;
const prizeCooldownAt = new Map(); // `${chatId}:${userId}` -> timestamp

function prizeCooldownKey(chatId, userId) {
  return `${chatId}:${userId}`;
}

/** Random grow delta with 2 decimal places. Mostly gains; occasional shrink. */
function randomGrowDelta(mustBePositive) {
  if (mustBePositive || Math.random() < 0.90) {
    return roundCm(0.01 + Math.random() * 14.99); // +0.01 .. +15.00
  }
  return roundCm(-(0.01 + Math.random() * 4.99)); // -0.01 .. -5.00
}

/**
 * If horns are over 100cm, 5% chance they snap to a stump of at most 5.00cm.
 * Returns { snapped, before, after } when checked; after is the length to keep.
 */
async function maybeSnapHorns(chatId, userId, currentLength) {
  const before = roundCm(currentLength);
  if (before <= 100) {
    return { snapped: false, before, after: before };
  }
  if (Math.random() >= 0.05) {
    return { snapped: false, before, after: before };
  }
  const stump = roundCm(0.01 + Math.random() * 4.99); // 0.01 .. 5.00
  await setLength(chatId, userId, stump);
  return { snapped: true, before, after: stump };
}

const FOOTER_HTML = `\n\n<a href="https://t.me/DomIncXRP">Bull Royale - Part of Dom Inc</a>`;
function addFooter(text) {
  return `${text}${FOOTER_HTML}`;
}

function withGrowButton(options) {
  const existing = options && options.reply_markup && Array.isArray(options.reply_markup.inline_keyboard)
    ? options.reply_markup.inline_keyboard.slice()
    : [];
  const inline_keyboard = existing.concat([[{ text: 'Grow horns', callback_data: 'grow_now' }]]);
  return {
    ...(options || {}),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      ...(options && options.reply_markup ? options.reply_markup : {}),
      inline_keyboard
    }
  };
}

function sendWithGrow(chatId, text, options) {
  return bot.sendMessage(chatId, addFooter(text), withGrowButton(options));
}

function sendWithFooter(chatId, text, options) {
  const opts = { ...(options || {}), parse_mode: 'HTML', disable_web_page_preview: true };
  return bot.sendMessage(chatId, addFooter(text), opts);
}

await initSchema();
const bot = new TelegramBot(token, { polling: true });
const BOT_INFO = await bot.getMe();
const BOT_ID = BOT_INFO.id;
const BOT_USERNAME = BOT_INFO.username;
console.log(`[startup] Bot ID=${BOT_ID} username=@${BOT_USERNAME}`);

/** Exact /cmd or /cmd@ThisBot only — not /cmdExtra or /cmd@OtherBot */
function commandRegex(command, argsPattern = '') {
  const at = BOT_USERNAME
    ? `(?:@${BOT_USERNAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})?`
    : '';
  if (!argsPattern) {
    return new RegExp(`^/${command}${at}(?:\\s|$)`, 'i');
  }
  return new RegExp(`^/${command}${at}${argsPattern}`, 'i');
}

/** True in DMs always; in groups only if @BotUsername appears (e.g. /help@Bot). */
function isBotTagged(msg) {
  if (!msg?.chat || msg.chat.type === 'private') return true;
  const uname = String(BOT_USERNAME || '').toLowerCase();
  if (!uname) return false;
  const text = msg.text || msg.caption || '';
  const escaped = uname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`@${escaped}\\b`, 'i').test(text)) return true;
  const entities = msg.entities || msg.caption_entities || [];
  for (const e of entities) {
    if (e.type === 'text_mention' && Number(e.user?.id) === Number(BOT_ID)) return true;
    if (e.type === 'mention') {
      const mention = text.slice(e.offset, e.offset + e.length).toLowerCase();
      if (mention === `@${uname}`) return true;
    }
  }
  return false;
}

const HELP_TEXT =
  `<b>Bull Royale</b>\n` +
  `Bull Royale is a competitive Telegram game where players grow their horns, challenge rivals and compete to become the top bull on the leaderboard. Progress comes from consistent activity, successful duels and strategic play. The objective is simple. Build the strongest bull and become the Alpha Bull.\n\n` +
  `<b>Rules</b>\n` +
  `• Every player begins with a bull and an initial horn length.\n` +
  `• Horn growth is earned through game commands, regular activity and winning duels.\n` +
  `• If you lose a duel, you lose horn length to your opponent.\n` +
  `• Players over 100cm can be snapped, giving newer players the chance to catch up.\n` +
  `• Duel commands let you challenge another player for a chosen amount of horn length.\n` +
  `• Each round lasts 72 hours.\n` +
  `• Prizes are awarded to the top 3 bulls at the end of every round.\n` +
  `• The leaderboard updates as bulls grow and battle.\n` +
  `• The goal is to grow the biggest horns and become the Alpha Bull.\n\n` +
  `<b>Commands</b>\n` +
  `• /grow — Increase your horn length once every ${GROW_COOLDOWN_HOURS} hours. Use this regularly to keep growing.\n\n` +
  `• /attack — Challenge another player to a duel. Win to steal your opponent's horn length. Lose and they take yours.\n\n` +
  `• /attack [amount] — Duel another player for a chosen amount of horn length.\n` +
  `Example: /attack 30\n\n` +
  `• /setwallet — Opens a private DM where you can add your Solana wallet address to become eligible for $HBULL rewards.`;

async function reloadImagesCache() {
  const rows = await getAllImages();
  const next = { ...DEFAULT_IMAGES };
  for (const r of rows) {
    if (!r.url) continue;
    // Ignore legacy remote defaults so bundled assets win
    if (/burnwithmerch\.com/i.test(r.url)) continue;

    const normalized = normalizeImageRef(r.url);
    if (!normalized) continue;

    // Prefer stored Telegram file_ids / URLs over bundled defaults
    if (isTelegramFileRef(normalized) || isRemoteMediaUrl(normalized)) {
      next[r.key] = normalized;
      // Persist normalized form if we upgraded a bare file_id
      if (normalized !== r.url) {
        setImageUrl(r.key, normalized).catch((e) => {
          console.error('normalize image ref persist failed', r.key, e?.message || e);
        });
      }
      continue;
    }

    // Local path — only keep if the file exists on this machine
    if (isLocalMediaPath(normalized)) {
      next[r.key] = normalized;
      continue;
    }
    // Stale path from another deploy — ignore, keep default
  }
  imagesCache = next;
  const summary = Object.entries(imagesCache)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}:${isTelegramFileRef(v) ? 'tg' : isRemoteMediaUrl(v) ? 'url' : 'file'}`)
    .join(', ');
  console.log(`[media] cache loaded: ${summary || '(defaults only)'}`);
}
await reloadImagesCache();

/** Compact Telegram / HTTP errors (avoid dumping full response objects into logs). */
function formatTelegramError(err) {
  if (!err) return 'unknown error';
  const status = err.response?.statusCode || err.response?.status || err.code;
  const body = err.response?.body;
  const desc =
    (typeof body === 'object' && (body.description || body.error_code))
      ? `${body.error_code || ''} ${body.description || ''}`.trim()
      : (typeof body === 'string' ? body.slice(0, 200) : null);
  const msg = err.message || String(err);
  if (status || desc) {
    return [msg, status && `status=${status}`, desc && `body=${desc}`].filter(Boolean).join(' | ');
  }
  return msg;
}

function isBadTelegramFileIdError(err) {
  const text = `${err?.message || ''} ${err?.response?.body?.description || ''}`.toLowerCase();
  return (
    text.includes('wrong file_id') ||
    text.includes('file is too big') ||
    text.includes('failed to get http url content') ||
    text.includes('wrong type of the web page content') ||
    text.includes('failed to get file') ||
    /bad request:.*file/i.test(text)
  );
}

bot.on('polling_error', (err) => {
  console.error('[polling_error]', formatTelegramError(err));
});

const recentGroupWelcomes = new Map(); // chatId -> timestamp
const WELCOME_DEDUPE_MS = 60_000;

async function notifyBotAddedToGroup(chat, actor) {
  try {
    const chatId = chat.id;
    const now = Date.now();
    const last = recentGroupWelcomes.get(chatId);
    if (last && now - last < WELCOME_DEDUPE_MS) return;
    recentGroupWelcomes.set(chatId, now);

    // Welcome the group with the Bull Royale poster + command breakdown
    await sendKeyedMedia(chatId, 'poster', {
      parse_mode: 'HTML',
      caption: addFooter(
        `<b>Bull Royale</b> has entered the arena.\n` +
        `Grow. Duel. Steal horns.\n\n` +
        `<b>Commands</b>\n` +
        `/grow — Grow your horns (every ${GROW_COOLDOWN_HOURS}h)\n` +
        `/attack &lt;bet&gt; — Challenge a Horn Clash\n` +
        `/stats — Horn length &amp; W/L\n` +
        `/top — Top 10 in this group\n` +
        `/average — Group &amp; global averages\n` +
        `/bulloftheday — Today's random champion\n\n` +
        `Use /grow to start.`
      )
    });
  } catch (e) {
    console.error('Failed to welcome new group', e?.message || e);
  }
}

const growInFlight = new Set(); // `${chatId}:${userId}` — blocks same-process double /grow

async function performGrow(chatId, user) {
  const userId = user.id;
  const lockKey = `${chatId}:${userId}`;
  if (growInFlight.has(lockKey)) {
    // Second tap while first is still running — ignore silently
    return { ok: false, reason: 'busy' };
  }
  growInFlight.add(lockKey);

  try {
    const utcNow = getUtcNow();
    const allowed = await canGrow(chatId, userId, utcNow);
    if (!allowed) {
      const remaining = await getGrowCooldownRemainingMs(chatId, userId, utcNow);
      const caption =
        `You've already grown your horns recently. Wait ${formatCooldown(remaining)}.\n` +
        `Free growth resets every ${GROW_COOLDOWN_HOURS} hours.`;
      await sendKeyedMedia(chatId, 'grow', {
        parse_mode: 'HTML',
        caption: addFooter(caption)
      });
      return { ok: false, reason: 'cooldown' };
    }

    const current = await getUser(chatId, userId);
    const mustBePositive = current && Number(current.length_cm) === 0;
    const delta = randomGrowDelta(mustBePositive);
    // Atomic cooldown gate — only one concurrent grow can win
    let updated = await tryApplyGrowth(chatId, userId, delta, utcNow);
    if (!updated) {
      const remaining = await getGrowCooldownRemainingMs(chatId, userId, utcNow);
      const caption =
        `You've already grown your horns recently. Wait ${formatCooldown(remaining)}.\n` +
        `Free growth resets every ${GROW_COOLDOWN_HOURS} hours.`;
      await sendKeyedMedia(chatId, 'grow', {
        parse_mode: 'HTML',
        caption: addFooter(caption)
      });
      return { ok: false, reason: 'cooldown' };
    }

    const sign = delta >= 0 ? '+' : '';

    const snap = await maybeSnapHorns(chatId, userId, updated.length_cm);
    if (snap.snapped) {
      updated = await getUser(chatId, userId);
      const caption =
        `${getUsernameLabel(user)} used /grow: ${sign}${formatCm(delta)}cm… but their horns SNAPPED!\n` +
        `${formatCm(snap.before)}cm → stump of ${formatCm(snap.after)}cm.`;
      await sendKeyedMedia(chatId, 'snap', {
        parse_mode: 'HTML',
        caption: addFooter(caption)
      });
      return { ok: true, snapped: true, updated };
    }

    const caption = `${getUsernameLabel(user)} used /grow: ${sign}${formatCm(delta)}cm. Current horns: ${formatCm(updated.length_cm)}cm.`;
    const mediaKey = delta < 0 ? 'snap' : 'grow';
    await sendKeyedMedia(chatId, mediaKey, {
      parse_mode: 'HTML',
      caption: addFooter(caption)
    });
    return { ok: true, snapped: false, updated };
  } finally {
    growInFlight.delete(lockKey);
  }
}

// /help — groups only when bot is tagged (/help@BotName)
bot.onText(commandRegex('help'), async (msg) => {
  if (!msg.chat) return;
  if (!isBotTagged(msg)) return;
  try {
    await sendWithFooter(msg.chat.id, HELP_TEXT);
  } catch (err) {
    console.error('help error', err);
  }
});

// /prize — current round prize split + time remaining (30m cooldown per user)
bot.onText(commandRegex('prize'), async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const cdKey = prizeCooldownKey(chatId, userId);
  const lastAt = prizeCooldownAt.get(cdKey) || 0;
  const elapsed = Date.now() - lastAt;
  if (lastAt && elapsed < PRIZE_COOLDOWN_MS) {
    const remaining = PRIZE_COOLDOWN_MS - elapsed;
    // Personal popup via callback-style alert isn't available for slash commands;
    // DM the user so the group isn't spammed. Fall back to a short group notice.
    const coolText = `You're on cooldown for /prize. Try again in ${formatDuration(remaining)}.`;
    try {
      await bot.sendMessage(userId, coolText);
    } catch {
      const notice = await bot.sendMessage(chatId, coolText, {
        reply_to_message_id: msg.message_id
      });
      setTimeout(() => {
        bot.deleteMessage(chatId, notice.message_id).catch(() => {});
      }, 8000);
    }
    return;
  }

  try {
    const group = await getGroupRewards(chatId);
    if (!group?.reward_mint || !(group.reward_amount > 0) || !(group.winner_count >= 1)) {
      prizeCooldownAt.set(cdKey, Date.now());
      await sendWithFooter(
        chatId,
        'Prizes are not configured for this group yet. An admin can set them up with /setbull.'
      );
      return;
    }

    const n = Math.max(1, Math.min(Number(group.winner_count) || 1, 50));
    const shares = cascadingShares(group.reward_amount, n);
    const tokenName = await getTokenMetadataName(group.reward_mint).catch(() => 'tokens');
    const lines = ['<b>Current prizes for this round</b>'];
    if (group.rewards_enabled === false) {
      lines.push('<i>Rewards are currently OFF for this group.</i>');
    }
    for (let i = 0; i < shares.length; i++) {
      lines.push(`${placeLabel(i)}: ${formatPrizeAmount(shares[i])} ${tokenName}`);
    }

    const periodHours = Math.max(1, Number(group.period_hours) || 1);
    if (group.period_started_at) {
      const endMs = new Date(group.period_started_at).getTime() + periodHours * 3600000;
      const left = endMs - Date.now();
      if (left > 0) {
        lines.push('');
        lines.push(`You have <b>${formatDuration(left)}</b> remaining in this round.`);
      } else {
        lines.push('');
        lines.push('This round has ended — payout is pending.');
      }
    } else {
      lines.push('');
      lines.push('The reward period has not started yet.');
    }

    prizeCooldownAt.set(cdKey, Date.now());
    await sendWithFooter(chatId, lines.join('\n'));
  } catch (err) {
    console.error('prize error', err);
    await sendWithFooter(chatId, 'Could not load prize info right now.');
  }
});

// /grow
bot.onText(commandRegex('grow'), async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const user = msg.from;
  await ensureUser(chatId, user);
  try {
    await performGrow(chatId, user);
  } catch (err) {
    console.error('grow error', err);
    const caption = 'Something went wrong processing /grow.';
    try {
      await sendKeyedMedia(chatId, 'grow', { parse_mode: 'HTML', caption: addFooter(caption) });
    } catch (e) {
      console.error('send media fallback failed', e);
      await sendWithFooter(chatId, caption);
    }
  }
});

// /average
bot.onText(commandRegex('average'), async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  await ensureUser(chatId, msg.from);
  try {
    const groupAvgRow = await getGroupAverageAndRank(chatId);
    const groupAvg = groupAvgRow.avg;
    const groupRank = groupAvgRow.rank;
    const groupTotal = groupAvgRow.total;
    const globalAvg = await getGlobalAverageLength();
    const groupText = Number.isFinite(groupAvg) ? formatCm(groupAvg) : '0.00';
    const globalText = Number.isFinite(globalAvg) ? formatCm(globalAvg) : '0.00';
    const text =
      `This group's average horn size is ${groupText}cm.\n` +
      (Number.isFinite(groupRank) && groupTotal > 0
        ? `<b>Your group is ranked number ${groupRank}.</b>\n`
        : '') +
      `The overall average horn size for Bull Royale is ${globalText}cm.`;
    await sendWithGrow(chatId, text);
  } catch (err) {
    console.error('average error', err);
    await sendWithGrow(chatId, 'Could not calculate averages.');
  }
});

// /gift — admin drops a first-come claim for +5–20cm horns
const openGifts = new Map(); // giftId -> { chatId, claimed }

bot.onText(commandRegex('gift'), async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const from = msg.from;

  if (!(await canManageSetbull(chatId, from.id))) {
    return;
  }

  try {
    const group = await ensureGroupRewards(chatId);
    const cooldownMins = Math.max(1, Number(group.gift_cooldown_mins) || 30);
    const lastGift = group.last_gift_at ? new Date(group.last_gift_at).getTime() : 0;
    const cooldownMs = cooldownMins * 60 * 1000;
    const elapsed = Date.now() - lastGift;
    if (lastGift && elapsed < cooldownMs) {
      const left = cooldownMs - elapsed;
      await sendWithFooter(
        chatId,
        `/gift is on cooldown. Try again in ${formatDuration(left)}.`
      );
      return;
    }

    await updateGroupRewards(chatId, { last_gift_at: new Date() });

    const giftId = `${chatId}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    openGifts.set(giftId, { chatId, claimed: false });

    const adminLabel = getUsernameLabel(from);
    const text =
      `<b>Horn gift drop!</b>\n` +
      `${adminLabel} dropped a gift.\n` +
      `First to claim gets a random <b>+5–20cm</b> of horns.`;

    await bot.sendMessage(chatId, addFooter(text), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: 'Claim gift', callback_data: `giftclaim:${giftId}` }]]
      }
    });
  } catch (err) {
    console.error('gift error', err);
    await sendWithFooter(chatId, 'Failed to drop a gift.');
  }
});

// /top
bot.onText(commandRegex('top'), async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  await ensureUser(chatId, msg.from);
  try {
    const top = await getTopUsers(chatId, 10);
    if (!top || top.length === 0) {
      await sendWithGrow(chatId, 'No members found.');
      return;
    }
    const lines = top.map((u, idx) => {
      const label = getUsernameLabel({ id: u.user_id, username: u.username, first_name: u.first_name });
      return `${idx + 1}. ${label} — ${formatCm(u.length_cm)}cm`;
    });
    const caption = `Top 10 horns:\n${lines.join('\n')}`;
    if (getImageUrl('top')) {
      await sendKeyedMedia(chatId, 'top', {
        parse_mode: 'HTML',
        caption: addFooter(caption),
        ...withGrowButton({})
      });
    } else {
      await sendWithGrow(chatId, caption);
    }
  } catch (err) {
    console.error('top error', err);
    await sendWithGrow(chatId, 'Could not fetch leaderboard.');
  }
});

// /attack <bet>
bot.onText(commandRegex('attack', '(?:\\s+(\\d+(?:\\.\\d{1,2})?))?(?:\\s|$)'), async (msg, match) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const user = msg.from;
  const userId = user.id;
  await ensureUser(chatId, user);
  const bet = roundCm(parseFloat(match?.[1] || ''));
  if (!bet || !Number.isFinite(bet) || bet <= 0) {
    await sendWithGrow(chatId, 'Usage: /attack &lt;bet_cm&gt; (e.g. /attack 12.18)');
    return;
  }
  try {
    const me = await getUser(chatId, userId);
    if (!me) {
      await sendWithGrow(chatId, 'You are not registered yet. Try again.');
      return;
    }
    if (Number(me.length_cm) < bet) {
      await sendWithGrow(chatId, `Insufficient horns. You have ${formatCm(me.length_cm)}cm but tried to bet ${formatCm(bet)}cm.`);
      return;
    }
    const existing = await getOpenChallengeByAttacker(chatId, userId);
    if (existing) {
      await cancelOpenChallengesByAttacker(chatId, userId);
    }
    const caption =
      `${getUsernameLabel(user)} challenges the group to a Horn Clash for ${formatCm(bet)}cm!\nAccept the challenge and lock horns!`;
    const message = await sendKeyedMedia(chatId, 'attack', {
      parse_mode: 'HTML',
      caption: addFooter(caption),
      reply_markup: {
        inline_keyboard: [[{ text: 'Accept Horn Clash', callback_data: `accept:${bet}` }]]
      }
    });
    await createChallenge(chatId, userId, bet, message.message_id);
  } catch (err) {
    console.error('attack error', err);
    await sendWithGrow(chatId, 'Something went wrong creating the challenge.');
  }
});

// /update — admin image dashboard
bot.onText(commandRegex('update'), async (msg) => {
  if (!msg.chat || !msg.from) return;
  if (!isAdminUser(msg.from.id)) return;
  const chatId = msg.chat.id;
  const keyboard = [
    [{ text: 'Update Poster', callback_data: 'imgupd:poster' }],
    [{ text: 'Update Grow', callback_data: 'imgupd:grow' }],
    [{ text: 'Update Snap', callback_data: 'imgupd:snap' }],
    [{ text: 'Update Top', callback_data: 'imgupd:top' }],
    [{ text: 'Update Attack (photo/video)', callback_data: 'imgupd:attack' }],
    [{ text: 'Update Attack Resolved (photo/video)', callback_data: 'imgupd:attack_resolved' }]
  ];
  await bot.sendMessage(chatId, addFooter('Admin: Choose which media to update.'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard }
  });
});

const pendingImageUpdate = new Map();

// /setbull — group admin (or primary owner) rewards dashboard
bot.onText(commandRegex('setbull'), async (msg) => {
  if (!msg.chat || !msg.from) return;
  if (!(await canManageSetbull(msg.chat.id, msg.from.id))) return;
  const chatId = msg.chat.id;
  try {
    // Replace any prior session so only this admin owns the new menu
    const prev = setbullMenuMessages.get(Number(chatId));
    if (prev?.ownerId != null) {
      const pending = pendingSetbull.get(prev.ownerId);
      if (pending?.chatId === chatId) {
        try { await bot.deleteMessage(chatId, pending.replyToMessageId); } catch {}
        pendingSetbull.delete(prev.ownerId);
      }
      if (prev.messageId) {
        try { await bot.deleteMessage(chatId, prev.messageId); } catch {}
      }
    }
    const menu = await buildSetbullMenu(chatId, msg.from.id);
    const sent = await bot.sendMessage(chatId, addFooter(menu.text), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: menu.reply_markup
    });
    rememberSetbullMenu(chatId, sent.message_id, msg.from.id);
  } catch (err) {
    console.error('setbull error', err);
    await sendWithFooter(chatId, 'Could not open rewards settings.');
  }
});

// /setwallet — register Solana address via DM
bot.onText(commandRegex('setwallet'), async (msg) => {
  if (!msg.chat || !msg.from) return;
  try {
    await ensureUser(msg.chat.id, msg.from);
    await startSetwalletFlow(bot, msg, addFooter);
  } catch (err) {
    console.error('setwallet error', err);
  }
});

// /owner — group creator only: DM the treasury private key (never post it in the group)
bot.onText(commandRegex('owner'), async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
    await sendWithFooter(chatId, 'Use /owner in a group chat.');
    return;
  }

  try {
    const member = await bot.getChatMember(chatId, userId);
    if (member?.status !== 'creator') {
      await sendWithFooter(chatId, 'Only the Telegram group owner can use /owner.');
      return;
    }

    const group = await getGroupRewards(chatId);
    if (!group?.wallet_pubkey || !group?.wallet_privkey_enc) {
      await sendWithFooter(chatId, 'This group has no rewards wallet yet. An admin must generate one with /setbull.');
      return;
    }

    let secretBytes;
    try {
      secretBytes = decryptSecret(group.wallet_privkey_enc);
    } catch (e) {
      console.error('owner decrypt failed', chatId, e?.message || e);
      await sendWithFooter(chatId, 'Could not unlock the treasury key. Contact the bot operator.');
      return;
    }

    const secretB58 = secretKeyToBase58(secretBytes);
    const dmText =
      `<b>Bull Royale treasury key</b>\n` +
      `Group: ${escHtmlHelp(msg.chat.title || String(chatId))}\n` +
      `Public key:\n<code>${group.wallet_pubkey}</code>\n\n` +
      `Private key (base58 — keep secret):\n<code>${secretB58}</code>\n\n` +
      `Anyone with this key can move the group's funds. Store it safely and do not share it.`;

    try {
      await bot.sendMessage(userId, addFooter(dmText), {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    } catch (e) {
      console.error('owner DM failed', userId, e?.message || e);
      await sendWithFooter(
        chatId,
        'I could not message you privately. Open a private chat with me, press <b>Start</b>, then run /owner again.\n\n' +
        'The private key was <b>not</b> sent to this group.'
      );
      return;
    }

    await sendWithFooter(
      chatId,
      'Sent the treasury private key to your DMs. Check your private chat with me — it was not posted here.'
    );
  } catch (err) {
    console.error('owner command error', err);
    await sendWithFooter(chatId, 'Something went wrong running /owner.');
  }
});

function escHtmlHelp(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// /nobull — admin blacklist by reply
bot.onText(commandRegex('nobull'), async (msg) => {
  try {
    await handleNobull(bot, msg, addFooter, isAdminUser, getUsernameLabel);
  } catch (err) {
    console.error('nobull error', err);
  }
});

// /stats
bot.onText(commandRegex('stats', '(?:\\s+(.+))?(?:\\s|$)'), async (msg, match) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const user = msg.from;
  await ensureUser(chatId, user);
  try {
    const targetRef = (match?.[1] || '').trim();
    let targetUserId = user.id;
    let targetRow = null;
    if (targetRef) {
      const entities = msg.entities || [];
      const tm = entities.find(e => e.type === 'text_mention' && e.user);
      if (tm && tm.user) {
        targetUserId = tm.user.id;
        await ensureUser(chatId, tm.user);
      } else if (targetRef.startsWith('@')) {
        const u = await getUserByUsername(chatId, targetRef);
        if (u) {
          targetUserId = Number(u.user_id);
          targetRow = u;
        } else {
          await sendWithGrow(chatId, `I don't have any stats for ${targetRef}.`);
          return;
        }
      }
    }
    const person = targetRow || (await getUser(chatId, targetUserId));
    if (!person) {
      await sendWithGrow(chatId, 'No stats yet. Use /grow to begin.');
      return;
    }
    const total = Number(person.wins) + Number(person.losses);
    const pct = total > 0 ? Math.round((Number(person.wins) / total) * 100) : 0;
    const label = getUsernameLabel({ id: person.user_id, username: person.username, first_name: person.first_name });
    const horns = Number(person.length_cm);
    let text = `${label}\nHorns: ${formatCm(horns)}cm\nW/L: ${person.wins}/${person.losses} (${pct}%)`;
    if (horns > 100) {
      text += `\n\n⚠️ <b>Danger zone!</b> Horns over 100cm risk snapping (5% chance on grow/clash) down to a stump of at most 5.00cm.`;
    }
    await sendWithGrow(chatId, text);
  } catch (err) {
    console.error('stats error', err);
    await sendWithGrow(chatId, 'Could not load stats.');
  }
});

// /bulloftheday
bot.onText(commandRegex('bulloftheday'), async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  await ensureUser(chatId, msg.from);
  const utcNow = getUtcNow();
  try {
    const potd = await selectOrCreatePotd(chatId, utcNow);
    if (!potd) {
      await sendWithGrow(chatId, 'No registered members found to choose from.');
      return;
    }
    const label = getUsernameLabel({ id: potd.user_id, username: potd.username, first_name: potd.first_name });
    await sendWithGrow(chatId, `Bull of the Day goes to: ${label} — ${formatCm(potd.length_cm)}cm horns`);
  } catch (err) {
    console.error('potd error', err);
    await sendWithGrow(chatId, 'Could not determine Bull of the Day.');
  }
});

bot.on('message', async (msg) => {
  try {
    if (!msg.chat) return;

    // /setwallet DM address capture
    if (await handleSetwalletPending(bot, msg, addFooter, getUsernameLabel)) return;

    // Cancel pending setwallet
    if (
      msg.chat.type === 'private' &&
      msg.from &&
      pendingSetwallet.has(msg.from.id) &&
      typeof msg.text === 'string' &&
      /^\/cancel(@\w+)?$/i.test(msg.text.trim())
    ) {
      pendingSetwallet.delete(msg.from.id);
      await bot.sendMessage(msg.chat.id, addFooter('Wallet registration cancelled.'), {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
      return;
    }

    // /setbull force-reply inputs (only the user who started the prompt)
    if (msg.from && pendingSetbull.has(msg.from.id)) {
      if (await handleSetbullPendingInput(bot, msg, addFooter)) return;
    }

    if (msg.from && isAdminUser(msg.from.id)) {
      const state = pendingImageUpdate.get(msg.from.id);
      if (state && msg.chat.id === state.chatId && msg.reply_to_message && msg.reply_to_message.message_id === state.replyToMessageId) {
        const { key } = state;
        const label = key.replace(/_/g, ' ');
        let newUrl = null;
        if (msg.video && msg.video.file_id) {
          newUrl = `video:${msg.video.file_id}`;
        } else if (msg.animation && msg.animation.file_id) {
          newUrl = `animation:${msg.animation.file_id}`;
        } else if (Array.isArray(msg.photo) && msg.photo.length > 0) {
          const best = msg.photo.reduce((a, b) => ((a.file_size || 0) > (b.file_size || 0) ? a : b));
          newUrl = `photo:${best.file_id}`;
        } else if (msg.document && msg.document.file_id) {
          const mime = String(msg.document.mime_type || '');
          const name = msg.document.file_name || '';
          if (mime.startsWith('video/') || isVideoMedia(name)) {
            newUrl = `video:${msg.document.file_id}`;
          } else if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(name)) {
            newUrl = `photo:${msg.document.file_id}`;
          }
        } else if (typeof msg.text === 'string' && /^https?:\/\//i.test(msg.text.trim())) {
          const candidate = msg.text.trim();
          if (/^https?:\/\/api\.telegram\.org\//i.test(candidate)) {
            try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch {}
            const current = getImageUrl(key) || '(none)';
            const prompt = `Send a photo, video, or media URL to set the ${label} media.\nCurrent: ${current}`;
            try {
              await bot.editMessageText(addFooter(prompt), {
                chat_id: state.chatId,
                message_id: state.replyToMessageId,
                parse_mode: 'HTML',
                disable_web_page_preview: true
              });
            } catch {
              await bot.sendMessage(msg.chat.id, addFooter(prompt), { parse_mode: 'HTML', disable_web_page_preview: true });
            }
            return;
          }
          newUrl = isVideoMedia(candidate) ? `video:${candidate}` : candidate;
        }
        if (!newUrl) {
          try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch {}
          const current = getImageUrl(key) || '(none)';
          const prompt = `Send a photo, video, or media URL to set the ${label} media.\nCurrent: ${current}`;
          try {
            await bot.editMessageText(addFooter(prompt), {
              chat_id: state.chatId,
              message_id: state.replyToMessageId,
              parse_mode: 'HTML',
              disable_web_page_preview: true
            });
          } catch {
            await bot.sendMessage(msg.chat.id, addFooter(prompt), { parse_mode: 'HTML', disable_web_page_preview: true });
          }
          return;
        }
        await setImageUrl(key, newUrl);
        if (key === 'snap' || key === 'shrunk') {
          await setImageUrl(key === 'snap' ? 'shrunk' : 'snap', newUrl);
        }
        await reloadImagesCache();

        // If they set an http(s) URL, upload once now and store Telegram file_id for fast reuse
        if (isRemoteMediaUrl(newUrl)) {
          try {
            const warmChatId = msg.from.id; // DM the admin so the group isn't spammed
            const warmMsg = await sendKeyedMedia(warmChatId, key, {
              caption: addFooter(`Caching ${label} media for fast reuse…`),
              parse_mode: 'HTML'
            });
            // sendKeyedMedia already caches file_id when URL is uploaded
            if (warmMsg?.message_id) {
              setTimeout(() => {
                bot.deleteMessage(warmChatId, warmMsg.message_id).catch(() => {});
              }, 3000);
            }
          } catch (e) {
            console.error('warm media cache failed', key, e?.message || e);
          }
        }

        try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch {}
        const kind = isVideoMedia(getImageUrl(key) || newUrl) ? 'video' : 'image';
        const after = getImageUrl(key) || newUrl;
        const cachedNote = shouldCacheMediaFileId(after)
          ? ''
          : ' Cached for fast reuse.';
        try {
          await bot.editMessageText(addFooter(`✅ Updated ${label} ${kind}.${cachedNote}`), {
            chat_id: state.chatId,
            message_id: state.replyToMessageId,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          });
        } catch {
          await bot.sendMessage(msg.chat.id, addFooter(`✅ Updated ${label} ${kind}.${cachedNote}`), {
            parse_mode: 'HTML',
            disable_web_page_preview: true
          });
        }
        pendingImageUpdate.delete(msg.from.id);
        return;
      }
    }
    const newMembers = msg.new_chat_members;
    if (!newMembers || newMembers.length === 0) return;
    if (!newMembers.some(m => m && m.id === BOT_ID)) return;
    await notifyBotAddedToGroup(msg.chat, msg.from);
  } catch (e) {
    console.error('message handler error', e);
  }
});

bot.on('my_chat_member', async (update) => {
  try {
    const chat = update.chat;
    if (!chat) return;
    const oldStatus = update.old_chat_member?.status;
    const newStatus = update.new_chat_member?.status;
    const addedNow = (oldStatus === 'left' || oldStatus === 'kicked') &&
      (newStatus === 'member' || newStatus === 'administrator');
    if (!addedNow) return;
    await notifyBotAddedToGroup(chat, update.from);
  } catch (e) {
    console.error('my_chat_member handler error', e);
  }
});

bot.on('callback_query', async (query) => {
  const data = query.data || '';
  const msg = query.message;
  if (!msg || !msg.chat) {
    if (query.id) bot.answerCallbackQuery(query.id);
    return;
  }
  const chatId = msg.chat.id;
  const from = query.from;
  const fromId = from.id;

  if (data.startsWith('sb:')) {
    if (!(await canManageSetbull(chatId, fromId))) {
      if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Group admins only.', show_alert: true });
      return;
    }
    try {
      await handleSetbullCallback(bot, query, addFooter, getUsernameLabel);
    } catch (err) {
      console.error('setbull callback error', err);
      if (query.id) {
        try { await bot.answerCallbackQuery(query.id, { text: 'Something went wrong.' }); } catch {}
      }
    }
    return;
  }

  if (data === 'grow_now') {
    try {
      await ensureUser(chatId, from);
      const result = await performGrow(chatId, from);
      if (query.id) {
        await bot.answerCallbackQuery(query.id, {
          text: result.ok ? (result.snapped ? 'Snapped!' : 'Grown!') : 'Cooldown active'
        });
      }
    } catch (err) {
      console.error('grow_now error', err);
      if (query.id) {
        try { await bot.answerCallbackQuery(query.id, { text: 'Something went wrong.' }); } catch {}
      }
    }
    return;
  }

  if (data.startsWith('giftclaim:')) {
    const giftId = data.slice('giftclaim:'.length);
    const gift = openGifts.get(giftId);
    try {
      if (!gift || gift.chatId !== chatId) {
        if (query.id) {
          await bot.answerCallbackQuery(query.id, { text: 'This gift is no longer available.', show_alert: true });
        }
        return;
      }
      if (gift.claimed) {
        if (query.id) {
          await bot.answerCallbackQuery(query.id, { text: 'Already claimed!', show_alert: true });
        }
        return;
      }

      await ensureUser(chatId, from);
      const claimCdLeft = await getGiftClaimCooldownRemainingMs(chatId, fromId);
      if (claimCdLeft > 0) {
        if (query.id) {
          await bot.answerCallbackQuery(query.id, {
            text: `You've already claimed a gift recently. Try again in ${formatDuration(claimCdLeft)}.`,
            show_alert: true
          });
        }
        return;
      }

      // First-come lock (after personal cooldown check so the drop stays open)
      gift.claimed = true;

      const amount = roundCm(5 + Math.random() * 15); // 5.00 .. 20.00
      const updated = await addLength(chatId, fromId, amount);
      await recordGiftClaim(chatId, fromId);
      const label = getUsernameLabel(from);
      const text =
        `<b>Gift claimed!</b>\n` +
        `${label} claimed <b>+${formatCm(amount)}cm</b> of horns.\n` +
        `New length: <b>${formatCm(updated.length_cm)}cm</b>.`;

      let edited = false;
      try {
        await bot.editMessageText(addFooter(text), {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [] }
        });
        edited = true;
      } catch {}
      if (!edited) {
        try {
          await bot.editMessageCaption(addFooter(text), {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [] }
          });
          edited = true;
        } catch {}
      }
      if (!edited) {
        await sendWithFooter(chatId, text);
      }

      if (query.id) await bot.answerCallbackQuery(query.id, { text: `+${formatCm(amount)}cm!` });
      openGifts.delete(giftId);
    } catch (err) {
      console.error('giftclaim error', err);
      if (gift?.claimed) {
        gift.claimed = false;
      }
      if (query.id) {
        try { await bot.answerCallbackQuery(query.id, { text: 'Something went wrong.', show_alert: true }); } catch {}
      }
    }
    return;
  }

  if (data.startsWith('imgupd:')) {
    try {
      if (!isAdminUser(fromId)) {
        if (query.id) await bot.answerCallbackQuery(query.id);
        return;
      }
      const key = data.split(':')[1];
      const valid = ['poster', 'grow', 'snap', 'shrunk', 'top', 'attack', 'attack_resolved'];
      if (!valid.includes(key)) {
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Unknown media key.' });
        return;
      }
      const label = key.replace(/_/g, ' ');
      const current = getImageUrl(key) || '(none)';
      const prompt =
        `Send a photo, video, or media URL to set the ${label} media.\n` +
        `Current: ${current}`;
      const sent = await bot.sendMessage(chatId, addFooter(prompt), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { force_reply: true }
      });
      pendingImageUpdate.set(fromId, { key, chatId, replyToMessageId: sent.message_id });
      if (query.id) await bot.answerCallbackQuery(query.id);
    } catch (e) {
      console.error('imgupd error', e);
      if (query.id) {
        try { await bot.answerCallbackQuery(query.id, { text: 'Something went wrong.' }); } catch {}
      }
    }
    return;
  }

  if (!data.startsWith('accept:')) {
    if (query.id) bot.answerCallbackQuery(query.id);
    return;
  }

  try {
    const challenge = await getOpenChallengeByMessageId(chatId, msg.message_id);
    if (!challenge) {
      if (query.id) await bot.answerCallbackQuery(query.id, { text: 'This challenge has been cancelled.' });
      return;
    }
    const outcome = await resolveChallengeTransaction(challenge.id, chatId, fromId);
    if (!outcome.ok) {
      const reasonText = {
        already_resolved: 'Challenge already resolved.',
        self_accept: 'You cannot accept your own challenge.',
        attacker_insufficient: 'Challenger lacks enough horn cm.',
        acceptor_insufficient: 'Your horns are too short.',
        missing_user: 'One of the fighters is not registered.'
      }[outcome.reason] || 'Unable to accept challenge.';
      if (query.id) await bot.answerCallbackQuery(query.id, { text: reasonText, show_alert: false });
      return;
    }
    const { result } = outcome;
    const winnerMention = result.winnerId === Number(result.attacker.user_id)
      ? getUsernameLabel(result.attacker)
      : getUsernameLabel(result.acceptor);
    const loserMention = result.winnerId === Number(result.attacker.user_id)
      ? getUsernameLabel(result.acceptor)
      : getUsernameLabel(result.attacker);

    let updatedWinner = await getUser(chatId, result.winnerId);
    let updatedLoser = await getUser(chatId, result.loserId);

    // Snap risk for anyone now over 100cm
    const snapNotes = [];
    for (const [uid, label] of [[result.winnerId, winnerMention], [result.loserId, loserMention]]) {
      const u = uid === result.winnerId ? updatedWinner : updatedLoser;
      const snap = await maybeSnapHorns(chatId, uid, u?.length_cm ?? 0);
      if (snap.snapped) {
        snapNotes.push(`${label}'s horns SNAPPED! ${formatCm(snap.before)}cm → ${formatCm(snap.after)}cm stump.`);
        if (uid === result.winnerId) updatedWinner = await getUser(chatId, uid);
        else updatedLoser = await getUser(chatId, uid);
      }
    }

    const loserLoss = result.betCm;
    let baseText =
      `${winnerMention} took ${formatCm(loserLoss)}cm of ${loserMention}'s horns.\n` +
      `Their new sizes are:\n` +
      `${winnerMention}: ${formatCm(updatedWinner?.length_cm ?? 0)}cm\n` +
      `${loserMention}: ${formatCm(updatedLoser?.length_cm ?? 0)}cm`;
    if (snapNotes.length) {
      baseText += `\n\n${snapNotes.join('\n')}`;
    }

    try {
      const resolved = resolveMedia('attack_resolved') || resolveMedia('attack') || resolveMedia('poster');
      if (resolved && resolved.media) {
        await bot.editMessageMedia(
          {
            type: resolved.type,
            media: resolved.media,
            caption: addFooter(baseText),
            parse_mode: 'HTML'
          },
          { chat_id: chatId, message_id: msg.message_id }
        );
      } else {
        await bot.editMessageCaption(addFooter(baseText), {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: 'HTML'
        });
      }
    } catch {
      try {
        await bot.editMessageCaption(addFooter(baseText), {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: 'HTML'
        });
      } catch {
        await sendWithFooter(chatId, baseText);
      }
    }
    if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Duel complete!' });
  } catch (err) {
    console.error('callback error', err);
    if (query.id) {
      try { await bot.answerCallbackQuery(query.id, { text: 'Something went wrong.' }); } catch {}
    }
  }
});

async function start() {
  console.log('Bot started with long polling.');
  const app = express();
  app.get('/', (_req, res) => res.send('Bull Royale bot is running.'));
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`HTTP server listening on ${port}`);
  });

  const REWARD_TICK_MS = 5 * 60 * 1000;
  const tick = () => {
    runRewardTick(bot, addFooter, getUsernameLabel).catch((e) => {
      console.error('reward tick error', e?.message || e);
    });
  };
  tick();
  setInterval(tick, REWARD_TICK_MS);

  process.once('SIGINT', () => bot.stopPolling());
  process.once('SIGTERM', () => bot.stopPolling());
}

start().catch((e) => {
  console.error('Failed to start bot', e);
  process.exit(1);
});
