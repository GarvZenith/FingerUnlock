// Expo config plugin: Register Android Quick Settings TileService in AndroidManifest.xml and generate FingerUnlockTileService.kt
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withQuickSettingsTile(config) {
  // 1) Add TileService to AndroidManifest.xml
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application && cfg.modResults.manifest.application[0];
    if (app) {
      if (!app.service) app.service = [];

      const hasTileService = app.service.some(
        (s) => s['$'] && s['$']['android:name'] === '.FingerUnlockTileService'
      );

      if (!hasTileService) {
        app.service.push({
          '$': {
            'android:name': '.FingerUnlockTileService',
            'android:label': 'Unlock Laptop',
            'android:icon': '@drawable/icon',
            'android:permission': 'android.permission.BIND_QUICK_SETTINGS_TILE',
            'android:exported': 'true',
          },
          'intent-filter': [
            {
              action: [
                {
                  '$': {
                    'android:name': 'android.service.quicksettings.action.QS_TILE',
                  },
                },
              ],
            },
          ],
        });
      }
    }
    return cfg;
  });

  // 2) Write Kotlin FingerUnlockTileService.kt file automatically during prebuild
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const packageName = cfg.android?.package || 'com.garv.fingerunlock';
      const packagePath = packageName.replace(/\./g, '/');
      const targetDir = path.join(
        cfg.modRequest.projectRoot,
        'android/app/src/main/java',
        packagePath
      );

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const filePath = path.join(targetDir, 'FingerUnlockTileService.kt');
      const content = `package ${packageName}

import android.content.Intent
import android.os.Build
import android.service.quicksettings.TileService

class FingerUnlockTileService : TileService() {
    override fun onClick() {
        super.onClick()
        try {
            val intent = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra("action", "tile_unlock")
            }
            if (Build.VERSION.SDK_INT >= 34) {
                val pendingIntent = android.app.PendingIntent.getActivity(
                    this,
                    0,
                    intent,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
                )
                startActivityAndCollapse(pendingIntent)
            } else {
                @Suppress("DEPRECATION")
                startActivityAndCollapse(intent)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}
`;
      fs.writeFileSync(filePath, content, 'utf8');
      return cfg;
    },
  ]);

  return config;
};
