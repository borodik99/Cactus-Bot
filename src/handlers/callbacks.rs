use std::error::Error;

use teloxide::prelude::*;

use crate::config::env;
use crate::constants::WATERING;
use crate::db::queries;
use crate::helpers::dates;
use crate::helpers::first_watering_html;
use crate::helpers::rich::{answer_callback, cq_chat_id, cq_message_id, edit_rich, esc, send_rich};
use crate::helpers::turn_passed_html;
use crate::helpers::{
    DOUBLE_CLICK_WINDOW, EARLY_WATERING_LIMIT, ensure_approved, is_current_waterer,
    notify_next_waterer,
};
use crate::keyboards::{after_watering_html, back_html, main_menu_html, watered_with_back_html};

pub fn handler() -> crate::handlers::UpdateHandler {
    Update::filter_callback_query()
        .branch(dptree::filter(data_is("join_queue")).endpoint(join_queue))
        .branch(dptree::filter(data_is("leave_queue")).endpoint(leave_queue))
        .branch(dptree::filter(data_is("show_queue")).endpoint(show_queue))
        .branch(dptree::filter(data_is("show_history")).endpoint(show_history))
        .branch(dptree::filter(data_is("show_next")).endpoint(show_next))
        .branch(dptree::filter(data_is("back_to_menu")).endpoint(back_to_menu))
        .branch(dptree::filter(data_is("mark_watered")).endpoint(mark_watered))
        .branch(dptree::filter(data_is("skip_turn")).endpoint(skip_turn))
}

fn data_is(data: &'static str) -> impl Fn(CallbackQuery) -> bool {
    move |cq: CallbackQuery| cq.data.as_deref() == Some(data)
}

async fn join_queue(bot: Bot, cq: CallbackQuery) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(chat_id) = cq_chat_id(&cq) else {
        return Ok(());
    };
    let Some(user) = ensure_approved(&bot, chat_id).await? else {
        return answer_callback(&bot, &cq, None, false).await;
    };

    if user.in_queue {
        return answer_callback(&bot, &cq, Some("Ты уже в очереди! 🌿"), false).await;
    }

    let (position, len) = queries::join_queue(chat_id).await?;
    let is_current = is_current_waterer(chat_id).await?;

    answer_callback(&bot, &cq, None, false).await?;
    if let Some(message_id) = cq_message_id(&cq) {
        edit_rich(
            chat_id,
            message_id,
            &format!(
                "<h3>✅ Ты в очереди!</h3>\
                 <p><b>{}</b>, ты в очереди по уходу за Максом!</p>\
                 <p>📍 Позиция: <b>{}</b> из {}</p>{}",
                esc(&user.name),
                position + 1,
                len,
                main_menu_html(true, is_current)
            ),
        )
        .await?;
    }

    if len == 1 {
        send_rich(chat_id, &first_watering_html(&user.name)).await?;

        queries::mark_notified_now(dates::now().naive_utc()).await?;
    }
    Ok(())
}

async fn leave_queue(bot: Bot, cq: CallbackQuery) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(chat_id) = cq_chat_id(&cq) else {
        return Ok(());
    };
    let Some(user) = ensure_approved(&bot, chat_id).await? else {
        return answer_callback(&bot, &cq, None, false).await;
    };

    if !user.in_queue {
        return answer_callback(&bot, &cq, Some("Тебя нет в очереди"), false).await;
    }

    let next_date = queries::get_next_watering_date().await?;
    if let Some(next_date) = next_date {
        let time_left = next_date - dates::now();
        if time_left < chrono::Duration::zero() {
            return answer_callback(
                &bot,
                &cq,
                Some("⛔ Макса ещё не полили! Нельзя выйти пока полив не выполнен."),
                true,
            )
            .await;
        }
        if time_left < EARLY_WATERING_LIMIT {
            return answer_callback(
                &bot,
                &cq,
                Some("⛔ До полива осталось менее 24 часов. Выйти нельзя."),
                true,
            )
            .await;
        }
    }

    queries::leave_queue(chat_id).await?;

    if user.waiting_skip_reason {
        queries::set_waiting_skip_reason(chat_id, false).await?;
    }

    answer_callback(&bot, &cq, Some("👋 Ты вышел из очереди"), false).await?;
    if let Some(message_id) = cq_message_id(&cq) {
        edit_rich(
            chat_id,
            message_id,
            &format!(
                "<h3>👋 Ты вышел из очереди</h3>\
                 <p><b>{}</b>, ты вышел из очереди.</p>\
                 <p>Можешь вернуться в любое время!</p>{}",
                esc(&user.name),
                main_menu_html(false, false)
            ),
        )
        .await?;
    }
    Ok(())
}

