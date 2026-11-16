//! FTPS authenticator delegating to the Klipgard internal API.
//!
//! libunftp calls us on every connect with a username/password pair. We
//! forward the credentials over HTTP (internal API key auth) to the Node
//! server, which owns the bcrypt hashes, ban state, and quota row. Every
//! `PASS` calls the API; no cache ever skips that call ([FTPS-020]).
//!
//! After a successful login the user context is cached by username only (never
//! by password), with a 1-hour TTL. The cache never short-circuits the API; it
//! only hands the session context to libunftp (see `KlipgardUserProvider`).
//!
//! Every refused login, whatever the reason (wrong password, ban, lockout),
//! gets the same generic FTP 530 "Authentication failed" reply. There is no
//! special "account suspended" reply.
use std::fmt;
use std::time::Duration;

use async_trait::async_trait;
use moka::future::Cache;
use tracing::{info, warn};
use unftp_core::auth::{
    AuthenticationError, Authenticator, Credentials, Principal, UserDetailError, UserDetailProvider,
};

use crate::api::InternalApi;
use crate::user::KlipgardUser;

/// Authenticator that verifies credentials against the internal API.
///
/// On successful authentication, caches the user context (uuid, encryption_salt)
/// with a 1-hour TTL (capped at 10 000 entries) so the UserDetailProvider can
/// retrieve it for the same session without extra API calls.
#[derive(Clone)]
pub struct KlipgardAuth {
    api: InternalApi,
    cache: Cache<String, KlipgardUser>,
}

impl fmt::Debug for KlipgardAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // `cache` is a moka Cache<String, _> keyed by the user's email (PII).
        // moka's derived Debug prints every entry as a map, so libunftp's
        // session-level `self = ?` instrument would spill up to 10 000 cached
        // emails into a single WARN record (the per-value `KlipgardUser` Debug
        // redacts username + salt, but the map KEY is the raw email). Redact
        // the whole cache — ops correlates via `user_uuid`, never email.
        f.debug_struct("KlipgardAuth")
            .field("api", &self.api)
            .field("cache", &"<redacted>")
            .finish()
    }
}

impl KlipgardAuth {
    pub fn new(api: InternalApi) -> Self {
        let cache = Cache::builder()
            .time_to_live(Duration::from_secs(3600))
            .max_capacity(10_000)
            .build();
        Self { api, cache }
    }

    /// Get the shared cache (for use by KlipgardUserProvider).
    pub fn cache(&self) -> Cache<String, KlipgardUser> {
        self.cache.clone()
    }
}

#[async_trait]
impl Authenticator for KlipgardAuth {
    async fn authenticate(
        &self,
        username: &str,
        creds: &Credentials,
    ) -> Result<Principal, AuthenticationError> {
        let password = creds
            .password
            .as_deref()
            .ok_or(AuthenticationError::BadPassword)?;

        info!(username = username, "Login attempt");

        let auth_result = self
            .api
            .verify_auth(username, password, creds.source_ip)
            .await
            .map_err(|e| {
                warn!(
                    username = username,
                    error = %e,
                    "Internal API error during authentication"
                );
                AuthenticationError::new(format!("API error: {}", e))
            })?;

        if !auth_result.valid {
            let reason = auth_result
                .reason
                .unwrap_or_else(|| "invalid credentials".to_string());
            info!(username = username, reason = %reason, "Login failed");
            return Err(AuthenticationError::BadPassword);
        }

        let user_uuid = auth_result.user_uuid.ok_or_else(|| {
            warn!(username = username, "Login failed: missing user_uuid");
            AuthenticationError::new("Missing user data")
        })?;

        let encryption_salt = auth_result.encryption_salt.ok_or_else(|| {
            warn!(username = username, "Login failed: missing encryption_salt");
            AuthenticationError::new("Missing user data")
        })?;

        info!(username = username, uuid = %user_uuid, "Login successful");

        let user = KlipgardUser {
            username: username.to_string(),
            user_uuid,
            encryption_salt,
            synthetic: auth_result.origin.as_deref() == Some("synthetic"),
            session_epoch: auth_result.session_epoch,
            browsed: Default::default(),
        };

        // Cache for the UserDetailProvider to retrieve (TTL: 1h, max: 10 000 entries)
        self.cache.insert(username.to_string(), user).await;

        Ok(Principal {
            username: username.to_string(),
        })
    }
}

