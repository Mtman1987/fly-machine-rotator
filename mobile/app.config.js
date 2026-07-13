const app = require("./app.json");

module.exports = () => {
  const bridgeAppId = process.env.MOUNTAINVIEW_BRIDGE_APP_ID || process.env.MOUNTAINVIEW_META_APP_ID || "mountainview-bridge-app-id-not-set";
  const enableMetaDat = process.env.MOUNTAINVIEW_ENABLE_META_DAT === "true";
  return {
    ...app.expo,
    android: {
      ...app.expo.android,
      permissions: [
        ...new Set([
          ...(app.expo.android?.permissions || []),
          "RECORD_AUDIO",
          "POST_NOTIFICATIONS",
          "FOREGROUND_SERVICE",
          "FOREGROUND_SERVICE_MICROPHONE",
          "FOREGROUND_SERVICE_CONNECTED_DEVICE",
          "WAKE_LOCK",
          "BLUETOOTH",
          "BLUETOOTH_ADMIN",
          "BLUETOOTH_SCAN",
          "BLUETOOTH_CONNECT",
          "BLUETOOTH_ADVERTISE",
          "ACCESS_FINE_LOCATION",
          "ACCESS_COARSE_LOCATION",
          "NEARBY_WIFI_DEVICES",
          "CAMERA",
          "FLASHLIGHT"
        ])
      ],
      config: {
        ...(app.expo.android?.config || {}),
        metaWearablesAndroidAppId: bridgeAppId
      }
    },
    plugins: [
      "expo-asset",
      "expo-font",
      "expo-dev-client",
      [
        "./plugins/withMetaWearablesAndroid",
        {
          mwdatVersion: "0.7.0",
          applicationId: bridgeAppId,
          enableMetaDat,
          analyticsOptOut: true
        }
      ]
    ]
  };
};
