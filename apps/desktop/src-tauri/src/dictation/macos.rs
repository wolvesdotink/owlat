//! The macOS engine: `SFSpeechRecognizer` with `requiresOnDeviceRecognition`,
//! fed from an `AVAudioEngine` input tap.
//!
//! Every function here runs on the main thread, and the recognizer is told to
//! answer on the main queue, so the one session lives in a thread-local and
//! needs no lock. The permission prompts answer on any thread; their callbacks
//! hop back through `MainThread` and check that their session is still the
//! current one. Only the audio tap runs elsewhere, and it touches nothing but
//! its own request, whose buffer appends the framework allows from any thread.
//!
//! The Speech framework arrived in macOS 10.15 and `AVAudioApplication` in 14;
//! both are weakly linked (build.rs), so each is looked up before use.

use std::cell::{Cell, RefCell};
use std::ptr::NonNull;
use std::rc::Rc;
use std::sync::Arc;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, Bool, NSObjectProtocol};
use objc2::{sel, AllocAnyThread};
use objc2_avf_audio::{
    AVAudioApplication, AVAudioApplicationRecordPermission, AVAudioEngine, AVAudioPCMBuffer,
    AVAudioTime,
};
use objc2_foundation::{NSError, NSLocale, NSOperationQueue, NSString};
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask,
    SFSpeechRecognitionTaskHint, SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
};

use super::model::{classify, DictationError, DictationEvent, Phrases};

/// Delivers a session's events to the webview that started it.
pub type Emit = Rc<dyn Fn(DictationEvent)>;
/// Runs a task on the main thread.
pub type MainThread = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

struct Session {
    id: u64,
    /// The label of the webview that started it.
    owner: String,
    lang: String,
    emit: Emit,
    phrases: Phrases,
    /// `None` while a permission prompt is open.
    live: Option<Live>,
}

struct Live {
    engine: Retained<AVAudioEngine>,
    request: Retained<SFSpeechAudioBufferRecognitionRequest>,
    task: Retained<SFSpeechRecognitionTask>,
    _recognizer: Retained<SFSpeechRecognizer>,
}

thread_local! {
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
    static LAST_ID: Cell<u64> = const { Cell::new(0) };
}

/// The input bus of the input node, the only one it has.
const INPUT_BUS: usize = 0;

fn speech_framework() -> bool {
    AnyClass::get(c"SFSpeechRecognizer").is_some() && AnyClass::get(c"AVAudioEngine").is_some()
}

fn recognizer(lang: &str) -> Option<Retained<SFSpeechRecognizer>> {
    let locale = NSLocale::localeWithLocaleIdentifier(&NSString::from_str(lang));
    unsafe { SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale) }
}

/// Whether `lang` can be dictated without the audio leaving this Mac.
pub fn available(lang: &str) -> bool {
    if !speech_framework() {
        return false;
    }
    // A device policy forbids speech recognition; nothing in Owlat can change
    // that. A plain "denied" still shows the mic, whose error says where to
    // allow it.
    if unsafe { SFSpeechRecognizer::authorizationStatus() }
        == SFSpeechRecognizerAuthorizationStatus::Restricted
    {
        return false;
    }
    recognizer(lang).is_some_and(|r| unsafe { r.supportsOnDeviceRecognition() })
}

/// Start a session for the webview `owner`, ending any other first. Its events
/// go to `emit`; the returned id stops or cancels it.
pub fn start(owner: String, lang: String, emit: Emit, main: MainThread) -> u64 {
    if let Some(previous) = SESSION.take() {
        end(previous, None);
    }
    let id = LAST_ID.get() + 1;
    LAST_ID.set(id);
    SESSION.set(Some(Session {
        id,
        owner,
        lang,
        emit,
        phrases: Phrases::default(),
        live: None,
    }));
    if speech_framework() {
        authorize(id, main, false);
    } else {
        fail(id, DictationError::Failed);
    }
    id
}

