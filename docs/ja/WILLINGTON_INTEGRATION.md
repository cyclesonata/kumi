# オプションの Willington 連携

[English](../en/WILLINGTON_INTEGRATION.md) · [简体中文](../zh-CN/WILLINGTON_INTEGRATION.md) · 日本語

Willington は、別途インストールするネイティブプロバイダーのセットで、Live の Python API では届かない部分に手が届きます。Session クリップの Follow Action、ラックのマクロのマッピングと名前、ラックのチェーンのゾーンです。各プロバイダーは macOS ARM64 上の特定の Live ビルド 1 つのために作られており、実験的なものです。通常の Kumi とブリッジにはどれも必要ありません。なければ、これらのツールが表示されないだけです。

## 追加されるもの

| Kumi のツール | ブリッジのツール | 編集の種類 | プロバイダー |
| --- | --- | --- | --- |
| `set_clip_follow_actions` | `live_follow_actions_preview/apply` | Session クリップの Follow Action の 10 個のフィールドすべて | WillingtonBindings |
| `edit_rack_mapping` | `live_willington_device_preview/apply` | `macro-name`、`variation-name`、`macro-mapping` | WillingtonDeviceTools |
| `edit_rack_mapping` | `live_willington_device_preview/apply` | `selector-zone`、`key-zone`、`velocity-zone` | WillingtonRackZones |

ブリッジが提供するのは、プロバイダーが書き込み有効の状態でインストールされている編集の種類だけです。`live_willington_device_preview` は、それらの `kind` の値だけを並べます。どの編集でも、トランスポートが止まっている必要があります。

ラックの改善の中には、Willington が要らないものもあります。Live 自身のマクロのレイアウトでのラックの読み取り、インデックスによるバリエーションの呼び出しや削除、Live の Browser に Modulators カテゴリがないときの標準のモジュレーターデバイスへのフォールバックです。これらはどのブリッジでも動作します。

## インストールと有効化

1. 使いたいプロバイダーを、Live の Remote Scripts フォルダーの AbletonMcpBridge の隣にインストールします。`WillingtonBindings`（Follow Action）、`WillingtonDeviceTools`（マクロとバリエーション。`get_macro_mapping` と `get_selected_variation_name` を提供している必要があります）、`WillingtonRackZones`（ゾーン）です。どれも、作られた対象の Live ビルドそのもので動いていることを確認し、ほかのビルドにはインストールを拒否します。
2. Live でスタンドアロンの Willington コントロールサーフェスをすべてオフにし、Live を再起動します。ブリッジはプロバイダーをほかの持ち主と共有しません。
3. `Remote Scripts/AbletonMcpBridge` の中、ブリッジの `__init__.py` の隣に `willington.json` を作ります。通常のファイルで、オーナー専用、4 KiB 以下で、ちょうど次のキーを持つ必要があります。

   ```json
   {"version": 1, "followActions": true, "deviceTools": true, "rackZones": true, "enableWrites": false}
   ```

   | キー | 意味 |
   | --- | --- |
   | `version` | 常に `1` |
   | `followActions` | WillingtonBindings を読み込む |
   | `deviceTools` | WillingtonDeviceTools を読み込む |
   | `rackZones` | 省略可。WillingtonRackZones を読み込む |
   | `enableWrites` | 編集を許可する。`false` ではプロバイダーを読み込むが、編集は提供しない |

4. Follow Action を編集するには、WillingtonBindings のセルフテストに合格していることも必要です。そのフォルダーに、`"status": "passed"` と、`libwillington.dylib` の SHA-256 に等しい `library_sha256` を持つ `self-test.json` が必要です。これがないと Follow Action の編集はオフのままですが、ほかのプロバイダーは動作します。
5. Live を再起動します。設定の変更は、Live の起動時にだけ反映されます。

Kumi を更新しても `willington.json` は残ります。素のブリッジに戻すには、このファイルを削除してください。

ファイルにキーが足りないか未知のキーがある、ファイルが指定するプロバイダーのどれかが読み込みに失敗する、別の持ち主がすでにプロバイダーを保持している、スタンドアロンの Follow Action・デバイス・ゾーンのサーフェスがすでにインストールされている、のいずれかのときは、どのプロバイダーも使われず、ブリッジはそれらなしで動き続けます。どれにあたるかは Live のログ（Log.txt）に出ます。「Willington extensions initialized; writes enabled」、「Willington extensions unavailable: …; ordinary bridge remains active」、「Willington Follow Action writes unavailable: …」のいずれかです。

Remote Script が止まると、Follow Action の書き込みをオフにし、DeviceTools と RackZones をアンインストールします。Follow Action のバインディングはアンインストールできず、その Live プロセスに登録されたままになります。ブリッジが再び起動すると、書き込みをオフにした状態でそれを再利用します。

## Follow Action

`live_follow_actions_preview/apply` は、Session クリップ 1 つの 10 個のフィールドすべてを設定します。有効、リンク、アクション A と B、確率 A と B、ループ回数、時間、ジャンプ先 A と B です。

- アクションは数値です。0 none、1 stop、2 again、3 previous、4 next、5 first、6 last、7 any、8 other、9 jump。ジャンプ先は 1 から数えるシーン番号です。
- 2 つの確率の合計は 100 です。片方だけを指定すると、もう片方は残りに設定されます。
- リンクしたタイミングではループ回数を使い、リンクしないタイミングでは拍単位の `time` を使います。
- トランスポートが止まっていて、クリップが録音中でない必要があります。
- シーンの Follow Action や、Live 全体の Follow Action のスイッチは変更しません。起動時の Legato には、クリップ設定のツール（Kumi では `set_clip`）を使ってください。

