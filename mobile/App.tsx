import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import * as ImagePicker from "expo-image-picker";
import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { addMediaButtonListener, metaWearables } from "./src/metaWearables";

type Command = {
  id: string;
  app_id: string;
  name: string;
  method: string;
  url_template: string;
};

type MemoryRecord = {
  id: string;
  title: string;
  body: string;
  created_at: string;
  tags?: string[];
};

type DeviceRecord = {
  id: string;
  name: string;
  kind: string;
  status: string;
  pairing_code?: string;
  connection_hint?: string;
  capabilities?: string[];
};

type PollingProfile = {
  id: string;
  name: string;
  interval_seconds: number;
  battery_mode: string;
  trigger_targets?: string[];
  enabled: number;
};

type RoadmapItem = {
  title: string;
  status: string;
  description: string;
};

type LogoProfile = {
  id: string;
  app_id: string;
  name: string;
  command_id: string;
  confidence_threshold: number;
  aliases?: string[];
};

type QrTrigger = {
  id: string;
  name: string;
  target_app: string;
  command_id: string;
  payload: string;
  action_type: string;
};

type BleScanDevice = {
  address: string;
  name?: string;
  rssi?: number;
  kindHint?: string;
  bondState?: string;
  bluetoothType?: string;
  serviceUuids?: string[];
};

const apiBaseUrl = Constants.expoConfig?.extra?.mountainViewApiBaseUrl ?? "https://mtman-machine-rotator.fly.dev/mountainview/api";

