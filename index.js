require('dotenv').config();
const { GrammyError, HttpError } = require('grammy'); // ✅ импорт ошибок
const { bot, db } = require('./bot');
const { registerCommands } = require('./handlers/commands');
const { registerCallbacks } = require('./handlers/callbacks');
const { registerAdminHandlers } = require('./handlers/admin');
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
startCron();

db.connect()
  .then(async () => {
    console.log('✅ Подключение к БД успешно');

    await bot.api.setMyCommands([
      { command: 'start', description: 'Запустить бота' },
      { command: 'menu', description: 'Открыть главное меню' },
      { command: 'watered', description: 'Отметить полив' },
      { command: 'help', description: 'Показать список команд' },
      { command: 'users', description: 'Список пользователей (админ)' },
      { command: 'approve', description: 'Выдать доступ (админ)' },
      { command: 'revoke', description: 'Забрать доступ (админ)' },
    ]);

    bot.start();
    console.log('🌵 Бот запущен! Слежу за Максом 🌵');
  })
  .catch(err => {
    console.error('❌ Ошибка подключения к БД:', err.message);
    process.exit(1);
  });
