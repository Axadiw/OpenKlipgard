use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use dashmap::DashMap;
use moka::future::Cache;
use serde::{Deserialize, Serialize};

/// How long a pooled connection to the API may sit idle before the client drops it
/// ([FTPS-156]). It MUST stay below the API listener's keep-alive ([API-CORE-076], 120 s):
/// otherwise the next request goes out on a connection the API closes at that moment and
/// fails with `error sending request`, which a login turns into `530`.
const API_POOL_IDLE_SECS: u64 = 30;
/// The API listener's keep-alive, for the check in the unit test below.
#[cfg(test)]
const API_LISTENER_KEEP_ALIVE_SECS: u64 = 120;
/// Pause before the one repeat of a login verification that failed without an HTTP answer.
const VERIFY_RETRY_DELAY_MS: u64 = 150;

fn internal_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .pool_idle_timeout(Duration::from_secs(API_POOL_IDLE_SECS))
        .build()
        .expect("the internal API HTTP client must build")
}

/// HTTP client for the internal API (klipgard-api service).
///
/// `Debug` is implemented manually with `api_key` redacted — the default
/// `#[derive(Debug)]` would print the full shared secret whenever libunftp's
/// `tracing` subsystem captures the session context on a WARN/ERROR record.
/// The switch was made because journald otherwise contained `api_key: "…"`
/// literal strings on every CWD-to-nonexistent-dir warning.
#[derive(Clone)]
pub struct InternalApi {
    base_url: String,
    api_key: String,
    client: reqwest::Client,
    /// In-process cache of the `/internal/users/:uuid/transfer-check` result.
    /// Short TTL: quota state is mutable; staleness must stay within seconds.
    /// Serves both RETR (`storage.rs::get`) and STOR (`storage.rs::put`) hot paths.
    transfer_cache: Cache<String, TransferCheckResponse>,
    /// In-process cache of the `GET /internal/users/:uuid/quota` result, used
    /// for the STOR disk-headroom pre-check. Same short TTL as
    /// `transfer_cache` — disk usage is mutable and staleness must stay within
    /// seconds. The pre-check is advisory/early-reject only — brief staleness
    /// never lets a real over-quota write commit (file_complete is the
    /// authoritative gate post-upload).
    quota_cache: Cache<String, QuotaResponse>,
    /// Verdict of `POST /internal/users/:uuid/session-check`, keyed
    /// `"{uuid}:{epoch}"` so a different credential epoch never reads another's
    /// answer. TTL `SESSION_CHECK_TTL_SECS` (default 30 s): that is how long an
    /// already-open FTP session may outlive a ban / lock / credential change.
    /// Only definite answers are cached; a failed lookup is not (fail-open).
    session_cache: Cache<String, bool>,
    /// Accumulator for per-user download transfer bytes. Flushed every 10 s
    /// by the background task in main.rs with one POST per user. Replaces
    /// a per-RETR report_usage call on the hot path.
    pending_transfer: Arc<DashMap<String, AtomicI64>>,
}

impl fmt::Debug for InternalApi {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InternalApi")
            .field("base_url", &self.base_url)
            .field("api_key", &"<redacted>")
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Deserialize)]
pub struct AuthResponse {
    pub valid: bool,
    #[serde(rename = "userUuid")]
    pub user_uuid: Option<String>,
    #[serde(rename = "encryptionSalt")]
    pub encryption_salt: Option<String>,
    pub reason: Option<String>,
    /// The answers that carry no `reason` (FTPS-023): failed-login backoff,
    /// a ban, a source address locked for credential spraying.
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub banned: bool,
    #[serde(rename = "ipLocked", default)]
    pub ip_locked: bool,
    /// Fingerprint of the credential this login was checked against; sent back
    /// to `session-check`. Absent from an older API, which skips the re-check.
    #[serde(rename = "sessionEpoch")]
    pub session_epoch: Option<String>,
    /// `organic` | `synthetic`. Absent from an older API, which reads as organic.
    pub origin: Option<String>,
}

impl AuthResponse {
    /// The reason the `Login failed` log line names (FTPS-023). A refusal without
    /// any of them is a wrong password or an unknown account.
    pub fn failure_reason(&self) -> String {
        if self.ip_locked {
            "ipLocked".to_string()
        } else if self.banned {
            "banned".to_string()
        } else if self.locked {
            "locked".to_string()
        } else {
            self.reason
                .clone()
                .unwrap_or_else(|| "invalid credentials".to_string())
        }
    }
}

#[derive(Debug, Deserialize)]
struct SessionCheckResponse {
    valid: bool,
    #[allow(dead_code)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct TransferCheckResponse {
    #[serde(rename = "withinLimit")]
    pub within_limit: bool,
}

/// Subset of the `GET /internal/users/:uuid/quota` response (server-side
/// `UserQuota` in `server/types.ts`). Only the disk fields are deserialized —
/// serde drops the transfer fields we don't read here. `diskLimitBytes == 0`
/// means "no plan limit / unlimited" (matching the server's own convention,
/// e.g. `quota.diskLimitBytes > 0` gates in `internal.ts`), so headroom is
/// treated as effectively infinite in that case.
#[derive(Debug, Deserialize, Clone)]
pub struct QuotaResponse {
    #[serde(rename = "diskUsageBytes")]
    pub disk_usage_bytes: i64,
    #[serde(rename = "diskLimitBytes")]
    pub disk_limit_bytes: i64,
    /// The user's `auto_delete_oldest` flag, exposed by
    /// `GET /internal/users/:uuid/quota`. `None` when the field is absent (an
    /// older API, or a cache entry populated before this field existed) — the
    /// upload-cap logic treats `None` as "unknown" and falls back to the full
    /// sanity cap (fail-open to today's accept-then-tidy behavior), never the
    /// tighter headroom cap.
    #[serde(rename = "autoDeleteOldest", default)]
    pub auto_delete_oldest: Option<bool>,
}

