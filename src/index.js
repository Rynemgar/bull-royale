import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import https from 'https';
import { Client as XrplClient, xrpToDrops, Wallet } from 'xrpl';
import TelegramBot from 'node-telegram-bot-api';
import {
  initSchema,
  ensureUser,
  getUser,
  getUserByUsername,
  canGrowToday,
  applyGrowth,
  addLength,
  createChallenge,
  getOpenChallengeByAttacker,
  getOpenChallengeByMessageId,
  getPotd,
  selectOrCreatePotd,
  cancelOpenChallengesByAttacker,
  getTopUsers,
  canPressGrowButton,
  recordGrowButtonPress,
  resolveChallengeTransaction,
  getGroupAverageLength,
  getGlobalAverageLength,
  getGroupAverageAndRank,
  createPayment,
  fulfillPayment,
  expirePayment,
  ensureImageDefaults,
  getAllImages,
  setImageUrl,
  setXrplAddress,
  getRubState,
  consumePaidFlip,
  recordFreeRub,
  addPaidFlips,
  createRubPayment,
  fulfillRubPayment,
  expireRubPayment
} from './db.js';

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
const XRPL_ENDPOINT = process.env.XRPL_ENDPOINT || 'wss://xrplcluster.com';
const XRP_DESTINATION = 'rn9i3edQrUiJ9VBDEx7DbkxrzMJ7q8esRZ';
const XRPL_SECRET = process.env.XRPL_SECRET || process.env.XRPL_SEED || '';
const RD_SEED = process.env.RD_SEED || '';
const RD_ALGORITHM = (process.env.RD_ALGORITHM || 'secp256k1').toLowerCase();
const RUB_XRP_DESTINATION = process.env.RUB_XRP_DESTINATION || 'rCUMdbZfS8t9Pz9VHYy3dbrBoCVFAmzM1';
const RIPPLE_DICK_ISSUER = 'rGxkZKJHTDd9MMxXujDs63YHRYbcTJeUgS';
const RIPD_POOL_DEST = process.env.XRPL_RIPD_POOL || process.env.XRPL_RIPPLEDICK_POOL || '';
const RUB_GROUP_ID = -1003387341298;
const HORIZON_API_KEY = process.env.HAPI || '';
function deriveHorizonRestBaseUrl() {
  const normalize = (raw) => {
    const v = (raw || '').trim();
    if (!v) return null;
    try {
      const u = new URL(v);
      const proto = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
      if (proto !== 'https:' && proto !== 'http:') return null;
      // Keep any path on explicit REST base URLs so callers can pass ".../v1" if needed.
      const path = (u.pathname || '').replace(/\/+$/, '');
      return `${proto}//${u.host}${path}`.replace(/\/+$/, '');
    } catch {
      if (/^https?:\/\//i.test(v)) return v.replace(/\/+$/, '');
      return null;
    }
  };

  const direct = normalize(process.env.HORIZON_BASE_URL);
  if (direct) return direct;
  const ws = (process.env.HORIZON_WS_URL || '').trim();
  if (!ws) return null;
  try {
    const u = new URL(ws);
    const proto = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    if (proto !== 'https:' && proto !== 'http:') return null;
    // If ws looks like "/v1/ws/...", infer "/v1" prefix.
    const prefix = (u.pathname || '').startsWith('/v1/ws/') ? '/v1' : '';
    return `${proto}//${u.host}${prefix}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}
const HORIZON_BASE_URL = deriveHorizonRestBaseUrl() || 'https://horizon-dev-api.fly.dev';
function deriveHorizonTokensBaseUrl() {
  // Prefer an explicit override for token/market endpoints.
  const explicit = (process.env.HORIZON_TOKENS_BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  // Prefer WS-derived base if present (keeps us on same environment even if HORIZON_BASE_URL is mis-set)
  const ws = (process.env.HORIZON_WS_URL || '').trim();
  if (ws) {
    try {
      const u = new URL(ws);
      const proto = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
      if (proto === 'https:' || proto === 'http:') {
        const prefix = (u.pathname || '').startsWith('/v1/ws/') ? '/v1' : '';
        return `${proto}//${u.host}${prefix}`.replace(/\/+$/, '');
      }
    } catch {}
  }
  return HORIZON_BASE_URL;
}
const HORIZON_TOKENS_BASE_URL = deriveHorizonTokensBaseUrl();
function asciiCurrencyCode(name) {
  const bytes = Buffer.from(name, 'ascii');
  return bytes.toString('hex').toUpperCase().padEnd(40, '0').slice(0, 40);
}
const RIPPLEDICK_HEX = asciiCurrencyCode('RIPPLEDICK');
// Horizon token_id format: <currencyHex>:<issuer>
const RIPPLEDICK_TOKEN_ID = process.env.RIPPLEDICK_TOKEN_ID || `${RIPPLEDICK_HEX}:${RIPPLE_DICK_ISSUER}`;
const GROW_IMAGE_URL = 'https://www.burnwithmerch.com/wp-content/uploads/2025/12/grow.jpg';
const ATTACK_IMAGE_URL = 'https://www.burnwithmerch.com/wp-content/uploads/2025/12/attack.jpg';
const ATTACK_RESOLVED_IMAGE_URL = 'https://www.burnwithmerch.com/wp-content/uploads/2025/12/attack2.jpg';
const SHRUNK_IMAGE_URL = 'https://www.burnwithmerch.com/wp-content/uploads/2025/12/Shrunk.jpg';
const SNAP_IMAGE_URL = 'https://www.burnwithmerch.com/wp-content/uploads/2025/12/Snap.jpg';
const WANK_IMAGE_URL = 'https://www.burnwithmerch.com/wp-content/uploads/2025/12/wank.jpg';

// Image config (DB-backed with defaults)
const DEFAULT_IMAGES = {
  grow: GROW_IMAGE_URL,
  shrunk: SHRUNK_IMAGE_URL,
  snap: SNAP_IMAGE_URL,
  attack: ATTACK_IMAGE_URL,
  attack_resolved: ATTACK_RESOLVED_IMAGE_URL,
  wank: WANK_IMAGE_URL
};
let imagesCache = { ...DEFAULT_IMAGES };
function getImageUrl(key) {
  return imagesCache[key] || DEFAULT_IMAGES[key];
}

function getUtcDate() {
  return new Date(new Date().toISOString());
}

function getUsernameLabel(from) {
  if (from.username) return `@${from.username}`;
  if (from.first_name || from.last_name) return `${from.first_name || ''} ${from.last_name || ''}`.trim();
  return `${from.id}`;
}

const FOOTER_HTML = `\n\n$<a href="https://t.me/rippledickcto">RIPPLEDICK</a> - Powered by Phallic Fury`;
function addFooter(text) {
  return `${text}${FOOTER_HTML}`;
}

