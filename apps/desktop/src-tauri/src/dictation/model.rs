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

/// A word or group of words of a transcript, as the recognizer timed it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Segment {
    /// Where it starts in the transcript, in bytes.
    pub at: usize,
    /// When it was spoken, in seconds since the session's audio began.
    pub start: f64,
    pub duration: f64,
}

/// The byte offset in `text` of the UTF-16 offset `index` (what an `NSRange`
/// counts in), if it falls on a character.
pub fn byte_offset(text: &str, index: usize) -> Option<usize> {
    let mut units = 0;
    for (at, c) in text.char_indices() {
        if units == index {
            return Some(at);
        }
        units += c.len_utf16();
    }
    (units == index).then_some(text.len())
}

/// Cuts the recognizer's transcripts into phrases.
///
/// Each result carries a transcript, and an utterance ends at a pause (the
/// result then has metadata) or when the session finishes. What follows an
/// utterance's end depends on the macOS version: the transcript either carries
/// on from the full text or starts over with the next utterance. Text cannot
/// tell the two apart, since people often open a sentence the way they opened
/// the last one ("Yes." then "Yes, please."). The segments' timings can: they
/// count from the start of the session's audio, so the words of a phrase
/// already sent were spoken before its end, and every word after it is new.
///
/// Partial results may carry no timings (every segment's duration is zero).
/// Without them, a transcript that starts with the whole text already sent
/// carries on from it; anything else starts over. That guess only decides
/// what a partial shows until the phrase arrives, or, should a phrase itself
/// carry no timings, what it inserts.
#[derive(Debug, Default)]
pub struct Phrases {
    /// The transcript the phrases sent so far were cut from.
    sent: String,
    /// Where in the audio that transcript ends, if its segments were timed.
    heard_until: Option<f64>,
}

fn timed(segments: &[Segment]) -> bool {
    segments.iter().any(|s| s.duration > 0.0)
}