impl QuotaResponse {
    /// Remaining disk headroom in bytes, clamped at zero. Returns `i64::MAX`
    /// when the user has no plan limit (`disk_limit_bytes <= 0`) so callers
    /// never early-reject an unlimited account.
    pub fn disk_headroom_bytes(&self) -> i64 {
        if self.disk_limit_bytes <= 0 {
            return i64::MAX;
        }
        (self.disk_limit_bytes - self.disk_usage_bytes).max(0)
    }

    /// Per-upload streaming byte cap. For a limited plan with
    /// auto-delete explicitly OFF, cap the stream at the user's remaining disk
    /// headroom so an over-quota STOR aborts at the headroom boundary instead of
    /// streaming up to `sanity_cap` (100 GiB) before the authoritative
    /// post-upload claim rejects and deletes it. This bounds the per-user
    /// concurrent-upload TOCTOU over-commit from `sanity_cap × N` down to
    /// `~headroom × N`.
    ///
    /// Returns the full `sanity_cap` (i.e. NO narrowing) for:
    /// - unlimited plans (`disk_limit_bytes <= 0`),
    /// - auto-delete-ON accounts (`Some(true)`) — they may legitimately
    ///   over-commit and rely on the background tidy, so capping them would
    ///   break the documented "always succeed then tidy" path, and
    /// - unknown flag (`None`) — fail open to today's behavior.
    ///
    /// Never WIDENS past `sanity_cap` (uses `min`), so a huge-headroom account
    /// still hits the 100 GiB per-file safety bound.
    pub fn upload_stream_cap(&self, sanity_cap: i64) -> i64 {
        if self.disk_limit_bytes > 0 && self.auto_delete_oldest == Some(false) {
            self.disk_headroom_bytes().min(sanity_cap)
        } else {
            sanity_cap
        }
    }
}

#[derive(Debug, Serialize)]
struct AuthRequest {
    username: String,
    password: String,
}

#[derive(Debug, Serialize)]
struct UsageReport {
    #[serde(rename = "diskDelta")]
    disk_delta: i64,
    #[serde(rename = "transferDelta")]
    transfer_delta: i64,
}

#[derive(Debug, Serialize)]
struct FileUploadedRequest {
    #[serde(rename = "s3Bucket")]
    s3_bucket: String,
    #[serde(rename = "s3Key")]
    s3_key: String,
    #[serde(rename = "originalFilename")]
    original_filename: String,
    #[serde(rename = "fileSizeBytes")]
    file_size_bytes: i64,
    /// The client cut the transfer short — the object is a valid but SHORTER
    /// clip than the camera recorded. Skipped when false so the legacy
    /// `/file-uploaded` payload shape is untouched.
    #[serde(rename = "truncated", skip_serializing_if = "std::ops::Not::not")]
    truncated: bool,
}

#[derive(Debug, serde::Deserialize)]
pub struct FileCompleteResponse {
    /// Server-level success flag (mirrors the JSON `ok` field). The caller
    /// uses `claimed` for routing; `ok` is retained for debug logging and
    /// future consumers.
    #[allow(dead_code)]
    pub ok: bool,
    pub claimed: bool,
    #[serde(default)]
    pub state: Option<String>,
    /// Why a 507 refused the file: `quota_exceeded` or `access_locked`
    /// ([FTPS-074]). Absent on success and on an older API.
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct NotificationRequest {
    #[serde(rename = "userUuid")]
    user_uuid: String,
    kind: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<serde_json::Value>,
}

impl InternalApi {
    pub fn new(base_url: &str, api_key: &str) -> Self {
        // CACHE_TTL_SECS env var overrides the default 10s TTL. Useful for
        // CI / e2e tests that need quota state to refresh quickly.
        let ttl_secs: u64 = std::env::var("CACHE_TTL_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(10);
        let transfer_cache = Cache::builder()
            .time_to_live(Duration::from_secs(ttl_secs))
            .max_capacity(10_000)
            .build();
        let quota_cache = Cache::builder()
            .time_to_live(Duration::from_secs(ttl_secs))
            .max_capacity(10_000)
            .build();
        let session_ttl_secs: u64 = std::env::var("SESSION_CHECK_TTL_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30);
        let session_cache = Cache::builder()
            .time_to_live(Duration::from_secs(session_ttl_secs))
            .max_capacity(10_000)
            .build();
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
            client: internal_http_client(),
            transfer_cache,
            quota_cache,
            session_cache,
            pending_transfer: Arc::new(DashMap::new()),
        }
    }

    pub async fn verify_auth(
        &self,
        username: &str,
        password: &str,
        client_ip: std::net::IpAddr,
    ) -> Result<AuthResponse, reqwest::Error> {
        // [FTPS-156] A request that failed without any HTTP answer (refused or reset
        // connection) is sent once more: the verification only records the login, so
        // repeating it is safe. An HTTP status or a `valid: false` answer is final.
        match self.verify_auth_once(username, password, client_ip).await {
            Err(e) if e.status().is_none() => {
                tracing::warn!(error = %e, "auth verify: transport error, repeating once");
                tokio::time::sleep(Duration::from_millis(VERIFY_RETRY_DELAY_MS)).await;
                self.verify_auth_once(username, password, client_ip).await
            }
            other => other,
        }
    }

    async fn verify_auth_once(
        &self,
        username: &str,
        password: &str,
        client_ip: std::net::IpAddr,
    ) -> Result<AuthResponse, reqwest::Error> {
        let resp = self
            .client
            .post(format!("{}/internal/auth/verify", self.base_url))
            .header("X-Internal-Key", &self.api_key)
            // Forward the real camera/client IP so the API can throttle
            // credential-spray per source IP across many usernames. The FTPS
            // pod's own IP (which the API's `req.ip` would otherwise see) is
            // shared by the whole camera fleet and useless — dangerous, even —
            // as a throttle key. Sent as a dedicated header so the JSON auth
            // contract stays stable.
            .header("X-Real-Client-IP", client_ip.to_string())
            .json(&AuthRequest {
                username: username.to_string(),
                password: password.to_string(),
            })
            .send()
            .await?
            .error_for_status()?
            .json::<AuthResponse>()
            .await?;
        Ok(resp)
    }

    pub async fn report_usage(
        &self,
        user_uuid: &str,
        disk_delta: i64,
        transfer_delta: i64,
    ) -> Result<(), reqwest::Error> {
        self.client
            .post(format!(
                "{}/internal/users/{}/usage",
                self.base_url, user_uuid
            ))
            .header("X-Internal-Key", &self.api_key)
            .json(&UsageReport {
                disk_delta,
                transfer_delta,
            })
            .send()
            .await?
            .error_for_status()?;
        if transfer_delta != 0 {
            self.invalidate_transfer(user_uuid).await;
        }
        // A disk-usage change (e.g. a DELETE freeing space) must drop the cached
        // quota so the next STOR's headroom-based upload cap reflects
        // reality — otherwise a user who just deleted a large file could see a
        // stale-low cap reject an upload that now fits, for up to the cache TTL.
        if disk_delta != 0 {
            self.invalidate_quota(user_uuid).await;
        }
        Ok(())
    }

    /// Synchronous transactional ingest (R1). Retries transient failures
    /// with backoff; the caller maps Err -> FTP transfer error (camera
    /// retransmits). A 507 response is NOT an error: quota rejected
    /// (claimed=false).
    ///
    /// Retry policy: 4 attempts total with sleeps of 200 ms, 600 ms, 1800 ms
    /// between attempts. Permanent 4xx → immediate Err (no retry). Transport
    /// error or 5xx → retry; after exhaustion returns Err(last error message).
    pub async fn file_complete(
        &self,
        user_uuid: &str,
        s3_bucket: &str,
        s3_key: &str,
        original_filename: &str,
        file_size_bytes: i64,
        truncated: bool,
    ) -> Result<FileCompleteResponse, String> {
        let body = FileUploadedRequest {
            s3_bucket: s3_bucket.to_string(),
            s3_key: s3_key.to_string(),
            original_filename: original_filename.to_string(),
            file_size_bytes,
            truncated,
        };
        let url = format!(
            "{}/internal/users/{}/file-complete",
            self.base_url, user_uuid
        );
        // Sleeps between attempts (ms): 200, 600, 1800 → 4 total attempts.
        let retry_delays_ms: &[u64] = &[200, 600, 1800];
        let mut last_err: String = String::new();
        let attempt_count = retry_delays_ms.len() + 1;
        for attempt in 0..attempt_count {
            let result = self
                .client
                .post(&url)
                .header("X-Internal-Key", &self.api_key)
                .json(&body)
                .send()
                .await;
            match result {
                Err(e) => {
                    last_err = e.to_string();
                    tracing::warn!(
                        error = %last_err,
                        key = %s3_key,
                        attempt = attempt + 1,
                        "file_complete: transport error, will retry"
                    );
                }
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() || status == reqwest::StatusCode::INSUFFICIENT_STORAGE {
                        return resp
                            .json::<FileCompleteResponse>()
                            .await
                            .map_err(|e| e.to_string());
                    }
                    if status.is_client_error() {
                        // 4xx (except 507 handled above) — permanent failure, no retry.
                        let msg = format!("file_complete: permanent error status {status} for key {s3_key}");
                        tracing::warn!(%msg);
                        return Err(msg);
                    }
                    // 5xx — transient, retry.
                    last_err = format!("file_complete: server error status {status} for key {s3_key}");
                    tracing::warn!(
                        error = %last_err,
                        attempt = attempt + 1,
                        "file_complete: server error, will retry"
                    );
                }
            }
            if attempt < retry_delays_ms.len() {
                tokio::time::sleep(std::time::Duration::from_millis(retry_delays_ms[attempt])).await;
            }
        }
        Err(last_err)
    }

