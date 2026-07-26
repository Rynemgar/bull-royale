import {
  ensureGroupRewards,
  getGroupRewards,
  setGroupWallet,
  updateGroupRewards,
  maybeStartRewardPeriod,
  getRewardBlacklistPage,
  removeRewardBlacklist,
  addRewardBlacklist,
  setUserWallet,
  getUserWallet,
  getEligibleRewardWinners,
  recordRewardPayout,
  listGroupsDueForRewards
} from './db.js';
import {
  generateGroupWallet,
  encryptSecret,
  decryptSecret,
  keypairFromSecretBytes,
  validateSolanaAddress,
  validateWalletAddress,
  getSolBalance,
  getTokenBalance,
  getTokenMetadataName,
  sendSplReward,
  cascadingShares
} from './solana.js';

export const pendingSetbull = new Map(); // userId -> { chatId, field, replyToMessageId }
export const pendingSetwallet = new Map(); // userId -> { chatId }

const BLACKLIST_PAGE_SIZE = 5;

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function buildSetbullMenu(chatId) {
  const row = await ensureGroupRewards(chatId);
  const lines = ['<b>Bull Royale Rewards</b>', ''];
  const keyboard = [];

  if (!row.wallet_pubkey) {
    keyboard.push([{ text: 'Generate Wallet', callback_data: 'sb:genwallet' }]);
    lines.push('No treasury wallet yet.');
  } else {
    lines.push(`<b>Wallet</b>: <code>${escHtml(row.wallet_pubkey)}</code>`);
    try {
      const sol = await getSolBalance(row.wallet_pubkey);
      lines.push(`SOL: ${sol.toFixed(4)}`);
    } catch (e) {
      lines.push(`SOL: (unavailable)`);
      console.error('SOL balance error', e?.message || e);
    }
    if (row.reward_mint) {
      try {
        const name = await getTokenMetadataName(row.reward_mint);
        const bal = await getTokenBalance(row.wallet_pubkey, row.reward_mint);
        lines.push(`${escHtml(name)}: ${bal.ui}`);
      } catch (e) {
        lines.push(`Token: (unavailable)`);
        console.error('token balance error', e?.message || e);
      }
    }
  }

  lines.push('');
  lines.push(`Reward token: ${row.reward_mint ? `<code>${escHtml(row.reward_mint)}</code>` : '(not set)'}`);
  lines.push(`Reward amount: ${row.reward_amount != null ? row.reward_amount : '(not set)'}`);
  lines.push(`Winners: ${row.winner_count}`);
  lines.push(`Timer: ${row.period_hours}h`);
  if (row.period_started_at) {
    const end = new Date(new Date(row.period_started_at).getTime() + Number(row.period_hours) * 3600000);
    lines.push(`Period ends: ${end.toISOString()}`);
  } else {
    lines.push('Period: not started (set wallet + token + amount)');
  }

  keyboard.push([{ text: 'Set reward token', callback_data: 'sb:settoken' }]);
  keyboard.push([{ text: 'Set reward amount', callback_data: 'sb:setamount' }]);
  keyboard.push([{ text: 'Set number of winners', callback_data: 'sb:setwinners' }]);
  keyboard.push([{ text: 'Set timer', callback_data: 'sb:settimer' }]);
  keyboard.push([{ text: 'Blacklist', callback_data: 'sb:bl:0' }]);

  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: keyboard }
  };
}

export async function buildBlacklistKeyboard(chatId, page = 0) {
  const { total, rows, pageSize } = await getRewardBlacklistPage(chatId, page, BLACKLIST_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const data = safePage === page
    ? { total, rows, pageSize }
    : await getRewardBlacklistPage(chatId, safePage, BLACKLIST_PAGE_SIZE);

  const lines = [
    `<b>Reward blacklist</b> (page ${safePage + 1}/${Math.max(1, Math.ceil(data.total / pageSize))})`,
    data.total === 0 ? 'No one is blacklisted.' : ''
  ].filter(Boolean);

  const keyboard = [];
  for (const r of data.rows) {
    const label = r.username ? `@${r.username}` : (r.first_name || String(r.user_id));
    keyboard.push([{
      text: `Remove ${label}`,
      callback_data: `sb:blrm:${r.user_id}:${safePage}`
    }]);
  }
  const nav = [];
  if (safePage > 0) nav.push({ text: '‹ Prev', callback_data: `sb:bl:${safePage - 1}` });
  nav.push({ text: 'Back', callback_data: 'sb:menu' });
  if ((safePage + 1) * pageSize < data.total) {
    nav.push({ text: 'Next ›', callback_data: `sb:bl:${safePage + 1}` });
  }
  keyboard.push(nav);

  return { text: lines.join('\n'), reply_markup: { inline_keyboard: keyboard }, page: safePage };
}

async function promptSetbullField(bot, chatId, userId, field, prompt) {
  const sent = await bot.sendMessage(chatId, prompt, {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, selective: true }
  });
  pendingSetbull.set(userId, {
    chatId,
    field,
    replyToMessageId: sent.message_id
  });
}

