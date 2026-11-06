//! What a dictation session reports to the SPA, and the rules that turn the
//! recognizer's output into it. Nothing here touches the OS, so it is tested on
//! every platform.

// Only the macOS engine produces these; elsewhere they exist for the tests.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use serde::Serialize;

/// What the SPA hears from a session, in order: partials and phrases, at most
/// one error, then `End`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DictationEvent {
    /// The phrase still being heard. Shown, never inserted.
    Partial {
        text: String,
    },
    /// A finished phrase, to insert.
    Phrase {
        text: String,
    },
    Error {
        reason: DictationError,
    },
    End,
}

/// Why a session stopped early, in the terms the SPA explains (its
/// `DictationError`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DictationError {
    /// No permission for the microphone or for speech recognition, or no
    /// microphone to open.
    Blocked,
    NoSpeech,
    /// No on-device model for the language.
    Language,
    Failed,
}

/// A language tag the webview sent (`navigator.language`), if it looks like
/// one. It only ever names a locale, so anything else is refused before it
/// reaches the OS.
pub fn language(tag: &str) -> Option<&str> {
    let ok = !tag.is_empty()
        && tag.len() <= 35
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then_some(tag)
}

/// The SPA's reason for a recognizer error, or `None` for the error a cancel
/// produces (the session asked for it, so there is nothing to explain). The
/// Speech framework documents few of its codes; these are the ones it reports
/// from on-device recognition, everything else is `Failed`.
pub fn classify(domain: &str, code: isize) -> Option<DictationError> {
    match (domain, code) {
        // "Recognition request was canceled" / "Canceled".
        ("kLSRErrorDomain", 301) | ("kAFAssistantErrorDomain", 216) => None,
        // "No speech detected" (on-device, and the older assistant domain).
        ("kAFAssistantErrorDomain", 1110) | ("kAFAssistantErrorDomain", 203) => {
            Some(DictationError::NoSpeech)
        }
        // "Siri and Dictation are disabled": turned off in System Settings or
        // by a profile.
        ("kLSRErrorDomain", 201) => Some(DictationError::Blocked),
        // The on-device assets for the language are missing.
        ("kLSRErrorDomain", 102) => Some(DictationError::Language),
        _ => Some(DictationError::Failed),
    }
}

/// Cuts the recognizer's transcripts into phrases.
///
/// Each result carries the whole transcript so far, and an utterance ends at a
/// pause (the result then has metadata) or when the session finishes. What
/// follows an utterance's end depends on the macOS version: the transcript
/// either carries on from the full text or starts over with the next
/// utterance. The first result after a phrase tells which: a transcript that
/// carries on starts with the text already sent, give or take a revision of
/// its last words, while a fresh one shares at most a word with it. Text
/// already sent as phrases is never sent again.
#[derive(Debug, Default)]
pub struct Phrases {
    /// The transcript the phrases sent so far were cut from.
    sent: String,
    /// Whether the transcript since the last phrase extends `sent`; `None`
    /// until a result after it arrives.
    extends: Option<bool>,
}

impl Phrases {
    fn unsent<'t>(&mut self, transcript: &'t str) -> &'t str {
        if self.sent.is_empty() {
            return transcript;
        }
        let sent = self.sent.as_str();
        if !*self
            .extends
            .get_or_insert_with(|| carries_on(sent, transcript))
        {
            return transcript;
        }
        transcript.strip_prefix(sent).unwrap_or_else(|| {
            // A revision reached back into text already sent; what is new
            // starts where that text ended.
            let mut cut = sent.len().min(transcript.len());
            while !transcript.is_char_boundary(cut) {
                cut -= 1;
            }
            &transcript[cut..]
        })
    }

    /// A result still being heard: the text to show.
    pub fn partial(&mut self, transcript: &str) -> String {
        self.unsent(transcript).trim().to_string()
    }

    /// The end of an utterance: the phrase to insert, if it says anything new.
    pub fn phrase(&mut self, transcript: &str) -> Option<String> {
        let phrase = self.unsent(transcript).trim().to_string();
        self.sent = transcript.to_string();
        self.extends = None;
        (!phrase.is_empty()).then_some(phrase)
    }
}

