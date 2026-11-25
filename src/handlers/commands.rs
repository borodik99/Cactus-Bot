use std::error::Error;

use teloxide::prelude::*;
use teloxide::utils::command::BotCommands;

use crate::config::env;
use crate::constants::WATERING;
use crate::db::queries::{self, UserListItem};
use crate::helpers::dates;
use crate::helpers::rich::{btn_styled, esc, row, send_rich};
use crate::helpers::{
    DOUBLE_CLICK_WINDOW, EARLY_WATERING_LIMIT, ensure_approved, is_current_waterer,
    notify_next_waterer,
};
use crate::keyboards::{after_watering_html, main_menu_html};

#[derive(BotCommands, Clone)]
#[command(rename_rule = "lowercase")]
pub enum Command {
    #[command(description = "Запустить бота")]
    Start,
    #[command(description = "Открыть главное меню")]
    Menu,
    #[command(description = "Отметить полив")]
    Watered,
    #[command(description = "Показать список команд")]
    Help,
    #[command(description = "Список пользователей (админ)")]
    Users,
}

pub fn handler() -> crate::handlers::UpdateHandler {
    Update::filter_message()
        .filter_command::<Command>()
        .branch(dptree::case![Command::Start].endpoint(start))
        .branch(dptree::case![Command::Menu].endpoint(menu))
        .branch(dptree::case![Command::Watered].endpoint(watered))
        .branch(dptree::case![Command::Help].endpoint(help))
        .branch(dptree::case![Command::Users].endpoint(users))
}

fn new_user_request_html(name: &str, username: Option<&str>, chat_id: i64) -> String {
    let username_html = username
        .map(|u| format!("@{}", esc(u)))
        .unwrap_or_else(|| "—".to_string());
    format!(
        "<h3>🆕 Новый пользователь</h3>\
         <p>ID: {chat_id}</p>\
         <p>Имя: <b>{}</b></p>\
         <p>Username: {username_html}</p>{}",
        esc(name),
        row(&[
            btn_styled("✅ Принять", &format!("admin_user_accept_{chat_id}"), "success"),
            btn_styled(
                "⛔ Отклонить",
                &format!("admin_user_reject_{chat_id}"),
                "danger"
            ),
        ])
    )
}

async fn start(msg: Message) -> Result<(), Box<dyn Error + Send + Sync>> {
    let chat_id = msg.chat.id.0;
    let name = msg
        .from
        .as_ref()
        .map(|u| u.first_name.clone())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Пользователь".to_string());
    let username = msg.from.as_ref().and_then(|u| u.username.clone());

    let is_new = queries::upsert_user_start(chat_id, &name, username.as_deref()).await?;
    let user = queries::get_user(chat_id)
        .await?
        .ok_or("Пользователь только что вставлен, но не найден — БД ведёт себя странно")?;

    let is_admin = env::get().admin_chat_id == chat_id;

    if is_admin && !user.approved {
        queries::approve_user(chat_id).await?;
    }

    if !user.approved && !is_admin {
        return start_pending(chat_id, &name, username.as_deref(), is_new).await;
    }

    let is_current = is_current_waterer(chat_id).await?;

    let html = format!(
        "<h3>🌵 Привет, {}!</h3>\
         <p>Я слежу за поливом кактуса <b>Макса</b> 🌵</p>\
         <p>📌 Режим полива: каждые <b>{} дней</b> (~10 рабочих)</p>\
         <p>💧 Объём: <b>{}</b></p>\
         <p>🕙 Уведомление: <b>{}</b></p>\
         <p>Нажми <b>«Участвовать в поливе»</b>, чтобы встать в очередь.</p>{}",
        esc(&name),
        WATERING.freq,
        WATERING.water_label,
        WATERING.time,
        main_menu_html(user.in_queue, is_current)
    );
    send_rich(chat_id, &html).await?;
    Ok(())
}

async fn start_pending(
    chat_id: i64,
    name: &str,
    username: Option<&str>,
    is_new: bool,
) -> Result<(), Box<dyn Error + Send + Sync>> {

    if is_new
        && let Some(admin_chat_id) = env::get().admin_chat()
        && let Err(err) =
            send_rich(admin_chat_id, &new_user_request_html(name, username, chat_id)).await
    {
        tracing::warn!(%err, "Не удалось уведомить админа о новом пользователе");
    }

    let status = if is_new {
        "Заявка отправлена админу. Как только он её одобрит, я пришлю меню."
    } else {
        "Твоя заявка ещё не одобрена. Подожди, пожалуйста 🌵"
    };
    send_rich(
        chat_id,
        &format!("<h3>🌵 Привет, {}!</h3><p>{status}</p>", esc(name)),
    )
    .await?;
    Ok(())
}

async fn menu(bot: Bot, msg: Message) -> Result<(), Box<dyn Error + Send + Sync>> {
    let chat_id = msg.chat.id.0;
    let Some(user) = ensure_approved(&bot, chat_id).await? else {
        return Ok(());
    };

    let is_current = is_current_waterer(chat_id).await?;

    let html = format!(
        "<h3>🌵 Главное меню</h3>{}",
        main_menu_html(user.in_queue, is_current)
    );
    send_rich(chat_id, &html).await?;
    Ok(())
}

