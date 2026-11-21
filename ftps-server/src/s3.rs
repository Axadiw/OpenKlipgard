use std::fmt;

use aws_credential_types::Credentials;
use aws_sdk_s3::{
    config::{http::HttpResponse, retry::RetryConfig, Builder as S3ConfigBuilder, Region},
    error::{ProvideErrorMetadata, SdkError},
    operation::head_object::HeadObjectError,
    primitives::ByteStream,
    types::{CompletedMultipartUpload, CompletedPart},
    Client as S3Client,
};
use aws_smithy_http_client::{
    tls::{self, TlsContext, TrustStore},
    Builder as HttpClientBuilder,
};
use bytes::Bytes;
use tokio::io::AsyncReadExt;
use tracing::{debug, error, info, warn};

use crate::metrics::{global, timed, timed_where, timed_within_on, S3Op};

/// Does this HeadObject failure mean S3 broke?
///
/// A 404 does not. `storage.rs::metadata` probes a key and falls back to a
/// directory marker when it is absent, so "no such object" is the answer the
/// FTPS server asked for on every directory stat — not a fault. Keeping those
/// out of `klipgard_ftps_s3_errors_total` is what lets that counter mean
/// "recordings are being lost", which is exactly what its alert claims.
fn head_object_failed(err: &SdkError<HeadObjectError>) -> bool {
    !matches!(err, SdkError::ServiceError(e) if e.err().is_not_found())
}

/// The HTTP status that S3-compatible stores answer when they have no space
/// left: 507 Insufficient Storage ([FTPS-168]).
///
/// WHY the status and not an error code: MinIO answers `XMinioStorageFull`, the
/// AWS capacity errors (S3 on Outposts, FSx behind an S3 access point) answer
/// `InsufficientCapacity`, and both use 507. A list of codes would grow with
/// every store, and the status still arrives when the body is not S3 XML (a
/// proxy in front of the store). Backblaze B2 reportedly answers a reached
/// storage cap with 403, which a revoked key shares, so it is deliberately not
/// matched. Its message still reaches the log.
const STORE_FULL_STATUS: u16 = 507;

/// What the object store said about one failed call of an upload.
///
/// WHY it exists: the `Display` of an SDK service error is the two words
/// `service error`. The S3 code and message sit in the error metadata and the
/// status sits in the raw response, and nothing read them, so a store with a
/// full disk looked like any other fault and the cause had to be found in the
/// store's own log. `Display` here is the log text ([FTPS-166]): status, code
/// and message of the answer, or the cause when there was no answer. It holds
/// nothing else, so it cannot show a credential, an SSE-C key or a request
/// header ([FTPS-167]).
#[derive(Debug)]
pub struct StoreFailure {
    pub op: S3Op,
    /// HTTP status of the answer. `None` when the store gave no answer.
    pub status: Option<u16>,
    /// S3 error code from the answer.
    pub code: Option<String>,
    /// S3 error message from the answer.
    pub message: Option<String>,
    /// The SDK error and its sources, only when the answer is not an S3 error
    /// response: refused connection, TLS trust error, timeout, unreadable reply.
    pub cause: Option<String>,
}

impl StoreFailure {
    pub fn from_sdk<E>(op: S3Op, err: &SdkError<E, HttpResponse>) -> Self
    where
        E: std::error::Error + ProvideErrorMetadata + 'static,
    {
        let cause = match err {
            SdkError::ServiceError(_) => None,
            other => Some(error_chain(other)),
        };
        Self {
            op,
            status: err
                .raw_response()
                .map(|response| response.status().as_u16()),
            code: err.code().map(str::to_owned),
            message: err.message().map(str::to_owned),
            cause,
        }
    }

    /// Did the store answer that it has no space left ([FTPS-168])?
    pub fn is_full(&self) -> bool {
        self.status == Some(STORE_FULL_STATUS)
    }
}

impl fmt::Display for StoreFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "S3 {} failed", self.op.as_str())?;
        let mut separator = ": ";
        if let Some(status) = self.status {
            write!(f, "{separator}HTTP status {status}")?;
            separator = ", ";
        }
        if let Some(code) = &self.code {
            write!(f, "{separator}S3 code {code}")?;
            separator = ", ";
        }
        if let Some(message) = &self.message {
            // Debug quotes the text and escapes control characters, so a message
            // from the store cannot break the log line in two.
            write!(f, "{separator}message {message:?}")?;
            separator = ", ";
        }
        if let Some(cause) = &self.cause {
            write!(f, "{separator}cause {cause}")?;
        }
        Ok(())
    }
}

impl std::error::Error for StoreFailure {}

/// `err` and every error under it, joined by `: `.
///
/// This is what the SDK's own `DisplayErrorContext` prints, minus the `Debug`
/// dump of the whole error that it appends: that dump holds the raw response and
/// is not a line for a log.
fn error_chain(err: &(dyn std::error::Error + 'static)) -> String {
    let mut text = err.to_string();
    let mut source = err.source();
    while let Some(inner) = source {
        text.push_str(": ");
        text.push_str(&inner.to_string());
        source = inner.source();
    }
    text
}

/// Log a failed call of an upload once, after its last attempt, and turn it
/// into the error that `put_object_stream` returns ([FTPS-166]).
fn failed_store_call<E>(
    op: S3Op,
    key: &str,
    layer: &'static str,
    err: SdkError<E, HttpResponse>,
) -> Box<dyn std::error::Error + Send + Sync>
where
    E: std::error::Error + ProvideErrorMetadata + 'static,
{
    let failure = StoreFailure::from_sdk(op, &err);
    error!(error = %failure, key = %key, layer = layer, "layer error");
    Box::new(failure)
}

/// Multipart part size, pinned to the S3 minimum for non-final parts.
///
/// Sized DOWN from 8 MiB when the per-user upload cap was raised to 24: peak
/// memory per in-flight upload is `READ_BUF + (1 + MULTIPART_CONCURRENCY) *
/// MULTIPART_CHUNK`, so 8 MiB × 24 concurrent uploads would have put a single
/// user at ~600 MiB on a 1 GiB pod. At 5 MiB that is ~16 MiB per upload
/// (~384 MiB for a fully saturated user), which the raised 2 GiB limit
/// absorbs comfortably. Smaller parts also mean a cut-short upload has
/// committed more of its bytes at any given moment.
const MULTIPART_CHUNK: usize = 5 * 1024 * 1024;

/// Read buffer size. Bigger = fewer syscalls + TLS record round-trips.
/// 1 MiB is a sweet spot — large enough to saturate a typical 1 Gbps local link,
/// small enough that the encoder keeps its latency bounded.
const READ_BUF: usize = 1024 * 1024;

/// Max concurrent S3 multipart part uploads in flight per file. Parts upload
/// independently (only part_number matters to S3), so overlapping them with
/// the client-side read hides the S3 round-trip behind the next part's TLS
/// buffer fill.
const MULTIPART_CONCURRENCY: usize = 2;

/// Give up waiting for more client bytes after this long and treat the stream
/// as ended, committing whatever arrived.
///
/// Uploads now stream in a task detached from the FTP control channel so a
/// client that disappears mid-transfer doesn't take its bytes down with it —
/// which means a half-open data socket (camera powered off mid-STOR, a NAT
/// silently dropping the flow) would otherwise pin that task, and the per-user
/// upload slot it holds, until the OS TCP timeout. Minutes to hours.
///
/// 120 s is far longer than any real inter-packet gap: the slowest transfer
/// observed on a congested LTE uplink (~130 KB/s) still moved
/// bytes every few hundred milliseconds. A stream that has delivered nothing
/// at all for two minutes is not slow, it is gone.
const READ_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

use crate::config::Config;
use crate::encryption::{
    derive_user_key, key_generation_for_bucket, master_key_for_generation, ssec_headers, KeyGeneration,
};

/// Value of the `x-amz-copy-source` header: the bucket, a slash, and the key
/// percent-encoded byte by byte. Slashes stay, so the key keeps its folders.
/// The unreserved set is `A-Z a-z 0-9 - _ . ~`. Every other byte of the UTF-8
/// key, a space, `+`, `%` or a Unicode letter, becomes `%XX`.
fn encode_copy_source(bucket: &str, key: &str) -> String {
    let mut out = String::with_capacity(bucket.len() + 1 + key.len() * 3);
    out.push_str(bucket);
    out.push('/');
    for b in key.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// S3 client wrapper with SSE-C encryption support.
#[derive(Clone)]
pub struct S3 {
    client: S3Client,
    bucket: String,
    /// Master key of the bucket's key generation (already resolved: the
    /// generation-2 key, or its fallback, for a generation-2 bucket).
    master_key: String,
    /// SSE-C key generation of `bucket` (spec DATA-146), fixed at start-up.
    key_generation: KeyGeneration,
}

impl fmt::Debug for S3 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // `master_key` is the encryption root secret (HKDF IKM for every SSE-C
        // key). `S3` lives inside `KlipgardStorage`, which libunftp can Debug
        // via its session instrument — `#[derive(Debug)]` printed the master
        // key in plaintext (after dumping the entire AWS client config).
        // Redact the key and drop the noisy client; `bucket` isn't secret and
        // helps ops correlate.
        f.debug_struct("S3")
            .field("bucket", &self.bucket)
            .field("master_key", &"<redacted>")
            .field("key_generation", &self.key_generation)
            .finish_non_exhaustive()
    }
}

