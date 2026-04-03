const { InlineKeyboard } = require('grammy');
const { db } = require('../bot');
const { WATERING } = require('../constants');
const { getQueue, getQueueState, setCurrentTurn, getCurrentWaterer, getNextWateringDate, rotateQueue } = require('../db/queries');
const { ensureApproved } = require('../helpers');
const { mainKeyboard, backKeyboard } = require('../keyboards');

function registerCallbacks(bot) {

  bot.callbackQuery('join_queue', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) return;

    const chatId = ctx.chat.id;
    if (user.in_queue) return ctx.answerCallbackQuery({ text: 'Ты уже в очереди! 🌿' });

    const res = await db.query(
      'SELECT COALESCE(MAX(queue_position), -1) + 1 AS pos FROM users WHERE in_queue = TRUE'
    );
    const position = res.rows[0].pos;

    await db.query(
      'UPDATE users SET in_queue = TRUE, queue_position = $1 WHERE chat_id = $2',
      [position, chatId]
    );

    const queue = await getQueue();
    const state = await getQueueState();
    const isCurrent = queue.length > 0 &&
      queue[state.current_turn % queue.length]?.chat_id === chatId;

    await ctx.editMessageText(
      `✅ *${user.name}*, ты в очереди по уходу за Максом!\n📍 Позиция: *${position + 1}* из ${queue.length}`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard(true, isCurrent) }
    );

    if (queue.length === 1) {
      const keyboard = new InlineKeyboard().text('✅ Полил!', 'mark_watered');
      await bot.api.sendMessage(
        chatId,
        `🌵 *${user.name}, ${WATERING.name}* ждёт первого полива!\n\n💧 Объём: ~${WATERING.waterLabel}\nЛей медленно по краю горшка 🪴`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
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

    const leavingPosition = user.queue_position;
    await db.query('UPDATE users SET in_queue = FALSE, queue_position = NULL WHERE chat_id = $1', [chatId]);
    await db.query(
      'UPDATE users SET queue_position = queue_position - 1 WHERE in_queue = TRUE AND queue_position > $1',
      [leavingPosition]
    );

    const queue = await getQueue();
    const state = await getQueueState();
    if (queue.length > 0 && state.current_turn >= queue.length) await setCurrentTurn(0);

    await ctx.answerCallbackQuery({ text: '👋 Ты вышел из очереди' });
    await ctx.editMessageText(
      `👋 *${user.name}*, ты вышел из очереди.\nМожешь вернуться в любое время!`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard(false) }
    );
  });

  bot.callbackQuery('show_queue', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) { await ctx.answerCallbackQuery(); return; }

    await ctx.answerCallbackQuery();
    const queue = await getQueue();

    if (queue.length === 0) {
      return ctx.editMessageText(
        `📋 Очередь пуста.\nНажми «Участвовать в поливе», чтобы ухаживать за *${WATERING.name}*! 🌵`,
        { parse_mode: 'Markdown', reply_markup: backKeyboard() }
      );
    }

    const state = await getQueueState();
    const lines = queue.map((u, i) => {
      const isCurrent = i === state.current_turn % queue.length;
      return `${isCurrent ? '💧' : `${i + 1}.`} ${u.name}${isCurrent ? ' ← сейчас' : ''}`;
    }).join('\n');

    await ctx.editMessageText(
      `📋 *Очередь полива Макса:*\n\n${lines}`,
      { parse_mode: 'Markdown', reply_markup: backKeyboard() }
    );
  });

  bot.callbackQuery('show_history', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) { await ctx.answerCallbackQuery(); return; }

    await ctx.answerCallbackQuery();
    const res = await db.query(
      `SELECT u.name, w.watered_at, w.water_ml
       FROM watering_log w
       LEFT JOIN users u ON u.id = w.user_id
       ORDER BY w.watered_at DESC LIMIT 10`
    );

    if (!res.rows.length) {
      return ctx.editMessageText(
        '📋 Макса ещё не поливали. История пуста.',
        { reply_markup: backKeyboard() }
      );
    }

    const lines = res.rows.map((e, i) => {
      const date = new Date(e.watered_at).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
      return `${i + 1}. ${date} — ${e.name} (${e.water_ml} мл)`;
    }).join('\n');

    await ctx.editMessageText(
      `💧 *История поливов Макса:*\n\n${lines}`,
      { parse_mode: 'Markdown', reply_markup: backKeyboard() }
    );
  });

  bot.callbackQuery('show_next', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) { await ctx.answerCallbackQuery(); return; }

    await ctx.answerCallbackQuery();
    const nextDate = await getNextWateringDate();
    const current = await getCurrentWaterer();

    if (!nextDate) {
      return ctx.editMessageText(
        `💧 Макса ещё не поливали через бота.\n\n📌 Режим: каждые *~${WATERING.freq} рабочих дней*\n👤 Первым поливает: *${current?.name || 'очередь пуста'}*`,
        { parse_mode: 'Markdown', reply_markup: backKeyboard() }
      );
    }

    const diffMs = nextDate.getTime() - Date.now();
    const daysLeft = Math.floor(diffMs / 86400000); // ✅ floor вместо ceil

    if (daysLeft <= 0) {
      await ctx.editMessageText(
        `⚠️ Макса уже пора полить!\n👤 Очередь: *${current?.name || '—'}*`,
        { parse_mode: 'Markdown', reply_markup: backKeyboard() }
      );
    } else {
      await ctx.editMessageText(
        `📅 Следующий полив Макса: *${nextDate.toLocaleDateString('ru-RU')}*\n⏳ Через: *${daysLeft} дн.*\n💧 Польёт: *${current?.name || '—'}* (~${WATERING.waterLabel})`,
        { parse_mode: 'Markdown', reply_markup: backKeyboard() }
      );
    }
  });

  bot.callbackQuery('back_to_menu', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) { await ctx.answerCallbackQuery(); return; }

    await ctx.answerCallbackQuery();
    const queue = await getQueue();
    const state = await getQueueState();
    const isCurrent = queue.length > 0 &&
      queue[state.current_turn % queue.length]?.chat_id === ctx.chat.id;

    await ctx.editMessageText(
      '🌵 Главное меню:',
      { reply_markup: mainKeyboard(user.in_queue || false, isCurrent) }
    );
  });

  bot.callbackQuery('mark_watered', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) { await ctx.answerCallbackQuery(); return; }

    const chatId = ctx.chat.id;
    const queue = await getQueue();
    const state = await getQueueState();
    const currentUser = queue[state.current_turn % queue.length];

    if (!currentUser || currentUser.chat_id !== chatId) {
      return ctx.answerCallbackQuery({ text: '⛔ Сейчас не твоя очередь поливать Макса.', show_alert: true });
    }

  const nextDate = await getNextWateringDate();
  if (nextDate) {
    const diffMs = nextDate.getTime() - Date.now();
    // ✅ Разрешаем полив если до даты меньше 24 часов или уже просрочено
    if (diffMs > 24 * 60 * 60 * 1000) {
      const daysLeft = Math.floor(diffMs / 86400000);
      return ctx.answerCallbackQuery({
      text: `⛔ Ещё рано! Следующий полив через ${daysLeft} дн. (${nextDate.toLocaleDateString('ru-RU')})`,
      show_alert: true,
    });
  }
}

    const name = user.name || ctx.from?.first_name || 'Кто-то';
    await db.query('INSERT INTO watering_log (user_id, water_ml) VALUES ($1, $2)', [user.id, WATERING.water]);
    await rotateQueue(chatId);

    const nextUser = await getCurrentWaterer();
    const nextWateringDate = await getNextWateringDate();
    const dateStr = new Date().toLocaleString('ru-RU', {
      timeZone: 'Europe/Minsk',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    await ctx.answerCallbackQuery({ text: '✅ Отмечено!' });
    await ctx.editMessageText(
      `✅ *${name}* полил Макса в ${dateStr} 💧\n\n📅 Следующий полив: *${nextWateringDate?.toLocaleDateString('ru-RU') || '—'}*\n👤 Польёт: *${nextUser?.name || '—'}*`,
      { parse_mode: 'Markdown' }
    );

    if (nextUser && nextUser.chat_id !== chatId) {
      await bot.api.sendMessage(
        nextUser.chat_id,
        `🔔 *${name}* только что полил Макса 💧\nГотовься — следующий полив *${nextWateringDate?.toLocaleDateString('ru-RU')}*, твоя очередь, *${nextUser.name}*! 🌵`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
  });

  bot.callbackQuery('skip_turn', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) { await ctx.answerCallbackQuery(); return; }

    const queue = await getQueue();
    const state = await getQueueState();
    const currentUser = queue[state.current_turn % queue.length];

    if (!currentUser || currentUser.chat_id !== ctx.chat.id) {
      return ctx.answerCallbackQuery({ text: 'Сейчас не твоя очередь.', show_alert: true });
    }

    await ctx.answerCallbackQuery();
    await ctx.reply(
      `⏩ Напиши причину, по которой хочешь пропустить очередь.\nСообщение уйдёт админу, и он решит — передать очередь или нет.\n\nПросто отправь текст в ответ на это сообщение.`,
      { reply_markup: { force_reply: true } }
    );

    await db.query('UPDATE users SET waiting_skip_reason = TRUE WHERE chat_id = $1', [ctx.chat.id]);
  });
}

module.exports = { registerCallbacks };