/// Whether `transcript` continues `sent` rather than starting over: it shares
/// at least half of `sent` as its start, ignoring case.
fn carries_on(sent: &str, transcript: &str) -> bool {
    let shared = sent
        .chars()
        .zip(transcript.chars())
        .take_while(|(a, b)| a.to_lowercase().eq(b.to_lowercase()))
        .count();
    shared * 2 >= sent.chars().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialize_as_the_spa_reads_them() {
        let json = |e: DictationEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            json(DictationEvent::Partial { text: "hi".into() }),
            serde_json::json!({ "kind": "partial", "text": "hi" })
        );
        assert_eq!(
            json(DictationEvent::Phrase { text: "hi".into() }),
            serde_json::json!({ "kind": "phrase", "text": "hi" })
        );
        assert_eq!(
            json(DictationEvent::Error {
                reason: DictationError::NoSpeech
            }),
            serde_json::json!({ "kind": "error", "reason": "no-speech" })
        );
        assert_eq!(
            json(DictationEvent::End),
            serde_json::json!({ "kind": "end" })
        );
    }

    #[test]
    fn recognizer_errors_map_to_the_spa_reasons() {
        assert_eq!(classify("kLSRErrorDomain", 301), None);
        assert_eq!(classify("kAFAssistantErrorDomain", 216), None);
        assert_eq!(
            classify("kAFAssistantErrorDomain", 1110),
            Some(DictationError::NoSpeech)
        );
        assert_eq!(
            classify("kLSRErrorDomain", 201),
            Some(DictationError::Blocked)
        );
        assert_eq!(
            classify("kLSRErrorDomain", 102),
            Some(DictationError::Language)
        );
        assert_eq!(
            classify("SFSpeechErrorDomain", 1),
            Some(DictationError::Failed)
        );
        // A code means something only within its domain.
        assert_eq!(
            classify("NSOSStatusErrorDomain", 301),
            Some(DictationError::Failed)
        );
    }

    #[test]
    fn only_language_tags_get_through() {
        assert_eq!(language("de-DE"), Some("de-DE"));
        assert_eq!(language("zh_Hant_TW"), Some("zh_Hant_TW"));
        assert_eq!(language(""), None);
        assert_eq!(language("en US"), None);
        assert_eq!(language("en@calendar=x"), None);
        assert_eq!(language(&"a".repeat(36)), None);
    }

    #[test]
    fn a_transcript_that_carries_on_is_cut_after_what_was_sent() {
        let mut p = Phrases::default();
        assert_eq!(p.partial("Tell them"), "Tell them");
        assert_eq!(
            p.phrase("Tell them Thursday works."),
            Some("Tell them Thursday works.".into())
        );
        assert_eq!(p.partial("Tell them Thursday works. And"), "And");
        assert_eq!(
            p.phrase("Tell them Thursday works. And ask"),
            Some("And ask".into())
        );
        // The session's final result repeats the transcript: nothing new.
        assert_eq!(p.phrase("Tell them Thursday works. And ask"), None);
    }

    #[test]
    fn a_transcript_that_starts_over_is_a_phrase_of_its_own() {
        let mut p = Phrases::default();
        assert_eq!(
            p.phrase("Tell them Thursday works."),
            Some("Tell them Thursday works.".into())
        );
        assert_eq!(p.partial("And"), "And");
        assert_eq!(
            p.partial("And ask for the agenda"),
            "And ask for the agenda"
        );
        assert_eq!(
            p.phrase("And ask for the agenda."),
            Some("And ask for the agenda.".into())
        );
    }

    #[test]
    fn a_revision_of_sent_text_does_not_send_it_again() {
        let mut p = Phrases::default();
        p.phrase("Tell them thursday");
        // The recognizer capitalised a word of the first phrase.
        assert_eq!(p.partial("Tell them Thursday. Thanks"), ". Thanks");
        assert_eq!(
            p.phrase("Tell them Thursday. Thanks"),
            Some(". Thanks".into())
        );
        // The cut lands on a character boundary.
        let mut p = Phrases::default();
        p.phrase("Tschüß");
        assert_eq!(p.phrase("Tschü Ärger"), Some("Ärger".into()));
    }

    #[test]
    fn a_silent_utterance_inserts_nothing() {
        let mut p = Phrases::default();
        assert_eq!(p.phrase("  "), None);
        assert_eq!(p.phrase(""), None);
    }
}
