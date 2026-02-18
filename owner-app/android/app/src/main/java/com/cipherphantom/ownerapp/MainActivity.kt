package com.cipherphantom.ownerapp

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.net.Uri
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var loading: ProgressBar
    private lateinit var errorBox: TextView
    private lateinit var retryBtn: Button
    private val prefsName = "owner_app_prefs"
    private val uiHandler = Handler(Looper.getMainLooper())
    private var bootTimeoutRunnable: Runnable? = null
    private val bootTimeoutMs = 15000L
    @Volatile private var recoveryAttempts = 0
    private val maxRecoveryAttempts = 3

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        loading = findViewById(R.id.loading)
        errorBox = findViewById(R.id.errorBox)
        retryBtn = findViewById(R.id.retryBtn)

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                clearBootTimeout()
                recoveryAttempts = 0
                loading.visibility = View.GONE
                if (errorBox.visibility != View.VISIBLE) {
                    webView.visibility = View.VISIBLE
                }
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    showError(error?.description?.toString() ?: getString(R.string.err_unknown))
                }
            }

            override fun onReceivedHttpError(
                view: WebView?,
                request: WebResourceRequest?,
                errorResponse: WebResourceResponse?
            ) {
                if (request?.isForMainFrame == true) {
                    val status = errorResponse?.statusCode ?: -1
                    if (status == 530 && recoveryAttempts < maxRecoveryAttempts) {
                        recoveryAttempts += 1
                        val delay = 1200L * recoveryAttempts
                        uiHandler.postDelayed({ bootstrapAndLoad() }, delay)
                        return
                    }
                    showError("HTTP ${if (status > 0) status else "-"}")
                }
            }
        }
        webView.webChromeClient = WebChromeClient()
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = false
            displayZoomControls = false
        }

        retryBtn.setOnClickListener {
            bootstrapAndLoad()
        }

        bootstrapAndLoad()
    }

    private fun normalizeBaseUrl(raw: String): String {
        val url = raw.trim().removeSuffix("/")
        return if (url.isBlank()) "" else url
    }

    private fun candidateBaseUrls(): List<String> {
        val configured = configuredBaseUrls()
        val lanCandidates = buildLanFallbackCandidates(configured)
        return (configured + lanCandidates).distinct()
    }

    private fun isBlockedLocalHost(baseUrl: String): Boolean {
        return try {
            val host = (URI(baseUrl).host ?: "").lowercase()
            host == "127.0.0.1" || host == "localhost" || host == "0.0.0.0"
        } catch (_: Exception) {
            false
        }
    }

    private fun configuredBaseUrls(): List<String> {
        val prefs = getSharedPreferences(prefsName, MODE_PRIVATE)
        val last = normalizeBaseUrl(prefs.getString("last_working_url", "") ?: "")
        val primary = normalizeBaseUrl(BuildConfig.OWNER_APP_URL)
        val fallback = normalizeBaseUrl(BuildConfig.OWNER_APP_FALLBACK_URL)
        return listOf(last, primary, fallback)
            .filter { it.isNotBlank() }
            .filterNot { isBlockedLocalHost(it) }
            .distinct()
    }

    private fun parseHost(baseUrl: String): String? {
        return try {
            val uri = URI(baseUrl)
            uri.host
        } catch (_: Exception) {
            null
        }
    }

    private fun parsePort(baseUrl: String): Int {
        return try {
            val uri = URI(baseUrl)
            if (uri.port > 0) uri.port else 8787
        } catch (_: Exception) {
            8787
        }
    }

    private fun buildLanFallbackCandidates(configured: List<String>): List<String> {
        val hosts = configured.mapNotNull { parseHost(it) }
        val ports = configured.map { parsePort(it) }.ifEmpty { listOf(8787) }
        val out = mutableListOf<String>()

        // 1) Reuse configured subnet if host is private IPv4
        hosts.forEach { host ->
            val parts = host.split(".")
            if (parts.size == 4 && parts.all { p -> p.toIntOrNull() != null }) {
                val a = parts[0].toInt()
                val b = parts[1].toInt()
                val isPrivate = a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168)
                if (isPrivate) {
                    val prefix = "${parts[0]}.${parts[1]}.${parts[2]}."
                    listOf(2, 10, 20, 50, 100, 101, 200, 221).forEach { last ->
                        ports.forEach { port ->
                            out.add("http://${prefix}${last}:$port")
                        }
                    }
                }
            }
        }

        // 2) Common hotspot/private ranges (free robust fallback without stable domain)
        val common = listOf(
            "192.168.43.", // Android hotspot default
            "192.168.137.", // Windows ICS
            "172.20.10.", // iPhone hotspot
            "10.42.0.",
            "10.0.0.",
            "10.244.65.",
            "10.17.86."
        )
        common.forEach { prefix ->
            listOf(2, 10, 20, 50, 100, 101, 200, 221).forEach { last ->
                ports.forEach { port ->
                    out.add("http://${prefix}${last}:$port")
                }
            }
        }

        // keep fallback scan bounded so startup does not appear stuck
        return out.distinct().take(24)
    }

    private fun httpGet(url: String, timeoutMs: Int = 2000): Pair<Int, String> {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            requestMethod = "GET"
            setRequestProperty("Accept", "application/json")
        }
        return try {
            val code = conn.responseCode
            val stream = if (code in 200..399) conn.inputStream else conn.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
            Pair(code, body)
        } finally {
            conn.disconnect()
        }
    }

    private fun checkUpdateAny(baseUrls: List<String>): Triple<Boolean, String?, String?> {
        val updateDirect = normalizeBaseUrl(BuildConfig.OWNER_UPDATE_URL)
        val updateEndpoints = mutableListOf<String>()
        if (updateDirect.isNotBlank()) {
            if (updateDirect.endsWith("/api/app-meta")) {
                updateEndpoints.add(updateDirect)
            } else {
                updateEndpoints.add("$updateDirect/api/app-meta")
                updateEndpoints.add(updateDirect)
            }
        }
        baseUrls.forEach { updateEndpoints.add("$it/api/app-meta") }

        for (ep in updateEndpoints.distinct()) {
            try {
                val (code, body) = httpGet(ep, 1400)
                if (code !in 200..299 || body.isBlank()) continue
                val j = JSONObject(body)
                val minVersion = j.optInt("minVersionCode", 1)
                val latestVersion = j.optInt("latestVersionCode", minVersion)
                val apkUrl = j.optString("apkDownloadUrl", "")
                if (minVersion > BuildConfig.VERSION_CODE || latestVersion > BuildConfig.VERSION_CODE) {
                    return Triple(true, if (apkUrl.isBlank()) null else apkUrl, ep)
                }
                return Triple(false, null, ep)
            } catch (_: Exception) {
                // try next endpoint
            }
        }
        return Triple(false, null, null)
    }

    private fun resolveWorkingBase(baseUrls: List<String>): String? {
        for (base in baseUrls) {
            try {
                val (code, _) = httpGet("$base/api/healthz", 1400)
                if (code in 200..299) return base
            } catch (_: Exception) {
                // try next
            }
        }
        return null
    }

    private fun bootstrapAndLoad() {
        clearBootTimeout()
        errorBox.visibility = View.GONE
        retryBtn.visibility = View.GONE
        webView.visibility = View.VISIBLE
        loading.visibility = View.VISIBLE
        bootTimeoutRunnable = Runnable {
            if (loading.visibility == View.VISIBLE && errorBox.visibility != View.VISIBLE) {
                showError("Zeitüberschreitung beim Verbindungsaufbau. Bitte erneut prüfen.")
            }
        }
        uiHandler.postDelayed(bootTimeoutRunnable!!, bootTimeoutMs)

        Thread {
            val configured = configuredBaseUrls()
            val bases = candidateBaseUrls()
            if (configured.isEmpty() && bases.isEmpty()) {
                runOnUiThread {
                    showError("Keine OWNER_APP_URL gesetzt.")
                }
                return@Thread
            }

            // check update endpoints only on configured URLs to avoid long scans
            val update = checkUpdateAny(configured.ifEmpty { bases.take(3) })
            if (update.first) {
                runOnUiThread {
                    showUpdateRequired(update.second)
                }
                return@Thread
            }

            val workingBase = resolveWorkingBase(bases)
            if (workingBase == null) {
                runOnUiThread {
                    showError("Keine URL erreichbar. Geprüft: ${bases.joinToString(", ")}")
                }
                return@Thread
            }

            getSharedPreferences(prefsName, MODE_PRIVATE)
                .edit()
                .putString("last_working_url", workingBase)
                .apply()

            runOnUiThread {
                clearBootTimeout()
                webView.loadUrl(workingBase)
            }
        }.start()
    }

    private fun showUpdateRequired(apkUrl: String?) {
        clearBootTimeout()
        loading.visibility = View.GONE
        webView.visibility = View.GONE
        errorBox.visibility = View.VISIBLE
        retryBtn.visibility = View.VISIBLE
        errorBox.text = getString(R.string.err_update_required)
        if (!apkUrl.isNullOrBlank()) {
            retryBtn.text = getString(R.string.btn_open_update)
            retryBtn.setOnClickListener {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(apkUrl)))
            }
        } else {
            retryBtn.text = getString(R.string.btn_retry)
            retryBtn.setOnClickListener { bootstrapAndLoad() }
        }
    }

    private fun showError(message: String) {
        clearBootTimeout()
        loading.visibility = View.GONE
        webView.visibility = View.GONE
        errorBox.visibility = View.VISIBLE
        retryBtn.visibility = View.VISIBLE
        retryBtn.text = getString(R.string.btn_retry)
        retryBtn.setOnClickListener { bootstrapAndLoad() }
        errorBox.text = getString(R.string.err_connect, BuildConfig.OWNER_APP_URL, message)
    }

    private fun clearBootTimeout() {
        bootTimeoutRunnable?.let { uiHandler.removeCallbacks(it) }
        bootTimeoutRunnable = null
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
