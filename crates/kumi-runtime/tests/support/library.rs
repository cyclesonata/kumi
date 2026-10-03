//! Synthesized fixtures from `packages/runtime/test/fixtures/library.ts`.
#![allow(dead_code)]
use kumi_common::js::number::round;
use std::f64::consts::PI;
pub const RATE: f64 = 44100.;
fn noise(seed: u32) -> impl FnMut() -> f64 {
    let mut state = seed;
    move || {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        state as f64 / 2147483648. - 1.
    }
}
pub fn kick(hz: f64, seconds: f64) -> Vec<f32> {
    let mut phase = 0.;
    (0..round(RATE * seconds) as usize)
        .map(|index| {
            let t = index as f64 / RATE;
            let pitch = hz * (1. + (-t / 0.02).exp());
            phase += 2. * PI * pitch / RATE;
            (0.9 * phase.sin() * (-t / 0.12).exp()) as f32
        })
        .collect()
}
pub fn hat(seconds: f64, seed: u32) -> Vec<f32> {
    let mut random = noise(seed);
    let mut previous = 0.;
    (0..round(RATE * seconds) as usize)
        .map(|index| {
            let value = random();
            let sample = (0.6 * (value - previous) * (-(index as f64) / RATE / 0.03).exp()) as f32;
            previous = value;
            sample
        })
        .collect()
}
pub fn snare(seconds: f64) -> Vec<f32> {
    let mut random = noise(11);
    (0..round(RATE * seconds) as usize)
        .map(|index| {
            let t = index as f64 / RATE;
            ((0.4 * (2. * PI * 190. * t).sin() + 0.5 * random()) * (-t / 0.06).exp()) as f32
        })
        .collect()
}
pub fn beat(bpm: f64, bars: usize) -> Vec<f32> {
    let beat_frames = round(RATE * 60. / bpm) as usize;
    let mut out = vec![0_f32; beat_frames * 4 * bars];
    let one = kick(55., 0.3);
    let tick = hat(0.08, 3);
    for at in 0..bars * 4 {
        let start = at * beat_frames;
        let length = one.len().min(out.len() - start);
        out[start..start + length].copy_from_slice(&one[..length]);
        let off = start + round(beat_frames as f64 / 2.) as usize;
        for (index, value) in tick.iter().enumerate() {
            if off + index >= out.len() {
                break;
            }
            out[off + index] = ((out[off + index] as f64) + (*value as f64)) as f32;
        }
    }
    out
}
pub fn pad(frequencies: &[f64], seconds: f64) -> Vec<f32> {
    (0..round(RATE * seconds) as usize)
        .map(|index| {
            let t = index as f64 / RATE;
            let sum: f64 = frequencies.iter().map(|hz| (2. * PI * hz * t).sin()).sum();
            (0.25 * sum / frequencies.len() as f64 * (t / 0.4).min(1.)) as f32
        })
        .collect()
}
pub fn wav(channels: &[Vec<f32>], rate: u32) -> Vec<u8> {
    let frames = channels[0].len();
    let count = channels.len();
    let length = frames * count * 2;
    let mut out = vec![];
    out.extend(b"RIFF");
    out.extend(((36 + length) as u32).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16_u32.to_le_bytes());
    out.extend(1_u16.to_le_bytes());
    out.extend((count as u16).to_le_bytes());
    out.extend(rate.to_le_bytes());
    out.extend((rate * count as u32 * 2).to_le_bytes());
    out.extend((count as u16 * 2).to_le_bytes());
    out.extend(16_u16.to_le_bytes());
    out.extend(b"data");
    out.extend((length as u32).to_le_bytes());
    for frame in 0..frames {
        for channel in channels {
            out.extend((round(channel[frame] as f64 * 32767.).clamp(-32768., 32767.) as i16).to_le_bytes());
        }
    }
    out
}
