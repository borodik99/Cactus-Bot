pub struct Watering {
    pub freq: i32,
    pub water: i32,
    pub water_label: &'static str,
    pub time: &'static str,
    pub name: &'static str,
    pub reminder_hour: u32,
}

pub const WATERING: Watering = Watering {
    freq: 14,
    water: 25,
    water_label: "25 мл",
    time: "10:00 по Минску (каждые 14 дней, дата полива не попадает на выходные)",
    name: "Макс",
    reminder_hour: 10,
};
