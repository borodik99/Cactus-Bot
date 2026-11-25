use chrono::{DateTime, NaiveDate, Timelike, Utc};
use chrono_tz::Tz;

pub const TZ: Tz = Tz::Europe__Minsk;

pub fn now() -> DateTime<Utc> {
    Utc::now()
}

pub fn local_hour(instant: DateTime<Utc>) -> u32 {
    instant.with_timezone(&TZ).hour()
}

pub fn calendar_date_in(instant: DateTime<Utc>) -> NaiveDate {
    instant.with_timezone(&TZ).date_naive()
}

pub fn at_local_time(day: NaiveDate, hours: u32, minutes: u32) -> DateTime<Utc> {
    let naive = day
        .and_hms_opt(hours, minutes, 0)
        .expect("корректные часы/минуты");
    naive
        .and_local_timezone(TZ)
        .single()
        .expect("Минск без DST: локальное время однозначно")
        .with_timezone(&Utc)
}

pub fn fmt_date(instant: Option<DateTime<Utc>>) -> String {
    match instant {
        Some(d) => d.with_timezone(&TZ).format("%d.%m.%Y").to_string(),
        None => "—".to_string(),
    }
}

pub fn fmt_date_time(instant: DateTime<Utc>) -> String {
    instant
        .with_timezone(&TZ)
        .format("%d.%m.%Y, %H:%M")
        .to_string()
}

pub fn calendar_days_diff(from_day: NaiveDate, to_day: NaiveDate) -> i64 {
    (to_day - from_day).num_days()
}

pub fn plural_days_ru(n: i64) -> String {
    let m10 = n % 10;
    let m100 = n % 100;
    if m10 == 1 && m100 != 11 {
        "день".to_string()
    } else if (2..=4).contains(&m10) && !(12..=14).contains(&m100) {
        "дня".to_string()
    } else {
        "дней".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plural_days_ru_works() {
        assert_eq!(plural_days_ru(1), "день");
        assert_eq!(plural_days_ru(2), "дня");
        assert_eq!(plural_days_ru(5), "дней");
        assert_eq!(plural_days_ru(11), "дней");
        assert_eq!(plural_days_ru(12), "дней");
        assert_eq!(plural_days_ru(14), "дней");
        assert_eq!(plural_days_ru(21), "день");
        assert_eq!(plural_days_ru(22), "дня");
        assert_eq!(plural_days_ru(25), "дней");
    }
}