    /// Fire-and-forget user-facing notification (e.g. quota exceeded, invalid upload).
    /// Logs errors but never propagates them — notifications are best-effort.
    pub async fn publish_notification(
        &self,
        user_uuid: &str,
        kind: &str,
        message: &str,
        details: Option<serde_json::Value>,
    ) {
        let body = NotificationRequest {
            user_uuid: user_uuid.to_string(),
            kind: kind.to_string(),
            message: message.to_string(),
            details,
        };
        let result = self
            .client
            .post(format!("{}/internal/notifications", self.base_url))
            .header("X-Internal-Key", &self.api_key)
            .json(&body)
            .send()
            .await;
        match result {
            Ok(resp) if resp.status().is_success() => {}
            Ok(resp) => {
                tracing::warn!(
                    "publish_notification: status {} for user {} kind {}",
                    resp.status(),
                    user_uuid,
                    kind,
                );
            }
            Err(e) => {
                tracing::warn!(
                    "publish_notification: {} (user {}, kind {})",
                    e,
                    user_uuid,
                    kind
                );
            }
        }
    }

    /// Report a STOR the client abandoned mid-stream so the API can count it
    /// on `klipgard_ftps_uploads_aborted_total`. Best-effort by design: this
    /// runs from a cancelled task's teardown, where the only alternative to a
    /// dropped report is a dropped signal entirely.
    ///
    /// `ext` must already be bucketed (`mp4` / `jpg` / `other`) — the label is
    /// a bounded enum and the API re-buckets defensively.
    ///
    /// `user_uuid` is sent so the API can tell a customer's lost recording from
    /// the synthetic probe's own timed-out upload; it decides the bounded
    /// `origin` label there and never becomes a label itself. The
    /// classification deliberately lives in the API, which already owns the
    /// synthetic-account list — this server just reports who it was serving.
    pub async fn report_upload_aborted(&self, ext: &str, user_uuid: &str) {
        let result = self
            .client
            .post(format!("{}/internal/ftps/upload-aborted", self.base_url))
            .header("X-Internal-Key", &self.api_key)
            .json(&serde_json::json!({ "ext": ext, "userUuid": user_uuid }))
            .send()
            .await;
        match result {
            Ok(resp) if resp.status().is_success() => {}
            Ok(resp) => {
                tracing::warn!("report_upload_aborted: status {}", resp.status());
            }
            Err(e) => {
                tracing::warn!("report_upload_aborted: {}", e);
            }
        }
    }

