package com.waveforge.android

import java.io.File
import java.io.FileInputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.util.concurrent.Executors

/**
 * Android 壳 HTTP 服务（HANDOVER §31 启动提速项）：
 *
 * - 占 127.0.0.1:3001，WebView 只加载本机地址；
 * - 静态请求直出 APK 内嵌 dist（磁盘解压目录 distFileDir，磁盘版优先、热更新生效），
 *   免去「等 Node 冷启 → 首屏白屏 56s」的完整链路；
 * - 非静态请求（/api 等动态路由）反代到 Node（3002，local-server.mjs），
 *   请求/响应全流式透传（Range 断点续传、SSE 等语义不变）；
 * - Node 未就绪时回 503 + `X-WaveForge-Engine-Starting: 1`，
 *   前端 main.tsx 全局 fetch 包装按此标记自动重试（首启解压期 90×800ms）。
 *
 * 鉴权：WebView 侧自行注入 `X-WaveForge-Local-Token` 头 / Cookie（MainActivity
 * shouldInterceptRequest 双通道），本服务透传即可；localToken 仅在转发请求缺失该头时
 * 兜底补上（前端旧版本或直接 curl 场景，与 Node 侧 local-service-auth 校验对齐）。
 *
 * 仅绑定回环地址：外部进程无法触达，token 只防 WebView 内被诱导发起的跨源调用。
 */
