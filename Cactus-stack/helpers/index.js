const { getUser } = require('../db/queries');

async function ensureApproved(ctx) {
  const user = await getUser(ctx.chat.id);
  if (!user) {
    await ctx.reply('Сначала отправь /start');
    return null;
  }
  if (!user.approved) {
    await ctx.reply('Твоя заявка на доступ к боту ещё не одобрена. Подождите, пожалуйста 🌵');
    return null;
  }
  return user;
}

module.exports = { ensureApproved };
