import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// リリース署名の設定。android/keystore.properties (git 管理外) か環境変数から読む。
// 揃っていなければ署名しない (デバッグビルドや CI は鍵なしで今までどおり動く)
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.isFile) file.inputStream().use { load(it) }
}

fun releaseSigningValue(propertyKey: String, envKey: String): String? =
    (keystoreProperties.getProperty(propertyKey) ?: System.getenv(envKey))?.takeIf { it.isNotBlank() }

val releaseStoreFile = releaseSigningValue("storeFile", "ANDROID_RELEASE_STORE_FILE")
val releaseStorePassword = releaseSigningValue("storePassword", "ANDROID_RELEASE_STORE_PASSWORD")
val releaseKeyAlias = releaseSigningValue("keyAlias", "ANDROID_RELEASE_KEY_ALIAS")
val releaseKeyPassword = releaseSigningValue("keyPassword", "ANDROID_RELEASE_KEY_PASSWORD")
val releaseSigningValues = listOf(releaseStoreFile, releaseStorePassword, releaseKeyAlias, releaseKeyPassword)
val hasReleaseSigning = releaseSigningValues.all { it != null }
if (!hasReleaseSigning && releaseSigningValues.any { it != null }) {
    logger.warn("リリース署名の設定が一部しかないため、release は署名せずにビルドします")
}

android {
    namespace = "com.syncgooglehealth.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.syncgooglehealth.app"
        minSdk = 34
        targetSdk = 36
        versionCode = 2
        versionName = "1.1.0"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                // 相対パスは android/ からの位置として扱う
                storeFile = rootProject.file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.activity.compose)
    implementation(libs.health.connect)
    implementation(libs.work.runtime)
    implementation(libs.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.coroutines.android)

    testImplementation(libs.junit)
}
