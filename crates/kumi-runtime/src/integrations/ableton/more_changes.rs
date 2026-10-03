//! Meter-aware change descriptions. The remaining change catalog is ported separately.
use kumi_common::js::number::{parse, to_fixed, to_string};
use std::cell::Cell;
thread_local! {static BEATS_PER_BAR:Cell<f64>=const{Cell::new(4.0)};}
pub fn set_meter(numerator: f64, denominator: f64) {
    if numerator > 0.0 && denominator > 0.0 {
        BEATS_PER_BAR.set(numerator * 4.0 / denominator);
    }
}
fn trim(value: f64) -> String {
    to_string(parse(&to_fixed(value, 2)).unwrap_or(f64::NAN))
}
fn plural(count: f64, one: &str) -> String {
    format!("{} {one}{}", to_string(count), if count == 1.0 { "" } else { "s" })
}
pub fn bars(beats: f64) -> String {
    let per_bar = BEATS_PER_BAR.get();
    let bar = (beats / per_bar).floor() + 1.0;
    let beat = beats - (bar - 1.0) * per_bar;
    if beat < 0.001 {
        format!("bar {}", to_string(bar))
    } else {
        format!("bar {} beat {}", to_string(bar), trim(beat + 1.0))
    }
}
pub fn span(beats: f64) -> String {
    let count = beats / BEATS_PER_BAR.get();
    if count.is_finite() && count.fract() == 0.0 {
        plural(count, "bar")
    } else {
        plural(parse(&trim(beats)).unwrap_or(f64::NAN), "beat")
    }
}
pub const MORE_REFERENCE_FIELDS: &[&str] =
    &["targetRef", "targetTrackRef", "targetChainRef", "slotRef", "sceneRef", "takeLaneRef", "destinationTrackRef", "locatorRef"];
// TODO(port): MORE_CHANGES catalog, preparation, and summaries.
