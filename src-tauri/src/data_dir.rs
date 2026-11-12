use std::path::PathBuf;

/// Debug-only native smoke runs must not reconcile real telemetry/cloud jobs.
/// Release builds always use the established ~/.powerhouse location.
pub(crate) fn test_root() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        std::env::var_os("POWERHOUSE_TEST_DATA_DIR")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}
pub(crate) fn root() -> Option<PathBuf> {
    test_root().or_else(|| dirs::home_dir().map(|p| p.join(".powerhouse")))
}
