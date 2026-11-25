use chrono::{DateTime, Datelike, NaiveDateTime, Utc, Weekday};
use tokio_postgres::Row;

use crate::constants::WATERING;
use crate::db::DbResult;
use crate::db::pool::db;
use crate::helpers::dates;

#[derive(Debug, Clone)]
pub struct User {
    pub name: String,
    pub in_queue: bool,
    pub approved: bool,
    pub waiting_skip_reason: bool,
}

fn user_from_row(row: &Row) -> User {
    User {
        name: row.get("name"),
        in_queue: row.get("in_queue"),
        approved: row.get("approved"),
        waiting_skip_reason: row.get("waiting_skip_reason"),
    }
}

#[derive(Debug, Clone)]
pub struct QueueState {
    pub current_turn: i32,
}

#[derive(Debug, Clone)]
pub struct CurrentWaterer {
    pub chat_id: i64,
    pub name: String,
}

pub async fn upsert_user(
    chat_id: i64,
    first_name: Option<&str>,
    username: Option<&str>,
) -> DbResult<()> {
    db().get()
        .await?
        .execute(
            "INSERT INTO users (chat_id, name, username, approved)
             VALUES ($1, $2, $3, FALSE)
             ON CONFLICT (chat_id) DO UPDATE
               SET name     = COALESCE(EXCLUDED.name, users.name),
                   username = COALESCE(EXCLUDED.username, users.username)",
            &[&chat_id, &first_name, &username],
        )
        .await?;
    Ok(())
}

pub async fn get_user(chat_id: i64) -> DbResult<Option<User>> {
    let rows = db()
        .get()
        .await?
        .query("SELECT * FROM users WHERE chat_id = $1", &[&chat_id])
        .await?;
    Ok(rows.first().map(user_from_row))
}

pub async fn upsert_user_start(chat_id: i64, name: &str, username: Option<&str>) -> DbResult<bool> {
    let row = db()
        .get()
        .await?
        .query_one(
            "INSERT INTO users (chat_id, name, username)
             VALUES ($1, $2, $3)
             ON CONFLICT (chat_id) DO UPDATE SET name = $2, username = $3
             RETURNING xmax = 0 AS inserted",
            &[&chat_id, &name, &username],
        )
        .await?;
    Ok(row.get("inserted"))
}

pub async fn approve_user(chat_id: i64) -> DbResult<()> {
    db().get()
        .await?
        .execute(
            "UPDATE users SET approved = TRUE WHERE chat_id = $1",
            &[&chat_id],
        )
        .await?;
    Ok(())
}

pub async fn set_user_access(chat_id: i64, approved: bool) -> DbResult<()> {
    db().get()
        .await?
        .execute(
            "UPDATE users SET approved = $1, waiting_skip_reason = FALSE WHERE chat_id = $2",
            &[&approved, &chat_id],
        )
        .await?;
    Ok(())
}

pub async fn set_waiting_skip_reason(chat_id: i64, waiting: bool) -> DbResult<()> {
    db().get()
        .await?
        .execute(
            "UPDATE users SET waiting_skip_reason = $1 WHERE chat_id = $2",
            &[&waiting, &chat_id],
        )
        .await?;
    Ok(())
}

pub struct UserListItem {
    pub chat_id: i64,
    pub name: String,
    pub username: Option<String>,
    pub approved: bool,
    pub in_queue: bool,
    pub queue_position: Option<i32>,
}

pub async fn list_users() -> DbResult<Vec<UserListItem>> {
    let rows = db()
        .get()
        .await?
        .query(
            "SELECT chat_id, name, username, approved, in_queue, queue_position
             FROM users
             ORDER BY approved DESC, in_queue DESC, queue_position NULLS LAST, chat_id ASC
             LIMIT 50",
            &[],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| UserListItem {
            chat_id: row.get("chat_id"),
            name: row.get("name"),
            username: row.get("username"),
            approved: row.get("approved"),
            in_queue: row.get("in_queue"),
            queue_position: row.get("queue_position"),
        })
        .collect())
}

