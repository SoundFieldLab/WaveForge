// WaveForge Android (TV/平板) 根构建脚本。
// 版本组合：AGP 8.13.0 + Gradle 9.1.0（wrapper）+ Kotlin 2.1.20。
// 若本机 JDK 过新导致构建异常，请安装 JDK 17/21 并设置 JAVA_HOME 后再构建。
plugins {
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.1.20" apply false
}
