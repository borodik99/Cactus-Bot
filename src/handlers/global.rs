use std::error::Error;

use teloxide::prelude::*;

pub fn handler() -> crate::handlers::UpdateHandler {
    Update::filter_message()
        .branch(dptree::filter(|msg: Message| msg.text().is_none()).endpoint(reply_unsupported))
        .branch(dptree::filter(|msg: Message| msg.text().is_some()).endpoint(ignore_text))
        .chain(
            Update::filter_callback_query()
                .branch(dptree::filter(|_cq: CallbackQuery| true).endpoint(ignore_callback)),
        )
        .chain(dptree::endpoint(ignore_other))
}

async fn reply_unsupported(bot: Bot, msg: Message) -> Result<(), Box<dyn Error + Send + Sync>> {
    bot.send_message(
        msg.chat.id,
        "Извините, я пока не умею работать с такими сообщениями",
    )
    .await?;
    Ok(())
}

async fn ignore_text(_msg: Message) -> Result<(), Box<dyn Error + Send + Sync>> {
    Ok(())
}

async fn ignore_callback(_cq: CallbackQuery) -> Result<(), Box<dyn Error + Send + Sync>> {
    Ok(())
}

async fn ignore_other(_upd: Update) -> Result<(), Box<dyn Error + Send + Sync>> {
    Ok(())
}
