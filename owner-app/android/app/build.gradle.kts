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

android {
    namespace = "com.cipherphantom.ownerapp"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.cipherphantom.ownerapp"
        minSdk = 24
        targetSdk = 34
        versionCode = ownerApkVersionCode
        versionName = "1.${ownerApkVersionCode}"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "OWNER_APP_URL", "\"$ownerAppUrl\"")
        buildConfigField("String", "OWNER_APP_FALLBACK_URL", "\"$ownerAppFallbackUrl\"")
        buildConfigField("String", "OWNER_UPDATE_URL", "\"$ownerUpdateUrl\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
