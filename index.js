require('dotenv').config();
const { GrammyError, HttpError } = require('grammy');
const { bot, db } = require('./bot');
const { logger } = require('./config/logger');
const { registerCommands } = require('./handlers/commands');
const { registerCallbacks } = require('./handlers/callbacks');
const { registerAdminHandlers } = require('./handlers/admin');
const { registerGlobalMessageHandlers } = require('./handlers/global');
const { startCron } = require('./cron');
const { run } = require('@grammyjs/runner');
const { upsertUser } = require('./db/queries');
const { requireEnvNumber } = require('./config/env');

const adminChatId = requireEnvNumber('ADMIN_CHAT_ID');

const commonCommands = [
  { command: 'start',   description: 'Запустить бота' },
  { command: 'menu',    description: 'Открыть главное меню' },
  { command: 'watered', description: 'Отметить полив' },
  { command: 'help',    description: 'Показать список команд' },
];

const adminCommands = [
  ...commonCommands,
  { command: 'users', description: 'Список пользователей (админ)' },
];

// ── Middleware: авто-регистрация пользователя ──────────────────────────────
bot.use(async (ctx, next) => {
  if (ctx.from) {
    await upsertUser(
      ctx.from.id,
      ctx.from.first_name,
      ctx.from.username ?? null
    ).catch((err) => logger.error({ err }, 'upsertUser failed'));
  }
  return next();
});

// ── Хендлеры ──────────────────────────────────────────────────────────────
registerCommands(bot);
registerCallbacks(bot);
registerAdminHandlers(bot);
registerGlobalMessageHandlers(bot);

// ── Глобальный перехват ошибок (после всех хендлеров) ─────────────────────
bot.catch((err) => {
  const ctx = err.ctx;
  const e = err.error;

  logger.error(
    { updateId: ctx?.update?.update_id, err: e },
    'Error while handling update'
  );

  if (e instanceof GrammyError) {
    logger.error({ description: e.description }, 'Telegram API error');
  } else if (e instanceof HttpError) {
    logger.error({ err: e }, 'Telegram connection error');
  } else {
    logger.error({ err: e }, 'Unknown error');
  }

  ctx?.reply('⚠️ Что-то пошло не так. Попробуй ещё раз.').catch(() => {});
});

// ── Запуск ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    await db.query('SELECT 1');
    logger.info('Database connection established');

    await bot.api.setMyCommands(commonCommands);

    if (adminChatId !== null) {
      await bot.api.setMyCommands(adminCommands, {
        type: 'chat',
        chat_id: adminChatId,
      });
    }

    const runner = run(bot, {
      source: {
        allowed_updates: ['message', 'callback_query'],
      },
      sink: {
        concurrency: Number(process.env.RUNNER_CONCURRENCY || 10),
      },
    });

    const stop = async () => {
      try {
        if (runner?.isRunning?.()) await runner.stop();
      } catch (err) {
        logger.error({ err }, 'Failed to stop runner');
      }
      try {
        await db.end();
      } catch (err) {
        logger.error({ err }, 'Failed to close DB pool');
      }
      process.exit(0);
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    logger.info('Bot started');
    startCron();
  } catch (err) {
    logger.error({ err }, 'Database connection error');
    process.exit(1);
  }
})();