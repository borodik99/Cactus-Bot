const { getUser } = require('../db/queries');
const { getQueueState, setCurrentTurn, getCurrentWaterer, leaveQueue } = require('../db/queries');
const { WATERING } = require('../constants');
const { db } = require('../bot');
const { usersListHtml } = require('./commands');
const { wateredHtml } = require('../keyboards');
const { esc, btn, row, rich, sendRich } = require('../helpers/rich');

function registerAdminHandlers(bot) {
  bot.callbackQuery(/^admin_user_accept_(\d+)$/, async (ctx) => {
    const adminId = Number(process.env.ADMIN_CHAT_ID);
    if (ctx.chat.id !== adminId) {
      return ctx.answerCallbackQuery({ text: 'Недостаточно прав', show_alert: true });
    }

    const targetId = Number(ctx.match[1]);
    const targetUser = await getUser(targetId);
    if (!targetUser) {
      return ctx.answerCallbackQuery({ text: 'Пользователь не найден', show_alert: true });
    }

    if (targetUser.approved) {
      await ctx.answerCallbackQuery({ text: 'Уже одобрен' });
      await ctx.editMessageText(rich(
        `<h3>✅ Уже одобрен</h3><p><b>${esc(targetUser.name)}</b><br>ID: ${targetId}</p>`
      )).catch(() => {});
      return;
    }

    await db.query('UPDATE users SET approved = TRUE, waiting_skip_reason = FALSE WHERE chat_id = $1', [targetId]);

    await ctx.answerCallbackQuery({ text: 'Одобрено' });
    await ctx.editMessageText(rich(
      `<h3>✅ Одобрен</h3><p><b>${esc(targetUser.name)}</b><br>ID: ${targetId}</p>`
    )).catch(() => {});

    await bot.api
      .sendMessage(targetId, '✅ Твоя заявка одобрена! Можешь пользоваться меню и очередью 🌵')
      .catch(() => {});
  });

  bot.callbackQuery(/^admin_user_reject_(\d+)$/, async (ctx) => {
    const adminId = Number(process.env.ADMIN_CHAT_ID);
    if (ctx.chat.id !== adminId) {
      return ctx.answerCallbackQuery({ text: 'Недостаточно прав', show_alert: true });
    }

    const targetId = Number(ctx.match[1]);
    const targetUser = await getUser(targetId);
    if (!targetUser) {
      return ctx.answerCallbackQuery({ text: 'Пользователь не найден', show_alert: true });
    }

    // Убираем из очереди с корректным пересчётом хода (current_turn)
    await leaveQueue(targetId);
    await db.query(
      'UPDATE users SET approved = FALSE, waiting_skip_reason = FALSE WHERE chat_id = $1',
      [targetId]
    );

    await ctx.answerCallbackQuery({ text: 'Отклонено' });
    await ctx.editMessageText(rich(
      `<h3>❌ Отклонён</h3><p><b>${esc(targetUser.name)}</b><br>ID: ${targetId}</p>`
    )).catch(() => {});

    await bot.api
      .sendMessage(targetId, '⛔ Твой доступ к боту отклонён администратором. Пожалуйста, попробуй позже 🌵')
      .catch(() => {});
  });

  async function renderUsersInline(ctx) {
    const res = await db.query(
      `SELECT chat_id, name, username, approved, in_queue, queue_position
       FROM users
       ORDER BY approved DESC, in_queue DESC, queue_position NULLS LAST, chat_id ASC
       LIMIT 50`
    );

    if (!res.rows.length) {
      return ctx.editMessageText(rich(`<h3>📋 Пользователи</h3><p>Пользователей в базе пока нет.</p>`)).catch(() => {});
    }

    return ctx
      .editMessageText(rich(usersListHtml(res.rows)))
      .catch(() => {});
  }

  bot.callbackQuery(/^admin_user_block_(\d+)$/, async (ctx) => {
    const adminId = Number(process.env.ADMIN_CHAT_ID);
    if (ctx.chat.id !== adminId) {
      return ctx.answerCallbackQuery({ text: 'Недостаточно прав', show_alert: true });
    }

    const targetId = Number(ctx.match[1]);
    const targetUser = await getUser(targetId);
    if (!targetUser) return ctx.answerCallbackQuery({ text: 'Пользователь не найден', show_alert: true });

    // Убираем из очереди с корректным пересчётом хода (current_turn)
    await leaveQueue(targetId);
    await db.query(
      'UPDATE users SET approved = FALSE, waiting_skip_reason = FALSE WHERE chat_id = $1',
      [targetId]
    );

    await ctx.answerCallbackQuery({ text: 'Пользователь заблокирован' });
    await renderUsersInline(ctx);

    await bot.api
      .sendMessage(targetId, '⛔ Твой доступ к боту заблокирован администратором. 🌵')
      .catch(() => {});
  });

  bot.callbackQuery(/^admin_user_unblock_(\d+)$/, async (ctx) => {
    const adminId = Number(process.env.ADMIN_CHAT_ID);
    if (ctx.chat.id !== adminId) {
      return ctx.answerCallbackQuery({ text: 'Недостаточно прав', show_alert: true });
    }

    const targetId = Number(ctx.match[1]);
    const targetUser = await getUser(targetId);
    if (!targetUser) return ctx.answerCallbackQuery({ text: 'Пользователь не найден', show_alert: true });

    await db.query('UPDATE users SET approved = TRUE, waiting_skip_reason = FALSE WHERE chat_id = $1', [targetId]);

    await ctx.answerCallbackQuery({ text: 'Пользователь разблокирован' });
    await renderUsersInline(ctx);

    await bot.api
      .sendMessage(targetId, '✅ Твой доступ к боту восстановлен администратором. Можешь пользоваться меню и очередью 🌵')
      .catch(() => {});
  });

  bot.on('message:text', async (ctx) => {
    // Обрабатываем только ответы на сообщение от бота (force_reply), чтобы не делать запрос в БД
    // на каждый текст от каждого пользователя.
    const replyText = ctx.message.reply_to_message?.text ?? '';
    if (!replyText.includes('Напиши причину')) return;

    const user = await getUser(ctx.chat.id);
    if (!user?.waiting_skip_reason) return;

    const reason = ctx.message.text;
    await db.query('UPDATE users SET waiting_skip_reason = FALSE WHERE chat_id = $1', [ctx.chat.id]);

    await ctx.react('👍').catch(() => {});

    const adminId = process.env.ADMIN_CHAT_ID;
    if (!adminId) return;

    await sendRich(
      adminId,
      `<h3>⏩ Запрос на пропуск очереди</h3>` +
      `<p>Имя: <b>${esc(user.name)}</b><br>ID: ${ctx.chat.id}</p>` +
      `<p>Причина: ${esc(reason)}</p>` +
      row([
        btn('✅ Передать очередь', `admin_skip_${ctx.chat.id}`, 'success'),
        btn('❌ Отклонить', `admin_deny_${ctx.chat.id}`, 'danger'),
      ])
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

    // Запрос мог устареть: проверяем, что очередь всё ещё на запрашивающем
    const currentBeforeSkip = await getCurrentWaterer();
    if (!currentBeforeSkip || currentBeforeSkip.chat_id !== targetId) {
      return ctx.answerCallbackQuery({
        text: 'Очередь уже изменилась — запрос устарел.',
        show_alert: true,
      });
    }

    await setCurrentTurn((Number(state.current_turn) + 1) % len);

    const nextUser = await getCurrentWaterer();

    await ctx.answerCallbackQuery({ text: 'Очередь передана.' });
    await ctx.editMessageText(rich(`<h3>✅ Одобрено</h3><p>Очередь передана следующему.</p>`));

    await bot.api.sendMessage(targetId, '✅ Твой запрос на пропуск одобрен. Очередь передана следующему.').catch(() => {});

    if (nextUser) {
      await sendRich(
        nextUser.chat_id,
        `<h3>🌵 Теперь твоя очередь поливать Макса!</h3>` +
        `<p><b>${esc(nextUser.name)}</b>, очередь перешла к тебе.</p>` +
        `<p>💧 Объём: ~${WATERING.waterLabel}</p>` +
        `<p>Лей медленно по краю горшка 🪴</p>` +
        wateredHtml()
      ).catch(() => {});
    }
  });

  bot.callbackQuery(/^admin_deny_(\d+)$/, async (ctx) => {
    const adminId = Number(process.env.ADMIN_CHAT_ID);
    if (ctx.chat.id !== adminId) return ctx.answerCallbackQuery();

    const targetId = Number(ctx.match[1]);

    await ctx.answerCallbackQuery({ text: 'Отклонено.' });
    await ctx.editMessageText(rich(`<h3>❌ Отклонено</h3><p>Очередь не изменена.</p>`));

    await bot.api.sendMessage(targetId, '❌ Твой запрос на пропуск отклонён администратором. Пожалуйста, полей Макса 🌵').catch(() => {});
  });
}

module.exports = { registerAdminHandlers };