function withGrowButton(options) {
  const existing = options && options.reply_markup && Array.isArray(options.reply_markup.inline_keyboard)
    ? options.reply_markup.inline_keyboard.slice()
    : [];
  const inline_keyboard = existing.concat([[{ text: 'Grow now', callback_data: 'grow_now' }]]);
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
const ALERT_DESTINATION = process.env.ALERT_DESTINATION || '@rippledickcto';
const BOT_INFO = await bot.getMe();
const BOT_ID = BOT_INFO.id;
const BOT_USERNAME = BOT_INFO.username;
console.log(`[startup] Bot ID=${BOT_ID} username=@${BOT_USERNAME}`);
// Initialize image defaults and load cache
await ensureImageDefaults(DEFAULT_IMAGES);
async function reloadImagesCache() {
  const rows = await getAllImages();
  const next = { ...DEFAULT_IMAGES };
  for (const r of rows) next[r.key] = r.url;
  imagesCache = next;
}
await reloadImagesCache();
bot.on('polling_error', (err) => {
  console.error('[polling_error]', err?.message || err);
});

function buildGrowDeepLink(originChatId) {
  if (!BOT_USERNAME) return undefined;
  try {
    const payload = `grow:${originChatId}`;
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    const param = `g__${encoded}`;
    const url = `https://t.me/${BOT_USERNAME}?start=${param}`;
    return url;
  } catch (e) {
    console.error('[buildGrowDeepLink] failed', e);
    return `https://t.me/${BOT_USERNAME}`;
  }
}

function buildRubDeepLink(originChatId) {
  if (!BOT_USERNAME) return undefined;
  try {
    const payload = `rub:${originChatId}`;
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    const param = `g__${encoded}`;
    return `https://t.me/${BOT_USERNAME}?start=${param}`;
  } catch (e) {
    console.error('[buildRubDeepLink] failed', e);
    return `https://t.me/${BOT_USERNAME}`;
  }
}

async function sendPaidGrowMenu(userId, originChatId) {
  console.log(`[paid menu] send options: user=${userId} originChatId=${originChatId}`);
  const lines =
    `Choose your poison:\n` +
    `• 0.1 XRP — Gain 5–10cm\n` +
    `• 0.2 XRP — Gain 8–15cm\n` +
    `• 0.3 XRP — Gain 12–15cm\n` +
    `Payment instructions will follow; you have 10 minutes after selecting.`;
  const buttons = [
    [{ text: 'Grow 0.1 XRP (+5–10cm)', callback_data: `paygrow:${originChatId}:A` }],
    [{ text: 'Grow 0.2 XRP (+8–15cm)', callback_data: `paygrow:${originChatId}:B` }],
    [{ text: 'Grow 0.3 XRP (+12–15cm)', callback_data: `paygrow:${originChatId}:C` }]
  ];
  await bot.sendMessage(userId, addFooter(lines), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: buttons }
  });
}

async function sendRubBuyMenu(userId, originChatId) {
  const lines =
    `Buy extra /rub usage (each rub is 0.1 XRP).\n` +
    `These bypass the 24h cooldown.\n\n` +
    `Select how many rubs to buy:`;
  const buttons = [
    [{ text: '1 rub (0.1 XRP)', callback_data: `payrub:${originChatId}:1` }],
    [{ text: '5 rubs (0.5 XRP)', callback_data: `payrub:${originChatId}:5` }],
    [{ text: '10 rubs (1.0 XRP)', callback_data: `payrub:${originChatId}:10` }]
  ];
  await bot.sendMessage(userId, addFooter(lines), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: buttons }
  });
}

