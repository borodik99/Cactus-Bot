use std::error::Error;

use teloxide::prelude::*;

use crate::config::env;
use crate::db::DbResult;
use crate::db::queries;
use crate::handlers::commands::users_list_html;
use crate::helpers::is_current_waterer;
use crate::helpers::rich::{
    answer_callback, btn_styled, cq_chat_id, cq_message_id, edit_rich, esc, row, send_rich,
};
use crate::helpers::turn_passed_html;
use crate::keyboards::main_menu_html;

pub fn handler() -> crate::handlers::UpdateHandler {
    callback_handler().chain(message_handler())
}

fn callback_handler() -> crate::handlers::UpdateHandler {
    Update::filter_callback_query()
        .branch(dptree::filter(prefix_is("admin_user_accept_")).endpoint(accept_user))
        .branch(dptree::filter(prefix_is("admin_user_reject_")).endpoint(reject_user))
        .branch(dptree::filter(prefix_is("admin_user_block_")).endpoint(block_user))
        .branch(dptree::filter(prefix_is("admin_user_unblock_")).endpoint(unblock_user))
        .branch(dptree::filter(prefix_is("admin_skip_")).endpoint(skip_approve))
        .branch(dptree::filter(prefix_is("admin_deny_")).endpoint(skip_deny))
}

fn message_handler() -> crate::handlers::UpdateHandler {

    Update::filter_message()
        .filter(|msg: Message| msg.text().is_some())
        .endpoint(skip_reason)
}

fn prefix_is(prefix: &'static str) -> impl Fn(CallbackQuery) -> bool {
    move |cq: CallbackQuery| cq.data.as_deref().is_some_and(|d| d.starts_with(prefix))
}

fn parse_target(cq: &CallbackQuery, prefix: &str) -> Option<i64> {
    cq.data.as_deref()?.strip_prefix(prefix)?.parse().ok()
}

async fn require_admin(
    bot: &Bot,
    cq: &CallbackQuery,
    chat_id: i64,
) -> Result<bool, Box<dyn Error + Send + Sync>> {
    if chat_id != env::get().admin_chat_id {
        answer_callback(bot, cq, Some("Недостаточно прав"), true).await?;
        return Ok(false);
    }
    Ok(true)
}

async fn require_admin_silent(
    bot: &Bot,
    cq: &CallbackQuery,
    chat_id: i64,
) -> Result<bool, Box<dyn Error + Send + Sync>> {
    if chat_id != env::get().admin_chat_id {
        answer_callback(bot, cq, None, false).await?;
        return Ok(false);
    }
    Ok(true)
}

async fn notify_access_granted(target_id: i64, title: &str) {
    let html = match access_granted_html(target_id, title).await {
        Ok(Some(html)) => html,
        Ok(None) => return,
        Err(err) => {
            tracing::warn!(%err, "notify failed");
            return;
        }
    };

    if let Err(err) = send_rich(target_id, &html).await {
        tracing::warn!(%err, "notify failed");
    }
}

async fn access_granted_html(target_id: i64, title: &str) -> DbResult<Option<String>> {
    let Some(target) = queries::get_user(target_id).await? else {
        return Ok(None);
    };

    let is_current = is_current_waterer(target_id).await?;
    Ok(Some(format!(
        "<h3>{title}</h3><p>Можешь пользоваться меню и очередью 🌵</p>{}",
        main_menu_html(target.in_queue, is_current)
    )))
}

async fn accept_user(bot: Bot, cq: CallbackQuery) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(chat_id) = cq_chat_id(&cq) else {
        return Ok(());
    };
    if !require_admin(&bot, &cq, chat_id).await? {
        return Ok(());
    }
    let Some(target_id) = parse_target(&cq, "admin_user_accept_") else {
        return Ok(());
    };

    let Some(target) = queries::get_user(target_id).await? else {
        return answer_callback(&bot, &cq, Some("Пользователь не найден"), true).await;
    };

    if target.approved {
        answer_callback(&bot, &cq, Some("Уже одобрен"), false).await?;
        edit_or_warn(
            &cq,
            chat_id,
            &format!(
                "<h3>✅ Уже одобрен</h3><p><b>{}</b><br>ID: {}</p>",
                esc(&target.name),
                target_id
            ),
        )
        .await;
        return Ok(());
    }

    queries::set_user_access(target_id, true).await?;

    answer_callback(&bot, &cq, Some("Одобрено"), false).await?;
    edit_or_warn(
        &cq,
        chat_id,
        &format!(
            "<h3>✅ Одобрен</h3><p><b>{}</b><br>ID: {}</p>",
            esc(&target.name),
            target_id
        ),
    )
    .await;

    notify_access_granted(target_id, "✅ Твоя заявка одобрена!").await;
    Ok(())
}

