use tracing_subscriber::EnvFilter;

use crate::config::env;

pub fn init() {
    let filter = EnvFilter::new(env::get().log_level.clone());

    tracing_subscriber::fmt().with_env_filter(filter).init();
}
