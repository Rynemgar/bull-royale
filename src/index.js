import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
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
  resolveChallengeTransaction
} from './db.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set.');
  process.exit(1);
}

const ADMIN_USER_ID = 6933188641;

function getUtcDate() {
  return new Date(new Date().toISOString());
}

function getUsernameLabel(from) {
  if (from.username) return `@${from.username}`;
  if (from.first_name || from.last_name) return `${from.first_name || ''} ${from.last_name || ''}`.trim();
  return `${from.id}`;
}

function withGrowButton(options) {
  const existing = options && options.reply_markup && Array.isArray(options.reply_markup.inline_keyboard)
    ? options.reply_markup.inline_keyboard.slice()
    : [];
  const inline_keyboard = existing.concat([[{ text: 'Grow now', callback_data: 'grow_now' }]]);
  return {
    ...(options || {}),
    reply_markup: {
      ...(options && options.reply_markup ? options.reply_markup : {}),
      inline_keyboard
    }
  };
}

function sendWithGrow(chatId, text, options) {
  return bot.sendMessage(chatId, text, withGrowButton(options));
}
await initSchema();
const bot = new TelegramBot(token, { polling: true });

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
      await bot.sendMessage(chatId, `You've already fondled your Phallus today.  Wait until tomorrow. \nResets at midnight UTC (${hours}h ${minutes}m).`);
      return;
    }
    // If already over 100cm, 15% chance to snap and lose 10–50% total
    const current = await getUser(chatId, userId);
    if (current && Number(current.length_cm) > 100 && Math.random() < 0.15) {
      const pct = 0.10 + Math.random() * 0.40; // 10%..50%
      const loss = Math.max(1, Math.floor(Number(current.length_cm) * pct));
      const updated = await applyGrowth(chatId, userId, -loss, utcNow);
      const pctText = Math.round(pct * 100);
      await bot.sendMessage(chatId, `${getUsernameLabel(user)} snapped their dick! -${loss}cm (${pctText}%). Current length: ${updated.length_cm}cm.`);
    } else {
      // 75% chance positive (1..15), 25% chance negative (-1..-5), never 0
      const mustBePositive = current && Number(current.length_cm) === 0;
      const delta = mustBePositive
        ? (1 + Math.floor(Math.random() * 15))
        : ((Math.random() < 0.75)
          ? (1 + Math.floor(Math.random() * 15))
          : (-1 - Math.floor(Math.random() * 5)));
      const updated = await applyGrowth(chatId, userId, delta, utcNow);
      const sign = delta >= 0 ? '+' : '';
      await bot.sendMessage(chatId, `${getUsernameLabel(user)} used /grow: ${sign}${delta}cm. Current length: ${updated.length_cm}cm.`);
    }
  } catch (err) {
    console.error('grow error', err);
    await bot.sendMessage(chatId, 'Something went wrong processing /grow.');
  }
});

// /give @user <number> — admin only, group-scoped
bot.onText(/^\/give(@\w+)?\s+(.+?)\s+(-?\d+)\b/i, async (msg, match) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const from = msg.from;
  const targetRef = (match?.[2] || '').trim();
  const amount = parseInt(match?.[3] || '0', 10);
  if (!Number.isFinite(amount) || amount === 0) {
    await sendWithGrow(chatId, 'Amount must be a non-zero integer.');
    return;
  }
  try {
    if (!ADMIN_USER_ID) {
      await sendWithGrow(chatId, 'ADMIN_USER_ID is not configured.');
      return;
    }
    if (from.id !== ADMIN_USER_ID) {
      await sendWithGrow(chatId, 'You are not allowed to use /give.');
      return;
    }
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
    const updated = await addLength(chatId, targetUserId, amount);
    const sign = amount >= 0 ? '+' : '';
    await sendWithGrow(chatId, `Awarded ${sign}${amount}cm to ${targetLabel}. New length: ${updated.length_cm}cm.`);
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
    await sendWithGrow(chatId, 'Usage: /attack <bet_cm> (positive integer)');
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
      `${getUsernameLabel(user)} challenges the group to a "Sword" fight for ${bet}cm!\nTap "En Guard" to accept.`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: 'En Guard', callback_data: `accept:${bet}` }]]
        }
      }
    );
    await createChallenge(chatId, userId, bet, message.message_id);
  } catch (err) {
    console.error('attack error', err);
    await sendWithGrow(chatId, 'Something went wrong creating the challenge.');
  }
});

