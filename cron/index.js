const cron = require('node-cron');
const { InlineKeyboard } = require('grammy');
const { bot } = require('../bot');
const { WATERING } = require('../constants');
const {
  getCurrentWaterer,
  getNextWateringDate,
  getLastNotifiedAt,
  markNotifiedNow,
} = require('../db/queries');
const { logger } = require('../config/logger');
const {
  TZ,
  calendarDateIn,
  calendarDaysDiff,
  fmtDate,
  pluralDaysRu,
} = require('../helpers/dates');

const wateredKeyboard = new InlineKeyboard().text('✅ Полил!', 'mark_watered');

// Одна проверка: решаем, пора ли слать уведомление текущему участнику очереди.
async function checkAndNotify() {
  const current = await getCurrentWaterer();
  if (!current) return;

  const nextDate = await getNextWateringDate();
  const today = calendarDateIn(new Date());

  let text;
  if (!nextDate) {
    // Макса ещё ни разу не поливали через бота — напоминаем текущему участнику.
    text =
      `🌵 *${current.name}, Макс ждёт первого полива!*\n\n` +
      `💧 Объём: ~${WATERING.waterLabel}\n` +
      `Лей медленно по краю горшка 🪴`;
  } else {
    if (Date.now() < nextDate.getTime()) return; // срок ещё не наступил

    const overdueDays = calendarDaysDiff(calendarDateIn(nextDate), today);
    if (overdueDays <= 0) {
      // Сегодня день полива (10:00 по Минску уже наступило)
      text =
        `🌵 *${current.name}, пора полить Макса!*\n\n` +
        `💧 Объём: ~${WATERING.waterLabel}\n` +
        `Лей медленно по краю горшка 🪴`;
    } else {
      const when = overdueDays === 1 ? 'вчера' : `${overdueDays} ${pluralDaysRu(overdueDays)} назад`;
      text =
        `⚠️ *${current.name}, Макс до сих пор не полит!*\n\n` +
        `Плановая дата (*${fmtDate(nextDate)}*) была ${when} 🌵\n` +
        `💧 Объём: ~${WATERING.waterLabel}\n` +
        `Лей медленно по краю горшка 🪴`;
    }
  }

  // Дедупликация: не больше одного уведомления в календарный день (по Минску).
  const lastNotified = await getLastNotifiedAt();
  if (lastNotified && calendarDateIn(lastNotified) === today) return;

  await bot.api.sendMessage(current.chat_id, text, {
    parse_mode: 'Markdown',
    reply_markup: wateredKeyboard,
  });
  await markNotifiedNow();
}

function startCron() {
  let running = false;

  // Проверка каждые 30 минут вместо одиночного запуска в 10:00:
  // уведомление всё равно приходит один раз в день (дедупликация по дате),
  // но не теряется, если бот был недоступен ровно в момент срока.
  cron.schedule(
    '*/30 * * * *',
    async () => {
      if (running) return;
      running = true;
      try {
        await checkAndNotify();
      } catch (e) {
        logger.error({ err: e }, 'Cron error');
      } finally {
        running = false;
      }
    },
    { timezone: TZ }
  );
}

module.exports = { startCron };
