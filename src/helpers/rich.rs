use std::error::Error;
use std::fmt::Display;
use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{Value, json};
use teloxide::Bot;
use teloxide::payloads::AnswerCallbackQuerySetters;
use teloxide::requests::Requester;
use teloxide::types::{CallbackQuery, MaybeInaccessibleMessage};

use crate::config::env;
use crate::db::DbResult;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub fn esc(value: impl Display) -> String {
    value
        .to_string()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn btn(label: &str, data: &str) -> String {
    format!(
        "<tg-button type=\"callback_data\" data=\"{}\">{}</tg-button>",
        esc(data),
        esc(label)
    )
}

pub fn btn_styled(label: &str, data: &str, style: &str) -> String {
    format!(
        "<tg-button type=\"callback_data\" data=\"{}\" style=\"{}\">{}</tg-button>",
        esc(data),
        style,
        esc(label)
    )
}

pub fn row(buttons: &[String]) -> String {
    format!("<tg-button-row>{}</tg-button-row>", buttons.join(""))
}

pub fn row_aligned(buttons: &[String], align: &str) -> String {
    format!(
        "<tg-button-row align=\"{}\">{}</tg-button-row>",
        align,
        buttons.join("")
    )
}

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()

        .unwrap_or_else(|_| reqwest::Client::new())
});

async fn post_bot_api(
    method: &str,
    payload: Value,
) -> Result<Value, Box<dyn Error + Send + Sync>> {
    let url = format!(
        "{}/bot{}/{}",
        env::get().telegram_api_url,
        env::get().bot_api_key,
        method
    );
    let max_attempts = env::get().telegram_max_retry_attempts;
    let fallback_delay = env::get().telegram_max_retry_delay_seconds;

    let mut attempt: u32 = 0;
    loop {
        let response = HTTP.post(&url).json(&payload).send().await?;
        let status = response.status();
        let text = response.text().await?;
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);

        if body["ok"].as_bool() == Some(true) {
            return Ok(body["result"].clone());
        }

        let error = api_error(method, status, &body);
        let retry_after = body["parameters"]["retry_after"].as_u64();

        let retryable = retry_after.is_some() || status.is_server_error();
        if !retryable || attempt >= max_attempts {
            return Err(error.into());
        }

        attempt += 1;
        tracing::warn!(method, attempt, "Telegram API retry");
        tokio::time::sleep(Duration::from_secs(retry_after.unwrap_or(fallback_delay))).await;
    }
}

fn api_error(method: &str, status: reqwest::StatusCode, body: &Value) -> String {
    let description = body["description"]
        .as_str()
        .map_or_else(|| format!("HTTP {status}"), ToOwned::to_owned);
    format!("Telegram API error in {method}: {description}")
}

pub async fn send_rich(
    chat_id: i64,
    html: &str,
) -> Result<Value, Box<dyn Error + Send + Sync>> {
    post_bot_api(
        "sendRichMessage",
        json!({
            "chat_id": chat_id,
            "rich_message": { "html": html },
        }),
    )
    .await
}

pub async fn edit_rich(
    chat_id: i64,
    message_id: i64,
    html: &str,
) -> Result<Value, Box<dyn Error + Send + Sync>> {

    post_bot_api(
        "editMessageText",
        json!({
            "chat_id": chat_id,
            "message_id": message_id,
            "rich_message": { "html": html },
        }),
    )
    .await
}

pub async fn answer_callback(
    bot: &Bot,
    cq: &CallbackQuery,
    text: Option<&str>,
    alert: bool,
) -> DbResult<()> {
    let mut req = bot.answer_callback_query(cq.id.clone());
    if let Some(t) = text {
        req = req.text(t).show_alert(alert);
    }
    req.await?;
    Ok(())
}

pub fn cq_chat_id(cq: &CallbackQuery) -> Option<i64> {
    cq.message.as_ref().map(|m| match m {
        MaybeInaccessibleMessage::Regular(msg) => msg.chat.id.0,
        MaybeInaccessibleMessage::Inaccessible(msg) => msg.chat.id.0,
    })
}

pub fn cq_message_id(cq: &CallbackQuery) -> Option<i64> {
    cq.message.as_ref().and_then(|m| match m {
        MaybeInaccessibleMessage::Regular(msg) => Some(i64::from(msg.id.0)),
        MaybeInaccessibleMessage::Inaccessible(_) => None,
    })
}
