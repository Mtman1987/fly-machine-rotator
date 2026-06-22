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
  const enableMetaDat = props.enableMetaDat === true;

  if (enableMetaDat) {
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
  }

  config = withAndroidManifest(config, (mod) => {
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    mainApplication["meta-data"] = mainApplication["meta-data"] || [];
    if (enableMetaDat) {
      upsertMetaData(mainApplication, "com.meta.wearable.mwdat.APPLICATION_ID", applicationId);
      upsertMetaData(mainApplication, "com.meta.wearable.mwdat.ANALYTICS_OPT_OUT", String(analyticsOptOut));
    }
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
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import android.view.KeyEvent
import java.util.Locale
import java.util.UUID

class MountainViewMetaWearablesModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext), PermissionListener {
  private var pendingPermissionPromise: Promise? = null
  private var pendingPermissionLabel: String = "permissions"
  private val mainHandler = Handler(Looper.getMainLooper())
  private val discoveredDevices = linkedMapOf<String, WritableNativeMap>()
  private val researchLog = mutableListOf<String>()
  private val mediaButtonLog = mutableListOf<String>()
  private var activeGatt: BluetoothGatt? = null
  private var mediaSession: MediaSession? = null
  private var speechRecognizer: SpeechRecognizer? = null
  private var speechPromise: Promise? = null
  private val pendingDescriptorWrites = ArrayDeque<PendingDescriptorWrite>()
  private var descriptorWriteInFlight = false

  override fun getName(): String = "MountainViewMetaWearables"

  @ReactMethod
  fun getSdkStatus(promise: Promise) {
    val result = WritableNativeMap()
    result.putBoolean("androidNativeBridge", true)
    result.putString("packageName", "${appPackage}")
    result.putString("sdk", "Meta Wearables Device Access Toolkit")
    result.putString("state", "installed-plus-rdglass-research")
    result.putString("note", "Native module shell is installed. Meta DAT binding is SDK-gated; generic BLE research mode can scan AiMB/RDGlass devices and discover GATT services.")
    result.putBoolean("flashControlSupported", false)
    result.putBoolean("wakePhraseSupported", false)
    result.putString("wakePhraseNote", "Android can request microphone/foreground-service permissions, but always-on custom wake phrases require a foreground service or vendor SDK support.")
    result.putString("rdGlassPackage", "com.rd.rdglass")
    result.putString("rdGlassVersionObserved", "1.2.6")
    result.putString("rdGlassAudioHint", "16 kHz mono PCM voice events were observed in the exported RDGlass assets.")
    result.putString("genericBleHint", "Look for AiMB/RDGlass/MA08/MA15 devices and Nordic UART-like UUIDs 6E40AB01/02/03-B5A3-F393-E0A9-E50E24DCCA9E.")
    result.putBoolean("mediaButtonCommandModeSupported", true)
    result.putString("mediaButtonNote", "Glasses media/headset buttons can be captured while MountainView command mode owns an Android MediaSession.")
    promise.resolve(result)
  }

  @ReactMethod
  fun addListener(eventName: String) {
  }

  @ReactMethod
  fun removeListeners(count: Int) {
  }

  @ReactMethod
  fun startMediaButtonCommandMode(promise: Promise) {
    try {
      val session = mediaSession ?: MediaSession(reactContext, "MountainViewAiGlassesCommand").also { mediaSession = it }
      session.setCallback(object : MediaSession.Callback() {
        override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
          val keyEvent = if (Build.VERSION.SDK_INT >= 33) {
            mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
          } else {
            @Suppress("DEPRECATION")
            mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
          }
          if (keyEvent != null) {
            recordMediaButton("media-button", keyEvent.keyCode, keyEvent.action, keyEvent.repeatCount)
          }
          return true
        }

        override fun onPlay() {
          recordMediaButton("media-session-play", KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.ACTION_DOWN, 0)
        }

        override fun onPause() {
          recordMediaButton("media-session-pause", KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.ACTION_DOWN, 0)
        }

        override fun onSkipToNext() {
          recordMediaButton("media-session-next", KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.ACTION_DOWN, 0)
        }

        override fun onSkipToPrevious() {
          recordMediaButton("media-session-previous", KeyEvent.KEYCODE_MEDIA_PREVIOUS, KeyEvent.ACTION_DOWN, 0)
        }
      })
      session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS)
      session.setPlaybackState(
        PlaybackState.Builder()
          .setActions(
            PlaybackState.ACTION_PLAY or
              PlaybackState.ACTION_PAUSE or
              PlaybackState.ACTION_PLAY_PAUSE or
              PlaybackState.ACTION_SKIP_TO_NEXT or
              PlaybackState.ACTION_SKIP_TO_PREVIOUS
          )
          .setState(PlaybackState.STATE_PLAYING, 0L, 1.0f)
          .build()
      )
      session.isActive = true
      appendMediaButtonLog("command mode active")
      val result = WritableNativeMap()
      result.putBoolean("androidNativeBridge", true)
      result.putString("state", "media-button-command-mode-active")
      result.putString("note", "Press play/pause or headset buttons on the glasses while MountainView is active. Events are logged and emitted to React Native.")
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("MEDIA_BUTTON_MODE_FAILED", error.message ?: "Could not start media button command mode.")
    }
  }

  @ReactMethod
  fun stopMediaButtonCommandMode(promise: Promise) {
    mediaSession?.isActive = false
    appendMediaButtonLog("command mode inactive")
    val result = WritableNativeMap()
    result.putBoolean("androidNativeBridge", true)
    result.putString("state", "media-button-command-mode-inactive")
    promise.resolve(result)
  }

  @ReactMethod
  fun getMediaButtonLog(promise: Promise) {
    val result = WritableNativeMap()
    result.putBoolean("androidNativeBridge", true)
    result.putString("state", "media-button-log")
    result.putArray("entries", stringArray(mediaButtonLog.takeLast(160)))
    promise.resolve(result)
  }

  @ReactMethod
  fun requestVoiceWakePermissions(promise: Promise) {
    requestPermissions(promise, "voice", voicePermissions())
  }

  @ReactMethod
  fun recognizeSpeechOnce(promise: Promise) {
    if (reactContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      promise.reject("VOICE_PERMISSION_REQUIRED", "Grant microphone permission before speech recognition.")
      return
    }
    if (!SpeechRecognizer.isRecognitionAvailable(reactContext)) {
      promise.reject("SPEECH_RECOGNIZER_UNAVAILABLE", "Android speech recognition is not available on this device.")
      return
    }
    if (speechPromise != null) {
      promise.reject("SPEECH_RECOGNITION_ACTIVE", "Speech recognition is already active.")
      return
    }
    speechPromise = promise
    mainHandler.post {
      try {
        val recognizer = speechRecognizer ?: SpeechRecognizer.createSpeechRecognizer(reactContext).also { speechRecognizer = it }
        recognizer.setRecognitionListener(object : RecognitionListener {
          override fun onReadyForSpeech(params: Bundle?) {
            appendMediaButtonLog("speech ready")
          }

          override fun onBeginningOfSpeech() {
            appendMediaButtonLog("speech started")
          }

          override fun onRmsChanged(rmsdB: Float) {}
          override fun onBufferReceived(buffer: ByteArray?) {}

          override fun onEndOfSpeech() {
            appendMediaButtonLog("speech ended")
          }

          override fun onError(error: Int) {
            val result = WritableNativeMap()
            result.putBoolean("androidNativeBridge", true)
            result.putString("state", "speech-error")
            result.putInt("errorCode", error)
            result.putString("error", speechErrorName(error))
            appendMediaButtonLog("speech error " + speechErrorName(error))
            speechPromise?.resolve(result)
            speechPromise = null
          }

          override fun onResults(results: Bundle?) {
            resolveSpeechResults("speech-result", results)
          }

          override fun onPartialResults(partialResults: Bundle?) {
            appendMediaButtonLog("speech partial")
          }

          override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
          putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
          putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
          putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
          putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
          putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak to Athena")
        }
        appendMediaButtonLog("speech listening")
        recognizer.startListening(intent)
      } catch (error: Exception) {
        val pending = speechPromise
        speechPromise = null
        pending?.reject("SPEECH_RECOGNITION_FAILED", error.message ?: "Speech recognition failed.")
      }
    }
  }

  @ReactMethod
  fun requestBleResearchPermissions(promise: Promise) {
    requestPermissions(promise, "ble-research", blePermissions())
  }

  private fun requestPermissions(promise: Promise, label: String, permissions: List<String>) {
    val activity = currentActivity
    if (activity !is PermissionAwareActivity) {
      promise.reject("NO_PERMISSION_ACTIVITY", "Current activity cannot request Android runtime permissions.")
      return
    }
    if (pendingPermissionPromise != null) {
      promise.reject("PERMISSION_REQUEST_ACTIVE", "A permission request is already active.")
      return
    }
    pendingPermissionPromise = promise
    pendingPermissionLabel = label
    activity.requestPermissions(permissions.toTypedArray(), 4107, this)
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray): Boolean {
    if (requestCode != 4107) return false
    val result = WritableNativeMap()
    result.putBoolean("androidNativeBridge", true)
    result.putString("state", "permissions-result")
    result.putString("scope", pendingPermissionLabel)
    permissions.forEachIndexed { index, permission ->
      result.putBoolean(permission, grantResults.getOrNull(index) == android.content.pm.PackageManager.PERMISSION_GRANTED)
    }
    result.putString("note", "Permissions are ready for push-to-talk, foreground wake testing, and generic BLE discovery where supported by Android.")
    pendingPermissionPromise?.resolve(result)
    pendingPermissionPromise = null
    return true
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun scanGenericBleDevices(promise: Promise) {
    if (!hasBlePermissions()) {
      promise.reject("BLE_PERMISSION_REQUIRED", "Grant Bluetooth scan/connect permissions before scanning.")
      return
    }
    val scanner = bluetoothManager()?.adapter?.bluetoothLeScanner
    if (scanner == null) {
      promise.reject("BLE_SCANNER_UNAVAILABLE", "Bluetooth LE scanner is unavailable or Bluetooth is disabled.")
      return
    }
    discoveredDevices.clear()
    appendResearchLog("scan started")
    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        recordScanResult(result)
      }

      override fun onBatchScanResults(results: MutableList<ScanResult>) {
        results.forEach { recordScanResult(it) }
      }

      override fun onScanFailed(errorCode: Int) {
        appendResearchLog("scan failed: " + errorCode)
      }
    }
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
    try {
      scanner.startScan(null, settings, callback)
      mainHandler.postDelayed({
        try {
          scanner.stopScan(callback)
        } catch (_: Exception) {
        }
        appendResearchLog("scan stopped with " + discoveredDevices.size + " devices")
        val result = WritableNativeMap()
        result.putBoolean("androidNativeBridge", true)
        result.putString("state", "scan-complete")
        result.putArray("devices", mapValues(discoveredDevices.values.toList()))
        result.putArray("hints", stringArray(listOf("AiMB", "RDGlass", "MA08", "MA15", "6E40AB01-B5A3-F393-E0A9-E50E24DCCA9E")))
        promise.resolve(result)
      }, 8500)
    } catch (error: Exception) {
      promise.reject("BLE_SCAN_FAILED", error.message ?: "BLE scan failed.")
    }
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun getBondedBluetoothDevices(promise: Promise) {
    if (!hasBlePermissions()) {
      promise.reject("BLE_PERMISSION_REQUIRED", "Grant Bluetooth connect permissions before reading paired devices.")
      return
    }
    val adapter = bluetoothManager()?.adapter
    if (adapter == null) {
      promise.reject("BLUETOOTH_UNAVAILABLE", "Bluetooth adapter is unavailable.")
      return
    }
    try {
      val devices = adapter.bondedDevices?.map { bondedDeviceMap(it) } ?: emptyList()
      appendResearchLog("bonded device lookup returned " + devices.size + " devices")
      val result = WritableNativeMap()
      result.putBoolean("androidNativeBridge", true)
      result.putString("state", "bonded-devices")
      result.putArray("devices", mapValues(devices))
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("BONDED_DEVICE_LOOKUP_FAILED", error.message ?: "Could not read paired Bluetooth devices.")
    }
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun connectGenericBleDevice(address: String, promise: Promise) {
    if (!hasBlePermissions()) {
      promise.reject("BLE_PERMISSION_REQUIRED", "Grant Bluetooth connect permissions before connecting.")
      return
    }
    try {
      val device = bluetoothManager()?.adapter?.getRemoteDevice(address)
      if (device == null) {
        promise.reject("BLE_DEVICE_NOT_FOUND", "No Bluetooth device for address " + address)
        return
      }
      appendResearchLog("connect requested: " + safeName(device) + " " + address)
      activeGatt?.close()
      activeGatt = device.connectGatt(reactContext, false, gattCallback)
      val result = WritableNativeMap()
      result.putBoolean("androidNativeBridge", true)
      result.putString("state", "connecting")
      result.putString("address", address)
      result.putString("name", safeName(device))
      result.putString("next", "Tap Discover services after Android reports connection in the log.")
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("BLE_CONNECT_FAILED", error.message ?: "BLE connect failed.")
    }
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun discoverGenericBleServices(promise: Promise) {
    if (!hasBlePermissions()) {
      promise.reject("BLE_PERMISSION_REQUIRED", "Grant Bluetooth connect permissions before service discovery.")
      return
    }
    val gatt = activeGatt
    if (gatt == null) {
      promise.reject("BLE_NOT_CONNECTED", "Connect to a BLE device first.")
      return
    }
    val started = gatt.discoverServices()
    appendResearchLog("discoverServices requested: " + started)
    val result = WritableNativeMap()
    result.putBoolean("androidNativeBridge", true)
    result.putString("state", if (started) "discovering" else "discover-failed")
    result.putString("note", "Service details will appear in the research log after Android completes discovery.")
    promise.resolve(result)
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun subscribeGenericBleNotifications(promise: Promise) {
    if (!hasBlePermissions()) {
      promise.reject("BLE_PERMISSION_REQUIRED", "Grant Bluetooth connect permissions before subscribing to BLE notifications.")
      return
    }
    val gatt = activeGatt
    if (gatt == null) {
      promise.reject("BLE_NOT_CONNECTED", "Connect to a BLE device first.")
      return
    }
    val count = subscribeToNotifyCharacteristics(gatt)
    val result = WritableNativeMap()
    result.putBoolean("androidNativeBridge", true)
    result.putString("state", if (count > 0) "ble-notifications-subscribed" else "no-notify-characteristics")
    result.putInt("subscribedCount", count)
    result.putString("note", "Press the glasses AI/talk/photo buttons, then load the BLE research log to compare notify bytes.")
    promise.resolve(result)
  }

  @ReactMethod
  fun getGenericBleLog(promise: Promise) {
    val result = WritableNativeMap()
    result.putBoolean("androidNativeBridge", true)
    result.putString("state", "log")
    result.putArray("entries", stringArray(researchLog.takeLast(120)))
    promise.resolve(result)
  }

  private val gattCallback = object : BluetoothGattCallback() {
    @SuppressLint("MissingPermission")
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      appendResearchLog("connection state " + newState + " status " + status + " for " + safeName(gatt.device))
      activeGatt = gatt
      if (newState == android.bluetooth.BluetoothProfile.STATE_CONNECTED && hasBlePermissions()) {
        gatt.discoverServices()
      }
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      appendResearchLog("services discovered status " + status + " count " + gatt.services.size)
      gatt.services.forEach { service ->
        appendResearchLog("service " + service.uuid.toString())
        service.characteristics.forEach { characteristic ->
          appendResearchLog("  characteristic " + characteristic.uuid.toString() + " props " + characteristicProperties(characteristic.properties))
        }
      }
      if (status == BluetoothGatt.GATT_SUCCESS && hasBlePermissions()) {
        val count = subscribeToNotifyCharacteristics(gatt)
        appendResearchLog("auto notification subscribe count " + count)
      }
    }

    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      val bytes = if (Build.VERSION.SDK_INT >= 33) characteristic.value else characteristic.value
      recordBleNotification(characteristic.uuid.toString(), bytes ?: byteArrayOf())
    }

    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
      recordBleNotification(characteristic.uuid.toString(), value)
    }

    @SuppressLint("MissingPermission")
    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      appendResearchLog("descriptor write complete " + descriptor.characteristic.uuid.toString() + " status " + status)
      descriptorWriteInFlight = false
      writeNextPendingDescriptor(gatt)
    }
  }

  private fun voicePermissions(): List<String> {
    val permissions = mutableListOf(Manifest.permission.RECORD_AUDIO)
    if (Build.VERSION.SDK_INT >= 33) {
      permissions.add(Manifest.permission.POST_NOTIFICATIONS)
    }
    return permissions
  }

  private fun blePermissions(): List<String> {
    val permissions = mutableListOf<String>()
    if (Build.VERSION.SDK_INT >= 31) {
      permissions.add(Manifest.permission.BLUETOOTH_SCAN)
      permissions.add(Manifest.permission.BLUETOOTH_CONNECT)
    } else {
      permissions.add(Manifest.permission.ACCESS_FINE_LOCATION)
      permissions.add(Manifest.permission.BLUETOOTH)
      permissions.add(Manifest.permission.BLUETOOTH_ADMIN)
    }
    if (Build.VERSION.SDK_INT >= 33) {
      permissions.add(Manifest.permission.POST_NOTIFICATIONS)
    }
    return permissions
  }

  private fun hasBlePermissions(): Boolean {
    return blePermissions().all {
      reactContext.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
    }
  }

  private fun bluetoothManager(): BluetoothManager? =
    reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

  private fun recordScanResult(result: ScanResult) {
    val device = result.device ?: return
    val address = device.address ?: return
    if (discoveredDevices.containsKey(address)) return
    val item = WritableNativeMap()
    item.putString("address", address)
    item.putString("name", safeName(device))
    item.putInt("rssi", result.rssi)
    item.putString("kindHint", classifyDeviceName(safeName(device)))
    item.putArray("serviceUuids", stringArray(result.scanRecord?.serviceUuids?.map { it.uuid.toString() } ?: emptyList()))
    discoveredDevices[address] = item
    appendResearchLog("scan hit " + safeName(device) + " " + address + " rssi " + result.rssi)
  }

  @SuppressLint("MissingPermission")
  private fun bondedDeviceMap(device: BluetoothDevice): WritableNativeMap {
    val item = WritableNativeMap()
    item.putString("address", device.address ?: "unknown")
    item.putString("name", safeName(device))
    item.putString("kindHint", classifyDeviceName(safeName(device)))
    item.putString("bondState", bondStateName(device.bondState))
    item.putString("bluetoothType", bluetoothTypeName(device.type))
    item.putArray("serviceUuids", stringArray(device.uuids?.map { it.uuid.toString() } ?: emptyList()))
    return item
  }

  private fun classifyDeviceName(name: String): String {
    val lower = name.lowercase(Locale.US)
    return when {
      lower.contains("aimb") -> "AiMB candidate"
      lower.contains("rdglass") -> "RDGlass candidate"
      lower.contains("ma08") || lower.contains("ma15") -> "RDGlass model candidate"
      lower.contains("glass") -> "glasses candidate"
      else -> "unknown"
    }
  }

  @SuppressLint("MissingPermission")
  private fun safeName(device: BluetoothDevice): String {
    return try {
      device.name ?: "Unnamed BLE device"
    } catch (_: SecurityException) {
      "Permission-gated BLE device"
    }
  }

  private fun appendResearchLog(message: String) {
    Log.d("MountainViewBLE", message)
    researchLog.add(System.currentTimeMillis().toString() + " " + message)
    if (researchLog.size > 300) researchLog.removeAt(0)
  }

  @SuppressLint("MissingPermission")
  private fun subscribeToNotifyCharacteristics(gatt: BluetoothGatt): Int {
    var count = 0
    pendingDescriptorWrites.clear()
    descriptorWriteInFlight = false
    gatt.services.forEach { service ->
      service.characteristics.forEach { characteristic ->
        val canNotify = characteristic.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0
        val canIndicate = characteristic.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0
        if (!canNotify && !canIndicate) return@forEach
        val enabled = gatt.setCharacteristicNotification(characteristic, true)
        val descriptor = characteristic.getDescriptor(CLIENT_CHARACTERISTIC_CONFIG_UUID)
        if (descriptor != null) {
          val value = if (canNotify) BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE else BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
          pendingDescriptorWrites.add(PendingDescriptorWrite(descriptor, value))
          appendResearchLog("subscribe queued " + characteristic.uuid.toString() + " enabled " + enabled)
        } else {
          appendResearchLog("subscribe " + characteristic.uuid.toString() + " enabled " + enabled + " no cccd")
        }
        if (enabled) count += 1
      }
    }
    writeNextPendingDescriptor(gatt)
    return count
  }

  @SuppressLint("MissingPermission")
  private fun writeNextPendingDescriptor(gatt: BluetoothGatt) {
    if (descriptorWriteInFlight) return
    val next = pendingDescriptorWrites.removeFirstOrNull()
    if (next == null) {
      appendResearchLog("descriptor queue drained")
      return
    }
    descriptorWriteInFlight = true
    next.descriptor.value = next.value
    val wrote = gatt.writeDescriptor(next.descriptor)
    appendResearchLog("descriptor write " + next.descriptor.characteristic.uuid.toString() + " started " + wrote)
    if (!wrote) {
      descriptorWriteInFlight = false
      writeNextPendingDescriptor(gatt)
    }
  }

  private fun recordBleNotification(uuid: String, bytes: ByteArray) {
    val hex = bytesToHex(bytes)
    appendResearchLog("notify " + uuid + " " + hex)
    val event = WritableNativeMap()
    event.putString("uuid", uuid)
    event.putString("hex", hex)
    event.putInt("byteLength", bytes.size)
    event.putDouble("timestamp", System.currentTimeMillis().toDouble())
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("MountainViewBleNotification", event)
    val action = classifyBleButtonAction(uuid, hex)
    if (action != null) {
      appendResearchLog("ble button ai-talk " + action + " " + hex)
      val buttonEvent = WritableNativeMap()
      buttonEvent.putString("source", "ble-notify")
      buttonEvent.putString("button", "ai-talk")
      buttonEvent.putString("action", action)
      buttonEvent.putString("uuid", uuid)
      buttonEvent.putString("hex", hex)
      buttonEvent.putInt("byteLength", bytes.size)
      buttonEvent.putDouble("timestamp", System.currentTimeMillis().toDouble())
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("MountainViewBleButton", buttonEvent)
    }
  }

  private fun classifyBleButtonAction(uuid: String, hex: String): String? {
    val normalizedUuid = uuid.lowercase(Locale.US)
    if (!normalizedUuid.startsWith("0000ea01")) return null
    return when {
      hex.contains("12 04 00") -> "ai-talk-tap"
      hex.contains("12 0d 03 02") -> "ai-talk-long-start"
      hex.contains("12 0d 03 01") -> "ai-talk-long-active"
      hex.contains("12 0d 00 00") -> "ai-talk-stop"
      hex.contains("12 03 00 05 00 02 00 01") -> "ai-talk-state"
      else -> null
    }
  }

  private fun recordMediaButton(source: String, keyCode: Int, action: Int, repeatCount: Int) {
    val keyName = KeyEvent.keyCodeToString(keyCode)
    appendMediaButtonLog(source + " " + keyName + " action " + action + " repeat " + repeatCount)
    if (action != KeyEvent.ACTION_DOWN || repeatCount > 0) return
    val event = WritableNativeMap()
    event.putString("source", source)
    event.putString("keyName", keyName)
    event.putInt("keyCode", keyCode)
    event.putInt("action", action)
    event.putInt("repeatCount", repeatCount)
    event.putDouble("timestamp", System.currentTimeMillis().toDouble())
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("MountainViewMediaButton", event)
  }

  private fun resolveSpeechResults(state: String, results: Bundle?) {
    val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) ?: arrayListOf()
    val array = WritableNativeArray()
    matches.forEach { array.pushString(it) }
    val result = WritableNativeMap()
    result.putBoolean("androidNativeBridge", true)
    result.putString("state", state)
    result.putString("transcript", matches.firstOrNull() ?: "")
    result.putArray("matches", array)
    appendMediaButtonLog("speech result " + (matches.firstOrNull() ?: "empty"))
    speechPromise?.resolve(result)
    speechPromise = null
  }

  private fun speechErrorName(error: Int): String {
    return when (error) {
      SpeechRecognizer.ERROR_AUDIO -> "audio"
      SpeechRecognizer.ERROR_CLIENT -> "client"
      SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "insufficient-permissions"
      SpeechRecognizer.ERROR_NETWORK -> "network"
      SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network-timeout"
      SpeechRecognizer.ERROR_NO_MATCH -> "no-match"
      SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "recognizer-busy"
      SpeechRecognizer.ERROR_SERVER -> "server"
      SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "speech-timeout"
      else -> "unknown-" + error
    }
  }

  private fun appendMediaButtonLog(message: String) {
    mediaButtonLog.add(System.currentTimeMillis().toString() + " " + message)
    if (mediaButtonLog.size > 300) mediaButtonLog.removeAt(0)
  }

  private fun mapValues(values: List<WritableNativeMap>): WritableNativeArray {
    val array = WritableNativeArray()
    values.forEach { array.pushMap(it) }
    return array
  }

  private fun stringArray(values: List<String>): WritableNativeArray {
    val array = WritableNativeArray()
    values.forEach { array.pushString(it) }
    return array
  }

  private fun characteristicProperties(properties: Int): String {
    val names = mutableListOf<String>()
    if (properties and BluetoothGattCharacteristic.PROPERTY_READ != 0) names.add("read")
    if (properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) names.add("write")
    if (properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) names.add("write-no-response")
    if (properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) names.add("notify")
    if (properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) names.add("indicate")
    return names.joinToString("|").ifEmpty { properties.toString() }
  }

  private fun bondStateName(state: Int): String {
    return when (state) {
      BluetoothDevice.BOND_BONDED -> "bonded"
      BluetoothDevice.BOND_BONDING -> "bonding"
      BluetoothDevice.BOND_NONE -> "none"
      else -> state.toString()
    }
  }

  private fun bluetoothTypeName(type: Int): String {
    return when (type) {
      BluetoothDevice.DEVICE_TYPE_CLASSIC -> "classic"
      BluetoothDevice.DEVICE_TYPE_LE -> "le"
      BluetoothDevice.DEVICE_TYPE_DUAL -> "dual"
      BluetoothDevice.DEVICE_TYPE_UNKNOWN -> "unknown"
      else -> type.toString()
    }
  }

  private fun bytesToHex(bytes: ByteArray): String =
    bytes.take(64).joinToString(" ") { "%02x".format(it) }

  companion object {
    private val CLIENT_CHARACTERISTIC_CONFIG_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
  }

  data class PendingDescriptorWrite(
    val descriptor: BluetoothGattDescriptor,
    val value: ByteArray
  )

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
