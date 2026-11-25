use crate::helpers::rich::{btn, btn_styled, row, row_aligned};

pub fn main_menu_html(in_queue: bool, is_current: bool) -> String {
    let mut rows = vec![
        row(&[if in_queue {
            btn_styled("🚪 Выйти из очереди", "leave_queue", "danger")
        } else {
            btn_styled("🌿 Участвовать в поливе", "join_queue", "success")
        }]),
        row(&[
            btn("📋 Очередь", "show_queue"),
            btn("💧 История", "show_history"),
        ]),
        row(&[btn("⏭ Следующий полив", "show_next")]),
    ];

    if in_queue && is_current {
        rows.push(row(&[btn_styled(
            "⏩ Пропустить очередь",
            "skip_turn",
            "primary",
        )]));
    }

    rows.join("")
}

pub fn back_html() -> String {
    row(&[btn("◀️ Назад в меню", "back_to_menu")])
}

pub fn watered_html() -> String {
    row_aligned(
        &[btn_styled("💧 Полил!", "mark_watered", "success")],
        "center",
    )
}

pub fn watered_with_back_html() -> String {
    format!("{}{}", watered_html(), back_html())
}

pub fn after_watering_html() -> String {
    format!(
        "{}{}",
        row_aligned(&[btn("⏭ Когда полив?", "show_next")], "center"),
        row_aligned(&[btn("🏠 Меню", "back_to_menu")], "center")
    )
}