function isValidXrplAddress(addr) {
  const a = (addr || '').trim();
  return /^r[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
}

function formatXrp(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function formatIouValue(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return '0.000001';
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

async function fetchRipdXrpPrice() {
  if (!HORIZON_API_KEY) throw new Error('HAPI is not set');
  // Some routers don't match "%3A" in path params reliably; keep ":" unescaped.
  const tokenIdPath = encodeURIComponent(RIPPLEDICK_TOKEN_ID).replace(/%3A/gi, ':');
  const base = String(HORIZON_TOKENS_BASE_URL || '').replace(/\/+$/, '');
  const headers = { 'X-Horizon-Api-Key': HORIZON_API_KEY, Accept: 'application/json' };

  const candidates = [];
  if (base.endsWith('/v1')) {
    candidates.push(`${base}/tokens/${tokenIdPath}/market-summary`);
  } else {
    candidates.push(`${base}/v1/tokens/${tokenIdPath}/market-summary`);
  }
  // Fallback: in case base already includes "/v1" but wasn't detected, or API is mounted at root.
  candidates.push(`${base}/tokens/${tokenIdPath}/market-summary`);
  candidates.push(`${base}/v1/tokens/${tokenIdPath}/market-summary`);

  let json = null;
  let lastErr = null;
  for (const url of candidates) {
    try {
      if (typeof fetch === 'function' && /^https?:\/\//i.test(url)) {
        const res = await fetch(url, { method: 'GET', headers });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Horizon error ${res.status}: ${text.slice(0, 200)} (url=${url})`);
        }
        json = await res.json();
      } else {
        json = await new Promise((resolve, reject) => {
          const req = https.request(url, { method: 'GET', headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
              if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`Horizon error ${res.statusCode}: ${String(body).slice(0, 200)} (url=${url})`));
              }
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(new Error(`Horizon returned invalid JSON (url=${url})`));
              }
            });
          });
          req.on('error', reject);
          req.end();
        });
      }
      // Success
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      json = null;
      continue;
    }
  }
  if (!json) throw lastErr || new Error('Horizon request failed');

  const price = json?.data?.market?.xrp?.price;
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid Horizon xrp price');
  return n;
}

async function buyRipdWithDrops(client, wallet, spendDrops) {
  await ensureTrustline(client, wallet, RIPPLEDICK_HEX, RIPPLE_DICK_ISSUER);
  try {
    await placePaymentBuyRipd(client, wallet, spendDrops);
  } catch (e) {
    console.warn('[buy] Payment path buy failed, falling back to OfferCreate', e?.message || e);
    await placeMarketBuyRipd(client, wallet, spendDrops);
  }
}

async function sendRipdPrize(destAddress, ripdAmount) {
  if (!RD_SEED) throw new Error('RD_SEED is not set');
  const client = new XrplClient(XRPL_ENDPOINT);
  await client.connect();
  try {
    const wallet = Wallet.fromSeed(RD_SEED, { algorithm: RD_ALGORITHM });
    await ensureTrustline(client, wallet, RIPPLEDICK_HEX, RIPPLE_DICK_ISSUER);
    const tx = {
      TransactionType: 'Payment',
      Account: wallet.address,
      Destination: destAddress,
      Amount: {
        currency: RIPPLEDICK_HEX,
        issuer: RIPPLE_DICK_ISSUER,
        value: formatIouValue(ripdAmount)
      }
    };
    const result = await client.submitAndWait(tx, { wallet });
    const engine = result?.result?.engine_result;
    if (engine && engine !== 'tesSUCCESS') throw new Error(`XRPL send failed: ${engine}`);
    return result?.result?.hash || 'unknown';
  } finally {
    try { await client.disconnect(); } catch {}
  }
}

async function notifyBotAddedToGroup(chat, actor) {
  try {
    const title = chat.title || '(no title)';
    const type = chat.type || 'unknown';
    const actorLabel = actor ? getUsernameLabel(actor) : 'unknown';
    // Try to build an invite link if possible
    let invite = '';
    if (chat.username) {
      invite = `Invite: https://t.me/${chat.username}\n`;
    } else {
      try {
        const exported = await bot.exportChatInviteLink(chat.id);
        if (exported) {
          invite = `Invite: ${exported}\n`;
        }
      } catch {}
    }
    const text =
      `Phallic Fury bot added to a new ${type}\n` +
      `Title: ${title}\n` +
      invite +
      `Looks like more dicks are about to get fondled.\n`
    await bot.sendMessage(ALERT_DESTINATION, text);
  } catch (e) {
    console.error('Failed to notify new group join', e);
  }
}

// /grow
bot.onText(/^\/grow(@\w+)?\b/i, async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const user = msg.from;
  const userId = user.id;
  await ensureUser(chatId, user);
  const utcNow = getUtcDate();
  try {
    const allowed = await canGrowToday(chatId, userId, utcNow);
    if (!allowed) {
      const nextMidnightUtc = new Date(utcNow);
      nextMidnightUtc.setUTCHours(24, 0, 0, 0);
      const ms = nextMidnightUtc.getTime() - utcNow.getTime();
      const hours = Math.floor(ms / 3600000);
      const minutes = Math.floor((ms % 3600000) / 60000);
      const deepLink = buildGrowDeepLink(chatId);
      const extra = deepLink ? `\n\n<b>Grow again NOW</b>: tap the button to open DM.` : '';
      const opts = deepLink
        ? { reply_markup: { inline_keyboard: [[{ text: 'Buy Viagra (DM)', url: deepLink }]] } }
        : undefined;
      console.log(`[grow cooldown] chat=${chatId} user=${userId} deepLink=${deepLink}`);
      {
        const caption = `You've already fondled your Phallus today.  Wait until tomorrow. \nResets at midnight UTC (${hours}h ${minutes}m).${extra}`;
        const photoOpts = { ...(opts || {}), parse_mode: 'HTML', caption: addFooter(caption) };
        await bot.sendPhoto(chatId, getImageUrl('grow'), photoOpts);
      }
      return;
    }
    // If already over 100cm, 15% chance to snap and lose 10–50% total
    const current = await getUser(chatId, userId);
    if (current && Number(current.length_cm) > 100 && Math.random() < 0.15) {
      const pct = 0.10 + Math.random() * 0.40; // 10%..50%
      const loss = Math.max(1, Math.floor(Number(current.length_cm) * pct));
      const updated = await applyGrowth(chatId, userId, -loss, utcNow);
      const pctText = Math.round(pct * 100);
      {
        const caption = `${getUsernameLabel(user)} snapped their dick! -${loss}cm (${pctText}%). Current length: ${updated.length_cm}cm.`;
        await bot.sendPhoto(chatId, getImageUrl('snap'), { parse_mode: 'HTML', caption: addFooter(caption) });
      }
    } else {
      // 90% chance positive (1..15), 10% chance negative (-1..-5), never 0
      const mustBePositive = current && Number(current.length_cm) === 0;
      const delta = mustBePositive
        ? (1 + Math.floor(Math.random() * 15))
        : ((Math.random() < 0.90)
          ? (1 + Math.floor(Math.random() * 15))
          : (-1 - Math.floor(Math.random() * 5)));
      const updated = await applyGrowth(chatId, userId, delta, utcNow);
      const sign = delta >= 0 ? '+' : '';
      {
        const caption = `${getUsernameLabel(user)} used /grow: ${sign}${delta}cm. Current length: ${updated.length_cm}cm.`;
        const imageUrl = delta < 0 ? getImageUrl('shrunk') : getImageUrl('grow');
        await bot.sendPhoto(chatId, imageUrl, { parse_mode: 'HTML', caption: addFooter(caption) });
      }
    }
  } catch (err) {
    console.error('grow error', err);
    const caption = 'Something went wrong processing /grow.';
    try {
      await bot.sendPhoto(chatId, getImageUrl('grow'), { parse_mode: 'HTML', caption: addFooter(caption) });
    } catch (e) {
      console.error('sendPhoto fallback failed', e);
      await sendWithFooter(chatId, caption);
    }
  }
});

// /wallet <xrplAddress> — set payout address for /rub prizes
bot.onText(/^\/wallet(@\w+)?\s+([^\s]+)\b/i, async (msg, match) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const user = msg.from;
  const addr = (match?.[2] || '').trim();
  await ensureUser(chatId, user);
  if (!isValidXrplAddress(addr)) {
    await sendWithFooter(chatId, `That doesn't look like a valid XRPL address.\nExample: <code>r....</code>`);
    return;
  }
  try {
    await setXrplAddress(chatId, user.id, addr);
    await sendWithFooter(chatId, `Saved your XRPL address:\n<code>${addr}</code>`);
  } catch (e) {
    console.error('wallet set error', e);
    await sendWithFooter(chatId, 'Could not save your address.');
  }
});

// /rub — 50/50 to win RIPPLEDICK prizes (RippleDick group only)
bot.onText(/^\/rub(@\w+)?\b/i, async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const user = msg.from;
  const userId = user.id;

  if (chatId !== RUB_GROUP_ID) {
    await sendWithFooter(chatId, 'This command is only usable in the RippleDick group.');
    return;
  }

  await ensureUser(chatId, user);
  const utcNow = getUtcDate();

  let consumedPaid = false;
  try {
    const state = await getRubState(chatId, userId);
    const xrplAddr = state?.xrpl_address || null;
    const paidFlips = Number(state?.paid_flips || 0);
    const lastFreeAt = state?.last_rub_free_at ? new Date(state.last_rub_free_at) : null;

    if (!xrplAddr) {
      await sendWithFooter(chatId, `Set your XRPL address first so I can reward you for cumming.\nUse: <code>/wallet r....</code>`);
      return;
    }

    const freeReady = !lastFreeAt || (utcNow.getTime() - lastFreeAt.getTime() >= 24 * 60 * 60 * 1000);
    let used = null; // 'free' | 'paid'

    if (freeReady) {
      await recordFreeRub(chatId, userId, utcNow);
      used = 'free';
    } else if (paidFlips > 0) {
      const ok = await consumePaidFlip(chatId, userId);
      if (!ok) {
        await sendWithFooter(chatId, `You're out of rubs. Try again after your free cooldown resets.`);
        return;
      }
      consumedPaid = true;
      used = 'paid';
    } else {
      const next = new Date(lastFreeAt.getTime() + 24 * 60 * 60 * 1000);
      const ms = next.getTime() - utcNow.getTime();
      const hours = Math.max(0, Math.floor(ms / 3600000));
      const minutes = Math.max(0, Math.floor((ms % 3600000) / 60000));
      const deepLink = buildRubDeepLink(chatId);
      const extra = deepLink ? `\n\nBuy extra rubs in DM: tap below.` : '';
      const opts = deepLink
        ? { reply_markup: { inline_keyboard: [[{ text: 'Buy rubs (DM)', url: deepLink }]] } }
        : undefined;
      await sendWithFooter(chatId, `Cooldown active. Free /rub resets in ${hours}h ${minutes}m.${extra}`, opts);
      return;
    }

    const win = Math.random() < 0.5;
    if (!win) {
      const note = used === 'paid' ? '' : '';
      await sendWithFooter(chatId, `${getUsernameLabel(user)} rubs... and goes flacid${note}. Better luck next time.`);
      return;
    }

    const r = Math.random();
    let prizeXrp = 0.01;
    if (r < 0.95) {
      prizeXrp = 0.01 + Math.random() * (0.05 - 0.01);
    } else if (r < 0.99) {
      prizeXrp = 0.1 + Math.random() * (0.5 - 0.1);
    } else if (r < 0.999) {
      prizeXrp = 1.0;
    } else {
      prizeXrp = 5.0;
    }

    const priceXrpPerRipd = await fetchRipdXrpPrice();
    const ripdAmount = prizeXrp / priceXrpPerRipd;
    const txHash = await sendRipdPrize(xrplAddr, ripdAmount);
    const note = used === 'paid' ? '' : '';
    await sendWithFooter(
      chatId,
      `${getUsernameLabel(user)} rubbed well.  Cum went everywhere! Won${note}!\n` +
      `Prize value: ~${formatXrp(prizeXrp)} XRP\n` +
      `RD sent: ~${formatIouValue(ripdAmount)} RIPPLEDICK\n` +
      `Tx: <code>${txHash}</code>`
    );
  } catch (e) {
    console.error('rub error', e);
    if (consumedPaid) {
      try { await addPaidFlips(chatId, userId, 1); } catch {}
    }
    const msgText = String(e?.message || '');
    const xrplErr = e?.data?.error || e?.data?.error_message || '';
    const hint =
      msgText.includes('HAPI is not set') ? '\nMissing server env: <code>HAPI</code>.' :
      msgText.startsWith('Horizon error') ? '\nHorizon API call failed (check token id / base URL / key).' :
      msgText.includes('Invalid Horizon') ? '\nHorizon returned no valid XRP price.' :
      msgText.includes('RD_SEED is not set') ? '\nMissing server env: <code>RD_SEED</code>.' :
      xrplErr === 'actNotFound' || msgText.includes('Account not found') ? '\nYour <code>RD_SEED</code> wallet address is not activated on this XRPL network (or you are pointing at the wrong network). Fund/activate it with a small amount of XRP, and confirm <code>XRPL_ENDPOINT</code> matches the network.' :
      msgText.includes('XRPL send failed') ? '\nXRPL payment failed (wallet balance / trustlines / network).' :
      '';
    await sendWithFooter(chatId, `Could not process /rub right now.${hint}`);
  }
});

// Deep-link start in DM for paid growth
bot.onText(/^\/start(?:\s+(.+))?/i, async (msg, match) => {
  try {
    if (!msg.chat || msg.chat.type !== 'private' || !msg.from) return;
    const user = msg.from;
    const rawParam = (match?.[1] || '').trim();
    console.log(`[start] from user=${user.id} chat=${msg.chat.id} type=${msg.chat.type} text="${msg.text}" param="${rawParam}"`);
    // Decode payload (supports base64url-encoded and legacy plain)
    let originChatId = null;
    let mode = null; // 'grow' | 'rub'
    if (rawParam.startsWith('g__')) {
      try {
        const decoded = Buffer.from(rawParam.slice(3), 'base64url').toString('utf8');
        console.log(`[start] decoded payload="${decoded}"`);
        if (decoded.startsWith('grow:')) {
          originChatId = Number(decoded.slice(5));
          mode = 'grow';
        } else if (decoded.startsWith('rub:')) {
          originChatId = Number(decoded.slice(4));
          mode = 'rub';
        }
      } catch (e) {
        console.warn('[start] failed to decode base64url payload', e);
      }
    } else if (rawParam.startsWith('grow:')) {
      originChatId = Number(rawParam.slice(5));
      mode = 'grow';
    } else if (rawParam.startsWith('rub:')) {
      originChatId = Number(rawParam.slice(4));
      mode = 'rub';
    } else {
      // not our deeplink
      return;
    }
    if (!Number.isFinite(originChatId)) {
      console.warn(`[start] invalid originChatId from param="${rawParam}"`);
      await bot.sendMessage(msg.chat.id, addFooter('Invalid session parameter.'), { parse_mode: 'HTML', disable_web_page_preview: true });
      return;
    }
    console.log(`[start] valid deeplink: mode=${mode} originChatId=${originChatId}`);
    await ensureUser(originChatId, user);
    if (mode === 'rub') {
      await sendRubBuyMenu(msg.chat.id, originChatId);
      return;
    }
    await sendPaidGrowMenu(msg.chat.id, originChatId);
  } catch (e) {
    console.error('/start grow handler error', e);
  }
});

// /average — show this group's average and global average
bot.onText(/^\/average(@\w+)?\b/i, async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const user = msg.from;
  await ensureUser(chatId, user);
  try {
    const groupAvgRow = await getGroupAverageAndRank(chatId);
    const groupAvg = groupAvgRow.avg;
    const groupRank = groupAvgRow.rank;
    const groupTotal = groupAvgRow.total;
    const globalAvg = await getGlobalAverageLength();
    const groupText = Number.isFinite(groupAvg) ? groupAvg.toFixed(1) : '0.0';
    const globalText = Number.isFinite(globalAvg) ? globalAvg.toFixed(1) : '0.0';
    const text =
      `This group's average dick size is ${groupText}cm.\n` +
      (Number.isFinite(groupRank) && groupTotal > 0
        ? `<b>Your group is ranked number ${groupRank}.</b>\n`
        : '') +
      `The overall average dick size for Phallic Fury is ${globalText}cm.\n` +
      `Collectively, you filthy degenerates are swinging baby carrots.`;
    await sendWithGrow(chatId, text);
  } catch (err) {
    console.error('average error', err);
    await sendWithGrow(chatId, 'Could not calculate averages. Even math is disgusted.');
  }
});

