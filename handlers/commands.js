const { db } = require('../bot');
const { WATERING } = require('../constants');
const { getUser, getCurrentWaterer, getNextWateringDate, markWatered } = require('../db/queries');
const { mainMenuHtml } = require('../keyboards');
const { ensureApproved, notifyNextWaterer } = require('../helpers');
const { esc, btn, row, sendRich } = require('../helpers/rich');
const {
  fmtDate,
  calendarDateIn,
  calendarDaysDiff,
  pluralDaysRu,
} = require('../helpers/dates');

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
    // Админу не нужна ручная модерация: выдаём доступ сразу при /start.
    // Иначе он будет оставаться approved=false до тех пор, пока не попадёт в ensureApproved().
    if (adminId && Number(adminId) === chatId && user && !user.approved) {
      await db.query('UPDATE users SET approved = TRUE WHERE chat_id = $1', [chatId]);
    }
    // Админу не нужно получать уведомление о собственной регистрации.
    if (adminId && !user.approved && Number(adminId) !== chatId) {
      await sendRich(
        adminId,
        `<h3>🆕 Новый пользователь</h3>` +
        `<p>ID: ${chatId}</p>` +
        `<p>Имя: <b>${esc(name)}</b></p>` +
        `<p>Username: ${username ? '@' + esc(username) : '—'}</p>` +
        row([
          btn('✅ Принять', `admin_user_accept_${chatId}`, 'success'),
          btn('⛔ Отклонить', `admin_user_reject_${chatId}`, 'danger'),
        ])
      ).catch(() => {});
    }

    const current = await getCurrentWaterer();
    const isCurrent = current?.chat_id === chatId;

    await sendRich(
      chatId,
      `<h3>🌵 Привет, ${esc(name)}!</h3>` +
      `<p>Я слежу за поливом кактуса <b>Макса</b> 🌵</p>` +
      `<p>📌 Режим полива: каждые <b>${WATERING.freq} дней</b> (~10 рабочих)</p>` +
      `<p>💧 Объём: <b>${WATERING.waterLabel}</b></p>` +
      `<p>🕙 Уведомление: <b>${WATERING.time}</b></p>` +
      `<p>Нажми <b>«Участвовать в поливе»</b>, чтобы встать в очередь.</p>` +
      mainMenuHtml(user.in_queue, isCurrent)
    );
  });

  bot.command('menu', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) return;

    const current = await getCurrentWaterer();
    const isCurrent = current?.chat_id === ctx.chat.id;

    await sendRich(
      ctx.chat.id,
      `<h3>🌵 Главное меню</h3>` +
      mainMenuHtml(user.in_queue || false, isCurrent)
    );
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
        'Одобрение новых пользователей — кнопками в сообщении админа\n';
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

    await sendRich(ctx.chat.id, usersListHtml(res.rows));
  });

  bot.command('watered', async (ctx) => {
    const user = await ensureApproved(ctx);
    if (!user) return;

    const currentUser = await getCurrentWaterer();

    if (!currentUser || currentUser.chat_id !== ctx.chat.id) {
      return ctx.reply('⛔ Сейчас не твоя очередь поливать Макса.');
    }

    const nextDate = await getNextWateringDate();
    if (nextDate) {
      const diffMs = nextDate.getTime() - Date.now();
      // Запрещаем ранний полив, если до даты ещё больше 24 часов.
      if (diffMs > 24 * 60 * 60 * 1000) {
        const daysLeft = calendarDaysDiff(calendarDateIn(new Date()), calendarDateIn(nextDate));
        return ctx.reply(
          `⛔ Ещё рано! Следующий полив ${fmtDate(nextDate)} (через ${daysLeft} ${pluralDaysRu(daysLeft)})`
        );
      }
    }

    const ok = await markWatered(ctx.chat.id, WATERING.water);
    if (!ok) {
      return ctx.reply('⛔ Очередь изменилась, попробуй ещё раз.').catch(() => {});
    }

    const name = user.name || ctx.from?.first_name || 'Кто-то';

    const nextUser = await getCurrentWaterer();
    const nextWateringDate = await getNextWateringDate();

    await sendRich(
      ctx.chat.id,
      `<h3>✅ Полив зафиксирован</h3>` +
      `<p><b>${esc(name)}</b> полил Макса 💧</p>` +
      `<p>📅 Следующий полив: <b>${fmtDate(nextWateringDate)}</b></p>` +
      `<p>👤 Следующий: <b>${esc(nextUser?.name || '—')}</b></p>`
    );

    // Следующий участник должен узнать, что теперь его очередь
    await notifyNextWaterer(name, nextUser, nextWateringDate, ctx.chat.id);
  });
}

// HTML-список пользователей с кнопками блокировки/разблокировки (для админа)
function usersListHtml(rows) {
  const lines = rows.map((u, i) => {
    const status = (u.approved ? '✅' : '⛔') + (u.in_queue ? `, очередь #${u.queue_position + 1}` : '');
    const uname = u.username ? '@' + esc(u.username) : '—';
    return (
      `<p>${i + 1}. <b>${esc(u.name)}</b> (${uname})<br>` +
      `ID: ${u.chat_id}<br>${status}</p>`
    );
  }).join('');

  const rowsHtml = rows.map((u) => {
    // approved=true означает "доступ разрешён" -> админ должен видеть "заблокировать".
    return u.approved
      ? row([btn(`⛔ Заблокировать: ${u.name}`, `admin_user_block_${u.chat_id}`, 'danger')])
      : row([btn(`✅ Разблокировать: ${u.name}`, `admin_user_unblock_${u.chat_id}`, 'success')]);
  }).join('');

  return `<h3>📋 Пользователи</h3>${lines}${rowsHtml}`;
}

module.exports = { registerCommands, usersListHtml };
