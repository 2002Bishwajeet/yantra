//! Parakeet-TDT-0.6B-v2, int8, run by sherpa-onnx ([ADR-0043] §1–2).
//!
//! Hotwords need `modified_beam_search` and a BPE vocabulary (R26 §2). The
//! model ships `tokens.txt`; `bpe.vocab` is made from it once, as the README says.
//!
//! [ADR-0043]: ../../../docs/adr/0043-dictation-runs-a-local-speech-model.md

use std::path::Path;

use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig};
use yantra_core::stt::{HOTWORD_SCORE, RATE};

use crate::http::Recognise;

/// The files a model directory must hold.
const FILES: [&str; 5] = [
    "encoder.int8.onnx",
    "decoder.int8.onnx",
    "joiner.int8.onnx",
    "tokens.txt",
    "bpe.vocab",
];

pub struct Parakeet(OfflineRecognizer);

impl Parakeet {
    pub fn load(dir: &Path, threads: i32) -> Result<Self, String> {
        let file = |name: &str| dir.join(name).to_string_lossy().into_owned();
        if let Some(missing) = FILES.iter().find(|name| !dir.join(name).is_file()) {
            return Err(format!("{} has no {missing}", dir.display()));
        }
        let mut config = OfflineRecognizerConfig::default();
        config.model_config.transducer = OfflineTransducerModelConfig {
            encoder: Some(file(FILES[0])),
            decoder: Some(file(FILES[1])),
            joiner: Some(file(FILES[2])),
        };
        config.model_config.tokens = Some(file(FILES[3]));
        config.model_config.bpe_vocab = Some(file(FILES[4]));
        config.model_config.modeling_unit = Some("bpe".into());
        config.model_config.model_type = Some("nemo_transducer".into());
        config.model_config.num_threads = threads;
        config.decoding_method = Some("modified_beam_search".into());
        config.hotwords_score = HOTWORD_SCORE;
        OfflineRecognizer::create(&config)
            .map(Self)
            .ok_or_else(|| format!("sherpa-onnx could not load the model in {}", dir.display()))
    }

    /// Text at any sample rate: sherpa-onnx resamples to the model's own.
    pub fn decode(&self, rate: i32, samples: &[f32], hotwords: &str) -> Option<String> {
        let stream = if hotwords.is_empty() {
            self.0.create_stream()
        } else {
            self.0.create_stream_with_hotwords(hotwords)
        };
        stream.accept_waveform(rate, samples);
        self.0.decode(&stream);
        stream.get_result().map(|result| result.text)
    }
}

impl Recognise for Parakeet {
    fn transcribe(&self, samples: &[f32], hotwords: &str) -> Option<String> {
        #[allow(clippy::cast_possible_truncation, clippy::cast_possible_wrap)]
        self.decode(RATE as i32, samples, hotwords)
    }
}
