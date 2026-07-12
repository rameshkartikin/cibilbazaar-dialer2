plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.cibilbazaar.dialer"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.cibilbazaar.dialer"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    // Release signing reads from android/keystore.properties (NOT committed
    // to source control). Generate a keystore once with:
    //   keytool -genkeypair -v -keystore cibilbazaar-release.keystore \
    //     -alias cibilbazaar -keyalg RSA -keysize 2048 -validity 10000
    // Then create android/keystore.properties with:
    //   storeFile=../cibilbazaar-release.keystore
    //   storePassword=YOUR_STORE_PASSWORD
    //   keyAlias=cibilbazaar
    //   keyPassword=YOUR_KEY_PASSWORD
    val keystorePropsFile = rootProject.file("keystore.properties")
    val keystoreProps = java.util.Properties()
    if (keystorePropsFile.exists()) {
        keystoreProps.load(java.io.FileInputStream(keystorePropsFile))
    }

    signingConfigs {
        if (keystorePropsFile.exists()) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystorePropsFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        debug {
            isMinifyEnabled = false
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
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.lifecycle:lifecycle-service:2.8.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