async fn show_queue(bot: Bot, cq: CallbackQuery) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(chat_id) = cq_chat_id(&cq) else {
        return Ok(());
    };
    if ensure_approved(&bot, chat_id).await?.is_none() {
        answer_callback(&bot, &cq, None, false).await?;
        return Ok(());
    }

    answer_callback(&bot, &cq, None, false).await?;
    let queue = queries::get_queue().await?;

    if queue.is_empty() {
        if let Some(message_id) = cq_message_id(&cq) {
            edit_rich(
                chat_id,
                message_id,
                &format!(
                    "<h3>📋 Очередь пуста</h3>\
                     <p>Нажми «Участвовать в поливе», чтобы ухаживать за <b>{}</b>! 🌵</p>{}",
                    WATERING.name,
                    back_html()
                ),
            )
            .await?;
        }
        return Ok(());
    }

    let state = queries::get_queue_state().await?;
    let current_turn = state.map(|s| s.current_turn).unwrap_or(0);
    let lines: String = queue
        .iter()
        .enumerate()
        .map(|(i, u)| {
            let is_current = i as i32 == current_turn % queue.len() as i32;
            if is_current {
                format!("<p>💧 <b>{}</b> ← сейчас</p>", esc(&u.name))
            } else {
                format!("<p>{}. {}</p>", i + 1, esc(&u.name))
            }
        })
        .collect();

    if let Some(message_id) = cq_message_id(&cq) {
        edit_rich(
            chat_id,
            message_id,
            &format!("<h3>📋 Очередь полива Макса</h3>{lines}{}", back_html()),
        )
        .await?;
    }
    Ok(())
}

async fn show_history(bot: Bot, cq: CallbackQuery) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(chat_id) = cq_chat_id(&cq) else {
        return Ok(());
    };
    if ensure_approved(&bot, chat_id).await?.is_none() {
        answer_callback(&bot, &cq, None, false).await?;
        return Ok(());
    }

    answer_callback(&bot, &cq, None, false).await?;
    let history = queries::get_watering_history().await?;

    if history.is_empty() {
        if let Some(message_id) = cq_message_id(&cq) {
            edit_rich(
                chat_id,
                message_id,
                &format!(
                    "<h3>💧 История поливов</h3>\
                     <p>Макса ещё не поливали. История пуста.</p>{}",
                    back_html()
                ),
            )
            .await?;
        }
        return Ok(());
    }

    let lines: String = history
        .iter()
        .enumerate()
        .map(|(i, e)| {
            format!(
                "<p>{}. {} — <b>{}</b> ({} мл)</p>",
                i + 1,
                dates::fmt_date_time(e.watered_at.and_utc()),
                esc(e.name.as_deref().unwrap_or("—")),
                e.water_ml
            )
        })
        .collect();

    if let Some(message_id) = cq_message_id(&cq) {
        edit_rich(
            chat_id,
            message_id,
            &format!("<h3>💧 История поливов Макса</h3>{lines}{}", back_html()),
        )
        .await?;
    }
    Ok(())
}

