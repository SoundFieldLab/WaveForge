package com.waveforge.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.webkit.WebView
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.net.HttpURLConnection
import java.net.URL

/**
 * 播放常驻前台服务（HANDOVER §31 防杀后台项）：
 *
 * - type=mediaPlayback：播放中把进程 adj 提到 FOREGROUND，避免 vivo 等 ROM
 *   在切后台后直接清理进程；暂停/停止时撤销通知并停服务；
 * - 通知挂 MediaStyle + MediaSession：锁屏/通知栏展示 曲名/歌手/封面/进度，
 *   耳机/蓝牙媒体按钮经 MediaSessionCallback 回发 WebView（JS 端可监听
 *   `waveforge:media-transport` 事件接管；未监听时按钮为安全 no-op）。
 *
 * JS 桥（MainActivity WaveForgeNative）：
 * - setPlaybackActive(true/false) → start()/stop()
 * - updatePlaybackInfo(...) → update()（字段可空 = 保持旧值；封面 URL 后台下载）
 */
class PlaybackService : Service() {

    companion object {
        /** 主 WebView 引用：媒体按钮回发 JS 用（MainActivity 每次桥调用时刷新） */
        @JvmStatic
        @Volatile
        var mainWebViewRef: WebView? = null

        @Volatile private var active = false
        @Volatile private var session: MediaSessionCompat? = null

        private const val CHANNEL_ID = "waveforge_playback"
        private const val NOTIFICATION_ID = 0x5746 // 'WF'
        private const val ACTION_TOGGLE = "com.waveforge.android.action.TOGGLE"
        private const val ACTION_STOP = "com.waveforge.android.action.STOP"

        // 最近一次元数据（update 的可空字段 = 保持旧值）
        @Volatile private var lastTitle: String? = null
        @Volatile private var lastArtist: String? = null
        @Volatile private var lastCoverUrl: String? = null
        @Volatile private var lastDurationMs: Long = 0
        @Volatile private var lastPositionMs: Long = 0
        @Volatile private var lastPlaying: Boolean = false
        @Volatile private var lastCoverBitmap: android.graphics.Bitmap? = null

        fun start(context: Context) {
            active = true
            val intent = Intent(context, PlaybackService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            active = false
            try {
                session?.isActive = false
            } catch (_: Exception) { /* ignore */ }
            try {
                context.stopService(Intent(context, PlaybackService::class.java))
            } catch (_: Exception) { /* ignore */ }
        }

        /**
         * 元数据更新。字段可空 = 保持旧值；playing 可空 = 不改变播放态。
         * 服务未运行时只缓存（下次 start 的通知直接带上最新数据）。
         */
        fun update(
            context: Context,
            title: String?, artist: String?, coverUrl: String?,
            durationMs: Long, positionMs: Long, playing: Boolean?,
        ) {
            if (!title.isNullOrBlank()) lastTitle = title
            if (!artist.isNullOrBlank()) lastArtist = artist
            if (coverUrl != null && coverUrl.isNotBlank() && coverUrl != lastCoverUrl) {
                lastCoverUrl = coverUrl
                lastCoverBitmap = null // 换封面：后台异步重新下载
            }
            if (durationMs > 0) lastDurationMs = durationMs
            if (positionMs >= 0) lastPositionMs = positionMs
            if (playing != null) lastPlaying = playing

            if (active) {
                updateSessionPlaybackState()
                refreshNotification(context)
            }
        }

        private fun updateSessionPlaybackState() {
            val s = session ?: return
            try {
                val state = if (lastPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
                s.setPlaybackState(
                    PlaybackStateCompat.Builder()
                        .setActions(
                            PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
                                PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_SEEK_TO or
                                PlaybackStateCompat.ACTION_SKIP_TO_NEXT or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                        )
                        .setState(state, lastPositionMs, if (lastPlaying) 1f else 0f)
                        .build()
                )
            } catch (_: Exception) { /* ignore */ }
        }

        private fun updateSessionMetadata() {
            val s = session ?: return
            try {
                val md = MediaMetadataCompat.Builder()
                    .putString(MediaMetadataCompat.METADATA_KEY_TITLE, lastTitle ?: "WaveForge")
                    .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, lastArtist ?: "")
                    .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, lastDurationMs)
                lastCoverBitmap?.let { md.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) }
                s.setMetadata(md.build())
            } catch (_: Exception) { /* ignore */ }
        }

