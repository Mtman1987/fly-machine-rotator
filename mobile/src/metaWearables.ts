import { EmitterSubscription, NativeEventEmitter, NativeModules, Platform } from "react-native";

type MetaWearablesModule = {
  getSdkStatus(): Promise<Record<string, unknown>>;
  startRegistration(): Promise<Record<string, unknown>>;
  capturePhoto(): Promise<Record<string, unknown>>;
  startAudioStream(): Promise<Record<string, unknown>>;
  startVideoStream(): Promise<Record<string, unknown>>;
  requestVoiceWakePermissions(): Promise<Record<string, unknown>>;
  requestBleResearchPermissions(): Promise<Record<string, unknown>>;
  scanGenericBleDevices(): Promise<Record<string, unknown>>;
  getBondedBluetoothDevices(): Promise<Record<string, unknown>>;
  connectGenericBleDevice(address: string): Promise<Record<string, unknown>>;
  discoverGenericBleServices(): Promise<Record<string, unknown>>;
  subscribeGenericBleNotifications(): Promise<Record<string, unknown>>;
  getGenericBleLog(): Promise<Record<string, unknown>>;
  sendRdGlassCommand(commandId: number, payloadHex?: string): Promise<Record<string, unknown>>;
  testRdGlassCamera(): Promise<Record<string, unknown>>;
  testRdGlassFlashlight(): Promise<Record<string, unknown>>;
  triggerRdGlassIntent(intent: number): Promise<Record<string, unknown>>;
  setRdGlassMediaTrigger(task: number, enabled: boolean): Promise<Record<string, unknown>>;
  startMediaButtonCommandMode(): Promise<Record<string, unknown>>;
  stopMediaButtonCommandMode(): Promise<Record<string, unknown>>;
  getMediaButtonLog(): Promise<Record<string, unknown>>;
  recognizeSpeechOnce(): Promise<Record<string, unknown>>;
  prepareLocalVoiceOutput(): Promise<Record<string, unknown>>;
  playTone(name: string): Promise<Record<string, unknown>>;
  setFlashlight(enabled: boolean): Promise<Record<string, unknown>>;
};

const nativeModule = NativeModules.MountainViewMetaWearables as MetaWearablesModule | undefined;
const nativeEvents = nativeModule ? new NativeEventEmitter(NativeModules.MountainViewMetaWearables) : undefined;

function unavailable(method: string): Promise<Record<string, unknown>> {
  return Promise.resolve({
    androidNativeBridge: false,
    state: "unavailable",
    method,
    platform: Platform.OS,
    note: "Run an Android dev client or release APK with the MountainView native bridge to enable BLE, media button, speech, and RDGlass research features."
  });
}

