const app = require("./app.json");

module.exports = () => {
  const metaAppId = process.env.MOUNTAINVIEW_META_APP_ID || "mountainview-meta-app-id-not-set";
  return {
    ...app.expo,
    android: {
      ...app.expo.android,
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
