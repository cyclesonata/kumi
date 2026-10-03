# 操作示例

[English](../en/USER_JOURNEYS.md) · 简体中文 · [日本語](../ja/USER_JOURNEYS.md)

以下是用桥接工具完成的几段简短会话，按 MCP 客户端发送的形式列出。每一步给出一个工具及其参数。尖括号中的值来自之前的应答：引用来自 `live_discover`，`transactionId` 来自预览。`idempotencyKey` 由你自己选定，8 到 128 个字符，每次应用都要用新的。[用户指南](USER_GUIDE.md)介绍了每个工具以及[修改的工作方式](USER_GUIDE.md#修改的工作方式)。

## 查看工程

```text
live_status     {}
live_discover   {"kind": "track", "limit": 50}
live_discover   {"kind": "device", "parent": "<trackRef>"}
live_discover   {"kind": "parameter", "parent": "<deviceRef>"}
```

`live_status` 应显示 `"connected": true` 和 `"provenance": "real-live"`。每一页发现结果都返回 `items`，还有更多结果时会附带 `nextCursor`。引用的形式类似 `1232800184424618:track:4`。它们在 Live 的 epoch 改变之前一直有效；Live 重启或桥接重连时 epoch 就会改变。

## 修改速度，然后撤销

```text
live_tempo_preview  {"tempo": 124}
live_tempo_apply    {"transactionId": "<id>", "confirmation": "apply", "idempotencyKey": "tempo-124-a1"}
live_undo           {"transactionId": "<id>", "confirmation": "undo", "idempotencyKey": "tempo-undo-a1"}
```

预览返回 `priorTempo`、`proposedTempo`、`confirmation: "apply"` 和 `expiresAt`，不做任何修改。应用返回 `"state": "applied"` 以及 Live 现在的速度。用同一个键再次发送同一个应用请求不会改变任何东西，只会再次应答。`change_tempo_safely` 提示词和 `ableton://live-workflow` 资源描述的也是同样的步骤。

## 一次调用完成修改

```text
live_change  {"tool": "live_mixer_preview", "args": {"trackRef": "<trackRef>", "mute": true}, "idempotencyKey": "mute-bass-a1"}
```

应答是应用的结果，预览的结果在 `preview` 下。其中的 `transactionId` 和其他修改一样可以用于 `live_undo`。

## 加载乐器并调整音色

```text
live_browser_search              {"category": "instruments", "query": "drift"}
live_browser_load_preview        {"itemId": "<itemId>", "trackRef": "<trackRef>"}
live_browser_load_apply          {"transactionId": "<id>", "confirmation": "apply", "idempotencyKey": "load-drift-a1"}
live_discover                    {"kind": "device", "parent": "<trackRef>"}
live_discover                    {"kind": "parameter", "parent": "<deviceRef>"}
live_device_parameter_preview    {"deviceRef": "<deviceRef>", "values": [{"parameterRef": "<cutoffRef>", "value": 0.4}, {"parameterRef": "<resonanceRef>", "value": 0.2}]}
live_device_parameter_apply      {"transactionId": "<id>", "confirmation": "apply", "idempotencyKey": "drift-tone-a1"}
```

加载的设备会放在轨道现有设备之后；已经有乐器的轨道会拒绝第二个乐器。在一次预览中设置的多个参数构成一项修改，对应一次撤销。

## 写一个片段并试听

```text
live_discover              {"kind": "clip-slot", "parent": "<trackRef>"}
live_midi_clip_preview     {"trackRef": "<trackRef>", "sceneIndex": 0, "name": "Bass", "length": 4,
                            "notes": [{"pitch": 36, "start": 0, "duration": 0.5, "velocity": 100},
                                      {"pitch": 36, "start": 1.5, "duration": 0.5, "velocity": 90}]}
live_midi_clip_apply       {"transactionId": "<id>", "confirmation": "apply", "idempotencyKey": "bass-clip-a1"}
live_clip_launch_preview   {"slotRef": "<slotRef>", "outputSafety": {"safe": true, "provenance": "monitors checked at a low level"}}
live_clip_launch_apply     {"transactionId": "<id>", "confirmation": "<confirmation>", "idempotencyKey": "bass-play-a1"}
live_clip_launch_stop      {"transactionId": "<id>", "confirmation": "<stopConfirmation>", "idempotencyKey": "bass-stop-a1"}
```

槽位必须是空的。MIDI 片段预览在 30 秒后过期。触发预览会给出两个不可预测的令牌：`confirmation` 用于触发，`stopConfirmation` 用于停止。停止只会结束这一个片段；其他正在播放的内容会继续播放。

## 删除轨道，然后恢复

```text
live_track_delete_preview  {"trackRef": "<trackRef>"}
live_track_delete_apply    {"transactionId": "<id>", "confirmation": "apply", "idempotencyKey": "drop-fx-a1"}
live_song_undo             {"confirmation": "undo-in-live", "idempotencyKey": "drop-fx-undo-a1"}
```

预览会列出随轨道一起删除的内容（`alsoDeletes`：删除编组会连同其中的轨道）。`live_undo` 无法恢复已删除的轨道，但 Live 自己的撤销可以。`live_song_undo` 撤销的是 Live 最后做的那一步，所以要立即使用。

## 多项修改合为一次 Cmd-Z

```text
live_undo_step_begin  {"label": "Build the drop"}
...                   previews and applies
live_undo_step_end    {"stepId": "<stepId>"}
```

两者之间的所有修改在 Live 的撤销历史中合为一步。每项修改也各自保留自己的 `live_undo`。该步骤会在两分钟（或你给出的 `timeoutMs`）后自行关闭，连接断开时也会关闭。

## 引导式计划

`plan_user_journey` 为五个流程之一返回一份计划，不做任何修改。计划按顺序列出各个阶段及每个阶段要用的工具；如果当前 Live 缺少某个阶段所需的功能，就把该阶段标记为 `unavailable`，并给出替代方案。同样的计划也以提示词的形式提供，`ableton://journeys` 资源会列出它们及其可用性。

| 流程 | 提示词 | 计划涵盖 |
| --- | --- | --- |
| `create-beat-or-song` | `create_beat_or_song` | 根据你的描述搭建轨道、场景和一个 MIDI 片段；可选复制到编曲视图、修改音符和试听 |
| `sequence-advanced-drums` | `sequence_advanced_drums` | 在 Drum Rack 实际的打击垫音符上编写鼓型，带有时值、概率和力度变化 |
| `design-owned-sound` | `design_owned_sound` | 从 Browser 查找并加载设备，调整其参数，前后对比试听 |
| `compare-reference-mix` | `compare_reference_mix` | 将你的音频与你提供的参考音频比较，可选读取 Live 上下文，进行一次可撤销的调音台实验 |
| `diagnose-performance-setup` | `diagnose_performance_setup` | 读取播放、预备录音、监听、路由和调音台状态，然后修正路由和调音台；可选录音或实时控制 |

计划接受以下输入：

- `traits`（必填）：描述音乐的 1–1,000 个字符。
- `experienceLevel`（可选）：`beginner` 或 `advanced`。
- `bars`（可选）：1–16。

计划只使用你描述中的一般音乐特征：节奏、密度、能量、音色、空间感、动态、和声、编排。如果描述中点名了某位艺人、某首歌或某张唱片，或者要求精确复制，就不会从中采用任何内容。此时每个阶段都会被标记为 `blocked-by-intent`，计划会请你在不点名任何人的情况下描述想要的声音。针对相同的 Live 状态发出相同的请求，总会得到相同的计划。
