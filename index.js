require('dotenv').config();
const { GrammyError, HttpError } = require('grammy'); // ✅ импорт ошибок
const { bot, db } = require('./bot');
const { registerCommands } = require('./handlers/commands');
const { registerCallbacks } = require('./handlers/callbacks');
const { registerAdminHandlers } = require('./handlers/admin');
const { registerGlobalMessageHandlers } = require('./handlers/global');
const { startCron } = require('./cron');

bot.catch((err) => {
  const ctx = err.ctx;
  const e = err.error;

  console.error(`❌ Ошибка при обработке update ${ctx?.update?.update_id}`);

  if (e instanceof GrammyError) {        // ✅ теперь работает
    console.error('Ошибка Telegram API:', e.description);
  } else if (e instanceof HttpError) {   // ✅ теперь работает
    console.error('Нет связи с Telegram:', e);
  } else {
    console.error('Неизвестная ошибка:', e);
  }

  ctx?.reply('⚠️ Что-то пошло не так. Попробуй ещё раз.').catch(() => {});
});

registerCommands(bot);
registerCallbacks(bot);
registerAdminHandlers(bot);
registerGlobalMessageHandlers(bot);

const { requireEnvNumber } = require('./config/env');
const adminChatId = (() => {
  // ADMIN_CHAT_ID нужен для работы с заявками и админ-командами.
  // Если переменная отсутствует/битая — упадем с понятной ошибкой.
  return requireEnvNumber('ADMIN_CHAT_ID');
})();

const commonCommands = [
  { command: 'start', description: 'Запустить бота' },
  { command: 'menu', description: 'Открыть главное меню' },
  { command: 'watered', description: 'Отметить полив' },
  { command: 'help', description: 'Показать список команд' },
];

const adminCommands = [
  ...commonCommands,
  { command: 'users', description: 'Список пользователей (админ)' },
];

(async () => {
  try {
    // Важно: Pool сам управляет клиентом, поэтому используем query вместо connect() без release()
    await db.query('SELECT 1');
    console.log('✅ Подключение к БД успешно');

    // Показываем обычные команды всем
    await bot.api.setMyCommands(commonCommands);

    // Показываем админские команды только в чате админа (scoped)
    if (adminChatId !== null) {
      await bot.api.setMyCommands(adminCommands, { type: 'chat', chat_id: adminChatId });
    }

    bot.start();
    console.log('🌵 Бот запущен! Слежу за Максом 🌵');
    startCron();
  } catch (err) {
    console.error('❌ Ошибка подключения к БД:', err?.message || err);
    process.exit(1);
  }
})();
