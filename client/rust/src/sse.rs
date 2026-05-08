//! SSE（Server-Sent Events）行级解析器
//!
//! 与 Python 实现的 `_parse_sse` 逻辑对应，将原始文本行解析为 [`SseEvent`]。

#[derive(Default, Debug, Clone)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
    pub id: String,
}

/// 将一行文本喂入状态机。
///
/// - 空行触发事件提交（若 data 非空，则 push 到 `out`）
/// - `:` 开头为注释/keepalive，忽略
/// - 其余行按 `field: value` 解析并更新 `current`
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_event() {
        let lines = ["event: message", "data: hello", "id: 1", ""];
        let mut current = SseEvent::default();
        let mut out = Vec::new();
        for line in &lines {
            feed_line(line, &mut current, &mut out);
        }
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].event, "message");
        assert_eq!(out[0].data, "hello");
        assert_eq!(out[0].id, "1");
    }

    #[test]
    fn test_multiline_data() {
        let lines = ["data: line1", "data: line2", ""];
        let mut current = SseEvent::default();
        let mut out = Vec::new();
        for line in &lines {
            feed_line(line, &mut current, &mut out);
        }
        assert_eq!(out[0].data, "line1\nline2");
    }

    #[test]
    fn test_keepalive_ignored() {
        let lines = [": keepalive", "data: ok", ""];
        let mut current = SseEvent::default();
        let mut out = Vec::new();
        for line in &lines {
            feed_line(line, &mut current, &mut out);
        }
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].data, "ok");
    }
}
