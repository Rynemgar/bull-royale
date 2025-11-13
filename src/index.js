import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import {
  initSchema,
  ensureUser,
  getUser,
  canGrowToday,
  applyGrowth,
  createChallenge,
  getOpenChallengeByAttacker,
  getOpenChallengeByMessageId,
  resolveChallengeTransaction
} from './db.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set.');
  process.exit(1);
}

function getUtcDate() {
  return new Date(new Date().toISOString());
}

function getUsernameLabel(from) {
  if (from.username) return `@${from.username}`;
  if (from.first_name || from.last_name) return `${from.first_name || ''} ${from.last_name || ''}`.trim();
  return `${from.id}`;
}

await initSchema();

const useWebhook = !!process.env.WEBHOOK_DOMAIN && !!process.env.PORT;
const bot = new TelegramBot(token, { polling: !useWebhook });

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
    const delta = Math.floor(Math.random() * 16) - 5;
    const updated = await applyGrowth(chatId, userId, delta, utcNow);
    const sign = delta >= 0 ? '+' : '';
    await bot.sendMessage(chatId, `${getUsernameLabel(user)} used /grow: ${sign}${delta}cm. Current length: ${updated.length_cm}cm.`);
  } catch (err) {
    console.error('grow error', err);
    await bot.sendMessage(chatId, 'Something went wrong processing /grow.');
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
    await bot.sendMessage(chatId, 'Usage: /attack <bet_cm> (positive integer)');
    return;
  }
  try {
    const me = await getUser(chatId, userId);
    if (!me) {
      await bot.sendMessage(chatId, 'You are not registered yet. Try again.');
      return;
    }
    if (me.length_cm < bet) {
      await bot.sendMessage(chatId, `Insufficient length. You have ${me.length_cm}cm but tried to bet ${bet}cm.`);
      return;
    }
    const existing = await getOpenChallengeByAttacker(chatId, userId);
    if (existing) {
      await bot.sendMessage(chatId, 'You already have an open challenge.');
      return;
    }
    const message = await bot.sendMessage(
      chatId,
      `${getUsernameLabel(user)} challenges anyone to a Sword Fight for ${bet}cm!\nTap "En Guard" to accept.`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: 'En Guard', callback_data: `accept:${bet}` }]]
        }
      }
    );
    await createChallenge(chatId, userId, bet, message.message_id);
  } catch (err) {
    console.error('attack error', err);
    await bot.sendMessage(chatId, 'Something went wrong creating the challenge.');
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
      await bot.sendMessage(chatId, 'No stats yet. Use /grow to begin.');
      return;
    }
    const total = Number(me.wins) + Number(me.losses);
    const pct = total > 0 ? Math.round((Number(me.wins) / total) * 100) : 0;
    await bot.sendMessage(chatId, `${getUsernameLabel(user)}\nLength: ${me.length_cm}cm\nW/L: ${me.wins}/${me.losses} (${pct}%)`);
  } catch (err) {
    console.error('stats error', err);
    await bot.sendMessage(chatId, 'Could not load stats.');
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
  if (!data.startsWith('accept:')) {
    if (query.id) bot.answerCallbackQuery(query.id);
    return;
  }
  try {
    const challenge = await getOpenChallengeByMessageId(chatId, msg.message_id);
    if (!challenge) {
      if (query.id) await bot.answerCallbackQuery(query.id, { text: 'No open challenge found.' });
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
    const baseText = `Sword Fight resolved for ${result.betCm}cm!\nWinner: ${winnerMention}\nLoser: ${loserMention}`;
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

// Startup: webhook for Heroku or polling locally
async function start() {
  if (useWebhook) {
    const app = express();
    app.use(express.json());
    const secret = crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
    const path = `/bot/${secret}`;
    app.post(path, (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });
    const url = `${process.env.WEBHOOK_DOMAIN}${path}`;
    await bot.setWebHook(url);
    app.get('/', (_req, res) => res.send('Phallic Fury bot is running.'));
    app.listen(Number(process.env.PORT), () => {
      console.log(`Webhook server listening on ${process.env.PORT}`);
    });
  } else {
    console.log('Bot started with long polling.');
  }
  process.once('SIGINT', () => bot.stopPolling());
  process.once('SIGTERM', () => bot.stopPolling());
}

start().catch((e) => {
  console.error('Failed to start bot', e);
  process.exit(1);
});


