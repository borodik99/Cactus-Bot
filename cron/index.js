const cron = require('node-cron');
const { bot } = require('../bot');
const { WATERING } = require('../constants');
const {
  getCurrentWaterer,
  getNextWateringDate,
  getLastNotifiedAt,
  markNotifiedNow,
} = require('../db/queries');
const { logger } = require('../config/logger');
const { wateredHtml } = require('../keyboards');
const { esc, rich } = require('../helpers/rich');
const {
  TZ,
  calendarDateIn,
  calendarDaysDiff,
  fmtDate,
  pluralDaysRu,
} = require('../helpers/dates');

// Одна проверка: решаем, пора ли слать уведомление текущему участнику очереди.
async function checkAndNotify() {
  const current = await getCurrentWaterer();
  if (!current) return;

  const nextDate = await getNextWateringDate();
  const today = calendarDateIn(new Date());

  let html;
  if (!nextDate) {
    // Макса ещё ни разу не поливали через бота — напоминаем текущему участнику.
    html =
      `<h3>🌵 Макс ждёт первого полива!</h3>` +
      `<p><b>${esc(current.name)}</b>, кактус ещё ни разу не поливали через бота.</p>` +
      `<p>💧 Объём: ~${WATERING.waterLabel}</p>` +
      `<p>Лей медленно по краю горшка 🪴</p>` +
      wateredHtml();
  } else {
    if (Date.now() < nextDate.getTime()) return; // срок ещё не наступил

    const overdueDays = calendarDaysDiff(calendarDateIn(nextDate), today);
    if (overdueDays <= 0) {
      // Сегодня день полива (10:00 по Минску уже наступило)
      html =
        `<h3>🌵 ${esc(current.name)}, пора полить Макса!</h3>` +
        `<p>💧 Объём: ~${WATERING.waterLabel}</p>` +
        `<p>Лей медленно по краю горшка 🪴</p>` +
        wateredHtml();
    } else {
      const when = overdueDays === 1 ? 'вчера' : `${overdueDays} ${pluralDaysRu(overdueDays)} назад`;
      html =
        `<h3>⚠️ ${esc(current.name)}, Макс до сих пор не полит!</h3>` +
        `<p>Плановая дата (<b>${fmtDate(nextDate)}</b>) была ${when} 🌵</p>` +
        `<p>💧 Объём: ~${WATERING.waterLabel}</p>` +
        `<p>Лей медленно по краю горшка 🪴</p>` +
        wateredHtml();
    }
  }

  // Дедупликация: не больше одного уведомления в календарный день (по Минску).
  const lastNotified = await getLastNotifiedAt();
  if (lastNotified && calendarDateIn(lastNotified) === today) return;

  await bot.api.sendRichMessage(current.chat_id, rich(html));
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
