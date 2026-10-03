# リリースと配布

[English](../en/DISTRIBUTION_POLICY.md) · [简体中文](../zh-CN/DISTRIBUTION_POLICY.md) · 日本語

Kumi とそのブリッジがどのように人の手に届くか、それによって何が証明され何が証明されないか、ブリッジのパッケージに何を含めてよいかをまとめます。リリースを作る手順は[開発者ガイド](DEVELOPER_GUIDE.md#リリース)にあります。

## 配布チャンネル

| 対象 | 場所 | 入手方法 |
| --- | --- | --- |
| Kumi | `user1303836/kumi` の GitHub Releases：`kumi.tar.gz`、`kumi-release.json`、`SHA256SUMS`。Installer ワークフローが各 `vX.Y.Z` タグに添付します | `install.sh` または `install.ps1`、その後は `kumi update` |
| ブリッジ（`@ableton-mcp/mcp-server`） | 各 Kumi バンドルの中に、`npm pack` の tarball と、その tarball をインストール済みの状態の両方で入っています | `kumi bridge`。ブリッジのライフサイクルを通じてインストールします（[ブリッジのインストール](DELIVERY.md)） |
| ブリッジ単体 | 独自のリリースはありません。`npm pack` でビルドするか、CI の実行が 90 日間保持する `exact-local-candidate` アーティファクトを取得します | ライフサイクル CLI（[ブリッジのインストール](DELIVERY.md#スタンドアロンのブリッジ)） |

インストーラーのスクリプトは `main` ブランチから読み込まれ、それがインストールするバンドルは最新の公開リリース（または `KUMI_VERSION` で指定したリリース）から取得されます。リリースはメンテナーが公開するまでは下書きで、公開されたリリースだけが「latest」になります。npm には何も公開しません。すべてのパッケージが `private: true` なので、`npm publish` は拒否されます。

## 完全性は確かめるが、作成者は証明しない

署名も公証もしておらず、ネイティブのインストーラー（`.pkg`、`.msi`）もありません。インストーラーは、バンドルを `kumi-release.json` 内の sha256 と、Node を nodejs.org の `SHASUMS256.txt` と照合します。`kumi update` も同じ方法でバンドルを確認し、`kumi bridge` はブリッジの tarball を、バンドルのビルド時に記録されたハッシュと照合します。ダウンロードと同じ場所から来たチェックサムは、バイト列が無傷で届いたことは証明しますが、誰が作ったかは証明しません。

ソフトウェアは [MIT ライセンス](../../LICENSE.md)です。このライセンスは Ableton の商標に関する権利を一切与えるものではなく、Kumi は Ableton と提携しておらず、Ableton の承認を受けたものでもありません。

## ブリッジのパッケージに含めてよいもの

- コンパイル済みのランタイムの JavaScript と型宣言（ソースマップやテストは含みません）
- Remote Script、その README、操作レジストリ、それらのハッシュマニフェスト
- Kumi の Live 拡張機能：そのマニフェスト、`package.json`、ビルドされた `extension.js` と、その sha256
- ブリッジのガイド（`README.md` と `release-docs/`）
- `release-manifest.json`、`package.json`、`LICENSE.md`

それ以外は含みません。スクリプト、テストのフィクスチャ、`node_modules`、認証情報、設定、ローカルの状態、ログ、キャプチャしたメディア、エビデンスは入りません。`npm run package:verify` は、自身の明示的なリストにないパスをすべて拒否し、正確なペイロードについては `release-manifest.json` が信頼できる情報源です。CI はブリッジを二回パックし（二回目は新しいクローンから、新しく `npm ci` を実行して）、バイト列が同一であることを求めます。

## リリースマニフェスト

`release-manifest.json`（スキーマ `ableton-mcp-release/v2`）は次のものを記録します：パッケージ名とバージョン、ソースのコミットとツリーがダーティだったかどうか、Node の範囲とメジャーバージョン、ビルドに使った Node、npm、TypeScript のバージョンとランナーイメージ、`package-lock.json` と CI ワークフローの SHA-256、ビルドレシピ、プロトコルのバージョンとレジストリハッシュ、各ペイロードファイルの役割と SHA-256、そして配布フィールドです。

配布フィールドは `channel: "local-npm-tarball"`、`published: false`、`signed: false`、`notarized: false` で、`package:verify` とライフサイクルはまさにこれらの値を要求します。ここでの「local」と「unpublished」は tarball そのものについての説明です。tarball は `npm pack` でビルドされ、ローカルのパスからハッシュを確認してインストールされ、レジストリには決して公開されません。ただし、GitHub Releases 上の Kumi バンドルに入って人の手に届きます。既存のインストールをアップグレードしたりロールバックしたりできるよう、ライフサイクルは古い `ableton-mcp-private-release/v1` マニフェストも引き続き受け付けます。

## マージゲート

`main` ブランチにはルールセットが一つあります：

- 変更はプルリクエストで入ります。承認のレビューは必要ありません。
- 必須チェックは、`main` に対して最新の状態にしたブランチでパスする必要があります：`Required CI`、`Kumi / Node 22`、`Kumi / Node 24`、`Kumi / Windows / Node 24`、`Kumi / macOS / Node 24`。
- `main` は削除もフォースプッシュもできません。
- リポジトリの管理者ロールは、プルリクエストについてこれらのルールをバイパスできます。

Installer ワークフローは必須チェックではありませんが、タグでは、その `publish` ジョブはバンドルが macOS、Linux、Windows でインストールできた後にだけ実行されます。すべてのジョブは[テスト](TESTING.md#ci)で説明しています。

## 未決のオーナー判断

- macOS と Windows での、Kumi のバンドルとインストーラーの**署名と公証**。
- **Extensions SDK の再配布。** Kumi の Live 拡張機能は、ローカルで用意したプレリリース版の Ableton Extensions SDK からビルドされます。SDK のライセンスがその再配布を制限しているため、リポジトリには決してコミットしません。ビルドされた `extension.js` は、拡張機能とそれが使う SDK のコードをバンドルしたもので、コミットされ、ブリッジのパッケージと Kumi のバンドルに入って配布されます。それが許されるかどうかはオーナーが決めることです。
- `main` のルールセットの**管理者バイパス**：残すか、取り除くか。