async fn help(bot: Bot, msg: Message) -> Result<(), Box<dyn Error + Send + Sync>> {
    let is_admin = env::get().admin_chat_id == msg.chat.id.0;

    let mut text = "📝 Список команд бота:\n\n\
                    /start — начать работу с ботом\n\
                    /menu — главное меню\n\
                    /watered — отметить, что ты полил Макса\n\n\
                    Через кнопки в меню можно:\n\
                    • Вступить или выйти из очереди\n\
                    • Посмотреть очередь\n\
                    • Посмотреть историю поливов\n\
                    • Узнать, когда следующий полив\n"
        .to_string();

    if is_admin {
        text += "\nАдминские команды:\n\
                 /users — список пользователей\n\
                 Одобрение новых пользователей — кнопками в сообщении админа\n";
    }

    bot.send_message(msg.chat.id, text).await?;
    Ok(())
}

async fn users(bot: Bot, msg: Message) -> Result<(), Box<dyn Error + Send + Sync>> {
    if msg.chat.id.0 != env::get().admin_chat_id {
        bot.send_message(msg.chat.id, "Команда только для админа.")
            .await?;
        return Ok(());
    }

    let rows = queries::list_users().await?;
    if rows.is_empty() {
        bot.send_message(msg.chat.id, "Пользователей в базе пока нет.")
            .await?;
        return Ok(());
    }

    send_rich(msg.chat.id.0, &users_list_html(&rows)).await?;
    Ok(())
}

async fn watered(bot: Bot, msg: Message) -> Result<(), Box<dyn Error + Send + Sync>> {
    let chat_id = msg.chat.id.0;
    let Some(user) = ensure_approved(&bot, chat_id).await? else {
        return Ok(());
    };
    let now = dates::now();

    if !is_current_waterer(chat_id).await? {
        let text = if queries::watered_after(chat_id, now.naive_utc() - DOUBLE_CLICK_WINDOW)
            .await?
        {
            "✅ Уже отмечено!"
        } else {
            "⛔ Сейчас не твоя очередь поливать Макса."
        };
        bot.send_message(msg.chat.id, text).await?;
        return Ok(());
    }

    if let Some(next_date) = queries::get_next_watering_date().await?
        && next_date - now > EARLY_WATERING_LIMIT
    {
        let days_left = dates::calendar_days_diff(
            dates::calendar_date_in(now),
            dates::calendar_date_in(next_date),
        );
        bot.send_message(
            msg.chat.id,
            format!(
                "⛔ Ещё рано! Следующий полив {} (через {} {})",
                dates::fmt_date(Some(next_date)),
                days_left,
                dates::plural_days_ru(days_left)
            ),
        )
        .await?;
        return Ok(());
    }

    let ok = queries::mark_watered(chat_id, WATERING.water, now.naive_utc()).await?;
    if !ok {
        bot.send_message(msg.chat.id, "⛔ Очередь изменилась, попробуй ещё раз.")
            .await?;
        return Ok(());
    }

    let name = if user.name.is_empty() {
        msg.from
            .as_ref()
            .map(|u| u.first_name.clone())
            .unwrap_or_else(|| "Кто-то".to_string())
    } else {
        user.name.clone()
    };

    let next_user = queries::get_current_waterer().await?;
    let next_date = queries::get_next_watering_date().await?;

    let html = format!(
        "<h3>✅ Полив зафиксирован</h3>\
         <p><b>{}</b> полил Макса 💧</p>\
         <p>📅 Следующий полив: <b>{}</b></p>\
         <p>👤 Следующий: <b>{}</b></p>{}",
        esc(&name),
        dates::fmt_date(next_date),
        esc(next_user.as_ref().map(|u| u.name.as_str()).unwrap_or("—")),
        after_watering_html()
    );
    send_rich(chat_id, &html).await?;

    notify_next_waterer(&name, next_user.as_ref(), next_date, chat_id).await;
    Ok(())
}

pub fn users_list_html(rows: &[UserListItem]) -> String {
    let lines: String = rows
        .iter()
        .enumerate()
        .map(|(i, u)| {
            let approved_mark = if u.approved { "✅" } else { "⛔" };
            let queue_part = u
                .queue_position
                .filter(|_| u.in_queue)
                .map(|p| format!(", очередь #{}", p + 1))
                .unwrap_or_default();
            let uname = u
                .username
                .as_deref()
                .map(|n| format!("@{}", esc(n)))
                .unwrap_or_else(|| "—".to_string());
            format!(
                "<p>{}. <b>{}</b> ({})<br>ID: {}<br>{}{}</p>",
                i + 1,
                esc(&u.name),
                uname,
                u.chat_id,
                approved_mark,
                queue_part
            )
        })
        .collect();

    let buttons: String = rows
        .iter()
        .map(|u| {
            if u.approved {
                row(&[btn_styled(
                    &format!("⛔ Заблокировать: {}", u.name),
                    &format!("admin_user_block_{}", u.chat_id),
                    "danger",
                )])
            } else {
                row(&[btn_styled(
                    &format!("✅ Разблокировать: {}", u.name),
                    &format!("admin_user_unblock_{}", u.chat_id),
                    "success",
                )])
            }
        })
        .collect();

    format!("<h3>📋 Пользователи</h3>{lines}{buttons}")
}
