import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
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
  expirePayment
} from './db.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set.');
  process.exit(1);
}

const ADMIN_USER_ID = 6933188641;
const XRPL_ENDPOINT = process.env.XRPL_ENDPOINT || 'wss://xrplcluster.com';
const XRP_DESTINATION = 'rn9i3edQrUiJ9VBDEx7DbkxrzMJ7q8esRZ';
const XRPL_SECRET = process.env.XRPL_SECRET || process.env.XRPL_SEED || '';
const RIPPLE_DICK_ISSUER = 'rGxkZKJHTDd9MMxXujDs63YHRYbcTJeUgS';
const RIPD_POOL_DEST = process.env.XRPL_RIPD_POOL || process.env.XRPL_RIPPLEDICK_POOL || '';

function asciiCurrencyCode(name) {
  const bytes = Buffer.from(name, 'ascii');
  return bytes.toString('hex').toUpperCase().padEnd(40, '0').slice(0, 40);
}
const RIPPLEDICK_HEX = asciiCurrencyCode('RIPPLEDICK');

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
      const extra = deepLink ? `\n\nOr pay to grow again: tap the button to open DM.` : '';
      const opts = deepLink
        ? { reply_markup: { inline_keyboard: [[{ text: 'Grow Again (DM)', url: deepLink }]] } }
        : undefined;
      console.log(`[grow cooldown] chat=${chatId} user=${userId} deepLink=${deepLink}`);
      await sendWithFooter(
        chatId,
        `You've already fondled your Phallus today.  Wait until tomorrow. \nResets at midnight UTC (${hours}h ${minutes}m).${extra}`,
        opts
      );
      return;
    }
    // If already over 100cm, 15% chance to snap and lose 10–50% total
    const current = await getUser(chatId, userId);
    if (current && Number(current.length_cm) > 100 && Math.random() < 0.15) {
      const pct = 0.10 + Math.random() * 0.40; // 10%..50%
      const loss = Math.max(1, Math.floor(Number(current.length_cm) * pct));
      const updated = await applyGrowth(chatId, userId, -loss, utcNow);
      const pctText = Math.round(pct * 100);
      await sendWithFooter(chatId, `${getUsernameLabel(user)} snapped their dick! -${loss}cm (${pctText}%). Current length: ${updated.length_cm}cm.`);
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
      await sendWithFooter(chatId, `${getUsernameLabel(user)} used /grow: ${sign}${delta}cm. Current length: ${updated.length_cm}cm.`);
    }
  } catch (err) {
    console.error('grow error', err);
    await sendWithFooter(chatId, 'Something went wrong processing /grow.');
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
    if (rawParam.startsWith('g__')) {
      try {
        const decoded = Buffer.from(rawParam.slice(3), 'base64url').toString('utf8');
        console.log(`[start] decoded payload="${decoded}"`);
        if (decoded.startsWith('grow:')) {
          originChatId = Number(decoded.slice(5));
        }
      } catch (e) {
        console.warn('[start] failed to decode base64url payload', e);
      }
    } else if (rawParam.startsWith('grow:')) {
      originChatId = Number(rawParam.slice(5));
    } else {
      // not our deeplink
      return;
    }
    if (!Number.isFinite(originChatId)) {
      console.warn(`[start] invalid originChatId from param="${rawParam}"`);
      await bot.sendMessage(msg.chat.id, addFooter('Invalid growth session parameter.'), { parse_mode: 'HTML', disable_web_page_preview: true });
      return;
    }
    console.log(`[start] valid grow deeplink: originChatId=${originChatId}`);
    await ensureUser(originChatId, user);
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
      await sendWithGrow(chatId, `${getUsernameLabel(user)} tried to have a cheeky wank, but there's nothing left to lose.`);
      return;
    }
    // 10% chance to swell +10%, otherwise shrink 10–90%
    if (Math.random() < 0.10) {
      const gainPct = 0.10; // 10%
      const gain = Math.max(1, Math.floor(currLen * gainPct));
      const updated = await addLength(chatId, user.id, gain);
      await sendWithGrow(chatId, `${getUsernameLabel(user)} had a wank and it swelled! +${gain}cm (10%). Current length: ${updated.length_cm}cm.`);
    } else {
      const pct = 0.10 + Math.random() * 0.80; // 10%..90%
      const loss = Math.max(1, Math.floor(currLen * pct));
      const updated = await addLength(chatId, user.id, -loss);
      const pctText = Math.round(pct * 100);
      await sendWithGrow(chatId, `${getUsernameLabel(user)} had a wank and lost ${loss}cm (${pctText}%). Current length: ${updated.length_cm}cm. Wank carefully!`);
    }
  } catch (err) {
    console.error('wank error', err);
    await sendWithGrow(chatId, 'Could not process /wank.');
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
    const isAdmin = from.id === ADMIN_USER_ID;
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
    const message = await sendWithGrow(
      chatId,
      `${getUsernameLabel(user)} challenges the group to a Cock fight for ${bet}cm!\nAccept the challenge and swing your dick!`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: 'Accept Cock Fight', callback_data: `accept:${bet}` }]]
        }
      }
    );
    await createChallenge(chatId, userId, bet, message.message_id);
  } catch (err) {
    console.error('attack error', err);
    await sendWithGrow(chatId, 'Something went wrong creating the challenge.');
  }
});

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
        const extra = deepLink ? `\n\nOr pay to grow again: tap the button to open DM.` : '';
        const opts = deepLink
          ? { reply_markup: { inline_keyboard: [[{ text: 'Grow Again (DM)', url: deepLink }]] } }
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
        await sendWithFooter(chatId, `${getUsernameLabel(from)} snapped their dick! -${loss}cm (${pctText}%). Current length: ${updated.length_cm}cm.`);
      } else {
        const mustBePositive = current && Number(current.length_cm) === 0;
        const delta = mustBePositive
          ? (1 + Math.floor(Math.random() * 15))
          : ((Math.random() < 0.90)
            ? (1 + Math.floor(Math.random() * 15))
            : (-1 - Math.floor(Math.random() * 5)));
        const updated = await applyGrowth(chatId, fromId, delta, utcNow);
        const sign = delta >= 0 ? '+' : '';
        await sendWithFooter(chatId, `${getUsernameLabel(from)} used /grow: ${sign}${delta}cm. Current length: ${updated.length_cm}cm.`);
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
      await bot.editMessageText(addFooter(baseText), { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', disable_web_page_preview: true });
    } catch {
      await sendWithFooter(chatId, baseText);
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
    await client.request({ command: 'subscribe', accounts: [XRP_DESTINATION] });
    const maybeFulfill = async (tx) => {
      try {
        const t = tx?.transaction || tx?.tx || tx;
        const meta = tx?.meta || tx?.metaData || tx?.metaData;
        if (!t || t.TransactionType !== 'Payment') return false;
        if (t.Destination !== XRP_DESTINATION) return false;
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
        if (!XRPL_SECRET) {
          console.warn('[buy] XRPL_SECRET not set; skipping purchase.');
        } else {
          try {
            const wallet = Wallet.fromSeed(XRPL_SECRET);
            if (wallet.address !== XRP_DESTINATION) {
              console.warn('[buy] Wallet address does not match destination. Using wallet:', wallet.address);
            }
            await ensureTrustline(client, wallet, RIPPLEDICK_HEX, RIPPLE_DICK_ISSUER);
            // Prefer Payment tfPartialPayment to allow partial fills via AMM/path
            try {
              const buyDrops = Math.floor(Number(deliveredDrops) / 2);
              console.log('[buy] using half of received drops for purchase', { deliveredDrops, buyDrops });
              await placePaymentBuyRipd(client, wallet, buyDrops);
            } catch (e) {
              console.warn('[buy] Payment path buy failed, falling back to OfferCreate', e?.message || e);
              const buyDrops = Math.floor(Number(deliveredDrops) / 2);
              await placeMarketBuyRipd(client, wallet, buyDrops);
            }
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


