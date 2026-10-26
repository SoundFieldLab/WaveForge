import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}

// versionCode 与 versionName 统一推导：0.2.0 → 200（发布脚本使用同一规则，避免漂移）。
fun versionCodeOf(version: String): Int {
    val parts = version.split('.').map { it.toIntOrNull() ?: 0 }
    val major = parts.getOrElse(0) { 0 }
    val minor = parts.getOrElse(1) { 0 }
    val patch = parts.getOrElse(2) { 0 }
    return major * 10000 + minor * 100 + patch
}

val appVersionName = "0.1.5"

// 内嵌 Python（Chaquopy 17）：节拍分析（AutoMix）等 PC 端 Python 能力上移动端。
// 构建机 PATH 需有同版本 python（本机 D:\Python = 3.13.x）。先验证 numpy 科学计算栈，
// beat 分析器（librosa 精简移植，numba-free）后续接入。Python 源码默认 src/main/python。
chaquopy {
    defaultConfig {
        version = "3.13"
        pip {
            install("numpy")
        }
    }
}

android {
    namespace = "com.waveforge.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.waveforge.android"
        // Android TV 设备普遍为 Android 9+（API 28），minSdk 24 已足够宽松。
        minSdk = 24
        targetSdk = 35
        versionName = appVersionName
        // ⚠️ vivo 等 ROM 的安装器对「同 packageName + 同 versionCode」的覆盖安装会
        // 直接复用缓存旧 APK（实测：pm install 返回 Success，但设备端 base.apk 字节
        // 与新包不同、跑的是旧代码）——这是「改了代码真机毫无变化」的元凶。
        // 用分钟级时间戳做 versionCode，保证每次构建唯一且单调
        // （≈2.9e7，远小于上限 21 亿；OTA 版本比较仍然成立）。
        versionCode = (System.currentTimeMillis() / 60_000L).toInt()

        ndk {
            // 绝大多数 Android TV 是 64 位 arm；加 x86_64 供电脑模拟器原生运行。
            // 正式发布可只保留 arm64 减体积。
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    sourceSets {
        getByName("main") {
            // 原生库全部预置（app/libnode/bin/<abi>/）：libnode.so（nodejs-mobile）、
            // libnative-lib.so（JNI 壳，源码见 app/src/main/cpp + CMakeLists.txt）、
            // libc++_shared.so（NDK 27 STL）。不使用 externalNativeBuild：
            // Chaquopy 17.1（2026-10）与 AGP externalNativeBuild 的 jniLibs 合并有回归
            // （CMake 产物被丢弃 → libnative-lib/libc++_shared 不进 APK，启动
            // UnsatisfiedLinkError）。需要改 C++ 时：临时恢复 externalNativeBuild 块
            // 构建，再把 obj/<abi>/libnative-lib.so 拷回 libnode/bin/<abi>/。
            jniLibs.srcDirs("libnode/bin/")
        }
    }

    sourceSets {
        getByName("main") {
            // 预编译的 libnode.so 按 ABI 放在 app/libnode/bin/<abi>/ 下。
            jniLibs.srcDirs("libnode/bin/")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // Kotlin 2.x：kotlinOptions 已弃用（AGP 8.13 起 DSL 编译报错），迁移到 compilerOptions
    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // 签名（优先级）：CI 环境变量 > local.properties（本地侧载用，不入库）> 无签名。
            // 本地 keystore：android/waveforge-local.jks（scripts 生成，.gitignore 已排除）——
            // debug 包会触发 Android 15 的 16KB 对齐警告弹窗 + 性能差，日常真机一律装 release。
            fun localProp(key: String): String? {
                val props = Properties()
                val f = rootProject.file("local.properties")
                if (f.exists()) f.inputStream().use { stream -> props.load(stream) }
                return props.getProperty(key)
            }
            val releaseKeystorePath = System.getenv("WAVEFORGE_RELEASE_KEYSTORE")
                ?: (project.findProperty("waveforgeReleaseKeystore") as String?)
                ?: localProp("waveforgeReleaseKeystore")?.let { rootProject.file(it).absolutePath }
            val releaseKeystorePassword = System.getenv("WAVEFORGE_RELEASE_KEYSTORE_PASSWORD")
                ?: (project.findProperty("waveforgeReleaseKeystorePassword") as String?)
                ?: localProp("waveforgeReleaseKeystorePassword")
            val releaseKeystoreAlias = System.getenv("WAVEFORGE_RELEASE_KEYSTORE_ALIAS")
                ?: (project.findProperty("waveforgeReleaseKeystoreAlias") as String?)
                ?: localProp("waveforgeReleaseKeystoreAlias")
                ?: "waveforge"
            if (releaseKeystorePath != null && File(releaseKeystorePath).exists() && releaseKeystorePassword != null) {
                signingConfig = signingConfigs.create("release") {
                    storeFile = file(releaseKeystorePath)
                    storePassword = releaseKeystorePassword
                    keyAlias = releaseKeystoreAlias
                    keyPassword = releaseKeystorePassword
                }
            }
        }
    }

    ndkVersion = "27.0.12077973"
}

dependencies {
    // FileProvider（APK 安装用，Android 7+ 不允许 file:// 分享安装包）
    implementation("androidx.core:core-ktx:1.13.1")
}