// /stats
bot.onText(/^\/stats(@\w+)?\b/i, async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = msg.chat.id;
  const user = msg.from;
  const userId = user.id;
  await ensureUser(chatId, user);
  try {
    const me = await getUser(chatId, userId);
    if (!me) {
      await sendWithGrow(chatId, 'No stats yet. Use /grow to begin.');
      return;
    }
    const total = Number(me.wins) + Number(me.losses);
    const pct = total > 0 ? Math.round((Number(me.wins) / total) * 100) : 0;
    const danger = Number(me.length_cm) > 100
      ? `\nWarning: You are in the danger zone. /grow has a 15% chance to snap your dick (-10% to -50%).`
      : '';
    const text = `${getUsernameLabel(user)}\nLength: ${me.length_cm}cm\nW/L: ${me.wins}/${me.losses} (${pct}%)${danger}`;
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
        await bot.sendMessage(chatId, `${getUsernameLabel(from)} — You've already fondled your Phallus today.  Wait until tomorrow. \nResets at midnight UTC (${hours}h ${minutes}m).`);
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Cooldown active' });
        return;
      }
      const current = await getUser(chatId, fromId);
      if (current && Number(current.length_cm) > 100 && Math.random() < 0.15) {
        const pct = 0.10 + Math.random() * 0.40;
        const loss = Math.max(1, Math.floor(Number(current.length_cm) * pct));
        const updated = await applyGrowth(chatId, fromId, -loss, utcNow);
        const pctText = Math.round(pct * 100);
        await bot.sendMessage(chatId, `${getUsernameLabel(from)} snapped their dick! -${loss}cm (${pctText}%). Current length: ${updated.length_cm}cm.`);
      } else {
        const mustBePositive = current && Number(current.length_cm) === 0;
        const delta = mustBePositive
          ? (1 + Math.floor(Math.random() * 15))
          : ((Math.random() < 0.75)
            ? (1 + Math.floor(Math.random() * 15))
            : (-1 - Math.floor(Math.random() * 5)));
        const updated = await applyGrowth(chatId, fromId, delta, utcNow);
        const sign = delta >= 0 ? '+' : '';
        await bot.sendMessage(chatId, `${getUsernameLabel(from)} used /grow: ${sign}${delta}cm. Current length: ${updated.length_cm}cm.`);
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
        acceptor_insufficient: 'Acceptor lacks enough cm.',
        missing_user: 'One of the fighters is not registered.'
      }[outcome.reason] || 'Unable to accept challenge.';
      if (query.id) await bot.answerCallbackQuery(query.id, { text: reasonText, show_alert: false });
      return;
    }
    const { result } = outcome;
    const winnerMention = result.winnerId === Number(result.attacker.user_id) ? getUsernameLabel(result.attacker) : getUsernameLabel(result.acceptor);
    const loserMention = result.winnerId === Number(result.attacker.user_id) ? getUsernameLabel(result.acceptor) : getUsernameLabel(result.attacker);
    const baseText = `They swung their dicks for ${result.betCm}cm!\nWinner: ${winnerMention}\nLoser: ${loserMention}`;
    try {
      await bot.editMessageText(baseText, { chat_id: chatId, message_id: msg.message_id });
    } catch {
      await bot.sendMessage(chatId, baseText);
    }
    if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Duel complete!' });
  } catch (err) {
    console.error('callback error', err);
    if (query.id) {
      try { await bot.answerCallbackQuery(query.id, { text: 'Something went wrong.' }); } catch {}
    }
  }
});

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