pub async fn get_queue() -> DbResult<Vec<User>> {
    let rows = db()
        .get()
        .await?
        .query(
            "SELECT * FROM users WHERE in_queue = TRUE ORDER BY queue_position ASC",
            &[],
        )
        .await?;
    Ok(rows.iter().map(user_from_row).collect())
}

pub async fn get_queue_state() -> DbResult<Option<QueueState>> {
    let rows = db()
        .get()
        .await?
        .query("SELECT * FROM queue_state WHERE id = 1", &[])
        .await?;
    Ok(rows.first().map(|row| QueueState {
        current_turn: row.get("current_turn"),
    }))
}

pub async fn queue_len() -> DbResult<i32> {
    let row = db()
        .get()
        .await?
        .query_one(
            "SELECT COUNT(*)::int AS len FROM users WHERE in_queue = TRUE",
            &[],
        )
        .await?;
    Ok(row.get("len"))
}

#[derive(Debug, Clone)]
pub struct WateringHistoryItem {
    pub name: Option<String>,
    pub watered_at: NaiveDateTime,
    pub water_ml: i32,
}

pub async fn get_watering_history() -> DbResult<Vec<WateringHistoryItem>> {
    let rows = db()
        .get()
        .await?
        .query(

            "SELECT u.name, w.watered_at, w.water_ml
             FROM watering_log w
             LEFT JOIN users u ON u.id = w.user_id
             ORDER BY w.watered_at DESC LIMIT 10",
            &[],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| WateringHistoryItem {
            name: row.get("name"),
            watered_at: row.get("watered_at"),
            water_ml: row.get("water_ml"),
        })
        .collect())
}

pub async fn get_current_waterer() -> DbResult<Option<CurrentWaterer>> {
    let client = db().get().await?;

    let current_turn: i32 = client
        .query_one("SELECT current_turn FROM queue_state WHERE id = 1", &[])
        .await?
        .get("current_turn");

    let len: i32 = client
        .query_one(
            "SELECT COUNT(*)::int AS len FROM users WHERE in_queue = TRUE",
            &[],
        )
        .await?
        .get("len");
    if len <= 0 {
        return Ok(None);
    }

    let idx = current_turn % len;
    let rows = client
        .query(
            "SELECT chat_id, name FROM users WHERE in_queue = TRUE
             ORDER BY queue_position ASC OFFSET $1 LIMIT 1",
            &[&i64::from(idx)],
        )
        .await?;

    Ok(rows.first().map(|row| CurrentWaterer {
        chat_id: row.get("chat_id"),
        name: row.get("name"),
    }))
}

pub async fn get_next_watering_date() -> DbResult<Option<DateTime<Utc>>> {
    let rows = db()
        .get()
        .await?
        .query(
            "SELECT watered_at
             FROM watering_log
             ORDER BY watered_at DESC
             LIMIT 1",
            &[],
        )
        .await?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };

    let watered_utc: NaiveDateTime = row.get("watered_at");
    let last_day = dates::calendar_date_in(watered_utc.and_utc());
    let mut day = last_day + chrono::Duration::days(WATERING.freq as i64);
    match day.weekday() {
        Weekday::Sat => day += chrono::Duration::days(2),
        Weekday::Sun => day += chrono::Duration::days(1),
        _ => {}
    }
    Ok(Some(dates::at_local_time(day, WATERING.reminder_hour, 0)))
}

pub async fn get_last_notified_at() -> DbResult<Option<NaiveDateTime>> {
    let rows = db()
        .get()
        .await?
        .query(
            "SELECT last_notified_at AS ts
             FROM queue_state WHERE id = 1",
            &[],
        )
        .await?;
    Ok(rows
        .first()
        .and_then(|row| row.get::<_, Option<NaiveDateTime>>("ts")))
}