    async fn check_transfer_uncached(
        &self,
        user_uuid: &str,
    ) -> Result<TransferCheckResponse, reqwest::Error> {
        let resp = self
            .client
            .post(format!(
                "{}/internal/users/{}/transfer-check",
                self.base_url, user_uuid
            ))
            .header("X-Internal-Key", &self.api_key)
            .send()
            .await?
            .error_for_status()?
            .json::<TransferCheckResponse>()
            .await?;
        Ok(resp)
    }

    pub async fn check_transfer(
        &self,
        user_uuid: &str,
    ) -> Result<TransferCheckResponse, reqwest::Error> {
        if let Some(cached) = self.transfer_cache.get(user_uuid).await {
            return Ok(cached);
        }
        let fresh = self.check_transfer_uncached(user_uuid).await?;
        self.transfer_cache
            .insert(user_uuid.to_string(), fresh.clone())
            .await;
        Ok(fresh)
    }

    /// Whether an already-open FTP session may keep going: false once the API
    /// says the account was banned/locked/deactivated/deleted or the credential
    /// the session logged in with has changed. Cached for the session TTL.
    ///
    /// Fails OPEN: a transport error, a 5xx or a 404 (an older API without the
    /// route during a rollout) logs a warning and allows, uncached. An API
    /// outage already stops new logins and `file-complete`; it must not also
    /// cut every camera mid-upload.
    pub async fn check_session(&self, user_uuid: &str, epoch: &str) -> bool {
        let key = format!("{}:{}", user_uuid, epoch);
        if let Some(cached) = self.session_cache.get(&key).await {
            return cached;
        }
        let result = self
            .client
            .post(format!(
                "{}/internal/users/{}/session-check",
                self.base_url, user_uuid
            ))
            .header("X-Internal-Key", &self.api_key)
            .json(&serde_json::json!({ "sessionEpoch": epoch }))
            .send()
            .await;
        let parsed = match result {
            Ok(resp) if resp.status().is_success() => {
                resp.json::<SessionCheckResponse>().await.map_err(|e| e.to_string())
            }
            Ok(resp) => Err(format!("status {}", resp.status())),
            Err(e) => Err(e.to_string()),
        };
        match parsed {
            Ok(r) => {
                self.session_cache.insert(key, r.valid).await;
                r.valid
            }
            Err(e) => {
                tracing::warn!("session-check unavailable, allowing session: {}", e);
                true
            }
        }
    }

    /// Drop the cached transfer-check for a user. Relies on the API endpoint
    /// at `server/routes/internal.ts::/users/:uuid/usage` committing the DB
    /// row BEFORE responding — that ordering is what makes the subsequent
    /// `check_transfer_uncached` see fresh data.
    pub(crate) async fn invalidate_transfer(&self, user_uuid: &str) {
        self.transfer_cache.invalidate(user_uuid).await;
    }

    /// Drop the cached quota for a user. Called after a disk-usage change so the
    /// headroom upload cap recomputes from fresh disk usage.
    pub(crate) async fn invalidate_quota(&self, user_uuid: &str) {
        self.quota_cache.invalidate(user_uuid).await;
    }

    async fn fetch_quota_uncached(
        &self,
        user_uuid: &str,
    ) -> Result<QuotaResponse, reqwest::Error> {
        // GET /internal/users/:uuid/quota — admin/internal route gated by the
        // same X-Internal-Key middleware as transfer-check. Returns the full
        // server-side `UserQuota`; we deserialize only the disk fields.
        let resp = self
            .client
            .get(format!(
                "{}/internal/users/{}/quota",
                self.base_url, user_uuid
            ))
            .header("X-Internal-Key", &self.api_key)
            .send()
            .await?
            .error_for_status()?
            .json::<QuotaResponse>()
            .await?;
        Ok(resp)
    }

    /// Fetch the user's current disk usage + cap (cached, short TTL). Mirrors
    /// the `check_transfer` cache pattern. Used by the STOR disk-headroom
    /// pre-check to early-reject uploads from accounts that already
    /// have zero headroom, before any bytes stream to S3.
    pub async fn fetch_quota(
        &self,
        user_uuid: &str,
    ) -> Result<QuotaResponse, reqwest::Error> {
        if let Some(cached) = self.quota_cache.get(user_uuid).await {
            return Ok(cached);
        }
        let fresh = self.fetch_quota_uncached(user_uuid).await?;
        self.quota_cache
            .insert(user_uuid.to_string(), fresh.clone())
            .await;
        Ok(fresh)
    }

    /// Enqueue a download transfer delta for the given user. Replaces a
    /// per-RETR report_usage call on the hot path — see Fix 0B in the
    /// perf optimization plan. Drained by `flush_transfer`.
    pub fn enqueue_download_transfer(&self, user_uuid: &str, bytes: i64) {
        if bytes <= 0 {
            return;
        }
        self.pending_transfer
            .entry(user_uuid.to_string())
            .or_insert_with(|| AtomicI64::new(0))
            .fetch_add(bytes, Ordering::Relaxed);
    }

    /// Drain the in-process transfer aggregator, sending one `report_usage`
    /// POST per user with the accumulated total. Errors per user are logged
    /// and the bytes are returned to the queue so the next flush retries.
    /// Caller-driven: the 10 s interval task in main.rs invokes this, and a
    /// final drain runs at shutdown so in-flight bytes don't silently vanish
    /// (best-effort — SIGKILL still loses whatever's queued).
    ///
    /// Concurrent enqueues during drain are safe: swap(0) atomically claims
    /// the bytes we're about to POST, and any fetch_add that wins the race
    /// after our swap accumulates into the next flush window.
    ///
    /// Each successful per-user POST invalidates that user's transfer_cache
    /// entry (via report_usage), keeping Fix 0A's staleness contract honest.
    pub async fn flush_transfer(&self) {
        let drained: Vec<(String, i64)> = self
            .pending_transfer
            .iter()
            .filter_map(|e| {
                let n = e.value().swap(0, Ordering::Relaxed);
                if n == 0 { None } else { Some((e.key().clone(), n)) }
            })
            .collect();

        for (uuid, bytes) in drained {
            if let Err(e) = self.report_usage(&uuid, 0, bytes).await {
                tracing::warn!(
                    error = %e, user = %uuid, bytes,
                    "flush_transfer: report_usage failed, re-queueing"
                );
                self.enqueue_download_transfer(&uuid, bytes);
            }
        }
    }
}

#[cfg(test)]
mod tests {

