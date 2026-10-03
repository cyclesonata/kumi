# 対応プラットフォーム

[English](../en/SUPPORT_MATRIX.md) · [简体中文](../zh-CN/SUPPORT_MATRIX.md) · 日本語

Kumi とそのブリッジが動作する環境、対応する Live のバージョン、どこで何をテストしたかをまとめます。それぞれの「テスト済み」の根拠は[実装状況](IMPLEMENTATION_STATUS.md)に記載しています。

## Kumi

| システム | バージョン | プロセッサ | 状況 |
| --- | --- | --- | --- |
| macOS | 13（Ventura）以降 | Apple silicon、Intel | Apple silicon 上の Live でテスト済み |
| Windows | 10 または 11 | x64、ARM64 | インストールと Live への接続をテスト済み。[Windows](#windows) を参照 |
| Linux | glibc のディストリビューション（Alpine などの musl 系は不可） | x64、ARM64 | Kumi のインストールと実行はできますが、Live は使えません。Linux 版の Live は存在しません |

インストーラーは Kumi 専用の Node を持ち込みます。Kumi のビルドとテストに使ったものとまったく同じ Node 24 のリリースなので、Node を自分でインストールする必要はありません。今後の Kumi が別の Node メジャーバージョンに移行した場合は、`kumi update` がインストーラーをもう一度実行するよう伝え、それで新しい Node が入ります。

## Ableton Live

| Live | 状況 |
| --- | --- |
| 12.4 以降 | すべての機能。Kumi の Live 拡張機能による、オフラインレンダリング、アレンジメントへの MIDI クリップの書き込み、範囲のクリア、**Ask Kumi about this** も含みます。macOS 上の Live 12.4.15 beta でテスト済み。 |
| 12.0〜12.3 | ブリッジはその Live の API にあるものを提供します。拡張機能は使えないので、上記の機能はありません。`kumi doctor` がそう伝えます。未テスト。 |
| 11 以前 | 非対応。 |

エディション：ブリッジは接続先の Live が提供するものを検出するので、エディションにないデバイスやコンテンツ（Standard と Intro は少なめです）は推測で扱われず、使えないままになります。Max for Live デバイスを作るには Max for Live（Suite、またはアドオンを追加した Standard）が必要です。オプションの Willington プロバイダーは、特定の一つの Live ビルドでのみ動作します。[Willington 連携](WILLINGTON_INTEGRATION.md)を参照してください。

## Windows

テスト済みの項目：CI 上の Windows PowerShell 5.1 での、インストーラー、`kumi update`、`kumi bridge`、`kumi uninstall`。そして Live 12.4.15 beta を入れた Windows 10 マシンでの、ユーザーフォルダーの外に移動した User Library への `kumi bridge`、Live での Remote Script の読み込み、Kumi の接続。CI の Windows ランナーは標準のフォルダー構成の管理者アカウントなので、一般のアカウントや移動したライブラリでしか起きない問題は確認できません。

Windows でまだ確認できていないこと：

- **Live が Extensions フォルダーを置く場所。** Kumi は `%APPDATA%\Ableton\Extensions` を使い、`KUMI_LIVE_EXTENSIONS_DIR` で上書きできます。これが確認できるまで、拡張機能の機能は Windows では未テストです。
- **Windows のターミナルでのフルスクリーンアプリ。** Windows Terminal を推奨します。[ターミナル](KUMI_TUI.md#ターミナル)を参照してください。
- **Kumi 1.6.0 以前からの `kumi update`** は、PATH 上で Git の `tar` が Windows 自身の `tar` より前にあると（Git Bash から起動した PowerShell など）、tar のエラーで失敗します。インストールのコマンドをもう一度実行するか、`kumi update` の前に `$env:Path = "$env:SystemRoot\System32;$env:Path"` を実行してください。

## ソースのチェックアウトとスタンドアロンのブリッジ向けの Node.js

| Node.js | 状況 |
| --- | --- |
| 22.x、24.x | 対応。Node 24 LTS を推奨 |
| 25.x | 非対応：2026年6月1日にサポートが終了しました |
| 26.x 以降、21.x 以前、プレリリース | テストされるまで非対応 |

すべてのパッケージのエンジン範囲は `>=22 <23 || >=24 <25` です。チェックアウトの `kumi` はそれ以外のメジャーバージョンでは動作を拒否します（例外は `kumi doctor` で、何が問題かを伝えます）。ブリッジのサーバーと `ableton-mcp-setup` も拒否し、`ableton-mcp-diagnostics` はそれを報告します。`ableton-mcp-lifecycle` と `ableton-mcp-migrate` は引き続き動作するので、古いインストールを調べたり削除したりできます。

## MCP プロトコル

ブリッジは stdio 上で、二つのプロトコル世代の MCP を話します。initialize ハンドシェイクを使う `2025-11-25` と、リクエストごとのメタデータと `server/discover` を使う `2026-07-28` です。新しい世代では、すべての結果は完全なもので、キャッシュヒントは TTL ゼロの private で、頼まれていないものをプッシュすることはありません。MRTR、Tasks、HTTP は提供しません。テストは両方の世代を対象にしていますが、特定の MCP クライアントやモデルを認定しているわけではありません。クライアントの接続方法は[ユーザーガイド](USER_GUIDE.md)で説明しています。

## アクセシビリティ

`KUMI_UI=plain`（または出力をパイプする）で、Kumi はスクリーンリーダーに向いた、一行ずつ表示するプレーンなインターフェースになります。[プレーンモード](KUMI_TUI.md#プレーンモード)を参照してください。ブリッジ自身の出力は決まった順序のプレーンテキストで、色だけで示す状態はなく、ポインターが必要な操作もありません。どちらも VoiceOver や Narrator ではテストしていません。Live、プラグインのウィンドウ、MCP クライアントの挙動は、それぞれの開発元が決めるものです。

## CI がカバーする範囲

CI は GitHub がホストする macOS 15、Ubuntu 24.04、Windows Server 2025 のランナー上で、Node 22 と 24 を使って実行されます。どのランナーにも Live はありません。すべてのジョブは[テスト](TESTING.md#ci)に記載しています。
