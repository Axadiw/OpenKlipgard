use std::fmt;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use unftp_core::auth::UserDetail;

use crate::metrics;

/// Per-session user context carrying the data needed for S3 operations.
///
/// `Debug` redacts both `username` (email — PII) and `encryption_salt`. Libunftp's
/// `tracing` subsystem captures the whole session context on command-level WARN
/// records via the implicit `self = ?` instrument field; without this redaction
/// every rejected upload writes the operator's email + salt to journald and to
/// any downstream log aggregator. `user_uuid` stays visible — it's the same
/// value already used as the S3 key prefix, and ops needs SOMETHING to
/// correlate a log line with a user. Both `encryption_salt` and `username`
/// (the email) are redacted.
#[derive(Clone)]
pub struct KlipgardUser {
    /// Kept on the struct for parity with libunftp's `Principal.username`
    /// (the authenticator constructs both from the same source) and as the
    /// cache key in `auth.rs`. Never read for logging —
    /// every log site moved to `user_uuid` and the `Debug` impl prints
    /// `<redacted>` rather than this field.
    #[allow(dead_code)]
    pub username: String,
    pub user_uuid: String,
    pub encryption_salt: String,
    /// Whether the API classified this account as the synthetic probe. Only
    /// used to label this server's own metrics; the API owns the decision.
    pub synthetic: bool,
    /// Credential fingerprint from the API at login, replayed to
    /// `session-check` so a changed password cuts this session. `None` (older
    /// API) skips the re-check.
    pub session_epoch: Option<String>,
    /// Set the first time THIS session lists or downloads. Fresh for every
    /// login (`KlipgardUserProvider` replaces it on each PASS) and shared with
    /// the session's data channels, which clone the same `Arc`.
    pub browsed: Arc<AtomicBool>,
}

impl KlipgardUser {
    /// Note that this session listed a directory or downloaded a file.
    ///
    /// WHY: `FtpsCamerasConnectingNothingLanding` compares camera logins with
    /// completed uploads, and a person opening the account in an FTP client
    /// (FileZilla opens a dozen parallel connections, each one a login) used to
    /// look exactly like cameras dying before STOR. A camera uploads; a person
    /// browses. Counting the sessions that browsed lets the alert subtract them.
    /// Counted once per session, however many LISTs it runs.
    pub fn mark_browsing(&self) {
        if !self.browsed.swap(true, Ordering::Relaxed) {
            metrics::global().record_browsing_session(self.synthetic);
        }
    }

    /// This user with a fresh per-session browsing flag.
    pub fn for_new_session(&self) -> Self {
        Self {
            browsed: Arc::new(AtomicBool::new(false)),
            ..self.clone()
        }
    }
}

impl fmt::Debug for KlipgardUser {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KlipgardUser")
            .field("username", &"<redacted>")
            .field("user_uuid", &self.user_uuid)
            .field("encryption_salt", &"<redacted>")
            .finish()
    }
}

impl fmt::Display for KlipgardUser {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "<user {}>", self.user_uuid)
    }
}

impl UserDetail for KlipgardUser {
    fn account_enabled(&self) -> bool {
        true
    }

    fn home(&self) -> Option<&Path> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    ///story: Debug-format `KlipgardUser` nigdy nie ujawnia `encryption_salt` ani `username` (email = PII) — regresje: wyciek soli + wyciek emaila. `user_uuid` zostaje widoczny dla ops.
    #[test]
    fn debug_format_redacts_secret_fields() {
        // Regression test for two leaks:
        //   - #[derive(Debug)] leaked per-user
        //     encryption salts into journald on every libunftp WARN.
        //   - the leftover `username`
        //     field (which IS the user's email) leaked PII into journald +
        //     any downstream log pipeline on every rejected upload.
        let user = KlipgardUser {
            username: "alice@example.com".to_string(),
            user_uuid: "f24450a4-ff34-4052-8eb5-52699a1e9905".to_string(),
            encryption_salt: "NhCZ0UA_ZkzbyUULKUDjAbhVoXlvrVSzdsYxtE44KVA".to_string(),
            synthetic: false,
            session_epoch: None,
            browsed: Arc::default(),
        };
        let dbg = format!("{:?}", user);
        assert!(
            !dbg.contains("NhCZ0UA_ZkzbyUULKUDjAbhVoXlvrVSzdsYxtE44KVA"),
            "Debug impl leaked encryption_salt: {}",
            dbg,
        );
        assert!(
            !dbg.contains("alice@example.com"),
            "Debug impl leaked username (email is PII): {}",
            dbg,
        );
        assert!(dbg.contains("<redacted>"), "Debug impl must mark the redaction");
        // user_uuid stays visible so ops can correlate log lines without PII.
        assert!(dbg.contains("f24450a4"), "user_uuid must remain in Debug output");
    }

    ///story: Display-format `KlipgardUser` nie ujawnia email (był używany w `Display` wcześniej).
    #[test]
    fn display_format_does_not_leak_username() {
        let user = KlipgardUser {
            username: "bob@example.com".to_string(),
            user_uuid: "11111111-2222-3333-4444-555555555555".to_string(),
            encryption_salt: "salt".to_string(),
            synthetic: false,
            session_epoch: None,
            browsed: Arc::default(),
        };
        let s = format!("{}", user);
        assert!(!s.contains("bob@example.com"), "Display leaked email: {}", s);
        assert!(s.contains("11111111"), "Display should still carry user_uuid: {}", s);
    }

    ///story: Klient FTP otwiera kilkanaście równoległych połączeń — każde z nich to logowanie, ale ma się liczyć jako JEDNA sesja przeglądająca tylko raz, a nowe logowanie musi zaczynać z czystą flagą. Inaczej alert o kamerach, które się łączą i nic nie wgrywają, albo dalej budziłby właściciela za przeglądanie konta, albo przestałby widzieć kamery.
    #[test]
    fn browsing_flag_is_per_session_and_set_once() {
        let cached = KlipgardUser {
            username: "carol@example.com".to_string(),
            user_uuid: "22222222-3333-4444-5555-666666666666".to_string(),
            encryption_salt: "salt".to_string(),
            synthetic: false,
            session_epoch: None,
            browsed: Arc::default(),
        };
        let first = cached.for_new_session();
        let data_channel = first.clone();
        data_channel.mark_browsing();
        assert!(first.browsed.load(Ordering::Relaxed), "data channel shares the session flag");
        assert!(
            !cached.for_new_session().browsed.load(Ordering::Relaxed),
            "a new login must start unbrowsed"
        );
        assert!(!cached.browsed.load(Ordering::Relaxed), "the cached template is never marked");
    }
}
