const app = require("./app.json");

module.exports = () => {
  const metaAppId = process.env.MOUNTAINVIEW_META_APP_ID || "mountainview-meta-app-id-not-set";
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
          "WAKE_LOCK"
        ])
      ],
      config: {
        ...(app.expo.android?.config || {}),
        metaWearablesAndroidAppId: metaAppId
      }
    },
    plugins: [
      "expo-dev-client",
      [
        "./plugins/withMetaWearablesAndroid",
        {
          mwdatVersion: "0.7.0",
          applicationId: metaAppId,
          analyticsOptOut: true
        }
      ]
    ]
  };
};
