const cron = require('node-cron');
const { InlineKeyboard } = require('grammy');
const { bot, db } = require('../bot');
const { WATERING } = require('../constants');
const { getQueueState, getCurrentWaterer, getNextWateringDate } = require('../db/queries');

function startCron() {

  cron.schedule('0 10 * * 3', async () => {
    try {
      const state = await getQueueState();
      const newCounter = (state.week_counter || 0) + 1;

      await db.query(
        'UPDATE queue_state SET week_counter = $1, last_notified_at = NOW() WHERE id = 1',
        [newCounter]
      );

      if (newCounter % 2 !== 0) return;

      const current = await getCurrentWaterer();
      if (!current) return;

      const keyboard = new InlineKeyboard().text('✅ Полил!', 'mark_watered');
      await bot.api.sendMessage(
        current.chat_id,
        `🌵 *${current.name}, пора полить Макса!*\n\n💧 Объём: ~${WATERING.waterLabel}\nЛей медленно по краю горшка 🪴`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    } catch (e) {
      console.error('❌ Ошибка cron (напоминание о поливе):', e.message);
    }
  }, { timezone: 'Europe/Minsk' });

  cron.schedule('0 10 * * *', async () => {
    try {
      const nextDate = await getNextWateringDate();
      if (!nextDate) return;

      const diffMs = nextDate.getTime() - Date.now();
      if (diffMs >= 0) return;

      const current = await getCurrentWaterer();
      if (!current) return;

      const keyboard = new InlineKeyboard().text('✅ Полил!', 'mark_watered');
      await bot.api.sendMessage(
        current.chat_id,
        `⚠️ *${current.name}, Макс до сих пор не полит!*\n\nСрок полива уже прошёл 🌵\n💧 Объём: ~${WATERING.waterLabel}\nЛей медленно по краю горшка 🪴`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    } catch (e) {
      console.error('❌ Ошибка cron (проверка просрочки):', e.message);
    }
  }, { timezone: 'Europe/Minsk' });
}

module.exports = { startCron };