/// Answer to one bounded existence probe.
///
/// `Unknown` is the load-bearing variant: it means "S3 did not tell us inside
/// the budget". The two callers resolve it in OPPOSITE directions on purpose —
/// `cwd` treats it as "exists" so the camera proceeds to STOR (the real test),
/// while `metadata` must not claim "directory" about something it failed to
/// inspect. Collapsing this into a bool is how the optimism leaks into the
/// wrong call site.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Probe {
    Present,
    Absent,
    Unknown,
}

#[derive(Debug)]
pub struct S3Object {
    pub key: String,
    pub size: i64,
    /// LastModified from S3, mapped to SystemTime. None when the SDK
    /// didn't return a timestamp (shouldn't happen for normal objects).
    pub last_modified: Option<std::time::SystemTime>,
}

impl S3 {
    pub fn new(config: &Config) -> Self {
        let creds = Credentials::new(
            &config.s3_access_key,
            &config.s3_secret_key,
            None,
            None,
            "klipgard-ftps",
        );

        let mut builder = S3ConfigBuilder::new()
            .endpoint_url(&config.s3_endpoint)
            .region(Region::new("us-east-1"))
            .credentials_provider(creds)
            .force_path_style(true)
            // `standard`, not `adaptive`, and the attempt count is deliberately
            // UNCHANGED at 6.
            //
            // The retries themselves are load-bearing: a transient S3 blip on
            // complete_multipart destroys a recording outright, and cameras
            // never re-send. Lowering the count to make the latency histogram
            // prettier would trade recordings for a nicer graph.
            //
            // What `adaptive` adds on top of `standard` is a CLIENT-SIDE rate
            // limiter that measures throttling responses and then delays our own
            // sends to smooth them out. It is designed for fleets large enough to
            // be throttled by the service. This server runs at 0.26 req/s
            // average, 10 req/s at the 24 h peak (measured across
            // every pod) — orders of magnitude below any quota, so the limiter can
            // never protect us and can only add delay. Worse, it adds that delay
            // in exactly the wrong moment: during a provider latency event it
            // starts holding requests back, lengthening the stall it is reacting
            // to. `standard` keeps the exponential backoff and the retry-quota
            // token bucket that prevents retry storms, and drops the
            // self-throttling.
            //
            // Note what this does NOT fix: `metrics::timed_where_on` wraps the
            // whole `send()`, so one observation still covers up to 6 attempts
            // plus their backoff. That is time-to-succeed, not single-request
            // latency, and `FtpsS3LatencyHigh`'s description says so.
            .retry_config(RetryConfig::standard().with_max_attempts(6))
            .behavior_version_latest();

        // Always pin the rustls/aws-lc HTTPS connector (rustls 0.23) so the SDK
        // never falls back to its legacy default connector (rustls 0.21 + webpki
        // 0.101 — RUSTSEC). With no custom CA bundle it uses the platform's
        // native root store, matching the old default client's trust.
        let mut http = HttpClientBuilder::new()
            .tls_provider(tls::Provider::Rustls(tls::rustls_provider::CryptoMode::AwsLc));
        if let Some(ca_path) = &config.s3_ca_bundle {
            let ca_bytes = std::fs::read(ca_path)
                .unwrap_or_else(|e| panic!("Cannot read KLIPGARD_S3_CA_BUNDLE {ca_path}: {e}"));
            let trust_store = TrustStore::empty().with_pem_certificate(ca_bytes);
            let tls_ctx = TlsContext::builder()
                .with_trust_store(trust_store)
                .build()
                .expect("Failed to build TLS context from CA bundle");
            http = http.tls_context(tls_ctx);
        }
        builder = builder.http_client(http.build_https());

        let client = S3Client::from_conf(builder.build());

        // The generation is a pure function of the bucket name. This server
        // uses one bucket, so every key it derives is of that generation.
        let key_generation =
            key_generation_for_bucket(&config.s3_recordings_bucket, &config.sse_v2_buckets);
        let master_key = master_key_for_generation(
            key_generation,
            &config.encryption_master_key,
            config.encryption_master_key_v2.as_deref(),
        )
        .to_string();

        Self {
            client,
            bucket: config.s3_recordings_bucket.clone(),
            master_key,
            key_generation,
        }
    }

    /// SSE-C key generation of the recordings bucket, for the start-up log.
    pub fn key_generation(&self) -> KeyGeneration {
        self.key_generation
    }

    fn get_ssec(&self, user_salt: &str) -> (String, String, String) {
        let key = derive_user_key(&self.master_key, user_salt, self.key_generation);
        ssec_headers(&key)
    }

    /// Recordings bucket name. Exposed so `storage.rs` can pass it to the
    /// internal API when registering uploads in the FIFO eviction queue.
    pub fn bucket_name(&self) -> &str {
        &self.bucket
    }

    pub async fn put_object(
        &self,
        key: &str,
        data: Bytes,
        user_salt: &str,
    ) -> Result<(), aws_sdk_s3::Error> {
        let len = data.len() as i64;

        debug!(key = key, size = len, "Uploading to S3");

        let mut req = self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(ByteStream::from(data))
            .content_length(len);

        let (algo, key_b64, key_md5) = self.get_ssec(user_salt);
        req = req
            .sse_customer_algorithm(algo)
            .sse_customer_key(key_b64)
            .sse_customer_key_md5(key_md5);

        timed(S3Op::Put, req.send()).await?;

        Ok(())
    }

