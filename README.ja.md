# Kumi

[English](README.md) · [简体中文](README.zh-CN.md) · 日本語

猫の名前にちなんだ、音楽制作のためのパーソナルアシスタントです。
この POC は全画面のターミナル会話で、現在開いている Ableton Live Set
についての質問に答え、頼んだ変更（テンポ、ミキサー、名前、新しいトラックと
シーン、MIDI クリップ、デバイスの読み込み、デバイスのパラメータ、ロケーター、
トラックの色）を行います。変更はそれぞれ HISTORY に表示され、個別に元に戻せます。
保存済みの Set を覚えていて、次に開いたときに Kumi が閉じていた間の変更を伝えます。
再生操作、録音、音声の試聴・解析、会話の記憶はまだ実装されていません。

## 開始

**Node.js 22 または 24** が必要です（[nodejs.org](https://nodejs.org) の
Node 24 LTS インストーラーで構いません。Node 25 はサポート終了）。リポジトリのルートで実行します。

```sh
npm run setup                          # すべてをインストール・ビルド（約 1 分）
npm run kumi -- login openai-codex     # ChatGPT プランでサインイン（ブラウザがない環境では --device）
npm run kumi                           # 開いている Live Set について話す
npm run kumi -- doctor                 # うまくいかないとき：すべてを確認し、実行すべきことを表示
```

サインインするとデフォルトのモデルも設定されます。`npm run kumi -- model <provider>/<model>`
でいつでも変更できます。API キーも使えます。`openai/`・`anthropic/`・`opencode/` の
モデルは `OPENAI_API_KEY`・`ANTHROPIC_API_KEY`・`OPENCODE_API_KEY` を使用し、
`npm run kumi -- auth` で利用可能なものを確認できます。終了すると会話履歴は失われます。

ブリッジの Remote Script をインストールし、Live でコントロールサーフェスとして
選択すると、Kumi は自動でブリッジを見つけます。それまでも Kumi は起動して会話でき、
Live に接続されていないことを表示します。初回のブリッジのインストール:
[Live への接続（英語）](docs/en/KUMI_POC.md#connect-to-live)。

- [Kumi の設定・コマンド・制限（英語）](docs/en/KUMI_POC.md)
- [ブリッジ設定](docs/ja/USER_GUIDE.md) · [安全性](docs/ja/LIVE_SAFETY.md)
- [実機 Live を含む検証結果（英語）](docs/evidence/kumi-poc.md)

ターミナルでは全画面で動作します（会話、Live ペイン、入力欄）。`/` でコマンド、
Esc で処理を中止、Ctrl-C で入力欄をクリアし、空なら終了します。
テストは `npm run typecheck` と `npm test`。認証情報や Live は不要です。

## Ableton MCP Beyond — 独立したブリッジ

[![Node 22 | 24](https://img.shields.io/badge/node-22%20%7C%2024-339933)](apps/mcp-server/package.json)

`@ableton-mcp/mcp-server` は引き続き他の MCP クライアントから単独で使用できます。
独自のロックファイル、Node 対応方針、安全性の契約、CI を維持します。
Kumi はブリッジの Live 読み取りツールと編集ツール（検証済みの取り消し付き）を使用しています。解析ツールは次の段階です。

[ブリッジ概要（英語）](apps/mcp-server/README.md) ·
[能力一覧](docs/ja/CAPABILITY_MATRIX.md) · [互換性](docs/ja/SUPPORT_MATRIX.md) ·
[運用](docs/ja/OPERATIONS.md) · [復旧](docs/ja/RECOVERY.md) · [配布](docs/ja/DELIVERY.md)

ホストされているリポジトリの改名は所有者が別途行います。
[MIT ライセンス](LICENSE.md)。Ableton AG との提携・承認を意味しません。