async fn show_next(bot: Bot, cq: CallbackQuery) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(chat_id) = cq_chat_id(&cq) else {
        return Ok(());
    };
    if ensure_approved(&bot, chat_id).await?.is_none() {
        answer_callback(&bot, &cq, None, false).await?;
        return Ok(());
    }

    answer_callback(&bot, &cq, None, false).await?;
    let next_date = queries::get_next_watering_date().await?;
    let current = queries::get_current_waterer().await?;

    let Some(next_date) = next_date else {
        if let Some(message_id) = cq_message_id(&cq) {
            edit_rich(
                chat_id,
                message_id,
                &format!(
                    "<h3>⏭ Следующий полив</h3>\
                     <p>Макса ещё не поливали через бота.</p>\
                     <p>📌 Режим: каждые <b>~{} дней</b></p>\
                     <p>👤 Первым поливает: <b>{}</b></p>{}",
                    WATERING.freq,
                    esc(current
                        .as_ref()
                        .map(|c| c.name.as_str())
                        .unwrap_or("очередь пуста")),
                    back_html()
                ),
            )
            .await?;
        }
        return Ok(());
    };

    let days_left = dates::calendar_days_diff(
        dates::calendar_date_in(dates::now()),
        dates::calendar_date_in(next_date),
    );

    let Some(message_id) = cq_message_id(&cq) else {
        return Ok(());
    };

    if days_left < 1 {
        edit_rich(
            chat_id,
            message_id,
            &format!(
                "<h3>⚠️ Макса уже пора полить!</h3>\
                 <p>👤 Очередь: <b>{}</b></p>\
                 <p>💧 Объём: ~{}</p>{}",
                esc(current.as_ref().map(|c| c.name.as_str()).unwrap_or("—")),
                WATERING.water_label,
                watered_with_back_html()
            ),
        )
        .await?;
        return Ok(());
    }

    edit_rich(
        chat_id,
        message_id,
        &format!(
            "<h3>⏭ Следующий полив Макса</h3>\
             <p>📅 Дата: <b>{}</b></p>\
             <p>⏳ Через: <b>{} {}</b></p>\
             <p>💧 Польёт: <b>{}</b> (~{})</p>{}",
            dates::fmt_date(Some(next_date)),
            days_left,
            dates::plural_days_ru(days_left),
            esc(current.as_ref().map(|c| c.name.as_str()).unwrap_or("—")),
            WATERING.water_label,
            back_html()
        ),
    )
    .await?;
    Ok(())
}

async fn back_to_menu(bot: Bot, cq: CallbackQuery) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(chat_id) = cq_chat_id(&cq) else {
        return Ok(());
    };
    let Some(user) = ensure_approved(&bot, chat_id).await? else {
        return answer_callback(&bot, &cq, None, false).await;
    };

    answer_callback(&bot, &cq, None, false).await?;
    let is_current = is_current_waterer(chat_id).await?;

    if let Some(message_id) = cq_message_id(&cq) {
        edit_rich(
            chat_id,
            message_id,
            &format!(
                "<h3>🌵 Главное меню</h3>{}",
                main_menu_html(user.in_queue, is_current)
            ),
        )
        .await?;
    }
    Ok(())
}

