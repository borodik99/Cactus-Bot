pub mod admin;
pub mod callbacks;
pub mod commands;
pub mod global;

pub type UpdateHandler =
    teloxide::dispatching::UpdateHandler<Box<dyn std::error::Error + Send + Sync + 'static>>;