/// Stop listening; the recognizer still delivers what it heard, then ends.
pub fn stop(id: u64) {
    let listening = SESSION.with_borrow(|s| {
        s.as_ref()
            .filter(|s| s.id == id)
            .map(|s| s.live.as_ref().map(|live| live.request.clone()))
    });
    match listening {
        Some(Some(request)) => {
            stop_audio(id);
            unsafe { request.endAudio() };
        }
        // Still asking for permission: nothing was heard yet.
        Some(None) => cancel(id),
        None => {}
    }
}

/// Stop listening and drop what has not been delivered yet.
pub fn cancel(id: u64) {
    if let Some(session) = take(|s| s.id == id) {
        end(session, None);
    }
}

/// The webview `owner` navigated or closed: its session, if any, goes with it.
pub fn release(owner: &str) {
    if let Some(mut session) = take(|s| s.owner == owner) {
        if let Some(live) = session.live.take() {
            teardown(&live);
        }
    }
}

fn take(matches: impl Fn(&Session) -> bool) -> Option<Session> {
    SESSION.with_borrow_mut(|s| {
        if s.as_ref().is_some_and(matches) {
            s.take()
        } else {
            None
        }
    })
}

fn is_current(id: u64) -> bool {
    SESSION.with_borrow(|s| s.as_ref().is_some_and(|s| s.id == id))
}

/// End a session that is no longer the current one: release the microphone and
/// the recognizer, then tell the webview.
fn end(mut session: Session, error: Option<DictationError>) {
    if let Some(live) = session.live.take() {
        teardown(&live);
    }
    if let Some(reason) = error {
        (session.emit)(DictationEvent::Error { reason });
    }
    (session.emit)(DictationEvent::End);
}

fn fail(id: u64, reason: DictationError) {
    if let Some(session) = take(|s| s.id == id) {
        end(session, Some(reason));
    }
}

fn teardown(live: &Live) {
    unsafe {
        live.engine.stop();
        live.engine.inputNode().removeTapOnBus(INPUT_BUS);
        live.request.endAudio();
        live.task.cancel();
    }
}

fn stop_audio(id: u64) {
    let engine = SESSION.with_borrow(|s| {
        s.as_ref()
            .filter(|s| s.id == id)
            .and_then(|s| s.live.as_ref().map(|live| live.engine.clone()))
    });
    if let Some(engine) = engine {
        unsafe {
            engine.stop();
            engine.inputNode().removeTapOnBus(INPUT_BUS);
        }
    }
}

/// Speech recognition permission, asked once; then the microphone's.
fn authorize(id: u64, main: MainThread, asked: bool) {
    let status = unsafe { SFSpeechRecognizer::authorizationStatus() };
    if status == SFSpeechRecognizerAuthorizationStatus::Authorized {
        authorize_microphone(id, main, false);
    } else if status == SFSpeechRecognizerAuthorizationStatus::NotDetermined && !asked {
        let hop = main.clone();
        let answered = RcBlock::new(move |_: SFSpeechRecognizerAuthorizationStatus| {
            let main = hop.clone();
            hop(Box::new(move || {
                if is_current(id) {
                    authorize(id, main, true);
                }
            }));
        });
        unsafe { SFSpeechRecognizer::requestAuthorization(&answered) };
    } else {
        fail(id, DictationError::Blocked);
    }
}

/// Before macOS 14 there is no permission to read: opening the input device
/// asks, and a refusal is heard as silence.
fn authorize_microphone(id: u64, main: MainThread, asked: bool) {
    if AnyClass::get(c"AVAudioApplication").is_none() {
        return listen(id);
    }
    let permission = unsafe { AVAudioApplication::sharedInstance().recordPermission() };
    if permission == AVAudioApplicationRecordPermission::Granted {
        listen(id);
    } else if permission == AVAudioApplicationRecordPermission::Undetermined && !asked {
        let hop = main.clone();
        let answered = RcBlock::new(move |_: Bool| {
            let main = hop.clone();
            hop(Box::new(move || {
                if is_current(id) {
                    authorize_microphone(id, main, true);
                }
            }));
        });
        unsafe { AVAudioApplication::requestRecordPermissionWithCompletionHandler(&answered) };
    } else {
        fail(id, DictationError::Blocked);
    }
}

