import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) {
        f.inputStream().use { load(it) }
    }
}
val ownerAppUrl = (localProps.getProperty("OWNER_APP_URL") ?: "http://192.168.0.100:8787").trim()
val ownerAppFallbackUrl = (localProps.getProperty("OWNER_APP_FALLBACK_URL") ?: "").trim()
val ownerUpdateUrl = (localProps.getProperty("OWNER_UPDATE_URL") ?: "").trim()
val ownerApkVersionCode = (localProps.getProperty("OWNER_APK_VERSION_CODE") ?: "1").trim().toIntOrNull()?.coerceAtLeast(1) ?: 1
val ownerVersionName = (localProps.getProperty("OWNER_APP_VERSION_NAME") ?: "1.0.$ownerApkVersionCode").trim()
val releaseKeystoreFile = (localProps.getProperty("OWNER_KEYSTORE_FILE") ?: "").trim()
val releaseKeystorePassword = (localProps.getProperty("OWNER_KEYSTORE_PASSWORD") ?: "").trim()
val releaseKeyAlias = (localProps.getProperty("OWNER_KEY_ALIAS") ?: "").trim()
val releaseKeyPassword = (localProps.getProperty("OWNER_KEY_PASSWORD") ?: "").trim()
val hasReleaseSigning = releaseKeystoreFile.isNotBlank() &&
    releaseKeystorePassword.isNotBlank() &&
    releaseKeyAlias.isNotBlank() &&
    releaseKeyPassword.isNotBlank()

android {
    namespace = "com.cipherphantom.ownerapp"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.cipherphantom.ownerapp"
        minSdk = 24
        targetSdk = 34
        versionCode = ownerApkVersionCode
        versionName = ownerVersionName

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "OWNER_APP_URL", "\"$ownerAppUrl\"")
        buildConfigField("String", "OWNER_APP_FALLBACK_URL", "\"$ownerAppFallbackUrl\"")
        buildConfigField("String", "OWNER_UPDATE_URL", "\"$ownerUpdateUrl\"")
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseKeystoreFile)
                storePassword = releaseKeystorePassword
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
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
}
