require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const cron = require('node-cron');
const { Pool } = require('pg');

const bot = new Bot(process.env.BOT_API_KEY);

// Подключение к БД
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// Настройки полива
const WATERING = {
  freq: 10,
  water: 70,
  waterLabel: '70 мл',
  time: '10:00 (каждую вторую среду)',
  name: 'Макс',
};

let wateringWeekCounter = 0;

// --- Вспомогательные функции ---

async function getUser(chatId) {
  const res = await db.query('SELECT * FROM users WHERE chat_id = $1', [chatId]);
  return res.rows[0] || null;
}

async function getQueue() {
  const res = await db.query(
    'SELECT * FROM users WHERE in_queue = TRUE ORDER BY queue_position ASC'
  );
  return res.rows;
}

async function getQueueState() {
  const res = await db.query('SELECT * FROM queue_state WHERE id = 1');
  return res.rows[0];
}

async function setCurrentTurn(turn) {
  await db.query('UPDATE queue_state SET current_turn = $1 WHERE id = 1', [turn]);
}

async function getCurrentWaterer() {
  const queue = await getQueue();
  if (queue.length === 0) return null;
  const state = await getQueueState();
  return queue[state.current_turn % queue.length] || null;
}

async function getNextWaterer() {
  const queue = await getQueue();
  if (queue.length < 2) return null;
  const state = await getQueueState();
  return queue[(state.current_turn + 1) % queue.length] || null;
}

async function getNextWateringDate() {
  const res = await db.query(
    'SELECT watered_at FROM watering_log ORDER BY watered_at DESC LIMIT 1'
  );
  if (!res.rows[0]) return null;
  
  const lastDate = new Date(res.rows[0].watered_at);
  const next = new Date(lastDate);
  next.setDate(next.getDate() + WATERING.freq); // +10 дней
  
  // Если следующая дата выпадает на выходной — сдвигаем на понедельник
  const day = next.getDay();
  if (day === 6) next.setDate(next.getDate() + 2); // суббота → понедельник
  if (day === 0) next.setDate(next.getDate() + 1); // воскресенье → понедельник
  
  next.setHours(10, 0, 0, 0);
  return next;
}

function mainKeyboard(inQueue) {
  return new InlineKeyboard()
    .text(inQueue ? '🚪 Выйти из очереди' : '🌿 Участвовать в поливе', inQueue ? 'leave_queue' : 'join_queue')
    .row()
    .text('📋 Очередь', 'show_queue')
    .text('💧 История', 'show_history')
    .row()
    .text('⏭ Следующий полив', 'show_next');
}

// --- /start ---
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

  await ctx.reply(
    `👋 Привет, *${name}*! Я слежу за поливом кактуса *Макса* 🌵\n\n` +
    `📌 Режим полива: каждые *~${WATERING.freq} рабочих дней*\n` +
    `💧 Объём: *${WATERING.waterLabel}*\n` +
    `🕙 Уведомление: *${WATERING.time}*\n\n` +
    `Нажми *«Участвовать в поливе»*, чтобы встать в очередь.`,
    { parse_mode: 'Markdown', reply_markup: mainKeyboard(user.in_queue) }
  );
});

// --- /menu ---
bot.command('menu', async (ctx) => {
  const user = await getUser(ctx.chat.id);
  await ctx.reply('🌵 Главное меню:', { reply_markup: mainKeyboard(user?.in_queue || false) });
});