pub async fn mark_notified_now(notified_at: NaiveDateTime) -> DbResult<()> {
    db().get()
        .await?
        .execute(
            "UPDATE queue_state SET last_notified_at = $1 WHERE id = 1",
            &[&notified_at],
        )
        .await?;
    Ok(())
}

pub async fn join_queue(chat_id: i64) -> DbResult<(i32, i32)> {
    let mut client = db().get().await?;
    let tx = client.transaction().await?;

    tx.query_one(
        "SELECT current_turn FROM queue_state WHERE id = 1 FOR UPDATE",
        &[],
    )
    .await?;

    let position: i32 = tx
        .query_one(
            "SELECT COALESCE(MAX(queue_position), -1) + 1 AS pos
             FROM users WHERE in_queue = TRUE",
            &[],
        )
        .await?
        .get("pos");

    tx.execute(
        "UPDATE users SET in_queue = TRUE, queue_position = $1 WHERE chat_id = $2",
        &[&position, &chat_id],
    )
    .await?;

    let len: i32 = tx
        .query_one(
            "SELECT COUNT(*)::int AS len FROM users WHERE in_queue = TRUE",
            &[],
        )
        .await?
        .get("len");

    tx.commit().await?;
    tracing::info!(chat_id, position, len, "queue joined");
    Ok((position, len))
}

pub async fn leave_queue(chat_id: i64) -> DbResult<i32> {
    let mut client = db().get().await?;
    let tx = client.transaction().await?;

    let current_turn = tx
        .query_opt(
            "SELECT current_turn FROM queue_state WHERE id = 1 FOR UPDATE",
            &[],
        )
        .await?
        .and_then(|row| row.get::<_, Option<i32>>("current_turn"))
        .unwrap_or(0);

    let rows = tx
        .query(
            "SELECT queue_position FROM users WHERE chat_id = $1 AND in_queue = TRUE",
            &[&chat_id],
        )
        .await?;

    let leaving_position = rows
        .first()
        .and_then(|row| row.get::<_, Option<i32>>("queue_position"));
    let Some(leaving_position) = leaving_position else {
        tx.commit().await?;
        return Ok(0);
    };

    tx.execute(
        "UPDATE users SET in_queue = FALSE, queue_position = NULL WHERE chat_id = $1",
        &[&chat_id],
    )
    .await?;
    tx.execute(
        "UPDATE users SET queue_position = queue_position - 1
         WHERE in_queue = TRUE AND queue_position > $1",
        &[&leaving_position],
    )
    .await?;

    let len: i32 = tx
        .query_one(
            "SELECT COUNT(*)::int AS len FROM users WHERE in_queue = TRUE",
            &[],
        )
        .await?
        .get("len");

    let mut next_turn = current_turn;
    if leaving_position < current_turn {
        next_turn -= 1;
    }
    if len <= 0 || next_turn < 0 || next_turn >= len {
        next_turn = 0;
    }
    tx.execute(
        "UPDATE queue_state SET current_turn = $1 WHERE id = 1",
        &[&next_turn],
    )
    .await?;

    tx.commit().await?;
    tracing::info!(chat_id, len, "queue left");
    Ok(len)
}

