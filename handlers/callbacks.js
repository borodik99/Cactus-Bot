const { db } = require('../bot');
const { WATERING } = require('../constants');
const { getQueue, getQueueState, getCurrentWaterer, getNextWateringDate, joinQueue, leaveQueue, markWatered } = require('../db/queries');
const { ensureApproved, notifyNextWaterer } = require('../helpers');
const { mainMenuHtml, backHtml, wateredHtml, nextWateringHtml } = require('../keyboards');
const { esc, rich, sendRich } = require('../helpers/rich');
const {
  fmtDate,
  fmtDateTime,
  calendarDateIn,
  calendarDaysDiff,
  pluralDaysRu,
} = require('../helpers/dates');

function registerCallbacks(bot) {

  bot.callbackQuery('join_queue', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) return;

    const chatId = ctx.chat.id;
    if (user.in_queue) return ctx.answerCallbackQuery({ text: 'Ты уже в очереди! 🌿' });

    const { position, len } = await joinQueue(chatId);
    const current = await getCurrentWaterer();
    const isCurrent = current?.chat_id === chatId;

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(rich(
      `<h3>✅ Ты в очереди!</h3>` +
      `<p><b>${esc(user.name)}</b>, ты в очереди по уходу за Максом!</p>` +
      `<p>📍 Позиция: <b>${position + 1}</b> из ${len}</p>` +
      mainMenuHtml(true, isCurrent)
    ));

    if (len === 1) {
      await sendRich(
        chatId,
        `<h3>🌵 Макс ждёт первого полива!</h3>` +
        `<p><b>${esc(user.name)}</b>, кактус ещё ни разу не поливали через бота.</p>` +
        `<p>💧 Объём: ~${WATERING.waterLabel}</p>` +
        `<p>Лей медленно по краю горшка 🪴</p>` +
        wateredHtml()
      );
    }
  });

  bot.callbackQuery('leave_queue', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) { await ctx.answerCallbackQuery(); return; }

    const chatId = ctx.chat.id;
    if (!user.in_queue) return ctx.answerCallbackQuery({ text: 'Тебя нет в очереди' });

    const nextDate = await getNextWateringDate();
    if (nextDate) {
      const diffMs = nextDate.getTime() - Date.now();
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      if (diffMs < 0) {
        return ctx.answerCallbackQuery({ text: '⛔ Макса ещё не полили! Нельзя выйти пока полив не выполнен.', show_alert: true });
      }
      if (diffHours < 24) {
        return ctx.answerCallbackQuery({ text: '⛔ До полива осталось менее 24 часов. Выйти нельзя.', show_alert: true });
      }
    }

    await leaveQueue(chatId);

    await ctx.answerCallbackQuery({ text: '👋 Ты вышел из очереди' });
    await ctx.editMessageText(rich(
      `<h3>👋 Ты вышел из очереди</h3>` +
      `<p><b>${esc(user.name)}</b>, ты вышел из очереди.</p>` +
      `<p>Можешь вернуться в любое время!</p>` +
      mainMenuHtml(false)
    ));
  });

  bot.callbackQuery('show_queue', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) { await ctx.answerCallbackQuery(); return; }

    await ctx.answerCallbackQuery();
    const queue = await getQueue();

    if (queue.length === 0) {
      return ctx.editMessageText(rich(
        `<h3>📋 Очередь пуста</h3>` +
        `<p>Нажми «Участвовать в поливе», чтобы ухаживать за <b>${WATERING.name}</b>! 🌵</p>` +
        backHtml()
      ));
    }

    const state = await getQueueState();
    const lines = queue.map((u, i) => {
      const isCurrent = i === state.current_turn % queue.length;
      return isCurrent
        ? `<p>💧 <b>${esc(u.name)}</b> ← сейчас</p>`
        : `<p>${i + 1}. ${esc(u.name)}</p>`;
    }).join('');

    await ctx.editMessageText(rich(
      `<h3>📋 Очередь полива Макса</h3>${lines}${backHtml()}`
    ));
  });

  bot.callbackQuery('show_history', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) { await ctx.answerCallbackQuery(); return; }

    await ctx.answerCallbackQuery();
    const res = await db.query(
      `SELECT u.name, w.watered_at AT TIME ZONE 'UTC' AS watered_at, w.water_ml
       FROM watering_log w
       LEFT JOIN users u ON u.id = w.user_id
       ORDER BY w.watered_at DESC LIMIT 10`
    );

    if (!res.rows.length) {
      return ctx.editMessageText(rich(
        `<h3>💧 История поливов</h3>` +
        `<p>Макса ещё не поливали. История пуста.</p>` +
        backHtml()
      ));
    }

    const lines = res.rows.map((e, i) => {
      const date = fmtDateTime(new Date(e.watered_at));
      return `<p>${i + 1}. ${date} — <b>${esc(e.name || '—')}</b> (${e.water_ml} мл)</p>`;
    }).join('');

    await ctx.editMessageText(rich(
      `<h3>💧 История поливов Макса</h3>${lines}${backHtml()}`
    ));
  });

  bot.callbackQuery('show_next', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) { await ctx.answerCallbackQuery(); return; }

    await ctx.answerCallbackQuery();
    const nextDate = await getNextWateringDate();
    const current = await getCurrentWaterer();

    if (!nextDate) {
      return ctx.editMessageText(rich(
        `<h3>⏭ Следующий полив</h3>` +
        `<p>Макса ещё не поливали через бота.</p>` +
        `<p>📌 Режим: каждые <b>~${WATERING.freq} дней</b></p>` +
        `<p>👤 Первым поливает: <b>${esc(current?.name || 'очередь пуста')}</b></p>` +
        backHtml()
      ));
    }

    const daysLeft = calendarDaysDiff(calendarDateIn(new Date()), calendarDateIn(nextDate));

    if (daysLeft < 1) {
      return ctx.editMessageText(rich(
        `<h3>⚠️ Макса уже пора полить!</h3>` +
        `<p>👤 Очередь: <b>${esc(current?.name || '—')}</b></p>` +
        `<p>💧 Объём: ~${WATERING.waterLabel}</p>` +
        wateredHtml()
      ));
    }

    await ctx.editMessageText(rich(
      `<h3>⏭ Следующий полив Макса</h3>` +
      `<p>📅 Дата: <b>${fmtDate(nextDate)}</b></p>` +
      `<p>⏳ Через: <b>${daysLeft} ${pluralDaysRu(daysLeft)}</b></p>` +
      `<p>💧 Польёт: <b>${esc(current?.name || '—')}</b> (~${WATERING.waterLabel})</p>` +
      backHtml()
    ));
  });

  bot.callbackQuery('back_to_menu', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) { await ctx.answerCallbackQuery(); return; }

    await ctx.answerCallbackQuery();
    const current = await getCurrentWaterer();
    const isCurrent = current?.chat_id === ctx.chat.id;

    await ctx.editMessageText(rich(
      `<h3>🌵 Главное меню</h3>` +
      mainMenuHtml(user.in_queue || false, isCurrent)
    ));
  });

  bot.callbackQuery('mark_watered', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) { await ctx.answerCallbackQuery(); return; }

    const chatId = ctx.chat.id;
    const currentUser = await getCurrentWaterer();
    if (!currentUser || currentUser.chat_id !== chatId) {
      return ctx.answerCallbackQuery({ text: '⛔ Сейчас не твоя очередь поливать Макса.', show_alert: true });
    }

    const nextDate = await getNextWateringDate();
    if (nextDate) {
      const diffMs = nextDate.getTime() - Date.now();
      // Разрешаем полив если до даты меньше 24 часов или уже просрочено.
      if (diffMs > 24 * 60 * 60 * 1000) {
        const daysLeft = calendarDaysDiff(calendarDateIn(new Date()), calendarDateIn(nextDate));
        return ctx.answerCallbackQuery({
          text: `⛔ Ещё рано! Следующий полив ${fmtDate(nextDate)} (через ${daysLeft} ${pluralDaysRu(daysLeft)})`,
          show_alert: true,
        });
      }
    }

    const name = user.name || ctx.from?.first_name || 'Кто-то';
    const ok = await markWatered(chatId, WATERING.water);
    if (!ok) {
      return ctx.answerCallbackQuery({
        text: '⛔ Очередь изменилась, попробуй ещё раз.',
        show_alert: true,
      });
    }

    const nextUser = await getCurrentWaterer();
    const nextWateringDate = await getNextWateringDate();
    const dateStr = fmtDateTime(new Date());

    await ctx.answerCallbackQuery({ text: '✅ Отмечено!' });
    await ctx.editMessageText(rich(
      `<h3>✅ Полив зафиксирован</h3>` +
      `<p><b>${esc(name)}</b> полил Макса в ${dateStr} 💧</p>` +
      `<p>📅 Следующий полив: <b>${fmtDate(nextWateringDate)}</b></p>` +
      `<p>👤 Польёт: <b>${esc(nextUser?.name || '—')}</b></p>` +
      nextWateringHtml()
    ));

    await notifyNextWaterer(name, nextUser, nextWateringDate, chatId);
  });

  bot.callbackQuery('skip_turn', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) { await ctx.answerCallbackQuery(); return; }

    const currentUser = await getCurrentWaterer();

    if (!currentUser || currentUser.chat_id !== ctx.chat.id) {
      return ctx.answerCallbackQuery({ text: 'Сейчас не твоя очередь.', show_alert: true });
    }

    await ctx.answerCallbackQuery();
    await ctx.reply(
      `⏩ Напиши причину, по которой хочешь пропустить очередь.\nСообщение уйдёт админу, и он решит — передать очередь или нет.\n\nПросто отправь текст в ответ на это сообщение.`,
    );

    await db.query('UPDATE users SET waiting_skip_reason = TRUE WHERE chat_id = $1', [ctx.chat.id]);
  });
}

module.exports = { registerCallbacks };