    ///story: [FTPS-023] Linia `Login failed` nazywa blokadę: odpowiedź `locked`/`banned`/`ipLocked` nie ma pola `reason`, a log pisał „invalid credentials” i wyglądało to na złe hasło (kamery właściciela, 2026-11-17).
    #[test]
    fn failure_reason_names_lockouts_and_bans() {
        let r = |j: &str| serde_json::from_str::<AuthResponse>(j).unwrap().failure_reason();
        assert_eq!(r(r#"{"valid":false}"#), "invalid credentials");
        assert_eq!(r(r#"{"valid":false,"locked":true,"lockedUntil":"2026-11-17T08:43:36Z"}"#), "locked");
        assert_eq!(r(r#"{"valid":false,"banned":true,"bannedUntil":null,"reason":null}"#), "banned");
        assert_eq!(r(r#"{"valid":false,"ipLocked":true}"#), "ipLocked");
        assert_eq!(r(r#"{"valid":false,"reason":"access_locked"}"#), "access_locked");
    }
    use super::*;

    ///story: Połączenie z API, które FTPS trzyma w puli, wygasa wcześniej niż keep-alive nasłuchu API — dzięki temu logowanie nigdy nie idzie po połączeniu, które API właśnie zamyka (to dawało losowe 530 dla świeżego użytkownika).
    #[test]
    fn pooled_api_connection_expires_before_the_api_closes_it() {
        const { assert!(API_POOL_IDLE_SECS < API_LISTENER_KEEP_ALIVE_SECS) };
    }

    /// One-shot HTTP server for the retry tests: the first `drop_first` connections are
    /// closed without an answer, every later one gets `body` as a JSON 200.
    async fn mock_api(drop_first: usize, body: &'static str) -> (String, Arc<AtomicI64>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicI64::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                let n = counter.fetch_add(1, Ordering::SeqCst) as usize;
                if n < drop_first {
                    drop(sock); // no HTTP answer at all
                    continue;
                }
                let mut buf = vec![0u8; 8192];
                let _ = sock.read(&mut buf).await;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });
        (url, hits)
    }

    ///story: Logowanie, którego żądanie do API padło bez żadnej odpowiedzi HTTP (połączenie odrzucone lub zerwane), jest powtarzane raz i przechodzi — kamera nie dostaje 530 przez jednorazowy błąd transportu.
    #[tokio::test]
    async fn verify_auth_repeats_once_after_a_transport_error() {
        let (url, hits) = mock_api(1, r#"{"valid":false,"reason":"invalid credentials"}"#).await;
        let api = InternalApi::new(&url, "k");
        let r = api
            .verify_auth("u", "p", "127.0.0.1".parse().unwrap())
            .await
            .expect("the repeat must reach the API");
        assert!(!r.valid);
        assert_eq!(hits.load(Ordering::SeqCst), 2, "one failed request and one repeat");
    }

    ///story: Błąd transportu, który się powtarza, kończy logowanie błędem po jednym powtórzeniu — serwer nie zapętla się na niedostępnym API.
    #[tokio::test]
    async fn verify_auth_gives_up_after_one_repeat() {
        let (url, hits) = mock_api(usize::MAX, "{}").await;
        let api = InternalApi::new(&url, "k");
        let r = api.verify_auth("u", "p", "127.0.0.1".parse().unwrap()).await;
        assert!(r.is_err());
        assert_eq!(hits.load(Ordering::SeqCst), 2, "exactly two attempts");
    }

    ///story: Odpowiedź z kodem HTTP (np. 500) kończy weryfikację od razu, bez powtórzenia — powtórka dotyczy tylko braku jakiejkolwiek odpowiedzi.
    #[tokio::test]
    async fn verify_auth_does_not_repeat_after_an_http_status() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicI64::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                counter.fetch_add(1, Ordering::SeqCst);
                let mut buf = vec![0u8; 8192];
                let _ = sock.read(&mut buf).await;
                let _ = sock
                    .write_all(b"HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                    .await;
            }
        });
        let api = InternalApi::new(&url, "k");
        let r = api.verify_auth("u", "p", "127.0.0.1".parse().unwrap()).await;
        assert!(r.is_err());
        assert_eq!(hits.load(Ordering::SeqCst), 1, "a 5xx is final, not repeated");
    }

    ///story: Debug-format `InternalApi` nie wypuszcza współdzielonego klucza API do logów — regresja: domyślny derive(Debug) wyciekał klucz do journald.
    #[tokio::test]
    async fn debug_format_redacts_api_key() {
        // Regression test: libunftp's
        // tracing subsystem captures the session context on WARN records, and
        // the default #[derive(Debug)] on InternalApi leaked the shared
        // internal API key into journald. The manual Debug impl must redact.
        let api = InternalApi::new("http://127.0.0.1:1", "super-secret-shared-key-xxxxxxxxxxxxx");
        let dbg = format!("{:?}", api);
        assert!(
            !dbg.contains("super-secret-shared-key"),
            "Debug impl leaked api_key: {}",
            dbg,
        );
        assert!(dbg.contains("<redacted>"), "Debug impl must mark the redaction");
    }

    ///story: Sprawdzenie limitu transferu przy cache-hit nie wysyła HTTP-ki do API — ogranicza narzut na każdy upload i chroni przed cascade-failure gdy API jest wolne.
    #[tokio::test]
    async fn check_transfer_returns_cached_value_without_http() {
        // Non-routable URL — any real HTTP call would error within milliseconds
        let api = InternalApi::new("http://127.0.0.1:1", "test-key");

        // Pre-populate the cache for uuid "u1"
        api.transfer_cache
            .insert(
                "u1".to_string(),
                TransferCheckResponse { within_limit: true },
            )
            .await;

        // Should hit the cache, never touch HTTP
        let r = api.check_transfer("u1").await.expect("cache hit must succeed");
        assert!(r.within_limit);
    }

    ///story: Invalidacja cache'u transferu faktycznie usuwa wpis, więc kolejny `check_transfer` sięga do API po świeży stan — kluczowe po ręcznym zresetowaniu quoty operatora.
    #[tokio::test]
    async fn invalidate_transfer_removes_cached_value() {
        let api = InternalApi::new("http://127.0.0.1:1", "test-key");

        api.transfer_cache
            .insert(
                "u2".to_string(),
                TransferCheckResponse { within_limit: false },
            )
            .await;

        // Sanity: entry exists
        assert!(api.transfer_cache.get("u2").await.is_some());

        api.invalidate_transfer("u2").await;

        // Entry gone — next check_transfer would try HTTP and fail fast
        assert!(api.transfer_cache.get("u2").await.is_none());

        // Confirm next check_transfer actually attempts HTTP and errors
        let err = api.check_transfer("u2").await;
        assert!(err.is_err(), "post-invalidate call must try HTTP and error");
    }

    ///story: Kolejne porcje pobranych bajtów kumulują się per-user w bufferze FTPS zanim trafią w batchu do API — zapewnia poprawną księgowość transferu bez HTTP-call na każdy chunk.
    #[tokio::test]
    async fn enqueue_accumulates_bytes_per_user() {
        let api = InternalApi::new("http://127.0.0.1:1", "test-key");
        api.enqueue_download_transfer("u1", 1024);
        api.enqueue_download_transfer("u1", 2048);
        api.enqueue_download_transfer("u2", 512);

        assert_eq!(
            api.pending_transfer.get("u1").unwrap().load(Ordering::Relaxed),
            3072
        );
        assert_eq!(
            api.pending_transfer.get("u2").unwrap().load(Ordering::Relaxed),
            512
        );
    }

    ///story: Enqueue z zerem lub ujemną liczbą bajtów to no-op — chroni księgowość transferu przed przypadkową korekcją w złą stronę z buggy callsite.
    #[tokio::test]
    async fn enqueue_rejects_non_positive() {
        let api = InternalApi::new("http://127.0.0.1:1", "test-key");
        api.enqueue_download_transfer("u", 0);
        api.enqueue_download_transfer("u", -100);
        assert!(api.pending_transfer.get("u").is_none(),
            "zero and negative enqueues must be no-ops");
    }

    ///story: Headroom dysku liczy się jako limit−użycie z podłogą w zerze, a brak limitu (0) traktujemy jako nieograniczony — gwarantuje, że pre-check STOR nigdy nie odrzuci konta bez planu i nie zwróci ujemnej wartości.
    #[test]
    fn disk_headroom_computes_and_treats_zero_limit_as_unlimited() {
        // Normal case: limit − usage.
        let q = QuotaResponse { disk_usage_bytes: 300, disk_limit_bytes: 1000, auto_delete_oldest: None };
        assert_eq!(q.disk_headroom_bytes(), 700);

        // At/over cap clamps to zero — this is the early-reject trigger.
        let full = QuotaResponse { disk_usage_bytes: 1000, disk_limit_bytes: 1000, auto_delete_oldest: None };
        assert_eq!(full.disk_headroom_bytes(), 0);
        let over = QuotaResponse { disk_usage_bytes: 1500, disk_limit_bytes: 1000, auto_delete_oldest: None };
        assert_eq!(over.disk_headroom_bytes(), 0);

        // No plan limit (0 = unlimited, matching server convention) → infinite.
        let unlimited = QuotaResponse { disk_usage_bytes: 9_999, disk_limit_bytes: 0, auto_delete_oldest: None };
        assert_eq!(unlimited.disk_headroom_bytes(), i64::MAX);
    }

    ///story: Limit STOR-streamu zwęża się do headroomu TYLKO dla planu z limitem i wyłączonym auto-delete — over-quota upload przerywa się na granicy headroomu zamiast lecieć do 100 GiB (zawężenie okna TOCTOU), nigdy nie przekraczając sanity-capu.
    #[test]
    fn upload_stream_cap_narrows_only_for_limited_non_autodelete() {
        const SANITY: i64 = 100 * 1024 * 1024 * 1024;

        // Limited plan + auto-delete OFF + headroom < sanity → cap at headroom.
        let near_cap = QuotaResponse {
            disk_usage_bytes: 900,
            disk_limit_bytes: 1000,
            auto_delete_oldest: Some(false),
        };
        assert_eq!(near_cap.upload_stream_cap(SANITY), 100);

        // Same flags but headroom > sanity → never widen past the sanity cap.
        let lots_of_room = QuotaResponse {
            disk_usage_bytes: 0,
            disk_limit_bytes: i64::MAX,
            auto_delete_oldest: Some(false),
        };
        assert_eq!(lots_of_room.upload_stream_cap(SANITY), SANITY);
    }

    ///story: Auto-delete-ON, plan bez limitu oraz nieznana flaga (None) zachowują pełny sanity-cap — fail-open do dzisiejszego "always succeed then tidy", żeby fix zawężający okno TOCTOU nigdy nie odrzucił legalnego uploadu kont, które mają prawo chwilowo przekroczyć plan.
    #[test]
    fn upload_stream_cap_keeps_sanity_for_autodelete_unlimited_unknown() {
        const SANITY: i64 = 100 * 1024 * 1024 * 1024;

        // Auto-delete ON → full sanity cap (may over-commit then tidy).
        let auto_on = QuotaResponse {
            disk_usage_bytes: 900,
            disk_limit_bytes: 1000,
            auto_delete_oldest: Some(true),
        };
        assert_eq!(auto_on.upload_stream_cap(SANITY), SANITY);

        // Unlimited plan → full sanity cap regardless of the flag.
        let unlimited = QuotaResponse {
            disk_usage_bytes: 900,
            disk_limit_bytes: 0,
            auto_delete_oldest: Some(false),
        };
        assert_eq!(unlimited.upload_stream_cap(SANITY), SANITY);

        // Unknown flag (older API / pre-field cache entry) → fail open to sanity.
        let unknown = QuotaResponse {
            disk_usage_bytes: 900,
            disk_limit_bytes: 1000,
            auto_delete_oldest: None,
        };
        assert_eq!(unknown.upload_stream_cap(SANITY), SANITY);
    }

    ///story: Deserializacja odpowiedzi /quota mapuje JSON `autoDeleteOldest` na pole Rust, a jego brak (starsze API) daje None — gwarantuje, że nowy cap działa po stronie FTPS bez zmiany kontraktu dla starych odpowiedzi.
    #[test]
    fn quota_response_deserializes_auto_delete_flag() {
        let with_flag: QuotaResponse = serde_json::from_str(
            r#"{"diskUsageBytes":1,"diskLimitBytes":2,"autoDeleteOldest":true}"#,
        )
        .unwrap();
        assert_eq!(with_flag.auto_delete_oldest, Some(true));

        let absent: QuotaResponse =
            serde_json::from_str(r#"{"diskUsageBytes":1,"diskLimitBytes":2}"#).unwrap();
        assert_eq!(absent.auto_delete_oldest, None);
    }

    ///story: Pobranie quoty przy cache-hit nie wysyła HTTP-ki do API — tak samo jak check_transfer, pre-check headroomu na każdym STOR nie dokłada round-tripu gdy stan jest świeży.
    #[tokio::test]
    async fn fetch_quota_returns_cached_value_without_http() {
        // Non-routable URL — any real HTTP call would error within milliseconds.
        let api = InternalApi::new("http://127.0.0.1:1", "test-key");
        api.quota_cache
            .insert(
                "u1".to_string(),
                QuotaResponse { disk_usage_bytes: 100, disk_limit_bytes: 1000, auto_delete_oldest: None },
            )
            .await;

        let r = api.fetch_quota("u1").await.expect("cache hit must succeed");
        assert_eq!(r.disk_headroom_bytes(), 900);
    }

    ///story: Gdy flush transferu do API padnie (np. API offline), bajty wracają do kolejki zamiast wypadać z ewidencji — brak utraty zapisanego ruchu w razie krótkiej niedostępności.
    #[tokio::test]
    async fn flush_requeues_on_failure() {
        // Non-routable URL — report_usage will fail fast
        let api = InternalApi::new("http://127.0.0.1:1", "test-key");
        api.enqueue_download_transfer("u1", 1000);
        api.enqueue_download_transfer("u2", 2000);

        // First flush: both POSTs fail → bytes re-queued
        api.flush_transfer().await;

        assert_eq!(
            api.pending_transfer.get("u1").unwrap().load(Ordering::Relaxed),
            1000
        );
        assert_eq!(
            api.pending_transfer.get("u2").unwrap().load(Ordering::Relaxed),
            2000
        );
    }

    ///story: verify_auth forwarduje realny IP klienta w nagłówku `X-Real-Client-IP`, żeby API mogło throttlować credential-spray per source-IP — sam pod FTPS ma współdzielony IP całej floty kamer i nie nadaje się na klucz limitu.
    #[tokio::test]
    async fn verify_auth_forwards_client_ip_header() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/internal/auth/verify"))
            .and(header("X-Real-Client-IP", "203.0.113.7"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "valid": true,
                    "userUuid": "uuid-1",
                    "encryptionSalt": "salt",
                })),
            )
            // The mock only matches when the header is present with the exact
            // client IP — a missing/wrong header would 404 and fail the call.
            .expect(1)
            .mount(&server)
            .await;

        let api = InternalApi::new(&server.uri(), "test-key");
        let ip: std::net::IpAddr = "203.0.113.7".parse().unwrap();
        let resp = api
            .verify_auth("alice@example.com", "pw", ip)
            .await
            .expect("verify_auth must succeed when the IP header matches");
        assert!(resp.valid);
    }

    // ── file_complete tests (R1 synchronous ingest) ──────────────────────────

    ///story: [FTPS-074] 507 z `reason` to nie błąd transportu: `file_complete` zwraca Ok{claimed:false} razem z powodem odmowy (`access_locked` albo `quota_exceeded`), żeby wywołujący wybrał właściwe powiadomienie zamiast zakładać „dysk pełny”.
    #[tokio::test]
    async fn file_complete_507_carries_the_reason_of_the_refusal() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/internal/users/uuid-1/file-complete"))
            .respond_with(ResponseTemplate::new(507).set_body_json(serde_json::json!({
                "ok": false,
                "claimed": false,
                "reason": "access_locked"
            })))
            .mount(&server)
            .await;

        let api = InternalApi::new(&server.uri(), "test-key");
        let resp = api
            .file_complete("uuid-1", "recordings", "uuid-1/file.mp4", "file.mp4", 1024, false)
            .await
            .expect("507 is an answer, not a transport error");

        assert!(!resp.claimed);
        assert_eq!(resp.reason.as_deref(), Some("access_locked"));
    }

    ///story: file_complete 200 → Ok{claimed:true} — ścieżka happy path R1: API przyjmuje plik, zwraca claimed=true, metoda zwraca Ok bez błędu.
    #[tokio::test]
    async fn file_complete_200_returns_ok_claimed() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/internal/users/uuid-1/file-complete"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({
                        "ok": true,
                        "claimed": true,
                        "state": "pending"
                    })),
            )
            .mount(&server)
            .await;

