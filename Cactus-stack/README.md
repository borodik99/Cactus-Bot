# Cactus-Bot
# 🌵 Cactus Bot — Максим

Telegram-бот для управления поливом офисного кактуса **Максима**.  
Бот следит за очередью полива, отправляет напоминания и хранит историю поливов в базе данных.

---

## 🚀 Возможности

- 📋 Очередь полива — любой сотрудник может встать в очередь
- 🔔 Автоматические уведомления — напоминание приходит только тому, чья очередь
- 💧 История поливов — хранится в PostgreSQL
- ⏭ Подсчёт следующего полива — с учётом рабочих дней
- 🔄 Чередование — после полива очередь автоматически переходит к следующему

---

## 🛠 Технологии

| Технология | Назначение |
|---|---|
| [Node.js](https://nodejs.org/) | Среда выполнения |
| [grammY](https://grammy.dev/) | Telegram Bot Framework |
| [node-cron](https://www.npmjs.com/package/node-cron) | Планировщик уведомлений |
| [pg](https://www.npmjs.com/package/pg) | Подключение к PostgreSQL |
| [PostgreSQL 15](https://www.postgresql.org/) | База данных |
| [Docker](https://www.docker.com/) | Контейнеризация |
| [pgAdmin 4](https://www.pgadmin.org/) | Управление БД |

---

## 📁 Структура проекта

cactus-bot/
├── 📄 index.js — основной код бота
├── 📄 init.sql — схема базы данных
├── 📄 Dockerfile — образ для бота
├── 📄 docker-compose.yml — конфигурация всех сервисов
├── 📄 .env — переменные окружения (не коммитить!)
├── 📄 .env.example — шаблон переменных окружения
├── 📄 .gitignore
├── 📄 package.json
└── 📁 node_modules/

text

---

## ⚙️ Установка и запуск

### 1. Клонируй репозиторий

git clone https://github.com/borodik99/Cactus-Bot.git
cd Cactus-Bot

text

### 2. Создай файл .env

cp .env.example .env

text

Заполни .env:

BOT_API_KEY=токен_от_BotFather
POSTGRES_USER=admin
POSTGRES_PASSWORD=your_password
POSTGRES_DB=cactus_bot

PGADMIN_EMAIL=admin@admin.com
PGADMIN_PASSWORD=your_password

DATABASE_URL=postgresql://admin:your_password@postgres:5432/cactus_bot

text

### 3. Запусти через Docker

docker compose up -d --build

text

### 4. Проверь логи

docker compose logs -f bot

text

Должно появиться:
✅ Подключение к БД успешно
🌵 Бот запущен! Слежу за Максимом 🌵

text

---

## 🤖 Команды бота

| Команда | Описание |
|---|---|
| /start | Регистрация и главное меню |
| /menu | Открыть главное меню |
| /watered | Отметить полив вручную |

### Кнопки меню

| Кнопка | Действие |
|---|---|
| 🌿 Участвовать в поливе | Встать в очередь |
| 🚪 Выйти из очереди | Покинуть очередь |
| 📋 Очередь | Посмотреть текущую очередь |
| 💧 История | Последние 10 поливов |
| ⏭ Следующий полив | Дата и ответственный |

---

## 💧 График полива

| Параметр | Значение |
|---|---|
| Частота | Каждые 10 рабочих дней |
| Объём воды | ~70 мл |
| Уведомление | Каждую вторую среду в 10:00 |
| Часовой пояс | Europe/Minsk |

Если дата полива выпадает на выходной — автоматически переносится на понедельник.

---

## 🗄 База данных

### Таблицы

- users — зарегистрированные пользователи и очередь
- watering_log — история всех поливов
- queue_state — текущее состояние очереди

### Управление через pgAdmin

Открой http://localhost:8080
- Email: значение PGADMIN_EMAIL из .env
- Password: значение PGADMIN_PASSWORD из .env

---

## 🐳 Docker команды

Запустить все сервисы
docker compose up -d

Пересобрать и запустить
docker compose up -d --build

Остановить
docker compose down

Остановить и удалить данные БД
docker compose down -v

Логи бота
docker compose logs -f bot

Статус контейнеров
docker compose ps

text

---

## 🌱 Советы по уходу за Максимом

- 💧 Поливай медленно по краю горшка — не лей на центр
- 🌡 Вода должна быть комнатной температуры — холодная вода вредит корням
- ☀️ Не заливай — кактус лучше переносит засуху, чем избыток влаги

---

## 👨‍💻 Автор

Максим Бородик — @borodik99