async fn mark_watered(bot: Bot, cq: CallbackQuery) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(chat_id) = cq_chat_id(&cq) else {
        return Ok(());
    };
    let Some(user) = ensure_approved(&bot, chat_id).await? else {
        return answer_callback(&bot, &cq, None, false).await;
    };
    let now = dates::now();

    if !is_current_waterer(chat_id).await? {

        let already =
            queries::watered_after(chat_id, now.naive_utc() - DOUBLE_CLICK_WINDOW).await?;
        let text = if already {
            "✅ Уже отмечено!"
        } else {
            "⛔ Сейчас не твоя очередь поливать Макса."
        };
        return answer_callback(&bot, &cq, Some(text), !already).await;
    }

    let next_date = queries::get_next_watering_date().await?;
    if let Some(next_date) = next_date
        && next_date - now > EARLY_WATERING_LIMIT
    {
        let days_left = dates::calendar_days_diff(
            dates::calendar_date_in(now),
            dates::calendar_date_in(next_date),
        );
        return answer_callback(
            &bot,
            &cq,
            Some(&format!(
                "⛔ Ещё рано! Следующий полив {} (через {} {})",
                dates::fmt_date(Some(next_date)),
                days_left,
                dates::plural_days_ru(days_left)
            )),
            true,
        )
        .await;
    }

    let name = if user.name.is_empty() {
        cq.from.first_name.clone()
    } else {
        user.name.clone()
    };

    let ok = queries::mark_watered(chat_id, WATERING.water, now.naive_utc()).await?;
    if !ok {
        return answer_callback(
            &bot,
            &cq,
            Some("⛔ Очередь изменилась, попробуй ещё раз."),
            true,
        )
        .await;
    }

    if user.waiting_skip_reason {
        queries::set_waiting_skip_reason(chat_id, false).await?;
    }

    let next_user = queries::get_current_waterer().await?;
    let next_date = queries::get_next_watering_date().await?;

    answer_callback(&bot, &cq, Some("✅ Отмечено!"), false).await?;
    if let Some(message_id) = cq_message_id(&cq) {
        edit_rich(
            chat_id,
            message_id,
            &format!(
                "<h3>✅ Полив зафиксирован</h3>\
                 <p><b>{}</b> полил Макса в {} 💧</p>\
                 <p>📅 Следующий полив: <b>{}</b></p>\
                 <p>👤 Польёт: <b>{}</b></p>{}",
                esc(&name),
                dates::fmt_date_time(now),
                dates::fmt_date(next_date),
                esc(next_user.as_ref().map(|u| u.name.as_str()).unwrap_or("—")),
                after_watering_html()
            ),
        )
        .await?;
    }

    notify_next_waterer(&name, next_user.as_ref(), next_date, chat_id).await;
    Ok(())
}

async fn skip_turn(bot: Bot, cq: CallbackQuery) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(chat_id) = cq_chat_id(&cq) else {
        return Ok(());
    };
    if ensure_approved(&bot, chat_id).await?.is_none() {
        answer_callback(&bot, &cq, None, false).await?;
        return Ok(());
    }

    if !is_current_waterer(chat_id).await? {
        return answer_callback(&bot, &cq, Some("Сейчас не твоя очередь."), true).await;
    }
    if queries::queue_len().await? <= 1 {
        return answer_callback(
            &bot,
            &cq,
            Some("Ты в очереди один — передавать очередь некому."),
            true,
        )
        .await;
    }

    answer_callback(&bot, &cq, None, false).await?;

    if env::get().admin_chat_id == chat_id {
        return admin_skips_own_turn(&bot, &cq, chat_id).await;
    }

    bot.send_message(
        ChatId(chat_id),
        "⏩ Напиши причину, по которой хочешь пропустить очередь.\n\
         Сообщение уйдёт админу, и он решит — передать очередь или нет.\n\n\
         Просто отправь её следующим сообщением.",
    )
    .await?;

    queries::set_waiting_skip_reason(chat_id, true).await?;
    Ok(())
}

async fn admin_skips_own_turn(
    bot: &Bot,
    cq: &CallbackQuery,
    chat_id: i64,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    queries::pass_turn(chat_id).await?;
    let next_user = queries::get_current_waterer().await?;

    answer_callback(bot, cq, Some("⏩ Очередь передана."), false).await?;
    if let Some(message_id) = cq_message_id(cq) {
        edit_rich(
            chat_id,
            message_id,
            &format!(
                "<h3>⏩ Очередь передана следующему</h3>\
                 <p>💧 Польёт: <b>{}</b></p>{}",
                esc(next_user.as_ref().map(|u| u.name.as_str()).unwrap_or("—")),
                main_menu_html(false, false)
            ),
        )
        .await?;
    }

    if let Some(next) = next_user
        && next.chat_id != chat_id
    {
        let next_date = queries::get_next_watering_date().await?;
        if let Err(err) = send_rich(next.chat_id, &turn_passed_html(&next.name, next_date)).await
        {
            tracing::warn!(%err, "notify failed");
        }
    }
    Ok(())
}
