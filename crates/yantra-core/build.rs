fn main() {
    println!(
        "cargo:rustc-env=YANTRA_TARGET={}",
        std::env::var("TARGET").unwrap_or_default()
    );
    println!(
        "cargo:rustc-env=YANTRA_BUILT={}",
        time::OffsetDateTime::now_utc().date()
    );
}
