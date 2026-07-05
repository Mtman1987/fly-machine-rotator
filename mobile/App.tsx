import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import * as ImagePicker from "expo-image-picker";
import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { parseVoiceCommandForDate } from "./src/dateParser";
import { addBleButtonListener, addMediaButtonListener, metaWearables, toggleFlashlight } from "./src/metaWearables";

(Text as any).defaultProps = (Text as any).defaultProps ?? {};
(Text as any).defaultProps.maxFontSizeMultiplier = 1.15;
(TextInput as any).defaultProps = (TextInput as any).defaultProps ?? {};
(TextInput as any).defaultProps.maxFontSizeMultiplier = 1.15;

type Command = {
  id: string;
  app_id: string;
  name: string;
  phrase?: string;
  method: string;
  url_template: string;
  requiredContext?: string[];
  naturalExamples?: string[];
  riskLevel?: string;
  testReadiness?: string;
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

type VoiceDestination = "ai" | "private" | "twitch" | "discord";
type VoiceCommanderMode = "reply" | "dictation" | "translation";
type ActivityLogRecord = {
  id: string;
  category: "api" | "ble" | "voice" | "flashlight" | "calendar" | "vision" | "system";
  title: string;
  status: string;
  detail: string;
  createdAt: string;
};

const apiBaseUrl = Constants.expoConfig?.extra?.mountainViewApiBaseUrl ?? "https://mtman-machine-rotator.fly.dev/mountainview/api";
const bleLastDeviceKey = "mountainview_last_ble_device";
const defaultAimbAddress = "C8:47:8C:15:60:01";
const voiceRoutes: { id: VoiceDestination; label: string; detail: string }[] = [
  { id: "ai", label: "Athena OS", detail: "Control all SpaceMountain apps" },
  { id: "private", label: "Memory", detail: "Save to Athena context" },
  { id: "twitch", label: "Twitch", detail: "Send through StreamWeaver" },
  { id: "discord", label: "Discord", detail: "Post through Discord routes" }
];
const voiceModes: { id: VoiceCommanderMode; label: string; detail: string }[] = [
  { id: "reply", label: "Reply loop", detail: "Listen, answer, reopen mic" },
  { id: "dictation", label: "Dictation", detail: "Long press sends speech" },
  { id: "translation", label: "Translation", detail: "Route live translated speech" }
];
const translationLanguages = ["Spanish", "French", "Japanese", "German"];

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
  const [activityLogs, setActivityLogs] = useState<ActivityLogRecord[]>([]);
  const [logFilter, setLogFilter] = useState<ActivityLogRecord["category"] | "all">("all");
  const [statusMessage, setStatusMessage] = useState("Ready. Leave owner password blank and tap Connect.");
  const [note, setNote] = useState("");
  const [deviceName, setDeviceName] = useState("Companion Tablet");
  const [pollInterval, setPollInterval] = useState("180");
  const [logoTestText, setLogoTestText] = useState("I see the StreamWeaver logo on my tablet");
  const [twitchTargetChannel, setTwitchTargetChannel] = useState("");
  const [visualContext, setVisualContext] = useState("No visual target locked yet.");
  const [qrPayload, setQrPayload] = useState("mountainview://avatar/room-anchor/default");
  const [voicePrompt, setVoicePrompt] = useState("Hey Athena open my SpaceMountain apps and tell me what needs attention.");
  const [voiceDestination, setVoiceDestination] = useState<VoiceDestination>("ai");
  const [voiceMode, setVoiceMode] = useState<VoiceCommanderMode>("reply");
  const [translationLanguage, setTranslationLanguage] = useState("Spanish");
  const [replyLoopActive, setReplyLoopActive] = useState(false);
  const [bleDevices, setBleDevices] = useState<BleScanDevice[]>([]);
  const [bleAutoConnectState, setBleAutoConnectState] = useState("Not armed");
  const [mediaCommandMode, setMediaCommandMode] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [wakeListenerActive, setWakeListenerActive] = useState(false);
  const [streamCommandListenerActive, setStreamCommandListenerActive] = useState(false);
  const [glassesStatus, setGlassesStatus] = useState<Record<string, unknown>>({
    state: "not checked",
    flashControlSupported: false
  });
  const mediaCommandModeRef = useRef(false);
  const tokenRef = useRef("");
  const voicePromptRef = useRef(voicePrompt);
  const lastMediaTriggerRef = useRef(0);
  const lastBleAiTriggerRef = useRef(0);
  const autoBleAttemptedRef = useRef(false);
  const wakeListenerActiveRef = useRef(false);
  const streamCommandListenerActiveRef = useRef(false);
  const replyLoopActiveRef = useRef(false);
  const lastToneAtRef = useRef<Record<string, number>>({});

  const connected = token.length > 0;
  const commandMap = useMemo(() => new Map(commands.map((command) => [command.id, command])), [commands]);
  const visibleActivityLogs = useMemo(() => {
    return logFilter === "all" ? activityLogs : activityLogs.filter((item) => item.category === logFilter);
  }, [activityLogs, logFilter]);

  function appendActivityLog(category: ActivityLogRecord["category"], title: string, status: string, detail: unknown) {
    const record: ActivityLogRecord = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      category,
      title,
      status,
      detail: typeof detail === "string" ? detail : JSON.stringify(detail, null, 2),
      createdAt: new Date().toISOString()
    };
    setActivityLogs((current) => [record, ...current].slice(0, 250));
  }

  function announce(message: string) {
    setStatusMessage(message);
    setLog(message);
    appendActivityLog("system", "Status", "info", message);
  }

  function reportError(action: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setStatusMessage(`${action} failed: ${message}`);
    setLog(`${action} failed\n${message}`);
    appendActivityLog("system", action, "error", message);
    Alert.alert(`${action} failed`, message);
  }

  function reportSoftError(action: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setStatusMessage(`${action} failed: ${message}`);
    setLog((current) => `${action} failed\n${message}\n\n${current}`);
    appendActivityLog("system", action, "error", message);
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
    const timer = setTimeout(() => {
      void autoArmGlassesBridge("startup");
    }, 1200);
    return () => clearTimeout(timer);
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

  useEffect(() => {
    const subscription = addBleButtonListener((event) => {
      void handleBleButtonEvent(event);
    });
    return () => subscription.remove();
  }, []);

  async function request(path: string, options: RequestInit = {}, authToken = token) {
    const startedAt = Date.now();
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
    appendActivityLog("api", `${options.method ?? "GET"} ${path}`, response.ok && !data.error ? "success" : "error", {
      status: response.status,
      durationMs: Date.now() - startedAt,
      response: data.error ? { error: data.error } : data
    });
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

  function extractTwitchChannel(text: string) {
    const normalized = String(text || "").trim();
    const twitchUrl = normalized.match(/(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([a-z0-9_]{3,25})/i);
    if (twitchUrl?.[1]) return twitchUrl[1].toLowerCase();
    const watching = normalized.match(/\b(?:watching|on|in)\s+@?([a-z0-9_]{3,25})(?:'s)?\s+(?:twitch\s+)?(?:stream|chat)\b/i);
    if (watching?.[1]) return watching[1].toLowerCase();
    const known = normalized.match(/\b(mamafeisty|mtman1987)\b/i);
    return known?.[1]?.toLowerCase() ?? "";
  }

  function updateVisualTargetFromText(text: string, source: string) {
    const channel = extractTwitchChannel(text);
    if (channel) {
      setTwitchTargetChannel(channel);
      setVisualContext(`Twitch target locked from ${source}: ${channel}`);
      return channel;
    }
    if (text.trim()) setVisualContext(`${source}: ${text.trim().slice(0, 220)}`);
    return "";
  }

  async function playTone(name: string, options: { force?: boolean } = {}) {
    try {
      const now = Date.now();
      const minGapMs = name === "listen" || name === "ready" ? 1800 : 900;
      if (!options.force && now - (lastToneAtRef.current[name] ?? 0) < minGapMs) return;
      lastToneAtRef.current[name] = now;
      await metaWearables.playTone(name);
    } catch {
      // Tone feedback is best-effort; command flow should keep working without it.
    }
  }

  async function speakText(text: string) {
    try {
      await metaWearables.prepareLocalVoiceOutput();
    } catch {
      // Local routing is best-effort; Expo speech can still use the active Android output route.
    }
    return new Promise<void>((resolve) => {
      const spokenText = text.trim();
      if (!spokenText) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        Speech.stop();
        Speech.speak(spokenText, {
          onDone: finish,
          onStopped: finish,
          onError: finish
        });
        setTimeout(finish, Math.max(2500, Math.min(18000, spokenText.length * 75)));
      } catch {
        finish();
      }
    });
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

  async function runCommand(commandId: string, message = "MountainView mobile trigger", destination: VoiceDestination = voiceDestination, options: { speakReply?: boolean; visualContextOverride?: string } = {}) {
    try {
      const lockedVisualContext = options.visualContextOverride ?? visualContext;
      const intent = parseVoiceCommandForDate(message);
      const shouldUseParsedIntent = commandId === "cmd_streamweaver_voice_commander" || commandId === "cmd_dsh_calendar_add_mission";
      const forcedVoiceMode = typeof intent.metadata.forceVoiceMode === "string" ? intent.metadata.forceVoiceMode as VoiceCommanderMode : undefined;
      const effectiveVoiceMode = forcedVoiceMode ?? voiceMode;
      const outboundMessage = intent.intent === "direct-message" ? intent.cleanedText : message;
      if (shouldUseParsedIntent && intent.commandId === "local_flashlight") {
        appendActivityLog("voice", "Voice intent", intent.intent, intent);
        await requestGlassesFlashlight();
        return { ok: true, local: true, intent };
      }
      const actualCommandId = shouldUseParsedIntent ? intent.commandId : commandId;
      const actualDestination = shouldUseParsedIntent ? intent.destination : destination;
      if (commandId === "cmd_streamweaver_voice_commander") {
        const routeData = await request("/voice/route", {
          method: "POST",
          body: JSON.stringify({
            transcript: message,
            context: {
              destination,
              voiceMode,
              tenantId: "94371378",
              username: "mtman1987",
              channel: twitchTargetChannel.trim() || extractTwitchChannelFromVisualContext(lockedVisualContext) || "mtman1987",
              visualContext: lockedVisualContext,
              translation: {
                enabled: voiceMode === "translation",
                language: translationLanguage
              },
              source: "mountainview-mobile"
            }
          })
        });
        setLog(JSON.stringify(routeData, null, 2));
        appendActivityLog("voice", "Voice route", String(routeData.decision?.mode ?? "routed"), routeData.decision ?? routeData);
        const reply = commandReplyText(routeData.result ?? routeData);
        if (routeData.decision?.mode === "action") await playTone("command");
        if (options.speakReply ?? true) {
          await speakText(reply || (routeData.ok ? "Command routed." : "Command failed."));
        }
        return routeData;
      }
      announce(`Sending command ${actualCommandId}...`);
      appendActivityLog(intent.intent === "calendar" ? "calendar" : "voice", "Voice intent", intent.intent, intent);
      const command = commandMap.get(actualCommandId);
      const translationEnabled = effectiveVoiceMode === "translation";
      const selectedChannel = actualDestination === "twitch"
        ? (intent.twitchChannel || twitchTargetChannel.trim() || extractTwitchChannelFromVisualContext(lockedVisualContext) || "mtman1987")
        : "mtman1987";
      const voicePayload = {
        message: outboundMessage,
        transcript: outboundMessage,
        destination: actualDestination,
        tenantId: "94371378",
        username: "mtman1987",
        channel: selectedChannel,
        visualContext: lockedVisualContext,
        dispatch: actualDestination === "twitch",
        source: "mountainview-mobile",
        voiceMode: effectiveVoiceMode,
        intent: intent.intent,
        parsedDate: intent.date,
        parsedTime: intent.time,
        ...intent.metadata,
        translation: {
          enabled: translationEnabled,
          language: translationLanguage
        }
      };
      const data = await request("/commands/execute", {
        method: "POST",
        body: JSON.stringify({
          commandId: actualCommandId,
          payload: {
            ...voicePayload,
            destination: actualDestination,
            wakeWord: message.toLowerCase().startsWith("hey annie") ? "hey annie" : "hey athena",
            payload: voicePayload
          }
        })
      });
      setLog(`${command?.name ?? actualCommandId}\n${JSON.stringify(data, null, 2)}`);
      setStatusMessage(`${command?.name ?? actualCommandId} sent.`);
      const reply = commandReplyText(data);
      if (data.command) await playTone("command");
      else if (data.dispatched) await playTone("dispatch");
      if (options.speakReply ?? true) {
        await speakText(reply || (data.ok ? "Command sent." : "Command failed."));
      }
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

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function extractTwitchChannelFromVisualContext(text: string) {
    const direct = text.match(/(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([a-z0-9_]{3,25})/i);
    if (direct?.[1]) return direct[1].toLowerCase();
    const named = text.match(/\b(?:watching|locked|target|channel)\s+@?([a-z0-9_]{3,25})(?:'s)?\s+(?:twitch\s+)?(?:stream|chat)\b/i);
    return named?.[1]?.toLowerCase() ?? "";
  }

  function chooseGlassesDevice(devices: BleScanDevice[], preferredAddress?: string) {
    const normalizedPreferred = preferredAddress?.trim().toUpperCase();
    return devices.find((device) => device.address?.toUpperCase() === normalizedPreferred)
      ?? devices.find((device) => device.address?.toUpperCase() === defaultAimbAddress)
      ?? devices.find((device) => `${device.name ?? ""} ${device.kindHint ?? ""}`.toLowerCase().includes("aimb"))
      ?? devices.find((device) => `${device.name ?? ""} ${device.kindHint ?? ""}`.toLowerCase().includes("glass"));
  }

  async function armBleDevice(address: string, reason: string, showAlerts = false) {
    try {
      setBleAutoConnectState(`Connecting ${address}`);
      setStatusMessage(`Arming glasses bridge: ${reason}`);
      const connect = await metaWearables.connectGenericBleDevice(address);
      await SecureStore.setItemAsync(bleLastDeviceKey, address);
      setGlassesStatus((current) => ({
        ...current,
        state: "ble-connecting",
        bleAddress: address,
        bleReason: reason
      }));
      setLog(JSON.stringify({ reason, connect }, null, 2));
      await sleep(1800);
      const services = await metaWearables.discoverGenericBleServices().catch((error) => ({ state: "discover-skipped", error: String(error) }));
      await sleep(1200);
      const notifications = await metaWearables.subscribeGenericBleNotifications().catch((error) => ({ state: "subscribe-skipped", error: String(error) }));
      setGlassesStatus((current) => ({
        ...current,
        state: "ble-armed",
        bleAddress: address,
        notifications
      }));
      setBleAutoConnectState("AiMB bridge armed");
      setStatusMessage("AiMB bridge armed. Glasses button events are subscribed.");
      setLog(JSON.stringify({ reason, connect, services, notifications }, null, 2));
      appendActivityLog("ble", "AiMB bridge armed", "armed", { reason, address, connect, services, notifications });
      await trackMobileEvent("ble-auto-arm", { reason, address, connect, services, notifications }, "armed");
      return true;
    } catch (error) {
      setBleAutoConnectState("Auto-arm failed");
      if (showAlerts) reportError("Arm glasses bridge", error);
      else reportSoftError("Auto arm glasses bridge", error);
      return false;
    }
  }

  async function autoArmGlassesBridge(reason = "manual") {
    if (reason === "startup" && autoBleAttemptedRef.current) return;
    if (reason === "startup") autoBleAttemptedRef.current = true;
    try {
      setBleAutoConnectState("Checking Bluetooth");
      setStatusMessage("Checking for paired AiMB glasses...");
      const permission = await metaWearables.requestBleResearchPermissions();
      const bonded = await metaWearables.getBondedBluetoothDevices();
      const devices = Array.isArray(bonded.devices) ? bonded.devices as BleScanDevice[] : [];
      setBleDevices(devices);
      const storedAddress = await SecureStore.getItemAsync(bleLastDeviceKey);
      const candidate = chooseGlassesDevice(devices, storedAddress ?? defaultAimbAddress);
      const address = candidate?.address ?? storedAddress ?? defaultAimbAddress;
      setLog(JSON.stringify({ reason, permission, pairedCount: devices.length, candidate, address }, null, 2));
      if (!address) {
        setBleAutoConnectState("No glasses found");
        setStatusMessage("No paired AiMB glasses found. Pair once, then MountainView can auto-arm.");
        return false;
      }
      return await armBleDevice(address, reason, false);
    } catch (error) {
      setBleAutoConnectState("Auto-arm unavailable");
      reportSoftError("Auto arm glasses bridge", error);
      return false;
    }
  }

  async function handleMediaButtonEvent(event: Record<string, unknown>) {
    const keyName = String(event.keyName ?? "UNKNOWN_BUTTON");
    const now = Date.now();
    appendActivityLog("ble", "Media button", keyName, event);
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

  async function handleBleButtonEvent(event: Record<string, unknown>) {
    const action = String(event.action ?? "unknown");
    const now = Date.now();
    appendActivityLog("ble", "BLE button", action, event);
    setLog((current) => `BLE glasses button event\n${JSON.stringify(event, null, 2)}\n\n${current}`);
    await trackMobileEvent("ble-button", { event }, action);
    if (action !== "ai-talk-tap" && action !== "ai-talk-long-start") return;
    if (now - lastBleAiTriggerRef.current < 2500) return;
    lastBleAiTriggerRef.current = now;
    if (action === "ai-talk-long-start") {
      setStatusMessage("Glasses long press captured. Toggling StreamWeaver command gate...");
      if (voiceMode === "reply") setVoiceMode("dictation");
      if (streamCommandListenerActiveRef.current) stopStreamWeaverCommandListener();
      else void startStreamWeaverCommandListener();
      return;
    }
    setStatusMessage("Glasses AI button captured over BLE. Listening for one Athena command...");
    void listenAndRunVoiceCommander(`Hey Athena glasses AI button pressed. ${voicePromptRef.current}`);
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

  async function pickImageBase64(action: string) {
    announce(`Opening image picker for ${action}...`);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      base64: true,
      quality: 0.8
    });
    if (result.canceled) return "";
    return result.assets[0]?.base64 ?? "";
  }

  async function smartVisionCapture(savePerson = false) {
    try {
      const imageBase64 = await pickImageBase64(savePerson ? "profile memory" : "smart vision");
      if (!imageBase64) {
        setStatusMessage("Vision capture canceled.");
        return;
      }
      announce("Running MountainView smart vision capture...");
      const data = await request("/vision/smart-capture", {
        method: "POST",
        body: JSON.stringify({
          imageBase64,
          message: voicePrompt,
          savePerson,
          displayName: savePerson ? voicePrompt.replace(/^.*(?:about|person|meeting with)\s+/i, "").trim() : "",
          providers: "google,amazon"
        })
      });
      setLog(JSON.stringify(data, null, 2));
      updateVisualTargetFromText(JSON.stringify(data), "smart vision");
      setStatusMessage(data.reply ?? "Smart vision capture complete.");
      await speakText(data.reply ?? "Smart vision capture complete.");
    } catch (error) {
      reportError("Smart vision capture", error);
    }
  }

  async function savePersonProfileFromPrompt() {
    try {
      announce("Saving person profile memory...");
      const data = await request("/people/remember", {
        method: "POST",
        body: JSON.stringify({
          displayName: voicePrompt.replace(/^.*(?:about|person|meeting with|remember)\s+/i, "").trim() || "Stream contact",
          notes: voicePrompt,
          topics: ["meeting", "stream", "follow-up"],
          reminders: [{ kind: "follow-up", when: voicePrompt.toLowerCase().includes("tomorrow") ? "tomorrow" : "", note: voicePrompt }]
        })
      });
      setLog(JSON.stringify(data, null, 2));
      setStatusMessage("Person profile memory saved.");
      await load();
    } catch (error) {
      reportError("Save person profile", error);
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
      reportError("Bridge status", error);
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
      announce("Sending RDGlass flashlight diagnostic with retries...");
      const result = await toggleFlashlight(true, { retries: 3, settleMs: 260 });
      setLog(JSON.stringify(result, null, 2));
      appendActivityLog("flashlight", "Flashlight request", result.ok ? "accepted" : "unsupported", result);
      await trackMobileEvent("flashlight", result, result.ok ? "accepted" : "unsupported");
      setStatusMessage(`RDGlass flashlight diagnostic: ${String(result.state ?? (result.ok ? "accepted" : "checked"))}`);
    } catch (error) {
      reportError("Flashlight", error);
    }
  }

  async function testRdGlassCamera() {
    try {
      announce("Sending RDGlass camera diagnostic...");
      const result = await metaWearables.testRdGlassCamera();
      setLog(JSON.stringify(result, null, 2));
      setStatusMessage(`RDGlass camera diagnostic: ${String(result.state ?? "checked")}`);
    } catch (error) {
      reportError("RDGlass camera diagnostic", error);
    }
  }

  async function triggerRdGlassVisualQa() {
    try {
      announce("Triggering RDGlass VisualQA intent...");
      const result = await metaWearables.triggerRdGlassIntent(1);
      setLog(JSON.stringify(result, null, 2));
      setStatusMessage(`RDGlass VisualQA trigger: ${String(result.state ?? "checked")}`);
    } catch (error) {
      reportError("RDGlass VisualQA", error);
    }
  }

  async function triggerRdGlassPhotoRecognition() {
    try {
      announce("Triggering RDGlass photo recognition intent...");
      const result = await metaWearables.triggerRdGlassIntent(2);
      setLog(JSON.stringify(result, null, 2));
      setStatusMessage(`RDGlass photo recognition trigger: ${String(result.state ?? "checked")}`);
    } catch (error) {
      reportError("RDGlass photo recognition", error);
    }
  }

  async function enableRdGlassImageTriggers() {
    try {
      announce("Enabling RDGlass image AI media triggers...");
      const photo = await metaWearables.setRdGlassMediaTrigger(1, true);
      const recognize = await metaWearables.setRdGlassMediaTrigger(4, true);
      const ai = await metaWearables.setRdGlassMediaTrigger(5, true);
      const result = { photo, recognize, ai };
      setLog(JSON.stringify(result, null, 2));
      setStatusMessage("RDGlass photo, recognize, and AI media triggers requested.");
    } catch (error) {
      reportError("RDGlass media triggers", error);
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
      announce(`Connecting and arming BLE device ${address}...`);
      const armed = await armBleDevice(address, "manual", true);
      await request("/glasses/media-event", {
        method: "POST",
        body: JSON.stringify({ kind: "ble-connect", source: "rdglass-research", targetApp: "streamweaver", metadata: { address, armed } })
      });
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

  async function subscribeGenericBleNotifications() {
    try {
      announce("Subscribing to BLE button/audio notifications...");
      const result = await metaWearables.subscribeGenericBleNotifications();
      setLog(JSON.stringify(result, null, 2));
      setStatusMessage("BLE notifications subscribed. Press the glasses AI/talk button, then load the BLE log.");
    } catch (error) {
      reportError("BLE notification subscribe", error);
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

  async function listenAndRunVoiceCommander(fallbackPrompt = voicePrompt, visualContextOverride?: string) {
    try {
      setIsListening(true);
      announce("Listening for Athena command...");
      await playTone("listen");
      const speech = await metaWearables.recognizeSpeechOnce();
      setLog(JSON.stringify(speech, null, 2));
      const transcript = String(speech.transcript ?? "").trim();
      if (!transcript) {
        setStatusMessage("No speech recognized. Sending the typed prompt instead.");
        await playTone("stop");
        await runCommand("cmd_streamweaver_voice_commander", fallbackPrompt, voiceDestination, { visualContextOverride });
        return;
      }
      await playTone("capture");
      setVoicePrompt(transcript);
      await trackMobileEvent("speech-recognition", speech, "recognized");
      await runCommand("cmd_streamweaver_voice_commander", transcript, voiceDestination, { visualContextOverride });
    } catch (error) {
      reportError("Listen and ask Athena", error);
    } finally {
      setIsListening(false);
    }
  }

  async function startReplyLoop(source = "manual") {
    if (replyLoopActiveRef.current) return;
    replyLoopActiveRef.current = true;
    setReplyLoopActive(true);
    setVoiceMode("reply");
    let turns = 0;
    const maxTurns = 10;
    setStatusMessage("Reply loop active. Speak after the tone, then pause.");
    setLog(`Reply loop started from ${source}.`);

    while (replyLoopActiveRef.current && turns < maxTurns) {
      try {
        setIsListening(true);
        const pauseHint = turns === 0 ? "Listening for your first message..." : "Listening for your reply...";
        setStatusMessage(pauseHint);
        await playTone(turns === 0 ? "listen" : "ready");
        const speech = await metaWearables.recognizeSpeechOnce();
        const transcript = String(speech.transcript ?? "").trim();
        setLog((current) => `Reply loop turn ${turns + 1}\n${JSON.stringify(speech, null, 2)}\n\n${current}`);
        if (!transcript) {
          setStatusMessage(turns === 0 ? "No speech recognized. Reply loop stopped." : "No reply heard. Reply loop stopped.");
          await playTone("stop");
          break;
        }
        await playTone("capture");
        setVoicePrompt(transcript);
        await trackMobileEvent("reply-loop-speech", { source, turn: turns + 1, ...speech }, "recognized");
        setStatusMessage("Sending to Athena...");
        await runCommand("cmd_streamweaver_voice_commander", transcript, voiceDestination, { speakReply: true });
        turns += 1;
        if (!replyLoopActiveRef.current) break;
        setStatusMessage("Athena finished. Reply when ready, or stay quiet to stop.");
        await playTone("ready");
        await delay(turns === 1 ? 1200 : 2200);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLog((current) => `Reply loop failed: ${message}\n${current}`);
        setStatusMessage("Reply loop hit an error and stopped.");
        break;
      } finally {
        setIsListening(false);
      }
    }

    replyLoopActiveRef.current = false;
    setReplyLoopActive(false);
    setIsListening(false);
  }

  function stopReplyLoop() {
    replyLoopActiveRef.current = false;
    setReplyLoopActive(false);
    setIsListening(false);
    Speech.stop();
    void playTone("stop");
    setStatusMessage("Reply loop stopped.");
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
          await playTone("capture");
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

  async function startStreamWeaverCommandListener() {
    if (streamCommandListenerActiveRef.current) return;
    streamCommandListenerActiveRef.current = true;
    setStreamCommandListenerActive(true);
    setStatusMessage("StreamWeaver command listener active. Spoken phrases will be routed like trusted stream commands.");
    setLog("StreamWeaver command listener active. Try: be right back, !brb, shoutout mtman, or Athena plus a question.");
    await playTone("listen", { force: true });

    while (streamCommandListenerActiveRef.current) {
      try {
        setIsListening(true);
        const speech = await metaWearables.recognizeSpeechOnce();
        const transcript = String(speech.transcript ?? "").trim();
        if (transcript) {
          await playTone("capture");
          setVoicePrompt(transcript);
          await trackMobileEvent("streamweaver-command-listener-speech", speech, "recognized");
          setStatusMessage(`Sending spoken command: ${transcript}`);
          await runCommand("cmd_streamweaver_voice_commander", transcript, "twitch");
        } else {
          setStatusMessage("StreamWeaver command listener active...");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLog((current) => `StreamWeaver command listener cycle failed: ${message}\n${current}`);
        setStatusMessage("StreamWeaver command listener still active; retrying...");
      } finally {
        setIsListening(false);
      }
      await delay(800);
    }
    setStatusMessage("StreamWeaver command listener stopped.");
  }

  function stopStreamWeaverCommandListener() {
    streamCommandListenerActiveRef.current = false;
    setStreamCommandListenerActive(false);
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
      const intervalSeconds = Number(pollInterval);
      await request("/polling-profiles", {
        method: "POST",
        body: JSON.stringify({
          name: "Visual trigger scan",
          intervalSeconds,
          batteryMode: intervalSeconds <= 30 ? "high-power" : intervalSeconds >= 180 ? "battery-saver" : "balanced",
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
      updateVisualTargetFromText(`${logoTestText}\n${JSON.stringify(data)}`, "logo route");
      setStatusMessage(data.matched ? "Logo route matched." : "No logo route matched.");
      Speech.speak(data.matched ? "Logo route matched." : "No logo route matched.");
      await load();
    } catch (error) {
      reportError("Logo route test", error);
    }
  }

  function commandForLogo(profile: LogoProfile) {
    return commandMap.get(profile.command_id);
  }

  function logoInitials(name: string) {
    return name
      .split(/\s+|\/|-/)
      .map((part) => part.trim()[0])
      .filter(Boolean)
      .join("")
      .slice(0, 3)
      .toUpperCase();
  }

  function logoAccent(appId: string) {
    const accents: Record<string, string> = {
      streamweaver: "#22d3ee",
      hearmeout: "#f97316",
      discordstreamhub: "#8b5cf6",
      "chat-tag": "#32d583",
      edenai: "#f43f5e",
      spmt: "#eab308",
      twitch: "#a78bfa",
      discord: "#60a5fa"
    };
    return accents[appId] ?? "#20d5ff";
  }

  function logoVisualContext(profile: LogoProfile) {
    const command = commandForLogo(profile);
    return `Visual target locked: ${profile.name} logo. App=${profile.app_id}. Command=${profile.command_id}. Endpoint=${command?.method ?? "POST"} ${command?.url_template ?? "unknown"}.`;
  }

  function lockLogoTarget(profile: LogoProfile) {
    const context = logoVisualContext(profile);
    setLogoTestText(`I am looking at the ${profile.name} logo`);
    setVisualContext(context);
    setStatusMessage(`${profile.name} locked as the visual command target.`);
    appendActivityLog("vision", "Logo target locked", profile.app_id, context);
  }

  async function listenWithLogoTarget(profile: LogoProfile) {
    const context = logoVisualContext(profile);
    lockLogoTarget(profile);
    await listenAndRunVoiceCommander(`I am looking at the ${profile.name} logo. ${voicePromptRef.current}`, context);
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
              <View style={styles.heroPanel}>
                <View style={styles.kickerRow}>
                  <Text style={styles.label}>Voice commander</Text>
                  <View style={[styles.statusPill, replyLoopActive ? styles.statusPillActive : undefined]}>
                    <Ionicons name={replyLoopActive ? "mic" : "mic-outline"} size={14} color={replyLoopActive ? "#071018" : "#22d3ee"} />
                    <Text style={[styles.statusPillText, replyLoopActive ? styles.statusPillTextActive : undefined]}>{replyLoopActive ? "Reply loop" : bleAutoConnectState}</Text>
                  </View>
                </View>
                <Text style={styles.heroTitle}>Glasses to Athena command bridge</Text>
                <Text style={styles.heroCopy}>Tap the AiMB talk button once to speak, hear Athena, then answer back without repeating the wake word. Athena OS routes cross-app commands through SPMT, while StreamWeaver, DiscordStreamHub, Chat-Tag, and HearMeOut keep owning their own actions.</Text>
                <View style={styles.routeGrid}>
                  {voiceRoutes.map((route) => (
                    <Pressable key={route.id} style={[styles.routeCard, voiceDestination === route.id && styles.routeCardActive]} onPress={() => setVoiceDestination(route.id)}>
                      <Text style={styles.routeLabel}>{route.label}</Text>
                      <Text style={styles.routeDetail}>{route.detail}</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.inlineOptions}>
                  {voiceModes.map((mode) => (
                    <Pressable key={mode.id} style={[styles.modeChip, voiceMode === mode.id && styles.modeChipActive]} onPress={() => setVoiceMode(mode.id)}>
                      <Text style={styles.modeChipText}>{mode.label}</Text>
                    </Pressable>
                  ))}
                </View>
                {voiceMode === "translation" && (
                  <View style={styles.inlineOptions}>
                    {translationLanguages.map((language) => (
                      <Pressable key={language} style={[styles.optionChip, translationLanguage === language && styles.optionChipActive]} onPress={() => setTranslationLanguage(language)}>
                        <Text style={styles.optionChipText}>{language}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
                <TextInput value={voicePrompt} onChangeText={setVoicePrompt} placeholder="Hey Athena ..." placeholderTextColor="#7f8ca8" style={styles.input} />
                <View style={styles.targetPanel}>
                  <View style={styles.targetHeader}>
                    <Ionicons name="logo-twitch" size={16} color="#a78bfa" />
                    <Text style={styles.targetTitle}>Twitch visual target</Text>
                  </View>
                  <TextInput
                    value={twitchTargetChannel}
                    onChangeText={(value) => {
                      setTwitchTargetChannel(value.replace(/^#|^@/, "").trim().toLowerCase());
                      setVisualContext(value.trim() ? `Manual Twitch target: ${value.trim()}` : "No visual target locked yet.");
                    }}
                    placeholder="mamafeisty"
                    placeholderTextColor="#7f8ca8"
                    autoCapitalize="none"
                    style={styles.input}
                  />
                  <Text style={styles.note}>{visualContext}</Text>
                </View>
                <View style={styles.actionRow}>
                  <Pressable style={[styles.primaryButton, styles.actionButton]} onPress={replyLoopActive ? stopReplyLoop : () => startReplyLoop("manual-button")}>
                    <Text style={styles.primaryButtonText}>{replyLoopActive ? "Stop reply loop" : "Start reply loop"}</Text>
                  </Pressable>
                  <Pressable style={[styles.secondaryButton, styles.actionButton]} onPress={() => listenAndRunVoiceCommander()}>
                    <Text style={styles.secondaryButtonText}>{isListening ? "Listening..." : "Listen once"}</Text>
                  </Pressable>
                </View>
                <View style={styles.actionRow}>
                  <Pressable style={[styles.secondaryButton, styles.actionButton]} onPress={askStreamWeaverVoiceCommander}>
                    <Text style={styles.secondaryButtonText}>Route typed prompt</Text>
                  </Pressable>
                  <Pressable style={[styles.secondaryButton, styles.actionButton]} onPress={() => runCommand("cmd_spmt_athena_command", voicePrompt)}>
                    <Text style={styles.secondaryButtonText}>Ask Athena OS</Text>
                  </Pressable>
                </View>
                <View style={styles.actionRow}>
                  <Pressable style={[styles.secondaryButton, styles.actionButton]} onPress={() => runCommand("cmd_spmt_athena_search", voicePrompt)}>
                    <Text style={styles.secondaryButtonText}>Search Athena</Text>
                  </Pressable>
                  <Pressable style={[styles.secondaryButton, styles.actionButton]} onPress={() => runCommand("cmd_spmt_apps", "What apps can I control?")}>
                    <Text style={styles.secondaryButtonText}>List apps</Text>
                  </Pressable>
                </View>
                <View style={styles.actionRow}>
                  <Pressable style={[streamCommandListenerActive ? styles.dangerButton : styles.secondaryButton, styles.actionButton]} onPress={streamCommandListenerActive ? stopStreamWeaverCommandListener : startStreamWeaverCommandListener}>
                    <Text style={streamCommandListenerActive ? styles.dangerButtonText : styles.secondaryButtonText}>{streamCommandListenerActive ? "Stop gate" : "Arm command gate"}</Text>
                  </Pressable>
                </View>
                <View style={styles.buttonMap}>
                  <View style={styles.buttonMapItem}>
                    <Ionicons name="radio" size={18} color="#22d3ee" />
                    <Text style={styles.buttonMapTitle}>AI tap</Text>
                    <Text style={styles.buttonMapText}>Reply loop with Athena</Text>
                  </View>
                  <View style={styles.buttonMapItem}>
                    <Ionicons name="finger-print" size={18} color="#8b5cf6" />
                    <Text style={styles.buttonMapTitle}>AI long press</Text>
                    <Text style={styles.buttonMapText}>StreamWeaver command gate</Text>
                  </View>
                  <View style={styles.buttonMapItem}>
                    <Ionicons name="camera" size={18} color="#34d399" />
                    <Text style={styles.buttonMapTitle}>Image button</Text>
                    <Text style={styles.buttonMapText}>Next map: image/video relay</Text>
                  </View>
                </View>
              </View>
              <View style={styles.grid}>
                <StatusCard label="Glasses" value={String(glassesStatus.state ?? "native bridge")} tone="warn" detail="Android BLE, media-button, speech, and RDGlass research bridge." />
                <StatusCard label="Image AI" value="Relay only" tone="good" detail="No face recognition in MountainView AI." />
                <StatusCard label="Streaming" value="Control ready" detail="Start/stop/overlay triggers are prepared." />
                <StatusCard label="Flash" value="RD test found" tone="warn" detail="RDGlass exposes BKTestFlashlight, not a confirmed steady torch toggle." />
              </View>
              <View style={styles.panel}>
                <Text style={styles.label}>AiMB / RDGlass bridge</Text>
                <Text style={styles.note}>These glasses are handled through Android-native Bluetooth, BLE notifications, media buttons, speech recognition, and RDGlass command research. No Meta SDK is required for this hardware path.</Text>
                <Pressable style={styles.primaryButton} onPress={checkGlassesSdk}><Text style={styles.primaryButtonText}>Bridge status</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={registerGlasses}><Text style={styles.secondaryButtonText}>Register glasses</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={captureGlassesPhoto}><Text style={styles.secondaryButtonText}>Capture glasses photo</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={requestGlassesFlashlight}><Text style={styles.secondaryButtonText}>Test RDGlass flashlight</Text></Pressable>
              </View>
              <View style={styles.panel}>
                <Text style={styles.label}>RDGlass / AiMB research</Text>
                <Text style={styles.note}>MountainView now auto-arms the last AiMB glasses connection on app open. These controls are for recovery and button-mapping research.</Text>
                <View style={styles.hintBox}>
                  <Text style={styles.memoryTitle}>Bridge status</Text>
                  <Text style={styles.memoryBody}>{bleAutoConnectState}</Text>
                <Text style={styles.memoryBody}>{String(glassesStatus.bleAddress ?? defaultAimbAddress)}</Text>
              </View>
              <Pressable style={styles.primaryButton} onPress={() => autoArmGlassesBridge("manual")}><Text style={styles.primaryButtonText}>Auto-connect AiMB glasses</Text></Pressable>
              <Pressable style={styles.primaryButton} onPress={requestBleResearchPermissions}><Text style={styles.primaryButtonText}>Grant BLE permissions</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={requestGlassesFlashlight}><Text style={styles.secondaryButtonText}>Test RDGlass flashlight</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={testRdGlassCamera}><Text style={styles.secondaryButtonText}>Test RDGlass camera</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={triggerRdGlassVisualQa}><Text style={styles.secondaryButtonText}>Trigger VisualQA</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={triggerRdGlassPhotoRecognition}><Text style={styles.secondaryButtonText}>Trigger photo recognition</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={enableRdGlassImageTriggers}><Text style={styles.secondaryButtonText}>Enable image AI triggers</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={loadBondedBluetoothDevices}><Text style={styles.secondaryButtonText}>Load paired Bluetooth devices</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={scanGenericBleDevices}><Text style={styles.secondaryButtonText}>Scan nearby BLE devices</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={discoverGenericBleServices}><Text style={styles.secondaryButtonText}>Discover connected services</Text></Pressable>
                <Pressable style={styles.secondaryButton} onPress={subscribeGenericBleNotifications}><Text style={styles.secondaryButtonText}>Subscribe BLE notifications</Text></Pressable>
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
                <Text style={styles.label}>Wake and media debug</Text>
                <Text style={styles.note}>Keep these controls for testing Android wake permissions, media-button interception, and the older continuous listener while the BLE button map gets filled in.</Text>
                <Pressable style={wakeListenerActive ? styles.dangerButton : styles.primaryButton} onPress={wakeListenerActive ? stopWakeListener : startWakeListener}>
                  <Text style={wakeListenerActive ? styles.dangerButtonText : styles.primaryButtonText}>{wakeListenerActive ? "Stop Hey Athena listener" : "Start Hey Athena listener"}</Text>
                </Pressable>
                <Pressable style={mediaCommandMode ? styles.dangerButton : styles.primaryButton} onPress={mediaCommandMode ? stopMediaButtonCommandMode : startMediaButtonCommandMode}>
                  <Text style={mediaCommandMode ? styles.dangerButtonText : styles.primaryButtonText}>{mediaCommandMode ? "Stop media button mode" : "Start media button mode"}</Text>
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
                <CommandGroup title="SPMT / Athena OS" commands={commands.filter((command) => command.app_id === "spmt")} onRun={runCommand} />
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
                <Text style={styles.note}>Use Smart vision capture to lock the current Twitch stream/app context, then say things like send message "hello mama" while Twitch dictation is selected.</Text>
                <Pressable style={styles.primaryButton} onPress={() => smartVisionCapture(false)}><Text style={styles.primaryButtonText}>Smart vision capture</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => smartVisionCapture(true)}><Text style={styles.secondaryButtonText}>Capture and save profile</Text></Pressable>
              <Pressable style={styles.primaryButton} onPress={sendImageToStreamWeaver}><Text style={styles.primaryButtonText}>Send image/frame</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_streamweaver_image_generate", voicePrompt)}><Text style={styles.secondaryButtonText}>Generate StreamWeaver image</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_streamweaver_image_regenerate", voicePrompt)}><Text style={styles.secondaryButtonText}>Regenerate from context</Text></Pressable>
              <Text style={styles.note}>Images can be analyzed by EdenAI, saved as profile context, routed to a companion device, or generated through StreamWeaver.</Text>
            </View>
          )}

          {tab === "memory" && (
            <View style={styles.panel}>
              <Text style={styles.label}>AI memory</Text>
              <TextInput value={note} onChangeText={setNote} placeholder="Save note, context, image metadata, or app activity" placeholderTextColor="#7f8ca8" style={[styles.input, styles.textArea]} multiline />
              <Pressable style={styles.primaryButton} onPress={saveMemory}><Text style={styles.primaryButtonText}>Save memory</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={savePersonProfileFromPrompt}><Text style={styles.secondaryButtonText}>Save person profile</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => smartVisionCapture(true)}><Text style={styles.secondaryButtonText}>Profile from image</Text></Pressable>
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
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_stream_stop", "Stop stream")}><Text style={styles.secondaryButtonText}>Stop stream</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_stream_overlay", "Overlay event requested")}><Text style={styles.secondaryButtonText}>Trigger overlay/event</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_streamweaver_tts", voicePrompt || "Athena is live on stream.")}><Text style={styles.secondaryButtonText}>Athena speaks on stream</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_streamweaver_obs_scenes", "Read OBS scenes")}><Text style={styles.secondaryButtonText}>Read OBS scenes</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_streamweaver_overlay_data", "Show stream overlay data")}><Text style={styles.secondaryButtonText}>Read overlay data</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_spmt_athena_command", voicePrompt || "Open the SpaceMountain command bridge")}><Text style={styles.secondaryButtonText}>Athena OS command</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_spmt_athena_search", voicePrompt || "Search SpaceMountain context")}><Text style={styles.secondaryButtonText}>Search Athena context</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_spmt_apps", "List registered SPMT apps")}><Text style={styles.secondaryButtonText}>List registered apps</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_dsh_calendar_add_mission", voicePrompt || "Add MountainView reminder tomorrow", "discord")}><Text style={styles.secondaryButtonText}>Add DSH calendar date</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_dsh_calendar_post", "Post the DiscordStreamHub calendar", "discord")}><Text style={styles.secondaryButtonText}>Post DSH calendar</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_chat_tag_live_members", "Who is live in Chat-Tag?")}><Text style={styles.secondaryButtonText}>Who is live?</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_chat_tag_tag", voicePrompt || "tag scarlett")}><Text style={styles.secondaryButtonText}>Tag Chat-Tag player</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_hearmeout", "HearMeOut music session state")}><Text style={styles.secondaryButtonText}>HearMeOut session</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_hearmeout_voice_peers", "Who is in the HearMeOut room?")}><Text style={styles.secondaryButtonText}>HearMeOut room peers</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_hearmeout_song_request", voicePrompt)}><Text style={styles.secondaryButtonText}>Request HearMeOut song</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_hearmeout_music_control", voicePrompt || "play")}><Text style={styles.secondaryButtonText}>Control HearMeOut music</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_hearmeout_watch_request", voicePrompt || "Request a watch party item")}><Text style={styles.secondaryButtonText}>Request watch item</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => runCommand("cmd_hearmeout_watch_control", voicePrompt || "play")}><Text style={styles.secondaryButtonText}>Control watch party</Text></Pressable>
            </View>
          )}

          {tab === "logs" && (
            <View style={styles.panel}>
              <Text style={styles.label}>Activity logs</Text>
              <Text style={styles.note}>API calls, BLE signals, voice intents, calendar parsing, flashlight attempts, and vision actions are kept here for mapping the glasses.</Text>
              <View style={styles.inlineOptions}>
                {(["all", "api", "ble", "voice", "calendar", "flashlight", "vision", "system"] as const).map((category) => (
                  <Pressable key={category} style={[styles.optionChip, logFilter === category && styles.optionChipActive]} onPress={() => setLogFilter(category)}>
                    <Text style={styles.optionChipText}>{category}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.hintBox}>
                <Text style={styles.memoryTitle}>Latest raw output</Text>
                <Text style={styles.log}>{log}</Text>
              </View>
              {visibleActivityLogs.length === 0 ? (
                <Text style={styles.note}>No structured log records for this filter yet.</Text>
              ) : (
                visibleActivityLogs.map((item) => (
                  <View key={item.id} style={styles.logRow}>
                    <View style={styles.logRowHeader}>
                      <Text style={styles.logCategory}>{item.category}</Text>
                      <Text style={styles.logTime}>{new Date(item.createdAt).toLocaleTimeString()}</Text>
                    </View>
                    <Text style={styles.memoryTitle}>{item.title}</Text>
                    <Text style={styles.memoryBody}>{item.status}</Text>
                    <Text style={styles.logDetail}>{item.detail}</Text>
                  </View>
                ))
              )}
            </View>
          )}

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
              <Text style={styles.note}>Open this page on another screen, stare at one logo, press the glasses talk button, and Athena will receive that logo as the visual target.</Text>
              <TextInput value={logoTestText} onChangeText={setLogoTestText} placeholder="Detected logo or OCR text" placeholderTextColor="#7f8ca8" style={styles.input} />
              <Pressable style={styles.primaryButton} onPress={testLogoMatch}><Text style={styles.primaryButtonText}>Test logo route</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={saveLogoProfile}><Text style={styles.secondaryButtonText}>Add StreamWeaver logo profile</Text></Pressable>
              <View style={styles.logoBoard}>
                {logoProfiles.map((profile) => {
                  const command = commandForLogo(profile);
                  const accent = logoAccent(profile.app_id);
                  return (
                    <View key={profile.id} style={[styles.logoCard, { borderColor: accent }]}>
                      <Pressable style={[styles.logoMark, { backgroundColor: accent }]} onPress={() => lockLogoTarget(profile)}>
                        <Text style={styles.logoMarkText}>{logoInitials(profile.name)}</Text>
                      </Pressable>
                      <Text style={styles.logoTitle}>{profile.name}</Text>
                      <Text style={styles.logoMeta}>{profile.app_id}</Text>
                      <Text style={styles.logoEndpoint}>{command ? `${command.method} ${command.url_template}` : profile.command_id}</Text>
                      <Text style={styles.logoBody}>Command: {profile.command_id}</Text>
                      <Text style={styles.logoBody}>Needs: {(command?.requiredContext ?? ["message"]).join(", ")}</Text>
                      <View style={styles.actionRow}>
                        <Pressable style={[styles.secondaryButton, styles.actionButton]} onPress={() => lockLogoTarget(profile)}>
                          <Text style={styles.secondaryButtonText}>Lock</Text>
                        </Pressable>
                        <Pressable style={[styles.primaryButton, styles.actionButton]} onPress={() => listenWithLogoTarget(profile)}>
                          <Text style={styles.primaryButtonText}>Look + talk</Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })}
              </View>
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
  app: { flex: 1, backgroundColor: "#070812", paddingTop: 54 },
  header: { flexDirection: "row", gap: 12, alignItems: "center", paddingHorizontal: 18, paddingBottom: 16 },
  mark: { width: 40, height: 40, borderRadius: 10, backgroundColor: "#8b5cf6", borderWidth: 1, borderColor: "rgba(34,211,238,.55)" },
  title: { color: "#f8fbff", fontSize: 24, fontWeight: "900" },
  subtitle: { color: "#9fb1cc", fontSize: 13 },
  statusStrip: { marginHorizontal: 14, marginBottom: 10, padding: 10, borderRadius: 8, backgroundColor: "#0b1020", borderWidth: 1, borderColor: "rgba(32,213,255,.28)", flexDirection: "row", alignItems: "center", gap: 8 },
  statusStripText: { color: "#d9e8ff", fontSize: 13, lineHeight: 18, flex: 1 },
  content: { padding: 14, paddingBottom: 110, gap: 14 },
  panel: { margin: 14, padding: 16, borderRadius: 8, backgroundColor: "#111425", borderWidth: 1, borderColor: "rgba(255,255,255,.12)", gap: 12 },
  heroPanel: { margin: 14, padding: 14, borderRadius: 8, backgroundColor: "#111425", borderWidth: 1, borderColor: "rgba(34,211,238,.22)", gap: 10 },
  kickerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  statusPill: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: "rgba(34,211,238,.34)", backgroundColor: "rgba(34,211,238,.08)", maxWidth: "58%" },
  statusPillActive: { backgroundColor: "#22d3ee", borderColor: "#22d3ee" },
  statusPillText: { color: "#c9f7ff", fontSize: 11, fontWeight: "900" },
  statusPillTextActive: { color: "#071018" },
  heroTitle: { color: "#f8fafc", fontSize: 23, lineHeight: 28, fontWeight: "900" },
  heroCopy: { color: "#a8b0c3", fontSize: 13, lineHeight: 19 },
  routeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  routeCard: { width: "48.5%", minHeight: 68, borderRadius: 8, padding: 9, backgroundColor: "#171b31", borderWidth: 1, borderColor: "rgba(255,255,255,.12)" },
  routeCardActive: { borderColor: "#22d3ee", backgroundColor: "rgba(34,211,238,.12)" },
  routeLabel: { color: "#f8fafc", fontSize: 15, fontWeight: "900" },
  routeDetail: { color: "#a8b0c3", fontSize: 12, lineHeight: 16, marginTop: 4 },
  modeChip: { borderRadius: 8, paddingVertical: 9, paddingHorizontal: 11, backgroundColor: "#171b31", borderWidth: 1, borderColor: "rgba(255,255,255,.12)" },
  modeChipActive: { borderColor: "#8b5cf6", backgroundColor: "rgba(139,92,246,.22)" },
  modeChipText: { color: "#f8fafc", fontWeight: "900", fontSize: 12 },
  actionRow: { flexDirection: "row", gap: 8 },
  actionButton: { flex: 1 },
  buttonMap: { flexDirection: "row", gap: 8 },
  buttonMapItem: { flex: 1, minHeight: 92, borderRadius: 8, padding: 9, backgroundColor: "#0b1020", borderWidth: 1, borderColor: "rgba(255,255,255,.12)", gap: 5 },
  buttonMapTitle: { color: "#f8fafc", fontWeight: "900", fontSize: 12 },
  buttonMapText: { color: "#a8b0c3", fontSize: 11, lineHeight: 15 },
  targetPanel: { gap: 8, padding: 10, borderRadius: 8, backgroundColor: "#0b1020", borderWidth: 1, borderColor: "rgba(167,139,250,.28)" },
  targetHeader: { flexDirection: "row", alignItems: "center", gap: 7 },
  targetTitle: { color: "#f8fafc", fontWeight: "900", fontSize: 12 },
  grid: { gap: 10 },
  statusCard: { padding: 14, borderRadius: 8, backgroundColor: "#171b31", borderWidth: 1, borderColor: "rgba(255,255,255,.12)" },
  label: { color: "#9fb1cc", fontSize: 11, letterSpacing: 1.4, textTransform: "uppercase", fontWeight: "700" },
  statusValue: { color: "#f8fbff", fontSize: 24, fontWeight: "900", marginTop: 4 },
  good: { color: "#32d583" },
  warn: { color: "#ffd166" },
  bad: { color: "#ff6b8a" },
  note: { color: "#9fb1cc", fontSize: 13, lineHeight: 19 },
  input: { color: "#f8fbff", backgroundColor: "#0b1020", borderColor: "rgba(255,255,255,.12)", borderWidth: 1, borderRadius: 8, padding: 12 },
  textArea: { minHeight: 110, textAlignVertical: "top" },
  primaryButton: { backgroundColor: "#22d3ee", borderRadius: 8, padding: 12, alignItems: "center" },
  primaryButtonText: { color: "#00131a", fontWeight: "900" },
  dangerButton: { backgroundColor: "#ff6b8a", borderRadius: 8, padding: 12, alignItems: "center" },
  dangerButtonText: { color: "#1f0610", fontWeight: "900" },
  secondaryButton: { borderRadius: 8, padding: 12, alignItems: "center", borderWidth: 1, borderColor: "rgba(255,255,255,.14)" },
  secondaryButtonText: { color: "#f8fbff", fontWeight: "800" },
  commandRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 12, borderRadius: 8, backgroundColor: "#0b1020", borderWidth: 1, borderColor: "rgba(255,255,255,.12)", marginTop: 8 },
  commandTitle: { color: "#f8fbff", fontWeight: "800" },
  commandMeta: { color: "#9fb1cc", fontSize: 12, marginTop: 3 },
  commandGroup: { gap: 6, marginTop: 10 },
  commandGroupTitle: { color: "#22d3ee", fontSize: 14, fontWeight: "900", marginTop: 4 },
  memoryRow: { borderLeftWidth: 2, borderLeftColor: "#20d5ff", paddingLeft: 12, paddingVertical: 8, marginTop: 8 },
  logoBoard: { gap: 10, marginTop: 8 },
  logoCard: { borderWidth: 1, borderRadius: 8, padding: 12, backgroundColor: "#0b1020", gap: 7 },
  logoMark: { width: 68, height: 68, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  logoMarkText: { color: "#061018", fontSize: 22, fontWeight: "900" },
  logoTitle: { color: "#f8fbff", fontSize: 18, fontWeight: "900" },
  logoMeta: { color: "#9fb1cc", fontSize: 12, fontWeight: "800", textTransform: "uppercase" },
  logoEndpoint: { color: "#d9e8ff", fontFamily: "Courier", fontSize: 11, lineHeight: 15 },
  logoBody: { color: "#9fb1cc", fontSize: 12, lineHeight: 17 },
  hintBox: { padding: 12, borderRadius: 8, backgroundColor: "rgba(117,80,255,.12)", borderWidth: 1, borderColor: "rgba(117,80,255,.32)" },
  memoryTitle: { color: "#f8fbff", fontWeight: "800" },
  memoryBody: { color: "#9fb1cc", marginTop: 3 },
  log: { color: "#d9e8ff", fontFamily: "Courier", fontSize: 12 },
  logRow: { borderRadius: 8, padding: 12, backgroundColor: "#0b1020", borderWidth: 1, borderColor: "rgba(255,255,255,.12)", gap: 5 },
  logRowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  logCategory: { color: "#20d5ff", fontSize: 11, fontWeight: "900", textTransform: "uppercase" },
  logTime: { color: "#9fb1cc", fontSize: 11, fontWeight: "700" },
  logDetail: { color: "#d9e8ff", fontFamily: "Courier", fontSize: 11, lineHeight: 15 },
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