    /// Stream an upload from `first_bytes` + `reader` into S3.
    ///
    /// Uses a single PUT for small files (< `MULTIPART_CHUNK`); multipart PUT for larger ones.
    /// Returns the total bytes uploaded as `i64`.
    ///
    /// The caller passes `first_bytes` separately because they may have been read already
    /// (e.g. for magic-bytes validation). They are prepended to the stream transparently.
    ///
    /// Multipart parts upload concurrently (up to `MULTIPART_CONCURRENCY` in flight),
    /// so the per-part S3 round-trip overlaps with reading the next part from the
    /// client. This is the difference between ~20 MiB/s and ~80+ MiB/s on localhost.
    ///
    /// `max_bytes` is the hard upper bound on stream size — uploads that
    /// exceed it abort with an error whose message starts with `Upload
    /// exceeds`. `KlipgardStorage::put` matches on that prefix to report
    /// the right FTP reply + user notification. Caller passes a sanity cap
    /// (e.g. 100 GiB to stop runaway clients from burning unbounded S3
    /// writes) — there is no plan-based gating here; quota enforcement
    /// runs post-upload via `claim_disk_space_and_tidy`.
    pub async fn put_object_stream(
        &self,
        key: &str,
        first_bytes: &[u8],
        reader: &mut (impl tokio::io::AsyncRead + Unpin + Send),
        user_salt: &str,
        max_bytes: i64,
    ) -> Result<i64, Box<dyn std::error::Error + Send + Sync>> {
        let (algo, key_b64, key_md5) = self.get_ssec(user_salt);

        // Fill the first chunk buffer starting with already-read magic bytes
        let mut chunk: Vec<u8> = Vec::with_capacity(MULTIPART_CHUNK);
        chunk.extend_from_slice(first_bytes);

        let mut tmp = vec![0u8; READ_BUF];
        let mut total: i64 = first_bytes.len() as i64;

        // Read until we either fill the first chunk or hit EOF
        loop {
            if chunk.len() >= MULTIPART_CHUNK {
                break;
            }
            match read_or_idle(reader, &mut tmp).await {
                Ok(0) => {
                    // EOF (or idle timeout) — small file: single PUT
                    debug!(key = key, size = total, "put_object_stream: single PUT");
                    let bytes = Bytes::from(chunk);
                    let len = bytes.len() as i64;
                    if let Err(e) = timed(
                        S3Op::Put,
                        self.client
                            .put_object()
                            .bucket(&self.bucket)
                            .key(key)
                            .body(ByteStream::from(bytes))
                            .content_length(len)
                            .sse_customer_algorithm(algo)
                            .sse_customer_key(key_b64)
                            .sse_customer_key_md5(key_md5)
                            .send(),
                    )
                    .await
                    {
                        return Err(failed_store_call(S3Op::Put, key, "s3_single_put_eof", e));
                    }
                    return Ok(total);
                }
                Ok(n) => {
                    total += n as i64;
                    if total > max_bytes {
                        return Err(format!("Upload exceeds {max_bytes} byte limit").into());
                    }
                    chunk.extend_from_slice(&tmp[..n]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    // FTP TLS close without close_notify — treat as EOF
                    debug!(
                        key = key,
                        size = total,
                        "put_object_stream: TLS UnexpectedEof (normal)"
                    );
                    let bytes = Bytes::from(chunk);
                    let len = bytes.len() as i64;
                    if let Err(e) = timed(
                        S3Op::Put,
                        self.client
                            .put_object()
                            .bucket(&self.bucket)
                            .key(key)
                            .body(ByteStream::from(bytes))
                            .content_length(len)
                            .sse_customer_algorithm(algo.clone())
                            .sse_customer_key(key_b64.clone())
                            .sse_customer_key_md5(key_md5.clone())
                            .send(),
                    )
                    .await
                    {
                        return Err(failed_store_call(
                            S3Op::Put,
                            key,
                            "s3_single_put_unexpectedeof",
                            e,
                        ));
                    }
                    return Ok(total);
                }
                Err(e) => {
                    error!(
                        error = %e,
                        kind = ?e.kind(),
                        key = %key,
                        layer = "ftps_data_read_first_chunk",
                        "layer error"
                    );
                    return Err(Box::new(e));
                }
            }
        }

        // Large file path — multipart upload
        info!(key = key, "put_object_stream: starting multipart upload");

        let mpu = match timed(
            S3Op::CreateMultipart,
            self.client
                .create_multipart_upload()
                .bucket(&self.bucket)
                .key(key)
                .sse_customer_algorithm(algo.clone())
                .sse_customer_key(key_b64.clone())
                .sse_customer_key_md5(key_md5.clone())
                .send(),
        )
        .await
        {
            Ok(v) => v,
            Err(e) => {
                return Err(failed_store_call(
                    S3Op::CreateMultipart,
                    key,
                    "s3_create_multipart",
                    e,
                ));
            }
        };
        let upload_id = mpu.upload_id().unwrap_or_default().to_string();

        let abort = |upload_id: String, key: String, client: S3Client, bucket: String| {
            let client = client.clone();
            tokio::spawn(async move {
                if let Err(e) = timed(
                    S3Op::AbortMultipart,
                    client
                        .abort_multipart_upload()
                        .bucket(bucket)
                        .key(key)
                        .upload_id(upload_id)
                        .send(),
                )
                .await
                {
                    warn!(error = %e, "Failed to abort multipart upload");
                }
            });
        };

        // Parallel multipart: spawn up to MULTIPART_CONCURRENCY part uploads
        // at once so S3 round-trips overlap with reading the next chunk.
        let mut joinset: tokio::task::JoinSet<
            Result<CompletedPart, Box<dyn std::error::Error + Send + Sync>>,
        > = tokio::task::JoinSet::new();
        let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(MULTIPART_CONCURRENCY));
        let mut part_number: i32 = 1;

        // Queue part 1 (the already-full first chunk)
        queue_part(
            &mut joinset,
            sem.clone(),
            self.client.clone(),
            self.bucket.clone(),
            key.to_string(),
            upload_id.clone(),
            part_number,
            chunk,
            algo.clone(),
            key_b64.clone(),
            key_md5.clone(),
        )
        .await;
        part_number += 1;

        // Read remaining data and queue parts concurrently with uploads in flight
        loop {
            let mut next_chunk: Vec<u8> = Vec::with_capacity(MULTIPART_CHUNK);
            loop {
                if next_chunk.len() >= MULTIPART_CHUNK {
                    break;
                }
                match read_or_idle(reader, &mut tmp).await {
                    Ok(0) => break, // EOF or idle timeout (final part may be short)
                    Ok(n) => {
                        total += n as i64;
                        if total > max_bytes {
                            joinset.shutdown().await;
                            abort(
                                upload_id.clone(),
                                key.to_string(),
                                self.client.clone(),
                                self.bucket.clone(),
                            );
                            return Err(
                                format!("Upload exceeds {max_bytes} byte limit").into()
                            );
                        }
                        next_chunk.extend_from_slice(&tmp[..n]);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                    Err(e) => {
                        error!(
                            error = %e,
                            kind = ?e.kind(),
                            key = %key,
                            bytes_read = total,
                            layer = "ftps_data_read_mid_stream",
                            "layer error"
                        );
                        joinset.shutdown().await;
                        abort(
                            upload_id.clone(),
                            key.to_string(),
                            self.client.clone(),
                            self.bucket.clone(),
                        );
                        return Err(Box::new(e));
                    }
                }
            }

            if next_chunk.is_empty() {
                break;
            }

            queue_part(
                &mut joinset,
                sem.clone(),
                self.client.clone(),
                self.bucket.clone(),
                key.to_string(),
                upload_id.clone(),
                part_number,
                next_chunk,
                algo.clone(),
                key_b64.clone(),
                key_md5.clone(),
            )
            .await;
            part_number += 1;
        }

        // Wait for every in-flight upload to finish, collecting parts.
        let mut parts: Vec<CompletedPart> = Vec::new();
        while let Some(joined) = joinset.join_next().await {
            match joined {
                Ok(Ok(p)) => parts.push(p),
                Ok(Err(e)) => {
                    error!(error = %e, key = %key, layer = "s3_upload_part", "layer error");
                    joinset.shutdown().await;
                    abort(
                        upload_id.clone(),
                        key.to_string(),
                        self.client.clone(),
                        self.bucket.clone(),
                    );
                    return Err(e);
                }
                Err(e) => {
                    joinset.shutdown().await;
                    abort(
                        upload_id.clone(),
                        key.to_string(),
                        self.client.clone(),
                        self.bucket.clone(),
                    );
                    return Err(Box::new(e));
                }
            }
        }
        // S3 CompleteMultipartUpload requires parts in ascending part_number order.
        parts.sort_by_key(|p| p.part_number().unwrap_or(0));

        // Complete multipart upload — also gated so a burst of finalising
        // uploads doesn't itself reopen N fresh TLS connections to the object store.
        let completed = CompletedMultipartUpload::builder()
            .set_parts(Some(parts))
            .build();

        // Retry the finalise, then verify before giving up.
        //
        // This call used to be single-shot, which made a momentary S3 hiccup
        // discard an upload that had already streamed in full — the worst
        // possible moment to fail. A long upload could die here on a
        // `service error` while a HEAD afterwards showed the object HAD been
        // created: the object store had completed it and only the response
        // came back an error, so the bytes sat in the bucket as an
        // unregistered orphan the reconciler would eventually purge.
        //
        // CompleteMultipartUpload is idempotent for the same parts, so
        // retrying is safe. The final HEAD covers the observed case where the
        // operation succeeded but we never saw the confirmation.
        let mut last_err = None;
        for (attempt, backoff_ms) in [0u64, 300, 1200].into_iter().enumerate() {
            if backoff_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            }
            match timed(
                S3Op::CompleteMultipart,
                self.client
                    .complete_multipart_upload()
                    .bucket(&self.bucket)
                    .key(key)
                    .upload_id(&upload_id)
                    .multipart_upload(completed.clone())
                    .sse_customer_algorithm(algo.clone())
                    .sse_customer_key(key_b64.clone())
                    .sse_customer_key_md5(key_md5.clone())
                    .send(),
            )
            .await
            {
                Ok(_) => {
                    last_err = None;
                    break;
                }
                Err(e) => {
                    warn!(
                        error = %e, key = %key, attempt = attempt + 1,
                        "complete_multipart_upload failed — retrying"
                    );
                    last_err = Some(e);
                }
            }
        }
        if let Some(e) = last_err {
            // Every attempt reported failure. Before throwing the upload away,
            // ask S3 whether the object exists anyway.
            // Same rule as the metadata path: a 404 here is S3 answering
            // "that object does not exist" — bad news for this upload, but not
            // an S3 fault, and the upload failure is surfaced on its own.
            match timed_where(
                S3Op::Head,
                head_object_failed,
                self.client
                    .head_object()
                    .bucket(&self.bucket)
                    .key(key)
                    .sse_customer_algorithm(algo)
                    .sse_customer_key(key_b64)
                    .sse_customer_key_md5(key_md5)
                    .send(),
            )
            .await
            {
                Ok(head) if head.content_length().unwrap_or(0) > 0 => {
                    warn!(
                        key = %key,
                        size = head.content_length().unwrap_or(0),
                        "complete_multipart_upload reported failure but the object exists — treating as complete"
                    );
                }
                _ => {
                    return Err(failed_store_call(
                        S3Op::CompleteMultipart,
                        key,
                        "s3_complete_multipart",
                        e,
                    ));
                }
            }
        }

        info!(
            key = key,
            total_bytes = total,
            parts = part_number - 1,
            "put_object_stream: multipart upload complete"
        );
        Ok(total)
    }

    pub async fn get_object(
        &self,
        key: &str,
        user_salt: &str,
    ) -> Result<(ByteStream, Option<i64>), aws_sdk_s3::Error> {
        debug!(key = key, "Downloading from S3");

        let mut req = self.client.get_object().bucket(&self.bucket).key(key);

        let (algo, key_b64, key_md5) = self.get_ssec(user_salt);
        req = req
            .sse_customer_algorithm(algo)
            .sse_customer_key(key_b64)
            .sse_customer_key_md5(key_md5);

        let resp = timed(S3Op::Get, req.send()).await?;

        Ok((resp.body, resp.content_length))
    }

    pub async fn head_object(&self, key: &str, user_salt: &str) -> Result<i64, aws_sdk_s3::Error> {
        Ok(self.head_object_full(key, user_salt).await?.0)
    }

