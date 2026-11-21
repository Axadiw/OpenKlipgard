use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    // FTP
    pub ftp_port: u16,
    pub pasv_url: String,
    pub pasv_min: u16,
    pub pasv_max: u16,
    pub tls_cert_path: String,
    pub tls_key_path: String,
    /// Port for the Prometheus /metrics endpoint. `0` disables it entirely —
    /// local dev and the e2e stack have no scraper and no reason to open a
    /// listener. See src/metrics.rs for why this is a separate port and not a
    /// path on :21.
    pub metrics_port: u16,

    // S3
    pub s3_endpoint: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,
    /// Which variables `s3_access_key` / `s3_secret_key` came from. Logged at
    /// startup so an operator can see which key a pod uses without reading
    /// the secret itself.
    pub s3_credentials_source: S3CredentialsSource,
    pub s3_recordings_bucket: String,

    // Encryption
    pub encryption_master_key: String,
    /// `KLIPGARD_ENCRYPTION_MASTER_KEY_V2`: master key of SSE-C key generation
    /// 2. `None` (unset or empty): generation 2 uses `encryption_master_key`.
    pub encryption_master_key_v2: Option<String>,
    /// `KLIPGARD_SSE_V2_BUCKETS`: buckets whose objects use SSE-C key
    /// generation 2 (spec DATA-146). Empty (the default): every bucket is
    /// generation 1.
    pub sse_v2_buckets: Vec<String>,
    /// PEM CA bundle for self-signed S3 TLS cert (local dev only).
    /// Set KLIPGARD_S3_CA_BUNDLE; unset in production.
    pub s3_ca_bundle: Option<String>,

    // Internal API
    pub internal_api_url: String,
    pub internal_api_key: String,

    // Redis — distributed locks (transfer flush) + Streams publisher
    // (scan-trigger, delete-notify).
    pub redis_url: String,

    /// `MAX_GLOBAL_UPLOADS`: process-wide ceiling on in-flight uploads
    /// (spec FTPS-165). Sized from the pod memory budget.
    pub max_global_uploads: usize,
}

/// Default for `MAX_GLOBAL_UPLOADS`: about 60 % of the 2 GiB pod limit
/// (1228 MiB) divided by the ~16 MiB buffer of one upload.
pub const DEFAULT_MAX_GLOBAL_UPLOADS: usize = 76;

/// Where the object-store credentials of this process came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum S3CredentialsSource {
    /// `KLIPGARD_FTPS_S3_ACCESS_KEY` / `KLIPGARD_FTPS_S3_SECRET_KEY`: a key
    /// that only this server holds.
    Dedicated,
    /// `KLIPGARD_S3_ACCESS_KEY` / `KLIPGARD_S3_SECRET_KEY`: the key the other
    /// components use.
    Shared,
}

impl S3CredentialsSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dedicated => "dedicated (KLIPGARD_FTPS_S3_*)",
            Self::Shared => "shared (KLIPGARD_S3_*)",
        }
    }
}