// /wank — randomly shrink 10–90% of current length
bot.onText(/^\/wank(@\w+)?\b/i, async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const user = msg.from;
  await ensureUser(chatId, user);
  try {
    const current = await getUser(chatId, user.id);
    const currLen = Number(current?.length_cm ?? 0);
    if (!current || currLen <= 0) {
      {
        const caption = `${getUsernameLabel(user)} tried to have a cheeky wank, but there's nothing left to lose.`;
        await bot.sendPhoto(chatId, getImageUrl('wank'), withGrowButton({ caption: addFooter(caption), parse_mode: 'HTML' }));
      }
      return;
    }
    // 10% chance to swell +10%, otherwise shrink 10–90%
    if (Math.random() < 0.10) {
      const gainPct = 0.10; // 10%
      const gain = Math.max(1, Math.floor(currLen * gainPct));
      const updated = await addLength(chatId, user.id, gain);
      {
        const caption = `${getUsernameLabel(user)} had a wank and it swelled! +${gain}cm (10%). Current length: ${updated.length_cm}cm.`;
        await bot.sendPhoto(chatId, getImageUrl('wank'), withGrowButton({ caption: addFooter(caption), parse_mode: 'HTML' }));
      }
    } else {
      const pct = 0.10 + Math.random() * 0.80; // 10%..90%
      const loss = Math.max(1, Math.floor(currLen * pct));
      const updated = await addLength(chatId, user.id, -loss);
      const pctText = Math.round(pct * 100);
      {
        const caption = `${getUsernameLabel(user)} had a wank and lost ${loss}cm (${pctText}%). Current length: ${updated.length_cm}cm. Wank carefully!`;
        await bot.sendPhoto(chatId, getImageUrl('wank'), withGrowButton({ caption: addFooter(caption), parse_mode: 'HTML' }));
      }
    }
  } catch (err) {
    console.error('wank error', err);
    {
      const caption = 'Could not process /wank.';
      await bot.sendPhoto(chatId, getImageUrl('wank'), withGrowButton({ caption: addFooter(caption), parse_mode: 'HTML' }));
    }
  }
});

// /give @user <number> — admin only, group-scoped
bot.onText(/^\/give(@\w+)?\s+(.+?)\s+(-?\d+)\b/i, async (msg, match) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const from = msg.from;
  await ensureUser(chatId, from);
  const targetRef = (match?.[2] || '').trim();
  const amount = parseInt(match?.[3] || '0', 10);
  try {
    const isAdmin = isAdminUser(from.id);
    let targetUserId = null;
    let targetLabel = null;
    // Prefer reply target if present
    if (msg.reply_to_message && msg.reply_to_message.from) {
      targetUserId = msg.reply_to_message.from.id;
      targetLabel = getUsernameLabel(msg.reply_to_message.from);
      await ensureUser(chatId, msg.reply_to_message.from);
    } else {
      // Try text_mention entity with embedded user
      const entities = msg.entities || [];
      const textMention = entities.find(e => e.type === 'text_mention' && e.user);
      if (textMention && textMention.user) {
        targetUserId = textMention.user.id;
        targetLabel = getUsernameLabel(textMention.user);
        await ensureUser(chatId, textMention.user);
      }
      // Fallback: username string like @name -> look up from DB cache
      if (!targetUserId && targetRef.startsWith('@')) {
        const u = await getUserByUsername(chatId, targetRef);
        if (u) {
          targetUserId = Number(u.user_id);
          targetLabel = getUsernameLabel({ id: u.user_id, username: u.username, first_name: u.first_name });
        }
      }
    }
    if (!targetUserId) {
      await sendWithGrow(chatId, 'Could not identify the target user. Reply to a user or mention someone I know.');
      return;
    }
    if (!isAdmin) {
      // Non-admin: transfer from caller to target. Amount must be positive.
      if (!Number.isFinite(amount) || amount <= 0) {
        await sendWithGrow(chatId, 'Amount must be a positive integer.');
        return;
      }
      if (targetUserId === from.id) {
        await sendWithGrow(chatId, 'You cannot transfer length to yourself.');
        return;
      }
      const me = await getUser(chatId, from.id);
      if (!me || Number(me.length_cm) < amount) {
        await sendWithGrow(chatId, `Insufficient length. You have ${me?.length_cm ?? 0}cm but tried to give ${amount}cm.`);
        return;
      }
      // Ask for confirmation via inline buttons
      const fromLabel = getUsernameLabel(from);
      await sendWithGrow(
        chatId,
        `${fromLabel}, are you sure you want to give ${amount}cm of your dick to ${targetLabel}?`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: 'Confirm transfer', callback_data: `giveconf:${from.id}:${targetUserId}:${amount}` },
              { text: 'Cancel', callback_data: `givecancel:${from.id}` }
            ]]
          }
        }
      );
      return;
    } else {
      // Admin behavior: award or deduct to target; amount can be negative.
      if (!Number.isFinite(amount) || amount === 0) {
        await sendWithGrow(chatId, 'Amount must be a non-zero integer.');
        return;
      }
      const updated = await addLength(chatId, targetUserId, amount);
      const sign = amount >= 0 ? '+' : '';
      await sendWithGrow(chatId, `Awarded ${sign}${amount}cm to ${targetLabel}. New length: ${updated.length_cm}cm.`);
    }
  } catch (err) {
    console.error('give error', err);
    await sendWithGrow(chatId, 'Failed to process /give.');
  }
});

