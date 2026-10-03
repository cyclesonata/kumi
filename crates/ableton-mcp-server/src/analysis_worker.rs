//! Port of `apps/mcp-server/src/analysis-worker.ts`: the benchmark's isolated analysis run.
//!
//! It analyzes the largest allowed programme three times and reports latencies, output size and
//! peak memory. A native process has no JavaScript heap: `peakRssBytes` is the process's peak
//! resident size, and the three V8 heap figures the benchmark reads are reported as 0.

use std::f64::consts::PI;

use kumi_common::js::{json, number};
use kumi_common::time::perf_now;
use serde_json::json as json_value;

use crate::analysis::{analyze_pcm, PcmAnalysisInput, MAX_ANALYSIS_SAMPLES};

/// The process's peak resident set size in bytes, where the platform reports one.
fn peak_rss_bytes() -> u64 {
    #[cfg(unix)]
    {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
        // SAFETY: getrusage writes a complete rusage into the buffer it is given.
        let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
        if result == 0 {
            let usage = unsafe { usage.assume_init() };
            let maxrss = usage.ru_maxrss.max(0) as u64;
            // macOS counts bytes; Linux counts kilobytes.
            return if cfg!(target_os = "macos") { maxrss } else { maxrss * 1024 };
        }
    }
    0
}

/// `args` are the command-line arguments after the program name: `--slow=<ms>` and `--allocate`.
pub fn main(args: &[String]) -> i32 {
    let slow_milliseconds = args.iter().find_map(|value| value.strip_prefix("--slow=")).and_then(number::parse).unwrap_or(0.0);
    let allocation_mode = args.iter().any(|value| value == "--allocate");
    let samples: Vec<f64> =
        (0..MAX_ANALYSIS_SAMPLES).map(|index| (0.5 * ((2.0 * PI * 440.0 * index as f64) / 48_000.0).sin()) as f32 as f64).collect();
    let input = PcmAnalysisInput { samples: &samples, sample_rate: 48_000.0, channels: None, channel_layout: None, frame_size: None };
    let mut retained: Vec<Vec<f64>> = Vec::new();
    let mut latency_measurements: Vec<f64> = Vec::new();
    let mut result = analyze_pcm(&input);
    for _ in 0..3 {
        let started = perf_now();
        if slow_milliseconds > 0.0 {
            let until = perf_now() + slow_milliseconds;
            while perf_now() < until { /* controlled regression mode */ }
        }
        result = analyze_pcm(&input);
        if allocation_mode {
            retained.push(vec![0.0; samples.len()]);
            retained.push(vec![0.0; samples.len()]);
        }
        latency_measurements.push(perf_now() - started);
    }
    let output_bytes = match &result {
        Ok(analysis) => serde_json::to_value(analysis).map(|value| json::stringify(&value).len()).unwrap_or(0),
        Err(_) => 0,
    };
    let peak = peak_rss_bytes();
    drop(retained);
    println!(
        "{}",
        json::stringify(&json_value!({
            "peakRssBytes": peak,
            "peakHeapUsedBytes": 0,
            "peakExternalBytes": 0,
            "peakArrayBuffersBytes": 0,
            "latencyMeasurements": latency_measurements,
            "outputBytes": output_bytes,
        }))
    );
    0
}
