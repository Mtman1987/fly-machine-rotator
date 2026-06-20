const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withMainApplication,
  withSettingsGradle
} = require("@expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const META_MAVEN = "https://maven.pkg.github.com/facebook/meta-wearables-dat-android";
const PACKAGE_NAME = "live.spacemountain.mountainviewai.meta";

function withMetaWearablesAndroid(config, props = {}) {
  const mwdatVersion = props.mwdatVersion || "0.7.0";
  const applicationId = props.applicationId || "${MOUNTAINVIEW_META_APP_ID}";
  const analyticsOptOut = props.analyticsOptOut !== false;

  config = withSettingsGradle(config, (mod) => {
    if (!mod.modResults.contents.includes(META_MAVEN)) {
      mod.modResults.contents = mod.modResults.contents.replace(
        /dependencyResolutionManagement\s*\{/,
        `dependencyResolutionManagement {\n  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)\n  repositories {\n    google()\n    mavenCentral()\n    maven {\n      url = uri("${META_MAVEN}")\n      credentials {\n        username = ""\n        password = System.getenv("GITHUB_TOKEN") ?: providers.gradleProperty("github_token").orNull\n      }\n    }\n  }`
      );
    }
    return mod;
  });

  config = withAppBuildGradle(config, (mod) => {
    const lines = [
      `implementation("com.meta.wearable:mwdat-core:${mwdatVersion}")`,
      `implementation("com.meta.wearable:mwdat-camera:${mwdatVersion}")`,
      `debugImplementation("com.meta.wearable:mwdat-mockdevice:${mwdatVersion}")`
    ];
    for (const line of lines) {
      if (!mod.modResults.contents.includes(line)) {
        mod.modResults.contents = mod.modResults.contents.replace(/dependencies\s*\{/, `dependencies {\n    ${line}`);
      }
    }
    return mod;
  });

  config = withAndroidManifest(config, (mod) => {
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    mainApplication["meta-data"] = mainApplication["meta-data"] || [];
    upsertMetaData(mainApplication, "com.meta.wearable.mwdat.APPLICATION_ID", applicationId);
    upsertMetaData(mainApplication, "com.meta.wearable.mwdat.ANALYTICS_OPT_OUT", String(analyticsOptOut));
    return mod;
  });

  config = withMainApplication(config, (mod) => {
    if (!mod.modResults.contents.includes("MountainViewMetaWearablesPackage")) {
      mod.modResults.contents = mod.modResults.contents
        .replace(/^import /m, `import ${PACKAGE_NAME}.MountainViewMetaWearablesPackage\nimport `)
        .replace(
          /PackageList\(this\)\.packages/,
          `PackageList(this).packages.apply { add(MountainViewMetaWearablesPackage()) }`
        );
    }
    return mod;
  });

  config = withDangerousMod(config, ["android", (mod) => {
    const appPackage = config.android?.package || "live.spacemountain.mountainviewai";
    const baseDir = path.join(mod.modRequest.platformProjectRoot, "app", "src", "main", "java", ...PACKAGE_NAME.split("."));
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, "MountainViewMetaWearablesModule.kt"), renderModule(appPackage));
    fs.writeFileSync(path.join(baseDir, "MountainViewMetaWearablesPackage.kt"), renderPackage());
    return mod;
  }]);

  return config;
}

function upsertMetaData(application, name, value) {
  const items = application["meta-data"];
  const existing = items.find((item) => item.$["android:name"] === name);
  if (existing) {
    existing.$["android:value"] = value;
    return;
  }
  items.push({ $: { "android:name": name, "android:value": value } });
}

function renderPackage() {
  return `package ${PACKAGE_NAME}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class MountainViewMetaWearablesPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): MutableList<NativeModule> =
    mutableListOf(MountainViewMetaWearablesModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): MutableList<ViewManager<*, *>> =
    mutableListOf()
}
`;
}

function renderModule(appPackage) {
  return `package ${PACKAGE_NAME}

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeMap

class MountainViewMetaWearablesModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "MountainViewMetaWearables"

  @ReactMethod
  fun getSdkStatus(promise: Promise) {
    val result = WritableNativeMap()
    result.putBoolean("androidNativeBridge", true)
    result.putString("packageName", "${appPackage}")
    result.putString("sdk", "Meta Wearables Device Access Toolkit")
    result.putString("state", "installed-not-bound")
    result.putString("note", "Native module shell is installed. Next step is binding registration/session/camera APIs after Gradle resolves the DAT artifacts with GITHUB_TOKEN.")
    result.putBoolean("flashControlSupported", false)
    promise.resolve(result)
  }

  @ReactMethod
  fun startRegistration(promise: Promise) {
    promise.reject("MWDAT_NOT_BOUND", "Meta DAT registration is not bound yet. Configure MOUNTAINVIEW_META_APP_ID and GITHUB_TOKEN, run Android prebuild, then wire DAT registration APIs.")
  }

  @ReactMethod
  fun capturePhoto(promise: Promise) {
    promise.reject("MWDAT_NOT_BOUND", "Photo capture needs DAT Camera API binding after package resolution.")
  }

  @ReactMethod
  fun startAudioStream(promise: Promise) {
    promise.reject("MWDAT_NOT_BOUND", "Audio streaming needs DAT/session API binding after package resolution. Route audio events to StreamWeaver or HearMeOut through MountainView commands.")
  }

  @ReactMethod
  fun startVideoStream(promise: Promise) {
    promise.reject("MWDAT_NOT_BOUND", "Video streaming needs DAT Camera API binding after package resolution.")
  }

  @ReactMethod
  fun setFlashlight(enabled: Boolean, promise: Promise) {
    promise.reject("MWDAT_UNSUPPORTED", "Current public DAT Android setup does not document glasses flash/torch control.")
  }
}
`;
}

module.exports = createRunOncePlugin(withMetaWearablesAndroid, "withMetaWearablesAndroid", "0.1.0");