export async function handleSetbullCallback(bot, query, addFooter) {
  const data = query.data || '';
  const msg = query.message;
  const chatId = msg.chat.id;
  const fromId = query.from.id;

  if (data === 'sb:menu' || data === 'sb:genwallet') {
    if (data === 'sb:genwallet') {
      const existing = await getGroupRewards(chatId);
      if (existing?.wallet_pubkey) {
        if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Wallet already generated.', show_alert: true });
      } else {
        try {
          const { publicKey, secretKeyBytes } = generateGroupWallet();
          const enc = encryptSecret(secretKeyBytes);
          await setGroupWallet(chatId, publicKey, enc);
          await maybeStartRewardPeriod(chatId);
          if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Wallet generated.' });
        } catch (e) {
          console.error('genwallet error', e);
          if (query.id) {
            await bot.answerCallbackQuery(query.id, {
              text: e?.message?.includes('WALLET_ENCRYPTION_KEY')
                ? 'WALLET_ENCRYPTION_KEY not configured.'
                : 'Failed to generate wallet.',
              show_alert: true
            });
          }
          return true;
        }
      }
    } else if (query.id) {
      await bot.answerCallbackQuery(query.id);
    }
    const menu = await buildSetbullMenu(chatId);
    try {
      await bot.editMessageText(addFooter(menu.text), {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: menu.reply_markup
      });
    } catch (e) {
      console.error('edit setbull menu', e?.message || e);
    }
    return true;
  }

  if (data === 'sb:settoken') {
    if (query.id) await bot.answerCallbackQuery(query.id);
    await promptSetbullField(
      bot,
      chatId,
      fromId,
      'token',
      'Reply with the Solana token mint address (CA) for rewards.'
    );
    return true;
  }
  if (data === 'sb:setamount') {
    if (query.id) await bot.answerCallbackQuery(query.id);
    await promptSetbullField(
      bot,
      chatId,
      fromId,
      'amount',
      'Reply with the total reward token amount to split each period (e.g. 1000).'
    );
    return true;
  }
  if (data === 'sb:setwinners') {
    if (query.id) await bot.answerCallbackQuery(query.id);
    await promptSetbullField(
      bot,
      chatId,
      fromId,
      'winners',
      'Reply with the number of winners (integer ≥ 1).'
    );
    return true;
  }
  if (data === 'sb:settimer') {
    if (query.id) await bot.answerCallbackQuery(query.id);
    await promptSetbullField(
      bot,
      chatId,
      fromId,
      'timer',
      'Reply with the reward period in hours (default 72).'
    );
    return true;
  }

  if (data.startsWith('sb:bl:')) {
    if (query.id) await bot.answerCallbackQuery(query.id);
    const page = Number(data.slice('sb:bl:'.length)) || 0;
    const bl = await buildBlacklistKeyboard(chatId, page);
    try {
      await bot.editMessageText(addFooter(bl.text), {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: bl.reply_markup
      });
    } catch (e) {
      console.error('edit blacklist', e?.message || e);
    }
    return true;
  }

  if (data.startsWith('sb:blrm:')) {
    const parts = data.split(':');
    const userId = Number(parts[2]);
    const page = Number(parts[3]) || 0;
    await removeRewardBlacklist(chatId, userId);
    if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Removed from blacklist.' });
    const bl = await buildBlacklistKeyboard(chatId, page);
    try {
      await bot.editMessageText(addFooter(bl.text), {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: bl.reply_markup
      });
    } catch (e) {
      console.error('edit blacklist after remove', e?.message || e);
    }
    return true;
  }

  return false;
}

