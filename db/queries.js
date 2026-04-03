const { db } = require('../bot');
const { WATERING } = require('../constants');

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
  const queue = await getQueue();
  if (queue.length === 0) return null;
  const state = await getQueueState();
  return queue[state.current_turn % queue.length] || null;
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
  const queue = await getQueue();
  if (queue.length <= 1) return;

  const state = await getQueueState();
  const currentIndex = state.current_turn % queue.length;
  const currentUser = queue[currentIndex];

  if (!currentUser || currentUser.chat_id !== wateredChatId) return;

  await db.query(
    'UPDATE users SET queue_position = queue_position - 1 WHERE in_queue = TRUE AND queue_position > $1',
    [currentUser.queue_position]
  );

  const res = await db.query(
    'SELECT MAX(queue_position) AS max FROM users WHERE in_queue = TRUE'
  );
  const lastPos = res.rows[0].max ?? 0;

  await db.query(
    'UPDATE users SET queue_position = $1 WHERE chat_id = $2',
    [lastPos + 1, wateredChatId]
  );

  const newQueue = await getQueue();
  if (state.current_turn >= newQueue.length) {
    await setCurrentTurn(0);
  }
}

module.exports = {
  getUser,
  getQueue,
  getQueueState,
  setCurrentTurn,
  getCurrentWaterer,
  getNextWateringDate,
  rotateQueue,
};
