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
  getWalletTokenBalances,
  getTokenMetadataName,
  sendSplReward,
  cascadingShares
} from './solana.js';

export const pendingSetbull = new Map(); // userId -> { chatId, field, replyToMessageId, menuMessageId }
export const pendingSetwallet = new Map(); // userId -> { notifyChatId? }
/** chatId -> { messageId, ownerId } for the active /setbull session */
export const setbullMenuMessages = new Map();

const BLACKLIST_PAGE_SIZE = 5;
const MIN_PERIOD_HOURS = 1;
/** Primary admin only — same as ADMIN_USER_ID in index.js */
const RUN_REWARDS_NOW_USER_ID = 6933188641;

function canRunRewardsNow(userId) {
  return Number(userId) === RUN_REWARDS_NOW_USER_ID;
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function rememberSetbullMenu(chatId, messageId, ownerId = null) {
  if (chatId == null || messageId == null) return;
  const key = Number(chatId);
  const prev = setbullMenuMessages.get(key);
  setbullMenuMessages.set(key, {
    messageId: Number(messageId),
    ownerId: ownerId != null ? Number(ownerId) : (prev?.ownerId ?? null)
  });
}

function getSetbullSession(chatId) {
  return setbullMenuMessages.get(Number(chatId)) || null;
}

async function refreshSetbullMenu(bot, chatId, addFooter, messageId = null) {
  const session = getSetbullSession(chatId);
  const menuId = messageId || session?.messageId;
  if (!menuId) return false;
  const menu = await buildSetbullMenu(chatId, session?.ownerId);
  try {
    await bot.editMessageText(addFooter(menu.text), {
      chat_id: chatId,
      message_id: menuId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: menu.reply_markup
    });
    rememberSetbullMenu(chatId, menuId, session?.ownerId);
    return true;
  } catch (e) {
    // ignore "message is not modified"
    if (!/message is not modified/i.test(e?.message || '')) {
      console.error('refresh setbull menu', e?.message || e);
    }
    return false;
  }
}

export async function buildSetbullMenu(chatId, viewerUserId = null) {
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
    try {
      const tokens = await getWalletTokenBalances(row.wallet_pubkey);
      if (tokens.length === 0) {
        lines.push('Tokens: none');
      } else {
        lines.push('<b>Tokens</b>:');
        for (const t of tokens.slice(0, 15)) {
          const label = t.name || `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`;
          const amount = Number.isFinite(t.ui)
            ? t.ui.toLocaleString(undefined, { maximumFractionDigits: 6 })
            : String(t.ui);
          lines.push(`• ${escHtml(label)}: ${amount}`);
        }
        if (tokens.length > 15) {
          lines.push(`…and ${tokens.length - 15} more`);
        }
      }
    } catch (e) {
      lines.push('Tokens: (unavailable)');
      console.error('wallet token balances error', e?.message || e);
    }
  }

  lines.push('');
  lines.push(`Rewards: ${row.rewards_enabled !== false ? 'ON' : 'OFF'}`);
  lines.push(`Reward token: ${row.reward_mint ? `<code>${escHtml(row.reward_mint)}</code>` : '(not set)'}`);
  lines.push(`Reward amount: ${row.reward_amount != null ? row.reward_amount : '(not set)'}`);
  lines.push(`Winners: ${row.winner_count}`);
  lines.push(`Timer: ${row.period_hours}h`);
  lines.push(`Gift cooldown: ${row.gift_cooldown_mins ?? 30} min`);
  if (row.period_started_at) {
    const hours = Math.max(MIN_PERIOD_HOURS, Number(row.period_hours) || MIN_PERIOD_HOURS);
    const end = new Date(new Date(row.period_started_at).getTime() + hours * 3600000);
    lines.push(`Period ends: ${end.toISOString()}`);
  } else {
    lines.push('Period: not started (set wallet + token + amount)');
  }

  keyboard.push([{ text: 'Set reward token', callback_data: 'sb:settoken' }]);
  keyboard.push([{ text: 'Set reward amount', callback_data: 'sb:setamount' }]);
  keyboard.push([{ text: 'Set number of winners', callback_data: 'sb:setwinners' }]);
  keyboard.push([{ text: 'Set timer', callback_data: 'sb:settimer' }]);
  keyboard.push([{ text: 'Set gift cooldown', callback_data: 'sb:setgiftcd' }]);
  keyboard.push([{
    text: row.rewards_enabled !== false ? 'Turn rewards OFF' : 'Turn rewards ON',
    callback_data: 'sb:togglerewards'
  }]);
  if (canRunRewardsNow(viewerUserId)) {
    keyboard.push([{ text: 'Run Rewards Now', callback_data: 'sb:runnow' }]);
  }
  keyboard.push([{ text: 'Blacklist', callback_data: 'sb:bl:0' }]);
  keyboard.push([{ text: 'Close', callback_data: 'sb:close' }]);

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

async function promptSetbullField(bot, chatId, user, field, prompt, menuMessageId) {
  const userId = user.id;
  const session = getSetbullSession(chatId);
  // Mention the owner so force_reply selective only targets them
  const who = user.username
    ? `@${escHtml(user.username)}`
    : `<a href="tg://user?id=${userId}">${escHtml(user.first_name || 'admin')}</a>`;
  const sent = await bot.sendMessage(chatId, `${who} ${prompt}`, {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, selective: true }
  });
  pendingSetbull.set(userId, {
    chatId,
    field,
    replyToMessageId: sent.message_id,
    menuMessageId: menuMessageId || session?.messageId || null,
    ownerId: userId
  });
}

