package com.waveforge.android

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.PI
import kotlin.math.sin

/**
 * TV 端全屏启动动画，与 Win 端 splash（desktop/splash.html）同风格：
 * 多彩旋转渐变背景 + 应用 Logo + 渐变 "WaveForge" 文字 + 多彩音波条。
 * 后端就绪后由 MainActivity 淡出移除。
 */
class SplashView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    private val dot = resources.displayMetrics.density

    // 多彩渐变（与 Win 端 splash 同色板）
    private val GRADIENT_COLORS = intArrayOf(
        Color.parseColor("#FF6B6B"),
        Color.parseColor("#FFB347"),
        Color.parseColor("#FFE66D"),
        Color.parseColor("#4ECDC4"),
        Color.parseColor("#5B9FFF"),
        Color.parseColor("#A78BFA"),
        Color.parseColor("#EC4899"),
        Color.parseColor("#FF6B6B"),
    )
    // 音波条颜色（Win 端 12 根循环）
    private val WAVE_COLORS = intArrayOf(
        Color.parseColor("#FF6B6B"),
        Color.parseColor("#FFB347"),
        Color.parseColor("#FFE66D"),
        Color.parseColor("#4ECDC4"),
        Color.parseColor("#5B9FFF"),
        Color.parseColor("#A78BFA"),
        Color.parseColor("#EC4899"),
        Color.parseColor("#FF6B6B"),
        Color.parseColor("#FFB347"),
        Color.parseColor("#FFE66D"),
        Color.parseColor("#4ECDC4"),
        Color.parseColor("#5B9FFF"),
    )

    private val gradientPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val wavePaints: List<Paint> = WAVE_COLORS.map { color ->
        Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 54 * dot
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        textAlign = Paint.Align.CENTER
    }

    // Win 端 Logo 图片
    private val logoBitmap = runCatching {
        BitmapFactory.decodeResource(resources, R.drawable.wf_splash_logo)
    }.getOrNull()

    // 持续递增的起始时间（elapsed 驱动动画，入场只播一次、背景/浮动连贯）
    private var startTime = 0L

    private val animator = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 4000
        repeatCount = ValueAnimator.INFINITE
        interpolator = LinearInterpolator()
        addUpdateListener { invalidate() }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        startTime = android.os.SystemClock.elapsedRealtime()
        animator.start()
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        animator.cancel()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        val cx = w / 2f
        // 用持续递增的 elapsed（毫秒）代替循环 progress：入场只播一次，背景/浮动连贯不"从头播放"
        val elapsed = android.os.SystemClock.elapsedRealtime() - startTime
        val t = elapsed / 1000f // 秒

        // 入场：前 1.2s 一次性上移淡入（参照 Win 端 splashEnter 位移入场）
        val enter = minOf(1f, elapsed / 1200f)
        val eased = enter * enter * (3f - 2f * enter)
        val alpha = (eased * 255).toInt()
        val enterY = (1f - eased) * 30 * dot

        // 1) 多彩旋转渐变背景：15s 匀速旋转一整圈（elapsed 递增不取模，旋转平滑无跳变）
        canvas.save()
        canvas.rotate(t / 15f * 360f, cx, h / 2f)
        val bgSize = maxOf(w, h) * 2f
        val bgLeft = cx - bgSize / 2f
        val bgTop = h / 2f - bgSize / 2f
        gradientPaint.shader = LinearGradient(
            bgLeft, bgTop, bgLeft + bgSize, bgTop + bgSize,
            GRADIENT_COLORS, null, Shader.TileMode.CLAMP,
        )
        gradientPaint.alpha = (0.18f * alpha).toInt()
        canvas.drawRect(bgLeft, bgTop, bgLeft + bgSize, bgTop + bgSize, gradientPaint)
        canvas.restore()

        // 2) Logo 图片（圆角方形 + 浮动 + 阴影）
        val logoSize = 130 * dot * (0.94f + 0.06f * eased)
        val logoY = h * 0.30f - logoSize / 2f + enterY + sin(t / 3f * PI * 2).toFloat() * 6f * dot
        if (logoBitmap != null) {
            canvas.save()
            canvas.translate(cx, logoY)
            canvas.rotate(sin(t / 4f * PI * 2).toFloat() * 1.5f)
            // 柔和阴影（PC 端 box-shadow 风格）：用 ShadowLayer 大范围模糊，不做偏移实心块
            val logoPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply {
                this.alpha = alpha
                setShadowLayer(24 * dot, 0f, 10 * dot, Color.argb((0.45f * alpha).toInt(), 0, 0, 0))
            }
            // 圆角裁剪绘制（PC 端 border-radius 28px/120px 比例）
            val radius = logoSize * 0.23f
            val saveCount = canvas.saveLayer(-logoSize / 2f, -logoSize / 2f, logoSize / 2f, logoSize / 2f, null)
            val clip = android.graphics.Path().apply {
                addRoundRect(
                    -logoSize / 2f, -logoSize / 2f, logoSize / 2f, logoSize / 2f,
                    radius, radius, android.graphics.Path.Direction.CW,
                )
            }
            canvas.clipPath(clip)
            canvas.drawBitmap(
                logoBitmap, null,
                android.graphics.RectF(-logoSize / 2f, -logoSize / 2f, logoSize / 2f, logoSize / 2f),
                logoPaint,
            )
            canvas.restoreToCount(saveCount)
            canvas.restore()
        }

        // 3) "WaveForge" 渐变文字（文字颜色渐变随背景色板滑动）
        val textY = h * 0.42f + enterY
        textPaint.alpha = alpha
        val shimmerOffset = ((t / 3f) % 1f) * 400f
        textPaint.shader = LinearGradient(
            cx - 200f + shimmerOffset, 0f, cx + 200f + shimmerOffset, 0f,
            GRADIENT_COLORS.copyOf(GRADIENT_COLORS.size - 1), null, Shader.TileMode.REPEAT,
        )
        canvas.drawText("WaveForge", cx, textY, textPaint)
        textPaint.shader = null

        // 4) 多彩音波条（12 根，高度/相位错开，参照 Win 端 wave-bar）
        val barY = h * 0.62f + enterY
        val barW = 8 * dot
        val gap = 22 * dot
        val maxH = 64 * dot
        for (i in WAVE_COLORS.indices) {
            val phase = t / 1.4f * PI * 2 + i * 0.6
            val amp = (0.5 + 0.5 * sin(phase)).toFloat()
            val bh = (14 + (maxH - 14) * amp) * (if (i % 2 == 0) 1f else 0.85f)
            val x = cx + (i - WAVE_COLORS.size / 2f + 0.5f) * gap
            wavePaints[i].alpha = alpha
            canvas.drawRoundRect(
                x - barW / 2f, barY - bh / 2f, x + barW / 2f, barY + bh / 2f,
                4 * dot, 4 * dot, wavePaints[i],
            )
        }
    }
}
