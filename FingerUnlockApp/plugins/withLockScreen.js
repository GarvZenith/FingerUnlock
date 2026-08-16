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
      main['$']['android:showWhenLocked'] = 'true';
      main['$']['android:turnScreenOn'] = 'true';

      // Headless Service Mode: Remove LAUNCHER category so app icon is hidden from App Drawer
      if (main['intent-filter']) {
        main['intent-filter'].forEach((filter) => {
          if (filter.category) {
            filter.category = filter.category.filter(
              (cat) => cat['$'] && cat['$']['android:name'] !== 'android.intent.category.LAUNCHER'
            );
          }
        });
      }
    }
    return cfg;
  });
};