        let api = InternalApi::new(&server.uri(), "test-key");
        let resp = api
            .file_complete("uuid-1", "recordings", "uuid-1/file.mp4", "file.mp4", 1024, false)
            .await
            .expect("200 must return Ok");

        assert!(resp.ok);
        assert!(resp.claimed);
        assert_eq!(resp.state.as_deref(), Some("pending"));
    }

    ///story: Nagranie ucięte w locie (kamera zerwała połączenie) trafia do API z `truncated: true` — bez tego pół nagrania byłoby nie do odróżnienia od kompletnego. Pole jest pomijane, gdy false, więc payload kompletnego uploadu nie zmienia kształtu.
    #[tokio::test]
    async fn file_complete_marks_truncated_uploads_and_omits_the_flag_otherwise() {
        use wiremock::matchers::{body_string_contains, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let ok = ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "ok": true, "claimed": true, "state": "pending_sidecar"
        }));

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/internal/users/uuid-t/file-complete"))
            .and(body_string_contains(r#""truncated":true"#))
            .respond_with(ok.clone())
            .expect(1)
            .mount(&server)
            .await;
        let api = InternalApi::new(&server.uri(), "test-key");
        api.file_complete("uuid-t", "recordings", "uuid-t/a.mp4", "a.mp4", 8_389_756, true)
            .await
            .expect("truncated upload must still register");
        drop(server); // .expect(1) is verified on drop

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/internal/users/uuid-f/file-complete"))
            .respond_with(ok)
            .mount(&server)
            .await;
        let api = InternalApi::new(&server.uri(), "test-key");
        api.file_complete("uuid-f", "recordings", "uuid-f/b.mp4", "b.mp4", 1024, false)
            .await
            .expect("complete upload must register");
        let sent = &server.received_requests().await.unwrap()[0];
        let body = String::from_utf8_lossy(&sent.body);
        assert!(!body.contains("truncated"), "false must be omitted, got: {body}");
    }

    ///story: file_complete 507 → Ok{claimed:false} bez retry — quota rejection nie jest błędem transportu; jeden request wystarczy (kamera dostaje 552).
    #[tokio::test]
    async fn file_complete_507_returns_ok_not_claimed_no_retry() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/internal/users/uuid-2/file-complete"))
            .respond_with(
                ResponseTemplate::new(507)
                    .set_body_json(serde_json::json!({
                        "ok": false,
                        "claimed": false,
                        "reason": "quota_exceeded"
                    })),
            )
            // Exactly 1 request — no retries on 507.
            .expect(1)
            .mount(&server)
            .await;

        let api = InternalApi::new(&server.uri(), "test-key");
        let resp = api
            .file_complete("uuid-2", "recordings", "uuid-2/file.mp4", "file.mp4", 1024, false)
            .await
            .expect("507 must return Ok (quota rejection, not transport error)");

        assert!(!resp.ok);
        assert!(!resp.claimed);
        // wiremock verifies the `expect(1)` on MockServer drop.
    }

    ///story: file_complete 500 → retry → 200 → Ok — błąd serwera jest przejściowy; po retry metoda zwraca sukces zamiast propagować błąd.
    #[tokio::test]
    async fn file_complete_5xx_then_200_retries_and_succeeds() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

        // Custom responder: first call → 500, subsequent → 200.
        struct FirstFails {
            count: Arc<AtomicU32>,
        }
        impl Respond for FirstFails {
            fn respond(&self, _: &Request) -> ResponseTemplate {
                let n = self.count.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    ResponseTemplate::new(500)
                } else {
                    ResponseTemplate::new(200).set_body_json(serde_json::json!({
                        "ok": true,
                        "claimed": true,
                        "state": "pending"
                    }))
                }
            }
        }

        let counter = Arc::new(AtomicU32::new(0));
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/internal/users/uuid-3/file-complete"))
            .respond_with(FirstFails { count: counter.clone() })
            .mount(&server)
            .await;

        let api = InternalApi::new(&server.uri(), "test-key");
        let resp = api
            .file_complete("uuid-3", "recordings", "uuid-3/file.mp4", "file.mp4", 1024, false)
            .await
            .expect("retry after 500 must succeed");

        assert!(resp.claimed);
        // First attempt → 500, second → 200: total 2 requests.
        assert_eq!(counter.load(Ordering::SeqCst), 2, "expected exactly 2 requests");
    }

    ///story: file_complete 400 → natychmiastowy Err, bez retry — permanentny błąd klienta nie powinien obciążać API kolejnymi próbami.
    #[tokio::test]
    async fn file_complete_400_returns_err_immediately_no_retry() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/internal/users/uuid-4/file-complete"))
            .respond_with(ResponseTemplate::new(400))
            // Exactly 1 request — no retries on 4xx permanent errors.
            .expect(1)
            .mount(&server)
            .await;

        let api = InternalApi::new(&server.uri(), "test-key");
        let result = api
            .file_complete("uuid-4", "recordings", "uuid-4/file.mp4", "file.mp4", 1024, false)
            .await;

        assert!(result.is_err(), "400 must return Err");
        // wiremock verifies the `expect(1)` on MockServer drop.
    }

    // ── session-check tests (live FTP session re-validation) ────────────────

    ///story: Kamera ma otwartą sesję FTP, a właściciel zmienił hasło FTP — serwer FTPS pyta API o epokę sesji i dostaje valid:false, więc kolejne polecenie dostaje odmowę zamiast działać do rozłączenia.
    #[tokio::test]
    async fn check_session_refused_after_credential_change() {
        use wiremock::matchers::{body_json, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/internal/users/uuid-1/session-check"))
            .and(body_json(serde_json::json!({ "sessionEpoch": "old-epoch" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({ "valid": false, "reason": "credential_changed" }),
            ))
            .expect(1)
            .mount(&server)
            .await;

        let api = InternalApi::new(&server.uri(), "test-key");
        assert!(!api.check_session("uuid-1", "old-epoch").await);
    }

    ///story: Aktywna sesja wysyła setki poleceń na minutę — API ma być pytane raz na okno cache, a nie przy każdym poleceniu, inaczej każde LIST/DELE kosztowałoby zapytanie do bazy.
    #[tokio::test]
    async fn check_session_is_cached_for_ttl() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/internal/users/uuid-1/session-check"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "valid": true })),
            )
            .expect(1)
            .mount(&server)
            .await;

        let api = InternalApi::new(&server.uri(), "test-key");
        assert!(api.check_session("uuid-1", "e").await);
        assert!(api.check_session("uuid-1", "e").await);
    }

    ///story: Podczas wdrożenia FTPS może dostać się na API bez nowej trasy (404) albo na chwilę niedostępne — sesje kamer nie mogą wtedy padać; odmowa dotyczy tylko jednoznacznego valid:false.
    #[tokio::test]
    async fn check_session_fails_open_when_route_missing() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/internal/users/uuid-1/session-check"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let api = InternalApi::new(&server.uri(), "test-key");
        assert!(api.check_session("uuid-1", "e").await);
        // Unreachable API: also allowed.
        let down = InternalApi::new("http://127.0.0.1:1", "test-key");
        assert!(down.check_session("uuid-1", "e").await);
    }
}