    /// Like `head_object` but also returns LastModified — used by the FTPS
    /// metadata path so MLSD/LIST shows the upload time, not "now".
    pub async fn head_object_full(
        &self,
        key: &str,
        user_salt: &str,
    ) -> Result<(i64, Option<std::time::SystemTime>), aws_sdk_s3::Error> {
        let mut req = self.client.head_object().bucket(&self.bucket).key(key);

        let (algo, key_b64, key_md5) = self.get_ssec(user_salt);
        req = req
            .sse_customer_algorithm(algo)
            .sse_customer_key(key_b64)
            .sse_customer_key_md5(key_md5);

        let resp = timed_where(S3Op::Head, head_object_failed, req.send()).await?;
        let modified = resp
            .last_modified
            .as_ref()
            .and_then(|t| std::time::SystemTime::try_from(*t).ok());

        Ok((resp.content_length.unwrap_or(0), modified))
    }

    /// Server-side copy of an encrypted object to a new key under the same bucket.
    ///
    /// Used by FTPS `rename` (see `storage.rs::rename`). Passing the user's salt
    /// on both the SSE-C (source) and SSE-C (destination) headers lets MinIO
    /// re-encrypt the object without the data ever round-tripping through the
    /// FTPS process. This replaces the previous `get_object → read_to_end →
    /// put_object` pattern, which was an unbounded-RAM DoS vector: each
    /// concurrent rename buffered the entire source file in RAM.
    pub async fn copy_object(
        &self,
        from_key: &str,
        to_key: &str,
        user_salt: &str,
    ) -> Result<(), aws_sdk_s3::Error> {
        let (algo, key_b64, key_md5) = self.get_ssec(user_salt);

        // [FTPS-038] `copy_source` is `<bucket>/<percent-encoded key>`. File
        // names are unrestricted (spaces, `+`, `%`, Unicode), and an unencoded
        // key copies the wrong object or fails.
        let copy_source = encode_copy_source(&self.bucket, from_key);

        let req = self
            .client
            .copy_object()
            .bucket(&self.bucket)
            .key(to_key)
            .copy_source(copy_source)
            // SSE-C headers apply to the destination write
            .sse_customer_algorithm(&algo)
            .sse_customer_key(&key_b64)
            .sse_customer_key_md5(&key_md5)
            // Matching SSE-C headers on the source read. Source and
            // destination are the same bucket, so they are of the same key
            // generation and the per-user key is the same.
            .copy_source_sse_customer_algorithm(&algo)
            .copy_source_sse_customer_key(&key_b64)
            .copy_source_sse_customer_key_md5(&key_md5);

        timed(S3Op::Copy, req.send()).await?;

        Ok(())
    }

    pub async fn delete_object(&self, key: &str) -> Result<(), aws_sdk_s3::Error> {
        debug!(key = key, "Deleting from S3");

        timed(
            S3Op::Delete,
            self.client
                .delete_object()
                .bucket(&self.bucket)
                .key(key)
                .send(),
        )
        .await?;

        Ok(())
    }

    /// Batch delete. S3 `DeleteObjects` takes up to 1000 keys per request, so
    /// for N files this issues ⌈N/1000⌉ round-trips instead of N. On a dir
    /// with 500 uploads that's the difference between ~500 HTTP calls
    /// (minutes on anything with latency) and 1 call (sub-second).
    pub async fn delete_objects(&self, keys: &[String]) -> Result<(), aws_sdk_s3::Error> {
        use aws_sdk_s3::types::{Delete, ObjectIdentifier};
        const BATCH: usize = 1000;
        for chunk in keys.chunks(BATCH) {
            let objects: Vec<ObjectIdentifier> = chunk
                .iter()
                .map(|k| {
                    ObjectIdentifier::builder()
                        .key(k)
                        .build()
                        .expect("key is non-empty")
                })
                .collect();
            let delete = Delete::builder()
                .set_objects(Some(objects))
                .quiet(true)
                .build()
                .expect("Delete.objects set above");
            timed(
                S3Op::DeleteBatch,
                self.client
                    .delete_objects()
                    .bucket(&self.bucket)
                    .delete(delete)
                    .send(),
            )
            .await?;
        }
        Ok(())
    }

    /// Does anything exist under `prefix`? One page, one key, one S3 call.
    ///
    /// WHY THIS IS NOT `list_objects(..).is_empty()`. `cwd` and `metadata` only
    /// ever need this boolean, but they used to get it from the fully paginated
    /// helper below — so proving a directory exists cost O(every page) of the
    /// slowest S3 verb, on the hottest path the FTPS server has. That is what
    /// destroyed recordings once the object store degraded (`list` at several
    /// seconds, `put` at tens of seconds): every camera `CWD 2026` -> `CWD 09` ->
    /// `CWD 09` rode it, and the cameras hung up before ever issuing STOR. The
    /// loss was invisible because a camera that dies BEFORE STOR never reaches
    /// `salvage_upload`, so nothing counted it.
    ///
    /// `max_keys(1)` plus no continuation loop makes the cost independent of
    /// how many objects the prefix holds — even a prefix holding nine objects
    /// was slow.
    pub async fn prefix_exists(&self, prefix: &str, budget: std::time::Duration) -> Probe {
        let req = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .prefix(prefix)
            .max_keys(1);

        match timed_within_on(global(), S3Op::ListProbe, budget, |_| true, req.send()).await {
            Some(Ok(resp)) => {
                if resp.contents().is_empty() {
                    Probe::Absent
                } else {
                    Probe::Present
                }
            }
            Some(Err(e)) => {
                warn!(error = %e, prefix = %prefix, "prefix_exists: S3 list failed");
                Probe::Unknown
            }
            None => {
                warn!(
                    prefix = %prefix,
                    budget_ms = budget.as_millis() as u64,
                    "prefix_exists: S3 did not answer inside the budget"
                );
                Probe::Unknown
            }
        }
    }

    /// Is there a directory-marker object at `dir_key` (a trailing-slash key)?
    ///
    /// `mkd` writes one of these as a zero-byte object, so for any directory a
    /// camera created with MKD this single cheap HeadObject answers the
    /// existence question outright — no listing at all. HEAD is also the verb
    /// that holds up best when the object store degrades: in one such event `head`
    /// was 0.005 s while `list` was 5.8 s.
    ///
    /// A 404 is `Absent`, not an error — see `head_object_failed`.
    pub async fn dir_marker_exists(
        &self,
        dir_key: &str,
        user_salt: &str,
        budget: std::time::Duration,
    ) -> Probe {
        let mut req = self.client.head_object().bucket(&self.bucket).key(dir_key);

        let (algo, key_b64, key_md5) = self.get_ssec(user_salt);
        req = req
            .sse_customer_algorithm(algo)
            .sse_customer_key(key_b64)
            .sse_customer_key_md5(key_md5);

        match timed_within_on(global(), S3Op::Head, budget, head_object_failed, req.send()).await {
            Some(Ok(_)) => Probe::Present,
            Some(Err(e)) => {
                if head_object_failed(&e) {
                    warn!(error = %e, key = %dir_key, "dir_marker_exists: S3 head failed");
                    Probe::Unknown
                } else {
                    Probe::Absent
                }
            }
            None => {
                warn!(
                    key = %dir_key,
                    budget_ms = budget.as_millis() as u64,
                    "dir_marker_exists: S3 did not answer inside the budget"
                );
                Probe::Unknown
            }
        }
    }

    pub async fn list_objects(&self, prefix: &str) -> Result<Vec<S3Object>, aws_sdk_s3::Error> {
        let mut results = Vec::new();
        let mut continuation_token: Option<String> = None;

        loop {
            let mut req = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(prefix);

            if let Some(token) = &continuation_token {
                req = req.continuation_token(token);
            }

            let resp = timed(S3Op::List, req.send()).await?;

            for obj in resp.contents() {
                if let Some(key) = obj.key.as_deref() {
                    results.push(S3Object {
                        key: key.to_string(),
                        size: obj.size.unwrap_or(0),
                        last_modified: obj
                            .last_modified
                            .as_ref()
                            .and_then(|t| std::time::SystemTime::try_from(*t).ok()),
                    });
                }
            }

            if resp.is_truncated.unwrap_or(false) {
                continuation_token = resp.next_continuation_token.clone();
            } else {
                break;
            }
        }

        Ok(results)
    }
}

/// One `reader.read`, bounded by `READ_IDLE_TIMEOUT`. A timeout reports `Ok(0)`
/// — the same shape as EOF — so both streaming loops finalise with the bytes
/// they already hold instead of hanging on a socket that will never deliver.
async fn read_or_idle(
    reader: &mut (impl tokio::io::AsyncRead + Unpin + Send),
    buf: &mut [u8],
) -> std::io::Result<usize> {
    match tokio::time::timeout(READ_IDLE_TIMEOUT, reader.read(buf)).await {
        Ok(res) => res,
        Err(_) => {
            warn!(
                idle_secs = READ_IDLE_TIMEOUT.as_secs(),
                "Upload stalled with no bytes — treating as end of stream"
            );
            Ok(0)
        }
    }
}

