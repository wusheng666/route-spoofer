package com.routespoofer.app

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * GitHub-release updater. The web layer checks a JSON manifest, then hands the
 * APK URL here: this plugin downloads it, verifies its SHA-256, package name and
 * signing certificate, and opens the system package installer via FileProvider.
 *
 * Deliberately independent of Google Play (no Play Core / Play Store APIs): the
 * app is distributed as a sideloaded APK, so updates must come from the release
 * host configured in the web layer.
 */
@CapacitorPlugin(name = "AppUpdater")
class AppUpdaterPlugin : Plugin() {

    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    @PluginMethod
    fun getInfo(call: PluginCall) {
        val info = currentPackageInfo()
        val ret = JSObject()
        ret.put("versionCode", versionCodeOf(info))
        ret.put("versionName", info.versionName ?: "")
        ret.put("canInstall", canInstallPackages())
        call.resolve(ret)
    }

    /** Deep-links to "Install unknown apps" for this package (Android 8+). */
    @PluginMethod
    fun openInstallSettings(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val intent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}")
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }
        call.resolve()
    }

    @PluginMethod
    fun downloadAndInstall(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) {
            call.reject("MISSING_URL")
            return
        }
        val expectedSha = call.getString("sha256")?.lowercase()
        val versionName = call.getString("versionName") ?: "update"
        if (!canInstallPackages()) {
            call.reject("INSTALL_PERMISSION")
            return
        }
        val target = File(context.cacheDir, "route-spoofer-$versionName.apk")
        executor.execute {
            try {
                download(url, target)
                if (!expectedSha.isNullOrEmpty() && sha256(target) != expectedSha) {
                    target.delete()
                    call.reject("CHECKSUM_MISMATCH")
                    return@execute
                }
                if (!isInstallable(target)) {
                    target.delete()
                    return@execute
                }
                launchInstaller(target)
                call.resolve()
            } catch (e: Exception) {
                target.delete()
                call.reject("DOWNLOAD_FAILED", e)
            }
        }
    }

    private fun download(url: String, target: File) {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.instanceFollowRedirects = true
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        conn.readTimeout = READ_TIMEOUT_MS
        conn.setRequestProperty("User-Agent", "RouteSpoofer-Updater")
        try {
            conn.connect()
            check(conn.responseCode in HTTP_OK_MIN..HTTP_OK_MAX) { "HTTP ${conn.responseCode}" }
            val total = conn.getHeaderField("Content-Length")?.toLongOrNull() ?: -1L
            conn.inputStream.use { input ->
                FileOutputStream(target).use { output ->
                    copyWithProgress(input, output, total)
                }
            }
        } finally {
            conn.disconnect()
        }
    }

    /** Streams [input] into [output], reporting whole percentages when [total] is known. */
    private fun copyWithProgress(input: InputStream, output: OutputStream, total: Long) {
        val buf = ByteArray(BUFFER_SIZE)
        var read = 0L
        var lastPct = -1
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            output.write(buf, 0, n)
            read += n
            if (total > 0) {
                val pct = ((read * PERCENT) / total).toInt()
                if (pct != lastPct) {
                    lastPct = pct
                    emitProgress(pct)
                }
            }
        }
    }

    private fun emitProgress(percent: Int) {
        val data = JSObject()
        data.put("percent", percent)
        main.post { notifyListeners("progress", data) }
    }

    /**
     * Rejects foreign APKs: same package name and same signing certificate as
     * the running app. A signature mismatch would fail at install time anyway;
     * catching it here yields a clear message instead of a generic installer error.
     */
    private fun isInstallable(apk: File): Boolean {
        @Suppress("DEPRECATION")
        val archive = context.packageManager.getPackageArchiveInfo(
            apk.absolutePath,
            PackageManager.GET_SIGNATURES
        ) ?: return false
        if (archive.packageName != context.packageName) return false
        @Suppress("DEPRECATION")
        val current = context.packageManager.getPackageInfo(
            context.packageName,
            PackageManager.GET_SIGNATURES
        )
        return signaturesOf(archive) == signaturesOf(current)
    }

    @Suppress("DEPRECATION")
    private fun signaturesOf(info: PackageInfo): Set<String> =
        info.signatures?.map { it.toCharsString() }?.toSet() ?: emptySet()

    private fun launchInstaller(apk: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    private fun canInstallPackages(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

    @Suppress("DEPRECATION")
    private fun currentPackageInfo(): PackageInfo =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
        } else {
            context.packageManager.getPackageInfo(context.packageName, 0)
        }

    @Suppress("DEPRECATION")
    private fun versionCodeOf(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(BUFFER_SIZE)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 20_000
        const val READ_TIMEOUT_MS = 30_000
        const val BUFFER_SIZE = 64 * 1024
        const val PERCENT = 100
        const val HTTP_OK_MIN = 200
        const val HTTP_OK_MAX = 299
    }
}
