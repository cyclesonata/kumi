# 作業例

[English](../en/USER_JOURNEYS.md) · [简体中文](../zh-CN/USER_JOURNEYS.md) · 日本語

ブリッジのツールを使った短いセッションを、MCP クライアントが送る形で示します。各ステップは、ツールとその引数です。山括弧で囲んだ値は、それより前の応答から得たものです：`live_discover` の ref や、プレビューの `transactionId` などです。`idempotencyKey` は 8–128 文字で自分で決め、適用ごとに新しいものを使ってください。すべてのツールと[変更のしくみ](USER_GUIDE.md#変更のしくみ)は、[ユーザーガイド](USER_GUIDE.md#変更のしくみ)で説明しています。

## Set を見る

```text
live_status     {}
live_discover   {"kind": "track", "limit": 50}
live_discover   {"kind": "device", "parent": "<trackRef>"}
live_discover   {"kind": "parameter", "parent": "<deviceRef>"}
```

`live_status` は `"connected": true` と `"provenance": "real-live"` を返すはずです。discovery の各ページは `items` を返し、続きがある間は `nextCursor` も返します。ref は `1232800184424618:track:4` のような形です。ref は Live のエポックが変わるまで有効です。エポックは、Live が再起動したときや、ブリッジが再接続したときに変わります。

## テンポを変えて、取り消す

```text
live_tempo_preview  {"tempo": 124}
live_tempo_apply    {"transactionId": "<id>", "confirmation": "apply", "idempotencyKey": "tempo-124-a1"}
live_undo           {"transactionId": "<id>", "confirmation": "undo", "idempotencyKey": "tempo-undo-a1"}
```

プレビューは `priorTempo`、`proposedTempo`、`confirmation: "apply"`、`expiresAt` を返し、何も変更しません。適用は `"state": "applied"` と、Live の現在のテンポを返します。同じキーで同じ適用をもう一度送っても何も変わらず、もう一度同じ答えが返ります。`change_tempo_safely` プロンプトと `ableton://live-workflow` リソースも、同じ手順を説明しています。

## 一度の呼び出しで変更する

```text
live_change  {"tool": "live_mixer_preview", "args": {"trackRef": "<trackRef>", "mute": true}, "idempotencyKey": "mute-bass-a1"}
```

答えは適用の結果で、プレビューの結果は `preview` の下にあります。その `transactionId` は、ほかの変更と同じく `live_undo` で使えます。

## インストゥルメントを読み込んで音を整える

```text
live_browser_search              {"category": "instruments", "query": "drift"}
live_browser_load_preview        {"itemId": "<itemId>", "trackRef": "<trackRef>"}
live_browser_load_apply          {"transactionId": "<id>", "confirmation": "apply", "idempotencyKey": "load-drift-a1"}
live_discover                    {"kind": "device", "parent": "<trackRef>"}
live_discover                    {"kind": "parameter", "parent": "<deviceRef>"}
live_device_parameter_preview    {"deviceRef": "<deviceRef>", "values": [{"parameterRef": "<cutoffRef>", "value": 0.4}, {"parameterRef": "<resonanceRef>", "value": 0.2}]}
live_device_parameter_apply      {"transactionId": "<id>", "confirmation": "apply", "idempotencyKey": "drift-tone-a1"}
```

読み込んだものは、トラックのデバイスの後ろに入ります。すでにインストゥルメントがあるトラックは、二つ目を拒否します。一つのプレビューで複数のパラメータを設定すると、一つの変更・一つの取り消しになります。

## クリップを書いて鳴らす

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

スロットは空である必要があります。MIDI クリップのプレビューは 30 秒で期限切れになります。起動のプレビューは、予測できないトークンを二つ返します：起動用の `confirmation` と、停止用の `stopConfirmation` です。停止で止まるのはそのクリップだけで、ほかに再生中のものは鳴り続けます。

## トラックを削除して、元に戻す

```text
live_track_delete_preview  {"trackRef": "<trackRef>"}
live_track_delete_apply    {"transactionId": "<id>", "confirmation": "apply", "idempotencyKey": "drop-fx-a1"}
live_song_undo             {"confirmation": "undo-in-live", "idempotencyKey": "drop-fx-undo-a1"}
```

プレビューは、トラックと一緒に消えるものを一覧にします（`alsoDeletes`。グループはその中のトラックも一緒に消えます）。削除したトラックは `live_undo` では戻せませんが、Live 自身の取り消しなら戻せます。`live_song_undo` は Live が最後に行ったことを取り消すので、すぐに使ってください。

## 複数の変更を Cmd-Z 一回にまとめる

```text
live_undo_step_begin  {"label": "Build the drop"}
...                   previews and applies
live_undo_step_end    {"stepId": "<stepId>"}
```

その間のすべての変更が、Live の取り消し履歴の一ステップになります。各変更は、それぞれの `live_undo` も持ち続けます。ステップは 2 分後（または指定した `timeoutMs` の後）と、接続が切れたときに自動で閉じます。

## ガイド付きプラン

`plan_user_journey` は五つのジャーニーのいずれかのプランを返し、何も変更しません。プランは順番に並んだステージを示し、各ステージには使うツールが付きます。この Live に必要なものがないステージは `unavailable` とし、代わりの方法を示します。同じプランはプロンプトとしても使え、`ableton://journeys` リソースはそれらを利用可否とともに一覧にします。

| ジャーニー | プロンプト | プランの内容 |
| --- | --- | --- |
| `create-beat-or-song` | `create_beat_or_song` | 説明から組み立てるトラック、シーン、MIDI クリップ。必要に応じて、アレンジメントへのコピー、ノートの修正、オーディション |
| `sequence-advanced-drums` | `sequence_advanced_drums` | Drum Rack の実際のパッドのノートに合わせたドラムパターン。タイミング、確率、ベロシティの変化付き |
| `design-owned-sound` | `design_owned_sound` | ブラウザからデバイスを探して読み込み、パラメータで音を作り、前後をオーディションで聴き比べる |
| `compare-reference-mix` | `compare_reference_mix` | 自分のオーディオと、自分で用意したリファレンスの比較。必要に応じて Live の状況を加え、元に戻せるミキサーの試みを一つ |
| `diagnose-performance-setup` | `diagnose_performance_setup` | 再生、アーム、モニタリング、ルーティング、ミキサーの状態を読み、ルーティングとミキサーを修正。必要に応じて録音やリアルタイムコントロール |

プランは次の入力を受け取ります。

- `traits`（必須）：音楽を説明する 1–1,000 文字。
- `experienceLevel`（省略可）：`beginner` または `advanced`。
- `bars`（省略可）：1–16。

プランは、説明のうち一般的な音楽的特徴だけを使います：リズム、密度、エネルギー、音色、空間、ダイナミクス、ハーモニー、アレンジ。説明がアーティスト、曲、レコードの名前を挙げていたり、そっくりそのままのコピーを求めていたりすると、そこからは何も取り入れません。その場合はすべてのステージが `blocked-by-intent` となり、プランは誰の名前も挙げずに音を説明するよう求めます。同じ Live の状態に対して同じリクエストをすると、常に同じプランが返ります。
