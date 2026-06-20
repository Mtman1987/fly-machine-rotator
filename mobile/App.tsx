import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import * as ImagePicker from "expo-image-picker";
import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import React, { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { metaWearables } from "./src/metaWearables";

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
  const [note, setNote] = useState("");
  const [deviceName, setDeviceName] = useState("Companion Tablet");
  const [pollInterval, setPollInterval] = useState("60");
  const [logoTestText, setLogoTestText] = useState("I see the StreamWeaver logo on my tablet");
  const [qrPayload, setQrPayload] = useState("mountainview://avatar/room-anchor/default");
  const [voicePrompt, setVoicePrompt] = useState("Hey Athena what do you remember about my stream today?");
  const [voiceDestination, setVoiceDestination] = useState<"ai" | "private" | "twitch">("ai");
  const [glassesStatus, setGlassesStatus] = useState<Record<string, unknown>>({
    state: "not checked",
    flashControlSupported: false
  });

  const connected = token.length > 0;
  const commandMap = useMemo(() => new Map(commands.map((command) => [command.id, command])), [commands]);

  useEffect(() => {
    SecureStore.getItemAsync("mountainview_token").then((stored) => {
      if (stored) {
        setToken(stored);
        void load(stored);
      }
    });
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
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error ?? "Request failed");
    return data;
  }

  async function login() {
    try {
      const data = await request("/login", {
        method: "POST",
        body: JSON.stringify({ email: "owner@spacemountain.live", password })
      }, "");
      setToken(data.token);
      await SecureStore.setItemAsync("mountainview_token", data.token);
      await load(data.token);
    } catch (error) {
      Alert.alert("Login failed", error instanceof Error ? error.message : String(error));
    }
  }

  async function load(authToken = token) {
    const data = await request("/bootstrap", {}, authToken);
    setCommands(data.commands ?? []);
    setMemory(data.memory ?? []);
    setDevices(data.devices ?? []);
    setPollingProfiles(data.pollingProfiles ?? []);
    setLogoProfiles(data.logoProfiles ?? []);
    setQrTriggers(data.qrTriggers ?? []);
    setRoadmap(data.roadmap ?? []);
    setLog((data.logs ?? []).map((item: Record<string, string>) => `${item.created_at} ${item.app_id} ${item.status}`).join("\n") || "No activity yet.");
  }

  async function runCommand(commandId: string, message = "MountainView mobile trigger") {
    try {
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
      Speech.speak(data.ok ? "Command sent." : "Command failed.");
    } catch (error) {
      setLog(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendImageToStreamWeaver() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      base64: true,
      quality: 0.8
    });
    if (result.canceled) return;
    const imageBase64 = result.assets[0]?.base64 ?? "";
    const data = await request("/media/streamweaver", {
      method: "POST",
      body: JSON.stringify({
        imageBase64,
        metadata: { source: "mountainview-mobile", sentAt: new Date().toISOString() }
      })
    });
    setLog(JSON.stringify(data, null, 2));
  }

  async function saveMemory() {
    await request("/memory", {
      method: "POST",
      body: JSON.stringify({ title: "Mobile note", body: note, tags: ["mobile", "glasses"] })
    });
    setNote("");
    await load();
  }

  async function checkGlassesSdk() {
    const status = await metaWearables.getSdkStatus();
    setGlassesStatus(status);
    setLog(JSON.stringify(status, null, 2));
  }

  async function registerGlasses() {
    try {
      const result = await metaWearables.startRegistration();
      setGlassesStatus(result);
      setLog(JSON.stringify(result, null, 2));
    } catch (error) {
      setLog(error instanceof Error ? error.message : String(error));
    }
  }

  async function captureGlassesPhoto() {
    try {
      const result = await metaWearables.capturePhoto();
      setLog(JSON.stringify(result, null, 2));
    } catch (error) {
      setLog(error instanceof Error ? error.message : String(error));
    }
  }

  async function startGlassesAudioStream() {
    try {
      const result = await metaWearables.startAudioStream();
      setLog(JSON.stringify(result, null, 2));
      await request("/glasses/media-event", {
        method: "POST",
        body: JSON.stringify({ kind: "audio-stream", targetApp: "hearmeout", metadata: result })
      });
    } catch (error) {
      setLog(error instanceof Error ? error.message : String(error));
    }
  }

  async function startGlassesVideoStream() {
    try {
      const result = await metaWearables.startVideoStream();
      setLog(JSON.stringify(result, null, 2));
      await request("/glasses/media-event", {
        method: "POST",
        body: JSON.stringify({ kind: "video-stream", targetApp: "streamweaver", metadata: result })
      });
    } catch (error) {
      setLog(error instanceof Error ? error.message : String(error));
    }
  }

  async function requestGlassesFlashlight() {
    try {
      const result = await metaWearables.setFlashlight(true);
      setLog(JSON.stringify(result, null, 2));
    } catch (error) {
      setLog(error instanceof Error ? error.message : String(error));
    }
  }

  async function requestVoiceWakePermissions() {
    try {
      const result = await metaWearables.requestVoiceWakePermissions();
      setLog(JSON.stringify(result, null, 2));
    } catch (error) {
      setLog(error instanceof Error ? error.message : String(error));
    }
  }

  async function askStreamWeaverVoiceCommander() {
    await runCommand("cmd_streamweaver_voice_commander", voicePrompt);
  }

  async function saveDevice() {
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
  }

  async function savePollingProfile() {
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
  }

  async function testLogoMatch() {
    const data = await request("/logo-profiles/match", {
      method: "POST",
      body: JSON.stringify({ observedText: logoTestText })
    });
    setLog(JSON.stringify(data, null, 2));
    Speech.speak(data.matched ? "Logo route matched." : "No logo route matched.");
    await load();
  }

  async function saveLogoProfile() {
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
  }

  async function saveQrTrigger() {
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

      {!connected ? (
        <View style={styles.panel}>
          <Text style={styles.label}>Owner login</Text>
          <TextInput secureTextEntry value={password} onChangeText={setPassword} placeholder="Owner password" placeholderTextColor="#7f8ca8" style={styles.input} />
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
                <Text style={styles.label}>Athena wake bridge</Text>
                <Text style={styles.note}>Test Hey Athena or Hey Annie by sending the transcript to StreamWeaver voice commander. Android permissions prepare mic and foreground wake testing; always-on wake still needs a foreground listener or glasses wake event.</Text>
                <TextInput value={voicePrompt} onChangeText={setVoicePrompt} placeholder="Hey Athena ..." placeholderTextColor="#7f8ca8" style={styles.input} />
                <View style={styles.inlineOptions}>
                  {(["ai", "private", "twitch"] as const).map((value) => (
                    <Pressable key={value} style={[styles.optionChip, voiceDestination === value && styles.optionChipActive]} onPress={() => setVoiceDestination(value)}>
                      <Text style={styles.optionChipText}>{value}</Text>
                    </Pressable>
                  ))}
                </View>
                <Pressable style={styles.primaryButton} onPress={askStreamWeaverVoiceCommander}><Text style={styles.primaryButtonText}>Ask StreamWeaver AI</Text></Pressable>
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
          ["home", "planet"],
          ["relay", "image"],
          ["memory", "file-tray-full"],
          ["stream", "radio"],
          ["devices", "phone-portrait"],
          ["polling", "scan"],
          ["logos", "apps"],
          ["qr", "qr-code"],
          ["roadmap", "rocket"],
          ["logs", "terminal"]
        ].map(([id, icon]) => (
          <Pressable key={id} style={[styles.tab, tab === id && styles.activeTab]} onPress={() => setTab(id)}>
            <Ionicons name={icon as keyof typeof Ionicons.glyphMap} size={20} color={tab === id ? "#20d5ff" : "#94a3b8"} />
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
  secondaryButton: { borderRadius: 8, padding: 12, alignItems: "center", borderWidth: 1, borderColor: "rgba(255,255,255,.14)" },
  secondaryButtonText: { color: "#f8fbff", fontWeight: "800" },
  commandRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 12, borderRadius: 8, backgroundColor: "#0b1020", borderWidth: 1, borderColor: "rgba(255,255,255,.12)", marginTop: 8 },
  commandTitle: { color: "#f8fbff", fontWeight: "800" },
  commandMeta: { color: "#9fb1cc", fontSize: 12, marginTop: 3 },
  commandGroup: { gap: 6, marginTop: 10 },
  commandGroupTitle: { color: "#20d5ff", fontSize: 14, fontWeight: "900", marginTop: 4 },
  memoryRow: { borderLeftWidth: 2, borderLeftColor: "#20d5ff", paddingLeft: 12, paddingVertical: 8, marginTop: 8 },
  memoryTitle: { color: "#f8fbff", fontWeight: "800" },
  memoryBody: { color: "#9fb1cc", marginTop: 3 },
  log: { color: "#d9e8ff", fontFamily: "Courier", fontSize: 12 },
  inlineOptions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  optionChip: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: "#0b1020", borderWidth: 1, borderColor: "rgba(255,255,255,.12)" },
  optionChipActive: { borderColor: "#20d5ff", backgroundColor: "rgba(32,213,255,.14)" },
  optionChipText: { color: "#f8fbff", fontWeight: "800" },
  tabs: { position: "absolute", bottom: 18, left: 14, right: 14, flexDirection: "row", justifyContent: "space-around", backgroundColor: "rgba(8,12,25,.94)", borderRadius: 12, padding: 8, borderWidth: 1, borderColor: "rgba(255,255,255,.12)" },
  tab: { padding: 10, borderRadius: 8 },
  activeTab: { backgroundColor: "rgba(32,213,255,.14)" }
});