async fn reject_user(bot: Bot, cq: CallbackQuery) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(chat_id) = cq_chat_id(&cq) else {
        return Ok(());
    };
    if !require_admin(&bot, &cq, chat_id).await? {
        return Ok(());
    }
    let Some(target_id) = parse_target(&cq, "admin_user_reject_") else {
        return Ok(());
    };

    let Some(target) = queries::get_user(target_id).await? else {
        return answer_callback(&bot, &cq, Some("Пользователь не найден"), true).await;
    };

    queries::leave_queue(target_id).await?;
    queries::set_user_access(target_id, false).await?;

    answer_callback(&bot, &cq, Some("Отклонено"), false).await?;
    edit_or_warn(
        &cq,
        chat_id,
        &format!(
            "<h3>❌ Отклонён</h3><p><b>{}</b><br>ID: {}</p>",
            esc(&target.name),
            target_id
        ),
    )
    .await;

    if let Err(err) = bot
        .send_message(
            ChatId(target_id),
            "⛔ Твой доступ к боту отклонён администратором. Пожалуйста, попробуй позже 🌵",
        )
        .await
    {
        tracing::warn!(%err, "notify failed");
    }
    Ok(())
}

async fn render_users_inline(cq: &CallbackQuery) {
    let (Some(chat_id), Some(message_id)) = (cq_chat_id(cq), cq_message_id(cq)) else {
        return;
    };

    let result = match queries::list_users().await {
        Ok(rows) if rows.is_empty() => {
            edit_rich(
                chat_id,
                message_id,
                "<h3>📋 Пользователи</h3><p>Пользователей в базе пока нет.</p>",
            )
            .await
        }
        Ok(rows) => edit_rich(chat_id, message_id, &users_list_html(&rows)).await,
        Err(err) => {
            tracing::error!(%err, "list_users failed");
            return;
        }
    };
    if let Err(err) = result {
        tracing::warn!(%err, "edit users list failed");
    }
}

async fn block_user(bot: Bot, cq: CallbackQuery) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(chat_id) = cq_chat_id(&cq) else {
        return Ok(());
    };
    if !require_admin(&bot, &cq, chat_id).await? {
        return Ok(());
    }
    let Some(target_id) = parse_target(&cq, "admin_user_block_") else {
        return Ok(());
    };

    if queries::get_user(target_id).await?.is_none() {
        return answer_callback(&bot, &cq, Some("Пользователь не найден"), true).await;
    }

    queries::leave_queue(target_id).await?;
    queries::set_user_access(target_id, false).await?;

    answer_callback(&bot, &cq, Some("Пользователь заблокирован"), false).await?;
    render_users_inline(&cq).await;

    if let Err(err) = bot
        .send_message(
            ChatId(target_id),
            "⛔ Твой доступ к боту заблокирован администратором. 🌵",
        )
        .await
    {
        tracing::warn!(%err, "notify failed");
    }
    Ok(())
}

async fn unblock_user(bot: Bot, cq: CallbackQuery) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(chat_id) = cq_chat_id(&cq) else {
        return Ok(());
    };
    if !require_admin(&bot, &cq, chat_id).await? {
        return Ok(());
    }
    let Some(target_id) = parse_target(&cq, "admin_user_unblock_") else {
        return Ok(());
    };

    if queries::get_user(target_id).await?.is_none() {
        return answer_callback(&bot, &cq, Some("Пользователь не найден"), true).await;
    }

    queries::set_user_access(target_id, true).await?;

    answer_callback(&bot, &cq, Some("Пользователь разблокирован"), false).await?;
    render_users_inline(&cq).await;

    notify_access_granted(target_id, "✅ Доступ к боту восстановлен!").await;
    Ok(())
}

