use std::sync::LazyLock;

use deadpool_postgres::{Manager, Pool};
use tokio_postgres::NoTls;

use crate::config::env;
use crate::db::DbResult;

static DB: LazyLock<Pool> = LazyLock::new(|| {
    let pg_config: tokio_postgres::Config = env::get().database_url.parse().expect(
        "Не удалось разобрать DATABASE_URL (пример: postgresql://user:pass@localhost:5432/db)",
    );

    let manager = Manager::new(pg_config, NoTls);
    Pool::builder(manager)
        .build()
        .expect("Не удалось создать пул соединений с PostgreSQL")
});

pub fn db() -> &'static Pool {
    &DB
}

pub async fn health_check() -> DbResult<()> {
    let client = db().get().await?;
    client.simple_query("SELECT 1").await?;
    Ok(())
}
