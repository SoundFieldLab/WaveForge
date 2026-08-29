package com.waveforge.android

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * 应用内更新器（TV 无 Google Play，走"下载 APK + 系统安装器"）。
 *
 * 流程：启动时后台拉取更新清单 update.json（Gitee 主源、GitHub 备源，均免鉴权）
 *  → 比较 androidVersionCode → 有新版弹窗 → 下载 APK → sha256 校验 → 调系统安装器安装。
 *
 * 清单由 scripts/publish-release.mjs 每次发版生成并提交到仓库根目录，双源同步。
 */
object UpdateChecker {

    private const val TAG = "WaveForgeUpdater"

    /**
     * 安装前的钩子：由 MainActivity 设置，把"更新已生效"标记写入 Web 端 localStorage，
     * 应用更新后首次启动时前端 UpdatePrompt 据此显示「版本更新成功」弹窗。
     */
    var beforeInstallHook: ((versionName: String, notes: String) -> Unit)? = null

    // 版本无关的固定地址（发布脚本维护仓库根目录的 update.json）。
    // 网络现实：国内无法裸连 GitHub → Gitee 主源、ghproxy 加速的 GitHub 备源、GitHub 直连兜底。
    private val MANIFEST_URLS = listOf(
        "https://gitee.com/kirito666233/wave-forge/raw/master/update.json",
        "https://ghproxy.net/https://raw.githubusercontent.com/YoshinoRinn/WaveForge/master/update.json",
        "https://raw.githubusercontent.com/YoshinoRinn/WaveForge/master/update.json",
    )

    private const val PREF = "waveforge-update"
    private const val KEY_LAST_NOTIFIED = "last_notified_version"
    private const val KEY_ENABLED = "check_enabled"
    private const val DOWNLOAD_TIMEOUT_MS = 15_000

    fun isCheckEnabled(context: Context): Boolean =
        context.getSharedPreferences(PREF, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, true)

    fun setCheckEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_ENABLED, enabled).apply()
    }

    /** 入口：后台线程检查，有新版则弹窗（UI 线程）。
     *  @param force 手动触发（设置页按钮）：忽略"每版本只提示一次"限制，每次都检查。 */
    fun check(context: Context, force: Boolean = false) {
        Thread {
            try {
                val manifest = fetchManifest() ?: return@Thread
                val remoteVersionName = manifest.optString("version", "")
                val remoteVersionCode = manifest.optInt("androidVersionCode", 0)
                if (remoteVersionCode <= 0) return@Thread

                val currentCode = currentVersionCode(context)
                if (remoteVersionCode <= currentCode) return@Thread

                val prefs = context.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                if (!force && prefs.getString(KEY_LAST_NOTIFIED, null) == remoteVersionName) return@Thread

                val notes = manifest.optString("notes", "")
                val codename = manifest.optString("codename", "")
                val artifacts = manifest.optJSONObject("artifacts")?.optJSONObject("android-arm64")
                val apkUrl = artifacts
                    ?.optJSONArray("urls")
                    ?.takeIf { it.length() > 0 }
                    ?.getString(0)
                    ?: return@Thread
                val expectedSha = artifacts.optString("sha256", "")

                // 手动触发时不记录，用户每次点"检查更新"都应能看到结果
                if (!force) prefs.edit().putString(KEY_LAST_NOTIFIED, remoteVersionName).apply()

                android.os.Handler(Looper.getMainLooper()).post {
                    showUpdateDialog(context, remoteVersionName, codename, notes, apkUrl, expectedSha)
                }
            } catch (t: Throwable) {
                Log.d(TAG, "检查更新失败: ${t.message}")
            }
        }.start()
    }

    @Suppress("DEPRECATION")
    private fun currentVersionCode(context: Context): Int {
        val pi = context.packageManager.getPackageInfo(context.packageName, 0)
        return if (android.os.Build.VERSION.SDK_INT >= 28) {
            pi.longVersionCode.toInt()
        } else {
            pi.versionCode
        }
    }

    private fun fetchManifest(): JSONObject? {
        for (url in MANIFEST_URLS) {
            try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.connectTimeout = DOWNLOAD_TIMEOUT_MS
                conn.readTimeout = DOWNLOAD_TIMEOUT_MS
                conn.requestMethod = "GET"
                if (conn.responseCode in 200..299) {
                    val body = conn.inputStream.bufferedReader().use { it.readText() }
                    conn.disconnect()
                    return JSONObject(body)
                }
                conn.disconnect()
            } catch (t: Throwable) {
                Log.d(TAG, "源不可用 ${url}: ${t.message}")
            }
        }
        return null
    }

    private fun showUpdateDialog(
        context: Context,
        versionName: String,
        codename: String,
        notes: String,
        apkUrl: String,
        expectedSha: String,
    ) {
        val builder = AlertDialog.Builder(context)
        builder.setTitle(
            if (codename.isBlank()) "发现新版本 v$versionName"
            else "发现新版本 v$versionName「$codename」"
        )
        builder.setMessage(if (notes.isBlank()) "是否下载并安装更新？" else "$notes\n\n是否下载并安装更新？")
        builder.setCancelable(true)
        builder.setNegativeButton("稍后", null)
        builder.setPositiveButton("更新") { _, _ -> downloadAndInstall(context, apkUrl, expectedSha, versionName, notes) }
        builder.show()
    }

    private fun downloadAndInstall(context: Context, apkUrl: String, expectedSha: String, versionName: String, notes: String) {
        val dialog = AlertDialog.Builder(context)
            .setTitle("正在下载更新")
            .setMessage("请稍候…")
            .setCancelable(false)
            .create()
        dialog.show()

        Thread {
            try {
                val file = downloadApk(context, apkUrl) ?: return@Thread
                if (expectedSha.isNotBlank() && !sha256(file).equals(expectedSha, ignoreCase = true)) {
                    throw IllegalStateException("下载文件校验失败")
                }
                android.os.Handler(Looper.getMainLooper()).post {
                    dialog.dismiss()
                    // 安装前写入"更新已生效"标记：更新后首次启动前端显示成功弹窗
                    beforeInstallHook?.invoke(versionName, notes)
                    installApk(context, file)
                }
            } catch (t: Throwable) {
                Log.e(TAG, "下载失败: ${t.message}")
                Handler(Looper.getMainLooper()).post {
                    dialog.dismiss()
                    AlertDialog.Builder(context)
                        .setTitle("下载更新失败")
                        .setMessage(t.message ?: "请稍后重试")
                        .setPositiveButton("确定", null)
                        .show()
                }
            }
        }.start()
    }

    private fun downloadApk(context: Context, apkUrl: String): File? {
        val dest = File(context.cacheDir, "waveforge-update.apk")
        val conn = URL(apkUrl).openConnection() as HttpURLConnection
        conn.connectTimeout = DOWNLOAD_TIMEOUT_MS
        conn.readTimeout = DOWNLOAD_TIMEOUT_MS
        if (conn.responseCode !in 200..299) {
            conn.disconnect()
            throw IllegalStateException("HTTP ${conn.responseCode}")
        }
        conn.inputStream.use { input ->
            dest.outputStream().use { output -> input.copyTo(output) }
        }
        conn.disconnect()
        return dest
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun installApk(context: Context, apkFile: File) {
        val uri: Uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            apkFile
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            context.startActivity(intent)
        } catch (t: Throwable) {
            Log.e(TAG, "无法打开安装器: ${t.message}")
        }
    }
}