// /top — top 10 by length for this group
bot.onText(/^\/top(@\w+)?\b/i, async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const user = msg.from;
  await ensureUser(chatId, user);
  try {
    const top = await getTopUsers(chatId, 10);
    if (!top || top.length === 0) {
      await sendWithGrow(chatId, 'No members found.');
      return;
    }
    const lines = top.map((u, idx) => {
      const label = getUsernameLabel({ id: u.user_id, username: u.username, first_name: u.first_name });
      return `${idx + 1}. ${label} — ${u.length_cm}cm`;
    });
    await sendWithGrow(chatId, `Top 10 dicks:\n${lines.join('\n')}`);
  } catch (err) {
    console.error('top error', err);
    await sendWithGrow(chatId, 'Could not fetch leaderboard.');
  }
});

// /attack <bet>
bot.onText(/^\/attack(@\w+)?(?:\s+(\d+))?/i, async (msg, match) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const user = msg.from;
  const userId = user.id;
  await ensureUser(chatId, user);
  const bet = parseInt(match?.[2] || '', 10);
  if (!bet || isNaN(bet) || bet <= 0) {
    await sendWithGrow(chatId, 'Usage: /attack &lt;bet_cm&gt; (positive integer)');
    return;
  }
  try {
    const me = await getUser(chatId, userId);
    if (!me) {
      await sendWithGrow(chatId, 'You are not registered yet. Try again.');
      return;
    }
    if (me.length_cm < bet) {
      await sendWithGrow(chatId, `Insufficient length. You have ${me.length_cm}cm but tried to bet ${bet}cm.`);
      return;
    }
    const existing = await getOpenChallengeByAttacker(chatId, userId);
    if (existing) {
      await cancelOpenChallengesByAttacker(chatId, userId);
    }
    const caption =
      `${getUsernameLabel(user)} challenges the group to a Cock fight for ${bet}cm!\nAccept the challenge and swing your dick!`;
    const message = await bot.sendPhoto(chatId, getImageUrl('attack'), {
      parse_mode: 'HTML',
      caption: addFooter(caption),
      reply_markup: {
        inline_keyboard: [[{ text: 'Accept Cock Fight', callback_data: `accept:${bet}` }]]
      }
    });
    await createChallenge(chatId, userId, bet, message.message_id);
  } catch (err) {
    console.error('attack error', err);
    await sendWithGrow(chatId, 'Something went wrong creating the challenge.');
  }
});

// /update — admin dashboard to update images
bot.onText(/^\/update(@\w+)?\b/i, async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const from = msg.from;
  if (!isAdminUser(from.id)) return;
  const keyboard = [
    [{ text: 'Update Grow', callback_data: 'imgupd:grow' }],
    [{ text: 'Update Shrunk', callback_data: 'imgupd:shrunk' }],
    [{ text: 'Update Snap', callback_data: 'imgupd:snap' }],
    [{ text: 'Update Attack', callback_data: 'imgupd:attack' }],
    [{ text: 'Update Attack Resolved', callback_data: 'imgupd:attack_resolved' }],
    [{ text: 'Update Wank', callback_data: 'imgupd:wank' }]
  ];
  const text = 'Admin: Choose which image to update.';
  await bot.sendMessage(chatId, addFooter(text), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard }
  });
});

const pendingImageUpdate = new Map(); // adminUserId -> { key }

// /stats (optionally with @username to view others)
bot.onText(/^\/stats(@\w+)?(?:\s+(.+))?/i, async (msg, match) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const user = msg.from;
  const userId = user.id;
  await ensureUser(chatId, user);
  try {
    const targetRef = (match?.[2] || '').trim();
    let targetUserId = userId;
    let targetRow = null;
    // Prefer text_mention entity if present
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
    const danger = Number(person.length_cm) > 100
      ? `\nWarning: You are in the danger zone. /grow has a 30% chance to snap your dick (-10% to -50%).`
      : '';
    const label = getUsernameLabel({ id: person.user_id, username: person.username, first_name: person.first_name });
    const text = `${label}\nLength: ${person.length_cm}cm\nW/L: ${person.wins}/${person.losses} (${pct}%)${danger}`;
    await sendWithGrow(chatId, text);
  } catch (err) {
    console.error('stats error', err);
    await sendWithGrow(chatId, 'Could not load stats.');
  }
});

// /phallusoftheday
bot.onText(/^\/phallusoftheday(@\w+)?\b/i, async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const user = msg.from;
  await ensureUser(chatId, user);
  const utcNow = getUtcDate();
  try {
    const potd = await selectOrCreatePotd(chatId, utcNow);
    if (!potd) {
      await sendWithGrow(chatId, 'No registered members found to choose from.');
      return;
    }
    const dateStr = utcNow.toISOString().slice(0, 10);
    const label = getUsernameLabel({ id: potd.user_id, username: potd.username, first_name: potd.first_name });
    await sendWithGrow(chatId, `Dick of the day goes to: ${label} — ${potd.length_cm}cm`);
  } catch (err) {
    console.error('potd error', err);
    await sendWithGrow(chatId, 'Could not determine Phallus of the Day.');
  }
});

// Detect when bot is added via member join message
bot.on('message', async (msg) => {
  try {
    if (!msg.chat) return;
    // Handle admin image update reply (only if replying to the specific prompt)
    if (msg.from && isAdminUser(msg.from.id)) {
      const state = pendingImageUpdate.get(msg.from.id);
      if (state && msg.chat.id === state.chatId && msg.reply_to_message && msg.reply_to_message.message_id === state.replyToMessageId) {
        const { key } = state;
        const label = key.replace(/_/g, ' ');
        let newUrl = null;
        if (Array.isArray(msg.photo) && msg.photo.length > 0) {
          const best = msg.photo.reduce((a, b) => ((a.file_size || 0) > (b.file_size || 0) ? a : b));
          // Store the Telegram file_id so Telegram can reuse the uploaded file directly
          newUrl = best.file_id;
        } else if (typeof msg.text === 'string' && /^https?:\/\//i.test(msg.text.trim())) {
          const candidate = msg.text.trim();
          if (/^https?:\/\/api\.telegram\.org\//i.test(candidate)) {
            // Reject Telegram file URLs for upload; delete reply and update the original prompt with guidance and current value
            try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch (e) {}
            let currentRef = getImageUrl(key);
            let displayUrl = currentRef || '';
            if (!/^https?:\/\//i.test(displayUrl) && displayUrl) {
              try {
                const f = await bot.getFile(displayUrl);
                if (f && f.file_path) {
                  displayUrl = `https://api.telegram.org/file/bot${token}/${f.file_path}`;
                }
              } catch {}
            }
            const prompt = `Send a photo or image URL to set the ${label} image.\n` +
              `Current: ${displayUrl || '(none)'}`;
            try {
              await bot.editMessageText(
                addFooter(prompt),
                {
                  chat_id: state.chatId,
                  message_id: state.replyToMessageId,
                  parse_mode: 'HTML',
                  disable_web_page_preview: true
                }
              );
            } catch {
              await bot.sendMessage(msg.chat.id, addFooter(prompt), {
                parse_mode: 'HTML',
                disable_web_page_preview: true
              });
            }
            return;
          }
          newUrl = candidate;
        }
        if (!newUrl) {
          // No valid input: delete reply and re-show the prompt with current value
          try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch (e) {}
          let currentRef = getImageUrl(key);
          let displayUrl = currentRef || '';
          if (!/^https?:\/\//i.test(displayUrl) && displayUrl) {
            try {
              const f = await bot.getFile(displayUrl);
              if (f && f.file_path) {
                displayUrl = `https://api.telegram.org/file/bot${token}/${f.file_path}`;
              }
            } catch {}
          }
          const prompt = `Send a photo or image URL to set the ${label} image.\n` +
            `Current: ${displayUrl || '(none)'}`;
          try {
            await bot.editMessageText(
              addFooter(prompt),
              {
                chat_id: state.chatId,
                message_id: state.replyToMessageId,
                parse_mode: 'HTML',
                disable_web_page_preview: true
              }
            );
          } catch {
            await bot.sendMessage(msg.chat.id, addFooter(prompt), {
              parse_mode: 'HTML',
              disable_web_page_preview: true
            });
          }
          return;
        }
        await setImageUrl(key, newUrl);
        await reloadImagesCache();
        // Try to delete the admin's reply message to keep the chat clean
        try {
          await bot.deleteMessage(msg.chat.id, msg.message_id);
        } catch (e) {
          console.warn('Could not delete admin update reply message:', e?.message || e);
        }
        // Update the original prompt message to indicate success
        try {
          await bot.editMessageText(
            addFooter(`✅ Updated ${label} image.`),
            {
              chat_id: state.chatId,
              message_id: state.replyToMessageId,
              parse_mode: 'HTML',
              disable_web_page_preview: true
            }
          );
        } catch (e) {
          // Fallback: send a separate confirmation message
          await bot.sendMessage(msg.chat.id, addFooter(`✅ Updated ${label} image.`), {
            parse_mode: 'HTML',
            disable_web_page_preview: true
          });
        }
        pendingImageUpdate.delete(msg.from.id);
        return;
      }
    }
    if (msg.chat.type === 'private') {
      console.log(`[message][private] from=${msg.from?.id} chat=${msg.chat.id} text="${msg.text}"`);
    }
    const newMembers = msg.new_chat_members;
    if (!newMembers || newMembers.length === 0) return;
    const botWasAdded = newMembers.some(m => m && m.id === BOT_ID);
    if (!botWasAdded) return;
    await notifyBotAddedToGroup(msg.chat, msg.from);
  } catch (e) {
    console.error('message new_chat_members handler error', e);
  }
});

