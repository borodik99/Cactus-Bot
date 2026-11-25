use std::env;
use std::sync::LazyLock;

pub fn require_env(name: &str) -> String {
    match env::var(name) {
        Ok(value) if !value.is_empty() => value,
        _ => panic!(
            "Missing required environment variable: {name}. \
             Create a .env file (copy from .env.example) and set it."
        ),
    }
}

pub fn require_env_number(name: &str) -> i64 {
    let raw = require_env(name);
    raw.parse()
        .unwrap_or_else(|_| panic!("Environment variable {name} must be a number, got: {raw}"))
}

fn env_number_or<T>(name: &str, default: T) -> T
where
    T: std::str::FromStr,
{
    env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

#[derive(Debug)]
pub struct Config {
    pub bot_api_key: String,
    pub admin_chat_id: i64,
    pub database_url: String,
    pub log_level: String,
    pub telegram_api_url: String,
    pub telegram_max_retry_attempts: u32,
    pub telegram_max_retry_delay_seconds: u64,
}

impl Config {
    fn from_env() -> Self {
        Self {
            bot_api_key: require_env("BOT_API_KEY"),
            admin_chat_id: require_env_number("ADMIN_CHAT_ID"),
            database_url: require_env("DATABASE_URL"),
            log_level: env::var("LOG_LEVEL").unwrap_or_else(|_| "debug".to_string()),
            telegram_api_url: env::var("TELEGRAM_API_URL")
                .ok()
                .filter(|url| !url.is_empty())
                .unwrap_or_else(|| "https://api.telegram.org".to_string())
                .trim_end_matches('/')
                .to_string(),
            telegram_max_retry_attempts: env_number_or("TELEGRAM_MAX_RETRY_ATTEMPTS", 3),
            telegram_max_retry_delay_seconds: env_number_or("TELEGRAM_MAX_RETRY_DELAY_SECONDS", 30),
        }
    }

    pub fn admin_chat(&self) -> Option<i64> {
        (self.admin_chat_id != 0).then_some(self.admin_chat_id)
    }
}

static CONFIG: LazyLock<Config> = LazyLock::new(Config::from_env);

pub fn get() -> &'static Config {
    &CONFIG
}
