function registerGlobalMessageHandlers(bot) {
  const unsupportedText = 'Извините, я пока не умею работать с такими сообщениями';

  bot.on('message', async (ctx) => {
    if (ctx.message?.text) return;

    await ctx.reply(unsupportedText).catch(() => {});
  });
}

module.exports = { registerGlobalMessageHandlers };