/// Provides user details from the auth cache.
/// Works together with KlipgardAuth — after authenticate() caches the user data,
/// this provider retrieves it when libunftp needs the full user context.
pub struct KlipgardUserProvider {
    cache: Cache<String, KlipgardUser>,
}

impl fmt::Debug for KlipgardUserProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Same moka cache as `KlipgardAuth` — keyed by email (PII). Redact it
        // wholesale so libunftp's session Debug can't enumerate cached emails.
        f.debug_struct("KlipgardUserProvider")
            .field("cache", &"<redacted>")
            .finish()
    }
}

impl KlipgardUserProvider {
    pub fn new(cache: Cache<String, KlipgardUser>) -> Self {
        Self { cache }
    }
}

#[async_trait]
impl UserDetailProvider for KlipgardUserProvider {
    type User = KlipgardUser;

    async fn provide_user_detail(
        &self,
        principal: &Principal,
    ) -> Result<KlipgardUser, UserDetailError> {
        // libunftp asks once per PASS, so this is where a session begins: hand
        // it its own browsing flag rather than the cached entry's.
        self.cache
            .get(&principal.username)
            .await
            .map(|u| u.for_new_session())
            .ok_or_else(|| {
                UserDetailError::new(format!("User {} not found in cache", principal.username))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_user() -> KlipgardUser {
        KlipgardUser {
            username: "alice@example.com".to_string(),
            user_uuid: "f24450a4-ff34-4052-8eb5-52699a1e9905".to_string(),
            encryption_salt: "NhCZ0UA_ZkzbyUULKUDjAbhVoXlvrVSzdsYxtE44KVA".to_string(),
            synthetic: false,
            session_epoch: None,
            browsed: Default::default(),
        }
    }

    ///story: Debug-format `KlipgardUserProvider` nie ujawnia żadnego e-maila z cache — moka `Cache<String, _>` jest kluczowana e-mailem (PII), a libunftp Debug-uje całą sesję na WARN. Redakcja pola w `KlipgardUser` nie wystarcza, bo Debug mapy drukuje KLUCZE. Regresja: wyciek PII przez klucz cache.
    #[tokio::test]
    async fn provider_debug_does_not_leak_cached_emails() {
        let cache: Cache<String, KlipgardUser> = Cache::builder().build();
        cache.insert("alice@example.com".to_string(), sample_user()).await;
        cache.run_pending_tasks().await;

        let provider = KlipgardUserProvider::new(cache);
        let dbg = format!("{:?}", provider);

        assert!(
            !dbg.contains("alice@example.com"),
            "KlipgardUserProvider Debug leaked a cached email (moka cache key is PII): {}",
            dbg,
        );
        assert!(
            !dbg.contains("NhCZ0UA_ZkzbyUULKUDjAbhVoXlvrVSzdsYxtE44KVA"),
            "KlipgardUserProvider Debug leaked encryption_salt: {}",
            dbg,
        );
    }

    ///story: Debug-format `KlipgardAuth` nie ujawnia e-maili z cache ani `api_key` — ten sam wektor (klucz moka = e-mail) co provider, plus regresja na maskowaniu klucza API w `InternalApi`.
    #[tokio::test]
    async fn auth_debug_does_not_leak_cached_emails_or_api_key() {
        let api = InternalApi::new("http://internal.test", "test-api-key");
        let auth = KlipgardAuth::new(api);
        auth.cache()
            .insert("bob@example.com".to_string(), sample_user())
            .await;
        auth.cache().run_pending_tasks().await;

        let dbg = format!("{:?}", auth);

        assert!(
            !dbg.contains("bob@example.com"),
            "KlipgardAuth Debug leaked a cached email (moka cache key is PII): {}",
            dbg,
        );
        assert!(
            !dbg.contains("test-api-key"),
            "KlipgardAuth Debug leaked api_key: {}",
            dbg,
        );
    }
}
