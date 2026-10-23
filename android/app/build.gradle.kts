plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
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

android {
    namespace = "com.waveforge.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.waveforge.android"
        // Android TV 设备普遍为 Android 9+（API 28），minSdk 24 已足够宽松。
        minSdk = 24
        targetSdk = 35
        versionName = appVersionName
        versionCode = versionCodeOf(appVersionName)

        externalNativeBuild {
            cmake {
                cppFlags("")
                // libnode.so 使用 libC++ STL 构建，必须使用 c++_shared 链接。
                arguments("-DANDROID_STL=c++_shared")
            }
        }

        ndk {
            // 绝大多数 Android TV 是 64 位 arm；加 x86_64 供电脑模拟器原生运行。
            // 正式发布可只保留 arm64 减体积。
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("CMakeLists.txt")
            version = "3.22.1"
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

    kotlinOptions {
        jvmTarget = "17"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // 签名：CI 从 Release keystore secret 注入（每次 runner 重新生成 debug
            // keystore 会让第二版起拒绝覆盖安装 → 用户必须卸载丢数据）。
            // 本地无 keystore 时回退 debug 签名（只影响本地侧载，不影响 CI 产物）。
            val releaseKeystorePath = System.getenv("WAVEFORGE_RELEASE_KEYSTORE")
                ?: (project.findProperty("waveforgeReleaseKeystore") as String?)
            val releaseKeystorePassword = System.getenv("WAVEFORGE_RELEASE_KEYSTORE_PASSWORD")
                ?: (project.findProperty("waveforgeReleaseKeystorePassword") as String?)
            val releaseKeystoreAlias = System.getenv("WAVEFORGE_RELEASE_KEYSTORE_ALIAS")
                ?: (project.findProperty("waveforgeReleaseKeystoreAlias") as String? ?: "waveforge")
            if (releaseKeystorePath != null && java.io.File(releaseKeystorePath).exists() && releaseKeystorePassword != null) {
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
