import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import * as ImagePicker from "expo-image-picker";
import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import React, { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

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

const apiBaseUrl = Constants.expoConfig?.extra?.mountainViewApiBaseUrl ?? "https://mtman-machine-rotator.fly.dev/mountainview/api";

export default function App() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [tab, setTab] = useState("home");
  const [commands, setCommands] = useState<Command[]>([]);
  const [memory, setMemory] = useState<MemoryRecord[]>([]);
  const [log, setLog] = useState("Waiting for bridge activity.");
  const [note, setNote] = useState("");

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
    setLog((data.logs ?? []).map((item: Record<string, string>) => `${item.created_at} ${item.app_id} ${item.status}`).join("\n") || "No activity yet.");
  }

  async function runCommand(commandId: string, message = "MountainView mobile trigger") {
    try {
      const command = commandMap.get(commandId);
      const data = await request("/commands/execute", {
        method: "POST",
        body: JSON.stringify({ commandId, payload: { message, payload: { message }, source: "mountainview-mobile" } })
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
                <StatusCard label="Glasses" value="SDK gated" tone="warn" detail="Phone-side bridge ready for Meta Wearables events." />
                <StatusCard label="Image AI" value="Relay only" tone="good" detail="No face recognition in MountainView AI." />
                <StatusCard label="Streaming" value="Control ready" detail="Start/stop/overlay triggers are prepared." />
                <StatusCard label="Flash" value="Not exposed" tone="bad" detail="Waiting on SDK/API support." />
              </View>
              <View style={styles.panel}>
                <Text style={styles.label}>Quick commands</Text>
                {commands.slice(0, 5).map((command) => (
                  <CommandRow key={command.id} command={command} onPress={() => runCommand(command.id)} />
                ))}
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
              <Pressable style={styles.secondaryButton} onPress={() => setLog("Stop stream requested")}><Text style={styles.secondaryButtonText}>Stop stream</Text></Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => setLog("Overlay event requested")}><Text style={styles.secondaryButtonText}>Trigger overlay/event</Text></Pressable>
            </View>
          )}

          {tab === "logs" && <View style={styles.panel}><Text style={styles.label}>Activity logs</Text><Text style={styles.log}>{log}</Text></View>}
        </ScrollView>
      )}

      <View style={styles.tabs}>
        {[
          ["home", "planet"],
          ["relay", "image"],
          ["memory", "file-tray-full"],
          ["stream", "radio"],
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
  memoryRow: { borderLeftWidth: 2, borderLeftColor: "#20d5ff", paddingLeft: 12, paddingVertical: 8, marginTop: 8 },
  memoryTitle: { color: "#f8fbff", fontWeight: "800" },
  memoryBody: { color: "#9fb1cc", marginTop: 3 },
  log: { color: "#d9e8ff", fontFamily: "Courier", fontSize: 12 },
  tabs: { position: "absolute", bottom: 18, left: 14, right: 14, flexDirection: "row", justifyContent: "space-around", backgroundColor: "rgba(8,12,25,.94)", borderRadius: 12, padding: 8, borderWidth: 1, borderColor: "rgba(255,255,255,.12)" },
  tab: { padding: 10, borderRadius: 8 },
  activeTab: { backgroundColor: "rgba(32,213,255,.14)" }
});