export async function handleSetbullPendingInput(bot, msg, addFooter) {
  if (!msg.from || !msg.text) return false;
  const state = pendingSetbull.get(msg.from.id);
  if (!state) return false;
  if (msg.chat.id !== state.chatId) return false;
  if (!msg.reply_to_message || msg.reply_to_message.message_id !== state.replyToMessageId) return false;

  const text = msg.text.trim();
  const chatId = state.chatId;
  try {
    if (state.field === 'token') {
      if (!validateSolanaAddress(text)) {
        await bot.sendMessage(chatId, addFooter('Invalid Solana mint address. Try again via /setbull.'), {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      } else {
        await updateGroupRewards(chatId, { reward_mint: text });
        await maybeStartRewardPeriod(chatId);
        await bot.sendMessage(chatId, addFooter(`Reward token set to <code>${escHtml(text)}</code>.`), {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      }
    } else if (state.field === 'amount') {
      const amount = Number(text);
      if (!Number.isFinite(amount) || amount <= 0) {
        await bot.sendMessage(chatId, addFooter('Amount must be a positive number.'), {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      } else {
        await updateGroupRewards(chatId, { reward_amount: amount });
        await maybeStartRewardPeriod(chatId);
        await bot.sendMessage(chatId, addFooter(`Reward amount set to ${amount}.`), {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      }
    } else if (state.field === 'winners') {
      const n = parseInt(text, 10);
      if (!Number.isFinite(n) || n < 1 || n > 50) {
        await bot.sendMessage(chatId, addFooter('Winners must be an integer from 1 to 50.'), {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      } else {
        await updateGroupRewards(chatId, { winner_count: n });
        await maybeStartRewardPeriod(chatId);
        await bot.sendMessage(chatId, addFooter(`Number of winners set to ${n}.`), {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      }
    } else if (state.field === 'timer') {
      const hours = Number(text);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) {
        await bot.sendMessage(chatId, addFooter('Timer must be a positive number of hours.'), {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      } else {
        await updateGroupRewards(chatId, {
          period_hours: hours,
          period_started_at: new Date()
        });
        await bot.sendMessage(chatId, addFooter(`Timer set to ${hours}h (period restarted).`), {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      }
    }
  } catch (e) {
    console.error('setbull pending input error', e);
    await bot.sendMessage(chatId, addFooter('Failed to save setting.'), {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  }
  pendingSetbull.delete(msg.from.id);
  return true;
}

export async function handleSetwalletPending(bot, msg, addFooter, getUsernameLabel) {
  if (!msg.from || msg.chat?.type !== 'private' || !msg.text) return false;
  const state = pendingSetwallet.get(msg.from.id);
  if (!state) return false;
  if (msg.text.startsWith('/')) return false;

  const address = msg.text.trim();
  if (!validateWalletAddress(address)) {
    await bot.sendMessage(msg.chat.id, addFooter('That is not a valid Solana wallet address. Send a wallet address, or /cancel.'), {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    return true;
  }
  await setUserWallet(state.chatId, msg.from.id, address);
  pendingSetwallet.delete(msg.from.id);
  await bot.sendMessage(
    msg.chat.id,
    addFooter(`Saved wallet <code>${escHtml(address)}</code> for rewards in that group.`),
    { parse_mode: 'HTML', disable_web_page_preview: true }
  );
  try {
    await bot.sendMessage(
      state.chatId,
      addFooter(`${getUsernameLabel(msg.from)} registered a Solana wallet for rewards.`),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
  } catch {}
  return true;
}

export async function startSetwalletFlow(bot, msg, addFooter) {
  const chat = msg.chat;
  const user = msg.from;
  if (!chat || !user) return;

  if (chat.type === 'private') {
    await bot.sendMessage(
      chat.id,
      addFooter('Run /setwallet inside the Bull Royale group you want to register for, then I will DM you for your address.'),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
    return;
  }

  const chatId = chat.id;
  pendingSetwallet.set(user.id, { chatId });
  await bot.sendMessage(chatId, addFooter(`${getUsernameLabelSafe(user)}: check your DMs to register your Solana wallet.`), {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });

  try {
    await bot.sendMessage(
      user.id,
      addFooter(
        `Send me your Solana wallet address to receive Bull Royale rewards for <b>${escHtml(chat.title || 'this group')}</b>.\n` +
        `Reply in this chat with the address only.`
      ),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
  } catch {
    pendingSetwallet.delete(user.id);
    await bot.sendMessage(
      chatId,
      addFooter('I could not DM you. Open a private chat with me, press Start, then run /setwallet in the group again.'),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
  }
}

function getUsernameLabelSafe(from) {
  if (from.username) return `@${from.username}`;
  if (from.first_name || from.last_name) return `${from.first_name || ''} ${from.last_name || ''}`.trim();
  return `${from.id}`;
}

export async function handleNobull(bot, msg, addFooter, isAdminUser, getUsernameLabel) {
  if (!msg.chat || !msg.from) return;
  if (!isAdminUser(msg.from.id)) return;
  if (!msg.reply_to_message?.from) {
    await bot.sendMessage(msg.chat.id, addFooter('Reply to a user\'s message with /nobull to blacklist them from rewards.'), {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    return;
  }
  const target = msg.reply_to_message.from;
  if (target.is_bot) {
    await bot.sendMessage(msg.chat.id, addFooter('Cannot blacklist a bot.'), {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    return;
  }
  await addRewardBlacklist(msg.chat.id, target.id, msg.from.id);
  await bot.sendMessage(
    msg.chat.id,
    addFooter(`${getUsernameLabel(target)} has been blacklisted from rewards.`),
    { parse_mode: 'HTML', disable_web_page_preview: true }
  );
}

async function processGroupPayout(bot, group, addFooter, getUsernameLabel) {
  const chatId = group.chat_id;
  const periodEnd = new Date(new Date(group.period_started_at).getTime() + Number(group.period_hours) * 3600000);
  const now = new Date();
  if (now < periodEnd) return { paid: false };

  const winners = await getEligibleRewardWinners(chatId, group.winner_count);
  if (!winners.length) {
    await updateGroupRewards(chatId, {
      last_payout_at: now,
      period_started_at: now
    });
    try {
      await bot.sendMessage(
        chatId,
        addFooter('Reward period ended, but no eligible winners (need horns + /setwallet, not blacklisted). Period restarted.'),
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
    } catch {}
    return { paid: false };
  }

  const shares = cascadingShares(group.reward_amount, winners.length);
  let secret;
  try {
    secret = decryptSecret(group.wallet_privkey_enc);
  } catch (e) {
    console.error('decrypt treasury failed', chatId, e?.message || e);
    return { paid: false, error: e };
  }
  const fromKeypair = keypairFromSecretBytes(secret);

  const results = [];
  for (let i = 0; i < winners.length; i++) {
    const w = winners[i];
    const amount = shares[i];
    try {
      const { signature } = await sendSplReward({
        fromKeypair,
        toAddress: w.solana_address,
        mint: group.reward_mint,
        amountUi: amount
      });
      await recordRewardPayout({
        chatId,
        userId: Number(w.user_id),
        amount,
        signature,
        periodStartedAt: group.period_started_at
      });
      results.push({ w, amount, signature, ok: true });
    } catch (e) {
      console.error('payout failed', chatId, w.user_id, e?.message || e);
      results.push({ w, amount, ok: false, error: e?.message || String(e) });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  if (okCount > 0) {
    await updateGroupRewards(chatId, {
      last_payout_at: now,
      period_started_at: now
    });
    const lines = results.map((r, idx) => {
      const label = getUsernameLabel({
        id: r.w.user_id,
        username: r.w.username,
        first_name: r.w.first_name
      });
      if (r.ok) return `${idx + 1}. ${label} — ${r.amount} tokens`;
      return `${idx + 1}. ${label} — failed (${escHtml(r.error)})`;
    });
    try {
      await bot.sendMessage(
        chatId,
        addFooter(`<b>Reward payout</b>\n${lines.join('\n')}`),
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
    } catch {}
    return { paid: true };
  }
  return { paid: false, allFailed: true };
}

async function maybeLowBalanceAlert(bot, group, addFooter) {
  if (!group.wallet_pubkey || !group.reward_mint || !(group.reward_amount > 0)) return;
  const last = group.last_low_balance_alert_at
    ? new Date(group.last_low_balance_alert_at).getTime()
    : 0;
  if (Date.now() - last < 24 * 3600000) return;

  let bal;
  try {
    bal = await getTokenBalance(group.wallet_pubkey, group.reward_mint);
  } catch (e) {
    console.error('low balance check failed', group.chat_id, e?.message || e);
    return;
  }
  if (bal.ui >= group.reward_amount) return;

  await updateGroupRewards(group.chat_id, { last_low_balance_alert_at: new Date() });
  try {
    const name = await getTokenMetadataName(group.reward_mint).catch(() => 'reward token');
    await bot.sendMessage(
      group.chat_id,
      addFooter(
        `<b>Treasury low</b>\n` +
        `The rewards wallet cannot cover the next payout of ${group.reward_amount} ${escHtml(name)}.\n` +
        `Current balance: ${bal.ui}\n` +
        `<code>${escHtml(group.wallet_pubkey)}</code>`
      ),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
  } catch (e) {
    console.error('low balance alert send failed', e?.message || e);
  }
}

export async function runRewardTick(bot, addFooter, getUsernameLabel) {
  let groups;
  try {
    groups = await listGroupsDueForRewards();
  } catch (e) {
    console.error('listGroupsDueForRewards', e?.message || e);
    return;
  }
  for (const group of groups) {
    try {
      await processGroupPayout(bot, group, addFooter, getUsernameLabel);
      // Re-fetch for alert timing after possible payout update
      const fresh = await getGroupRewards(group.chat_id);
      if (fresh) await maybeLowBalanceAlert(bot, fresh, addFooter);
    } catch (e) {
      console.error('reward tick group error', group.chat_id, e?.message || e);
    }
  }
}
