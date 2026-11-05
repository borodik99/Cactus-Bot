const { db } = require('../bot');
const { logger } = require('../config/logger');
const { WATERING } = require('../constants');
const { calendarDateIn, atLocalTime } = require('../helpers/dates');

async function upsertUser(chatId, firstName, username) {
  const userChatId = Number(chatId);
  await db.query(
    `INSERT INTO users (chat_id, name, username, approved)
     VALUES ($1, $2, $3, FALSE)
     ON CONFLICT (chat_id) DO UPDATE
       SET name     = COALESCE(EXCLUDED.name, users.name),
           username = COALESCE(EXCLUDED.username, users.username)`,
    [userChatId, firstName || null, username || null]
  );
}

async function getUser(chatId) {
  const res = await db.query('SELECT * FROM users WHERE chat_id = $1', [chatId]);
  if (!res.rows[0]) return null;
  return { ...res.rows[0], chat_id: Number(res.rows[0].chat_id) };
}

async function getQueue() {
  const res = await db.query(
    'SELECT * FROM users WHERE in_queue = TRUE ORDER BY queue_position ASC'
  );
  return res.rows.map(u => ({ ...u, chat_id: Number(u.chat_id) }));
}

async function getQueueState() {
  const res = await db.query('SELECT * FROM queue_state WHERE id = 1');
  return res.rows[0];
}

async function setCurrentTurn(turn) {
  await db.query('UPDATE queue_state SET current_turn = $1 WHERE id = 1', [turn]);
}

async function getCurrentWaterer() {
  const state = await getQueueState();
  const lenRes = await db.query(
    'SELECT COUNT(*)::int AS len FROM users WHERE in_queue = TRUE'
  );
  const len = Number(lenRes.rows[0]?.len ?? 0);
  if (len <= 0) return null;
  const idx = Number(state.current_turn % len);
  const res = await db.query(
    `SELECT chat_id, name FROM users WHERE in_queue = TRUE ORDER BY queue_position ASC OFFSET $1 LIMIT 1`,
    [idx]
  );
  if (!res.rows[0]) return null;
  return {
    chat_id: Number(res.rows[0].chat_id),
    name: res.rows[0].name,
  };
}

