import java.util.Properties

plugins {
    id("com.android.application")
}

val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) {
        keystorePropsFile.inputStream().use { load(it) }
    }
}

android {
    namespace = "app.panda.tv"
    compileSdk = 37
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "app.panda.tv"
        minSdk = 22
        targetSdk = 34
        versionCode = 9
        versionName = "1.0.8"
    }

    androidResources {
        localeFilters += listOf("zh", "zh-rCN")
    }

    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }

    signingConfigs {
        create("release") {
            val store = keystoreProps.getProperty("storeFile")
            if (!store.isNullOrBlank()) {
                storeFile = rootProject.file(store)
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
            enableV1Signing = true
            enableV2Signing = true
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (keystorePropsFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    lint {
        checkReleaseBuilds = true
        abortOnError = true
        error.add("NewApi")
        fatal.add("NewApi")
        disable.add("MissingTvBanner")
        disable.add("VectorRaster")
    }

    packaging {
        resources {
            excludes += setOf(
                "DebugProbesKt.bin",
                "kotlin-tooling-metadata.json",
                "META-INF/*.version",
                "META-INF/androidx.*.version",
                "META-INF/kotlin-project-structure-metadata.json",
                "META-INF/com/android/build/gradle/**",
                "META-INF/version-control-info.textproto",
            )
        }
    }

    testOptions {
        unitTests.isIncludeAndroidResources = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)
    }
}

configurations.all {
    resolutionStrategy {
        force(
            "androidx.core:core:1.13.1",
            "androidx.annotation:annotation:1.8.1",
            "androidx.collection:collection:1.4.2",
            "androidx.recyclerview:recyclerview:1.3.2",
        )
    }
}

dependencies {
    implementation("androidx.media3:media3-exoplayer:1.8.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.8.1")
    implementation("androidx.leanback:leanback-grid:1.0.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    testImplementation("junit:junit:4.13.2")
}
