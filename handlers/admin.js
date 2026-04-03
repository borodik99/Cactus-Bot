const { InlineKeyboard } = require('grammy');
const { getUser } = require('../db/queries');
const { getQueueState, setCurrentTurn, getCurrentWaterer } = require('../db/queries');
const { WATERING } = require('../constants');
const { db } = require('../bot');

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
      await ctx.editMessageText(`✅ ${targetUser.name} уже одобрен.\nID: ${targetId}`).catch(() => {});
      return;
    }

    await db.query('UPDATE users SET approved = TRUE, waiting_skip_reason = FALSE WHERE chat_id = $1', [targetId]);

    await ctx.answerCallbackQuery({ text: 'Одобрено' });
    await ctx.editMessageText(`✅ Одобрено: ${targetUser.name}\nID: ${targetId}`).catch(() => {});

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

    const leavingPosition = targetUser.in_queue ? targetUser.queue_position : null;

    await db.query(
      'UPDATE users SET approved = FALSE, in_queue = FALSE, queue_position = NULL, waiting_skip_reason = FALSE WHERE chat_id = $1',
      [targetId]
    );

    // На случай, если пользователь уже успел попасть в очередь (например, если админ отклоняет старую заявку).
    if (leavingPosition !== null && leavingPosition !== undefined) {
      await db.query(
        'UPDATE users SET queue_position = queue_position - 1 WHERE in_queue = TRUE AND queue_position > $1',
        [leavingPosition]
      );
      const lenRes = await db.query('SELECT COUNT(*)::int AS len FROM users WHERE in_queue = TRUE');
      const len = Number(lenRes.rows[0]?.len ?? 0);
      const state = await getQueueState();
      if (len > 0 && Number(state.current_turn) >= len) await setCurrentTurn(0);
    }

    await ctx.answerCallbackQuery({ text: 'Отклонено' });
    await ctx.editMessageText(`❌ Отклонено: ${targetUser.name}\nID: ${targetId}`).catch(() => {});

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
      return ctx.editMessageText('Пользователей в базе пока нет.').catch(() => {});
    }

    const lines = res.rows.map((u, i) => {
      const status = (u.approved ? '✅' : '⛔') + (u.in_queue ? `, очередь #${u.queue_position + 1}` : '');
      const uname = u.username ? '@' + u.username : '—';
      return `${i + 1}. ${u.name} (${uname})\n   ID: ${u.chat_id}\n   ${status}`;
    }).join('\n\n');

    const keyboard = new InlineKeyboard();
    for (const u of res.rows) {
      // approved=true означает "доступ разрешён", значит кнопку нужно показывать как "заблокировать".
      if (!u.approved) {
        keyboard
          .text(`✅ Разблокировать: ${u.name}`, `admin_user_unblock_${u.chat_id}`)
          .success()
          .row();
      } else {
        keyboard
          .text(`⛔ Заблокировать: ${u.name}`, `admin_user_block_${u.chat_id}`)
          .danger()
          .row();
      }
    }

    return ctx
      .editMessageText(`📋 Пользователи:\n\n${lines}`, { reply_markup: keyboard })
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

    const leavingPosition = targetUser.in_queue ? targetUser.queue_position : null;

    await db.query(
      'UPDATE users SET approved = FALSE, in_queue = FALSE, queue_position = NULL, waiting_skip_reason = FALSE WHERE chat_id = $1',
      [targetId]
    );

    if (leavingPosition !== null && leavingPosition !== undefined) {
      await db.query(
        'UPDATE users SET queue_position = queue_position - 1 WHERE in_queue = TRUE AND queue_position > $1',
        [leavingPosition]
      );

      const lenRes = await db.query('SELECT COUNT(*)::int AS len FROM users WHERE in_queue = TRUE');
      const len = Number(lenRes.rows[0]?.len ?? 0);
      const state = await getQueueState();
      const cur = Number(state.current_turn ?? 0);
      if (len <= 0) {
        await setCurrentTurn(0);
      } else {
        await setCurrentTurn(cur % len);
      }
    }

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