pub async fn mark_watered(
    watered_chat_id: i64,
    water_ml: i32,
    watered_at: NaiveDateTime,
) -> DbResult<bool> {
    let mut client = db().get().await?;
    let tx = client.transaction().await?;

    let current_turn = tx
        .query_opt(
            "SELECT current_turn FROM queue_state WHERE id = 1 FOR UPDATE",
            &[],
        )
        .await?
        .and_then(|row| row.get::<_, Option<i32>>("current_turn"))
        .unwrap_or(0);

    let len: i32 = tx
        .query_one(
            "SELECT COUNT(*)::int AS len FROM users WHERE in_queue = TRUE",
            &[],
        )
        .await?
        .get("len");
    if len <= 0 {
        tx.commit().await?;
        return Ok(false);
    }

    let idx = current_turn % len;
    let rows = tx
        .query(
            "SELECT chat_id, queue_position, id FROM users WHERE in_queue = TRUE
             ORDER BY queue_position ASC OFFSET $1 LIMIT 1 FOR UPDATE",
            &[&i64::from(idx)],
        )
        .await?;

    if rows.is_empty() || rows[0].get::<_, i64>("chat_id") != watered_chat_id {
        tx.commit().await?;
        return Ok(false);
    }

    let watered_pos: i32 = rows[0].get("queue_position");
    let user_id: i32 = rows[0].get("id");

    tx.execute(
        "INSERT INTO watering_log (user_id, water_ml, watered_at)
         VALUES ($1, $2, $3)",
        &[&user_id, &water_ml, &watered_at],
    )
    .await?;

    if len <= 1 {
        tx.execute("UPDATE queue_state SET current_turn = 0 WHERE id = 1", &[])
            .await?;
        tx.commit().await?;
        tracing::info!(
            chat_id = watered_chat_id,
            len,
            "water marked (no rotation needed)"
        );
        return Ok(true);
    }

    move_to_tail(&tx, watered_chat_id, watered_pos, len).await?;
    let next_turn = if idx == len - 1 { 0 } else { idx };
    tx.execute(
        "UPDATE queue_state SET current_turn = $1 WHERE id = 1",
        &[&next_turn],
    )
    .await?;

    tx.commit().await?;
    tracing::info!(
        chat_id = watered_chat_id,
        len,
        "water marked and queue rotated"
    );
    Ok(true)
}

pub async fn pass_turn(chat_id: i64) -> DbResult<bool> {
    let mut client = db().get().await?;
    let tx = client.transaction().await?;

    let current_turn: i32 = tx
        .query_one("SELECT current_turn FROM queue_state WHERE id = 1 FOR UPDATE", &[])
        .await?
        .get("current_turn");
    let len: i32 = tx
        .query_one(
            "SELECT COUNT(*)::int AS len FROM users WHERE in_queue = TRUE",
            &[],
        )
        .await?
        .get("len");
    if len <= 0 {
        tx.commit().await?;
        return Ok(false);
    }

    let idx = current_turn % len;
    let rows = tx
        .query(
            "SELECT chat_id, queue_position FROM users WHERE in_queue = TRUE
             ORDER BY queue_position ASC OFFSET $1 LIMIT 1 FOR UPDATE",
            &[&i64::from(idx)],
        )
        .await?;
    if rows.is_empty() || rows[0].get::<_, i64>("chat_id") != chat_id {
        tx.commit().await?;
        return Ok(false);
    }

    if len > 1 {
        let position = rows[0].get("queue_position");
        move_to_tail(&tx, chat_id, position, len).await?;
    }
    tx.commit().await?;
    tracing::info!(chat_id, len, "turn passed");
    Ok(true)
}

async fn move_to_tail(
    tx: &tokio_postgres::Transaction<'_>,
    chat_id: i64,
    position: i32,
    len: i32,
) -> DbResult<()> {
    tx.execute(
        "UPDATE users SET queue_position = queue_position - 1
         WHERE in_queue = TRUE AND queue_position > $1",
        &[&position],
    )
    .await?;
    tx.execute(
        "UPDATE users SET queue_position = $1 WHERE in_queue = TRUE AND chat_id = $2",
        &[&(len - 1), &chat_id],
    )
    .await?;
    Ok(())
}

pub async fn watered_after(chat_id: i64, since: NaiveDateTime) -> DbResult<bool> {
    let row = db()
        .get()
        .await?
        .query_one(
            "SELECT EXISTS (
                 SELECT 1 FROM watering_log w
                 JOIN users u ON u.id = w.user_id
                 WHERE u.chat_id = $1 AND w.watered_at >= $2
             ) AS watered",
            &[&chat_id, &since],
        )
        .await?;
    Ok(row.get("watered"))
}