/// Spawn one `upload_part` call into the JoinSet, gated by a per-file
/// semaphore (MULTIPART_CONCURRENCY permits). The acquire happens before
/// spawning so the read loop naturally throttles when N parts are already
/// uploading for this file.
#[allow(clippy::too_many_arguments)]
async fn queue_part(
    joinset: &mut tokio::task::JoinSet<
        Result<CompletedPart, Box<dyn std::error::Error + Send + Sync>>,
    >,
    sem: std::sync::Arc<tokio::sync::Semaphore>,
    client: S3Client,
    bucket: String,
    key: String,
    upload_id: String,
    part_number: i32,
    data: Vec<u8>,
    algo: String,
    key_b64: String,
    key_md5: String,
) {
    let permit = sem.acquire_owned().await.expect("semaphore closed");
    joinset.spawn(async move {
        let _p = permit; // released when the task ends
        let bytes = Bytes::from(data);
        let len = bytes.len() as i64;
        let resp = timed(
            S3Op::UploadPart,
            client
                .upload_part()
                .bucket(bucket)
                .key(key)
                .upload_id(upload_id)
                .part_number(part_number)
                .body(ByteStream::from(bytes))
                .content_length(len)
                .sse_customer_algorithm(algo)
                .sse_customer_key(key_b64)
                .sse_customer_key_md5(key_md5)
                .send(),
        )
        .await
        // The failure is named here, where the SDK error is still typed. The join
        // loop in `put_object_stream` logs it once ([FTPS-166]).
        .map_err(|e| StoreFailure::from_sdk(S3Op::UploadPart, &e))?;
        Ok(CompletedPart::builder()
            .part_number(part_number)
            .set_e_tag(resp.e_tag.clone())
            .build())
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    ///story: [FTPS-038] Nazwy plików są dowolne: spacja, `+`, `%` i Unicode muszą trafić do nagłówka `x-amz-copy-source` jako sekwencje %XX (bajty UTF-8, wielkie litery hex), a ukośniki zostają, żeby klucz miał foldery. Bez tego rename pliku `Zażółć gęślą.mp4` kopiował zły obiekt albo padał.
    #[test]
    fn copy_source_percent_encodes_everything_but_the_unreserved_set() {
        assert_eq!(
            encode_copy_source("b", "u/2026/06/Cam_00_20260612121935.mp4"),
            "b/u/2026/06/Cam_00_20260612121935.mp4",
        );
        assert_eq!(
            encode_copy_source("b", "u/my clip+1%.mp4"),
            "b/u/my%20clip%2B1%25.mp4",
        );
        assert_eq!(
            encode_copy_source("b", "u/Zażółć.mp4"),
            "b/u/Za%C5%BC%C3%B3%C5%82%C4%87.mp4",
        );
        assert_eq!(encode_copy_source("b", "u/a~b-c.d"), "b/u/a~b-c.d");
    }

    ///story: [FTPS-038] Kodowanie musi działać na PRAWDZIWYM call site: `copy_object` wysyła zakodowany `x-amz-copy-source`, więc rename pliku ze spacją i Unicode wskazuje właściwy obiekt źródłowy.
    #[tokio::test]
    async fn copy_object_sends_an_encoded_copy_source() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                "<CopyObjectResult><ETag>\"e\"</ETag></CopyObjectResult>",
                "application/xml",
            ))
            .mount(&server)
            .await;

        s3_against(server.uri())
            .copy_object("u/a b/Zażółć.mp4", "u/final.mp4", "c2FsdHNhbHRzYWx0")
            .await
            .expect("copy must succeed");

        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        let source = requests[0]
            .headers
            .get("x-amz-copy-source")
            .expect("copy source header")
            .to_str()
            .unwrap();
        assert_eq!(source, "b/u/a%20b/Za%C5%BC%C3%B3%C5%82%C4%87.mp4");
    }

    ///story: Debug-format `S3` nigdy nie ujawnia `master_key` — to root sekret szyfrowania (IKM dla HKDF każdego klucza SSE-C). `S3` siedzi w `KlipgardStorage`, którą libunftp Debug-uje na sesyjnym instrumencie; `#[derive(Debug)]` wypisałby master key plaintextem do journald.
    #[test]
    fn debug_format_redacts_master_key() {
        let conf = S3ConfigBuilder::new()
            .behavior_version_latest()
            .region(Region::new("us-east-1"))
            .build();
        let client = S3Client::from_conf(conf);
        let s3 = S3 {
            client,
            bucket: "klipgard-recordings".to_string(),
            master_key: "SUPER_SECRET_MASTER_KEY_VALUE".to_string(),
            key_generation: KeyGeneration::V1,
        };

        let dbg = format!("{:?}", s3);

        assert!(
            !dbg.contains("SUPER_SECRET_MASTER_KEY_VALUE"),
            "S3 Debug leaked the encryption master_key: {}",
            dbg,
        );
        assert!(
            dbg.contains("<redacted>"),
            "S3 Debug must mark the redaction: {}",
            dbg,
        );
        assert!(
            dbg.contains("klipgard-recordings"),
            "S3 Debug should keep the (non-secret) bucket for ops: {}",
            dbg,
        );
    }

    // --- S3 latency instrumentation -------------------------------------
    //
    // These assert against the PROCESS-WIDE registry (`metrics::global()`),
    // because that is what production writes to and the point of the test is
    // that the real call sites are wired up. They therefore compare a
    // before/after delta rather than an absolute count, so they stay correct
    // no matter what else the test binary is doing concurrently.

    const LIST_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>b</Name><Prefix>p/</Prefix><KeyCount>1</KeyCount>
  <MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>
  <Contents><Key>p/one.mp4</Key><Size>17</Size></Contents>
