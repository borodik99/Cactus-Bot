const { db } = require('../bot');
const { logger } = require('../config/logger');
const { WATERING } = require('../constants');

/**
 * @typedef {object} UserRow
 * @property {number} id
 * @property {number} chat_id
 * @property {string} name
 * @property {string|null} username
 * @property {boolean} approved
 * @property {boolean} in_queue
 * @property {number|null} queue_position
 * @property {boolean} waiting_skip_reason
 */

/**
 * @typedef {object} CurrentWaterer
 * @property {number} chat_id
 * @property {string} name
 */

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
    `SELECT chat_id, name
     FROM users
     WHERE in_queue = TRUE
     ORDER BY queue_position ASC
     OFFSET $1 LIMIT 1`,
    [idx]
  );

  if (!res.rows[0]) return null;
  return {
    chat_id: Number(res.rows[0].chat_id),
    name: res.rows[0].name,
  };
}

async function getNextWateringDate() {
  const res = await db.query(
    'SELECT watered_at FROM watering_log ORDER BY watered_at DESC LIMIT 1'
  );
  if (!res.rows[0]) return null;

  const lastDate = new Date(res.rows[0].watered_at);
  const next = new Date(lastDate);
  next.setDate(next.getDate() + WATERING.freq);

  const day = next.getDay();
  if (day === 6) next.setDate(next.getDate() + 2);
  if (day === 0) next.setDate(next.getDate() + 1);

  next.setUTCHours(7, 0, 0, 0); // ✅ 7 UTC = 10:00 Минск
  return next;
}

async function rotateQueue(wateredChatId) {
  const wateredId = Number(wateredChatId);

  // Транзакция делает поворот очереди устойчивым к параллельным апдейтам.
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const stateRes = await client.query(
      'SELECT current_turn FROM queue_state WHERE id = 1 FOR UPDATE'
    );
    const currentTurn = Number(stateRes.rows[0]?.current_turn ?? 0);

    const lenRes = await client.query(
      // PostgreSQL не позволяет `FOR UPDATE` вместе с агрегатами (COUNT/SUM и т.п.).
      // Нам достаточно корректно посчитать длину внутри транзакции.
      'SELECT COUNT(*)::int AS len FROM users WHERE in_queue = TRUE'
    );
    const len = Number(lenRes.rows[0]?.len ?? 0);
    if (len <= 1) {
      await client.query('COMMIT');
      return;
    }

    const idx = Number(currentTurn % len);
    const currentUserRes = await client.query(
      `SELECT chat_id, queue_position
       FROM users
       WHERE in_queue = TRUE
       ORDER BY queue_position ASC
       OFFSET $1 LIMIT 1
       FOR UPDATE`,
      [idx]
    );
    const currentUser = currentUserRes.rows[0];
    if (!currentUser || Number(currentUser.chat_id) !== wateredId) {
      await client.query('COMMIT');
      return;
    }

    const wateredPos = Number(currentUser.queue_position);

    // Сдвигаем остальных ближе к началу и отправляем полившего в конец очереди.
    await client.query(
      'UPDATE users SET queue_position = queue_position - 1 WHERE in_queue = TRUE AND queue_position > $1',
      [wateredPos]
    );
    await client.query(
      'UPDATE users SET queue_position = $1 WHERE in_queue = TRUE AND chat_id = $2',
      [len - 1, wateredId]
    );

    // Защита на случай несогласованного current_turn (например, после выходов).
    await client.query(
      'UPDATE queue_state SET current_turn = CASE WHEN current_turn >= $1 THEN 0 ELSE current_turn END WHERE id = 1',
      [len]
    );

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
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

    // Сериализуем изменения очереди через lock на queue_state.
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
    try {
      await client.query('ROLLBACK');
    } catch {}
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

    // Сериализуем изменения очереди через lock на queue_state.
    const stateRes = await client.query(
      'SELECT current_turn FROM queue_state WHERE id = 1 FOR UPDATE'
    );
    const currentTurn = Number(stateRes.rows[0]?.current_turn ?? 0);

    const leavingRes = await client.query(
      'SELECT queue_position FROM users WHERE chat_id = $1 AND in_queue = TRUE',
      [userChatId]
    );
    const leavingPosition = leavingRes.rows[0]?.queue_position;

    // Если пользователя в очереди уже нет — ничего не делаем.
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

    const nextTurn = len <= 0 ? 0 : currentTurn >= len ? 0 : currentTurn;
    await client.query('UPDATE queue_state SET current_turn = $1 WHERE id = 1', [nextTurn]);

    await client.query('COMMIT');
    logger.info({ chatId: userChatId, len }, 'queue left');
    return { len };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
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
      `SELECT chat_id, queue_position
       FROM users
       WHERE in_queue = TRUE
       ORDER BY queue_position ASC
       OFFSET $1 LIMIT 1
       FOR UPDATE`,
      [idx]
    );
    const currentUser = currentUserRes.rows[0];
    if (!currentUser || Number(currentUser.chat_id) !== wateredId) {
      await client.query('COMMIT');
      return false;
    }

    const wateredPos = Number(currentUser.queue_position);

    // Важно: вставляем в watering_log только если пользователь реально текущий.
    await client.query(
      'INSERT INTO watering_log (user_id, water_ml) VALUES ($1, $2)',
      [wateredId, waterAmount]
    );

    if (len <= 1) {
      await client.query('UPDATE queue_state SET current_turn = 0 WHERE id = 1');
      await client.query('COMMIT');
      logger.info({ chatId: wateredId, len }, 'water marked (no rotation needed)');
      return true;
    }

    // Поворот очереди: текущий участник уходит в конец.
    await client.query(
      'UPDATE users SET queue_position = queue_position - 1 WHERE in_queue = TRUE AND queue_position > $1',
      [wateredPos]
    );
    await client.query(
      'UPDATE users SET queue_position = $1 WHERE in_queue = TRUE AND chat_id = $2',
      [len - 1, wateredId]
    );

    // Защита на случай несогласованного current_turn.
    await client.query(
      'UPDATE queue_state SET current_turn = CASE WHEN current_turn >= $1 THEN 0 ELSE current_turn END WHERE id = 1',
      [len]
    );

    await client.query('COMMIT');
    logger.info({ chatId: wateredId, len }, 'water marked and queue rotated');
    return true;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getUser,
  getQueue,
  getQueueState,
  setCurrentTurn,
  getCurrentWaterer,
  getNextWateringDate,
  joinQueue,
  leaveQueue,
  markWatered,
  rotateQueue,
};
