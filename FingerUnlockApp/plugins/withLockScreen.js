// Expo config plugin: let MainActivity appear over the lock screen and turn the
// screen on, so the full-screen unlock "call" behaves like an incoming call.
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withLockScreen(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application && cfg.modResults.manifest.application[0];
    const activities = (app && app.activity) || [];
    const main = activities.find(
      (a) => a['$'] && a['$']['android:name'] === '.MainActivity'
    );
    if (main) {
      // Ensure MainActivity has showWhenLocked, turnScreenOn, and full launch intent-filters
      main['$']['android:showWhenLocked'] = 'true';
      main['$']['android:turnScreenOn'] = 'true';
      main['$']['android:showForAllUsers'] = 'true';
      main['$']['android:inheritShowWhenLocked'] = 'true';
      main['$']['android:launchMode'] = 'singleTop';
      main['$']['android:exported'] = 'true';
    }
    return cfg;
  });
};
