package com.syncgooglehealth.app

import java.io.File
import java.util.Locale
import javax.xml.parsers.DocumentBuilderFactory

// 単体テスト用の Texts。Robolectric を使わずに、src/main/res/values/strings.xml をそのまま読んで文言を引く。
// リソース ID (R.string.*) は、R クラスのフィールドから名前を逆引きして strings.xml の項目に対応させる。
// 実機の getString と同じく、書式は %1$s / %1$d などの位置指定で埋める
object TestTexts : Texts {
    private val namesById: Map<Int, String> =
        R.string::class.java.fields.associate { it.getInt(null) to it.name }

    private val valuesByName: Map<String, String> by lazy {
        // Gradle のユニットテストは、モジュール (android/app) を作業ディレクトリにして動く
        val file = File("src/main/res/values/strings.xml")
        val nodes = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file).getElementsByTagName("string")
        (0 until nodes.length).associate { i ->
            val node = nodes.item(i)
            node.attributes.getNamedItem("name").nodeValue to unescape(node.textContent)
        }
    }

    override fun get(id: Int, vararg args: Any): String {
        val name = requireNotNull(namesById[id]) { "未知の文字列リソース: $id" }
        val raw = requireNotNull(valuesByName[name]) { "strings.xml に無い項目: $name" }
        return if (args.isEmpty()) raw else String.format(Locale.ROOT, raw, *args)
    }

    // Android のリソースの書き方を解く。"..." の中は空白をそのまま残し、外は空白の連続を 1 つにまとめて前後を削る。
    // 円記号 (\n, \', \", \\) は対応する文字にする
    private fun unescape(text: String): String {
        val out = StringBuilder()
        // 1 文字ずつ読む状態機械。引用の中か外かと、円記号の次の文字を読み飛ばす位置を持つので var にする
        var quoted = false
        var i = 0
        while (i < text.length) {
            val c = text[i]
            when {
                c == '\\' && i + 1 < text.length -> {
                    i++
                    out.append(if (text[i] == 'n') '\n' else text[i])
                }
                c == '"' -> quoted = !quoted
                !quoted && c.isWhitespace() -> if (out.isEmpty() || !out.last().isWhitespace()) out.append(' ')
                else -> out.append(c)
            }
            i++
        }
        return if (text.contains('"')) out.toString() else out.toString().trim()
    }
}
