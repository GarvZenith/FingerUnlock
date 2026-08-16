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
      main['$']['android:showForAllUsers'] = 'true';
      main['$']['android:inheritShowWhenLocked'] = 'true';
      main['$']['android:launchMode'] = 'singleTop';
      main['$']['android:exported'] = 'true';

      // 1. Hide from Launcher / App Drawer by removing LAUNCHER category
      if (main['intent-filter']) {
        main['intent-filter'].forEach((filter) => {
          if (filter.category) {
            filter.category = filter.category.filter(
              (cat) => cat['$'] && cat['$']['android:name'] !== 'android.intent.category.LAUNCHER'
            );
          }
        });

        // 2. Add APPLICATION_PREFERENCES so Settings -> App Info has an "Additional settings in the app" / Open button
        main['intent-filter'].push({
          action: [{ $: { 'android:name': 'android.intent.action.APPLICATION_PREFERENCES' } }],
          category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }]
        });
      }
    }
    return cfg;
  });
};