// Detect when bot is added via chat member status change
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

// Callback query: accept duel
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
  // Handle grow-now from stats
  if (data === 'grow_now') {
    try {
      await ensureUser(chatId, from);
      const utcNow = getUtcDate();
      const allowButton = await canPressGrowButton(chatId, fromId, utcNow);
      if (!allowButton) {
        if (query.id) await bot.answerCallbackQuery(query.id);
        return;
      }
      await recordGrowButtonPress(chatId, fromId, utcNow);
      const allowed = await canGrowToday(chatId, fromId, utcNow);
      if (!allowed) {
        const nextMidnightUtc = new Date(utcNow);
        nextMidnightUtc.setUTCHours(24, 0, 0, 0);
        const ms = nextMidnightUtc.getTime() - utcNow.getTime();
        const hours = Math.floor(ms / 3600000);
        const minutes = Math.floor((ms % 3600000) / 60000);
        const deepLink = buildGrowDeepLink(chatId);
        const extra = deepLink ? `\n\n<b>Grow again NOW</b>: tap the button to open DM.` : '';
        const opts = deepLink
          ? { reply_markup: { inline_keyboard: [[{ text: 'Buy Viagra (DM)', url: deepLink }]] } }
          : undefined;
        console.log(`[grow_now cooldown] chat=${chatId} user=${fromId} deepLink=${deepLink}`);
        await sendWithFooter(chatId, `${getUsernameLabel(from)} — You've already fondled your Phallus today.  Wait until tomorrow. \nResets at midnight UTC (${hours}h ${minutes}m).${extra}`, opts);
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Cooldown active' });
        return;
      }
      const current = await getUser(chatId, fromId);
      if (current && Number(current.length_cm) > 100 && Math.random() < 0.30) {
        const pct = 0.10 + Math.random() * 0.40;
        const loss = Math.max(1, Math.floor(Number(current.length_cm) * pct));
        const updated = await applyGrowth(chatId, fromId, -loss, utcNow);
        const pctText = Math.round(pct * 100);
        {
          const caption = `${getUsernameLabel(from)} snapped their dick! -${loss}cm (${pctText}%). Current length: ${updated.length_cm}cm.`;
          await bot.sendPhoto(chatId, getImageUrl('snap'), { parse_mode: 'HTML', caption: addFooter(caption) });
        }
      } else {
        const mustBePositive = current && Number(current.length_cm) === 0;
        const delta = mustBePositive
          ? (1 + Math.floor(Math.random() * 15))
          : ((Math.random() < 0.90)
            ? (1 + Math.floor(Math.random() * 15))
            : (-1 - Math.floor(Math.random() * 5)));
        const updated = await applyGrowth(chatId, fromId, delta, utcNow);
        const sign = delta >= 0 ? '+' : '';
        {
          const caption = `${getUsernameLabel(from)} used /grow: ${sign}${delta}cm. Current length: ${updated.length_cm}cm.`;
          const imageUrl = delta < 0 ? getImageUrl('shrunk') : getImageUrl('grow');
          await bot.sendPhoto(chatId, imageUrl, { parse_mode: 'HTML', caption: addFooter(caption) });
        }
      }
      if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Grown!' });
    } catch (err) {
      console.error('grow_now error', err);
      if (query.id) {
        try { await bot.answerCallbackQuery(query.id, { text: 'Something went wrong.' }); } catch {}
      }
    }
    return;
  }
  // Handle give confirmation
  if (data.startsWith('giveconf:')) {
    try {
      const parts = data.split(':');
      // giveconf:<requesterId>:<targetId>:<amount>
      const requesterId = Number(parts[1]);
      const targetId = Number(parts[2]);
      const amount = Number(parts[3]);
      if (fromId !== requesterId) {
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Only the requester can confirm this transfer.', show_alert: true });
        return;
      }
      await ensureUser(chatId, from);
      const me = await getUser(chatId, requesterId);
      if (!Number.isFinite(amount) || amount <= 0) {
        await bot.answerCallbackQuery(query.id, { text: 'Invalid amount.' });
        return;
      }
      if (!me || Number(me.length_cm) < amount) {
        const fromLabel = getUsernameLabel(from);
        const failText = `Transfer failed: insufficient length.\n${fromLabel} has ${me?.length_cm ?? 0}cm but tried to give ${amount}cm.`;
        try {
          await bot.editMessageText(addFooter(failText), {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          });
        } catch {
          await sendWithFooter(chatId, failText);
        }
        if (query.id) await bot.answerCallbackQuery(query.id);
        return;
      }
      // Perform transfer
      await addLength(chatId, requesterId, -amount);
      const updatedTarget = await addLength(chatId, targetId, amount);
      const updatedMe = await getUser(chatId, requesterId);
      const fromLabel = getUsernameLabel(from);
      const targetUser = await getUser(chatId, targetId);
      const targetLabel = getUsernameLabel({ id: targetId, username: targetUser?.username, first_name: targetUser?.first_name });
      const text = `Transferred ${amount}cm from ${fromLabel} to ${targetLabel}.\n${fromLabel}: ${updatedMe.length_cm}cm\n${targetLabel}: ${updatedTarget.length_cm}cm`;
      try {
        await bot.editMessageText(addFooter(text), {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      } catch {
        await sendWithFooter(chatId, text);
      }
      if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Transfer complete!' });
    } catch (err) {
      console.error('giveconf error', err);
      if (query.id) {
        try { await bot.answerCallbackQuery(query.id, { text: 'Something went wrong.' }); } catch {}
      }
    }
    return;
  }
  if (data.startsWith('givecancel:')) {
    try {
      const parts = data.split(':');
      const requesterId = Number(parts[1]);
      if (fromId !== requesterId) {
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Only the requester can cancel.', show_alert: true });
        return;
      }
      const fromLabel = getUsernameLabel(from);
      const text = `${fromLabel} cancelled the transfer.`;
      try {
        await bot.editMessageText(addFooter(text), {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      } catch {
        await sendWithFooter(chatId, text);
      }
      if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Cancelled' });
    } catch (err) {
      console.error('givecancel error', err);
      if (query.id) {
        try { await bot.answerCallbackQuery(query.id, { text: 'Something went wrong.' }); } catch {}
      }
    }
    return;
  }
  // Admin image update selection
  if (data.startsWith('imgupd:')) {
    try {
      if (!isAdminUser(fromId)) {
        if (query.id) await bot.answerCallbackQuery(query.id);
        return;
      }
      const key = data.split(':')[1];
      const valid = ['grow', 'shrunk', 'snap', 'attack', 'attack_resolved', 'wank'];
      if (!valid.includes(key)) {
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Unknown image key.' });
        return;
      }
      const label = key.replace(/_/g, ' ');
      const prompt = `Send a photo or image URL to set the ${label} image.\nCurrent: ${getImageUrl(key)}`;
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
  // Handle paid grow option selection in DM
  // Handle paid grow option selection in DM
  if (data.startsWith('paygrow:')) {
    try {
      if (msg.chat.type !== 'private') {
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Open this in DM.', show_alert: true });
        return;
      }
      const [_tag, originChatIdStr, tier] = data.split(':');
      const originChatId = Number(originChatIdStr);
      if (!Number.isFinite(originChatId)) {
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Invalid session.', show_alert: true });
        return;
      }
      const plan = tier === 'A'
        ? { xrp: 0.1, min: 5, max: 10, name: '0.1 XRP (+5–10cm)' }
        : tier === 'B'
          ? { xrp: 0.2, min: 8, max: 15, name: '0.2 XRP (+8–15cm)' }
          : tier === 'C'
            ? { xrp: 0.3, min: 12, max: 15, name: '0.3 XRP (+12–15cm)' }
            : null;
      if (!plan) {
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Unknown option.', show_alert: true });
        return;
      }
      const drops = Number(xrpToDrops(plan.xrp.toString()));
      const destTagStr = String(fromId).slice(0, 9);
      const destTag = Number(destTagStr);
      await ensureUser(originChatId, from);
      // Record payment intent
      const payment = await createPayment(originChatId, fromId, tier, plan.min, plan.max, drops, destTag);
      const instructions =
        `Send <b>${plan.xrp} XRP</b> to:\n` +
        `<code>${XRP_DESTINATION}</code>\n` +
        `Destination Tag: <b>${destTagStr}</b>\n\n` +
        `This will be monitored for 10 minutes. When payment is detected, you'll grow in the originating group.\n` +
        `Option chosen: ${plan.name}`;
      await bot.sendMessage(chatId, addFooter(instructions), { parse_mode: 'HTML', disable_web_page_preview: true });
      if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Waiting for payment...' });
      // Start XRPL watch
      watchForPaymentAndCredit(payment.id, drops, destTag, originChatId, fromId, plan.min, plan.max)
        .catch(err => console.error('payment watcher error', err));
    } catch (err) {
      console.error('paygrow error', err);
      if (query.id) {
        try { await bot.answerCallbackQuery(query.id, { text: 'Something went wrong.' }); } catch {}
      }
    }
    return;
  }
  // Handle /rub flip purchase selection in DM
  if (data.startsWith('payrub:')) {
    try {
      if (msg.chat.type !== 'private') {
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Open this in DM.', show_alert: true });
        return;
      }
      const [_tag, originChatIdStr, flipsStr] = data.split(':');
      const originChatId = Number(originChatIdStr);
      const flips = Math.max(1, Math.min(100, Math.floor(Number(flipsStr) || 0)));
      if (!Number.isFinite(originChatId)) {
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Invalid session.', show_alert: true });
        return;
      }
      // 0.1 XRP per flip
      const xrp = flips * 0.1;
      const drops = Number(xrpToDrops(xrp.toString()));
      // Use a random destination tag to avoid collisions with other payment flows
      const destTag = crypto.randomInt(100000, 2147483647);
      await ensureUser(originChatId, from);
      const payment = await createRubPayment(originChatId, fromId, flips, drops, destTag);
      const instructions =
        `Send <b>${formatXrp(xrp)} XRP</b> to:\n` +
        `<code>${RUB_XRP_DESTINATION}</code>\n` +
        `Destination Tag: <b>${destTag}</b>\n\n` +
        `This will be monitored for 10 minutes. When payment is detected, your paid rubs will be added.\n` +
        `Rubs: <b>${flips}</b>`;
      await bot.sendMessage(chatId, addFooter(instructions), { parse_mode: 'HTML', disable_web_page_preview: true });
      if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Waiting for payment...' });
      watchForRubPaymentAndCredit(payment.id, drops, destTag, originChatId, fromId, flips)
        .catch(err => console.error('rub payment watcher error', err));
    } catch (err) {
      console.error('payrub error', err);
      if (query.id) {
        try { await bot.answerCallbackQuery(query.id, { text: 'Something went wrong.' }); } catch {}
      }
    }
    return;
  }
  // Handle accept challenge
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
        attacker_insufficient: 'Challenger lacks enough cm.',
        acceptor_insufficient: 'Your dick is too small.',
        missing_user: 'One of the fighters is not registered.'
      }[outcome.reason] || 'Unable to accept challenge.';
      if (query.id) await bot.answerCallbackQuery(query.id, { text: reasonText, show_alert: false });
      return;
    }
    const { result } = outcome;
    const winnerMention = result.winnerId === Number(result.attacker.user_id) ? getUsernameLabel(result.attacker) : getUsernameLabel(result.acceptor);
    const loserMention = result.winnerId === Number(result.attacker.user_id) ? getUsernameLabel(result.acceptor) : getUsernameLabel(result.attacker);
    // Fetch updated sizes after transfer
    const updatedWinner = await getUser(chatId, result.winnerId);
    const updatedLoser = await getUser(chatId, result.loserId);
    const loserLoss = result.betCm;
    const baseText = `${winnerMention} took ${loserLoss}cm of ${loserMention}'s dick.\n` +
      `Their new sizes are:\n` +
      `${winnerMention}: ${updatedWinner?.length_cm ?? '??'}cm\n` +
      `${loserMention}: ${updatedLoser?.length_cm ?? '??'}cm`;
    try {
      await bot.editMessageMedia(
        {
          type: 'photo',
            media: getImageUrl('attack_resolved'),
          caption: addFooter(baseText),
          parse_mode: 'HTML'
        },
        { chat_id: chatId, message_id: msg.message_id }
      );
    } catch {
      try {
        await bot.editMessageCaption(addFooter(baseText), { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' });
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

async function ensureTrustline(client, wallet, currencyHex, issuer) {
  const lines = await client.request({
    command: 'account_lines',
    account: wallet.address
  });
  const exists = (lines.result?.lines || []).some(l => l.account === issuer && (l.currency === currencyHex || l.currency === 'RIPPLEDICK'));
  if (exists) return;
  const tx = {
    TransactionType: 'TrustSet',
    Account: wallet.address,
    LimitAmount: {
      currency: currencyHex,
      issuer,
      value: '999999999999'
    }
  };
  console.log('[trustline] creating trustline for currency', currencyHex, 'issuer', issuer);
  const result = await client.submitAndWait(tx, { wallet });
  console.log('[trustline] result', result.type, result.result?.engine_result);
}

async function placeMarketBuyRipd(client, wallet, spendDrops) {
  const spend = Math.max(10, Number(spendDrops) - 50);
  if (spend <= 0) {
    console.warn('[buy] not enough drops to place order', spendDrops);
    return;
  }
  const tx = {
    TransactionType: 'OfferCreate',
    Account: wallet.address,
    // BUY issued token with XRP: we OFFER XRP (TakerGets) and ASK for IOU (TakerPays)
    TakerGets: String(spend), // we sell this XRP (drops)
    TakerPays: {
      currency: RIPPLEDICK_HEX,
      issuer: RIPPLE_DICK_ISSUER,
      value: '999999999999' // large value to simulate market buy
    }
  };
  console.log('[buy] submitting OfferCreate (BUY, allow partial fill & rest) spendDrops=', spend, 'currencyHex=', RIPPLEDICK_HEX);
  const result = await client.submitAndWait(tx, { wallet });
  console.log('[buy] result', result.type, result.result?.engine_result);
}

// Alternative buy using Payment with tfPartialPayment to AMM/pool (path payment style)
async function placePaymentBuyRipd(client, wallet, spendDrops) {
  const spend = Math.max(10, Number(spendDrops) - 50);
  if (spend <= 0) {
    console.warn('[buy-payment] not enough drops to place payment', spendDrops);
    return;
  }
  // Destination MUST be the buyer (self-payment) so acquired IOUs are credited to us
  const destination = wallet.address;
  const tx = {
    TransactionType: 'Payment',
    Account: wallet.address,
    Destination: destination,
    SendMax: String(spend), // in drops
    Amount: {
      currency: RIPPLEDICK_HEX,
      value: '999999999999', // target IOU amount; tfPartialPayment allows partial
      issuer: RIPPLE_DICK_ISSUER
    },
    Flags: 131072 // tfPartialPayment
  };
  console.log('[buy-payment] submitting Payment tfPartialPayment spendDrops=', spend, 'dest=', destination);
  const result = await client.submitAndWait(tx, { wallet });
  console.log('[buy-payment] result', result.type, result.result?.engine_result);
}

async function watchForPaymentAndCredit(paymentId, requiredDrops, destTag, originChatId, userId, minGain, maxGain) {
  const client = new XrplClient(XRPL_ENDPOINT);
  const timeoutMs = 10 * 60 * 1000;
  const endAt = Date.now() + timeoutMs;
  await client.connect();
  try {
    await client.request({ command: 'subscribe', accounts: [RUB_XRP_DESTINATION] });
    const maybeFulfill = async (tx) => {
      try {
        const t = tx?.transaction || tx?.tx || tx;
        const meta = tx?.meta || tx?.metaData || tx?.metaData;
        if (!t || t.TransactionType !== 'Payment') return false;
        if (t.Destination !== RUB_XRP_DESTINATION) return false;
        const tag = t.DestinationTag;
        if (Number(tag) !== Number(destTag)) return false;
        // Determine delivered amount in drops
        let deliveredDrops = null;
        if (typeof t.Amount === 'string') {
          deliveredDrops = Number(t.Amount);
        } else if (meta && (meta.delivered_amount || meta.DeliveredAmount)) {
          const da = meta.delivered_amount || meta.DeliveredAmount;
          if (typeof da === 'string') deliveredDrops = Number(da);
        }
        if (deliveredDrops !== requiredDrops) return false;
        // Attempt to buy RIPPLEDICK using received XRP (use half of the payment)
        if (!RD_SEED) {
          console.warn('[buy] RD_SEED not set; skipping purchase.');
        } else {
          try {
            const wallet = Wallet.fromSeed(RD_SEED, { algorithm: RD_ALGORITHM });
            const buyDrops = Math.floor(Number(deliveredDrops) / 2);
            console.log('[buy] using half of received drops for purchase', { deliveredDrops, buyDrops });
            await buyRipdWithDrops(client, wallet, buyDrops);
          } catch (e) {
            console.error('[buy] failed to buy RIPPLEDICK', e);
          }
        }
        // Credit user
        const gain = Math.max(minGain, Math.min(maxGain, minGain + Math.floor(Math.random() * (maxGain - minGain + 1))));
        await addLength(originChatId, userId, gain);
        await fulfillPayment(paymentId, t.hash || 'unknown', gain);
        // Notify user
        try {
          const label = getUsernameLabel({ id: userId });
          await bot.sendMessage(userId, addFooter(`Payment received. +${gain}cm added in your group. Enjoy your swollen ego.`), { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch {}
        return true;
      } catch (e) {
        console.error('maybeFulfill error', e);
        return false;
      }
    };
    // Immediate ledger scan not implemented; rely on live tx stream for the window
    const onTx = async (event) => {
      const done = await maybeFulfill(event);
      if (done) {
        try { await client.request({ command: 'unsubscribe', accounts: [XRP_DESTINATION] }); } catch {}
        try { await client.disconnect(); } catch {}
      }
    };
    client.on('transaction', onTx);
    // Timeout in 10 minutes
    setTimeout(async () => {
      try {
        await expirePayment(paymentId);
        client.removeListener('transaction', onTx);
        try { await client.request({ command: 'unsubscribe', accounts: [XRP_DESTINATION] }); } catch {}
        try { await client.disconnect(); } catch {}
        try {
          await bot.sendMessage(userId, addFooter('No payment detected within 10 minutes. Try again if you actually have XRP.'), { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch {}
      } catch (e) {
        console.error('payment timeout cleanup error', e);
      }
    }, timeoutMs);
  } catch (e) {
    console.error('XRPL subscribe error', e);
    try { await client.disconnect(); } catch {}
  }
}

async function watchForRubPaymentAndCredit(paymentId, requiredDrops, destTag, originChatId, userId, flips) {
  const client = new XrplClient(XRPL_ENDPOINT);
  const timeoutMs = 10 * 60 * 1000;
  await client.connect();
  try {
    await client.request({ command: 'subscribe', accounts: [RUB_XRP_DESTINATION] });
    const maybeFulfill = async (tx) => {
      try {
        const t = tx?.transaction || tx?.tx || tx;
        const meta = tx?.meta || tx?.metaData || tx?.metaData;
        if (!t || t.TransactionType !== 'Payment') return false;
        if (t.Destination !== RUB_XRP_DESTINATION) return false;
        const tag = t.DestinationTag;
        if (Number(tag) !== Number(destTag)) return false;
        let deliveredDrops = null;
        if (typeof t.Amount === 'string') {
          deliveredDrops = Number(t.Amount);
        } else if (meta && (meta.delivered_amount || meta.DeliveredAmount)) {
          const da = meta.delivered_amount || meta.DeliveredAmount;
          if (typeof da === 'string') deliveredDrops = Number(da);
        }
        if (deliveredDrops !== requiredDrops) return false;
        // Top up RD supply on purchase
        if (!RD_SEED) {
          console.warn('[buy] RD_SEED not set; skipping purchase.');
        } else {
          try {
            const wallet = Wallet.fromSeed(RD_SEED, { algorithm: RD_ALGORITHM });
            const buyDrops = Number(deliveredDrops);
            console.log('[buy] using all received drops for purchase', { deliveredDrops, buyDrops });
            await buyRipdWithDrops(client, wallet, buyDrops);
          } catch (e) {
            console.error('[buy] failed to buy RIPPLEDICK', e);
          }
        }
        await addPaidFlips(originChatId, userId, flips);
        await fulfillRubPayment(paymentId, t.hash || 'unknown');
        try {
          await bot.sendMessage(
            userId,
            addFooter(`Payment received. Added <b>${flips}</b> paid /rub(s).`),
            { parse_mode: 'HTML', disable_web_page_preview: true }
          );
        } catch {}
        return true;
      } catch (e) {
        console.error('rub maybeFulfill error', e);
        return false;
      }
    };
    const onTx = async (event) => {
      const done = await maybeFulfill(event);
      if (done) {
        try { await client.request({ command: 'unsubscribe', accounts: [RUB_XRP_DESTINATION] }); } catch {}
        try { await client.disconnect(); } catch {}
      }
    };
    client.on('transaction', onTx);
    setTimeout(async () => {
      try {
        await expireRubPayment(paymentId);
        client.removeListener('transaction', onTx);
        try { await client.request({ command: 'unsubscribe', accounts: [RUB_XRP_DESTINATION] }); } catch {}
        try { await client.disconnect(); } catch {}
        try {
          await bot.sendMessage(userId, addFooter('No payment detected within 10 minutes. Try again.'), { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch {}
      } catch (e) {
        console.error('rub payment timeout cleanup error', e);
      }
    }, timeoutMs);
  } catch (e) {
    console.error('XRPL subscribe error (rub)', e);
    try { await client.disconnect(); } catch {}
  }
}

// Startup: always polling; also bind an HTTP port for Heroku health
async function start() {
  // Start long polling
  console.log('Bot started with long polling.');
  // Bind a simple HTTP server (Heroku expects PORT even for worker sometimes; safe to always bind)
  const app = express();
  app.get('/', (_req, res) => res.send('Phallic Fury bot is running.'));
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`HTTP server listening on ${port}`);
  });
  process.once('SIGINT', () => bot.stopPolling());
  process.once('SIGTERM', () => bot.stopPolling());
}

start().catch((e) => {
  console.error('Failed to start bot', e);
  process.exit(1);
});