async fn skip_approve(bot: Bot, cq: CallbackQuery) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(chat_id) = cq_chat_id(&cq) else {
        return Ok(());
    };
    if !require_admin_silent(&bot, &cq, chat_id).await? {
        return Ok(());
    }
    let Some(target_id) = parse_target(&cq, "admin_skip_") else {
        return Ok(());
    };

    const STALE: &str = "Очередь уже изменилась — запрос устарел.";
    if !is_current_waterer(target_id).await? {
        return answer_callback(&bot, &cq, Some(STALE), true).await;
    }

    if !queries::pass_turn(target_id).await? {
        return answer_callback(&bot, &cq, Some(STALE), true).await;
    }

    let next_user = queries::get_current_waterer().await?;

    answer_callback(&bot, &cq, Some("Очередь передана."), false).await?;
    edit_or_warn(
        &cq,
        chat_id,
        "<h3>✅ Одобрено</h3><p>Очередь передана следующему.</p>",
    )
    .await;

    if let Err(err) = bot
        .send_message(
            ChatId(target_id),
            "✅ Твой запрос на пропуск одобрен. Очередь передана следующему.",
        )
        .await
    {
        tracing::warn!(%err, "notify failed");
    }

    if let Some(next) = next_user
        && next.chat_id != target_id
    {
        let next_date = queries::get_next_watering_date().await?;
        if let Err(err) = send_rich(next.chat_id, &turn_passed_html(&next.name, next_date)).await
        {
            tracing::warn!(%err, "notify failed");
        }
    }
    Ok(())
}

async fn skip_deny(bot: Bot, cq: CallbackQuery) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(chat_id) = cq_chat_id(&cq) else {
        return Ok(());
    };
    if !require_admin_silent(&bot, &cq, chat_id).await? {
        return Ok(());
    }
    let Some(target_id) = parse_target(&cq, "admin_deny_") else {
        return Ok(());
    };

    answer_callback(&bot, &cq, Some("Отклонено."), false).await?;
    edit_or_warn(
        &cq,
        chat_id,
        "<h3>❌ Отклонено</h3><p>Очередь не изменена.</p>",
    )
    .await;

    if let Err(err) = bot
        .send_message(
            ChatId(target_id),
            "❌ Твой запрос на пропуск отклонён администратором. Пожалуйста, полей Макса 🌵",
        )
        .await
    {
        tracing::warn!(%err, "notify failed");
    }
    Ok(())
}

async fn skip_reason(bot: Bot, msg: Message) -> Result<(), Box<dyn Error + Send + Sync>> {
    let chat_id = msg.chat.id.0;

    let Some(user) = queries::get_user(chat_id).await? else {
        return Ok(());
    };
    if !user.waiting_skip_reason {
        return Ok(());
    }
    let Some(reason) = msg.text().map(str::trim) else {
        return Ok(());
    };
    queries::set_waiting_skip_reason(chat_id, false).await?;

    if let Err(err) = bot
        .set_message_reaction(msg.chat.id, msg.id)
        .reaction(vec![teloxide::types::ReactionType::Emoji {
            emoji: "👍".to_string(),
        }])
        .await
    {
        tracing::warn!(%err, "react failed");
    }

    let Some(admin_chat_id) = env::get().admin_chat() else {
        return Ok(());
    };

    let html = format!(
        "<h3>⏩ Запрос на пропуск очереди</h3>\
         <p>Имя: <b>{}</b><br>ID: {}</p>\
         <p>Причина: {}</p>{}",
        esc(&user.name),
        chat_id,
        esc(reason),
        row(&[
            btn_styled(
                "✅ Передать очередь",
                &format!("admin_skip_{chat_id}"),
                "success"
            ),
            btn_styled("❌ Отклонить", &format!("admin_deny_{chat_id}"), "danger"),
        ])
    );
    if let Err(err) = send_rich(admin_chat_id, &html).await {
        tracing::warn!(%err, "Не удалось отправить запрос админу");
    }

    bot.send_message(msg.chat.id, "✅ Запрос отправлен админу. Ожидай решения.")
        .await?;
    Ok(())
}

async fn edit_or_warn(cq: &CallbackQuery, chat_id: i64, html: &str) {
    if let Some(message_id) = cq_message_id(cq)
        && let Err(err) = edit_rich(chat_id, message_id, html).await
    {
        tracing::warn!(%err, "edit failed");
    }
}
