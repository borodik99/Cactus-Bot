// Единая часовая логика бота: все расчёты и отображение — в Европе/Минск.
// Календарная арифметика делается по UTC-полуночи дня, поэтому результат
// не зависит от часового пояса процесса Node (docker UTC, dev-машина и т.д.).

const TZ = 'Europe/Minsk';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const offsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

// Смещение TZ относительно UTC (мс) на момент date (Минск: +3ч круглый год)
function tzOffsetMs(date) {
  const parts = {};
  for (const { type, value } of offsetFormatter.formatToParts(date)) {
    parts[type] = value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

// Календарная дата мгновения в TZ: 'YYYY-MM-DD'
function calendarDateIn(date) {
  return dayFormatter.format(date);
}

// Абсолютное время hours:minutes местных часов TZ в календарный день,
// заданный как Date на полночь UTC (например, из calendarDateIn).
function atLocalTime(dayUtc, hours, minutes) {
  const probe = new Date(dayUtc.getTime());
  probe.setUTCHours(hours, minutes, 0, 0);
  return new Date(probe.getTime() - tzOffsetMs(probe));
}

// Дата для сообщений: '05.11.2026' (в TZ)
function fmtDate(date) {
  return date
    ? date.toLocaleDateString('ru-RU', { timeZone: TZ })
    : '—';
}

// Дата и время для сообщений: '05.11.2026, 10:00' (в TZ)
function fmtDateTime(date) {
  return date.toLocaleString('ru-RU', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Разница в календарных днях между 'YYYY-MM-DD' (toDay - fromDay)
function calendarDaysDiff(fromDay, toDay) {
  return Math.round(
    (Date.parse(`${toDay}T00:00:00.000Z`) -
      Date.parse(`${fromDay}T00:00:00.000Z`)) /
      86400000
  );
}

// Русская форма слова «день» для числа: 1 день, 2 дня, 5 дней…
function pluralDaysRu(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'день';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'дня';
  return 'дней';
}

module.exports = {
  TZ,
  calendarDateIn,
  atLocalTime,
  fmtDate,
  fmtDateTime,
  calendarDaysDiff,
  pluralDaysRu,
};
