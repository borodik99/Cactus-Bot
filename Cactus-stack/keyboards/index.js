const { InlineKeyboard } = require('grammy');

function mainKeyboard(inQueue, isCurrent = false) {
  const kb = new InlineKeyboard()
    .text(
      inQueue ? '🚪 Выйти из очереди' : '🌿 Участвовать в поливе',
      inQueue ? 'leave_queue' : 'join_queue'
    )
    .row()
    .text('📋 Очередь', 'show_queue')
    .text('💧 История', 'show_history')
    .row()
    .text('⏭ Следующий полив', 'show_next');

  if (inQueue && isCurrent) {
    kb.row().text('⏩ Пропустить очередь', 'skip_turn');
  }

  return kb;
}

module.exports = { mainKeyboard };
