import { NativeModules, Platform } from "react-native";

type MetaWearablesModule = {
  getSdkStatus(): Promise<Record<string, unknown>>;
  startRegistration(): Promise<Record<string, unknown>>;
  capturePhoto(): Promise<Record<string, unknown>>;
  startAudioStream(): Promise<Record<string, unknown>>;
  startVideoStream(): Promise<Record<string, unknown>>;
  setFlashlight(enabled: boolean): Promise<Record<string, unknown>>;
};

const nativeModule = NativeModules.MountainViewMetaWearables as MetaWearablesModule | undefined;

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
  setFlashlight: (enabled: boolean) => nativeModule?.setFlashlight?.(enabled) ?? unavailable(`setFlashlight:${enabled}`)
};
