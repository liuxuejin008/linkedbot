use bytes::BytesMut;
use futures_util::StreamExt;
use reqwest::Response;

/// A single SSE event parsed from the stream.
#[derive(Debug, Default)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
    pub id: String,
}

/// Async iterator over SSE events from a streaming reqwest response.
///
/// Parses the standard SSE wire format:
///   - `event: <type>`
///   - `data: <payload>`
///   - `id: <cursor>`
///   - blank line = emit event
///   - lines starting with `:` = keepalive / comment (ignored)
pub struct SseStream {
    inner: futures_util::stream::BoxStream<'static, reqwest::Result<bytes::Bytes>>,
    buf: BytesMut,
    current: SseEvent,
}

impl SseStream {
    pub fn new(resp: Response) -> Self {
        Self {
            inner: resp.bytes_stream().boxed(),
            buf: BytesMut::new(),
            current: SseEvent::default(),
        }
    }

    /// Yield the next parsed SSE event, or None when the stream ends.
    pub async fn next_event(&mut self) -> Option<SseEvent> {
        loop {
            // Try to extract a line from the buffer
            if let Some(line) = self.take_line() {
                if line.is_empty() {
                    // Blank line → emit the accumulated event
                    if !self.current.data.is_empty() || !self.current.event.is_empty() {
                        let evt = std::mem::take(&mut self.current);
                        return Some(evt);
                    }
                    continue;
                }

                if line.starts_with(':') {
                    continue; // comment / keepalive
                }

                let (field, value) = match line.find(':') {
                    Some(pos) => {
                        let f = &line[..pos];
                        let v = line[pos + 1..].trim_start_matches(' ');
                        (f, v)
                    }
                    None => (line.as_str(), ""),
                };

                match field {
                    "event" => self.current.event = value.to_string(),
                    "data" => {
                        if self.current.data.is_empty() {
                            self.current.data = value.to_string();
                        } else {
                            self.current.data.push('\n');
                            self.current.data.push_str(value);
                        }
                    }
                    "id" => self.current.id = value.to_string(),
                    _ => {}
                }
                continue;
            }

            // Need more data from the network
            match self.inner.next().await {
                Some(Ok(chunk)) => self.buf.extend_from_slice(&chunk),
                _ => return None,
            }
        }
    }

    /// Extract one complete line (up to `\n`) from buf.
    fn take_line(&mut self) -> Option<String> {
        let data = &self.buf[..];
        if let Some(pos) = data.iter().position(|&b| b == b'\n') {
            let line_bytes = self.buf.split_to(pos + 1);
            let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
            Some(line.trim_end_matches('\r').to_string())
        } else {
            None
        }
    }
}
