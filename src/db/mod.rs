pub mod pool;
pub mod queries;

pub type DbResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
