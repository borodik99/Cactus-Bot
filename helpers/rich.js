// Конструкторы rich-сообщений (Bot API 10.1+, полноценно — в 10.3).
// Вместо sendMessage + InlineKeyboardMarkup используем sendRichMessage
// с HTML-разметкой и rich text кнопками (<tg-button>).
// Нажатия кнопок с callback_data приходят обычными callback_query,
// поэтому логика хендлеров не меняется.

const { bot } = require('../bot');

// Экранирование пользовательского текста для HTML
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Rich-кнопка с callback_data.
// style: 'success' (зелёная) | 'danger' (красная) | 'primary' (синяя) | 'link'
function btn(label, data, style) {
  const styleAttr = style ? ` style="${style}"` : '';
  return `<tg-button type="callback_data" data="${esc(data)}"${styleAttr}>${label}</tg-button>`;
}

// Ряд из 1-8 кнопок; align: 'left' | 'center' | 'right'
function row(buttons, align) {
  const alignAttr = align ? ` align="${align}"` : '';
  return `<tg-button-row${alignAttr}>${buttons.join('')}</tg-button-row>`;
}

// InputRichMessage из HTML-строки
function rich(html) {
  return { html };
}

// Отправка rich-сообщения (замена sendMessage с inline-клавиатурой)
async function sendRich(chatId, html, other = {}) {
  return bot.api.sendRichMessage(chatId, rich(html), other);
}

module.exports = { esc, btn, row, rich, sendRich };