// --- Вступить в очередь ---
bot.callbackQuery('join_queue', async (ctx) => {
  const chatId = ctx.chat.id;
  const user = await getUser(chatId);

  if (!user) return ctx.answerCallbackQuery({ text: 'Сначала отправь /start' });
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

  await ctx.answerCallbackQuery({ text: '✅ Ты в очереди!' });
  await ctx.editMessageText(
    `✅ *${user.name}*, ты в очереди по уходу за Максом!\n` +
    `📍 Позиция: *${position + 1}* из ${queue.length}`,
    { parse_mode: 'Markdown', reply_markup: mainKeyboard(true) }
  );

  // Если первый — сразу уведомление
  if (queue.length === 1) {
    const keyboard = new InlineKeyboard().text('✅ Полил!', 'mark_watered');
    await bot.api.sendMessage(
      chatId,
      `🌵 *${user.name}, ${WATERING.name}* ждёт первого полива!\n\n` +
      `💧 Объём: ~${WATERING.waterLabel}\n` +
      `Лей медленно по краю горшка 🪴`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
    return;
  }

  // Уведомляем остальных
  for (const u of queue) {
    if (u.chat_id !== chatId) {
      await bot.api.sendMessage(
        u.chat_id,
        `🌿 *${user.name}* присоединился к уходу за Максом!\nВсего в очереди: ${queue.length} чел.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
  }
});

// --- Выйти из очереди ---
bot.callbackQuery('leave_queue', async (ctx) => {
  const chatId = ctx.chat.id;
  const user = await getUser(chatId);

  if (!user?.in_queue) return ctx.answerCallbackQuery({ text: 'Тебя нет в очереди' });

  const leavingPosition = user.queue_position;

  await db.query(
    'UPDATE users SET in_queue = FALSE, queue_position = NULL WHERE chat_id = $1',
    [chatId]
  );

  await db.query(
    'UPDATE users SET queue_position = queue_position - 1 WHERE in_queue = TRUE AND queue_position > $1',
    [leavingPosition]
  );

  const queue = await getQueue();
  const state = await getQueueState();
  if (queue.length > 0 && state.current_turn >= queue.length) {
    await setCurrentTurn(0);
  }

  await ctx.answerCallbackQuery({ text: '👋 Ты вышел из очереди' });
  await ctx.editMessageText(
    `👋 *${user.name}*, ты вышел из очереди.\nМожешь вернуться в любое время!`,
    { parse_mode: 'Markdown', reply_markup: mainKeyboard(false) }
  );
});

// --- Показать очередь ---
bot.callbackQuery('show_queue', async (ctx) => {
  await ctx.answerCallbackQuery();
  const queue = await getQueue();

  if (queue.length === 0) {
    return ctx.reply(
      `📋 Очередь пуста.\nНажми «Участвовать в поливе», чтобы ухаживать за *${WATERING.name}*! 🌵`,
      { parse_mode: 'Markdown' }
    );
  }

  const state = await getQueueState();
  const lines = queue.map((u, i) => {
    const isCurrent = i === state.current_turn % queue.length;
    return `${isCurrent ? '💧' : `${i + 1}.`} ${u.name}${isCurrent ? ' ← сейчас' : ''}`;
  }).join('\n');

  await ctx.reply(
    `📋 *Очередь полива Макса:*\n\n${lines}`,
    { parse_mode: 'Markdown' }
  );
});

// --- Следующий полив ---
bot.callbackQuery('show_next', async (ctx) => {
  await ctx.answerCallbackQuery();
  const nextDate = await getNextWateringDate();
  const current = await getCurrentWaterer();

  if (!nextDate) {
    return ctx.reply(
      `💧 Макса ещё не поливали через бота.\n\n` +
      `📌 Режим: каждые *~${WATERING.freq} рабочих дней*\n` +
      `👤 Первым поливает: *${current?.name || 'очередь пуста'}*`,
      { parse_mode: 'Markdown' }
    );
  }

  const daysLeft = Math.ceil((nextDate - Date.now()) / 86400000);

  if (daysLeft <= 0) {
    await ctx.reply(
      `⚠️ Макса уже пора полить!\n👤 Очередь: *${current?.name || '—'}*`,
      { parse_mode: 'Markdown' }
    );
  } else {
    await ctx.reply(
      `📅 Следующий полив Макса: *${nextDate.toLocaleDateString('ru-RU')}*\n` +
      `⏳ Через: *${daysLeft} дн.*\n` +
      `💧 Польёт: *${current?.name || '—'}* (~${WATERING.waterLabel})`,
      { parse_mode: 'Markdown' }
    );
  }
});

// --- Показать историю ---
bot.callbackQuery('show_history', async (ctx) => {
  await ctx.answerCallbackQuery();

  const res = await db.query(
    `SELECT u.name, w.watered_at, w.water_ml
     FROM watering_log w
     LEFT JOIN users u ON u.id = w.user_id
     ORDER BY w.watered_at DESC LIMIT 10`
  );

  if (!res.rows.length) {
    return ctx.reply(`📋 Макса ещё не поливали. История пуста.`);
  }

  const lines = res.rows.map((e, i) => {
    const date = new Date(e.watered_at).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });
    return `${i + 1}. ${date} — ${e.name} (${e.water_ml} мл)`;
  }).join('\n');

  await ctx.reply(
    `💧 *История поливов Макса:*\n\n${lines}`,
    { parse_mode: 'Markdown' }
  );
});

// --- Кнопка "Полил!" ---
bot.callbackQuery('mark_watered', async (ctx) => {
  const chatId = ctx.chat.id;
  const user = await getUser(chatId);
  const name = user?.name || ctx.from?.first_name || 'Кто-то';

  await db.query(
    'INSERT INTO watering_log (user_id, water_ml) VALUES ($1, $2)',
    [user?.id || null, WATERING.water]
  );

  const queue = await getQueue();
  if (queue.length > 0) {
    const state = await getQueueState();
    await setCurrentTurn((state.current_turn + 1) % queue.length);
  }

  const nextUser = await getCurrentWaterer();
  const nextDate = await getNextWateringDate();
  const dateStr = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' });

  await ctx.answerCallbackQuery({ text: '✅ Отмечено!' });
  await ctx.editMessageText(
    `✅ *${name}* полил Макса в ${dateStr} 💧\n\n` +
    `📅 Следующий полив: *${nextDate?.toLocaleDateString('ru-RU') || '—'}*\n` +
    `👤 Польёт: *${nextUser?.name || '—'}*`,
    { parse_mode: 'Markdown' }
  );

  if (nextUser && nextUser.chat_id !== chatId) {
    await bot.api.sendMessage(
      nextUser.chat_id,
      `🔔 *${name}* только что полил Макса 💧\n` +
      `Готовься — следующий полив *${nextDate?.toLocaleDateString('ru-RU')}*, твоя очередь, *${nextUser.name}*! 🌵`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
});

// --- /watered — отметить полив командой ---
bot.command('watered', async (ctx) => {
  const chatId = ctx.chat.id;
  const user = await getUser(chatId);
  const name = user?.name || ctx.from?.first_name || 'Кто-то';

  await db.query(
    'INSERT INTO watering_log (user_id, water_ml) VALUES ($1, $2)',
    [user?.id || null, WATERING.water]
  );

  const queue = await getQueue();
  if (queue.length > 0) {
    const state = await getQueueState();
    await setCurrentTurn((state.current_turn + 1) % queue.length);
  }

  const nextUser = await getCurrentWaterer();
  const nextDate = await getNextWateringDate();

  await ctx.reply(
    `✅ *${name}* полил Макса 💧\n` +
    `📅 Следующий полив: *${nextDate?.toLocaleDateString('ru-RU') || '—'}*\n` +
    `👤 Следующий: *${nextUser?.name || '—'}*`,
    { parse_mode: 'Markdown' }
  );
});

// --- Cron: каждую вторую среду в 10:00 ---
cron.schedule('0 10 * * 3', async () => {
  wateringWeekCounter++;
  if (wateringWeekCounter % 2 !== 0) return;

  const current = await getCurrentWaterer();
  if (!current) return;

  const keyboard = new InlineKeyboard().text('✅ Полил!', 'mark_watered');

  await bot.api.sendMessage(
    current.chat_id,
    `🌵 *${current.name}, пора полить Макса!*\n\n` +
    `💧 Объём: ~${WATERING.waterLabel}\n` +
    `Лей медленно по краю горшка 🪴`,
    { parse_mode: 'Markdown', reply_markup: keyboard }
  );
}, { timezone: 'Europe/Minsk' });

// --- Запуск: сначала БД, потом бот ---
db.connect()
  .then(() => {
    console.log('✅ Подключение к БД успешно');
    bot.start();
    console.log(`🌵 Бот запущен! Слежу за Максом 🌵`);
  })
  .catch(err => {
    console.error('❌ Ошибка подключения к БД:', err.message);
    process.exit(1);
  });
