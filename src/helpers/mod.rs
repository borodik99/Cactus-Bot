pub mod dates;
pub mod rich;

use chrono::{DateTime, Utc};
use teloxide::prelude::*;

use crate::config::env;
use crate::constants::WATERING;
use crate::db::DbResult;
use crate::db::queries::{self, CurrentWaterer, User};
use crate::helpers::rich::{esc, send_rich};
use crate::keyboards::{after_watering_html, watered_html};

pub const EARLY_WATERING_LIMIT: chrono::Duration = chrono::Duration::hours(24);

pub const DOUBLE_CLICK_WINDOW: chrono::Duration = chrono::Duration::seconds(30);

pub async fn ensure_approved(bot: &Bot, chat_id: i64) -> DbResult<Option<User>> {
    let is_admin = env::get().admin_chat_id == chat_id;

    let user = queries::get_user(chat_id).await?;
    let Some(user) = user else {
        bot.send_message(ChatId(chat_id), "Сначала отправь /start")
            .await?;
        return Ok(None);
    };

    if !user.approved {
        if is_admin {
            queries::approve_user(chat_id).await?;
            return Ok(Some(User {
                approved: true,
                ..user
            }));
        }
        bot.send_message(
            ChatId(chat_id),
            "Твоя заявка на доступ к боту ещё не одобрена. Подождите, пожалуйста 🌵",
        )
        .await?;
        return Ok(None);
    }

    Ok(Some(user))
}

pub async fn is_current_waterer(chat_id: i64) -> DbResult<bool> {
    let current = queries::get_current_waterer().await?;
    Ok(current.is_some_and(|c| c.chat_id == chat_id))
}

pub async fn notify_next_waterer(
    prev_name: &str,
    next_user: Option<&CurrentWaterer>,
    next_date: Option<DateTime<Utc>>,
    skip_chat_id: i64,
) {
    let Some(next) = next_user else { return };
    if next.chat_id == skip_chat_id {
        return;
    }

    let html = format!(
        "<h3>🔔 Теперь твоя очередь!</h3>\
         <p><b>{}</b> только что полил Макса 💧</p>\
         <p>📅 Следующий полив: <b>{}</b></p>{}",
        esc(prev_name),
        dates::fmt_date(next_date),
        after_watering_html()
    );

    if let Err(err) = send_rich(next.chat_id, &html).await {
        tracing::warn!(%err, "notifyNextWaterer failed");
    }
}

pub fn first_watering_html(name: &str) -> String {
    format!(
        "<h3>🌵 Макс ждёт первого полива!</h3>\
         <p><b>{}</b>, кактус ещё ни разу не поливали через бота.</p>\
         <p>💧 Объём: ~{}</p>\
         <p>Лей медленно по краю горшка 🪴</p>{}",
        esc(name),
        WATERING.water_label,
        watered_html()
    )
}

pub fn turn_passed_html(name: &str, next_date: Option<DateTime<Utc>>) -> String {
    format!(
        "<h3>🌵 Теперь твоя очередь поливать Макса!</h3>\
         <p><b>{}</b>, очередь перешла к тебе.</p>\
         <p>📅 Следующий полив: <b>{}</b></p>\
         <p>💧 Объём: ~{}</p>\
         <p>Лей медленно по краю горшка 🪴</p>{}",
        esc(name),
        dates::fmt_date(next_date),
        WATERING.water_label,
        watered_html()
    )
}