impl Config {
    pub fn from_env() -> Self {
        let (s3_access_key, s3_secret_key, s3_credentials_source) = s3_credentials(
            env::var("KLIPGARD_FTPS_S3_ACCESS_KEY").ok(),
            env::var("KLIPGARD_FTPS_S3_SECRET_KEY").ok(),
            env::var("KLIPGARD_S3_ACCESS_KEY").ok(),
            env::var("KLIPGARD_S3_SECRET_KEY").ok(),
        )
        .unwrap_or_else(|e| panic!("{e}"));
        Self {
            ftp_port: env::var("FTP_PORT")
                .unwrap_or_else(|_| "21".to_string())
                .parse()
                .expect("FTP_PORT must be a valid port number"),
            pasv_url: env::var("FTP_PASV_URL").unwrap_or_else(|_| "0.0.0.0".to_string()),
            pasv_min: env::var("FTP_PASV_MIN")
                .unwrap_or_else(|_| "30010".to_string())
                .parse()
                .expect("FTP_PASV_MIN must be a valid port number"),
            pasv_max: env::var("FTP_PASV_MAX")
                .unwrap_or_else(|_| "30019".to_string())
                .parse()
                .expect("FTP_PASV_MAX must be a valid port number"),
            tls_cert_path: env::var("TLS_CERT_PATH")
                .unwrap_or_else(|_| "/certs/fullchain.pem".to_string()),
            metrics_port: env::var("KLIPGARD_FTPS_METRICS_PORT")
                .unwrap_or_else(|_| "9106".to_string())
                .parse()
                .expect("KLIPGARD_FTPS_METRICS_PORT must be a valid port number"),
            tls_key_path: env::var("TLS_KEY_PATH")
                .unwrap_or_else(|_| "/certs/privkey.pem".to_string()),

            s3_endpoint: env::var("KLIPGARD_S3_ENDPOINT")
                .expect("KLIPGARD_S3_ENDPOINT is required"),
            s3_access_key,
            s3_secret_key,
            s3_credentials_source,
            s3_recordings_bucket: env::var("KLIPGARD_S3_RECORDINGS_BUCKET")
                .unwrap_or_else(|_| "recordings".to_string()),

            encryption_master_key: env::var("KLIPGARD_ENCRYPTION_MASTER_KEY")
                .expect("KLIPGARD_ENCRYPTION_MASTER_KEY is required"),
            encryption_master_key_v2: env::var("KLIPGARD_ENCRYPTION_MASTER_KEY_V2")
                .ok()
                .filter(|v| !v.is_empty()),
            sse_v2_buckets: bucket_list(env::var("KLIPGARD_SSE_V2_BUCKETS").ok()),
            s3_ca_bundle: env::var("KLIPGARD_S3_CA_BUNDLE").ok(),

            internal_api_url: env::var("KLIPGARD_INTERNAL_API_URL")
                .unwrap_or_else(|_| "http://klipgard-api:3000".to_string()),
            internal_api_key: internal_api_key(
                env::var("KLIPGARD_INTERNAL_API_KEY").ok(),
                env::var("KLIPGARD_INTERNAL_API_KEY_FILE").ok(),
            )
            .expect("KLIPGARD_INTERNAL_API_KEY or KLIPGARD_INTERNAL_API_KEY_FILE is required"),
            redis_url: env::var("REDIS_URL").unwrap_or_else(|_| "redis://redis:6379".to_string()),
            max_global_uploads: env::var("MAX_GLOBAL_UPLOADS")
                .ok()
                .and_then(|v| v.parse::<usize>().ok())
                .filter(|v| *v > 0)
                .unwrap_or(DEFAULT_MAX_GLOBAL_UPLOADS),
        }
    }
}

/// The object-store key pair: the dedicated pair when both variables are
/// non-empty, otherwise the shared pair. An empty value counts as unset.
/// A dedicated pair with one half only is an error, not a fallback: the
/// halves of two different keys would fail every request with a 403, and a
/// camera never retries an upload. The shared pair is required when no
/// dedicated pair is set.
fn s3_credentials(
    ftps_access: Option<String>,
    ftps_secret: Option<String>,
    shared_access: Option<String>,
    shared_secret: Option<String>,
) -> Result<(String, String, S3CredentialsSource), String> {
    let set = |v: Option<String>| v.filter(|v| !v.is_empty());
    match (set(ftps_access), set(ftps_secret)) {
        (Some(a), Some(s)) => Ok((a, s, S3CredentialsSource::Dedicated)),
        (Some(_), None) | (None, Some(_)) => Err(
            "KLIPGARD_FTPS_S3_ACCESS_KEY and KLIPGARD_FTPS_S3_SECRET_KEY must be set together"
                .to_string(),
        ),
        (None, None) => {
            let a = set(shared_access).ok_or(
                "KLIPGARD_S3_ACCESS_KEY is required (or KLIPGARD_FTPS_S3_ACCESS_KEY with KLIPGARD_FTPS_S3_SECRET_KEY)",
            )?;
            let s = set(shared_secret).ok_or(
                "KLIPGARD_S3_SECRET_KEY is required (or KLIPGARD_FTPS_S3_ACCESS_KEY with KLIPGARD_FTPS_S3_SECRET_KEY)",
            )?;
            Ok((a, s, S3CredentialsSource::Shared))
        }
    }
}

