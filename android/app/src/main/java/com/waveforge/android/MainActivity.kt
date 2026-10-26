package com.waveforge.android

import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.app.UiModeManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.StatFs
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.util.Log
import android.widget.FrameLayout
import android.widget.ProgressBar
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * WaveForge Android 壳。
 *
 * 启动顺序：
 *  1. 把 assets/nodejs-project 解压到 filesDir（版本变化时重新解压）。
 *  2. 后台线程通过 JNI 调用 node::Start 启动内置 Node（android-server 打包产物 main.cjs，
 *     它在 localhost:3001 同时提供 API 与前端静态资源）。
 *  3. 轮询 http://localhost:3001/health 就绪后，WebView 加载 http://localhost:3001/。
 *
 * 说明：nodejs-mobile 每次进程只允许一个 Node 实例且不支持重启，因此 Node 一旦启动即常驻。
 */
class MainActivity : Activity() {

    companion object {
        private const val TAG = "WaveForgeMain"
        private const val NODE_ASSETS_DIR = "nodejs-project"
        // 资产版本拆两级（启动提速）：
        //  - CORE_ASSETS_VERSION：main.cjs / node_modules / package.json 等核心层变化才全量重解压
        //    （全量 ~100MB，重装 APK 后冷启动大头就是它）；
        //  - DIST_ASSETS_VERSION：仅前端 dist/ 变化时只删 dist 重拷（秒级）。
        // 前端迭代随版本走 build:android（默认只递增 DIST），核心层由 --full 递增。
        private const val PREF_CORE_KEY = "core_assets_version"
        private const val PREF_DIST_KEY = "dist_assets_version"
        private const val CORE_ASSETS_VERSION = 6
        private const val DIST_ASSETS_VERSION = 19
        private const val SERVER_URL = "http://localhost:3001/"
        private const val HEALTH_URL = "http://localhost:3001/health"
        // Node 启动标记：必须进程级唯一（nodejs-mobile 不支持重启、每次进程只允许一个）。
        // 实例字段会导致 Activity 重建（BACK 退出后从启动器再开）时重复解压 + 重复 node::Start，
        // 旧 node 仍持有 3001 端口，新实例 EADDRINUSE 且每个实例泄漏上百 MB。
        private val nodeStarted = java.util.concurrent.atomic.AtomicBoolean(false)
        // QQ 统一登录页（appid=716027609 为 QQ 音乐）：自带二维码，加载即出扫码登录，
        // 手机 QQ 扫后跳回 s_url（y.qq.com），音乐 cookie 随之写入，轮询即可捕获。
        // 移动 UA 下该页展示「二维码登录」，injectQQLoginHelper 会自动切到扫码 tab。
        // 不要直连 y.qq.com 首页：那是桌面版布局，会诱导用户点「下载客户端」离开 WebView。
        private const val QQ_LOGIN_URL =
            "https://xui.ptlogin2.qq.com/cgi-bin/xlogin" +
            "?appid=716027609" +
            "&daid=16" +
            "&pt_no_auth=1" +
            "&s_url=https%3A%2F%2Fy.qq.com%2Fn%2Fryqq_v2%2Fprofile%2Flike"
        // 汽水（抖音）统一登录页：直接开抖音网页版首页，未登录时 SPA 自动弹出
        // 「扫码登录/验证码登录/密码登录」弹窗（实机验证）。sso.douyin.com/?service=
        // 会先重定向到精选页才弹登录（多一跳依赖）；www.douyin.com/login 只返回 JSON。
        // 登录成功后 sessionid/sid_guard 等 cookie 落在 .douyin.com，CookieManager 轮询可捕获；
        // 后端 /api/soda/* 只要求 cookie 含登录键（与手动粘贴同口径），域名无所谓。
        private const val SODA_LOGIN_URL = "https://www.douyin.com/"
    }

    private lateinit var webView: WebView
    private lateinit var rootView: FrameLayout
    private var splashView: SplashView? = null
    private var qqLoginWebView: WebView? = null
    private var qqLoginPolling: Thread? = null
    // 汽水（抖音）登录覆盖层：同 QQ 覆盖层模式，轮询 .douyin.com 登录 cookie
    private var sodaLoginWebView: WebView? = null
    private var sodaLoginPolling: Thread? = null
    private var sodaInitialCookie = ""
    // BACK 键：JS 消费（useTvBack 逐级关闭）后上报，原生不再执行默认返回
    private val backConsumed = java.util.concurrent.atomic.AtomicBoolean(false)
    // WebView 渲染进程崩溃重载计数（防无限重载）
    private var rendererCrashCount = 0
    // Python 冒烟测试只跑一次（进程级）
    private val pythonSmokeRan = java.util.concurrent.atomic.AtomicBoolean(false)
    // 本机 API 鉴权令牌（nodeStarted 线程生成；shouldInterceptRequest 注入请求头）
    @Volatile
    private var localServiceToken: String = ""
    // 焦点在滑块上时由 Web 层开启：音量键转发给页面做 +1/-1 调节，不再调系统音量
    @Volatile
    private var volumeKeyCapture = false

    /** 沉浸全屏重申：安卓端永远全屏形态（TV/移动/PC布局皆然），无条件重申最稳。
     *  保留标志仅供 JS 桥 setImmersiveMode 理论上动态关闭（当前无此场景）。 */
    private var immersiveActive = true

    /** 首屏加速壳服务（127.0.0.1:3001 静态 dist + 反代 3002）。 */
    private var shellServer: ShellServer? = null
    @Volatile
    private var splashDismissed = false

    init {
        System.loadLibrary("native-lib")
        System.loadLibrary("node")
    }

    private external fun startNodeWithArguments(args: Array<String>): Int

    /** 是否 TV 设备（UiModeManager 判定；用于屏幕常亮等原生行为分流）。 */
    private fun isTvDevice(): Boolean {
        return try {
            val uiModeManager = getSystemService(Context.UI_MODE_SERVICE) as UiModeManager
            uiModeManager.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
        } catch (_: Exception) {
            false
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 屏幕常亮：仅 TV（遥控场景不会碰屏幕）。手机/平板正常超时熄屏省电，
        // 播放时由 WebView 内 <video>/AudioContext 或前台服务策略接管。
        if (isTvDevice()) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }

        // 挖孔屏：内容延伸进摄像头区（配合沉浸 padding 归零，横屏右侧不再留空条）。
        // theme 里已声明 windowLayoutInDisplayCutoutMode，这里代码层再兜一次
        // （部分 ROM 对 theme 属性处理不一致），API 28+ 才可用。
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        // 显式关闭 decor 自动留白（setDecorFitsSystemWindows=false）：targetSdk 35 本应强制
        // edge-to-edge，但 vivo 等 ROM 在挖孔/手势条件下仍会在装饰层加 insets padding，
        // 表现为屏幕一侧露出与页面不同的纯黑条。这里明确接管全部 insets。
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)

