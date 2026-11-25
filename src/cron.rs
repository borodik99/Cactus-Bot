use std::time::Duration;

use crate::constants::WATERING;
use crate::db::DbResult;
use crate::db::queries;
use crate::helpers::dates;
use crate::helpers::first_watering_html;
use crate::helpers::rich::{esc, send_rich};
use crate::keyboards::watered_html;

pub fn start() {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30 * 60));
        loop {
            interval.tick().await;
            if let Err(err) = check_and_notify().await {
                tracing::error!(%err, "Cron error");
            }
        }
    });
}

async fn check_and_notify() -> DbResult<()> {
    let now = dates::now();

    if dates::local_hour(now) < WATERING.reminder_hour {
        return Ok(());
    }

    let Some(current) = queries::get_current_waterer().await? else {
        return Ok(());
    };

    let html = if let Some(next_date) = queries::get_next_watering_date().await? {
        if now < next_date {
            return Ok(());
        }

        let overdue_days = dates::calendar_days_diff(dates::calendar_date_in(next_date), dates::calendar_date_in(now));
        if overdue_days <= 0 {

            format!(
                "<h3>🌵 {}, пора полить Макса!</h3>\
                 <p>💧 Объём: ~{}</p>\
                 <p>Лей медленно по краю горшка 🪴</p>{}",
                esc(&current.name),
                WATERING.water_label,
                watered_html()
            )
        } else {
            let when = if overdue_days == 1 {
                "вчера".to_string()
            } else {
                format!("{} {} назад", overdue_days, dates::plural_days_ru(overdue_days))
            };
            format!(
                "<h3>⚠️ {}, Макс до сих пор не полит!</h3>\
                 <p>Плановая дата (<b>{}</b>) была {} 🌵</p>\
                 <p>💧 Объём: ~{}</p>\
                 <p>Лей медленно по краю горшка 🪴</p>{}",
                esc(&current.name),
                dates::fmt_date(Some(next_date)),
                when,
                WATERING.water_label,
                watered_html()
            )
        }
    } else {
        first_watering_html(&current.name)
    };

    if let Some(last_notified) = queries::get_last_notified_at().await?
        && dates::calendar_date_in(last_notified.and_utc()) == dates::calendar_date_in(now)
    {
        return Ok(());
    }

    send_rich(current.chat_id, &html).await?;
    queries::mark_notified_now(now.naive_utc()).await?;
    Ok(())
}