/// The key presented to the API on /internal: KLIPGARD_INTERNAL_API_KEY when
/// set, otherwise the contents of the file KLIPGARD_INTERNAL_API_KEY_FILE
/// names (the self-hosted install generates one on first start). Same rule
/// as `internalApiKeyFromEnv` in server/config.ts.
fn internal_api_key(value: Option<String>, file: Option<String>) -> Option<String> {
    if let Some(v) = value.filter(|v| !v.is_empty()) {
        return Some(v);
    }
    let path = file.filter(|p| !p.is_empty())?;
    let key = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read KLIPGARD_INTERNAL_API_KEY_FILE {path}: {e}"));
    Some(key.trim().to_string()).filter(|k| !k.is_empty())
}

/// A comma-separated bucket list. Blanks around a name are ignored, empty
/// entries are dropped. Same rule as `sseV2BucketsFromEnv` in server/config.ts.
fn bucket_list(raw: Option<String>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{bucket_list, internal_api_key, s3_credentials, S3CredentialsSource};

    ///story: [DATA-146] `KLIPGARD_SSE_V2_BUCKETS` nieustawione lub puste to pusta lista — każdy bucket zostaje w generacji 1. Spacje wokół nazw nie psują dopasowania.
    #[test]
    fn the_v2_bucket_list_is_comma_separated_and_empty_by_default() {
        assert!(bucket_list(None).is_empty());
        assert!(bucket_list(some("")).is_empty());
        assert!(bucket_list(some(" , ")).is_empty());
        assert_eq!(bucket_list(some("a, b ,,c")), vec!["a", "b", "c"]);
    }

    fn some(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    // [DATA-095] [DATA-145] [FTPS-156]
    #[test]
    fn the_dedicated_s3_pair_wins_over_the_shared_pair() {
        let got = s3_credentials(
            some("ftps-id"),
            some("ftps-sec"),
            some("app-id"),
            some("app-sec"),
        );
        assert_eq!(
            got,
            Ok((
                "ftps-id".into(),
                "ftps-sec".into(),
                S3CredentialsSource::Dedicated
            ))
        );
    }

    // [DATA-095] [DATA-145] [FTPS-156]
    #[test]
    fn without_a_dedicated_pair_the_shared_pair_is_used() {
        for (a, s) in [(None, None), (some(""), some(""))] {
            let got = s3_credentials(a, s, some("app-id"), some("app-sec"));
            assert_eq!(
                got,
                Ok((
                    "app-id".into(),
                    "app-sec".into(),
                    S3CredentialsSource::Shared
                ))
            );
        }
    }

    // [DATA-095] [DATA-145] [FTPS-156]
    #[test]
    fn a_dedicated_pair_with_one_half_is_refused_not_mixed() {
        let only_id = s3_credentials(some("ftps-id"), None, some("app-id"), some("app-sec"));
        assert!(only_id.unwrap_err().contains("must be set together"));
        let only_secret =
            s3_credentials(some(""), some("ftps-sec"), some("app-id"), some("app-sec"));
        assert!(only_secret.unwrap_err().contains("must be set together"));
    }

    // [FTPS-157] The label names the variables, never a value.
    #[test]
    fn the_credentials_label_names_the_pair_and_no_key() {
        assert!(S3CredentialsSource::Dedicated
            .as_str()
            .contains("KLIPGARD_FTPS_S3_"));
        assert!(S3CredentialsSource::Shared
            .as_str()
            .contains("KLIPGARD_S3_"));
    }

    // [FTPS-141] [FTPS-156]
    #[test]
    fn no_pair_at_all_is_refused() {
        assert!(s3_credentials(None, None, None, None).is_err());
        assert!(s3_credentials(None, None, some("app-id"), None).is_err());
        assert!(s3_credentials(None, None, some(""), some("app-sec")).is_err());
    }

    #[test]
    fn the_variable_wins_over_the_file() {
        let key = internal_api_key(Some("from-env".into()), Some("/nonexistent".into()));
        assert_eq!(key.as_deref(), Some("from-env"));
    }

    #[test]
    fn the_file_is_read_and_trimmed_when_the_variable_is_empty() {
        let dir = std::env::temp_dir().join(format!("ikey-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("internal-api-key");
        std::fs::write(&path, "abc123\n").unwrap();
        let key = internal_api_key(Some(String::new()), Some(path.display().to_string()));
        assert_eq!(key.as_deref(), Some("abc123"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn neither_means_none() {
        assert_eq!(internal_api_key(None, None), None);
        assert_eq!(
            internal_api_key(Some(String::new()), Some(String::new())),
            None
        );
    }
}
