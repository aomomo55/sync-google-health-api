package com.syncgooglehealth.app

// テストで使う、サーバーが返すノートの失敗の文。サーバーの文言と同じものを写している
// (server/src/sync/note-sync.ts の NOTE_FAILURE_MESSAGE、server/src/routes/health.ts の SYNC_FAILURE_MESSAGE、
// server/src/notes/daily.ts の MemoMarkerMissingError)。サーバーの文を変えたら合わせる
object ServerMessages {
    const val NOTE_FAILURE =
        "Vault への書き込みに失敗しました。健康データは保存済みで、次の送信で送った日のノートは作り直されます。" +
            "続くときは、obsidian-sync-mcp が動いているかとサーバーのログを確かめてください"
    const val SYNC_FAILURE =
        "ノートの同期に失敗しました。健康データは保存済みで、次の送信で送った日のノートは作り直されます。" +
            "続くときは、obsidian-sync-mcp が動いているかとサーバーのログを確かめてください"
    const val MEMO_MARKER_MISSING =
        "既存のノートにメモ欄のマーカー（%% health:memo の行）が無いため、上書きしませんでした。" +
            "マーカーの行を戻すか、ノートを削除すると再生成されます"
}