export default function App() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [tab, setTab] = useState("home");
  const [commands, setCommands] = useState<Command[]>([]);
  const [memory, setMemory] = useState<MemoryRecord[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [pollingProfiles, setPollingProfiles] = useState<PollingProfile[]>([]);
  const [logoProfiles, setLogoProfiles] = useState<LogoProfile[]>([]);
  const [qrTriggers, setQrTriggers] = useState<QrTrigger[]>([]);
  const [roadmap, setRoadmap] = useState<RoadmapItem[]>([]);
  const [log, setLog] = useState("Waiting for bridge activity.");
  const [statusMessage, setStatusMessage] = useState("Ready. Leave owner password blank and tap Connect.");
  const [note, setNote] = useState("");
  const [deviceName, setDeviceName] = useState("Companion Tablet");
  const [pollInterval, setPollInterval] = useState("60");
  const [logoTestText, setLogoTestText] = useState("I see the StreamWeaver logo on my tablet");
  const [qrPayload, setQrPayload] = useState("mountainview://avatar/room-anchor/default");
  const [voicePrompt, setVoicePrompt] = useState("Hey Athena what do you remember about my stream today?");
  const [voiceDestination, setVoiceDestination] = useState<"ai" | "private" | "twitch">("ai");
  const [bleDevices, setBleDevices] = useState<BleScanDevice[]>([]);
  const [mediaCommandMode, setMediaCommandMode] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [wakeListenerActive, setWakeListenerActive] = useState(false);
  const [glassesStatus, setGlassesStatus] = useState<Record<string, unknown>>({
    state: "not checked",
    flashControlSupported: false
  });
  const mediaCommandModeRef = useRef(false);
  const tokenRef = useRef("");
  const voicePromptRef = useRef(voicePrompt);
  const lastMediaTriggerRef = useRef(0);
  const wakeListenerActiveRef = useRef(false);

  const connected = token.length > 0;
  const commandMap = useMemo(() => new Map(commands.map((command) => [command.id, command])), [commands]);

  function announce(message: string) {
    setStatusMessage(message);
    setLog(message);
  }

  function reportError(action: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setStatusMessage(`${action} failed: ${message}`);
    setLog(`${action} failed\n${message}`);
    Alert.alert(`${action} failed`, message);
  }

  useEffect(() => {
    SecureStore.getItemAsync("mountainview_token").then((stored) => {
      if (stored) {
        setToken(stored);
        void load(stored);
      }
    });
  }, []);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    mediaCommandModeRef.current = mediaCommandMode;
  }, [mediaCommandMode]);

  useEffect(() => {
    voicePromptRef.current = voicePrompt;
  }, [voicePrompt]);

  useEffect(() => {
    wakeListenerActiveRef.current = wakeListenerActive;
  }, [wakeListenerActive]);

  useEffect(() => {
    const subscription = addMediaButtonListener((event) => {
      void handleMediaButtonEvent(event);
    });
    return () => subscription.remove();
  }, []);

  async function request(path: string, options: RequestInit = {}, authToken = token) {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        authorization: authToken ? `Bearer ${authToken}` : "",
        ...(options.headers ?? {})
      }
    });
    const raw = await response.text();
    let data: Record<string, any> = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(raw ? `Server returned non-JSON: ${raw.slice(0, 160)}` : "Server returned an empty response");
    }
    if (!response.ok || data.error) throw new Error(data.error ?? "Request failed");
    return data;
  }

  function commandReplyText(data: Record<string, any>) {
    const reply = data.response?.response ?? data.response?.message ?? data.response?.reply ?? data.response;
    return typeof reply === "string" && reply.trim() ? reply.trim() : "";
  }

  function wakeCommandFromTranscript(transcript: string) {
    const normalized = transcript.trim();
    const match = normalized.match(/\b(?:hey\s+)?(?:athena|annie)\b[:,]?\s*(.*)$/i);
    if (!match) return "";
    return match[1]?.trim() || normalized;
  }

  function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function login() {
    try {
      announce("Connecting to MountainView backend...");
      const data = await request("/login", {
        method: "POST",
        body: JSON.stringify({ email: "owner@spacemountain.live", password })
      }, "");
      setToken(data.token);
      await SecureStore.setItemAsync("mountainview_token", data.token);
      await load(data.token);
      setStatusMessage("Connected. MountainView command bridge is ready.");
    } catch (error) {
      reportError("Login", error);
    }
  }

  async function load(authToken = token) {
    setStatusMessage("Loading MountainView dashboard data...");
    const data = await request("/bootstrap", {}, authToken);
    setCommands(data.commands ?? []);
    setMemory(data.memory ?? []);
    setDevices(data.devices ?? []);
    setPollingProfiles(data.pollingProfiles ?? []);
    setLogoProfiles(data.logoProfiles ?? []);
    setQrTriggers(data.qrTriggers ?? []);
    setRoadmap(data.roadmap ?? []);
    setLog((data.logs ?? []).map((item: Record<string, string>) => `${item.created_at} ${item.app_id} ${item.status}`).join("\n") || "No activity yet.");
    setStatusMessage("Dashboard data loaded.");
  }

  async function runCommand(commandId: string, message = "MountainView mobile trigger") {
    try {
      announce(`Sending command ${commandId}...`);
      const command = commandMap.get(commandId);
      const data = await request("/commands/execute", {
        method: "POST",
        body: JSON.stringify({
          commandId,
          payload: {
            message,
            transcript: message,
            destination: voiceDestination,
            wakeWord: message.toLowerCase().startsWith("hey annie") ? "hey annie" : "hey athena",
            username: "mtman1987",
            source: "mountainview-mobile",
            payload: { message, transcript: message, destination: voiceDestination, source: "mountainview-mobile" }
          }
        })
      });
      setLog(`${command?.name ?? commandId}\n${JSON.stringify(data, null, 2)}`);
      setStatusMessage(`${command?.name ?? commandId} sent.`);
      const reply = commandReplyText(data);
      Speech.speak(reply || (data.ok ? "Command sent." : "Command failed."));
      return data;
    } catch (error) {
      reportError("Command", error);
      return undefined;
    }
  }

  async function trackMobileEvent(kind: string, metadata: Record<string, unknown>, status = "captured") {
    if (!tokenRef.current) return;
    try {
      await request("/glasses/media-event", {
        method: "POST",
        body: JSON.stringify({
          kind,
          source: "mountainview-mobile",
          targetApp: "streamweaver",
          status,
          metadata: {
            capturedAt: new Date().toISOString(),
            ...metadata
          }
        })
      }, tokenRef.current);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLog((current) => `${current}\nTelemetry save failed: ${message}`);
    }
  }

  async function handleMediaButtonEvent(event: Record<string, unknown>) {
    const keyName = String(event.keyName ?? "UNKNOWN_BUTTON");
    const now = Date.now();
    const triggerKeys = new Set([
      "KEYCODE_MEDIA_PLAY_PAUSE",
      "KEYCODE_MEDIA_PLAY",
      "KEYCODE_MEDIA_PAUSE",
      "KEYCODE_HEADSETHOOK",
      "KEYCODE_MEDIA_NEXT",
      "KEYCODE_MEDIA_PREVIOUS"
    ]);
    setLog((current) => `Glasses button event\n${JSON.stringify(event, null, 2)}\n\n${current}`);
    await trackMobileEvent("media-button", { event, commandMode: mediaCommandModeRef.current }, mediaCommandModeRef.current ? "command-mode" : "observed");
    if (!mediaCommandModeRef.current || !triggerKeys.has(keyName)) return;
    if (now - lastMediaTriggerRef.current < 1500) return;
    lastMediaTriggerRef.current = now;
    setStatusMessage(`${keyName.replace("KEYCODE_", "")} captured. Listening for Athena command...`);
    await listenAndRunVoiceCommander(`Hey Athena glasses button ${keyName} pressed. ${voicePromptRef.current}`);
  }

  async function startMediaButtonCommandMode() {
    try {
      announce("Starting glasses media button command mode...");
      const result = await metaWearables.startMediaButtonCommandMode();
      setMediaCommandMode(true);
      setLog(JSON.stringify(result, null, 2));
      await trackMobileEvent("media-button-command-mode", result, "active");
      setStatusMessage("Command mode active. Press the glasses play/pause button to talk to Athena.");
    } catch (error) {
      reportError("Media button command mode", error);
    }
  }

  async function stopMediaButtonCommandMode() {
    try {
      announce("Stopping glasses media button command mode...");
      const result = await metaWearables.stopMediaButtonCommandMode();
      setMediaCommandMode(false);
      setLog(JSON.stringify(result, null, 2));
      await trackMobileEvent("media-button-command-mode", result, "inactive");
      setStatusMessage("Command mode stopped.");
    } catch (error) {
      reportError("Stop command mode", error);
    }
  }

  async function loadMediaButtonLog() {
    try {
      announce("Loading glasses media button log...");
      const result = await metaWearables.getMediaButtonLog();
      setLog(JSON.stringify(result, null, 2));
      await trackMobileEvent("media-button-log", result, "loaded");
      setStatusMessage("Media button log loaded.");
    } catch (error) {
      reportError("Media button log", error);
    }
  }

  async function sendImageToStreamWeaver() {
    try {
      announce("Opening image picker...");
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        base64: true,
        quality: 0.8
      });
      if (result.canceled) {
        setStatusMessage("Image relay canceled.");
        return;
      }
      announce("Uploading image to StreamWeaver relay...");
      const imageBase64 = result.assets[0]?.base64 ?? "";
      const data = await request("/media/streamweaver", {
        method: "POST",
        body: JSON.stringify({
          imageBase64,
          metadata: { source: "mountainview-mobile", sentAt: new Date().toISOString() }
        })
      });
      setLog(JSON.stringify(data, null, 2));
      setStatusMessage("Image sent to StreamWeaver.");
    } catch (error) {
      reportError("StreamWeaver image relay", error);
    }
  }

  async function saveMemory() {
    try {
      announce("Saving memory...");
      await request("/memory", {
        method: "POST",
        body: JSON.stringify({ title: "Mobile note", body: note, tags: ["mobile", "glasses"] })
      });
      setNote("");
      await load();
      setStatusMessage("Memory saved.");
    } catch (error) {
      reportError("Save memory", error);
    }
  }

  async function checkGlassesSdk() {
    try {
      announce("Checking Android glasses bridge...");
      const status = await metaWearables.getSdkStatus();
      setGlassesStatus(status);
      setLog(JSON.stringify(status, null, 2));
      setStatusMessage(`Glasses bridge status: ${String(status.state ?? "checked")}`);
    } catch (error) {
      reportError("SDK status", error);
    }
  }

  async function registerGlasses() {
    try {
      announce("Starting glasses registration...");
      const result = await metaWearables.startRegistration();
      setGlassesStatus(result);
      setLog(JSON.stringify(result, null, 2));
      setStatusMessage(`Registration result: ${String(result.state ?? "complete")}`);
    } catch (error) {
      reportError("Register glasses", error);
    }
  }

  async function captureGlassesPhoto() {
    try {
      announce("Requesting glasses photo...");
      const result = await metaWearables.capturePhoto();
      setLog(JSON.stringify(result, null, 2));
      setStatusMessage(`Photo request result: ${String(result.state ?? "complete")}`);
    } catch (error) {
      reportError("Capture glasses photo", error);
    }
  }

  async function startGlassesAudioStream() {
    try {
      announce("Starting glasses audio relay...");
      const result = await metaWearables.startAudioStream();
      setLog(JSON.stringify(result, null, 2));
      await request("/glasses/media-event", {
        method: "POST",
        body: JSON.stringify({ kind: "audio-stream", targetApp: "hearmeout", metadata: result })
      });
      setStatusMessage("Audio relay event sent to HearMeOut route.");
    } catch (error) {
      reportError("Audio relay", error);
    }
  }

  async function startGlassesVideoStream() {
    try {
      announce("Starting glasses video relay...");
      const result = await metaWearables.startVideoStream();
      setLog(JSON.stringify(result, null, 2));
      await request("/glasses/media-event", {
        method: "POST",
        body: JSON.stringify({ kind: "video-stream", targetApp: "streamweaver", metadata: result })
      });
      setStatusMessage("Video relay event sent to StreamWeaver route.");
    } catch (error) {
      reportError("Video relay", error);
    }
  }

  async function requestGlassesFlashlight() {
    try {
      announce("Requesting glasses flashlight...");
      const result = await metaWearables.setFlashlight(true);
      setLog(JSON.stringify(result, null, 2));
      setStatusMessage(`Flashlight result: ${String(result.state ?? "checked")}`);
    } catch (error) {
      reportError("Flashlight", error);
    }
  }

  async function requestVoiceWakePermissions() {
    try {
      announce("Requesting wake/microphone permissions...");
      const result = await metaWearables.requestVoiceWakePermissions();
      setLog(JSON.stringify(result, null, 2));
      setStatusMessage(`Wake permission result: ${String(result.state ?? "checked")}`);
    } catch (error) {
      reportError("Wake permissions", error);
    }
  }

  async function requestBleResearchPermissions() {
    try {
      announce("Requesting Bluetooth permissions...");
      const result = await metaWearables.requestBleResearchPermissions();
      setLog(JSON.stringify(result, null, 2));
      setStatusMessage(`Bluetooth permission result: ${String(result.state ?? "checked")}`);
    } catch (error) {
      reportError("Bluetooth permissions", error);
    }
  }

  async function scanGenericBleDevices() {
    try {
      announce("Scanning nearby BLE devices for 12 seconds...");
      const result = await metaWearables.scanGenericBleDevices();
      const devices = Array.isArray(result.devices) ? result.devices as BleScanDevice[] : [];
      setBleDevices(devices);
      setLog(JSON.stringify(result, null, 2));
      await request("/glasses/media-event", {
        method: "POST",
        body: JSON.stringify({
          kind: "ble-scan",
          source: "rdglass-research",
          targetApp: "streamweaver",
          status: devices.length > 0 ? "devices-found" : "no-devices",
          metadata: {
            scannedAt: new Date().toISOString(),
            deviceCount: devices.length,
            devices,
            nativeResult: result
          }
        })
      });
      setStatusMessage(devices.length > 0 ? `Found ${devices.length} BLE devices. Tap the glasses row to connect.` : "No BLE devices found. Put glasses in pairing mode and scan again.");
    } catch (error) {
      reportError("BLE scan", error);
    }
  }

  async function loadBondedBluetoothDevices() {
    try {
      announce("Loading paired Bluetooth devices from Android...");
      const result = await metaWearables.getBondedBluetoothDevices();
      const devices = Array.isArray(result.devices) ? result.devices as BleScanDevice[] : [];
      setBleDevices(devices);
      setLog(JSON.stringify(result, null, 2));
      await request("/glasses/media-event", {
        method: "POST",
        body: JSON.stringify({
          kind: "bluetooth-bonded-devices",
          source: "android-paired-audio",
          targetApp: "streamweaver",
          status: devices.length > 0 ? "devices-found" : "no-devices",
          metadata: {
            checkedAt: new Date().toISOString(),
            deviceCount: devices.length,
            devices,
            nativeResult: result
          }
        })
      });
      setStatusMessage(devices.length > 0 ? `Found ${devices.length} paired Bluetooth devices. Tap the glasses row to inspect/connect.` : "No paired Bluetooth devices returned by Android.");
    } catch (error) {
      reportError("Paired Bluetooth lookup", error);
    }
  }

  async function connectGenericBleDevice(address: string) {
    try {
      announce(`Connecting to BLE device ${address}...`);
      const result = await metaWearables.connectGenericBleDevice(address);
      setLog(JSON.stringify(result, null, 2));
      await request("/glasses/media-event", {
        method: "POST",
        body: JSON.stringify({ kind: "ble-connect", source: "rdglass-research", targetApp: "streamweaver", metadata: result })
      });
      setStatusMessage(`BLE connect result: ${String(result.state ?? result.status ?? "complete")}`);
    } catch (error) {
      reportError("BLE connect", error);
    }
  }

  async function discoverGenericBleServices() {
    try {
      announce("Discovering services on connected BLE device...");
      const result = await metaWearables.discoverGenericBleServices();
      setLog(JSON.stringify(result, null, 2));
      setStatusMessage(`Service discovery result: ${String(result.state ?? "complete")}`);
    } catch (error) {
      reportError("BLE service discovery", error);
    }
  }

  async function loadGenericBleLog() {
    try {
      announce("Loading BLE research log...");
      const result = await metaWearables.getGenericBleLog();
      setLog(JSON.stringify(result, null, 2));
      setStatusMessage("BLE research log loaded.");
    } catch (error) {
      reportError("BLE log", error);
    }
  }

  async function askStreamWeaverVoiceCommander() {
    await runCommand("cmd_streamweaver_voice_commander", voicePrompt);
  }

  async function listenAndRunVoiceCommander(fallbackPrompt = voicePrompt) {
    try {
      setIsListening(true);
      announce("Listening for Athena command...");
      const speech = await metaWearables.recognizeSpeechOnce();
      setLog(JSON.stringify(speech, null, 2));
      const transcript = String(speech.transcript ?? "").trim();
      if (!transcript) {
        setStatusMessage("No speech recognized. Sending the typed prompt instead.");
        await runCommand("cmd_streamweaver_voice_commander", fallbackPrompt);
        return;
      }
      setVoicePrompt(transcript);
      await trackMobileEvent("speech-recognition", speech, "recognized");
      await runCommand("cmd_streamweaver_voice_commander", transcript);
    } catch (error) {
      reportError("Listen and ask Athena", error);
    } finally {
      setIsListening(false);
    }
  }

  async function startWakeListener() {
    if (wakeListenerActiveRef.current) return;
    wakeListenerActiveRef.current = true;
    setWakeListenerActive(true);
    setStatusMessage("Hey Athena listener active. Keep MountainView open.");
    setLog("Hey Athena listener active. Say: Hey Athena, followed by your command.");

    while (wakeListenerActiveRef.current) {
      try {
        setIsListening(true);
        const speech = await metaWearables.recognizeSpeechOnce();
        const transcript = String(speech.transcript ?? "").trim();
        if (transcript) {
          setVoicePrompt(transcript);
          await trackMobileEvent("wake-listener-speech", speech, "recognized");
          const command = wakeCommandFromTranscript(transcript);
          if (command) {
            setStatusMessage("Wake phrase captured. Sending to Athena...");
            await runCommand("cmd_streamweaver_voice_commander", command);
          } else {
            setStatusMessage(`Listening for Hey Athena. Heard: ${transcript}`);
          }
        } else {
          setStatusMessage("Listening for Hey Athena...");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLog((current) => `Wake listener cycle failed: ${message}\n${current}`);
        setStatusMessage("Wake listener still active; retrying...");
      } finally {
        setIsListening(false);
      }
      await delay(800);
    }
    setStatusMessage("Hey Athena listener stopped.");
  }

  function stopWakeListener() {
    wakeListenerActiveRef.current = false;
    setWakeListenerActive(false);
    setIsListening(false);
  }

  async function saveDevice() {
    try {
      announce("Registering companion device...");
      await request("/devices", {
        method: "POST",
        body: JSON.stringify({
          name: deviceName,
          kind: "tablet",
          pairingCode: "qr-command-portal",
          connectionHint: "qr-bluetooth",
          capabilities: ["display", "commands", "companion-hud"]
        })
      });
      await load();
      setStatusMessage("Companion device registered.");
    } catch (error) {
      reportError("Register device", error);
    }
  }

  async function savePollingProfile() {
    try {
      announce("Saving visual polling profile...");
      await request("/polling-profiles", {
        method: "POST",
        body: JSON.stringify({
          name: "Visual trigger scan",
          intervalSeconds: Number(pollInterval),
          batteryMode: Number(pollInterval) <= 15 ? "high-power" : "balanced",
          triggerTargets: ["qr", "device-marker", "scene-change", "app-logo", "screen-read"]
        })
      });
      await load();
      setStatusMessage("Visual polling profile saved.");
    } catch (error) {
      reportError("Save polling profile", error);
    }
  }

  async function testLogoMatch() {
    try {
      announce("Testing logo route...");
      const data = await request("/logo-profiles/match", {
        method: "POST",
        body: JSON.stringify({ observedText: logoTestText })
      });
      setLog(JSON.stringify(data, null, 2));
      setStatusMessage(data.matched ? "Logo route matched." : "No logo route matched.");
      Speech.speak(data.matched ? "Logo route matched." : "No logo route matched.");
      await load();
    } catch (error) {
      reportError("Logo route test", error);
    }
  }

  async function saveLogoProfile() {
    try {
      announce("Saving logo profile...");
      await request("/logo-profiles", {
        method: "POST",
        body: JSON.stringify({
          name: "MountainView app logo",
          appId: "streamweaver",
          aliases: "streamweaver,stream weaver,spacemountain stream",
          commandId: "cmd_streamweaver_voice_commander"
        })
      });
      await load();
      setStatusMessage("Logo profile saved.");
    } catch (error) {
      reportError("Save logo profile", error);
    }
  }

  async function saveQrTrigger() {
    try {
      announce("Saving QR trigger...");
      await request("/qr-triggers", {
        method: "POST",
        body: JSON.stringify({
          name: "AR avatar room anchor",
          targetApp: "streamweaver",
          commandId: "cmd_eden_image_generation",
          actionType: "ar-avatar",
          payload: qrPayload
        })
      });
      await load();
      setStatusMessage("QR trigger saved.");
    } catch (error) {
      reportError("Save QR trigger", error);
    }
  }

  return (
    <View style={styles.app}>
      <View style={styles.header}>
        <View style={styles.mark} />
        <View>
          <Text style={styles.title}>MountainView AI</Text>
          <Text style={styles.subtitle}>Spacemountain.live command bridge</Text>
        </View>
      </View>
      <View style={styles.statusStrip}>
        <Ionicons name={connected ? "radio" : "cloud-outline"} size={16} color={connected ? "#32d583" : "#ffd166"} />
        <Text style={styles.statusStripText}>{statusMessage}</Text>
      </View>

      {!connected ? (
        <View style={styles.panel}>
          <Text style={styles.label}>Owner login</Text>
          <Text style={styles.note}>Development auth is disabled on Fly. Leave this blank and tap Connect.</Text>
          <TextInput secureTextEntry value={password} onChangeText={setPassword} placeholder="Owner password optional" placeholderTextColor="#7f8ca8" style={styles.input} />
          <Pressable style={styles.primaryButton} onPress={login}><Text style={styles.primaryButtonText}>Connect</Text></Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {tab === "home" && (
            <>
              <View style={styles.grid}>
                <StatusCard label="Glasses" value={String(glassesStatus.state ?? "SDK gated")} tone="warn" detail="Android DAT bridge prepared for Meta Wearables events." />
                <StatusCard label="Image AI" value="Relay only" tone="good" detail="No face recognition in MountainView AI." />
                <StatusCard label="Streaming" value="Control ready" detail="Start/stop/overlay triggers are prepared." />
                <StatusCard label="Flash" value={glassesStatus.flashControlSupported ? "Supported" : "Not exposed"} tone={glassesStatus.flashControlSupported ? "good" : "bad"} detail="Current public DAT docs do not list glasses torch control." />
              </View>
              <View style={styles.panel}>
                <Text style={styles.label}>Meta glasses</Text>
                <Text style={styles.note}>Android SDK integration is native. Use a dev client build with GITHUB_TOKEN and MOUNTAINVIEW_META_APP_ID configured.</Text>
                <Pressable style={styles.primaryButton} onPress={checkGlassesSdk}><Text style={styles.primaryButtonText}>SDK status</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={registerGlasses}><Text style={styles.secondaryButtonText}>Register glasses</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={captureGlassesPhoto}><Text style={styles.secondaryButtonText}>Capture glasses photo</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={requestGlassesFlashlight}><Text style={styles.secondaryButtonText}>Request flashlight</Text></Pressable>
              </View>
              <View style={styles.panel}>
                <Text style={styles.label}>RDGlass / AiMB research</Text>
                <Text style={styles.note}>Scan for the knockoff glasses path first. The RDGlass export points to BLE, 16 kHz mono voice events, Microsoft speech libraries, and Nordic UART-like UUIDs; this screen discovers what your actual glasses expose.</Text>
                <Pressable style={styles.primaryButton} onPress={requestBleResearchPermissions}><Text style={styles.primaryButtonText}>Grant BLE permissions</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={loadBondedBluetoothDevices}><Text style={styles.secondaryButtonText}>Load paired Bluetooth devices</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={scanGenericBleDevices}><Text style={styles.secondaryButtonText}>Scan nearby BLE devices</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={discoverGenericBleServices}><Text style={styles.secondaryButtonText}>Discover connected services</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={loadGenericBleLog}><Text style={styles.secondaryButtonText}>Load BLE research log</Text></Pressable>
                <View style={styles.hintBox}>
                  <Text style={styles.memoryBody}>Known UUID leads: 6E40AB01/02/03-B5A3-F393-E0A9-E50E24DCCA9E, 0000FFD0-FFD8, 0000FFF1/FFF2/FFF3/FFF6, battery/device/HID services.</Text>
                </View>
                {bleDevices.map((device) => (
                  <Pressable key={device.address} style={styles.memoryRow} onPress={() => connectGenericBleDevice(device.address)}>
                    <Text style={styles.memoryTitle}>{device.name ?? "Unnamed BLE device"}</Text>
                    <Text style={styles.memoryBody}>{device.address} • RSSI {device.rssi ?? "n/a"} • {device.kindHint ?? "unknown"}</Text>
                    <Text style={styles.memoryBody}>{device.bondState ?? "scan"} • {device.bluetoothType ?? "ble"}</Text>
                    <Text style={styles.memoryBody}>{(device.serviceUuids ?? []).slice(0, 3).join(", ")}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.panel}>
                <Text style={styles.label}>Athena wake bridge</Text>
                <Text style={styles.note}>Send the typed prompt or use one-shot Android speech recognition. If RDGlass says connect to its app, that button press was intercepted before MountainView received it.</Text>
                <TextInput value={voicePrompt} onChangeText={setVoicePrompt} placeholder="Hey Athena ..." placeholderTextColor="#7f8ca8" style={styles.input} />
                <View style={styles.inlineOptions}>
                  {(["ai", "private", "twitch"] as const).map((value) => (
                    <Pressable key={value} style={[styles.optionChip, voiceDestination === value && styles.optionChipActive]} onPress={() => setVoiceDestination(value)}>
                      <Text style={styles.optionChipText}>{value}</Text>
                    </Pressable>
                  ))}
                </View>
                <Pressable style={styles.primaryButton} onPress={askStreamWeaverVoiceCommander}><Text style={styles.primaryButtonText}>Send typed prompt to Athena</Text></Pressable>
                <Pressable style={styles.primaryButton} onPress={() => listenAndRunVoiceCommander()}>
                  <Text style={styles.primaryButtonText}>{isListening ? "Listening..." : "Listen then ask Athena"}</Text>
                </Pressable>
                <Pressable style={wakeListenerActive ? styles.dangerButton : styles.primaryButton} onPress={wakeListenerActive ? stopWakeListener : startWakeListener}>
                  <Text style={wakeListenerActive ? styles.dangerButtonText : styles.primaryButtonText}>{wakeListenerActive ? "Stop Hey Athena listener" : "Start Hey Athena listener"}</Text>
                </Pressable>
                <Pressable style={mediaCommandMode ? styles.dangerButton : styles.primaryButton} onPress={mediaCommandMode ? stopMediaButtonCommandMode : startMediaButtonCommandMode}>
                  <Text style={mediaCommandMode ? styles.dangerButtonText : styles.primaryButtonText}>{mediaCommandMode ? "Stop glasses command mode" : "Start glasses command mode"}</Text>
                </Pressable>
                <Pressable style={styles.secondaryButton} onPress={loadMediaButtonLog}><Text style={styles.secondaryButtonText}>Load glasses button log</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={requestVoiceWakePermissions}><Text style={styles.secondaryButtonText}>Request wake permissions</Text></Pressable>
              </View>
              <View style={styles.panel}>
                <Text style={styles.label}>Companion HUD</Text>
                <Text style={styles.note}>Use your phone, tablet, PC, or browser as the display layer for glasses commands, memory, QR triggers, and StreamWeaver/HearMeOut status.</Text>
                <Pressable style={styles.secondaryButton} onPress={() => setTab("devices")}><Text style={styles.secondaryButtonText}>Open device mesh</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={() => setTab("polling")}><Text style={styles.secondaryButtonText}>Configure visual polling</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={() => setTab("logos")}><Text style={styles.secondaryButtonText}>Test app logo routes</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={() => setTab("qr")}><Text style={styles.secondaryButtonText}>Make QR triggers</Text></Pressable>
              </View>
              <View style={styles.panel}>
                <Text style={styles.label}>Quick commands</Text>
                <CommandGroup title="StreamWeaver" commands={commands.filter((command) => command.app_id === "streamweaver")} onRun={runCommand} />
                <CommandGroup title="HearMeOut" commands={commands.filter((command) => command.app_id === "hearmeout")} onRun={runCommand} />
                <CommandGroup title="DiscordStreamHub" commands={commands.filter((command) => command.app_id === "discordstreamhub")} onRun={runCommand} />
                <CommandGroup title="Chat-Tag" commands={commands.filter((command) => command.app_id === "chat-tag")} onRun={runCommand} />
                <CommandGroup title="EdenAI" commands={commands.filter((command) => command.app_id === "edenai")} onRun={runCommand} />
              </View>
            </>
          )}

          {tab === "relay" && (
            <View style={styles.panel}>
              <Text style={styles.label}>StreamWeaver relay</Text>
              <Pressable style={styles.primaryButton} onPress={sendImageToStreamWeaver}><Text style={styles.primaryButtonText}>Send image/frame</Text></Pressable>
              <Text style={styles.note}>Images are forwarded to StreamWeaver for AI processing.</Text>
            </View>
          )}

          {tab === "memory" && (
            <View style={styles.panel}>
              <Text style={styles.label}>AI memory</Text>
              <TextInput value={note} onChangeText={setNote} placeholder="Save note, context, image metadata, or app activity" placeholderTextColor="#7f8ca8" style={[styles.input, styles.textArea]} multiline />
              <Pressable style={styles.primaryButton} onPress={saveMemory}><Text style={styles.primaryButtonText}>Save memory</Text></Pressable>
              {memory.map((record) => (
                <View key={record.id} style={styles.memoryRow}>
                  <Text style={styles.memoryTitle}>{record.title}</Text>
                  <Text style={styles.memoryBody}>{record.body}</Text>
                </View>
              ))}
            </View>
          )}

          {tab === "stream" && (
            <View style={styles.panel}>
              <Text style={styles.label}>Live stream controls</Text>
              <Pressable style={styles.primaryButton} onPress={() => runCommand("cmd_stream_start", "Start stream")}><Text style={styles.primaryButtonText}>Start stream</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={startGlassesAudioStream}><Text style={styles.secondaryButtonText}>Start glasses audio relay</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={startGlassesVideoStream}><Text style={styles.secondaryButtonText}>Start glasses video relay</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={askStreamWeaverVoiceCommander}><Text style={styles.secondaryButtonText}>Run StreamWeaver voice commander</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_hearmeout_voice_room", "Join voice room")}><Text style={styles.secondaryButtonText}>Join HearMeOut voice room</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => setLog("Stop stream requested")}><Text style={styles.secondaryButtonText}>Stop stream</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_stream_overlay", "Overlay event requested")}><Text style={styles.secondaryButtonText}>Trigger overlay/event</Text></Pressable>
            </View>
          )}

          {tab === "logs" && <View style={styles.panel}><Text style={styles.label}>Activity logs</Text><Text style={styles.log}>{log}</Text></View>}

          {tab === "devices" && (
            <View style={styles.panel}>
              <Text style={styles.label}>Device mesh</Text>
              <TextInput value={deviceName} onChangeText={setDeviceName} placeholder="Device name" placeholderTextColor="#7f8ca8" style={styles.input} />
              <Pressable style={styles.primaryButton} onPress={saveDevice}><Text style={styles.primaryButtonText}>Register companion device</Text></Pressable>
              {devices.map((device) => (
                <View key={device.id} style={styles.memoryRow}>
                  <Text style={styles.memoryTitle}>{device.name}</Text>
                  <Text style={styles.memoryBody}>{device.kind} • {device.status} • {device.connection_hint ?? "local"}</Text>
                  <Text style={styles.memoryBody}>{(device.capabilities ?? []).join(", ")}</Text>
                </View>
              ))}
            </View>
          )}

          {tab === "polling" && (
            <View style={styles.panel}>
              <Text style={styles.label}>Visual trigger polling</Text>
              <Text style={styles.note}>Snapshot polling checks for QR codes, app logos, device markers, screen text, scene changes, and memory prompts without continuous video streaming.</Text>
              <View style={styles.inlineOptions}>
                {["15", "60", "180", "300"].map((value) => (
                  <Pressable key={value} style={[styles.optionChip, pollInterval === value && styles.optionChipActive]} onPress={() => setPollInterval(value)}>
                    <Text style={styles.optionChipText}>{value}s</Text>
                  </Pressable>
                ))}
              </View>
              <Pressable style={styles.primaryButton} onPress={savePollingProfile}><Text style={styles.primaryButtonText}>Save polling profile</Text></Pressable>
              {pollingProfiles.map((profile) => (
                <View key={profile.id} style={styles.memoryRow}>
                  <Text style={styles.memoryTitle}>{profile.name}</Text>
                  <Text style={styles.memoryBody}>{profile.interval_seconds}s • {profile.battery_mode} • {profile.enabled ? "enabled" : "paused"}</Text>
                  <Text style={styles.memoryBody}>{(profile.trigger_targets ?? []).join(", ")}</Text>
                </View>
              ))}
            </View>
          )}

          {tab === "logos" && (
            <View style={styles.panel}>
              <Text style={styles.label}>App logo recognition</Text>
              <Text style={styles.note}>Use this as the first polling test: detected screen labels or vision results route to the matching Spacemountain app command.</Text>
              <TextInput value={logoTestText} onChangeText={setLogoTestText} placeholder="Detected logo or OCR text" placeholderTextColor="#7f8ca8" style={styles.input} />
              <Pressable style={styles.primaryButton} onPress={testLogoMatch}><Text style={styles.primaryButtonText}>Test logo route</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={saveLogoProfile}><Text style={styles.secondaryButtonText}>Add StreamWeaver logo profile</Text></Pressable>
              {logoProfiles.map((profile) => (
                <View key={profile.id} style={styles.memoryRow}>
                  <Text style={styles.memoryTitle}>{profile.name}</Text>
                  <Text style={styles.memoryBody}>{profile.app_id} • {profile.command_id}</Text>
                  <Text style={styles.memoryBody}>{(profile.aliases ?? []).join(", ")}</Text>
                </View>
              ))}
            </View>
          )}

          {tab === "qr" && (
            <View style={styles.panel}>
              <Text style={styles.label}>QR trigger maker</Text>
              <Text style={styles.note}>Create QR payloads for AR avatars, stream overlays, Chat-Tag events, device pairing, and HearMeOut audiobook requests.</Text>
              <TextInput value={qrPayload} onChangeText={setQrPayload} placeholder="mountainview://..." placeholderTextColor="#7f8ca8" style={styles.input} />
              <Pressable style={styles.primaryButton} onPress={saveQrTrigger}><Text style={styles.primaryButtonText}>Save QR trigger</Text></Pressable>
              {qrTriggers.map((trigger) => (
                <View key={trigger.id} style={styles.memoryRow}>
                  <Text style={styles.memoryTitle}>{trigger.name}</Text>
                  <Text style={styles.memoryBody}>{trigger.target_app} • {trigger.command_id} • {trigger.action_type}</Text>
                  <Text style={styles.memoryBody}>{trigger.payload}</Text>
                </View>
              ))}
            </View>
          )}

          {tab === "roadmap" && (
            <View style={styles.panel}>
              <Text style={styles.label}>Coming soon</Text>
              {roadmap.map((item) => (
                <View key={item.title} style={styles.memoryRow}>
                  <Text style={styles.memoryTitle}>{item.title}</Text>
                  <Text style={styles.memoryBody}>{item.status}</Text>
                  <Text style={styles.memoryBody}>{item.description}</Text>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      )}

      <View style={styles.tabs}>
        {[
          ["home", "planet", "Home"],
          ["relay", "image", "Relay"],
          ["memory", "file-tray-full", "Memory"],
          ["stream", "radio", "Stream"],
          ["devices", "phone-portrait", "Devices"],
          ["polling", "scan", "Scan"],
          ["logos", "apps", "Logos"],
          ["qr", "qr-code", "QR"],
          ["roadmap", "rocket", "Soon"],
          ["logs", "terminal", "Logs"]
        ].map(([id, icon, label]) => (
          <Pressable key={id} style={[styles.tab, tab === id && styles.activeTab]} onPress={() => { setStatusMessage(`Opened ${label}.`); setTab(id); }}>
            <Ionicons name={icon as keyof typeof Ionicons.glyphMap} size={20} color={tab === id ? "#20d5ff" : "#94a3b8"} />
            <Text style={[styles.tabLabel, tab === id && styles.activeTabLabel]} numberOfLines={1}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function StatusCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: "good" | "warn" | "bad" }) {
  return (
    <View style={styles.statusCard}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.statusValue, tone === "good" && styles.good, tone === "warn" && styles.warn, tone === "bad" && styles.bad]}>{value}</Text>
      <Text style={styles.note}>{detail}</Text>
    </View>
  );
}

function CommandRow({ command, onPress }: { command: Command; onPress: () => void }) {
  return (
    <Pressable style={styles.commandRow} onPress={onPress}>
      <View>
        <Text style={styles.commandTitle}>{command.name}</Text>
        <Text style={styles.commandMeta}>{command.app_id} • {command.method} {command.url_template}</Text>
      </View>
      <Ionicons name="flash" size={18} color="#20d5ff" />
    </Pressable>
  );
}

function CommandGroup({ title, commands, onRun }: { title: string; commands: Command[]; onRun: (id: string) => void }) {
  if (commands.length === 0) return null;
  return (
    <View style={styles.commandGroup}>
      <Text style={styles.commandGroupTitle}>{title}</Text>
      {commands.map((command) => (
        <CommandRow key={command.id} command={command} onPress={() => onRun(command.id)} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: "#050712", paddingTop: 54 },
  header: { flexDirection: "row", gap: 12, alignItems: "center", paddingHorizontal: 18, paddingBottom: 16 },
  mark: { width: 40, height: 40, borderRadius: 10, backgroundColor: "#20d5ff" },
  title: { color: "#f8fbff", fontSize: 24, fontWeight: "900" },
  subtitle: { color: "#9fb1cc", fontSize: 13 },
  statusStrip: { marginHorizontal: 14, marginBottom: 10, padding: 10, borderRadius: 8, backgroundColor: "#0b1020", borderWidth: 1, borderColor: "rgba(32,213,255,.28)", flexDirection: "row", alignItems: "center", gap: 8 },
  statusStripText: { color: "#d9e8ff", fontSize: 13, lineHeight: 18, flex: 1 },
  content: { padding: 14, paddingBottom: 110, gap: 14 },
  panel: { margin: 14, padding: 16, borderRadius: 8, backgroundColor: "#10172a", borderWidth: 1, borderColor: "rgba(255,255,255,.12)", gap: 12 },
  grid: { gap: 10 },
  statusCard: { padding: 14, borderRadius: 8, backgroundColor: "#111c35", borderWidth: 1, borderColor: "rgba(255,255,255,.12)" },
  label: { color: "#9fb1cc", fontSize: 11, letterSpacing: 1.4, textTransform: "uppercase", fontWeight: "700" },
  statusValue: { color: "#f8fbff", fontSize: 24, fontWeight: "900", marginTop: 4 },
  good: { color: "#32d583" },
  warn: { color: "#ffd166" },
  bad: { color: "#ff6b8a" },
  note: { color: "#9fb1cc", fontSize: 13, lineHeight: 19 },
  input: { color: "#f8fbff", backgroundColor: "#0b1020", borderColor: "rgba(255,255,255,.12)", borderWidth: 1, borderRadius: 8, padding: 12 },
  textArea: { minHeight: 110, textAlignVertical: "top" },
  primaryButton: { backgroundColor: "#20d5ff", borderRadius: 8, padding: 12, alignItems: "center" },
  primaryButtonText: { color: "#00131a", fontWeight: "900" },
  dangerButton: { backgroundColor: "#ff6b8a", borderRadius: 8, padding: 12, alignItems: "center" },
  dangerButtonText: { color: "#1f0610", fontWeight: "900" },
  secondaryButton: { borderRadius: 8, padding: 12, alignItems: "center", borderWidth: 1, borderColor: "rgba(255,255,255,.14)" },
  secondaryButtonText: { color: "#f8fbff", fontWeight: "800" },
  commandRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 12, borderRadius: 8, backgroundColor: "#0b1020", borderWidth: 1, borderColor: "rgba(255,255,255,.12)", marginTop: 8 },
  commandTitle: { color: "#f8fbff", fontWeight: "800" },
  commandMeta: { color: "#9fb1cc", fontSize: 12, marginTop: 3 },
  commandGroup: { gap: 6, marginTop: 10 },
  commandGroupTitle: { color: "#20d5ff", fontSize: 14, fontWeight: "900", marginTop: 4 },
  memoryRow: { borderLeftWidth: 2, borderLeftColor: "#20d5ff", paddingLeft: 12, paddingVertical: 8, marginTop: 8 },
  hintBox: { padding: 12, borderRadius: 8, backgroundColor: "rgba(117,80,255,.12)", borderWidth: 1, borderColor: "rgba(117,80,255,.32)" },
  memoryTitle: { color: "#f8fbff", fontWeight: "800" },
  memoryBody: { color: "#9fb1cc", marginTop: 3 },
  log: { color: "#d9e8ff", fontFamily: "Courier", fontSize: 12 },
  inlineOptions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  optionChip: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: "#0b1020", borderWidth: 1, borderColor: "rgba(255,255,255,.12)" },
  optionChipActive: { borderColor: "#20d5ff", backgroundColor: "rgba(32,213,255,.14)" },
  optionChipText: { color: "#f8fbff", fontWeight: "800" },
  tabs: { position: "absolute", bottom: 18, left: 8, right: 8, flexDirection: "row", justifyContent: "space-between", backgroundColor: "rgba(8,12,25,.96)", borderRadius: 12, padding: 6, borderWidth: 1, borderColor: "rgba(255,255,255,.12)" },
  tab: { width: "10%", minHeight: 48, borderRadius: 8, alignItems: "center", justifyContent: "center", gap: 3 },
  activeTab: { backgroundColor: "rgba(32,213,255,.14)" },
  tabLabel: { color: "#94a3b8", fontSize: 9, fontWeight: "800" },
  activeTabLabel: { color: "#20d5ff" }
});
