mod config;
mod constants;
mod cron;
mod db;
mod handlers;
mod helpers;
mod keyboards;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ops::ControlFlow;
use std::sync::{Arc, LazyLock};

use dptree::HandlerSignature;
use teloxide::dispatching::Dispatcher;
use teloxide::prelude::*;
use teloxide::types::{BotCommand, UpdateKind};

use crate::config::env;
use crate::handlers::UpdateHandler;

#[tokio::main]
async fn main() {

    dotenvy::dotenv().ok();

    config::logger::init();

    if env::get().admin_chat().is_none() {
        tracing::warn!("ADMIN_CHAT_ID не задан: одобрять новых пользователей будет некому");
    }

    if let Err(err) = db::pool::health_check().await {
        tracing::error!(%err, "Database connection error");
        std::process::exit(1);
    }
    tracing::info!("Database connection established");

    let bot = Bot::new(env::get().bot_api_key.clone());

    let common_commands = vec![
        BotCommand::new("start", "Запустить бота"),
        BotCommand::new("menu", "Открыть главное меню"),
        BotCommand::new("watered", "Отметить полив"),
        BotCommand::new("help", "Показать список команд"),
    ];
    bot.set_my_commands(common_commands.clone())
        .await
        .expect("Не удалось установить список команд");

    if let Some(admin_chat_id) = env::get().admin_chat() {
        let mut admin_commands = common_commands.clone();
        admin_commands.push(BotCommand::new("users", "Список пользователей (админ)"));
        if let Err(err) = bot
            .set_my_commands(admin_commands)
            .scope(teloxide::types::BotCommandScope::Chat {
                chat_id: ChatId(admin_chat_id).into(),
            })
            .await
        {
            tracing::warn!(%err, "setMyCommands for admin failed");
        }
    }

    tracing::info!("Bot started");

    cron::start();

    Dispatcher::builder(bot, build_handler())
        .enable_ctrlc_handler()
        .build()
        .dispatch()
        .await;
}

fn build_handler() -> UpdateHandler {
    catch_errors(one_update_at_a_time_per_chat(
        dptree::map_async(log_update)

            .chain(dptree::filter(|upd: Update| {
                upd.chat().is_some_and(|chat| chat.is_private())
            }))
            .chain(dptree::map_async(upsert_user_middleware))
            .branch(handlers::commands::handler())
            .branch(handlers::callbacks::handler())
            .branch(handlers::admin::handler())
            .branch(handlers::global::handler()),
    ))
}

async fn log_update(upd: Update) -> Update {
    match &upd.kind {
        UpdateKind::Message(msg) => {
            tracing::info!(
                update_id = upd.id.0,
                chat_id = msg.chat.id.0,
                text = ?msg.text(),
                "telegram update received"
            );
        }
        UpdateKind::CallbackQuery(cb) => {
            tracing::info!(
                update_id = upd.id.0,
                from_id = cb.from.id.0,
                callback_data = ?cb.data,
                "telegram callback received"
            );
        }
        _ => {}
    }
    upd
}

async fn upsert_user_middleware(upd: Update) -> Update {

    let is_start = matches!(&upd.kind, UpdateKind::Message(msg)
        if msg.text().is_some_and(|text| text.trim_start().starts_with("/start")));
    if !is_start
        && let Some(from) = upd.from()
        && let Err(err) = db::queries::upsert_user(
            from.id.0 as i64,
            Some(from.first_name.as_str()),
            from.username.as_deref(),
        )
        .await
    {
        tracing::error!(%err, "upsertUser failed");
    }
    upd
}

type ChatLock = Arc<tokio::sync::Mutex<()>>;

static CHAT_LOCKS: LazyLock<std::sync::Mutex<HashMap<ChatId, ChatLock>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

fn chat_lock(chat_id: ChatId) -> ChatLock {
    CHAT_LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(chat_id)
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn wrapper_signature() -> HandlerSignature {
    HandlerSignature::Other {
        obligations: BTreeMap::new(),
        guaranteed_outcomes: BTreeSet::new(),
        conditional_outcomes: BTreeSet::new(),
        continues: true,
    }
}

fn one_update_at_a_time_per_chat(inner: UpdateHandler) -> UpdateHandler {
    dptree::from_fn(
        |deps: DependencyMap, cont| async move {
            let chat_id = deps
                .try_get::<Update>()
                .and_then(|upd| upd.chat().map(|chat| chat.id));
            let Some(chat_id) = chat_id else {
                return cont(deps).await;
            };

            let lock = chat_lock(chat_id);
            let _guard = lock.lock().await;
            cont(deps).await
        },
        wrapper_signature(),
    )
    .chain(inner)
}

fn catch_errors(inner: UpdateHandler) -> UpdateHandler {
    dptree::from_fn(
        |deps: DependencyMap, cont| async move {
            match cont(deps.clone()).await {
                ControlFlow::Break(Err(err)) => {
                    tracing::error!(error = %err, "Error while handling update");
                    report_error(&deps).await;
                    ControlFlow::Break(Ok(()))
                }
                other => other,
            }
        },
        wrapper_signature(),
    )
    .chain(inner)
}

async fn report_error(deps: &DependencyMap) {
    const TEXT: &str = "⚠️ Что-то пошло не так. Попробуй ещё раз.";

    let (Some(update), Some(bot)) = (deps.try_get::<Update>(), deps.try_get::<Bot>()) else {
        return;
    };
    let result = match &update.kind {
        UpdateKind::CallbackQuery(cq) => bot
            .answer_callback_query(cq.id.clone())
            .text(TEXT)
            .show_alert(true)
            .send()
            .await
            .map(|_| ()),
        UpdateKind::Message(msg) if msg.chat.is_private() => {
            bot.send_message(msg.chat.id, TEXT).await.map(|_| ())
        }
        _ => Ok(()),
    };
    if let Err(err) = result {
        tracing::warn!(%err, "Не удалось сообщить пользователю об ошибке");
    }
}
