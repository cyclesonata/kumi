//! Shared signed-wire primitives. Each caller applies its source channel's limits.
use crate::live::LiveError;
use crate::registry::{canonical_json, CanonicalError, CanonicalLimits, WIRE_CANONICAL_LIMITS};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde_json::Value;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
pub(super) const MAX_FRAME_BYTES: usize = 256 * 1_048_576;
pub(super) fn safe_integer(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| kumi_common::js::number::is_safe_integer(*n))
}
pub(super) fn canonical(value: &Value, extension: bool) -> Result<String, LiveError> {
    let extension_limits =
        CanonicalLimits { max_depth: 256, max_string_length: usize::MAX, max_array_length: usize::MAX, max_object_properties: usize::MAX };
    canonical_json(value, if extension { &extension_limits } else { &WIRE_CANONICAL_LIMITS }).map_err(|error| {
        LiveError::error(match error {
            CanonicalError::TooDeep => "wire payload is too deeply nested",
            CanonicalError::StringTooLarge => "wire string is too large",
            CanonicalError::ArrayTooLarge => "wire array is too large",
            CanonicalError::ObjectTooLarge => "wire object is too large",
        })
    })
}
pub(super) fn mac(secret: &str, value: &Value, extension: bool) -> Result<String, LiveError> {
    let encoded = canonical(value, extension)?;
    if !extension && encoded.len() > MAX_FRAME_BYTES {
        return Err(LiveError::error("wire payload is too large"));
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(encoded.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}
pub(super) fn signed(secret: &str, mut value: Value, extension: bool) -> Result<Value, LiveError> {
    value["mac"] = mac(secret, &value, extension)?.into();
    Ok(value)
}
pub(super) fn verify(secret: &str, value: &Value, extension: bool) -> Result<bool, LiveError> {
    let mut unsigned = value.clone();
    let Some(row) = unsigned.as_object_mut() else {
        return Ok(false);
    };
    let Some(Value::String(received)) = row.remove("mac") else {
        return Ok(false);
    };
    Ok(mac(secret, &unsigned, extension)?.as_bytes().ct_eq(received.as_bytes()).into())
}
pub(super) fn random_id() -> String {
    let mut bytes = [0; 18];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
pub(super) fn digest(value: &Value) -> Result<String, LiveError> {
    Ok(hex::encode(Sha256::digest(canonical(value, false)?.as_bytes())))
}
