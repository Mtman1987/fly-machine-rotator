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
  getGenericBleLog(): Promise<Record<string, unknown>>;
  startMediaButtonCommandMode(): Promise<Record<string, unknown>>;
  stopMediaButtonCommandMode(): Promise<Record<string, unknown>>;
  getMediaButtonLog(): Promise<Record<string, unknown>>;
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
    note: "Run an Android dev client/prebuild with the Meta Wearables plugin to enable this native bridge."
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
  getGenericBleLog: () => nativeModule?.getGenericBleLog?.() ?? unavailable("getGenericBleLog"),
  startMediaButtonCommandMode: () => nativeModule?.startMediaButtonCommandMode?.() ?? unavailable("startMediaButtonCommandMode"),
  stopMediaButtonCommandMode: () => nativeModule?.stopMediaButtonCommandMode?.() ?? unavailable("stopMediaButtonCommandMode"),
  getMediaButtonLog: () => nativeModule?.getMediaButtonLog?.() ?? unavailable("getMediaButtonLog"),
  setFlashlight: (enabled: boolean) => nativeModule?.setFlashlight?.(enabled) ?? unavailable(`setFlashlight:${enabled}`)
};

export function addMediaButtonListener(listener: (event: Record<string, unknown>) => void): EmitterSubscription | { remove: () => void } {
  return nativeEvents?.addListener("MountainViewMediaButton", listener) ?? { remove: () => undefined };
}
