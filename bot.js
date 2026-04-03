const { Bot } = require('grammy');
const { hydrate } = require('@grammyjs/hydrate');
const { autoRetry } = require('@grammyjs/auto-retry');
const { Pool } = require('pg');

const { requireEnv } = require('./config/env');
const { logger } = require('./config/logger');

const bot = new Bot(requireEnv('BOT_API_KEY'));
bot.use(hydrate());

// Log all incoming updates and their processing outcome.
bot.use(async (ctx, next) => {
  const updateId = ctx.update?.update_id;
  const msg = ctx.message;
  const cb = ctx.callbackQuery;

  const type = ctx.update?.message
    ? 'message'
    : ctx.update?.callback_query
      ? 'callback_query'
      : ctx.update?.edited_message
        ? 'edited_message'
        : 'other';

  const chatId = msg?.chat?.id ?? cb?.message?.chat?.id ?? ctx.chat?.id ?? null;
  const userId = msg?.from?.id ?? cb?.from?.id ?? null;

  const text = msg?.text ?? msg?.caption ?? null;
  const cbData = cb?.data ?? null;

  const start = Date.now();
  logger.info(
    {
      updateId,
      type,
      chatId,
      userId,
      text: text ? String(text).slice(0, 120) : null,
      cbData: cbData ? String(cbData).slice(0, 120) : null,
    },
    'telegram update received'
  );

  try {
    await next();
    logger.debug({ updateId, elapsedMs: Date.now() - start }, 'telegram update processed');
  } catch (err) {
    logger.error({ updateId, type, chatId, userId, err }, 'telegram update failed');
    throw err;
  }
});

// Log all Bot API calls (including failures).
bot.api.config.use(async (prev, method, payload, signal) => {
  const start = Date.now();
  try {
    const res = await prev(method, payload, signal);
    logger.debug({ method, ok: res?.ok, elapsedMs: Date.now() - start }, 'bot api call');
    return res;
  } catch (err) {
    logger.error({ method, err, elapsedMs: Date.now() - start }, 'bot api call failed');
    throw err;
  }
});

// Automatically retry safe Bot API requests (rate limits / transient failures).
bot.api.config.use(
  autoRetry({
    maxRetryAttempts: Number(process.env.TELEGRAM_MAX_RETRY_ATTEMPTS || 3),
    maxDelaySeconds: Number(process.env.TELEGRAM_MAX_RETRY_DELAY_SECONDS || 30),
    rethrowInternalServerErrors: false,
    rethrowHttpErrors: false,
  })
);

const db = new Pool({ connectionString: requireEnv('DATABASE_URL') });

module.exports = { bot, db };
