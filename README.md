# 🌵 CactusBot — Макс

> Telegram-бот для управления очередью полива офисного кактуса

![Rust](https://img.shields.io/badge/rust-1.100+-orange)
![Platform](https://img.shields.io/badge/platform-Telegram-blue)
![License](https://img.shields.io/badge/license-MIT-brightgreen)

Больше не нужно помнить, кто последний поливал Макса.
Бот сам ведёт очередь, напоминает кому и когда поливать, хранит историю и позволяет пропустить очередь через запрос к админу.

---

## ✨ Возможности

🌿 **Очередь полива:**
- Интерфейс построен на rich text кнопках (Bot API 10.x) через `sendRichMessage`
- Участники вступают и выходят из очереди через кнопки
- После каждого полива очередь автоматически ротируется
- Текущий участник видит кнопку «Пропустить очередь»

💧 **История поливов:**
- Хранит дату, время и объём каждого полива
- Последние 10 записей доступны в меню

🔔 **Автоматические напоминания:**
- Уведомление текущему участнику в день полива (каждые 14 дней), в 10:00 по Минску
- Ежедневный повтор, если полив просрочен
- Проверка каждые 30 минут: уведомление не теряется, даже если бот был недоступен в момент срока
- Повторные запросы к Bot API при rate limit (`retry_after`)

⏩ **Пропуск очереди:**
- Участник отправляет причину пропуска
- Админ одобряет или отклоняет запрос
- При одобрении очередь автоматически передаётся следующему

✅ **Управление доступом:**
- Новые пользователи проходят одобрение у админа
- Админ может выдать или забрать доступ в любой момент

---

## 📁 Структура проекта

```
project/
├── src/
│   ├── main.rs             # Точка входа: env, логи, диспетчер, middleware
│   ├── constants.rs        # Настройки полива (частота, объём и др.)
│   ├── cron.rs             # Планировщик напоминаний (каждые 30 минут)
│   ├── config/
│   │   ├── env.rs          # Переменные окружения и Config
│   │   └── logger.rs       # Логирование (tracing)
│   ├── db/
│   │   ├── pool.rs         # Пул соединений PostgreSQL
│   │   └── queries.rs      # Все запросы к базе данных
│   ├── handlers/
│   │   ├── commands.rs     # /start, /menu, /help, /users, /watered
│   │   ├── callbacks.rs    # Обработчики rich-кнопок
│   │   ├── admin.rs        # Одобрения, блокировки, пропуски очереди
│   │   └── global.rs       # Неподдерживаемые сообщения
│   ├── helpers/
│   │   ├── dates.rs        # Расчёты и формат дат в Europe/Minsk
│   │   └── rich.rs         # Rich-сообщения и rich text кнопки
│   └── keyboards.rs        # Кнопки интерфейса
└── init.sql                # Схема базы данных
```

---

## 📥 Установка

**1. Клонируй репозиторий:**
```bash
git clone https://github.com/suprunchuk/Cactus-Bot-Rust.git
cd Cactus-Bot-Rust
```

**2. Создай `.env` из примера:**
```bash
copy .env.example .env
```

На Linux/macOS:
```bash
cp .env.example .env
```

Открой `.env` и заполни значения: `BOT_API_KEY`, `ADMIN_CHAT_ID`, а также параметры БД (`POSTGRES_*`).

**3. Инициализируй базу данных:**
```bash
psql -U user -d dbname -f init.sql
```

**4. Запусти бота:**
```bash
cargo run
```

---

## Docker (рекомендуется)
Если запускаешь через `docker-compose`, достаточно:
```bash
docker compose up -d
```

---

## 🎮 Использование

1. Напиши боту `/start`
2. Дождись одобрения от админа
3. Нажми **«Участвовать в поливе»** — встанешь в конец очереди
4. Когда придёт твоя очередь — получишь уведомление с кнопкой **«Полил!»**
5. После полива очередь автоматически перейдёт к следующему

---

## 💬 Команды

| Команда | Описание |
|---|---|
| `/start` | Запустить бота |
| `/menu` | Главное меню |
| `/watered` | Отметить полив |
| `/help` | Список команд |
| `/users` | Все пользователи *(админ)* |

Одобрение/отклонение новых пользователей делается кнопками в сообщении админа.

---

## ⚙️ Как это работает?

**Логика очереди:**
```
Участник поливает
       ↓
mark_watered — поливший уходит в конец очереди
       ↓
Следующий получает уведомление
```

**Пропуск очереди:**
```
Участник нажимает «Пропустить» → пишет причину
       ↓
Админ получает запрос с кнопками [✅ Передать] [❌ Отклонить]
       ↓
При одобрении — очередь сдвигается, следующий получает уведомление
```

**Файл конфигурации `.env`:**
```env
BOT_API_KEY      # токен от @BotFather
ADMIN_CHAT_ID    # твой Telegram ID (узнать у @userinfobot)
DATABASE_URL     # строка подключения к PostgreSQL
LOG_LEVEL        # trace, debug, info, warn, error (по умолчанию: debug)

TELEGRAM_API_URL                  # адрес Bot API (по умолчанию официальный сервер)
TELEGRAM_MAX_RETRY_ATTEMPTS        # повторы Bot API при rate limit и сбоях сервера (по умолчанию: 3)
TELEGRAM_MAX_RETRY_DELAY_SECONDS   # задержка повтора, если Telegram не указал retry_after
```

---

## 🛠️ Сборка для разработчиков

Понадобится Rust 1.100+ (https://rustup.rs).

```bash
cargo run        # запустить в режиме разработки
cargo test       # unit-тесты
cargo build --release   # релизная сборка
```

---

## 📦 Стек

| Крейт | Назначение |
|---|---|
| [teloxide](https://github.com/teloxide/teloxide) | Telegram Bot framework |
| [tokio-postgres](https://github.com/sfackler/rust-postgres) | PostgreSQL клиент |
| [deadpool-postgres](https://github.com/bikeshedder/deadpool) | Пул соединений |
| [chrono](https://github.com/chronotope/chrono) / [chrono-tz](https://github.com/chronotope/chrono-tz) | Дата и таймзоны (Europe/Minsk) |
| [tracing](https://github.com/tokio-rs/tracing) | Логирование |
| [reqwest](https://github.com/seanmonstar/reqwest) | HTTP-клиент для `sendRichMessage` |

---

## 🤝 Вклад в проект

Нашли баг или есть идея для фичи?
- Откройте [Issue](https://github.com/suprunchuk/Cactus-Bot-Rust/issues)
- Сделайте Fork репозитория
- Отправьте Pull Request

---

> 🌵 Берегите Макса