        rootView = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0a0f14"))
        }

        // WebView 远程调试（chrome://inspect）：真机排查渲染层问题用，release 保持开启
        // （无 token 的调试口只在本机 ADB 可达，不构成暴露面）。
        WebView.setWebContentsDebuggingEnabled(true)

        // targetSdk 35 起系统强制 edge-to-edge：内容会绘制到状态栏/导航栏后面。
        // WebView 是整个 UI，这里按系统栏 insets 给根容器留白（CSS 侧 env(safe-area-*)
        // 因 WebView 不再延伸到栏下而回退为 0，不会双重留白）。Fold 展开/旋转时
        // manifest 已声明 configChanges，Activity 不重建，insets 回调驱动重排即可。
        // ⚠️ 沉浸全屏期间 padding 归零：隐藏系统栏后 displayCutout（挖孔）insets
        // 仍非零，若继续留白会在屏幕边缘留出空条（实测 Fold 外屏横屏左侧空条即此因）。
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(rootView) { v, insets ->
            if (immersiveActive) {
                v.setPadding(0, 0, 0, 0)
            } else {
                val bars = insets.getInsets(
                    androidx.core.view.WindowInsetsCompat.Type.systemBars()
                        or androidx.core.view.WindowInsetsCompat.Type.displayCutout()
                )
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            }
            insets
        }

        // TV 全屏启动动画（参照 Win 端 splash：渐变背景 + Logo + 音波条），后端就绪后淡出
        splashView = SplashView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        rootView.addView(splashView)

        // 沉浸全屏三连重申：窗口刚 attach（500ms）、Node 服务启动中（4s）、WebView
        // 即将加载（10s）各重申一次——部分 ROM 在窗口未完全就绪时会丢弃 hide 请求
        // （实测 vivo Fold3 首次 hide 无效），且期间无任何回调可挂。
        // 无条件重申（不做标志门控）：主线程被 Node 启动阻塞时 postDelayed 顺延执行，
        // 条件门控叠加时序延迟会让排障信号全部丢失。
        intArrayOf(500, 4000, 10000).forEach { delay ->
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                if (!isFinishing) applyImmersiveNow(true)
            }, delay.toLong())
        }

        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            visibility = View.GONE
            setBackgroundColor(Color.parseColor("#0a0f14"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            // 支持 viewport meta 的 width（配合前端 viewport width=1920 做 TV 缩放）：
            // 默认 useWideViewPort=false 会忽略 meta width，布局恒为设备宽 → UI 巨大
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            // 页面源是 http://localhost:3001，加载 http 的网易云 CDN 音频不属于混合内容；
            // 这里仍放开兜底，避免个别 https 页面加载 http 资源时被拦。
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            webViewClient = object : WebViewClient() {
                // 主 WebView 挂着 WaveForgeNative 原生桥，只允许停留在本机后端地址：
                // 任何外部跳转（页面自身被诱导 window.location 外链）一律交系统浏览器，
                // 防止带桥的 WebView 被导航到不可信站点。
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val url = request?.url?.toString() ?: return false
                    if (isLocalServerUrl(url)) return false
                    return try {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                        true
                    } catch (_: Exception) {
                        true
                    }
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    // 页面就绪 = 窗口完全可见：部分 ROM（实测 vivo Fold3）会在此前的
                    // 时机丢弃 hide 请求（window 未完全就绪时 InsetsController.hide
                    // 静默无效），无条件重申一次。
                    applyImmersiveNow(true)
                    // 首屏渲染完成 → 淡出启动动画（壳服务直出 dist，总耗时 2-3s）。
                    dismissSplash()
                }

                // 本机 API 鉴权（通道一：请求头注入；通道二：waitForServerAndLoad 里的 Cookie）。
                // 给发往本机后端的请求注入 token 头（local-service-auth 校验
                // X-WaveForge-Local-Token）。注意：新版 WebView 的 requestHeaders 是不可变
                // map，put 会抛异常——必须 try 包裹，失败时由 Cookie 通道兜底（实测 vivo
                // Fold3 等 2024+ 设备全部走 Cookie；旧设备 WebView 保留此头双保险）。
                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): android.webkit.WebResourceResponse? {
                    val url = request?.url?.toString()
                    if (url != null && localServiceToken.isNotEmpty()) {
                        val scheme = request.url.scheme?.lowercase()
                        val host = request.url.host?.lowercase()
                        if ((scheme == "http" || scheme == "https") &&
                            (host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1")) {
                            try {
                                request.requestHeaders.put("X-WaveForge-Local-Token", localServiceToken)
                            } catch (_: Exception) {
                                // 不可变 map（新 WebView）：Cookie 通道兜底
                            }
                        }
                    }
                    return null
                }

                // 页面开始加载（崩溃恢复重载 / 热更新 reload 都会走到这里）时复位音量键捕获：
                // 崩溃前若焦点在滑块上，JS 侧开启过捕获但重载后状态丢失，此后音量键全部变成
                // DOM 事件、系统音量键失效直到用户聚焦其它控件。原生侧在每次导航开始时兜底复位。
                override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                    volumeKeyCapture = false
                }

                // WebView 渲染进程崩溃（Android 8+ 模拟器/低端机常见）：默认行为是终止整个应用闪退。
                // 这里接管：返回 true 阻止终止，并尝试重载页面（最多 2 次）。
                @SuppressLint("NewApi")
                override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                    Log.w(TAG, "WebView 渲染进程崩溃: $detail")
                    if (rendererCrashCount < 2) {
                        rendererCrashCount++
                        view.postDelayed({
                            if (!isFinishing) view.loadUrl(SERVER_URL)
                        }, 800)
                        return true
                    }
                    // 连续崩溃：展示静态提示，避免无限重载
                    view.postDelayed({
                        if (!isFinishing) {
                            view.loadData(
                                "<html><body style='background:#0a0f14;color:#9db2cc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh'>" +
                                    "<div style='text-align:center'><h2>页面渲染失败</h2><p>请尝试重启应用，或更新系统 WebView</p></div></body></html>",
                                "text/html", "utf-8"
                            )
                        }
                    }, 800)
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                // 前端 console → logcat（tag WFRender）：真机排障（封面 403/接口错误等）
                // 无需调试台即可 adb logcat 直接看；TV 端有 :3008 调试台，这里同样受益。
                override fun onConsoleMessage(consoleMessage: android.webkit.ConsoleMessage?): Boolean {
                    consoleMessage?.let { cm ->
                        Log.d("WFRender", "[${cm.messageLevel()?.name ?: '?'}] ${cm.message()} @${cm.sourceId().substringAfterLast('/')}:${cm.lineNumber()}")
                    }
                    return super.onConsoleMessage(consoleMessage)
                }
            }
            // 供前端"检查更新"按钮触发原生更新器（TV 上由原生弹窗下载安装）
            addJavascriptInterface(object {
                @android.webkit.JavascriptInterface
                fun checkForUpdates() {
                    UpdateChecker.check(this@MainActivity, force = true)
                }

                // 页面（useTvBack）消费了 BACK 键后上报，原生不再执行默认返回/退出
                @android.webkit.JavascriptInterface
                fun reportBackConsumed() {
                    backConsumed.set(true)
                }

                // 应用内 QQ 扫码登录（电视上没有 Electron 登录窗口）
                @android.webkit.JavascriptInterface
                fun openQQLogin() {
                    openQQLoginWindow()
                }

                @android.webkit.JavascriptInterface
                fun closeQQLogin() {
                    closeQQLoginWindow()
                }

                // 应用内汽水（抖音）扫码登录（手机/TV 无 Electron 登录窗口）
                @android.webkit.JavascriptInterface
                fun openSodaLogin() {
                    openSodaLoginWindow()
                }

                // 打开外部链接（TV 无浏览器窗口，交给系统浏览器应用）。
                // 只放行 http/https：url 可能来自 API 响应字段，intent:// 等协议
                // 经 ACTION_VIEW 可触发任意 Intent，不能透传。
                @android.webkit.JavascriptInterface
                fun openExternal(url: String) {
                    if (!url.startsWith("http://") && !url.startsWith("https://")) return
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    } catch (_: Exception) {}
                }

                // 设备识别码（TV 端设置页显示）
                @android.webkit.JavascriptInterface
                fun getDeviceId(): String {
                    return android.provider.Settings.Secure.getString(
                        contentResolver,
                        android.provider.Settings.Secure.ANDROID_ID
                    ) ?: "unknown"
                }

                // 设备形态（前端 platform.ts 判定用）：TV 设备返回 "television"，
                // 手机/平板（含 Fold）返回 "normal"。部分电视盒子 UA 无 TV 标记，
                // 靠这个同步桥兜底识别，避免 TV 被误判成手机 UI。
                @android.webkit.JavascriptInterface
                fun getUiMode(): String {
                    return if (isTvDevice()) "television" else "normal"
                }

                // 平板「PC 布局」沉浸全屏：进入时隐藏系统栏（状态栏/导航栏，滑动手势临时唤出），
                // 切回移动布局恢复。平板 PC 模式要的是整屏桌面，系统栏 + insets 留白都是"黑边"。
                @android.webkit.JavascriptInterface
                fun setImmersiveMode(enabled: Boolean) {
                    runOnUiThread {
                        immersiveActive = enabled
                        applyImmersiveNow(enabled)
                        // 隐藏/显示系统栏会触发一次 insets 分发，但不保证（挖孔不变时
                        // 部分机型不重派），这里直接按标志重排，消除边缘空条/黑边。
                        rootView.setPadding(
                            if (enabled) 0 else rootView.paddingLeft.coerceAtLeast(0),
                            if (enabled) 0 else rootView.paddingTop.coerceAtLeast(0),
                            if (enabled) 0 else rootView.paddingRight.coerceAtLeast(0),
                            if (enabled) 0 else rootView.paddingBottom.coerceAtLeast(0)
                        )
                        if (!enabled) rootView.requestApplyInsets()
                    }
                }

                // 滑块聚焦时开启音量键捕获（音量键改为调节滑块，而非系统音量）
                @android.webkit.JavascriptInterface
                fun setVolumeKeyCapture(v: Boolean) {
                    volumeKeyCapture = v
                }

                // 播放状态同步：播放中起前台服务（进程 adj 提到 FOREGROUND，避免
                // vivo 等 ROM 在切后台后直接清理进程）；暂停/停止时撤销通知。
                @android.webkit.JavascriptInterface
                fun setPlaybackActive(active: Boolean) {
                    try {
                        if (active) PlaybackService.start(this@MainActivity)
                        else PlaybackService.stop(this@MainActivity)
                    } catch (_: Exception) {
                        // 前台服务受限不影响播放
                    }
                }

                // 设备详情（配置检查面板 + 关于本机用）：内存/存储/CPU/温度/分辨率/电池等
                @android.webkit.JavascriptInterface
                fun getDeviceInfo(): String {
                    return try {
                        val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
                        val mi = ActivityManager.MemoryInfo()
                        am.getMemoryInfo(mi)
                        val stat = StatFs(Environment.getDataDirectory().path)
                        val metrics = resources.displayMetrics
                        val realSize = android.graphics.Point().also { windowManager.defaultDisplay.getRealSize(it) }
                        val bm = getSystemService(Context.BATTERY_SERVICE) as android.os.BatteryManager
                        val webViewVersion = try {
                            android.webkit.WebView.getCurrentWebViewPackage()?.versionName ?: ""
                        } catch (_: Exception) { "" }
                        org.json.JSONObject()
                            .put("model", Build.MODEL)
                            .put("manufacturer", Build.MANUFACTURER)
                            .put("androidVersion", Build.VERSION.RELEASE)
                            .put("buildDisplay", Build.DISPLAY)
                            .put("apiLevel", Build.VERSION.SDK_INT)
                            .put("screenPx", "${realSize.x}x${realSize.y}")
                            .put("density", metrics.density.toString())
                            .put("densityDpi", metrics.densityDpi)
                            .put("webViewVersion", webViewVersion)
                            .put("totalMem", mi.totalMem)
                            .put("availMem", mi.availMem)
                            .put("heapMax", Runtime.getRuntime().maxMemory())
                            .put("storageTotal", stat.totalBytes)
                            .put("storageFree", stat.availableBytes)
                            .put("cpuCores", Runtime.getRuntime().availableProcessors())
                            .put("cpuTempC", readCpuTemp())
                            .put("batteryPercent", bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY))
                            .put("batteryCharging", bm.isCharging)
                            .put("refreshRate", run {
                                try { String.format(java.util.Locale.US, "%.1f", windowManager.defaultDisplay.mode.refreshRate) + " Hz" }
                                catch (_: Exception) { "" }
                            })
                            .put("hdr", run { try { windowManager.defaultDisplay.isHdr } catch (_: Exception) { false } })
                            .put("displayMode", run {
                                try {
                                    val m = windowManager.defaultDisplay.mode
                                    "${m.physicalWidth}x${m.physicalHeight} @ ${String.format(java.util.Locale.US, "%.1f", m.refreshRate)}Hz"
                                } catch (_: Exception) { "" }
                            })
                            .toString()
                    } catch (_: Exception) {
                        "{}"
                    }
                }

                /** 读取 CPU 温度（℃）：遍历 thermal_zone 取最大值。 */
                fun readCpuTemp(): Double {
                    return try {
                        val dir = java.io.File("/sys/class/thermal")
                        val zones = dir.listFiles()?.filter { it.name.startsWith("thermal_zone") } ?: return -1.0
                        var max = -1.0
                        for (z in zones) {
                            val f = java.io.File(z, "temp")
                            if (!f.exists()) continue
                            val v = f.readText().trim().toDoubleOrNull() ?: continue
                            val t = if (v > 1000) v / 1000.0 else v
                            if (t > max) max = t
                        }
                        max
                    } catch (_: Exception) {
                        -1.0
                    }
                }
            }, "WaveForgeNative")
        }
        rootView.addView(webView)
        setContentView(rootView)

        // 本机 API 鉴权令牌：必须在壳服务启动前生成——waitForServerAndLoad 会在壳就绪
        // （几百毫秒）时用它对 CookieManager 下发 wf_local_token；此前该令牌在 Node
        // 线程里生成（首启要等 ~60s 解压），导致首启页面请求全部 403 Unauthorized。
        if (localServiceToken.isEmpty()) {
            localServiceToken = java.util.UUID.randomUUID().toString().replace("-", "") +
                java.util.UUID.randomUUID().toString().replace("-", "")
        }

        // 首屏提速：原生壳服务先占 3001（APK 内 dist 直出，几百毫秒可用），
        // Node 后台在 3002 启动，壳把 API 反代过去（未就绪时 503 → 前端自动重试）。
        // 这样用户 2-3 秒看到界面，而不是等 Node 冷启 20-30 秒。
        if (shellServer == null) {
            shellServer = ShellServer(
                assets = assets,
                distFileDir = File(filesDir, "$NODE_ASSETS_DIR/dist"),
                localToken = localServiceToken,
            ).also { it.start(3001) }
        }

        if (nodeStarted.compareAndSet(false, true)) {
            Thread {
                ensureNodeProject()
                val mainJs = File(filesDir, "$NODE_ASSETS_DIR/main.cjs").absolutePath
                // --port=3002：3001 已被原生壳占用（壳反代到 3002）
                startNodeWithArguments(arrayOf("node", mainJs, "--waveforge-local-token=$localServiceToken", "--port=3002"))
            }.start()
        }

        // 更新生效标记：安装前写入 Web 端 localStorage，供前端"版本更新成功"弹窗使用
        UpdateChecker.beforeInstallHook = { version, notes ->
            webView.post {
                val payload = org.json.JSONObject().put("version", version).put("notes", notes).toString()
                webView.evaluateJavascript(
                    "localStorage.setItem('waveforge:update-applied', JSON.stringify($payload))", null)
            }
        }

        waitForServerAndLoad()
    }

    /** 把 assets/nodejs-project 解压到 filesDir；版本标记变化才重解。 */
    private fun ensureNodeProject() {
        val dest = File(filesDir, NODE_ASSETS_DIR)
        val prefs = getSharedPreferences("waveforge", Context.MODE_PRIVATE)
        val coreOk = prefs.getInt(PREF_CORE_KEY, -1) == CORE_ASSETS_VERSION
        val distOk = prefs.getInt(PREF_DIST_KEY, -1) == DIST_ASSETS_VERSION
        if (dest.exists() && coreOk && distOk) return
        if (!dest.exists() || !coreOk) {
            // 核心层变化（或首装）：全量解压
            dest.deleteRecursively()
            copyAssetDir(NODE_ASSETS_DIR, dest)
            prefs.edit()
                .putInt(PREF_CORE_KEY, CORE_ASSETS_VERSION)
                .putInt(PREF_DIST_KEY, DIST_ASSETS_VERSION)
                .apply()
            return
        }
        // 仅前端变化：只重建 dist/（node_modules 等核心层 ~100MB 不再重拷，冷启动秒级）
        val distDir = File(dest, "dist")
        distDir.deleteRecursively()
        copyAssetDir("$NODE_ASSETS_DIR/dist", distDir)
        prefs.edit().putInt(PREF_DIST_KEY, DIST_ASSETS_VERSION).apply()
    }

    private fun copyAssetDir(path: String, dest: File) {
        assets.list(path)?.forEach { name ->
            val childPath = "$path/$name"
            val out = File(dest, name)
            if (assets.list(childPath)?.isNotEmpty() == true) {
                out.mkdirs()
                copyAssetDir(childPath, out)
            } else {
                assets.open(childPath).use { input ->
                    out.outputStream().use { output -> input.copyTo(output) }
                }
            }
        }
    }

    /** 轮询 Node 服务直到 /health 就绪，然后加载应用。 */
    /** 等壳服务就绪（几百毫秒）后立即加载页面；Node 引擎在后台继续启动，前端自动重试。 */
    private fun waitForServerAndLoad() {
        val activity = this
        Thread {
            var ready = false
            var attempts = 0
            while (!ready && attempts < 40) { // 最多约 4 秒（壳正常几百毫秒）
                attempts++
                ready = isShellUp()
                if (!ready) Thread.sleep(100)
            }
            if (activity.isFinishing) return@Thread
            runOnUiThread {
                if (activity.isFinishing) return@runOnUiThread
                // 本机 API 鉴权通道二（新 WebView 主通道）：把 token 写成 localhost Cookie
                // （后端 local-service-auth 同时接受头与 wf_local_token Cookie）。
                // ● 壳服务反代到 Node 时会原样透传 Cookie/header，鉴权链路不变。
                if (localServiceToken.isNotEmpty()) {
                    try {
                        val cm = CookieManager.getInstance()
                        cm.setAcceptCookie(true)
                        cm.setCookie(SERVER_URL, "wf_local_token=$localServiceToken; Path=/")
                        cm.flush()
                    } catch (_: Exception) {
                        // Cookie 失败时旧通道（请求头注入）仍可能生效
                    }
                }
                webView.loadUrl(SERVER_URL)
                // 应用内更新检查（后台拉清单，有新版弹窗，不影响启动）
                if (!activity.isFinishing) UpdateChecker.check(activity)
            }
        }.start()
    }

    /** 页面首帧完成 → 淡出启动动画（幂等；页面重载不再重复淡出）。 */
    private fun dismissSplash() {
        if (splashDismissed) return
        splashDismissed = true
        runOnUiThread {
            if (isFinishing) return@runOnUiThread
            splashView?.animate()?.alpha(0f)?.setDuration(280)?.withEndAction {
                if (isFinishing) return@withEndAction
                runCatching { rootView.removeView(splashView) }
                splashView = null
                webView.visibility = View.VISIBLE
                webView.requestFocus()
            }
        }
    }

    /** 壳服务（3001）就绪探测：直接拿静态 index.html 的状态行判断。 */
    private fun isShellUp(): Boolean = try {
        // 探测壳的静态入口（HEAD /），不走 /health（那是 Node 的反代路径）
        val conn = URL(SERVER_URL).openConnection() as HttpURLConnection
        conn.connectTimeout = 400
        conn.readTimeout = 600
        conn.requestMethod = "HEAD"
        val code = conn.responseCode
        conn.disconnect()
        code in 200..299
    } catch (e: Exception) {
        false
    }

    // ---------- 应用内 QQ 扫码登录（电视上没有 Electron 登录窗口） ----------

    private fun openQQLoginWindow() {
        if (qqLoginWebView != null) return // 已打开
        runOnUiThread {
            val overlay = WebView(this).apply {
                layoutParams = FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                // 登录页是移动版站点：必须尊重 meta viewport，否则 980px 布局塞进手机屏
                // → 二维码巨大、按钮够不着（实机「扫码登录坏了」的直接原因之一）。
                settings.useWideViewPort = true
                settings.loadWithOverviewMode = true
                settings.userAgentString = mobileUserAgent()
                // 登录弹窗可能用 window.open 打开，允许并重定向回当前覆盖层
                settings.javaScriptCanOpenWindowsAutomatically = true
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                setBackgroundColor(Color.parseColor("#0a0f14"))
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                        val url = request?.url?.toString() ?: return false
                        val scheme = request.url.scheme?.lowercase() ?: ""
                        // App 唤起协议（mqqapi:// / wtloginmqq:// / wx:// 等）一律丢弃：
                        // 拉起 QQ 客户端后登录态只留在 QQ 自己的存储，WebView 的
                        // CookieManager 抓不到 → 轮询永远失败，用户还会被甩进系统浏览器
                        // 卡死。扫码/账号登录都在本覆盖层内完成，cookie 可可靠回传。
                        if (scheme != "http" && scheme != "https") return true
                        if (!isQQDomain(url)) {
                            // 登录流程之外的 http 站点交给系统浏览器，避免登录态外泄
                            try {
                                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                            } catch (_: Exception) {}
                            return true
                        }
                        return false
                    }

                    override fun onPageFinished(view: WebView?, url: String?) {
                        injectQQLoginHelper(view)
                    }
                }
                webChromeClient = object : WebChromeClient() {
                    // window.open 的新窗口重定向到当前覆盖层，避免 QQ 登录弹窗打不开
                    override fun onCreateWindow(
                        view: WebView?,
                        isDialog: Boolean,
                        isUserGesture: Boolean,
                        resultMsg: android.os.Message?
                    ): Boolean {
                        val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
                        transport.webView = view
                        resultMsg.sendToTarget()
                        return true
                    }
                }
            }
            // 覆盖层自己的最小桥：提示条「关闭/刷新」按钮走 window.WaveForgeNative，
            // 不注入的话这两个按钮点了没反应（主 WebView 的桥不在覆盖层作用域里）。
            overlay.addJavascriptInterface(object {
                @android.webkit.JavascriptInterface
                fun closeQQLogin() {
                    runOnUiThread { closeQQLoginWindow() }
                }
                @android.webkit.JavascriptInterface
                fun reloadLogin() {
                    runOnUiThread { overlay.loadUrl(QQ_LOGIN_URL) }
                }
                @android.webkit.JavascriptInterface
                fun reportBackConsumed() { /* 覆盖层内 BACK 由原生直接关闭，无需 DOM 上报 */ }
            }, "WaveForgeNative")
            rootView.addView(overlay)
            qqLoginWebView = overlay
            overlay.loadUrl(QQ_LOGIN_URL)
            startQQCookiePolling()
        }
    }

    private fun closeQQLoginWindow() {
        qqLoginPolling?.interrupt()
        qqLoginPolling = null
        runOnUiThread {
            qqLoginWebView?.destroy()
            qqLoginWebView?.let { rootView.removeView(it) }
            qqLoginWebView = null
            // 通知 SPA 登录流程已结束（未取到 cookie 时用于复位 loading）
            webView.post {
                webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('qqLoginClosed', { detail: {} }))", null)
            }
        }
    }

    private fun isQQDomain(url: String): Boolean = try {
        val host = Uri.parse(url).host?.lowercase() ?: return false
        host == "qq.com" || host.endsWith(".qq.com")
    } catch (_: Exception) {
        false
    }

    // ---------- 应用内汽水（抖音）扫码登录 ----------

    /** 抖音系/字节基建域名白名单：登录页、二维码图、风控验证（zijieapi 验证码）、汽水官方都在里面。 */
    private fun isSodaDomain(url: String): Boolean = try {
        val host = Uri.parse(url).host?.lowercase() ?: return false
        listOf(
            "douyin.com", "douyinstatic.com", "douyinpic.com", "zjcdn.com", "zijieapi.com",
            "bytedance.com", "byteimg.com", "ibytedtos.com", "bytetos.com", "snssdk.com",
            "toutiao.com", "qishui.com", "yhgfb-cn-static.com",
        ).any { host == it || host.endsWith(".$it") }
    } catch (_: Exception) {
        false
    }

    private fun openSodaLoginWindow() {
        if (sodaLoginWebView != null) return // 已打开
        runOnUiThread {
            // 覆盖层打开前的快照：WebView 的 cookie 库是全局持久的，可能残留上次的
            // 过期登录键。只认「内容发生变化且含登录键」的快照，避免旧 cookie 秒触发。
            sodaInitialCookie = try {
                CookieManager.getInstance().getCookie("https://www.douyin.com/") ?: ""
            } catch (_: Exception) { "" }
            val overlay = WebView(this).apply {
                layoutParams = FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.useWideViewPort = true
                settings.loadWithOverviewMode = true
                // 必须桌面 UA：sso.douyin.com 登录页检测到移动 UA 会重定向到
                // 「下载汽水音乐」营销轮播页（实机已复现），只有桌面 UA 才渲染
                // 二维码/短信登录表单。桌面页由 useWideViewPort 缩放适配。
                settings.userAgentString =
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                settings.javaScriptCanOpenWindowsAutomatically = true
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                setBackgroundColor(Color.parseColor("#0a0f14"))
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                        val url = request?.url?.toString() ?: return false
                        val scheme = request.url.scheme?.lowercase() ?: ""
                        // 抖音 App 唤起协议（snssdk1233:// 等）一律丢弃：登录态留在抖音
                        // App 自己的存储里，CookieManager 抓不到，轮询永远等不到结果
                        if (scheme != "http" && scheme != "https") return true
                        if (!isSodaDomain(url)) {
                            try {
                                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                            } catch (_: Exception) {}
                            return true
                        }
                        return false
                    }

                    override fun onPageFinished(view: WebView?, url: String?) {
                        injectSodaLoginHelper(view)
                    }
                }
                webChromeClient = object : WebChromeClient() {
                    override fun onCreateWindow(
                        view: WebView?,
                        isDialog: Boolean,
                        isUserGesture: Boolean,
                        resultMsg: android.os.Message?
                    ): Boolean {
                        val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
                        transport.webView = view
                        resultMsg.sendToTarget()
                        return true
                    }
                }
            }
            // 覆盖层自己的最小桥（主 WebView 的桥不在覆盖层作用域里）
            overlay.addJavascriptInterface(object {
                @android.webkit.JavascriptInterface
                fun closeSodaLogin() {
                    runOnUiThread { closeSodaLoginWindow() }
                }
                @android.webkit.JavascriptInterface
                fun reloadLogin() {
                    runOnUiThread { overlay.loadUrl(SODA_LOGIN_URL) }
                }
                @android.webkit.JavascriptInterface
                fun reportBackConsumed() { }
            }, "WaveForgeNative")
            rootView.addView(overlay)
            sodaLoginWebView = overlay
            overlay.loadUrl(SODA_LOGIN_URL)
            startSodaCookiePolling()
        }
    }

    private fun closeSodaLoginWindow() {
        sodaLoginPolling?.interrupt()
        sodaLoginPolling = null
        runOnUiThread {
            sodaLoginWebView?.destroy()
            sodaLoginWebView?.let { rootView.removeView(it) }
            sodaLoginWebView = null
            // 通知 SPA 登录流程已结束（未取到 cookie 时用于复位 loading）
            webView.post {
                webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('sodaLoginClosed', { detail: {} }))", null)
            }
        }
    }

    private fun injectSodaLoginHelper(view: WebView?) {
        view?.evaluateJavascript(
            """
            (function () {
              if (document.getElementById('wf-soda-login-bar')) return;
              var bar = document.createElement('div');
              bar.id = 'wf-soda-login-bar';
              bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483000;background:rgba(8,12,20,0.94);color:#fff;font-size:15px;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-family:sans-serif;';
              bar.innerHTML = '<span>在下方页面完成抖音登录（扫码 / 短信验证均可），成功后自动返回</span>' +
                '<span style="display:flex;gap:8px;flex:none;">' +
                '<button id="wf-soda-login-reload" style="background:rgba(255,255,255,0.16);color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:14px;">刷新</button>' +
                '<button id="wf-soda-login-close" style="background:rgba(255,255,255,0.16);color:#fff;border:none;border-radius:8px;padding:8px 18px;font-size:14px;">关闭</button>' +
                '</span>';
              document.body.appendChild(bar);
              document.getElementById('wf-soda-login-close').addEventListener('click', function () {
                try { window.WaveForgeNative.closeSodaLogin(); } catch (e) {}
              });
              document.getElementById('wf-soda-login-reload').addEventListener('click', function () {
                try { window.WaveForgeNative.reloadLogin(); } catch (e) {}
              });
            })();
            """.trimIndent(),
            null
        )
    }

    private fun startSodaCookiePolling() {
        sodaLoginPolling?.interrupt()
        sodaLoginPolling = Thread {
            var attempts = 0
            while (!Thread.currentThread().isInterrupted && attempts < 300) { // 最多 10 分钟
                attempts++
                val cookie = try {
                    CookieManager.getInstance().getCookie("https://www.douyin.com/")
                } catch (_: Exception) { null }
                if (cookie != null && cookie != sodaInitialCookie && isSodaLoggedInCookie(cookie)) {
                    runOnUiThread {
                        val payload = org.json.JSONObject().put("cookie", cookie).toString()
                        webView.evaluateJavascript(
                            "window.dispatchEvent(new CustomEvent('sodaLoginCookieCaptured', { detail: $payload }))",
                            null
                        )
                        closeSodaLoginWindow()
                    }
                    return@Thread
                }
                try {
                    Thread.sleep(2000)
                } catch (_: InterruptedException) {
                    return@Thread
                }
            }
        }.apply { start() }
    }

    /** 与后端 qishuiCookieHasLogin 同口径：四个抖音登录键任一存在即视为已登录。 */
    private fun isSodaLoggedInCookie(cookie: String): Boolean {
        return listOf("sessionid=", "sessionid_ss=", "sid_guard=", "sid_tt=").any { cookie.contains(it) }
    }

    /** 主 WebView 导航守卫用：只放行本机 Node 后端（localhost:3001）与 about/data 空地址。 */
    private fun isLocalServerUrl(url: String): Boolean = try {
        val uri = Uri.parse(url)
        when (uri.scheme?.lowercase()) {
            "http", "https" -> {
                val host = uri.host?.lowercase() ?: return false
                host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1"
            }
            "about", "data", "blob" -> true
            else -> false
        }
    } catch (_: Exception) {
        false
    }

    private fun injectQQLoginHelper(view: WebView?) {
        view?.evaluateJavascript(
            """
            (function () {
              if (document.getElementById('wf-qq-login-bar')) return;

              // ---- 顶部提示条 + 关闭按钮 ----
              var bar = document.createElement('div');
              bar.id = 'wf-qq-login-bar';
              bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483000;background:rgba(8,12,20,0.94);color:#fff;font-size:15px;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-family:sans-serif;';
              bar.innerHTML = '<span>在下方页面完成 QQ 登录（扫码 / 本机账号均可），成功后自动返回</span>' +
                '<span style="display:flex;gap:8px;flex:none;">' +
                '<button id=\"wf-qq-login-reload\" style=\"background:rgba(255,255,255,0.16);color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:14px;\">刷新</button>' +
                '<button id=\"wf-qq-login-close\" style=\"background:rgba(255,255,255,0.16);color:#fff;border:none;border-radius:8px;padding:8px 18px;font-size:14px;\">关闭</button>' +
                '</span>';
              document.body.appendChild(bar);
              document.getElementById('wf-qq-login-close').addEventListener('click', function () {
                try { window.WaveForgeNative.closeQQLogin(); } catch (e) {}
              });
              document.getElementById('wf-qq-login-reload').addEventListener('click', function () {
                try { window.WaveForgeNative.reloadLogin(); } catch (e) {}
              });

              // ---- 自动打开登录弹窗（电视无鼠标，不能让用户去点"登录"） ----
              // ptlogin2 统一登录页自带二维码，无需自动点击（且避免误点"密码登录"）
              if (location.hostname.indexOf('ptlogin') !== -1) return;
              window.__wfAutoLoginTries = window.__wfAutoLoginTries || 0;

              function pickByText(texts) {
                var all = document.querySelectorAll('button, a, div, span, li, em, i');
                for (var i = 0; i < all.length; i++) {
                  var el = all[i];
                  if (el.children.length > 4) continue; // 跳过容器
                  var t = (el.textContent || '').trim();
                  if (!t || t.length > 6) continue;
                  for (var k = 0; k < texts.length; k++) {
                    if (t === texts[k] || t.indexOf(texts[k]) !== -1) return el;
                  }
                }
                return null;
              }

              function loginDialogOpened() {
                if (document.querySelector('iframe[src*="ptlogin"], iframe[src*="xui.ptlogin"], [id*="ptlogin"], [class*="ptlogin"]')) return true;
                var bodyText = (document.body ? document.body.innerText : '');
                return bodyText.indexOf('二维码') !== -1 || bodyText.indexOf('扫码') !== -1;
              }

              function tryOpenLogin() {
                if (loginDialogOpened() || window.__wfAutoLoginTries > 6) return;
                window.__wfAutoLoginTries++;
                // 1) 点"登录"
                var btn = pickByText(['登录', '登 录', '立即登录', '登录QQ']);
                if (btn) { btn.click(); }
                // 2) 等弹窗渲染后，若默认不是扫码 tab，点"扫码登录/二维码"
                setTimeout(function () {
                  if (loginDialogOpened()) return;
                  var qr = pickByText(['扫码登录', '二维码登录', '扫码', '二维码']);
                  if (qr) qr.click();
                }, 1800);
                // 3) 没弹出来就再试
                setTimeout(tryOpenLogin, 2500);
              }

              // 页面可能是 SPA，多等几轮让脚本渲染完成
              setTimeout(tryOpenLogin, 800);
              setTimeout(tryOpenLogin, 2500);
              setTimeout(tryOpenLogin, 5000);
            })();
            """.trimIndent(),
            null
        )
    }

    private fun startQQCookiePolling() {
        qqLoginPolling?.interrupt()
        qqLoginPolling = Thread {
            var attempts = 0
            while (!Thread.currentThread().isInterrupted && attempts < 300) { // 最多 10 分钟
                attempts++
                val cookie = CookieManager.getInstance().getCookie("https://y.qq.com/")
                if (cookie != null && isQQLoggedInCookie(cookie)) {
                    runOnUiThread {
                        val payload = org.json.JSONObject().put("cookie", cookie).toString()
                        webView.evaluateJavascript(
                            "window.dispatchEvent(new CustomEvent('qqLoginCookieCaptured', { detail: $payload }))",
                            null
                        )
                        closeQQLoginWindow()
                    }
                    return@Thread
                }
                try {
                    Thread.sleep(2000)
                } catch (_: InterruptedException) {
                    return@Thread
                }
            }
        }.apply { start() }
    }

    private fun isQQLoggedInCookie(cookie: String): Boolean {
        val hasUserId = cookie.contains("uin=") || cookie.contains("wxuin=")
        val hasMusicKey = cookie.contains("qm_keyst=") || cookie.contains("qqmusic_key=")
        return hasUserId && hasMusicKey
    }

    /** 移动端 UA（默认 WebView UA 在个别 ROM 上缺 Chrome 版本段，站点会降级到桌面版）。 */
    private fun mobileUserAgent(): String {
        val base = WebSettings.getDefaultUserAgent(this)
        return if (base.contains("Mobile")) base else "$base Mobile"
    }

    // ---------- 遥控器键位 ----------

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // 滑块聚焦（Web 层已开启捕获）：音量键转发给页面做 +1/-1，不再调系统音量
        if (volumeKeyCapture && (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP || event.keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                forwardKeyToDom(event.keyCode)
            }
            return true
        }

        // BACK：QQ/汽水登录覆盖层打开时优先关闭它
        if (event.keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_DOWN) {
            if (qqLoginWebView != null) {
                closeQQLoginWindow()
                return true
            }
            if (sodaLoginWebView != null) {
                closeSodaLoginWindow()
                return true
            }
            // 派发给页面（useTvBack 逐级关闭弹窗/软键盘），JS 消费后上报；
            // 未消费（页面无弹窗）时再走默认返回/退到桌面，避免真机上 BACK 直接退应用。
            // 800ms 而非 400ms：低端 TV 上重弹窗（动画+GC 停顿）时 JS 的逐级关闭链
            // + evaluateJavascript 回传可能超出 400ms，导致页面还在关弹窗、原生已退应用。
            backConsumed.set(false)
            forwardKeyToDom(KeyEvent.KEYCODE_BACK)
            rootView.postDelayed({
                if (!backConsumed.get() && !isFinishing) {
                    handleBackDefault()
                }
            }, 800)
            return true
        }

        // 媒体键通常不会作为 DOM 事件到达 WebView，这里显式转发给页面（页面侧有对应 keydown 处理）。
        if (webView.visibility == View.VISIBLE) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_MEDIA_PLAY,
                KeyEvent.KEYCODE_MEDIA_PAUSE,
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
                KeyEvent.KEYCODE_MEDIA_STOP,
                KeyEvent.KEYCODE_MEDIA_NEXT,
                KeyEvent.KEYCODE_MEDIA_PREVIOUS,
                KeyEvent.KEYCODE_MEDIA_REWIND,
                KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
                KeyEvent.KEYCODE_MENU,
                KeyEvent.KEYCODE_SEARCH -> {
                    if (event.action == KeyEvent.ACTION_DOWN) {
                        forwardKeyToDom(event.keyCode)
                    }
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    /** JS 消费了 BACK（useTvBack 返回 true）后上报，避免原生再执行默认返回。 */
    private fun handleBackDefault() {
        if (webView.visibility == View.VISIBLE && webView.canGoBack()) {
            webView.goBack()
        } else {
            finish()
        }
    }

    private fun forwardKeyToDom(keyCode: Int) {
        webView.post {
            // 必须派发到 document：合成事件的传播路径只有目标节点自身（window 的父节点为 null），
            // 而 JS 侧（tvCore 焦点导航 / mediaKeyBridge）的 keydown 监听全部注册在 document 上——
            // 派发到 window 时 document 的 capture/bubble 监听器永远收不到（BACK 栈/媒体键整体失效）。
            webView.evaluateJavascript(
                "document.dispatchEvent(new KeyboardEvent('keydown', {keyCode: $keyCode, which: $keyCode, bubbles: true, cancelable: true}));" +
                    "document.dispatchEvent(new KeyboardEvent('keyup', {keyCode: $keyCode, which: $keyCode, bubbles: true, cancelable: true}));",
                null
            )
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // QQ/汽水登录覆盖层打开时优先关闭
        if (qqLoginWebView != null) {
            closeQQLoginWindow()
            return
        }
        if (sodaLoginWebView != null) {
            closeSodaLoginWindow()
            return
        }
        // dispatchKeyEvent 已把 BACK 派发给页面并等待 JS 消费上报；
        // 这里作为兜底（例如系统直接回调），走默认返回/退出。
        handleBackDefault()
    }

    override fun onResume() {
        super.onResume()
        // Fold 折叠/展开切换后必经 onResume：部分 ROM 的 WebView resize 事件会丢/迟到
        // （实测 vivo Fold3），补发一次 resize 让前端 platform.ts 重算手机/平板形态，
        // 避免「平板+PC布局」状态卡在外屏上渲染桌面 UI。
        runPythonSmokeTest()
        if (webView.visibility == View.VISIBLE) {
            webView.postDelayed({
                if (!isFinishing) webView.evaluateJavascript(
                    "window.dispatchEvent(new Event('resize')); if (document.visibilityState === 'visible') document.dispatchEvent(new Event('visibilitychange'));",
                    null)
            }, 250)
        }
        // 沉浸全屏在锁屏解锁/切后台回来后会被系统重置：这里无条件重申。
        webView.postDelayed({
            if (!isFinishing) applyImmersiveNow(true)
        }, 120)
        // JS 桥探针：logcat WFNative bridge-probe 行直接给出 WaveForgeNative / setImmersiveMode
        // 是否存在于页面（排障「前端为何没调到原生桥」用，与 console 桥无关）。
        webView.evaluateJavascript(
            "(function(){try{return 'native='+(typeof window.WaveForgeNative)+' setImm='+(window.WaveForgeNative?typeof window.WaveForgeNative.setImmersiveMode:'-')}catch(e){return 'probe-err:'+e}})()"
        ) { result -> Log.i("WFPython", "bridge-probe $result"); Log.i(TAG, "bridge-probe $result") }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // 窗口焦点变化（启动完成/弹窗关闭/多窗口切换）后系统可能重置系统栏显隐：
        // 这是安卓全屏应用的官方推荐挂点，无条件重申。
        if (hasFocus) applyImmersiveNow(true)
    }

    /** 实际执行沉浸栏显隐（hide/show），setImmersiveMode 与 onResume 重申共用。
     *  日志在动作之前打：若 controller 调用挂死/抛 Error，执行痕迹仍然可见。 */
    private fun applyImmersiveNow(enabled: Boolean) {
        // 用 WFPython tag（实测唯一稳定可达 logcat 的本应用 tag）+ WaveForgeMain 双打：
        // vivo 上 WaveForgeMain tag 疑似被日志系统静默丢弃，排障期间借道。
        Log.i("WFPython", "immersive begin=$enabled")
        Log.i(TAG, "immersive begin=$enabled")
        try {
            val controller = androidx.core.view.WindowCompat
                .getInsetsController(window, window.decorView)
            if (enabled) {
                controller.systemBarsBehavior =
                    androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                controller.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
                // vivo 兼容双保险：WindowManager 层全屏 flag（老路径，部分 ROM 只认这个）
                @Suppress("DEPRECATION")
                window.addFlags(android.view.WindowManager.LayoutParams.FLAG_FULLSCREEN)
            } else {
                controller.show(androidx.core.view.WindowInsetsCompat.Type.systemBars())
                @Suppress("DEPRECATION")
                window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_FULLSCREEN)
            }
            Log.i(TAG, "immersive done=$enabled")
        } catch (e: Exception) {
            Log.w(TAG, "immersive failed: $e")
        } catch (e: Throwable) {
            Log.w(TAG, "immersive fatal: $e")
        }
    }

    /** 内嵌 Python（Chaquopy）冒烟测试：验证 numpy + STFT 在安卓上可跑（AutoMix 前置）。 */
    private fun runPythonSmokeTest() {
        if (pythonSmokeRan.getAndSet(true)) return
        Thread {
            try {
                if (!com.chaquo.python.Python.isStarted()) {
                    com.chaquo.python.Python.start(com.chaquo.python.android.AndroidPlatform(this@MainActivity))
                }
                val py = com.chaquo.python.Python.getInstance()
                val result = py.getModule("wf_python_smoke").callAttr("smoke_test").toString()
                Log.i("WFPython", "smoke: $result")
                val beatResult = py.getModule("wf_python_smoke").callAttr("beat_smoke", cacheDir.absolutePath).toString()
                Log.i("WFPython", beatResult)
            } catch (e: Throwable) {
                Log.e("WFPython", "smoke failed", e)
            }
        }.start()
    }

    override fun onDestroy() {
        super.onDestroy()
        qqLoginPolling?.interrupt()
        qqLoginWebView?.destroy()
        sodaLoginPolling?.interrupt()
        sodaLoginWebView?.destroy()
        shellServer?.stop()
        shellServer = null
        webView.destroy()
    }
}
