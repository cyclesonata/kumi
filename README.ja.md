# Kumi

[English](README.md) · [简体中文](README.zh-CN.md) · 日本語

猫の名前にちなんだ、音楽制作のためのパーソナルアシスタントです。
全画面のターミナルで、現在開いている Ableton Live Set について会話します。
Set についての質問に答え、Live のスクリプトで変更できることのほぼすべてを、頼んだとおりに
行います。対象はテンポ、拍子、スウィングとスケール、ミキサー、ルーティングとサイドチェイン、
トラック・リターン・シーン、クリップ・ノート・MIDI 変換、デバイス・ラックとその
パラメータ、そしてコンピューター上で見つけたサンプルです。変更はそれぞれ HISTORY に表示され、
個別に元に戻せます。頼めば再生や録音も行い、リサンプリングで音をオーディオに書き出します。
リファレンス曲やサンプル、自分の録音といった音声を聴いて、ミックスをリファレンスと比較できます。
作業の手順をレシピとして保存して再実行でき、あなたの作業を見て手順を覚えることもできます。
あなたが伝えたことを短いメモとして覚えます。保存済みの Set を覚えていて、次に開いたときは
会話を続け、Kumi が閉じていた間の変更を伝えます。

## 開始

**Node.js 22 または 24** が必要です（[nodejs.org](https://nodejs.org) の
Node 24 LTS インストーラーで構いません。Node 25 はサポート終了）。リポジトリのルートで実行します。

```sh
npm run setup                          # すべてをインストール・ビルド（約 1 分）
npm run kumi -- login openai-codex     # ChatGPT プランでサインイン（ブラウザがない環境では --device）
npm run kumi -- bridge                 # Live を閉じてから：ブリッジを Live に入れる（または更新する）
npm run kumi                           # 開いている Live Set について話す
npm run kumi -- doctor                 # うまくいかないとき：すべてを確認し、実行すべきことを表示
```

サインインするとデフォルトのモデルも設定されます。`npm run kumi -- model <provider>/<model>`
でいつでも変更できます。API キーも使えます。`openai/`・`anthropic/`・`opencode/` の
モデルは `OPENAI_API_KEY`・`ANTHROPIC_API_KEY`・`OPENCODE_API_KEY` を使用し、
`npm run kumi -- auth` で利用可能なものを確認できます。未保存の Set についての会話は、Kumi を閉じると終わります。

Live に接続するには、Live を閉じてから `npm run kumi -- bridge` を実行します。ブリッジの
Remote Script をインストール（または更新）し、Live を開くのを待ちます。初回は Live の
**Settings → Link, Tempo & MIDI** で `AbletonMcpBridge` をコントロールサーフェスとして選択します。
その後は Kumi が自動でブリッジを見つけます。それまでも Kumi は起動して会話でき、
Live に接続されていないことを表示します（[Live への接続（英語）](docs/en/KUMI_POC.md#connect-to-live)）。

- [Kumi の設定・コマンド・制限（英語）](docs/en/KUMI_POC.md)
- [ブリッジ設定](docs/ja/USER_GUIDE.md) · [安全性](docs/ja/LIVE_SAFETY.md)
- [実機 Live を含む検証結果（英語）](docs/evidence/kumi-poc.md)

ターミナルでは全画面で動作します（会話、Live ペイン、入力欄）。`/` でコマンド、
Esc で処理を中止、`/stop` で Live を停止、Ctrl-C で入力欄をクリアし、空なら終了します。
[変更履歴（英語）](CHANGELOG.md)。
テストは `npm run typecheck` と `npm test`。認証情報や Live は不要です。

## 動作確認と今後の予定

Kumi の動作確認は、今のところ Ableton Live 12.4.15b4 でのみ行っています。ほかのバージョンの
Live ではまだ試していません。次は Renoise と Reaper への対応を予定しています。

## Ableton MCP Beyond — 独立したブリッジ

[![Node 22 | 24](https://img.shields.io/badge/node-22%20%7C%2024-339933)](apps/mcp-server/package.json)

`@ableton-mcp/mcp-server` は引き続き他の MCP クライアントから単独で使用できます。
独自のロックファイル、Node 対応方針、安全性の契約、CI を維持します。
Kumi はブリッジの Live 読み取り・編集・トランスポート・録音ツール（検証済みの取り消し付き）を使用し、音声の解析は自前で行います。

[ブリッジ概要（英語）](apps/mcp-server/README.md) ·
[能力一覧](docs/ja/CAPABILITY_MATRIX.md) · [互換性](docs/ja/SUPPORT_MATRIX.md) ·
[運用](docs/ja/OPERATIONS.md) · [復旧](docs/ja/RECOVERY.md) · [配布](docs/ja/DELIVERY.md)

ホストされているリポジトリの改名は所有者が別途行います。
[MIT ライセンス](LICENSE.md)。Ableton AG との提携・承認を意味しません。
