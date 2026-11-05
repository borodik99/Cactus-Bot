// Кнопки интерфейса — rich text buttons (Bot API 10.1+), inline-клавиатур нет.
// Каждая функция возвращает HTML <tg-button-row> для вставки в rich-сообщение.

const { btn, row } = require('../helpers/rich');

// Главное меню: вход/выход из очереди, очередь, история, дата полива
function mainMenuHtml(inQueue, isCurrent = false) {
  const rows = [
    row([
      inQueue
        ? btn('🚪 Выйти из очереди', 'leave_queue', 'danger')
        : btn('🌿 Участвовать в поливе', 'join_queue', 'success'),
    ]),
    row([
      btn('📋 Очередь', 'show_queue'),
      btn('💧 История', 'show_history'),
    ]),
    row([btn('⏭ Следующий полив', 'show_next')]),
  ];

  if (inQueue && isCurrent) {
    rows.push(row([btn('⏩ Пропустить очередь', 'skip_turn', 'primary')]));
  }

  return rows.join('');
}

// Кнопка «назад» для подэкранов (очередь/история/дата полива)
function backHtml() {
  return row([btn('◀️ Назад в меню', 'back_to_menu')]);
}

// Главная кнопка бота — отметить полив
function wateredHtml() {
  return row([btn('💧 Полил!', 'mark_watered', 'success')], 'center');
}

// Кнопка «когда полив?» для уведомлений следующему участнику
function nextWateringHtml() {
  return row([btn('⏭ Когда полив?', 'show_next')], 'center');
}

module.exports = { mainMenuHtml, backHtml, wateredHtml, nextWateringHtml };
