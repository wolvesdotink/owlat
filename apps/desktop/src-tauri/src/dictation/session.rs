//! The one dictation session, and which webview owns it. Nothing here touches
//! the OS, so it is tested on every platform.
//!
//! Everything that can reach a session holds its id: the SPA's stop and
//! cancel, the permission prompts' answers, the recognizer's results. Each
//! looks the session up by that id and does nothing once it has ended, so an
//! answer that arrives after a cancel, or after the owner's window closed,
//! never starts the microphone.

// Only the macOS engine keeps sessions; elsewhere this exists for the tests.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

pub struct Session<S> {
    pub id: u64,
    /// The label of the webview that started it.
    pub owner: String,
    pub state: S,
}

pub struct Sessions<S> {
    current: Option<Session<S>>,
    last_id: u64,
}

impl<S> Default for Sessions<S> {
    fn default() -> Self {
        Self::new()
    }
}

impl<S> Sessions<S> {
    pub const fn new() -> Self {
        Self {
            current: None,
            last_id: 0,
        }
    }

    /// Start a session for the webview `owner`. Returns its id, and the
    /// session it replaces, which the caller ends.
    pub fn start(&mut self, owner: String, state: S) -> (u64, Option<Session<S>>) {
        self.last_id += 1;
        let id = self.last_id;
        let previous = self.current.replace(Session { id, owner, state });
        (id, previous)
    }

    /// The session `id`, while it is the current one.
    pub fn get(&self, id: u64) -> Option<&S> {
        self.current
            .as_ref()
            .filter(|s| s.id == id)
            .map(|s| &s.state)
    }

    pub fn get_mut(&mut self, id: u64) -> Option<&mut S> {
        self.current
            .as_mut()
            .filter(|s| s.id == id)
            .map(|s| &mut s.state)
    }

    pub fn is_current(&self, id: u64) -> bool {
        self.get(id).is_some()
    }

    /// End the session `id`, if it is the current one: the caller ends it.
    pub fn take(&mut self, id: u64) -> Option<Session<S>> {
        self.take_if(|s| s.id == id)
    }

    /// The webview `owner` navigated, closed or was hidden: its session, if
    /// it has the current one, is the caller's to end.
    pub fn release(&mut self, owner: &str) -> Option<Session<S>> {
        self.take_if(|s| s.owner == owner)
    }

    fn take_if(&mut self, matches: impl Fn(&Session<S>) -> bool) -> Option<Session<S>> {
        if self.current.as_ref().is_some_and(matches) {
            self.current.take()
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a permission prompt's answer does: carry on with the session it
    /// was asked for, if that one is still current.
    fn answered(sessions: &mut Sessions<Vec<&'static str>>, id: u64) -> bool {
        match sessions.get_mut(id) {
            Some(steps) => {
                steps.push("listening");
                true
            }
            None => false,
        }
    }

    #[test]
    fn a_session_belongs_to_the_webview_that_started_it() {
        let mut sessions = Sessions::new();
        let (id, previous) = sessions.start("main".into(), ());
        assert!(previous.is_none());
        assert!(sessions.release("compose-1").is_none());
        assert!(sessions.is_current(id));
        let ended = sessions.release("main").expect("main's session ends");
        assert_eq!((ended.id, ended.owner.as_str()), (id, "main"));
        assert!(!sessions.is_current(id));
    }

    #[test]
    fn starting_a_session_hands_back_the_one_it_replaces() {
        let mut sessions = Sessions::new();
        let (first, _) = sessions.start("main".into(), ());
        let (second, previous) = sessions.start("compose-1".into(), ());
        assert_ne!(first, second);
        assert_eq!(previous.map(|s| s.id), Some(first));
        // A late stop or cancel from the first window reaches nothing.
        assert!(sessions.take(first).is_none());
        // Nor does closing it.
        assert!(sessions.release("main").is_none());
        assert!(sessions.is_current(second));
    }

    #[test]
    fn closing_the_owner_while_permission_is_asked_never_starts_listening() {
        let mut sessions = Sessions::new();
        let (id, _) = sessions.start("main".into(), vec!["asking"]);
        let ended = sessions.release("main").expect("closing ends the session");
        assert_eq!(ended.state, vec!["asking"]);
        assert!(!answered(&mut sessions, id));
        // A session started afterwards is not the one the answer was for.
        let (next, _) = sessions.start("main".into(), vec!["asking"]);
        assert!(!answered(&mut sessions, id));
        assert_eq!(sessions.get(next), Some(&vec!["asking"]));
        assert!(answered(&mut sessions, next));
    }

    #[test]
    fn a_cancelled_session_ignores_its_permission_answer() {
        let mut sessions = Sessions::new();
        let (id, _) = sessions.start("main".into(), vec!["asking"]);
        assert!(sessions.take(id).is_some());
        assert!(!answered(&mut sessions, id));
        assert!(sessions.take(id).is_none());
    }
}