export const metaWearables: MetaWearablesModule = {
  getSdkStatus: () => nativeModule?.getSdkStatus?.() ?? unavailable("getSdkStatus"),
  startRegistration: () => nativeModule?.startRegistration?.() ?? unavailable("startRegistration"),
  capturePhoto: () => nativeModule?.capturePhoto?.() ?? unavailable("capturePhoto"),
  startAudioStream: () => nativeModule?.startAudioStream?.() ?? unavailable("startAudioStream"),
  startVideoStream: () => nativeModule?.startVideoStream?.() ?? unavailable("startVideoStream"),
  requestVoiceWakePermissions: () => nativeModule?.requestVoiceWakePermissions?.() ?? unavailable("requestVoiceWakePermissions"),
  requestBleResearchPermissions: () => nativeModule?.requestBleResearchPermissions?.() ?? unavailable("requestBleResearchPermissions"),
  scanGenericBleDevices: () => nativeModule?.scanGenericBleDevices?.() ?? unavailable("scanGenericBleDevices"),
  getBondedBluetoothDevices: () => nativeModule?.getBondedBluetoothDevices?.() ?? unavailable("getBondedBluetoothDevices"),
  connectGenericBleDevice: (address: string) => nativeModule?.connectGenericBleDevice?.(address) ?? unavailable(`connectGenericBleDevice:${address}`),
  discoverGenericBleServices: () => nativeModule?.discoverGenericBleServices?.() ?? unavailable("discoverGenericBleServices"),
  subscribeGenericBleNotifications: () => nativeModule?.subscribeGenericBleNotifications?.() ?? unavailable("subscribeGenericBleNotifications"),
  getGenericBleLog: () => nativeModule?.getGenericBleLog?.() ?? unavailable("getGenericBleLog"),
  sendRdGlassCommand: (commandId: number, payloadHex = "") => nativeModule?.sendRdGlassCommand?.(commandId, payloadHex) ?? unavailable(`sendRdGlassCommand:${commandId}`),
  testRdGlassCamera: () => nativeModule?.testRdGlassCamera?.() ?? unavailable("testRdGlassCamera"),
  testRdGlassFlashlight: () => nativeModule?.testRdGlassFlashlight?.() ?? unavailable("testRdGlassFlashlight"),
  triggerRdGlassIntent: (intent: number) => nativeModule?.triggerRdGlassIntent?.(intent) ?? unavailable(`triggerRdGlassIntent:${intent}`),
  setRdGlassMediaTrigger: (task: number, enabled: boolean) => nativeModule?.setRdGlassMediaTrigger?.(task, enabled) ?? unavailable(`setRdGlassMediaTrigger:${task}:${enabled}`),
  startMediaButtonCommandMode: () => nativeModule?.startMediaButtonCommandMode?.() ?? unavailable("startMediaButtonCommandMode"),
  stopMediaButtonCommandMode: () => nativeModule?.stopMediaButtonCommandMode?.() ?? unavailable("stopMediaButtonCommandMode"),
  getMediaButtonLog: () => nativeModule?.getMediaButtonLog?.() ?? unavailable("getMediaButtonLog"),
  recognizeSpeechOnce: () => nativeModule?.recognizeSpeechOnce?.() ?? unavailable("recognizeSpeechOnce"),
  prepareLocalVoiceOutput: () => nativeModule?.prepareLocalVoiceOutput?.() ?? unavailable("prepareLocalVoiceOutput"),
  playTone: (name: string) => nativeModule?.playTone?.(name) ?? unavailable(`playTone:${name}`),
  setFlashlight: (enabled: boolean) => nativeModule?.setFlashlight?.(enabled) ?? unavailable(`setFlashlight:${enabled}`)
};

export function addMediaButtonListener(listener: (event: Record<string, unknown>) => void): EmitterSubscription | { remove: () => void } {
  return nativeEvents?.addListener("MountainViewMediaButton", listener) ?? { remove: () => undefined };
}

export function addBleButtonListener(listener: (event: Record<string, unknown>) => void): EmitterSubscription | { remove: () => void } {
  return nativeEvents?.addListener("MountainViewBleButton", listener) ?? { remove: () => undefined };
}

export async function toggleFlashlight(enabled: boolean, options: { retries?: number; settleMs?: number } = {}): Promise<Record<string, unknown>> {
  const retries = Math.max(1, options.retries ?? 3);
  const settleMs = Math.max(80, options.settleMs ?? 220);
  const attempts: Record<string, unknown>[] = [];

  for (let index = 0; index < retries; index += 1) {
    try {
      const result = await metaWearables.setFlashlight(enabled);
      attempts.push({ index: index + 1, path: "setFlashlight", result });
      return { ok: true, enabled, attempts, result };
    } catch (error) {
      attempts.push({ index: index + 1, path: "setFlashlight", error: error instanceof Error ? error.message : String(error) });
    }

    try {
      const result = await metaWearables.testRdGlassFlashlight();
      attempts.push({ index: index + 1, path: "testRdGlassFlashlight", result });
      if (enabled) return { ok: true, enabled, attempts, result, note: "RDGlass flashlight diagnostic command accepted." };
    } catch (error) {
      attempts.push({ index: index + 1, path: "testRdGlassFlashlight", error: error instanceof Error ? error.message : String(error) });
    }

    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  return {
    ok: false,
    enabled,
    attempts,
    state: "unsupported-or-not-connected",
    note: "No stable glasses torch API is confirmed yet; MountainView logged every retry for mapping."
  };
}