async function getNextWateringDate() {
  // Читаем наивный таймстемп как UTC: `AT TIME ZONE 'UTC'` вернёт timestamptz,
  // который node-pg парсит в абсолютный момент независимо от TZ процесса Node.
  const res = await db.query(
    `SELECT watered_at AT TIME ZONE 'UTC' AS watered_utc
     FROM watering_log
     ORDER BY watered_at DESC
     LIMIT 1`
  );
  if (!res.rows[0]) return null;

  // Дальше считаем по календарным дням Минска: +freq дней ко дню полива,
  // выходные (Сб/Вс) сдвигаются на понедельник, уведомление — в 10:00.
  const lastDay = calendarDateIn(new Date(res.rows[0].watered_utc));
  const day = new Date(`${lastDay}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + WATERING.freq);
  const dow = day.getUTCDay();
  if (dow === 6) day.setUTCDate(day.getUTCDate() + 2);
  else if (dow === 0) day.setUTCDate(day.getUTCDate() + 1);
  return atLocalTime(day, 10, 0);
}

// Когда последний раз cron отправлял уведомление (абсолютный момент)
async function getLastNotifiedAt() {
  const res = await db.query(
    `SELECT last_notified_at AT TIME ZONE 'UTC' AS ts
     FROM queue_state WHERE id = 1`
  );
  const ts = res.rows[0]?.ts;
  return ts ? new Date(ts) : null;
}

async function markNotifiedNow() {
  await db.query(
    `UPDATE queue_state SET last_notified_at = (now() AT TIME ZONE 'UTC') WHERE id = 1`
  );
}

async function rotateQueue(wateredChatId) {
  const wateredId = Number(wateredChatId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const stateRes = await client.query(
      'SELECT current_turn FROM queue_state WHERE id = 1 FOR UPDATE'
    );
    const currentTurn = Number(stateRes.rows[0]?.current_turn ?? 0);
    const lenRes = await client.query(
      'SELECT COUNT(*)::int AS len FROM users WHERE in_queue = TRUE'
    );
    const len = Number(lenRes.rows[0]?.len ?? 0);
    if (len <= 1) {
      await client.query('COMMIT');
      return;
    }
    const idx = Number(currentTurn % len);
    const currentUserRes = await client.query(
      `SELECT chat_id, queue_position FROM users WHERE in_queue = TRUE ORDER BY queue_position ASC OFFSET $1 LIMIT 1 FOR UPDATE`,
      [idx]
    );
    const currentUser = currentUserRes.rows[0];
    if (!currentUser || Number(currentUser.chat_id) !== wateredId) {
      await client.query('COMMIT');
      return;
    }
    const wateredPos = Number(currentUser.queue_position);
    await client.query(
      'UPDATE users SET queue_position = queue_position - 1 WHERE in_queue = TRUE AND queue_position > $1',
      [wateredPos]
    );
    await client.query(
      'UPDATE users SET queue_position = $1 WHERE in_queue = TRUE AND chat_id = $2',
      [len - 1, wateredId]
    );
    // Поливший уходит в конец, остальные сдвигаются вверх — следующий
    // оказывается на его месте. Если поливал последний — следующим становится первый.
    const nextTurn = idx === len - 1 ? 0 : idx;
    await client.query('UPDATE queue_state SET current_turn = $1 WHERE id = 1', [nextTurn]);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function joinQueue(chatId) {
  const userChatId = Number(chatId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT current_turn FROM queue_state WHERE id = 1 FOR UPDATE');
    const posRes = await client.query(
      'SELECT COALESCE(MAX(queue_position), -1) + 1 AS pos FROM users WHERE in_queue = TRUE'
    );
    const position = Number(posRes.rows[0]?.pos ?? 0);
    await client.query(
      'UPDATE users SET in_queue = TRUE, queue_position = $1 WHERE chat_id = $2',
      [position, userChatId]
    );
    const lenRes = await client.query('SELECT COUNT(*)::int AS len FROM users WHERE in_queue = TRUE');
    const len = Number(lenRes.rows[0]?.len ?? 0);
    await client.query('COMMIT');
    logger.info({ chatId: userChatId, position, len }, 'queue joined');
    return { position, len };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function leaveQueue(chatId) {
  const userChatId = Number(chatId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const stateRes = await client.query(
      'SELECT current_turn FROM queue_state WHERE id = 1 FOR UPDATE'
    );
    const currentTurn = Number(stateRes.rows[0]?.current_turn ?? 0);
    const leavingRes = await client.query(
      'SELECT queue_position FROM users WHERE chat_id = $1 AND in_queue = TRUE',
      [userChatId]
    );
    const leavingPosition = leavingRes.rows[0]?.queue_position;
    if (leavingPosition === null || leavingPosition === undefined) {
      await client.query('COMMIT');
      return { len: 0 };
    }
    await client.query('UPDATE users SET in_queue = FALSE, queue_position = NULL WHERE chat_id = $1', [userChatId]);
    await client.query(
      'UPDATE users SET queue_position = queue_position - 1 WHERE in_queue = TRUE AND queue_position > $1',
      [leavingPosition]
    );
    const lenRes = await client.query('SELECT COUNT(*)::int AS len FROM users WHERE in_queue = TRUE');
    const len = Number(lenRes.rows[0]?.len ?? 0);
    // Если вышел участник перед текущим — текущий сдвигается на позицию вверх.
    // Если вышел сам текущий последним — следующим становится первый (0).
    let nextTurn = currentTurn;
    if (Number(leavingPosition) < currentTurn) nextTurn -= 1;
    if (len <= 0 || nextTurn < 0 || nextTurn >= len) nextTurn = 0;
    await client.query('UPDATE queue_state SET current_turn = $1 WHERE id = 1', [nextTurn]);
    await client.query('COMMIT');
    logger.info({ chatId: userChatId, len }, 'queue left');
    return { len };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function markWatered(wateredChatId, waterMl) {
  const wateredId = Number(wateredChatId);
  const waterAmount = Number(waterMl);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const stateRes = await client.query(
      'SELECT current_turn FROM queue_state WHERE id = 1 FOR UPDATE'
    );
    const currentTurn = Number(stateRes.rows[0]?.current_turn ?? 0);
    const lenRes = await client.query('SELECT COUNT(*)::int AS len FROM users WHERE in_queue = TRUE');
    const len = Number(lenRes.rows[0]?.len ?? 0);
    if (len <= 0) {
      await client.query('COMMIT');
      return false;
    }
    const idx = Number(currentTurn % len);
    const currentUserRes = await client.query(
      `SELECT chat_id, queue_position, id FROM users WHERE in_queue = TRUE ORDER BY queue_position ASC OFFSET $1 LIMIT 1 FOR UPDATE`,
      [idx]
    );
    const currentUser = currentUserRes.rows[0];
    if (!currentUser || Number(currentUser.chat_id) !== wateredId) {
      await client.query('COMMIT');
      return false;
    }
    const wateredPos = Number(currentUser.queue_position);
    const userId = Number(currentUser.id); // ← используем users.id (serial)

    // Пишем время полива в UTC явно — не зависимо от таймзоны сессии Postgres
    await client.query(
      `INSERT INTO watering_log (user_id, water_ml, watered_at)
       VALUES ($1, $2, (now() AT TIME ZONE 'UTC'))`,
      [userId, waterAmount]
    );

    if (len <= 1) {
      await client.query('UPDATE queue_state SET current_turn = 0 WHERE id = 1');
      await client.query('COMMIT');
      logger.info({ chatId: wateredId, len }, 'water marked (no rotation needed)');
      return true;
    }
    await client.query(
      'UPDATE users SET queue_position = queue_position - 1 WHERE in_queue = TRUE AND queue_position > $1',
      [wateredPos]
    );
    await client.query(
      'UPDATE users SET queue_position = $1 WHERE in_queue = TRUE AND chat_id = $2',
      [len - 1, wateredId]
    );
    // Поливший уходит в конец, остальные сдвигаются вверх — следующий
    // оказывается на его месте. Если поливал последний — следующим становится первый.
    const nextTurn = idx === len - 1 ? 0 : idx;
    await client.query('UPDATE queue_state SET current_turn = $1 WHERE id = 1', [nextTurn]);
    await client.query('COMMIT');
    logger.info({ chatId: wateredId, len }, 'water marked and queue rotated');
    return true;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  upsertUser,
  getUser,
  getQueue,
  getQueueState,
  setCurrentTurn,
  getCurrentWaterer,
  getNextWateringDate,
  getLastNotifiedAt,
  markNotifiedNow,
  joinQueue,
  leaveQueue,
  markWatered,
  rotateQueue,
};