impl Phrases {
    fn unsent<'t>(&self, transcript: &'t str, segments: &[Segment]) -> &'t str {
        if self.sent.is_empty() && self.heard_until.is_none() {
            return transcript;
        }
        if let (Some(until), true) = (self.heard_until, timed(segments)) {
            // A word belongs to what was sent when most of it was spoken
            // before that ended, so a revision that shifts a word's timing a
            // little still counts as the same word.
            return segments
                .iter()
                .find(|s| s.start + s.duration / 2.0 >= until)
                .and_then(|s| transcript.get(s.at..))
                .unwrap_or("");
        }
        transcript
            .strip_prefix(self.sent.as_str())
            .unwrap_or(transcript)
    }

    /// A result still being heard: the text to show.
    pub fn partial(&mut self, transcript: &str, segments: &[Segment]) -> String {
        self.unsent(transcript, segments).trim().to_string()
    }

    /// The end of an utterance: the phrase to insert, if it says anything new.
    pub fn phrase(&mut self, transcript: &str, segments: &[Segment]) -> Option<String> {
        let phrase = self.unsent(transcript, segments).trim().to_string();
        let end = timed(segments).then(|| {
            segments
                .iter()
                .map(|s| s.start + s.duration)
                .fold(self.heard_until.unwrap_or(0.0), f64::max)
        });
        self.sent = transcript.to_string();
        self.heard_until = end;
        (!phrase.is_empty()).then_some(phrase)
    }
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

    /// A transcript of words spoken one after another from `from` seconds on,
    /// each taking `step` seconds, with its segments; `timed: false` drops
    /// the timings, as partial results may.
    fn heard(words: &str, from: f64, step: f64, timed: bool) -> (String, Vec<Segment>) {
        let mut segments = Vec::new();
        let mut at = 0;
        for (i, word) in words.split(' ').enumerate() {
            let (start, duration) = if timed {
                (from + step * i as f64, step * 0.8)
            } else {
                (0.0, 0.0)
            };
            segments.push(Segment {
                at,
                start,
                duration,
            });
            at += word.len() + 1;
        }
        (words.to_string(), segments)
    }

    /// `next` spoken after `first`, carrying on in one transcript: the
    /// segments of `first` keep their timings.
    fn carried(first: &(String, Vec<Segment>), next: &str, from: f64) -> (String, Vec<Segment>) {
        let (more, tail) = heard(next, from, 0.4, true);
        let offset = first.0.len() + 1;
        let mut segments = first.1.clone();
        segments.extend(tail.into_iter().map(|s| Segment {
            at: s.at + offset,
            ..s
        }));
        (format!("{} {more}", first.0), segments)
    }

    #[test]
    fn a_new_utterance_that_opens_like_the_last_keeps_all_its_words() {
        let mut p = Phrases::default();
        let (yes, at) = heard("Yes.", 0.0, 0.4, true);
        assert_eq!(p.phrase(&yes, &at), Some("Yes.".into()));
        let (more, at) = heard("Yes please.", 1.5, 0.4, true);
        assert_eq!(p.partial(&more, &at), "Yes please.");
        assert_eq!(p.phrase(&more, &at), Some("Yes please.".into()));
        // Also when the partials carry no timings.
        let mut p = Phrases::default();
        let (yes, at) = heard("Yes", 0.0, 0.4, true);
        p.phrase(&yes, &at);
        let (more, untimed) = heard("Yes please", 0.0, 0.0, false);
        let (_, at) = heard("Yes please", 1.5, 0.4, true);
        assert_eq!(p.partial(&more, &untimed), "please");
        assert_eq!(p.phrase(&more, &at), Some("Yes please".into()));
    }

    #[test]
    fn a_transcript_that_carries_on_after_a_pause_is_cut_after_what_was_sent() {
        let mut p = Phrases::default();
        let first = heard("Tell them Thursday works.", 0.0, 0.4, true);
        assert_eq!(p.partial("Tell them", &first.1[..2]), "Tell them");
        assert_eq!(
            p.phrase(&first.0, &first.1),
            Some("Tell them Thursday works.".into())
        );
        let and = carried(&first, "And", 3.0);
        assert_eq!(p.partial(&and.0, &and.1), "And");
        // Untimed, it still reads as carrying on.
        let untimed: Vec<_> = and
            .1
            .iter()
            .map(|s| Segment {
                start: 0.0,
                duration: 0.0,
                ..*s
            })
            .collect();
        assert_eq!(p.partial(&and.0, &untimed), "And");
        // It may open like the phrase before it, too.
        let next = carried(&first, "Tell them I said yes.", 3.0);
        assert_eq!(
            p.phrase(&next.0, &next.1),
            Some("Tell them I said yes.".into())
        );
        // The session's final result repeats the transcript: nothing new.
        assert_eq!(p.phrase(&next.0, &next.1), None);
    }

    #[test]
    fn a_transcript_that_starts_over_is_a_phrase_of_its_own() {
        let mut p = Phrases::default();
        let first = heard("Tell them Thursday works.", 0.0, 0.4, true);
        assert_eq!(
            p.phrase(&first.0, &first.1),
            Some("Tell them Thursday works.".into())
        );
        let (and, at) = heard("And", 0.0, 0.0, false);
        assert_eq!(p.partial(&and, &at), "And");
        let (next, at) = heard("And ask for the agenda.", 3.0, 0.4, true);
        assert_eq!(p.partial(&next, &at), "And ask for the agenda.");
        assert_eq!(p.phrase(&next, &at), Some("And ask for the agenda.".into()));
        // Stopping repeats the last utterance as the final result.
        assert_eq!(p.phrase(&next, &at), None);
    }

    #[test]
    fn a_revision_of_sent_text_does_not_send_it_again() {
        let mut p = Phrases::default();
        let first = heard("Tell them thursday", 0.0, 0.4, true);
        p.phrase(&first.0, &first.1);
        // The recognizer capitalised a word of the first phrase and moved it
        // a little.
        let mut next = carried(&heard("Tell them Thursday.", 0.0, 0.4, true), "Thanks", 2.0);
        next.1[2].start += 0.1;
        assert_eq!(p.partial(&next.0, &next.1), "Thanks");
        assert_eq!(p.phrase(&next.0, &next.1), Some("Thanks".into()));
    }

    #[test]
    fn a_phrase_without_timings_is_cut_by_its_text() {
        let mut p = Phrases::default();
        let (first, at) = heard("Tell them", 0.0, 0.0, false);
        assert_eq!(p.phrase(&first, &at), Some("Tell them".into()));
        let (next, at) = heard("Tell them Thursday.", 0.0, 0.0, false);
        assert_eq!(p.phrase(&next, &at), Some("Thursday.".into()));
        let (over, at) = heard("Thanks.", 0.0, 0.0, false);
        assert_eq!(p.phrase(&over, &at), Some("Thanks.".into()));
    }

    #[test]
    fn segment_ranges_convert_to_byte_offsets() {
        // NSRange counts UTF-16 units: "ü" and "ß" are one each, "😀" two.
        let text = "Tschüß Ärger 😀 ok";
        assert_eq!(byte_offset(text, 0), Some(0));
        assert_eq!(byte_offset(text, 7), Some(text.find('Ä').unwrap()));
        assert_eq!(byte_offset(text, 16), Some(text.find("ok").unwrap()));
        assert_eq!(byte_offset(text, 14), None);
        assert_eq!(byte_offset(text, 18), Some(text.len()));
        assert_eq!(byte_offset(text, 19), None);
    }

    #[test]
    fn a_silent_utterance_inserts_nothing() {
        let mut p = Phrases::default();
        assert_eq!(p.phrase("  ", &[]), None);
        assert_eq!(p.phrase("", &[]), None);
    }
}