</ListBucketResult>"#;

    fn s3_against(uri: String) -> S3 {
        s3_with_credentials(uri, "ak", "sk")
    }

    fn s3_with_credentials(uri: String, access_key: &str, secret_key: &str) -> S3 {
        let conf = S3ConfigBuilder::new()
            .behavior_version_latest()
            .region(Region::new("us-east-1"))
            .endpoint_url(uri)
            .force_path_style(true)
            .credentials_provider(Credentials::new(access_key, secret_key, None, None, "test"))
            .retry_config(RetryConfig::disabled())
            // `default-features = false` on aws-sdk-s3 means there is no
            // implicit HTTP client — the same pinned rustls connector
            // production uses has to be attached here too, or every request
            // fails with "No HTTP client was available" before it leaves the
            // process (and the test would then be measuring nothing).
            .http_client(
                HttpClientBuilder::new()
                    .tls_provider(tls::Provider::Rustls(tls::rustls_provider::CryptoMode::AwsLc))
                    .build_https(),
            )
            .build();
        S3 {
            client: S3Client::from_conf(conf),
            bucket: "b".to_string(),
            master_key: "0".repeat(64),
            key_generation: KeyGeneration::V1,
        }
    }

    /// A production-shaped `S3` built by `S3::new`, so the key generation
    /// comes from the same bucket rule the server uses at start-up.
    fn s3_from_config(uri: String, bucket: &str, v2_buckets: &[&str], master_v2: Option<&str>) -> S3 {
        let config = Config {
            ftp_port: 21,
            pasv_url: "0.0.0.0".to_string(),
            pasv_min: 30010,
            pasv_max: 30019,
            tls_cert_path: String::new(),
            tls_key_path: String::new(),
            metrics_port: 0,
            s3_endpoint: uri,
            s3_access_key: "ak".to_string(),
            s3_secret_key: "sk".to_string(),
            s3_credentials_source: crate::config::S3CredentialsSource::Shared,
            s3_recordings_bucket: bucket.to_string(),
            encryption_master_key: "first-master-key".to_string(),
            encryption_master_key_v2: master_v2.map(|k| k.to_string()),
            sse_v2_buckets: v2_buckets.iter().map(|b| b.to_string()).collect(),
            s3_ca_bundle: None,
            internal_api_url: String::new(),
            internal_api_key: String::new(),
            redis_url: String::new(),
            max_global_uploads: 1,
        };
        S3::new(&config)
    }

    /// The SSE-C key MD5 that every request to the mock server carried.
    async fn key_md5s(server: &wiremock::MockServer) -> Vec<String> {
        server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .map(|r| {
                r.headers
                    .get("x-amz-server-side-encryption-customer-key-md5")
                    .expect("SSE-C key md5 header")
                    .to_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    fn md5_of(master: &str, salt: &str, generation: KeyGeneration) -> String {
        ssec_headers(&derive_user_key(master, salt, generation)).2
    }

    ///story: [DATA-146] FTPS szyfruje kluczem generacji wynikającej z nazwy bucketu: bucket spoza `KLIPGARD_SSE_V2_BUCKETS` (także przy pustej liście, czyli domyślnie) dostaje dotychczasowy klucz generacji 1, a bucket z listy — klucz generacji 2 z własnym master key albo, bez niego, z dotychczasowym.
    #[tokio::test]
    async fn the_recordings_bucket_picks_the_key_generation() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        const SALT: &str = "c2FsdHNhbHRzYWx0";
        let cases: [(&str, &[&str], Option<&str>, String); 4] = [
            ("rec", &[], None, md5_of("first-master-key", SALT, KeyGeneration::V1)),
            ("rec", &["other"], Some("second-master-key"), md5_of("first-master-key", SALT, KeyGeneration::V1)),
            ("rec", &["other", "rec"], Some("second-master-key"), md5_of("second-master-key", SALT, KeyGeneration::V2)),
            ("rec", &["rec"], None, md5_of("first-master-key", SALT, KeyGeneration::V2)),
        ];
        for (bucket, v2, master_v2, expected) in cases {
            let server = MockServer::start().await;
            Mock::given(method("PUT"))
                .respond_with(ResponseTemplate::new(200))
                .mount(&server)
                .await;
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(200).set_body_raw("data", "application/octet-stream"))
                .mount(&server)
                .await;
            let s3 = s3_from_config(server.uri(), bucket, v2, master_v2);
            s3.put_object("u/a.mp4", Bytes::from_static(b"data"), SALT).await.expect("put");
            s3.get_object("u/a.mp4", SALT).await.expect("get");
            let md5s = key_md5s(&server).await;
            assert_eq!(md5s.len(), 2);
            for got in md5s {
                assert_eq!(got, expected, "bucket {bucket}, v2 list {v2:?}, own v2 key {master_v2:?}");
            }
        }
    }

    ///story: [DATA-146] Rename w FTPS to CopyObject w tym samym buckecie: źródło i cel mają tę samą generację, więc oba zestawy nagłówków SSE-C niosą ten sam klucz generacji bucketu.
    #[tokio::test]
    async fn copy_object_sends_the_bucket_generation_key_on_both_sides() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        const SALT: &str = "c2FsdHNhbHRzYWx0";
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                "<CopyObjectResult><ETag>\"e\"</ETag></CopyObjectResult>",
                "application/xml",
            ))
            .mount(&server)
            .await;
        s3_from_config(server.uri(), "rec", &["rec"], None)
            .copy_object("u/a.mp4", "u/b.mp4", SALT)
            .await
            .expect("copy");
        let requests = server.received_requests().await.unwrap();
        let expected = md5_of("first-master-key", SALT, KeyGeneration::V2);
        for header in [
            "x-amz-server-side-encryption-customer-key-md5",
            "x-amz-copy-source-server-side-encryption-customer-key-md5",
        ] {
            assert_eq!(requests[0].headers.get(header).unwrap().to_str().unwrap(), expected, "{header}");
        }
    }

    /// Sample of a `klipgard_ftps_*` series from the global registry.
    fn sample(needle: &str) -> u64 {
        crate::metrics::global()
            .render()
            .lines()
            .find(|l| l.starts_with(needle))
            .and_then(|l| l.rsplit(' ').next().map(|v| v.to_string()))
            .and_then(|v| v.parse::<f64>().ok())
            .map(|v| v as u64)
            .unwrap_or(0)
    }

    ///story: Metryki są warte tyle, ile wiernie odwzorowują prawdziwe wywołania — histogram, który nikt nie podpiął do call site'u, renderuje idealne zera i wygląda na zdrową produkcję. Ten test dowodzi, że `list_objects` naprawdę zasila serię `op="list"`.
    #[tokio::test]
    async fn list_objects_is_instrumented() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(LIST_XML, "application/xml"))
            .mount(&server)
            .await;

        let before = sample("klipgard_ftps_s3_request_duration_seconds_count{op=\"list\"}");
        let objects = s3_against(server.uri()).list_objects("p/").await.unwrap();

        assert_eq!(objects.len(), 1);
        assert_eq!(
            sample("klipgard_ftps_s3_request_duration_seconds_count{op=\"list\"}"),
            before + 1,
        );
    }

    ///story: Nieudane wywołanie S3 musi podbić licznik błędów przy PRAWDZIWYM call site, nie tylko w teście jednostkowym opakowania — bez tego wskaźnik błędów zostaje na zerze w trakcie awarii, dokładnie wtedy, gdy jedyny ślad po zerwanym uploadzie kamery jest w logu. Ale HEAD zwracający 404 to NIE awaria: `storage.rs::metadata` sonduje klucz i przy braku odpowiedzi cofa się do markera katalogu, więc brak obiektu to zwykły przepływ sterowania. Liczenie go jako błędu S3 dawało ~50% "błędów" na op="head" i z czasem odpaliłoby FtpsS3ErrorsSustained z komunikatem "recordings are being lost", gdy nic się nie dzieje.
    ///
    /// Oba przypadki żyją w JEDNYM teście, bo dzielą globalny rejestr metryk: osobne testy czytające `klipgard_ftps_s3_errors_total{op="head"}` ścigałyby się ze sobą przy równoległym uruchomieniu i asercje `before + 1` byłyby flaky.
    #[tokio::test]
    async fn head_counts_failures_but_not_missing_keys() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        // A 500 is a genuine S3 failure — it must be counted.
        let broken = MockServer::start().await;
        Mock::given(method("HEAD"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&broken)
            .await;

        let errors_before = sample("klipgard_ftps_s3_errors_total{op=\"head\"}");
        let res = s3_against(broken.uri()).head_object("k", "salt").await;

        assert!(res.is_err(), "a 500 from S3 must surface as an error");
        assert_eq!(
            sample("klipgard_ftps_s3_errors_total{op=\"head\"}"),
            errors_before + 1,
            "a 500 is an S3 failure and must be counted",
        );

        // A 404 is an answer, not a failure.
        let empty = MockServer::start().await;
        Mock::given(method("HEAD"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&empty)
            .await;

        let errors_before = sample("klipgard_ftps_s3_errors_total{op=\"head\"}");
        let observed_before =
            sample("klipgard_ftps_s3_request_duration_seconds_count{op=\"head\"}");
        let res = s3_against(empty.uri()).head_object("k", "salt").await;

        assert!(
            res.is_err(),
            "a missing key still surfaces as Err to the caller — only the metric changes"
        );
        assert_eq!(
            sample("klipgard_ftps_s3_errors_total{op=\"head\"}"),
            errors_before,
            "a 404 is a normal answer and must NOT count as an S3 error",
        );
        assert_eq!(
            sample("klipgard_ftps_s3_request_duration_seconds_count{op=\"head\"}"),
            observed_before + 1,
            "the duration of a 404 is still S3 latency and must still be observed",
        );

        // --- the same 404-vs-500 split, as `dir_marker_exists` reports it ---
        //
        // This lives HERE rather than in its own test for the reason given
        // above: `dir_marker_exists` is a HeadObject, so a separate test would
        // perturb the `op="head"` deltas this one asserts. (It did exactly that
        // when first written, which is how the hazard documented above got
        // confirmed a second time.)
        //
        // `cwd` depends on this distinction in both directions: `Absent` is
        // what lets it refuse a nonexistent directory with 550, and `Unknown`
        // is what makes it admit the client optimistically instead of turning
        // a broken S3 into a fabricated "no such directory".
        let present = MockServer::start().await;
        Mock::given(method("HEAD"))
            .respond_with(ResponseTemplate::new(200).append_header("content-length", "0"))
            .mount(&present)
            .await;
        assert_eq!(
            s3_against(present.uri())
                .dir_marker_exists("p/", "salt", std::time::Duration::from_secs(30))
                .await,
            Probe::Present,
        );

        assert_eq!(
            s3_against(empty.uri())
                .dir_marker_exists("p/", "salt", std::time::Duration::from_secs(30))
                .await,
            Probe::Absent,
            "a 404 means the marker is not there — an answer, not a fault",
        );

        assert_eq!(
            s3_against(broken.uri())
                .dir_marker_exists("p/", "salt", std::time::Duration::from_secs(30))
                .await,
            Probe::Unknown,
            "a 500 tells us nothing about whether the directory exists",
        );
    }

    const TRUNCATED_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>b</Name><Prefix>p/</Prefix><KeyCount>1</KeyCount>
  <MaxKeys>1</MaxKeys><IsTruncated>true</IsTruncated>
  <NextContinuationToken>MORE</NextContinuationToken>
  <Contents><Key>p/one.mp4</Key><Size>17</Size></Contents>
</ListBucketResult>"#;

    ///story: `cwd`/`metadata` potrzebują tylko odpowiedzi "czy cokolwiek tu jest", a brały ją z w pełni paginowanego `list_objects` — więc sprawdzenie istnienia katalogu kosztowało O(wszystkie strony) najwolniejszego czasownika S3, na najgorętszej ścieżce serwera. Gdy magazyn obiektów wystawia `list` na kilka sekund, kamery umierają na CWD przed STOR i tracą nagrania. Sonda MUSI zostać na jednej stronie nawet gdy S3 mówi `IsTruncated: true`, bo inaczej wracamy dokładnie do tego kosztu.
    #[tokio::test]
    async fn prefix_probe_asks_for_one_key_and_never_paginates() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(TRUNCATED_XML, "application/xml"))
            .mount(&server)
            .await;

        let verdict = s3_against(server.uri())
            .prefix_exists("p/", std::time::Duration::from_secs(30))
            .await;

        assert_eq!(verdict, Probe::Present);

        let reqs = server.received_requests().await.expect("recorded requests");
        assert_eq!(
            reqs.len(),
            1,
            "the probe followed the continuation token — that is the unbounded cost coming back",
        );
        let query = reqs[0].url.query().unwrap_or_default().to_string();
        assert!(
            query.contains("max-keys=1"),
            "the probe must cap the page at one key, got query {query:?}",
        );
    }

    ///story: Pusty prefiks musi dać jednoznaczne `Absent`, nie `Unknown` — bez tego `cwd` nigdy nie odmówi wejścia do nieistniejącego katalogu i 550 przestaje działać.
    #[tokio::test]
    async fn empty_prefix_is_absent_not_unknown() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        const EMPTY_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>b</Name><Prefix>p/</Prefix><KeyCount>0</KeyCount>
  <MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated>
