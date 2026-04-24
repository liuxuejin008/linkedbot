#[derive(Default, Debug)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
    pub id: String,
}

pub fn feed_line(line: &str, current: &mut SseEvent, out: &mut Vec<SseEvent>) {
    let line = line.trim_end_matches('\r');

    if line.is_empty() {
        if !current.data.is_empty() {
            out.push(std::mem::take(current));
        }
        *current = SseEvent::default();
        return;
    }

    if line.starts_with(':') {
        return;
    }

    let (fld, value) = if let Some(i) = line.find(':') {
        let v = line[i + 1..].trim_start_matches(' ');
        (&line[..i], v)
    } else {
        (line, "")
    };

    match fld {
        "event" => current.event = value.to_string(),
        "data" => {
            if current.data.is_empty() {
                current.data = value.to_string();
            } else {
                current.data.push('\n');
                current.data.push_str(value);
            }
        }
        "id" => current.id = value.to_string(),
        _ => {}
    }
}