class ShellServer(
    @Suppress("unused") private val assets: android.content.res.AssetManager,
    private val distFileDir: File,
    private val localToken: String,
) {
    private var serverSocket: ServerSocket? = null
    @Volatile private var running = false
    private val pool = Executors.newCachedThreadPool { r ->
        Thread(r, "wf-shell-conn").apply { isDaemon = true }
    }

    fun start(port: Int) {
        if (running) return
        running = true
        val t = Thread({
            try {
                val socket = ServerSocket(port, 128, InetAddress.getByName("127.0.0.1"))
                serverSocket = socket
                while (running) {
                    val client = try {
                        socket.accept()
                    } catch (_: Exception) {
                        break // stop() 关闭 accept 或进程退出
                    }
                    pool.execute { handleClient(client) }
                }
            } catch (_: Exception) {
                // 端口被占等致命错误：main 进程仍在（Node 3002 独立可用），静默降级
            }
        }, "wf-shell-server")
        t.isDaemon = true
        t.start()
    }

    fun stop() {
        running = false
        try { serverSocket?.close() } catch (_: Exception) { /* ignore */ }
        serverSocket = null
        pool.shutdownNow()
    }

    // ---------- 连接处理 ----------

    private fun handleClient(client: Socket) {
        try {
            client.soTimeout = 30_000
            // 头与体共用同一条带缓冲流：分别用 char reader 与 raw stream 读会互相吃缓冲，
            // POST 请求体会被截坏（本机回环 + 二进制上传路径都从这条流顺序读）
            val input = client.getInputStream().buffered()
            val requestLine = readAsciiLine(input) ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0].uppercase()
            val rawTarget = parts[1]

            val headers = mutableMapOf<String, String>()
            var contentLength = 0L
            while (true) {
                val line = readAsciiLine(input) ?: break
                if (line.isEmpty()) break
                val idx = line.indexOf(':')
                if (idx > 0) {
                    val name = line.substring(0, idx).trim()
                    val value = line.substring(idx + 1).trim()
                    headers[name.lowercase()] = value
                    if (name.equals("content-length", true)) contentLength = value.toLongOrNull() ?: 0L
                }
            }
            // 请求体（POST/PUT）：从同一条流精确读 Content-Length 字节
            val body = ByteArray(contentLength.toInt().coerceAtMost(64 * 1024 * 1024))
            var read = 0
            while (read < body.size) {
                val n = input.read(body, read, body.size - read)
                if (n < 0) break
                read += n
            }

            val pathStart = rawTarget.indexOf('/')
            val rawPath = if (pathStart >= 0) rawTarget.substring(pathStart) else "/"
            val qIdx = rawPath.indexOf('?')
            val pathOnly = if (qIdx >= 0) rawPath.substring(0, qIdx) else rawPath

            if (isStaticPath(pathOnly, method)) {
                serveStatic(client, method, pathOnly)
            } else {
                proxy(client, method, rawTarget, headers, body)
            }
        } catch (_: SocketTimeoutException) {
            try { client.close() } catch (_: Exception) { /* ignore */ }
        } catch (_: Exception) {
            try { client.close() } catch (_: Exception) { /* ignore */ }
        }
    }

    /** 头部行读取（ISO-8859-1 字节语义，CRLF 结尾；本服务头均为 ASCII，够用） */
    private fun readAsciiLine(input: java.io.InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b == -1) return if (sb.isEmpty()) null else sb.toString()
            if (b == 13) { // \r
                val n = input.read()
                if (n != -1 && n != 10) sb.append(n.toChar()) // 非规范行尾：把字符退回语义上不存在，忽略
                return sb.toString()
            }
            sb.append(b.toChar())
        }
    }

    /** 静态判定：非 /api 的 GET/HEAD，且 dist 里存在对应文件（或 SPA 兜底 index.html） */
    private fun isStaticPath(path: String, method: String): Boolean {
        if (method != "GET" && method != "HEAD") return false
        if (path.startsWith("/api/") || path == "/api") return false
        if (path == "/" || path == "/index.html") return true
        return resolveDistFile(path) != null || !path.substringAfterLast('.', "").contains('/')
    }

    private fun resolveDistFile(path: String): File? {
        val decoded = try { URLDecoder.decode(path, "UTF-8") } catch (_: Exception) { return null }
        val clean = decoded.trimStart('/').replace('\\', '/')
        if (clean.isEmpty()) return null
        if (clean.contains("..") || clean.contains(':')) return null // 路径穿越防御
        val file = File(distFileDir, clean)
        val canonical = try { file.canonicalFile } catch (_: Exception) { return null }
        val rootCanonical = try { distFileDir.canonicalFile } catch (_: Exception) { return null }
        if (!canonical.path.startsWith(rootCanonical.path)) return null
        return if (canonical.isFile) canonical else null
    }

    private fun serveStatic(client: Socket, method: String, path: String) {
        // 精确文件命中 → 服务；无扩展名的前端路由 → SPA 兜底 index.html；
        // 带扩展名但缺失（如懒加载 chunk 404）→ 真实 404，不回退 HTML（JS 会解析报错）
        val file = resolveDistFile(path)
            ?: (if (path.substringAfterLast('.', "").contains('/') || !path.contains('.'))
                resolveDistFile("/index.html") else null)
        if (file == null) {
            respondSimple(client, 404, "text/plain; charset=utf-8", "not found", headOnly = method == "HEAD")
            return
        }
        try {
            val out = client.getOutputStream()
            val mime = guessMime(file.name)
            val head = buildString {
                append("HTTP/1.1 200 OK\r\n")
                append("Content-Type: $mime\r\n")
                append("Content-Length: ${file.length()}\r\n")
                append("Cache-Control: no-cache\r\n")
                append("Connection: close\r\n\r\n")
            }
            out.write(head.toByteArray(Charsets.ISO_8859_1))
            if (method != "HEAD") {
                FileInputStream(file).use { input -> input.copyTo(out, 64 * 1024) }
            }
            out.flush()
        } catch (_: Exception) { /* 客户端提前断开 */ } finally {
            try { client.close() } catch (_: Exception) { /* ignore */ }
        }
    }

    /** 全流式反代到 Node（3002）：请求头透传（补 token 头），响应原样回写（Range/SSE 兼容） */
    private fun proxy(client: Socket, method: String, rawTarget: String, headers: Map<String, String>, body: ByteArray) {
        val upstream = try {
            Socket(InetAddress.getByName("127.0.0.1"), 3002)
        } catch (_: Exception) {
            // Node 引擎未就绪：503 + 启动标记，前端 fetch 包装会自动重试
            respondSimple(
                client, 503, "text/plain; charset=utf-8",
                "engine starting", headOnly = method == "HEAD",
                extraHeaders = "X-WaveForge-Engine-Starting: 1\r\nRetry-After: 1\r\n",
            )
            return
        }
        try {
            val upstreamOut = upstream.getOutputStream()
            val requestHead = buildString {
                append("$method $rawTarget HTTP/1.1\r\n")
                append("Host: 127.0.0.1:3002\r\n")
                append("Connection: close\r\n")
                for ((name, value) in headers) {
                    if (name in setOf("host", "connection", "proxy-connection", "keep-alive",
                            "transfer-encoding", "upgrade", "expect")) continue
                    append("$name: $value\r\n")
                }
                if (localToken.isNotEmpty() && !headers.containsKey("x-waveforge-local-token")) {
                    append("X-WaveForge-Local-Token: $localToken\r\n")
                }
                if (body.isNotEmpty() && !headers.containsKey("content-length")) {
                    append("Content-Length: ${body.size}\r\n")
                }
                append("\r\n")
            }
            upstreamOut.write(requestHead.toByteArray(Charsets.ISO_8859_1))
            if (body.isNotEmpty()) upstreamOut.write(body)
            upstreamOut.flush()

            // 响应流式回写（上行流结束后由 read 返回 -1 自然收尾）
            val clientOut: OutputStream = client.getOutputStream()
            upstream.getInputStream().use { input ->
                input.copyTo(clientOut, 32 * 1024)
            }
            clientOut.flush()
        } catch (_: Exception) { /* 任一端断开 */ } finally {
            try { upstream.close() } catch (_: Exception) { /* ignore */ }
            try { client.close() } catch (_: Exception) { /* ignore */ }
        }
    }

    private fun respondSimple(
        client: Socket,
        status: Int,
        mime: String,
        bodyText: String,
        headOnly: Boolean,
        extraHeaders: String = "",
    ) {
        try {
            val out = client.getOutputStream()
            val body = bodyText.toByteArray(Charsets.UTF_8)
            val head = buildString {
                append("HTTP/1.1 $status ${reasonOf(status)}\r\n")
                append("Content-Type: $mime\r\n")
                append("Content-Length: ${body.size}\r\n")
                append(extraHeaders)
                append("Connection: close\r\n\r\n")
            }
            out.write(head.toByteArray(Charsets.ISO_8859_1))
            if (!headOnly) out.write(body)
            out.flush()
        } catch (_: Exception) { /* ignore */ } finally {
            try { client.close() } catch (_: Exception) { /* ignore */ }
        }
    }

    private fun reasonOf(status: Int) = when (status) {
        200 -> "OK"; 404 -> "Not Found"; 503 -> "Service Unavailable"; else -> "OK"
    }

    private fun guessMime(name: String) = when (name.substringAfterLast('.', "").lowercase()) {
        "html", "htm" -> "text/html; charset=utf-8"
        "js", "mjs" -> "text/javascript; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "json", "map" -> "application/json; charset=utf-8"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "svg" -> "image/svg+xml"
        "ico" -> "image/x-icon"
        "woff" -> "font/woff"
        "woff2" -> "font/woff2"
        "mp3" -> "audio/mpeg"
        "wav" -> "audio/wav"
        "webm" -> "video/webm"
        "mp4" -> "video/mp4"
        "wasm" -> "application/wasm"
        "txt" -> "text/plain; charset=utf-8"
        else -> "application/octet-stream"
    }
}