fn listen(id: u64) {
    let lang = SESSION.with_borrow(|s| s.as_ref().filter(|s| s.id == id).map(|s| s.lang.clone()));
    let Some(lang) = lang else { return };
    match begin(id, &lang) {
        Ok(live) => {
            let orphan = SESSION.with_borrow_mut(|s| match s.as_mut().filter(|s| s.id == id) {
                Some(session) => {
                    session.live = Some(live);
                    None
                }
                None => Some(live),
            });
            if let Some(live) = orphan {
                teardown(&live);
            }
        }
        Err(reason) => fail(id, reason),
    }
}

fn begin(id: u64, lang: &str) -> Result<Live, DictationError> {
    let recognizer = recognizer(lang).ok_or(DictationError::Language)?;
    unsafe {
        if !recognizer.supportsOnDeviceRecognition() {
            return Err(DictationError::Language);
        }
        if !recognizer.isAvailable() {
            return Err(DictationError::Failed);
        }
        recognizer.setQueue(&NSOperationQueue::mainQueue());

        let request = SFSpeechAudioBufferRecognitionRequest::new();
        request.setShouldReportPartialResults(true);
        request.setRequiresOnDeviceRecognition(true);
        request.setTaskHint(SFSpeechRecognitionTaskHint::Dictation);
        // macOS 13 and later.
        if request.respondsToSelector(sel!(setAddsPunctuation:)) {
            request.setAddsPunctuation(true);
        }

        let engine = AVAudioEngine::new();
        let input = engine.inputNode();
        let format = input.outputFormatForBus(INPUT_BUS);
        // No input device: installing a tap on a format without channels
        // raises an Objective-C exception.
        if format.channelCount() == 0 || format.sampleRate() <= 0.0 {
            return Err(DictationError::Blocked);
        }
        let feed = request.clone();
        let tap = RcBlock::new(
            move |buffer: NonNull<AVAudioPCMBuffer>, _: NonNull<AVAudioTime>| {
                feed.appendAudioPCMBuffer(buffer.as_ref());
            },
        );
        input.installTapOnBus_bufferSize_format_block(
            INPUT_BUS,
            1024,
            Some(&format),
            RcBlock::as_ptr(&tap),
        );
        engine.prepare();
        if engine.startAndReturnError().is_err() {
            input.removeTapOnBus(INPUT_BUS);
            return Err(DictationError::Failed);
        }

        let handler = RcBlock::new(
            move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                heard(id, result.as_ref(), error.as_ref());
            },
        );
        let task = recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler);
        Ok(Live {
            engine,
            request,
            task,
            _recognizer: recognizer,
        })
    }
}

/// Whether the recognizer marked the end of an utterance (macOS 11.3 and
/// later; earlier ones mark only the end of the session).
fn utterance_ended(result: &SFSpeechRecognitionResult) -> bool {
    result.respondsToSelector(sel!(speechRecognitionMetadata))
        && unsafe { result.speechRecognitionMetadata() }.is_some()
}

/// The recognizer's answer: a result, an error, or both.
fn heard(id: u64, result: Option<&SFSpeechRecognitionResult>, error: Option<&NSError>) {
    let mut events = Vec::new();
    let mut done = false;
    let emit = SESSION.with_borrow_mut(|s| {
        let session = s.as_mut().filter(|s| s.id == id)?;
        if let Some(result) = result {
            let text = unsafe { result.bestTranscription().formattedString() }.to_string();
            let last = unsafe { result.isFinal() };
            if last || utterance_ended(result) {
                if let Some(text) = session.phrases.phrase(&text) {
                    events.push(DictationEvent::Phrase { text });
                }
            } else {
                events.push(DictationEvent::Partial {
                    text: session.phrases.partial(&text),
                });
            }
            done |= last;
        }
        if let Some(error) = error {
            if let Some(reason) = classify(&error.domain().to_string(), error.code()) {
                events.push(DictationEvent::Error { reason });
            }
            done = true;
        }
        Some(session.emit.clone())
    });
    let Some(emit) = emit else { return };
    for event in events {
        emit(event);
    }
    if done {
        if let Some(session) = take(|s| s.id == id) {
            end(session, None);
        }
    }
}
