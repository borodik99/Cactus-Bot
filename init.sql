-- Пользователи
CREATE TABLE users (
    id             SERIAL PRIMARY KEY,
    chat_id        BIGINT UNIQUE NOT NULL,
    name           TEXT NOT NULL,
    username       TEXT,
    in_queue       BOOLEAN DEFAULT FALSE,
    queue_position INT,
    approved       BOOLEAN DEFAULT FALSE, 
    waiting_skip_reason  BOOLEAN DEFAULT FALSE,
    created_at     TIMESTAMP DEFAULT NOW()
);

-- История поливов
CREATE TABLE watering_log (
    id          SERIAL PRIMARY KEY,
    user_id     INT REFERENCES users(id) ON DELETE SET NULL,
    watered_at  TIMESTAMP DEFAULT NOW(),  -- когда полили
    water_ml    INT DEFAULT 70,           -- сколько мл вылито
    note        TEXT                      -- комментарий (опционально)
);

-- Настройки очереди (текущее состояние)
CREATE TABLE queue_state (
    id              INT PRIMARY KEY DEFAULT 1, -- всегда одна строка
    current_turn    INT DEFAULT 0,             -- индекс текущего в очереди
    last_notified_at TIMESTAMP,                -- когда последний раз слали уведомление
    week_counter    INT DEFAULT 0              -- счётчик сред для cron
);

-- Вставляем начальное состояние очереди
INSERT INTO queue_state (id) VALUES (1);