</ListBucketResult>"#;

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(EMPTY_XML, "application/xml"))
            .mount(&server)
            .await;

        let verdict = s3_against(server.uri())
            .prefix_exists("p/", std::time::Duration::from_secs(30))
            .await;

        assert_eq!(verdict, Probe::Absent);
    }

    ///story: To jest regresja na utratę nagrań. Wolny S3 nie może trzymać kanału kontrolnego kamery — po budżecie sonda ma zwrócić `Unknown` i oddać sterowanie, a nie wisieć. Dodatkowo przekroczony budżet musi zostawić ślad w `klipgard_ftps_dir_probe_timeouts_total`, bo inaczej dokładnie ta awaria znowu będzie niewidoczna.
    #[tokio::test]
    async fn probe_past_its_budget_returns_unknown_and_is_counted() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_raw(LIST_XML, "application/xml")
                    .set_delay(std::time::Duration::from_secs(30)),
            )
            .mount(&server)
            .await;

        let timeouts_before = sample("klipgard_ftps_dir_probe_timeouts_total");
        let started = std::time::Instant::now();

        let verdict = s3_against(server.uri())
            .prefix_exists("p/", std::time::Duration::from_millis(150))
            .await;

        assert_eq!(verdict, Probe::Unknown);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the probe outlived its budget by {:?} — a camera would have hung up",
            started.elapsed(),
        );
        assert_eq!(
            sample("klipgard_ftps_dir_probe_timeouts_total"),
            timeouts_before + 1,
            "an unanswered probe must be counted, or this outage is invisible again",
        );
    }

    // --- A failed upload call says why ([FTPS-166], [FTPS-167], [FTPS-168]) ----
    //
    // These run `put_object_stream` against a mock object store, so they reach
    // the real call sites: the single PUT, CreateMultipartUpload, UploadPart and
    // CompleteMultipartUpload.

    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    const UPLOAD_SALT: &str = "c2FsdHNhbHRzYWx0";

    /// What a store under its free-space threshold answers to a write.
    const STORE_FULL_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>XMinioStorageFull</Code><Message>Storage backend has reached its minimum free drive threshold. Please delete a few objects to proceed.</Message><Key>a.mp4</Key><BucketName>b</BucketName><Resource>/b/a.mp4</Resource><RequestId>17A8B8E6C8D0B4A1</RequestId><HostId>dd9025bab4ad464b</HostId></Error>"#;
    const STORE_FULL_MESSAGE: &str = "Storage backend has reached its minimum free drive threshold. Please delete a few objects to proceed.";

    fn store_full_answer() -> ResponseTemplate {
        ResponseTemplate::new(507).set_body_raw(STORE_FULL_XML, "application/xml")
    }

    /// The four store calls an upload can fail at.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum UploadCall {
        Put,
        CreateMultipart,
        UploadPart,
        CompleteMultipart,
    }

    impl UploadCall {
        const ALL: [UploadCall; 4] = [
            UploadCall::Put,
            UploadCall::CreateMultipart,
            UploadCall::UploadPart,
            UploadCall::CompleteMultipart,
        ];

        /// Bytes that reach that call: below the part size for one PUT, one byte
        /// above it for a multipart upload with two parts.
        fn upload_len(self) -> u64 {
            match self {
                UploadCall::Put => 3,
                _ => MULTIPART_CHUNK as u64 + 1,
            }
        }

        /// Does this request make that call?
        fn is_call(self) -> fn(&Request) -> bool {
            match self {
                UploadCall::Put => is_put_object,
                UploadCall::CreateMultipart => is_create_multipart,
                UploadCall::UploadPart => is_upload_part,
                UploadCall::CompleteMultipart => is_complete_multipart,
            }
        }

        /// What a working store answers to that call.
        fn working_answer(self) -> ResponseTemplate {
            match self {
                UploadCall::Put => ResponseTemplate::new(200),
                UploadCall::CreateMultipart => ResponseTemplate::new(200).set_body_raw(
                    "<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>u/a.mp4</Key><UploadId>UP1</UploadId></InitiateMultipartUploadResult>",
                    "application/xml",
                ),
                UploadCall::UploadPart => ResponseTemplate::new(200).insert_header("ETag", "\"e1\""),
                UploadCall::CompleteMultipart => ResponseTemplate::new(200).set_body_raw(
                    "<CompleteMultipartUploadResult><Location>x</Location><Bucket>b</Bucket><Key>u/a.mp4</Key><ETag>\"e\"</ETag></CompleteMultipartUploadResult>",
                    "application/xml",
                ),
            }
        }
    }

    fn query_has(req: &Request, key: &str, value: Option<&str>) -> bool {
        req.url.query_pairs().any(|(k, v)| {
            k == key
                && match value {
                    Some(want) => v == want,
                    None => true,
                }
        })
    }

    fn is_put_object(req: &Request) -> bool {
        req.method.as_str() == "PUT" && query_has(req, "x-id", Some("PutObject"))
    }

    fn is_create_multipart(req: &Request) -> bool {
        req.method.as_str() == "POST" && query_has(req, "uploads", None)
    }

    fn is_upload_part(req: &Request) -> bool {
        req.method.as_str() == "PUT" && query_has(req, "x-id", Some("UploadPart"))
    }

    fn is_complete_multipart(req: &Request) -> bool {
        req.method.as_str() == "POST" && query_has(req, "uploadId", None)
    }

    fn is_abort_multipart(req: &Request) -> bool {
        req.method.as_str() == "DELETE" && query_has(req, "uploadId", None)
    }

    /// A store that answers every call of an upload correctly, except `failing`:
    /// that call gets `answer`.
    async fn store_failing_at(failing: UploadCall, answer: ResponseTemplate) -> MockServer {
        let server = MockServer::start().await;
        for call in UploadCall::ALL {
            let response = if call == failing {
                answer.clone()
            } else {
                call.working_answer()
            };
            Mock::given(call.is_call())
                .respond_with(response)
                .mount(&server)
                .await;
        }
        Mock::given(is_abort_multipart)
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        server
    }

    /// An address on this machine that nothing listens on.
    fn closed_port_uri() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a free port");
        let port = listener.local_addr().expect("local address").port();
        drop(listener);
        format!("http://127.0.0.1:{port}")
    }

    async fn upload_of(
        s3: &S3,
        key: &str,
        call: UploadCall,
    ) -> Result<i64, Box<dyn std::error::Error + Send + Sync>> {
        let mut reader = tokio::io::repeat(b'x').take(call.upload_len());
        s3.put_object_stream(key, &[], &mut reader, UPLOAD_SALT, i64::MAX)
            .await
    }

    async fn failed_upload(
        server: &MockServer,
        call: UploadCall,
    ) -> Box<dyn std::error::Error + Send + Sync> {
        upload_of(&s3_against(server.uri()), "u/a.mp4", call)
            .await
            .expect_err("the store refuses this call, so the upload must fail")
    }

    ///story: [FTPS-166] Gdy magazyn obiektów odpowiada błędem na wywołanie uploadu (PutObject, CreateMultipartUpload, UploadPart albo CompleteMultipartUpload), błąd wychodzący z `put_object_stream` musi nazywać tę odpowiedź: status HTTP, kod i komunikat S3. Goły `service error` kazał szukać przyczyny w logu MinIO i w `df`.
    #[tokio::test]
    async fn a_failed_upload_call_names_the_answer_of_the_store() {
        for call in UploadCall::ALL {
            let server = store_failing_at(call, store_full_answer()).await;

            let text = failed_upload(&server, call).await.to_string();

            for fact in ["507", "XMinioStorageFull", STORE_FULL_MESSAGE] {
                assert!(
                    text.contains(fact),
                    "{call:?}: the failure reads {text:?}, which does not hold {fact:?}",
                );
            }
        }
    }

    ///story: [FTPS-166] Gdy magazyn nie odpowiada wcale (odmowa połączenia, zły certyfikat, timeout), nie ma ani statusu, ani kodu — błąd ma wtedy nazwać przyczynę, którą zgłasza SDK, a nie sam `dispatch failure`.
    #[tokio::test]
    async fn an_upload_that_gets_no_answer_names_the_cause_from_the_sdk() {
        let err = upload_of(&s3_against(closed_port_uri()), "u/a.mp4", UploadCall::Put)
            .await
            .expect_err("nothing listens there, so the upload must fail");

        let text = err.to_string().to_lowercase();

        assert!(
            text.contains("refused"),
            "the failure reads {text:?}, which does not say why the connection failed",
        );
    }

    struct CaptureWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for CaptureWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// What `tracing` wrote in this test binary at the level a default install
    /// logs (`RUST_LOG=info`).
    ///
    /// The subscriber is process-wide on purpose. Tests run in parallel, and
    /// `tracing` caches per call site whether it is enabled: a subscriber that
    /// belongs to one test thread lost events that another test thread had
    /// evaluated first. A test picks its own lines out by a key that only it uses.
    fn log_text() -> String {
        static BUFFER: std::sync::OnceLock<std::sync::Arc<std::sync::Mutex<Vec<u8>>>> =
            std::sync::OnceLock::new();
        let buffer = BUFFER.get_or_init(|| {
            let buffer = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let writer = buffer.clone();
            let subscriber = tracing_subscriber::fmt()
                .with_writer(move || CaptureWriter(writer.clone()))
                .with_ansi(false)
                .with_max_level(tracing::Level::INFO)
                .finish();
            tracing::subscriber::set_global_default(subscriber)
                .expect("no other test installs a global tracing subscriber");
            buffer
        });
        String::from_utf8_lossy(&buffer.lock().unwrap()).into_owned()
    }

    ///story: [FTPS-166] [FTPS-167] To, co serwer naprawdę zapisuje w logu po nieudanym uploadzie, nazywa przyczynę (kod, status i komunikat magazynu, a gdy magazyn milczy — przyczynę z SDK), pojawia się raz na nieudany upload i nie zawiera ani danych dostępowych do magazynu, ani klucza SSE-C, ani nagłówków żądania.
    #[tokio::test]
    async fn the_log_of_a_failed_upload_names_the_cause_and_holds_no_secret() {
        const ACCESS_KEY: &str = "AKIAFTPSLOGTESTKEY1";
        const SECRET_KEY: &str = "fTpSlOgTeStSeCrEtKeY0123456789";
        const ANSWERED_KEY: &str = "u/ftps166-log-answered.mp4";
        const SILENT_KEY: &str = "u/ftps166-log-silent.mp4";

        log_text(); // installs the subscriber before the first event
        let full = store_failing_at(UploadCall::UploadPart, store_full_answer()).await;
        let answering = s3_with_credentials(full.uri(), ACCESS_KEY, SECRET_KEY);
        let silent = s3_with_credentials(closed_port_uri(), ACCESS_KEY, SECRET_KEY);

        let _ = upload_of(&answering, ANSWERED_KEY, UploadCall::UploadPart).await;
        let _ = upload_of(&silent, SILENT_KEY, UploadCall::Put).await;

        let text = log_text();
        let errors_for = |key: &str| -> Vec<&str> {
            text.lines()
                .filter(|line| line.contains(" ERROR ") && line.contains(key))
                .collect()
        };
        let answered = errors_for(ANSWERED_KEY);
        assert_eq!(
            answered.len(),
            1,
            "one error line for one failed upload:\n{answered:#?}"
        );
        for fact in ["507", "XMinioStorageFull", STORE_FULL_MESSAGE] {
            assert!(
                answered[0].contains(fact),
                "the line lacks {fact:?}: {}",
                answered[0]
            );
        }
        let silent_lines = errors_for(SILENT_KEY);
        assert_eq!(
            silent_lines.len(),
            1,
            "one error line for one failed upload:\n{silent_lines:#?}"
        );
        assert!(
            silent_lines[0].to_lowercase().contains("refused"),
            "the line does not say why the silent store failed: {}",
            silent_lines[0],
        );
        let (_, sse_key, sse_key_md5) = answering.get_ssec(UPLOAD_SALT);
        for secret in [
            ACCESS_KEY,
            SECRET_KEY,
            sse_key.as_str(),
            sse_key_md5.as_str(),
            "x-amz-server-side-encryption-customer-key",
            "AWS4-HMAC-SHA256",
        ] {
            assert!(!text.contains(secret), "the log shows {secret:?}");
        }
    }

    ///story: [FTPS-168] [FTPS-150] Pełny magazyn jest obsługiwany jak każdy inny błąd magazynu: nieudana część przerywa upload wieloczęściowy (AbortMultipartUpload), więc magazyn nie trzyma porzuconych części.
    #[tokio::test]
    async fn a_failed_part_aborts_the_multipart_upload() {
        let server = store_failing_at(UploadCall::UploadPart, store_full_answer()).await;

        failed_upload(&server, UploadCall::UploadPart).await;

        // The abort runs in a detached task. Wait for it instead of sleeping a fixed time.
        let aborted = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let requests = server.received_requests().await.expect("recorded requests");
                if requests.iter().any(is_abort_multipart) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(aborted.is_ok(), "no AbortMultipartUpload reached the store");
    }

    fn as_store_failure<'a>(
        err: &'a (dyn std::error::Error + Send + Sync + 'static),
    ) -> &'a StoreFailure {
        err.downcast_ref::<StoreFailure>()
            .unwrap_or_else(|| panic!("the failure of the upload is not a StoreFailure: {err:?}"))
    }

    ///story: [FTPS-168] Pełny magazyn musi być rozpoznany na KAŻDYM wywołaniu uploadu, nie tylko na jednym: pojedynczy PUT, CreateMultipartUpload, UploadPart i CompleteMultipartUpload zwracają błąd z nazwą wywołania, statusem 507, kodem i komunikatem magazynu.
    #[tokio::test]
    async fn a_full_store_is_recognised_at_every_upload_call() {
        let cases = [
            (UploadCall::Put, S3Op::Put),
            (UploadCall::CreateMultipart, S3Op::CreateMultipart),
            (UploadCall::UploadPart, S3Op::UploadPart),
            (UploadCall::CompleteMultipart, S3Op::CompleteMultipart),
        ];
        for (call, op) in cases {
            let server = store_failing_at(call, store_full_answer()).await;

            let err = failed_upload(&server, call).await;

            let failure = as_store_failure(&*err);
            assert_eq!(failure.op, op, "{call:?}");
            assert_eq!(failure.status, Some(507), "{call:?}");
            assert_eq!(
                failure.code.as_deref(),
                Some("XMinioStorageFull"),
                "{call:?}"
            );
            assert_eq!(
                failure.message.as_deref(),
                Some(STORE_FULL_MESSAGE),
                "{call:?}"
            );
            assert!(failure.is_full(), "{call:?}");
        }
    }

    ///story: [FTPS-168] [FTPS-166] Za pełny magazyn uchodzi WYŁĄCZNIE odpowiedź ze statusem HTTP 507 — także gdy ciało nie jest XML-em S3 (proxy przed magazynem). Każdy inny błąd (403 Backblaze B2 przy osiągniętym limicie, 500, 503, 404) zostaje zwykłym błędem magazynu z odpowiedzią 451 jak dotąd, a jego log nadal pokazuje to, co magazyn powiedział.
    #[tokio::test]
    async fn only_status_507_is_a_full_store() {
        let s3_error = |status: u16, code: &str, message: &str| {
            ResponseTemplate::new(status).set_body_raw(
                format!("<Error><Code>{code}</Code><Message>{message}</Message></Error>"),
                "application/xml",
            )
        };
        // (what the store answers, is it a full store, text that the failure must show)
        let cases: [(&str, ResponseTemplate, bool, &str); 7] = [
            ("store full", store_full_answer(), true, "XMinioStorageFull"),
            (
                "507 without a body",
                ResponseTemplate::new(507),
                true,
                "HTTP status 507",
            ),
            (
                "507 from a proxy in front of the store",
                ResponseTemplate::new(507).set_body_raw(
                    "<html><body>507 Insufficient Storage</body></html>",
                    "text/html",
                ),
                true,
                "HTTP status 507",
            ),
            (
                "storage cap of the store reached, 403",
                s3_error(
                    403,
                    "AccessDenied",
                    "Cannot upload files, storage cap exceeded.",
                ),
                false,
                "Cannot upload files, storage cap exceeded.",
            ),
            (
                "internal error, 500",
                s3_error(500, "InternalError", "We encountered an internal error."),
                false,
                "InternalError",
            ),
            (
                "slow down, 503",
                s3_error(503, "SlowDown", "Please reduce your request rate."),
                false,
                "SlowDown",
            ),
            (
                "no such bucket, 404",
                s3_error(404, "NoSuchBucket", "The specified bucket does not exist."),
                false,
                "NoSuchBucket",
            ),
        ];
        for (label, answer, full, shown) in cases {
            let server = store_failing_at(UploadCall::Put, answer).await;

            let err = failed_upload(&server, UploadCall::Put).await;

            assert_eq!(as_store_failure(&*err).is_full(), full, "{label}");
            assert!(
                err.to_string().contains(shown),
                "{label}: the failure reads {:?}, which does not show {shown:?}",
                err.to_string(),
            );
        }
    }
}