export async function handleSetbullCallback(bot, query, addFooter, getUsernameLabel) {
  const data = query.data || '';
  const msg = query.message;
  const chatId = msg.chat.id;
  const fromId = query.from.id;

  const session = getSetbullSession(chatId);
  if (!session || session.ownerId !== fromId || session.messageId !== msg.message_id) {
    if (query.id) {
      await bot.answerCallbackQuery(query.id, {
        text: 'Only the admin who opened this menu can use it.',
        show_alert: true
      });
    }
    return true;
  }

  if (data === 'sb:close') {
    if (query.id) await bot.answerCallbackQuery(query.id);
    // Drop any in-flight input for this owner
    const pending = pendingSetbull.get(fromId);
    if (pending?.chatId === chatId) {
      try { await bot.deleteMessage(chatId, pending.replyToMessageId); } catch {}
      pendingSetbull.delete(fromId);
    }
    try {
      await bot.deleteMessage(chatId, msg.message_id);
    } catch (e) {
      try {
        await bot.editMessageText(addFooter('Rewards settings closed.'), {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      } catch {}
    }
    setbullMenuMessages.delete(Number(chatId));
    return true;
  }

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
    await refreshSetbullMenu(bot, chatId, addFooter, msg.message_id);
    return true;
  }

  if (data === 'sb:settoken') {
    if (query.id) await bot.answerCallbackQuery(query.id);
    await promptSetbullField(
      bot,
      chatId,
      query.from,
      'token',
      'Reply with the Solana token mint address (CA) for rewards.',
      msg.message_id
    );
    return true;
  }
  if (data === 'sb:setamount') {
    if (query.id) await bot.answerCallbackQuery(query.id);
    await promptSetbullField(
      bot,
      chatId,
      query.from,
      'amount',
      'Reply with the total reward token amount to split each period (e.g. 1000).',
      msg.message_id
    );
    return true;
  }
  if (data === 'sb:setwinners') {
    if (query.id) await bot.answerCallbackQuery(query.id);
    await promptSetbullField(
      bot,
      chatId,
      query.from,
      'winners',
      'Reply with the number of winners (integer ≥ 1).',
      msg.message_id
    );
    return true;
  }
  if (data === 'sb:settimer') {
    if (query.id) await bot.answerCallbackQuery(query.id);
    await promptSetbullField(
      bot,
      chatId,
      query.from,
      'timer',
      `Reply with the reward period in hours (minimum ${MIN_PERIOD_HOURS}, default 72).`,
      msg.message_id
    );
    return true;
  }
  if (data === 'sb:setgiftcd') {
    if (query.id) await bot.answerCallbackQuery(query.id);
    await promptSetbullField(
      bot,
      chatId,
      query.from,
      'giftcd',
      'Reply with the /gift cooldown in minutes (minimum 1, default 30).',
      msg.message_id
    );
    return true;
  }
  if (data === 'sb:togglerewards') {
    const group = await getGroupRewards(chatId);
    const next = !(group?.rewards_enabled !== false);
    await updateGroupRewards(chatId, {
      rewards_enabled: next,
      // When turning back on, restart the period clock so a backlog doesn't pay immediately
      ...(next ? { period_started_at: new Date() } : {})
    });
    if (query.id) {
      await bot.answerCallbackQuery(query.id, {
        text: next ? 'Rewards turned ON.' : 'Rewards turned OFF.'
      });
    }
    await refreshSetbullMenu(bot, chatId, addFooter, msg.message_id);
    return true;
  }

  if (data === 'sb:runnow') {
    if (!canRunRewardsNow(fromId)) {
      if (query.id) {
        await bot.answerCallbackQuery(query.id, {
          text: 'Only the primary admin can run rewards manually.',
          show_alert: true
        });
      }
      return true;
    }
    const group = await getGroupRewards(chatId);
    if (group && group.rewards_enabled === false) {
      if (query.id) {
        await bot.answerCallbackQuery(query.id, {
          text: 'Rewards are turned OFF. Turn them on first.',
          show_alert: true
        });
      }
      return true;
    }
    if (!group?.wallet_pubkey || !group?.reward_mint || !(group.reward_amount > 0)) {
      if (query.id) {
        await bot.answerCallbackQuery(query.id, {
          text: 'Set wallet, reward token, and amount first.',
          show_alert: true
        });
      }
      return true;
    }
    if (query.id) await bot.answerCallbackQuery(query.id, { text: 'Running rewards now…' });
    try {
      await processGroupPayout(bot, group, addFooter, getUsernameLabel, { force: true });
    } catch (e) {
      console.error('manual run rewards failed', chatId, e?.message || e);
      try {
        await bot.sendMessage(
          chatId,
          addFooter(`Manual reward run failed: ${escHtml(e?.message || e)}`),
          { parse_mode: 'HTML', disable_web_page_preview: true }
        );
      } catch {}
    }
    await refreshSetbullMenu(bot, chatId, addFooter, msg.message_id);
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
      rememberSetbullMenu(chatId, msg.message_id, fromId);
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
      rememberSetbullMenu(chatId, msg.message_id, fromId);
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
  // Only the admin who started this input, and only as a reply to the prompt
  if (state.ownerId != null && msg.from.id !== state.ownerId) return false;
  if (!msg.reply_to_message || msg.reply_to_message.message_id !== state.replyToMessageId) {
    // Ignore unrelated messages from this user while a prompt is open
    return false;
  }

  const session = getSetbullSession(state.chatId);
  if (session && session.ownerId != null && session.ownerId !== msg.from.id) {
    return false;
  }

  const text = msg.text.trim();
  const chatId = state.chatId;
  let ok = false;
  let errText = null;

  try {
    if (state.field === 'token') {
      if (!validateSolanaAddress(text)) {
        errText = 'Invalid Solana mint address. Try again via the menu.';
      } else {
        await updateGroupRewards(chatId, { reward_mint: text });
        await maybeStartRewardPeriod(chatId);
        ok = true;
      }
    } else if (state.field === 'amount') {
      const amount = Number(text);
      if (!Number.isFinite(amount) || amount <= 0) {
        errText = 'Amount must be a positive number.';
      } else {
        await updateGroupRewards(chatId, { reward_amount: amount });
        await maybeStartRewardPeriod(chatId);
        ok = true;
      }
    } else if (state.field === 'winners') {
      const n = parseInt(text, 10);
      if (!Number.isFinite(n) || n < 1 || n > 50) {
        errText = 'Winners must be an integer from 1 to 50.';
      } else {
        await updateGroupRewards(chatId, { winner_count: n });
        await maybeStartRewardPeriod(chatId);
        ok = true;
      }
    } else if (state.field === 'timer') {
      const hours = Number(text);
      if (!Number.isFinite(hours) || hours < MIN_PERIOD_HOURS || hours > 8760) {
        errText = `Timer must be at least ${MIN_PERIOD_HOURS} hour(s) (max 8760).`;
      } else {
        await updateGroupRewards(chatId, {
          period_hours: hours,
          period_started_at: new Date()
        });
        ok = true;
      }
    } else if (state.field === 'giftcd') {
      const mins = parseInt(text, 10);
      if (!Number.isFinite(mins) || mins < 1 || mins > 10080) {
        errText = 'Gift cooldown must be an integer from 1 to 10080 minutes.';
      } else {
        await updateGroupRewards(chatId, { gift_cooldown_mins: mins });
        ok = true;
      }
    }
  } catch (e) {
    console.error('setbull pending input error', e);
    errText = 'Failed to save setting.';
  }

  pendingSetbull.delete(msg.from.id);

  // Clean up the force-reply prompt and the user's reply
  try { await bot.deleteMessage(chatId, state.replyToMessageId); } catch {}
  try { await bot.deleteMessage(chatId, msg.message_id); } catch {}

  if (ok) {
    await refreshSetbullMenu(bot, chatId, addFooter, state.menuMessageId);
  } else if (errText) {
    const notice = await bot.sendMessage(chatId, addFooter(errText), {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    await refreshSetbullMenu(bot, chatId, addFooter, state.menuMessageId);
    setTimeout(() => {
      bot.deleteMessage(chatId, notice.message_id).catch(() => {});
    }, 8000);
  }
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
  await setUserWallet(msg.from.id, address);
  pendingSetwallet.delete(msg.from.id);
  await bot.sendMessage(
    msg.chat.id,
    addFooter(`Saved wallet <code>${escHtml(address)}</code> for Bull Royale rewards across all groups.`),
    { parse_mode: 'HTML', disable_web_page_preview: true }
  );
  if (state.notifyChatId) {
    try {
      await bot.sendMessage(
        state.notifyChatId,
        addFooter(`${getUsernameLabel(msg.from)} registered a Solana wallet for rewards.`),
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
    } catch {}
  }
  return true;
}

export async function startSetwalletFlow(bot, msg, addFooter) {
  const chat = msg.chat;
  const user = msg.from;
  if (!chat || !user) return;

  const existing = await getUserWallet(user.id);
  const existingNote = existing?.solana_address
    ? `\n\nCurrent wallet: <code>${escHtml(existing.solana_address)}</code>\nSend a new address to replace it.`
    : '';

  // Private chat: register directly here
  if (chat.type === 'private') {
    pendingSetwallet.set(user.id, { notifyChatId: null });
    await bot.sendMessage(
      chat.id,
      addFooter(
        `Send me your Solana wallet address to receive Bull Royale rewards in all groups.${existingNote}\n` +
        `Reply with the address only (or /cancel).`
      ),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
    return;
  }

  // Group: nudge + DM
  const chatId = chat.id;
  pendingSetwallet.set(user.id, { notifyChatId: chatId });
  await bot.sendMessage(chatId, addFooter(`${getUsernameLabelSafe(user)}: check your DMs to register your Solana wallet.`), {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });

  try {
    await bot.sendMessage(
      user.id,
      addFooter(
        `Send me your Solana wallet address to receive Bull Royale rewards in <b>all groups</b>.${existingNote}\n` +
        `Reply in this chat with the address only.`
      ),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
  } catch {
    pendingSetwallet.delete(user.id);
    await bot.sendMessage(
      chatId,
      addFooter('I could not DM you. Open a private chat with me, press Start, then run /setwallet there (or in the group again).'),
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

const lastPayoutFailNotifyAt = new Map(); // chatId -> ms

async function processGroupPayout(bot, group, addFooter, getUsernameLabel, options = {}) {
  const force = Boolean(options.force);
  const chatId = group.chat_id;
  const now = new Date();

  if (!group.wallet_pubkey || !group.reward_mint || !(group.reward_amount > 0)) {
    return { paid: false, due: false };
  }
  if (group.rewards_enabled === false && !force) {
    return { paid: false, due: false };
  }

  // Enforce minimum period length for scheduled payouts (manual run ignores the clock)
  const periodHours = Math.max(MIN_PERIOD_HOURS, Number(group.period_hours) || MIN_PERIOD_HOURS);
  if (!force) {
    if (!group.period_started_at) return { paid: false, due: false };
    const startedAt = new Date(group.period_started_at).getTime();
    const periodMs = periodHours * 3600000;
    if (!Number.isFinite(startedAt) || !Number.isFinite(periodMs) || periodMs <= 0) {
      console.error('invalid reward period', chatId, group.period_started_at, group.period_hours);
      return { paid: false };
    }
    const periodEnd = new Date(startedAt + periodMs);
    if (now < periodEnd) return { paid: false, due: false };

    console.log(
      'reward period due',
      chatId,
      'ended',
      periodEnd.toISOString(),
      'amount',
      group.reward_amount,
      'winners',
      group.winner_count
    );
  } else {
    console.log('manual reward run', chatId, 'amount', group.reward_amount, 'winners', group.winner_count);
    // Allow immediate failure feedback for admin-triggered runs
    lastPayoutFailNotifyAt.delete(Number(chatId));
  }

  const winners = await getEligibleRewardWinners(chatId, group.winner_count);
  if (!winners.length) {
    await updateGroupRewards(chatId, {
      last_payout_at: now,
      period_started_at: now
    });
    try {
      await bot.sendMessage(
        chatId,
        addFooter(
          force
            ? 'Manual reward run: no eligible winners (not blacklisted). Period restarted.'
            : 'Reward period ended, but no eligible winners (not blacklisted). Period restarted.'
        ),
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
    } catch {}
    return { paid: false, due: true };
  }

  // Split across all placements (winner_count slots filled); unpaid shares stay in treasury
  const shares = cascadingShares(group.reward_amount, winners.length);
  const payableTotal = winners.reduce((sum, w, i) => {
    if (w.solana_address) return sum + Number(shares[i] || 0);
    return sum;
  }, 0);

  // Preflight only for the amount that will actually be sent
  if (payableTotal > 0) {
    try {
      const bal = await getTokenBalance(group.wallet_pubkey, group.reward_mint);
      if (bal.ui < payableTotal) {
        console.error(
          'treasury underfunded for payout',
          chatId,
          'have',
          bal.ui,
          'need',
          payableTotal
        );
        await maybeNotifyPayoutBlocked(
          bot,
          chatId,
          addFooter,
          force
            ? `Manual reward run blocked: treasury balance is ${bal.ui} (need ${payableTotal}).`
            : `Reward period ended but treasury balance is ${bal.ui} (need ${payableTotal}). Period not restarted — will retry.`
        );
        return { paid: false, due: true, underfunded: true };
      }
    } catch (e) {
      console.error('preflight balance check failed', chatId, e?.message || e);
    }
  }

  let fromKeypair = null;
  const needsTransfers = winners.some((w) => w.solana_address);
  if (needsTransfers) {
    let secret;
    try {
      secret = decryptSecret(group.wallet_privkey_enc);
    } catch (e) {
      console.error('decrypt treasury failed', chatId, e?.message || e);
      await maybeNotifyPayoutBlocked(
        bot,
        chatId,
        addFooter,
        'Reward payout blocked: could not unlock the treasury wallet key. Check WALLET_ENCRYPTION_KEY.'
      );
      return { paid: false, due: true, error: e };
    }
    fromKeypair = keypairFromSecretBytes(secret);
    if (fromKeypair.publicKey.toBase58() !== group.wallet_pubkey) {
      await maybeNotifyPayoutBlocked(
        bot,
        chatId,
        addFooter,
        'Reward payout blocked: treasury key does not match the configured wallet.'
      );
      return { paid: false, due: true, error: new Error('keypair mismatch') };
    }
  }

  const results = [];
  for (let i = 0; i < winners.length; i++) {
    const w = winners[i];
    const amount = shares[i];

    if (!w.solana_address) {
      results.push({ w, amount, ok: false, skipped: true, reason: 'no wallet' });
      continue;
    }

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
        periodStartedAt: group.period_started_at || now
      });
      results.push({ w, amount, signature, ok: true });
    } catch (e) {
      console.error('payout failed', chatId, w.user_id, e?.message || e);
      results.push({ w, amount, ok: false, error: e?.message || String(e) });
    }
  }

  const formatResultLine = (r, idx) => {
    const label = getUsernameLabel({
      id: r.w.user_id,
      username: r.w.username,
      first_name: r.w.first_name
    });
    if (r.ok) return `${idx + 1}. ${label} — ${r.amount} tokens`;
    if (r.skipped) {
      return `${idx + 1}. ${label} — ${r.amount} tokens (no wallet — /setwallet)`;
    }
    return `${idx + 1}. ${label} — ${r.amount} tokens — failed (${escHtml(r.error)})`;
  };

  const okCount = results.filter((r) => r.ok).length;
  const transferAttempts = results.filter((r) => !r.skipped).length;
  const allSkippedNoWallet = transferAttempts === 0 && results.length > 0;

  // Advance period if anyone was paid, or if nobody had a wallet to pay
  if (okCount > 0 || allSkippedNoWallet) {
    await updateGroupRewards(chatId, {
      last_payout_at: now,
      period_started_at: now
    });
    const lines = results.map(formatResultLine);
    try {
      await bot.sendMessage(
        chatId,
        addFooter(`<b>${force ? 'Manual reward payout' : 'Reward payout'}</b>\n${lines.join('\n')}`),
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
    } catch {}
    return { paid: okCount > 0, due: true };
  }

  const lines = results.map(formatResultLine);
  await maybeNotifyPayoutBlocked(
    bot,
    chatId,
    addFooter,
    `<b>Reward payout failed</b>\n${lines.join('\n')}\nPeriod not restarted — will retry.`
  );
  return { paid: false, due: true, allFailed: true };
}

async function maybeNotifyPayoutBlocked(bot, chatId, addFooter, htmlBody) {
  const key = Number(chatId);
  const last = lastPayoutFailNotifyAt.get(key) || 0;
  if (Date.now() - last < 15 * 60 * 1000) return;
  lastPayoutFailNotifyAt.set(key, Date.now());
  try {
    await bot.sendMessage(chatId, addFooter(htmlBody), {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (e) {
    console.error('payout blocked notify failed', chatId, e?.message || e);
  }
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
