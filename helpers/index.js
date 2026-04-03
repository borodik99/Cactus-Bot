const { getUser } = require('../db/queries');
const { db } = require('../bot');

const adminId = (() => {
  const raw = process.env.ADMIN_CHAT_ID;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
})();

async function ensureApproved(ctx) {
  const isAdmin = adminId !== null && ctx.chat.id === adminId;
  const user = await getUser(ctx.chat.id);
  if (!user) {
    await ctx.reply('Сначала отправь /start');
    return null;
  }
  if (!user.approved) {
    if (isAdmin) {
      await db.query('UPDATE users SET approved = TRUE WHERE chat_id = $1', [ctx.chat.id]);
      return { ...user, approved: true };
    }
    await ctx.reply('Твоя заявка на доступ к боту ещё не одобрена. Подождите, пожалуйста 🌵');
    return null;
  }
  return user;
}

module.exports = { ensureApproved };