        private fun refreshNotification(context: Context) {
            try {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.notify(NOTIFICATION_ID, buildNotification(context))
            } catch (_: Exception) { /* ignore */ }
        }

        private fun buildNotification(context: Context): Notification {
            val toggleIntent = PendingIntent.getService(
                context, 1,
                Intent(context, PlaybackService::class.java).setAction(ACTION_TOGGLE),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val stopIntent = PendingIntent.getService(
                context, 2,
                Intent(context, PlaybackService::class.java).setAction(ACTION_STOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val toggleTitle = if (lastPlaying) "暂停" else "播放"
            val toggleIcon = if (lastPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play

            val openAppIntent = PendingIntent.getActivity(
                context, 3,
                context.packageManager.getLaunchIntentForPackage(context.packageName)
                    ?: Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            return NotificationCompat.Builder(context, CHANNEL_ID)
                .setContentTitle(lastTitle ?: "WaveForge 澜音工坊")
                .setContentText(lastArtist ?: "播放中")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(openAppIntent)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .addAction(toggleIcon, toggleTitle, toggleIntent)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "退出", stopIntent)
                .setStyle(
                    androidx.media.app.NotificationCompat.MediaStyle()
                        .setMediaSession(session?.sessionToken)
                        .setShowActionsInCompactView(0)
                )
                .also { builder ->
                    lastCoverBitmap?.let { builder.setLargeIcon(it) }
                }
                .build()
        }

        private fun loadCoverAsync(context: Context) {
            val url = lastCoverUrl ?: return
            Thread {
                try {
                    val conn = URL(url).openConnection() as HttpURLConnection
                    conn.connectTimeout = 8000
                    conn.readTimeout = 8000
                    conn.setRequestProperty("User-Agent", "WaveForge-Android")
                    val bitmap = BitmapFactory.decodeStream(conn.inputStream)
                    conn.disconnect()
                    if (bitmap != null && url == lastCoverUrl) {
                        lastCoverBitmap = bitmap
                        updateSessionMetadata()
                        if (active) refreshNotification(context)
                    }
                } catch (_: Exception) { /* 封面下载失败不影响播放 */ }
            }.start()
        }

        /** 媒体按钮 → WebView 内派发自定义事件（JS 端按需接管；未监听 = 安全 no-op） */
        private fun dispatchTransport(action: String) {
            val webView = mainWebViewRef ?: return
            webView.post {
                try {
                    webView.evaluateJavascript(
                        "try{window.dispatchEvent(new CustomEvent('waveforge:media-transport',{detail:'$action'}))}catch(e){}",
                        null,
                    )
                } catch (_: Exception) { /* WebView 已销毁 */ }
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "播放状态", NotificationManager.IMPORTANCE_LOW).apply {
                        setShowBadge(false)
                    }
                )
            }
        }
        session = MediaSessionCompat(this, "WaveForgePlayback").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = dispatchTransport("play")
                override fun onPause() = dispatchTransport("pause")
                override fun onSkipToNext() = dispatchTransport("next")
                override fun onSkipToPrevious() = dispatchTransport("previous")
            })
            isActive = true
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_TOGGLE -> dispatchTransport(if (lastPlaying) "pause" else "play")
        }

        val notification = buildNotification(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        updateSessionMetadata()
        updateSessionPlaybackState()
        loadCoverAsync(this)
        return START_STICKY
    }

    override fun onDestroy() {
        try { session?.release() } catch (_: Exception) { /* ignore */ }
        session = null
        super.onDestroy()
    }
}
