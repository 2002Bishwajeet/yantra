//! `yantra-stt`: the dictation service on the box ([ADR-0043]). It loads the
//! model once and answers `POST /transcribe` on the tailnet address it is given.
//!
//! [ADR-0043]: ../../../docs/adr/0043-dictation-runs-a-local-speech-model.md

mod http;
mod model;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Instant;

use clap::{Parser, Subcommand};
use model::Parakeet;

#[derive(Parser)]
#[command(version, about = "Speech to text for Yantra's dictation")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(clap::Args)]
struct Model {
    /// The directory of the int8 Parakeet files and `bpe.vocab`.
    #[arg(long)]
    model: PathBuf,
    #[arg(long, default_value_t = 4)]
    threads: i32,
}

#[derive(Subcommand)]
enum Command {
    /// Answer `POST /transcribe` and `GET /health`.
    Serve {
        /// The box's tailnet address and a port, never `0.0.0.0`.
        #[arg(long)]
        listen: SocketAddr,
        #[command(flatten)]
        model: Model,
    },
    /// Decode WAV files and print the real-time factor and the peak RSS.
    Bench {
        #[command(flatten)]
        model: Model,
        /// A file of hotwords, one per line.
        #[arg(long)]
        hotwords: Option<PathBuf>,
        #[arg(required = true)]
        wavs: Vec<PathBuf>,
    },
}

fn main() -> ExitCode {
    // stderr reaches the journal; the unit sends stdout nowhere (§7).
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();
    let outcome = match Cli::parse().command {
        Command::Serve { listen, model } => serve(listen, &model),
        Command::Bench {
            model,
            hotwords,
            wavs,
        } => bench(&model, hotwords, &wavs),
    };
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(said) => {
            tracing::error!("{said}");
            ExitCode::FAILURE
        }
    }
}

fn serve(listen: SocketAddr, model: &Model) -> Result<(), String> {
    let loaded = Parakeet::load(&model.model, model.threads)?;
    let runtime = tokio::runtime::Runtime::new().map_err(|error| error.to_string())?;
    runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind(listen)
            .await
            .map_err(|error| format!("could not listen on {listen}: {error}"))?;
        tracing::info!("yantra-stt listening on {listen}");
        axum::serve(listener, http::router(Arc::new(loaded)))
            .await
            .map_err(|error| error.to_string())
    })
}

fn bench(model: &Model, hotwords: Option<PathBuf>, wavs: &[PathBuf]) -> Result<(), String> {
    let hotwords = match hotwords {
        Some(path) => std::fs::read_to_string(&path)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?,
        None => String::new(),
    };
    let started = Instant::now();
    let loaded = Parakeet::load(&model.model, model.threads)?;
    println!(
        "load {:.2} s, {} threads",
        started.elapsed().as_secs_f64(),
        model.threads
    );

    let (mut audio, mut decoding) = (0.0, 0.0);
    for path in wavs {
        let shown = path.display();
        let wave = sherpa_onnx::Wave::read(&path.to_string_lossy())
            .ok_or_else(|| format!("could not read {shown} as a mono WAV"))?;
        let seconds = f64::from(wave.num_samples()) / f64::from(wave.sample_rate());
        let started = Instant::now();
        let text = loaded
            .decode(wave.sample_rate(), wave.samples(), hotwords.trim())
            .ok_or_else(|| format!("the model did not decode {shown}"))?;
        let took = started.elapsed().as_secs_f64();
        println!("{shown}\t{seconds:.2} s\t{took:.2} s\t{}", text.trim());
        audio += seconds;
        decoding += took;
    }
    println!("RTF {:.3} over {audio:.1} s of audio", decoding / audio);
    println!(
        "peak RSS {}",
        peak_rss().unwrap_or_else(|| "unknown".to_owned())
    );
    Ok(())
}

/// `VmHWM`, the high-water mark of the resident set.
fn peak_rss() -> Option<String> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("VmHWM:"))?;
    let kib: f64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(format!("{:.2} GB", kib * 1024.0 / 1e9))
}
