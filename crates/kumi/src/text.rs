//! Port of `apps/kumi/src/text.ts`.

use kumi_common::js;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Text,
    Escape,
    Csi,
    String,
    StringEscape,
}

/// Incremental terminal sanitizer: escape sequences and secret prefixes may span chunks.
#[derive(Clone, Debug)]
pub struct StreamingText {
    state: State,
    pending: String,
    secrets: Vec<String>,
}

fn is_invisible(character: char) -> bool {
    matches!(character, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
}

impl Default for StreamingText {
    fn default() -> Self {
        Self::new(&[])
    }
}

impl StreamingText {
    pub fn new(secrets: &[String]) -> StreamingText {
        StreamingText { state: State::Text, pending: String::new(), secrets: secrets.to_vec() }
    }

    pub fn push(&mut self, input: &str) -> String {
        let mut clean = String::new();
        for character in input.chars() {
            let code = character as u32;
            if self.state == State::String {
                if code == 7 || code == 0x9c {
                    self.state = State::Text;
                } else if code == 27 {
                    self.state = State::StringEscape;
                }
                continue;
            }
            if self.state == State::StringEscape {
                self.state = if character == '\\' || code == 7 {
                    State::Text
                } else if code == 27 {
                    State::StringEscape
                } else {
                    State::String
                };
                continue;
            }
            if self.state == State::Csi {
                if (0x40..=0x7e).contains(&code) {
                    self.state = State::Text;
                } else if code == 27 {
                    self.state = State::Escape;
                }
                continue;
            }
            if self.state == State::Escape {
                self.state = if character == '[' {
                    State::Csi
                } else if matches!(character, ']' | 'P' | '^' | '_' | 'X') {
                    State::String
                } else if code == 27 {
                    State::Escape
                } else {
                    State::Text
                };
                continue;
            }
            if code == 27 {
                self.state = State::Escape;
                continue;
            }
            if code == 0x9b {
                self.state = State::Csi;
                continue;
            }
            if matches!(code, 0x90 | 0x98 | 0x9d | 0x9e | 0x9f) {
                self.state = State::String;
                continue;
            }
            if character == '\n' {
                clean.push(character);
            } else if character == '\t' {
                clean.push_str("    ");
            } else if code >= 0x20 && !(0x7f..=0x9f).contains(&code) && !is_invisible(character) {
                clean.push(character);
            }
        }
        self.pending.push_str(&clean);
        for secret in &self.secrets {
            if !secret.is_empty() {
                self.pending = self.pending.replace(secret.as_str(), "[redacted]");
            }
        }
        let mut retain = 0;
        let pending_length = js::string::utf16_len(&self.pending);
        for secret in &self.secrets {
            let mut length = (js::string::utf16_len(secret).saturating_sub(1)).min(pending_length);
            while length > retain {
                if self.pending.ends_with(&js::string::head(secret, length)) {
                    retain = length;
                    break;
                }
                length -= 1;
            }
        }
        let visible = js::string::slice(&self.pending, 0, Some((pending_length - retain) as i64));
        self.pending = if retain > 0 { js::string::slice(&self.pending, -(retain as i64), None) } else { String::new() };
        visible
    }

    pub fn finish(&mut self) -> String {
        let text = std::mem::take(&mut self.pending);
        self.discard();
        text
    }

    pub fn discard(&mut self) {
        self.pending.clear();
        self.state = State::Text;
    }
}

pub fn sanitize_text(text: &str, secrets: &[String]) -> String {
    let mut stream = StreamingText::new(secrets);
    let mut out = stream.push(text);
    out.push_str(&stream.finish());
    out
}

/// A search or a page Kumi read, in a line's words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebWords {
    pub lead: String,
    pub title: String,
    pub detail: String,
}