プレビューは 10 個のフィールドすべてを記録します。書き込みが途中で失敗すると、それまでに書いたフィールドは元に戻ります。取り消しは記録したフィールドを復元し、そのあとクリップが変わっていれば拒否されます。

## マクロ、バリエーション、マッピング

`ref` でラックを指定した `live_willington_device_preview/apply`：

| 種類 | 引数 | 補足 |
| --- | --- | --- |
| `macro-name` | `macroIndex`（0–15）、`name` | マクロの名前を変える |
| `variation-name` | `name` | 選択中のバリエーションの名前を変える。名前の付いたバリエーションが選択されている必要があります |
| `macro-mapping` | `targetRef`、`mappingIndex`（0–15、または割り当てを外す `null`）、`minimum`、`maximum`、`mappingKind` | このラックの中のパラメータをマクロに割り当てる |

マッピングの種類：

- `continuous` と `enum`：`minimum` と `maximum` はパラメータ自身の単位で、その範囲内で指定します。範囲は反転していてもかまいません。`enum` の両端は整数です。
- `boolean`：0 から 127 までの整数のマクロのしきい値で、`minimum` ≤ `maximum`。

`targetRef` は最新のディスカバリーで得たもので、このラック、その中にネストされたデバイス、またはそのチェーンのミキサーの中になければなりません。トランザクションは、名前、あるいはマッピングとパラメータの値とマクロの値を、関係する同一性とあわせて記録します。Live はマッピングされたパラメータの値を 1 ティック遅れて設定するので、マッピングはその値ではなく、マッピングとマクロの値でフェンスされます。書き込みはすべて読み戻され、一致しなければ正確に元に戻されます。取り消しは記録した状態を復元し、そのあとラックが変わっていれば拒否されます。これはトランザクション自身の取り消しで、Live の取り消しではありません。

## ラックのチェーンのゾーン

`ref` でラックを、`targetRef` でその通常のチェーンの 1 つを指定した `live_willington_device_preview/apply`：

| ラック | ゾーン |
| --- | --- |
| Audio Effect Rack | `selector-zone` |
| Instrument Rack、MIDI Effect Rack | `selector-zone`、`key-zone`、`velocity-zone` |

Drum Rack とリターンチェーンは拒否されます。ゾーンには 4 つの整数の端点 `minimum`、`fadeMinimum`、`fadeMaximum`、`maximum` があり、0–127（ベロシティでは 1–127）の範囲で、この順序（`minimum` ≤ `fadeMinimum` ≤ `fadeMaximum` ≤ `maximum`）を保つ必要があります。省略した端点は今の値のままなので、範囲を動かすときは両方のフェードの端点も指定する必要があるかもしれません。

プレビューは 4 つの端点すべてを記録します。適用と取り消しは、ラックとチェーンの同一性と、ゾーンの状態全体でフェンスします。指定どおりに読み戻せない書き込みは、正確に元に戻されます。

## 証拠

| プロバイダー | 実行 | Live | ブリッジ | 対象 |
| --- | --- | --- | --- | --- |
| Follow Action | [kumi-clip-follow-actions-b5.json](../evidence/kumi-clip-follow-actions-b5.json)、2026-09-30 | 12.4.15b5、macOS arm64 | 1.0.53 | 保存したテスト Set での Kumi の変更と取り消し、トランスポート停止中 |
| Follow Action、マクロ、マッピング | [willington-kumi-chat.json](../evidence/willington-kumi-chat.json)、2026-09-30 | 12.4.15b4 ARM64 | 1.0.52 | 実際の Kumi のチャット：Follow Action、マクロ名の変更、マッピング、それぞれを取り消し |
| ラックのゾーン | [rack-zones-b5.json](../evidence/rack-zones-b5.json)、2026-10-01 | 12.4.15b5（2026-09-24 ビルド）、arm64 | 1.0.66 | 読み戻し、書き込み、取り消しとやり直し、Set の保存と再オープン、インストール済みのブリッジと Kumi の取り消し |

バリエーション名の変更と、反転した continuous と enum のマッピングは、ブリッジを直接使ってテストしました。どの実行も再生はカバーしていません。Follow Action のスケジューリング、ゾーンの鳴り方、再生中のセレクターの変更です。Follow Action とマクロの編集は、Set の保存と再オープンをまたいではテストしていません。ラックのゾーンは、12.4.15b4 でもほかのどのビルドでもサポートされていません。

ブリッジの自動テストは、残りを Live なしでカバーしています。プロバイダーがない場合、不正な設定、古い編集や競合する編集、部分的な書き込み、持ち主の扱いと再接続、応答の喪失です。

## 意図的に提供していないもの

Willington にはこれらのためのネイティブメソッドがありますが、安全に取り消せるようになるまで、Kumi は提供しません。

- **バリエーションの上書き**：バリエーションの名前だけでなく、保存されたマクロの値と有効マスクの全体を読み取り、復元する必要があります。
- **Drum Sampler のサンプルの直接置き換え**：今のサンプルの同一性とパス、そして置き換えで変わるものの復元が必要です。Browser を通じたプリセットやサンプルのロードは使えます。
- **モジュレーターのマッピング**：ネイティブの変更はあとから落ち着くため、Live のスレッドと歩調が合いません。まず、落ち着いた状態の確認、ソースと対象の正確な持ち主の確認、キャンセル、復元が必要です。

ネイティブメソッドがあるだけでは、取り消せる操作には足りません。ランタイムの記述子やプロトコルのエントリを追加するだけで、それを提供しないでください。
