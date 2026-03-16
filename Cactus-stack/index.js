require('dotenv').config();
const { bot, db } = require('./bot');
const { registerCommands } = require('./handlers/commands');
const { registerCallbacks } = require('./handlers/callbacks');
const { registerAdminHandlers } = require('./handlers/admin');
const { startCron } = require('./cron');

bot.catch((err) => {
  console.error('Ошибка бота:', err.message);
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
