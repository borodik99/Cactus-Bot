const { db } = require('../bot');
const { bot } = require('../bot');
const { WATERING } = require('../constants');
const { getUser, getQueue, getQueueState, getCurrentWaterer, getNextWateringDate, rotateQueue } = require('../db/queries');
const { mainKeyboard } = require('../keyboards');
const { ensureApproved } = require('../helpers');

function registerCommands(bot) {

  bot.command('start', async (ctx) => {
    const chatId = ctx.chat.id;
    const name = ctx.from?.first_name || 'Пользователь';
    const username = ctx.from?.username || null;

    await db.query(
      `INSERT INTO users (chat_id, name, username)
       VALUES ($1, $2, $3)
       ON CONFLICT (chat_id) DO UPDATE SET name = $2, username = $3`,
      [chatId, name, username]
    );

    const user = await getUser(chatId);

    const adminId = process.env.ADMIN_CHAT_ID;
    if (adminId && !user.approved) {
      await bot.api.sendMessage(
        adminId,
        `🆕 Новый пользователь:\nID: ${chatId}\nИмя: ${name}\nUsername: @${username || '—'}\n\nВыдай доступ: /approve ${chatId}`
      ).catch(() => {});
    }

    const queue = await getQueue();
    const state = await getQueueState();
    const isCurrent = queue.length > 0 &&
      queue[state.current_turn % queue.length]?.chat_id === chatId;

    await ctx.reply(
      `👋 Привет, *${name}*! Я слежу за поливом кактуса *Макса* 🌵\n\n` +
      `📌 Режим полива: каждые *~${WATERING.freq} рабочих дней*\n` +
      `💧 Объём: *${WATERING.waterLabel}*\n` +
      `🕙 Уведомление: *${WATERING.time}*\n\n` +
      `Нажми *«Участвовать в поливе»*, чтобы встать в очередь.`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard(user.in_queue, isCurrent) }
    );
  });

  bot.command('menu', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) return;

    const queue = await getQueue();
    const state = await getQueueState();
    const isCurrent = queue.length > 0 &&
      queue[state.current_turn % queue.length]?.chat_id === ctx.chat.id;

    await ctx.reply('🌵 Главное меню:', {
      reply_markup: mainKeyboard(user.in_queue || false, isCurrent),
    });
  });

  bot.command('help', async (ctx) => {
    const isAdmin = Number(process.env.ADMIN_CHAT_ID) === ctx.chat.id;

    let text =
      '📝 Список команд бота:\n\n' +
      '/start — начать работу с ботом\n' +
      '/menu — главное меню\n' +
      '/watered — отметить, что ты полил Макса\n\n' +
      'Через кнопки в меню можно:\n' +
      '• Вступить или выйти из очереди\n' +
      '• Посмотреть очередь\n' +
      '• Посмотреть историю поливов\n' +
      '• Узнать, когда следующий полив\n';

    if (isAdmin) {
      text +=
        '\nАдминские команды:\n' +
        '/users — список пользователей\n' +
        '/approve 123456 — выдать доступ\n' +
        '/revoke 123456 — забрать доступ\n';
    }

    await ctx.reply(text);
  });

  bot.command('users', async (ctx) => {
    const adminId = Number(process.env.ADMIN_CHAT_ID);
    if (ctx.chat.id !== adminId) return ctx.reply('Команда только для админа.');

    const res = await db.query(
      `SELECT chat_id, name, username, approved, in_queue, queue_position
       FROM users
       ORDER BY approved DESC, in_queue DESC, queue_position NULLS LAST, chat_id ASC
       LIMIT 50`
    );

    if (!res.rows.length) return ctx.reply('Пользователей в базе пока нет.');

    const lines = res.rows.map((u, i) => {
      const status = (u.approved ? '✅' : '⛔') + (u.in_queue ? `, очередь #${u.queue_position + 1}` : '');
      const uname = u.username ? '@' + u.username : '—';
      return `${i + 1}. ${u.name} (${uname})\n   ID: ${u.chat_id}\n   ${status}`;
    }).join('\n\n');

    await ctx.reply(`📋 Пользователи:\n\n${lines}\n\n• /approve ID — выдать доступ\n• /revoke ID — забрать доступ`);
  });

  bot.command('approve', async (ctx) => {
    const adminId = Number(process.env.ADMIN_CHAT_ID);
    if (ctx.chat.id !== adminId) return ctx.reply('Команда только для админа.');

    const targetId = Number(ctx.message.text.split(' ')[1]);
    if (!targetId) return ctx.reply('Используй: /approve 123456');

    await db.query('UPDATE users SET approved = TRUE WHERE chat_id = $1', [targetId]);
    await ctx.reply(`Пользователь ${targetId} одобрен.`);
    await bot.api.sendMessage(targetId, '✅ Твоя заявка одобрена! Можешь пользоваться меню и очередью 🌵').catch(() => {});
  });

  bot.command('revoke', async (ctx) => {
    const adminId = Number(process.env.ADMIN_CHAT_ID);
    if (ctx.chat.id !== adminId) return ctx.reply('Команда только для админа.');

    const targetId = Number(ctx.message.text.split(' ')[1]);
    if (!targetId) return ctx.reply('Используй: /revoke 123456');

    await db.query(
      'UPDATE users SET approved = FALSE, in_queue = FALSE, queue_position = NULL WHERE chat_id = $1',
      [targetId]
    );
    await ctx.reply(`Доступ пользователя ${targetId} отобран.`);
    await bot.api.sendMessage(targetId, '⛔ Твой доступ к боту был отозван администратором.').catch(() => {});
  });

  bot.command('watered', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) return;

    const queue = await getQueue();
    const state = await getQueueState();
    const currentUser = queue[state.current_turn % queue.length];

    if (!currentUser || currentUser.chat_id !== ctx.chat.id) {
      return ctx.reply('⛔ Сейчас не твоя очередь поливать Макса.');
    }

    const nextDate = await getNextWateringDate();
    if (nextDate) {
      const diffMs = nextDate.getTime() - Date.now();
      // ✅ Допуск 24 часа
      if (diffMs > 24 * 60 * 60 * 1000) {
        const daysLeft = Math.floor(diffMs / 86400000);
        return ctx.reply(
          `⛔ Ещё рано! Следующий полив через *${daysLeft} дн.* (${nextDate.toLocaleDateString('ru-RU')})`,
          { parse_mode: 'Markdown' }
        );
      }
    }

    const name = user.name || ctx.from?.first_name || 'Кто-то';
    await db.query('INSERT INTO watering_log (user_id, water_ml) VALUES ($1, $2)', [user.id, WATERING.water]);
    await rotateQueue(ctx.chat.id);

    const nextUser = await getCurrentWaterer();
    const nextWateringDate = await getNextWateringDate();

    await ctx.reply(
      `✅ *${name}* полил Макса 💧\n` +
      `📅 Следующий полив: *${nextWateringDate?.toLocaleDateString('ru-RU') || '—'}*\n` +
      `👤 Следующий: *${nextUser?.name || '—'}*`,
      { parse_mode: 'Markdown' }
    );
  });
}

module.exports = { registerCommands };
