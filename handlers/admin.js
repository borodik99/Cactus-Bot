const { InlineKeyboard } = require('grammy');
const { getUser } = require('../db/queries');
const { getQueueState, setCurrentTurn, getCurrentWaterer } = require('../db/queries');
const { WATERING } = require('../constants');
const { db } = require('../bot');

function registerAdminHandlers(bot) {

  bot.on('message:text', async (ctx) => {
    // Обрабатываем только ответы на сообщение от бота (force_reply), чтобы не делать запрос в БД
    // на каждый текст от каждого пользователя.
    const replyText = ctx.message.reply_to_message?.text ?? '';
    if (!replyText.includes('Напиши причину')) return;

    const user = await getUser(ctx.chat.id);
    if (!user?.waiting_skip_reason) return;

    const reason = ctx.message.text;
    await db.query('UPDATE users SET waiting_skip_reason = FALSE WHERE chat_id = $1', [ctx.chat.id]);

    const adminId = process.env.ADMIN_CHAT_ID;
    if (!adminId) return;

    const keyboard = new InlineKeyboard()
      .text('✅ Передать очередь', `admin_skip_${ctx.chat.id}`)
      .text('❌ Отклонить', `admin_deny_${ctx.chat.id}`);

    await bot.api.sendMessage(
      adminId,
      `⏩ Запрос на пропуск очереди:\n\nИмя: ${user.name}\nID: ${ctx.chat.id}\nПричина: ${reason}`,
      { reply_markup: keyboard }
    ).catch(() => {});

    await ctx.reply('✅ Запрос отправлен админу. Ожидай решения.');
  });

  bot.callbackQuery(/^admin_skip_(\d+)$/, async (ctx) => {
    const adminId = Number(process.env.ADMIN_CHAT_ID);
    if (ctx.chat.id !== adminId) return ctx.answerCallbackQuery();

    const targetId = Number(ctx.match[1]);
    const state = await getQueueState();
    const lenRes = await db.query(
      'SELECT COUNT(*)::int AS len FROM users WHERE in_queue = TRUE'
    );
    const len = Number(lenRes.rows[0]?.len ?? 0);
    if (len <= 0) return ctx.answerCallbackQuery({ text: 'Очередь пуста.' });

    await setCurrentTurn((Number(state.current_turn) + 1) % len);

    const nextUser = await getCurrentWaterer();

    await ctx.answerCallbackQuery({ text: 'Очередь передана.' });
    await ctx.editMessageText('✅ Одобрено. Очередь передана следующему.');

    await bot.api.sendMessage(targetId, '✅ Твой запрос на пропуск одобрен. Очередь передана следующему.').catch(() => {});

    if (nextUser) {
      const keyboard = new InlineKeyboard().text('✅ Полил!', 'mark_watered');
      await bot.api.sendMessage(
        nextUser.chat_id,
        `🌵 *${nextUser.name}, теперь твоя очередь поливать Макса!*\n\n💧 Объём: ~${WATERING.waterLabel}\nЛей медленно по краю горшка 🪴`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      ).catch(() => {});
    }
  });

  bot.callbackQuery(/^admin_deny_(\d+)$/, async (ctx) => {
    const adminId = Number(process.env.ADMIN_CHAT_ID);
    if (ctx.chat.id !== adminId) return ctx.answerCallbackQuery();

    const targetId = Number(ctx.match[1]);

    await ctx.answerCallbackQuery({ text: 'Отклонено.' });
    await ctx.editMessageText('❌ Отклонено. Очередь не изменена.');

    await bot.api.sendMessage(targetId, '❌ Твой запрос на пропуск отклонён администратором. Пожалуйста, полей Макса 🌵').catch(() => {});
  });
}

module.exports = { registerAdminHandlers };
