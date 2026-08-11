# FANY Ticket Watch

FANYチケットの検索結果を芸人ごとに定期チェックし、新しい公演が追加されたら
LINE通知＋Googleカレンダーへの自動登録を行う仕組みです。

## 仕組み

1. GitHub Actionsが30分おき（cronは変更可）に起動
2. `config/comedians.json` に書いた芸人名それぞれで
   `https://ticket.fany.lol/search/event?keywords=...` を検索
3. 前回チェック時に見つかった公演一覧（`data/fany-state.json`、リポジトリにコミットして永続化）と比較
4. 新規公演があればLINEに通知＋Googleカレンダーに登録
5. 更新した状態ファイルをリポジトリに自動コミット

## セットアップ

### 1. リポジトリに配置

このディレクトリの中身をGitHubリポジトリにpushしてください
（既存のシフト管理アプリのリポジトリとは別の、専用の小さいリポジトリを作るのがおすすめです）。

### 2. 監視したい芸人を設定

`config/comedians.json` を編集:

```json
[
  "ダブルヒガシ",
  "バッテリィズ",
  "ヨネダ2000"
]
```

### 3. GitHub Secretsを設定

リポジトリの Settings → Secrets and variables → Actions で以下を登録:

| Secret名 | 内容 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | 既存のLINE Messaging APIチャネルのアクセストークン |
| `LINE_TO_ID` | 通知を送りたいユーザーID または グループID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Googleサービスアカウントの鍵JSON（下記参照） |
| `GOOGLE_CALENDAR_ID` | 登録先カレンダーのID（省略時は自分のメインカレンダー） |

Googleカレンダー連携が不要ならLINEの2つだけでも動きます（Calendar系のSecretsが無ければ自動でスキップされます）。

### 4. Googleサービスアカウントの準備（カレンダー連携する場合）

1. Google Cloud Consoleで新規プロジェクト（または既存のFirebaseプロジェクトを流用）
2. Google Calendar APIを有効化
3. サービスアカウントを作成し、JSON鍵をダウンロード
4. そのJSONの中身をそのまま `GOOGLE_SERVICE_ACCOUNT_JSON` に登録
5. Googleカレンダーの「設定と共有」から、登録したいカレンダーを
   サービスアカウントのメールアドレス（`xxx@xxx.iam.gserviceaccount.com`）に
   「予定の変更権限」で共有
6. そのカレンダーのIDを `GOOGLE_CALENDAR_ID` に設定

### 5. 動作確認

Actionsタブから `FANY Ticket Watch` を選び「Run workflow」で手動実行できます。
初回実行時は既存の公演が全部「新規」扱いになって大量通知が飛ぶので、
一度 `data/fany-state.json` を手動実行で埋めてから通知を有効化する運用がおすすめです
（もしくは初回だけLINE_TO_IDを外して実行→state更新だけ行う）。

## 注意点

FANYチケットのページ構造が変わるとスクレイピング部分（`scripts/check-fany.js` の
`fetchEventsFor` / `parseHeading`）の調整が必要になることがあります。
実行時のログやエラー内容を見ながら微調整してください。
