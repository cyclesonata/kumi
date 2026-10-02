<p align="center">
  <img src="docs/assets/kumi-logo.svg" alt="kumi" width="300">
</p>

<p align="center">
  <a href="https://github.com/user1303836/kumi/actions/workflows/kumi.yml"><img alt="CI" src="https://github.com/user1303836/kumi/actions/workflows/kumi.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/user1303836/kumi/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/user1303836/kumi?label=release"></a>
  <img alt="Ableton Live 12" src="https://img.shields.io/badge/Ableton%20Live-12-111111">
  <img alt="Node 22 | 24" src="https://img.shields.io/badge/node-22%20%7C%2024-339933">
  <a href="LICENSE.md"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · 日本語
</p>

**あなたの作業のしかたを覚える、Ableton Live のためのスタジオパートナー。** やりたいことを普段の言葉で伝えれば、Kumi があなたの Set で作業します。面倒な作業から、自分では調べる時間のないことまで。YouTube のチュートリアルから音を作り直したり、ミックスをリファレンスと比べたり、言葉で説明した Max for Live デバイスを作ったり、指し示したラックを作り直したりします。変更にはそれぞれ取り消しが付くので、知らないうちに何かが変わることはありません。気に入って残したテクニックは覚えておくので、使うほどあなたに合っていきます。

<p align="center">
  <img src="docs/assets/kumi-screenshot.png" alt="ビデオチュートリアルから Drift のベースを作り直す Kumi：手順ごとの会話、新しいトラックのデバイスチェーンを表示する FOCUS、変更ごとに取り消しの付いた HISTORY" width="760">
</p>

## できること

- **Set のほぼすべてを変更：** テンポ、スケール、グルーヴ。ミキサー、ルーティング、サイドチェイン。トラック、シーン、クリップ。ノートと MIDI 変換。デバイス、ラックとそのパラメータ。変更は一つずつ取り消せます。
- **聴く：** ミックス、サンプル、自分でバウンスした音のラウドネス、トーンバランス、ステレオ幅、テンポとキー。ミックスとリファレンスの違いも聴き分けます。
- **チュートリアルを見る：** YouTube やファイルのビデオを見て、その内容を新しいトラックに組み立てます。
- **再生・録音・リサンプリング**を、頼まれたときに行います。
- **Live を隅々まで操作：** 頼まれたものを削除し、MIDI をアレンジメントに直接書き込み、オフラインでレンダリングし、Live で右クリックしたもの（「Ask Kumi about this」）について答えます。プランはまとめて Cmd-Z 一回で戻せます。数百トラックの大きな Set でも速いままです。
- **Max for Live デバイスを作る：** 言葉で説明した MIDI エフェクト、オーディオエフェクト、インストゥルメントを作り、トラックに載せます。
- **調べる：** ウェブを検索し、ページ、PDF、マニュアル、GitHub のコードを読むので、読んだものに似たエフェクトも作れます。
- **いまいる場所を表示：** FOCUS は Live で触れたものを追い、デバイスツリー、ピアノロール、セッションやアレンジメントの帯として表示します。デバイスをクリックして指し示せます。「このサチュレーター、きつすぎる」のように。
- **覚える：** あなたと各 Set についてのメモ、残した音から学んだテクニック、再実行できるレシピ。保存したものはすべて表示され、クリック一つで忘れさせられます。
- **会話を保存：** Set ごとに会話を保存し、閉じていた間に変わったことも伝えます。
- **好きなモデルで：** ChatGPT でサインインするか、OpenAI・Anthropic・OpenCode の API キーを使います。

## はじめかた

必要なのは Ableton Live 12 Beta（macOS 13 以降、または Windows 10・11）だけです。Node を含め、ほかに必要なものは Kumi が用意します。

**macOS：** ターミナルを開いて貼り付けます。

```sh
curl -fsSL https://raw.githubusercontent.com/user1303836/kumi/main/install.sh | sh
```

**Windows：** PowerShell を開いて貼り付けます。

```powershell
irm https://raw.githubusercontent.com/user1303836/kumi/main/install.ps1 | iex
```

続けて、新しいターミナルウィンドウで：

```sh
kumi login      # ChatGPT でサインイン、または Anthropic・OpenAI・OpenCode のキーを使う
kumi bridge     # Live を閉じた状態で：Kumi を Live につなぐ（最初の一回だけ）
kumi            # Set の横で Kumi を開く
```

そのあと初めて Live を開いたら、Live の **Settings → Link, Tempo & MIDI** で **AbletonMcpBridge** をコントロールサーフェスとして選びます。その後は Kumi が自分で Live を見つけます。

うまくいかないときは、`kumi doctor` がすべてを確認し、実行すべきことを教えます。`kumi report` は起きたことを送れるファイル一つにまとめます。`kumi uninstall` で Kumi を削除します。

新しいバージョンが出ると、Kumi は起動時に知らせます。Kumi の中で `/update`、またはターミナルで `kumi update` を実行すると更新され、ブリッジも一緒に更新されます。`kumi update --check` は確認だけ、`kumi update --rollback` は一つ前に戻します。確認を止めるには、`~/.kumi/settings.json` に `"updateCheck": false` を加えます。

Kumi の中では `/` でコマンドを表示します。Esc で Kumi の作業を止め、`/stop` で Live を止めます。Kumi が作業中でも、Enter で追加の指示を送れます（今のステップの後に読まれます）。Tab は作業が終わった後に送るメッセージ、`/btw` は作業を止めずにちょっとした質問をします。

[ガイド（英語）](docs/en/KUMI_POC.md) · [コマンドと画面（英語）](docs/en/KUMI_TUI.md) · [変更履歴（英語）](CHANGELOG.md)

## 現状

Kumi 1.3 は macOS 上の Ableton Live 12.4（ベータ）で確認しています。Windows 対応は確認中です。次は Renoise と Reaper への対応を予定しています。

## 開発

このリポジトリのコピーで、Node.js 22 または 24 を使います。

```sh
npm run setup     # インストールとビルド
npm run kumi      # 実行（npm run kumi -- bridge、-- doctor など）
npm run typecheck
npm test          # Live もサインインも不要
node scripts/build-release.mjs   # インストーラーがダウンロードするバンドル（Node 24）
```

`apps/kumi` はターミナルアプリ、`packages/runtime` は Kumi のエージェントコア、プロバイダー、メモリー、音声解析、Live との連携を持ちます。Kumi はローカルのブリッジ（`apps/mcp-server` とその Remote Script）を通じて Live と通信します。このブリッジは他の MCP クライアントからも単独で使えます（[ブリッジのガイド（英語）](apps/mcp-server/README.md)）。

## ライセンス

[MIT](LICENSE.md)。Ableton Live は Ableton AG の商標です。Kumi は Ableton と提携しておらず、Ableton の承認を受けたものでもありません。
