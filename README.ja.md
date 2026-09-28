# Kumi

[English](README.md) · [简体中文](README.zh-CN.md) · 日本語

猫の名前にちなんだ、音楽制作のためのパーソナルアシスタントです。
この POC はストリーミング対応のターミナル会話で、現在開いている
Ableton Live Set を調べ、文脈に沿った質問に答えます。編集、再生操作、
録音、音声の試聴・解析、記憶機能はまだ実装されていません。

## 開始

**Node.js 22、24、25** のいずれかが必要です（[nodejs.org](https://nodejs.org) の
LTS インストーラーで構いません）。リポジトリのルートで実行します。

```sh
npm run setup                          # すべてをインストール・ビルド（約 1 分）
npm run kumi -- login openai-codex     # ChatGPT プランでサインイン（ブラウザがない環境では --device）
npm run kumi                           # 開いている Live Set について話す
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

[![Node 22 | 24 | 25](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2025-339933)](apps/mcp-server/package.json)

`@ableton-mcp/mcp-server` は引き続き他の MCP クライアントから単独で使用できます。
独自のロックファイル、Node 対応方針、安全性の契約、CI を維持します。
Kumi は現在ブリッジの Live 読み取りツールを使用しています。編集・解析ツールは次の段階です。

[ブリッジ概要（英語）](apps/mcp-server/README.md) ·
[能力一覧](docs/ja/CAPABILITY_MATRIX.md) · [互換性](docs/ja/SUPPORT_MATRIX.md) ·
[運用](docs/ja/OPERATIONS.md) · [復旧](docs/ja/RECOVERY.md) · [配布](docs/ja/DELIVERY.md)

ホストされているリポジトリの改名は所有者が別途行います。
[MIT ライセンス](LICENSE.md)。Ableton AG との提携・承認を意味しません。
