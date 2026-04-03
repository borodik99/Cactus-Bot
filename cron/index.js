const cron = require('node-cron');
const { InlineKeyboard } = require('grammy');
const { bot, db } = require('../bot');
const { WATERING } = require('../constants');
const { getCurrentWaterer, getNextWateringDate } = require('../db/queries');

function startCron() {
  let running = false;

  // Каждый день в 10:00 — проверяем нужно ли слать уведомление
  const keyboard = new InlineKeyboard().text('✅ Полил!', 'mark_watered');

  cron.schedule('0 10 * * *', async () => {
    if (running) return;
    running = true;
    try {
      const [nextDate, current] = await Promise.all([
        getNextWateringDate(),
        getCurrentWaterer(),
      ]);
      if (!nextDate || !current) return;

      const diffMs = nextDate.getTime() - Date.now();

      // Сегодня день полива
      if (diffMs <= 0 && diffMs > -86400000) {
        await bot.api.sendMessage(
          current.chat_id,
          `🌵 *${current.name}, пора полить Макса!*\n\n💧 Объём: ~${WATERING.waterLabel}\nЛей медленно по краю горшка 🪴`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
        return;
      }

      // Полив просрочен (уже прошло больше суток)
      if (diffMs < -86400000) {
        await bot.api.sendMessage(
          current.chat_id,
          `⚠️ *${current.name}, Макс до сих пор не полит!*\n\nСрок полива уже прошёл 🌵\n💧 Объём: ~${WATERING.waterLabel}\nЛей медленно по краю горшка 🪴`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
      }

    } catch (e) {
      console.error('❌ Ошибка cron:', e.message);
    } finally {
      running = false;
    }
  }, { timezone: 'Europe/Minsk' });

}

module.exports = { startCron };
