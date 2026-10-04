use ableton_mcp_server::live::{MixerState, RoutingState};
use serde_json::json;

#[test]
fn observed_mixer_and_routing_keep_property_order_nulls_and_updated_typed_values() {
    let mixer = json!({"sendRefs":[],"volumeRef":null,"sends":[],"volume":0.5,"pan":null,"cueVolume":1,"mute":false,"solo":false,"panRef":null,"cueRef":null,"trackActivatorRef":"p:active","trackActivator":true,"futureField":{"b":2,"a":1},"futureNull":null});
    let mut typed: MixerState = serde_json::from_value(mixer.clone()).unwrap();
    assert_eq!(kumi_common::js::json::stringify(&serde_json::to_value(&typed).unwrap()), kumi_common::js::json::stringify(&mixer));
    typed.volume = Some(0.75);
    let updated = serde_json::to_value(&typed).unwrap();
    assert_eq!(updated["volume"], 0.75);
    assert_eq!(updated.as_object().unwrap().keys().collect::<Vec<_>>(), mixer.as_object().unwrap().keys().collect::<Vec<_>>());
    typed.extra.remove("futureNull");
    assert!(serde_json::to_value(&typed).unwrap().get("futureNull").is_none());
    let route = json!({"outputType":"Main","inputType":null,"availableInputTypes":null,"future":true});
    let typed: RoutingState = serde_json::from_value(route.clone()).unwrap();
    assert_eq!(kumi_common::js::json::stringify(&serde_json::to_value(&typed).unwrap()), kumi_common::js::json::stringify(&route));
}
