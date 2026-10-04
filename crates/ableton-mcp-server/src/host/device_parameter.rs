//! Exact device/parameter hierarchy reads and transactions.
use super::reads::AUDITION_DEADLINE_MS;
use super::*;
use crate::transactions::batch;
use kumi_common::js::json as js_json;

pub(super) struct DeviceRow {
    pub track: Value,
    pub device: Value,
    pub owner_ref: String,
    pub owner_identity: String,
    pub siblings: Vec<Value>,
}
pub(super) struct ParameterTarget {
    pub device: Value,
    pub parameter: Value,
    pub track_ref: Value,
    pub authority: Value,
}
pub(super) struct ParameterState {
    pub parameter: Value,
    pub same: bool,
}
fn rows(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}
pub(super) fn fields(value: &Value, keys: &[&str]) -> Value {
    Value::Object(keys.iter().filter_map(|key| value.get(*key).map(|v| ((*key).into(), v.clone()))).collect())
}
pub(super) fn authority_fields(value: &Value, keys: &[&str]) -> Result<Value, LiveError> {
    if keys.iter().any(|key| value.get(*key).is_none()) {
        return Err(LiveError::error("mutation authority contains an unsupported value"));
    }
    Ok(fields(value, keys))
}
impl McpHost {
    pub(super) fn device_row(&self, snapshot: &LiveSnapshot, reference: &str) -> Result<DeviceRow, LiveError> {
        fn visit(values: &Value, owner_ref: &str, owner_identity: &str) -> Result<Option<(Value, String, String, Vec<Value>)>, LiveError> {
            let Some(values) = values.as_array() else { return Ok(None) };
            let siblings = values
                .iter()
                .map(|value| {
                    if !value.is_object() || !value["ref"].is_string() || !value["objectIdentity"].is_string() {
                        return Err(LiveError::error("device sibling identity is unavailable"));
                    }
                    Ok(fields(value, &["ref", "objectIdentity"]))
                })
                .collect::<Result<Vec<_>, _>>()?;
            // The reference is passed separately to keep recursion scoped to the selected tree.
            Ok(Some((json!(values), owner_ref.into(), owner_identity.into(), siblings)))
        }
        fn walk(
            values: &Value,
            owner_ref: &str,
            owner_identity: &str,
            reference: &str,
        ) -> Result<Option<(Value, String, String, Vec<Value>)>, LiveError> {
            let Some((values, owner_ref, owner_identity, siblings)) = visit(values, owner_ref, owner_identity)? else { return Ok(None) };
            for value in rows(&values) {
                if value["ref"] == reference {
                    return Ok(Some((value.clone(), owner_ref, owner_identity, siblings)));
                }
                for chain in rows(&value["chains"]).chain(rows(&value["drumPads"]).flat_map(|pad| rows(&pad["chains"]))) {
                    if let (Some(reference_), Some(identity)) = (chain["ref"].as_str(), chain["objectIdentity"].as_str()) {
                        if let Some(found) = walk(&chain["devices"], reference_, identity, reference)? {
                            return Ok(Some(found));
                        }
                    }
                }
            }
            Ok(None)
        }
        let snapshot = serde_json::to_value(snapshot).unwrap();
        for track in rows(&snapshot["tracks"]) {
            if let (Some(owner), Some(identity)) = (track["ref"].as_str(), track["objectIdentity"].as_str()) {
                if let Some((device, owner_ref, owner_identity, siblings)) = walk(&track["devices"], owner, identity, reference)? {
                    return Ok(DeviceRow { track: track.clone(), device, owner_ref, owner_identity, siblings });
                }
            }
        }
        Err(LiveError::error("device reference is not authoritative"))
    }
    pub(super) async fn discover_one_async(
        &self,
        context: Option<&LiveOperationContext>,
        kind: LiveDiscoveryKind,
        reference: &str,
        fields: Option<&[&str]>,
        parent: Option<&str>,
    ) -> Result<Option<Value>, LiveError> {
        let mut request = LiveDiscoveryRequest::of(kind);
        request.filter = Some(json!({"ref":reference}).as_object().unwrap().clone());
        request.limit = Some(1);
        request.fields = fields.map(|v| v.iter().map(|s| (*s).into()).collect());
        request.parent = parent.map(str::to_owned);
        let fallback = LiveOperationContext::with_deadline(self.deadline(AUDITION_DEADLINE_MS));
        let page = self.async_adapter().discover_async(&request, Some(context.unwrap_or(&fallback))).await?;
        Ok(page.items.into_iter().find(|item| item.get("ref").and_then(Value::as_str) == Some(reference)).map(Value::Object))
    }
    pub(super) async fn track_one_async(
        &self,
        context: Option<&LiveOperationContext>,
        reference: &str,
        fields: &[&str],
    ) -> Result<Option<Value>, LiveError> {
        for kind in [LiveDiscoveryKind::Track, LiveDiscoveryKind::ReturnTrack, LiveDiscoveryKind::MainTrack] {
            if let Some(found) = self.discover_one_async(context, kind, reference, Some(fields), None).await? {
                return Ok(Some(found));
            }
        }
        Ok(None)
    }
    pub(super) fn parameter_target(
        &self,
        snapshot: &LiveSnapshot,
        device: &str,
        parameter: &str,
    ) -> Result<(Value, Value, Value), LiveError> {
        let snapshot = serde_json::to_value(snapshot).unwrap();
        let target = batch::parameter_target(&snapshot, device, parameter)
            .map_err(|_| LiveError::error("device and parameter references are not authoritative children"))?;
        Ok((target.device.clone(), target.parameter.clone(), target.track["ref"].clone()))
    }
    pub(super) fn parameter_authority(&self, snapshot: &LiveSnapshot, reference: &str) -> Result<Value, LiveError> {
        let error = || LiveError::error("parameter lacks complete exact hierarchy authority");
        let authority = batch::parameter_authority(&serde_json::to_value(snapshot).unwrap(), reference).map_err(|_| error())?;
        if authority["ref"] != reference
            || ["parameterIdentity", "ownerRef", "ownerIdentity", "trackRef", "trackIdentity"]
                .iter()
                .any(|key| !is_non_empty_string(&authority[*key], 256))
            || !authority["siblings"].is_array()
        {
            return Err(error());
        }
        Ok(authority)
    }
    pub(super) async fn parameter_rows_async(
        &self,
        context: Option<&LiveOperationContext>,
        device: &str,
        parameters: &[String],
    ) -> Result<Vec<Value>, LiveError> {
        let listed = if parameters.len() > 4 {
            let mut request = LiveDiscoveryRequest::of(LiveDiscoveryKind::Parameter);
            request.parent = Some(device.into());
            request.limit = Some(1024);
            let fallback = LiveOperationContext::with_deadline(self.deadline(AUDITION_DEADLINE_MS));
            Some(self.views.discover_all(&request, Some(context.unwrap_or(&fallback)), None).await?)
        } else {
            None
        };
        let mut found = Vec::new();
        for reference in parameters {
            let row = if let Some(listed) = &listed {
                listed.iter().rev().find(|r| r.get("ref").and_then(Value::as_str) == Some(reference.as_str())).cloned().map(Value::Object)
            } else {
                self.discover_one_async(context, LiveDiscoveryKind::Parameter, reference, None, Some(device)).await?
            };
            let row = row.ok_or_else(|| LiveError::error("device and parameter references are not authoritative children"))?;
            if row.get("parentRef").is_some_and(|p| p != device) || !is_non_empty_string(&row["objectIdentity"], 256) {
                return Err(LiveError::error("device and parameter references are not authoritative children"));
            }
            found.push(row);
        }
        Ok(found)
    }
    pub(super) async fn parameter_targets_async(
        &self,
        context: Option<&LiveOperationContext>,
        device_ref: &str,
        parameters: &[String],
    ) -> Result<Vec<ParameterTarget>, LiveError> {
        let parameters = self.parameter_rows_async(context, device_ref, parameters).await?;
        let device = self
            .discover_one_async(
                context,
                LiveDiscoveryKind::Device,
                device_ref,
                Some(&["ref", "parentRef", "objectIdentity", "name", "kind", "enabled"]),
                None,
            )
            .await?;
        let parent = device.as_ref().and_then(|d| d["parentRef"].as_str());
        let track_ref = if let Some(parent) = parent.filter(|p| ref_kind(p) == Some("track")) {
            Some(parent.into())
        } else {
            track_index_of_ref(device_ref).map(|i| format!("{}:track:{i}", device_ref.split(':').next().unwrap_or("")))
        };
        let track = if let Some(reference) = track_ref {
            self.track_one_async(context, &reference, &["ref", "objectIdentity", "name", "kind"]).await?
        } else {
            None
        };
        let (Some(device), Some(track)) = (device, track) else {
            return Err(LiveError::error("device and parameter references are not authoritative children"));
        };
        parameters.into_iter().map(|parameter|{let authority=json!({"ref":parameter["ref"],"parameterIdentity":parameter["objectIdentity"],"ownerRef":device["ref"],"ownerIdentity":device["objectIdentity"],"trackRef":track["ref"],"trackIdentity":track["objectIdentity"]});if authority.as_object().unwrap().values().any(|v|!is_non_empty_string(v,256)){return Err(LiveError::error("parameter lacks complete exact hierarchy authority"));}Ok(ParameterTarget{device:device.clone(),parameter,track_ref:track["ref"].clone(),authority})}).collect()
    }
    pub(super) async fn parameter_state_async(
        &self,
        context: &LiveOperationContext,
        device: &str,
        items: &[Value],
        owner: bool,
    ) -> Result<Vec<ParameterState>, LiveError> {
        if items.iter().all(|i| i["authority"]["siblings"].as_array().is_none_or(Vec::is_empty)) {
            let references = items.iter().map(|i| i["ref"].as_str().unwrap_or("").into()).collect::<Vec<_>>();
            let parameters = self.parameter_rows_async(Some(context), device, &references).await?;
            let device_row = if owner {
                self.discover_one_async(Some(context), LiveDiscoveryKind::Device, device, Some(&["ref", "objectIdentity"]), None).await?
            } else {
                None
            };
            return Ok(parameters
                .into_iter()
                .enumerate()
                .map(|(i, parameter)| {
                    let authority = &items[i]["authority"];
                    let same = parameter["objectIdentity"] == authority["parameterIdentity"]
                        && authority["ownerRef"] == device
                        && (!owner || device_row.as_ref().is_some_and(|d| d["objectIdentity"] == authority["ownerIdentity"]));
                    ParameterState { parameter, same }
                })
                .collect());
        }
        let references = std::iter::once(json!(device)).chain(items.iter().map(|i| i["ref"].clone())).collect::<Vec<_>>();
        let snapshot = self.views.view_for(Some(context), &references, None, &[]).await?;
        items
            .iter()
            .map(|item| {
                let reference = item["ref"].as_str().unwrap_or("");
                let (_, parameter, _) = self.parameter_target(&snapshot, device, reference)?;
                let same = js_json::stringify(&self.parameter_authority(&snapshot, reference)?) == js_json::stringify(&item["authority"]);
                Ok(ParameterState { parameter, same })
            })
            .collect()
    }
}
