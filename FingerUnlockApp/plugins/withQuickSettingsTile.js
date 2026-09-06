// Expo config plugin: Register Android Quick Settings TileService & TransparentAuthActivity
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withQuickSettingsTile(config) {
  // 1) Add TileService & TransparentAuthActivity to AndroidManifest.xml
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application && cfg.modResults.manifest.application[0];
    if (app) {
      if (!app.service) app.service = [];
      if (!app.activity) app.activity = [];

      // Register TileService
      const hasTileService = app.service.some(
        (s) => s['$'] && s['$']['android:name'] === '.FingerUnlockTileService'
      );
      if (!hasTileService) {
        app.service.push({
          '$': {
            'android:name': '.FingerUnlockTileService',
            'android:label': 'Unlock Laptop',
            'android:icon': '@mipmap/ic_launcher',
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

      // Register TransparentAuthActivity
      const hasAuthActivity = app.activity.some(
        (a) => a['$'] && a['$']['android:name'] === '.TransparentAuthActivity'
      );
      if (!hasAuthActivity) {
        app.activity.push({
          '$': {
            'android:name': '.TransparentAuthActivity',
            'android:theme': '@android:style/Theme.Translucent.NoTitleBar',
            'android:exported': 'false',
            'android:excludeFromRecents': 'true',
            'android:launchMode': 'singleInstance',
          },
        });
      }
    }
    return cfg;
  });

  // 2) Write Kotlin source files automatically during prebuild
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const packageName = cfg.android?.package || 'com.garv.fingerunlock';
      const packagePath = packageName.replace(/\./g, '/');
      const platformRoot = cfg.modRequest.platformProjectRoot || path.join(cfg.modRequest.projectRoot, 'android');
      const targetDir = path.join(
        platformRoot,
        'app/src/main/java',
        packagePath
      );

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // TileService.kt
      const tileContent = `package ${packageName}

import android.content.Intent
import android.os.Build
import android.service.quicksettings.TileService

class FingerUnlockTileService : TileService() {
    override fun onClick() {
        super.onClick()
        try {
            val intent = Intent(this, TransparentAuthActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
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
      fs.writeFileSync(path.join(targetDir, 'FingerUnlockTileService.kt'), tileContent, 'utf8');

      // TransparentAuthActivity.kt
      const authContent = `package ${packageName}

import android.os.Bundle
import android.widget.Toast
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

class TransparentAuthActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val executor = ContextCompat.getMainExecutor(this)
        val biometricPrompt = BiometricPrompt(this, executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    super.onAuthenticationSucceeded(result)
                    performUnlock()
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    super.onAuthenticationError(errorCode, errString)
                    finish()
                }

                override fun onAuthenticationFailed() {
                    super.onAuthenticationFailed()
                }
            })

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock Laptop")
            .setSubtitle("Touch the fingerprint sensor")
            .setNegativeButtonText("Cancel")
            .build()

        biometricPrompt.authenticate(promptInfo)
    }

    private fun performUnlock() {
        Thread {
            var success = false
            for (attempt in 1..3) {
                if (sendUnlockRequest()) {
                    success = true
                    break
                }
                try { Thread.sleep(250) } catch (e: Exception) {}
            }
            runOnUiThread {
                if (success) {
                    Toast.makeText(applicationContext, "✅ Laptop Unlocked!", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(applicationContext, "❌ Connection failed", Toast.LENGTH_SHORT).show()
                }
                finish()
            }
        }.start()
    }

    private fun sendUnlockRequest(): Boolean {
        val candidates = mutableListOf<Pair<String, String>>()

        try {
            val ss = getSharedPreferences("SecureStore", MODE_PRIVATE)
            val laptopsJson = ss.getString("fu_laptops", null)
            if (laptopsJson != null) {
                val arr = org.json.JSONArray(laptopsJson)
                for (i in 0 until arr.length()) {
                    val obj = arr.getJSONObject(i)
                    val mainIp = obj.optString("ip", "")
                    val tsIp = obj.optString("tailscaleIp", "")
                    val token = obj.optString("token", "changeme")
                    if (mainIp.isNotEmpty()) candidates.add(Pair(mainIp, token))
                    if (tsIp.isNotEmpty() && tsIp != mainIp) candidates.add(Pair(tsIp, token))
                }
            }
        } catch (e: Exception) {}

        if (candidates.isEmpty()) {
            val prefs = getSharedPreferences("fu_prefs", MODE_PRIVATE)
            val ip = prefs.getString("ip", "192.168.1.50") ?: "192.168.1.50"
            val token = prefs.getString("token", "changeme") ?: "changeme"
            candidates.add(Pair(ip, token))
        }

        for (candidate in candidates) {
            val (ip, token) = candidate
            try {
                val url = URL("http://$ip:5599/unlock")
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("X-Token", token)
                conn.connectTimeout = 1800
                conn.readTimeout = 1800
                conn.doOutput = true

                val json = JSONObject()
                json.put("token", token)

                conn.outputStream.use { os ->
                    os.write(json.toString().toByteArray(Charsets.UTF_8))
                }

                if (conn.responseCode == 200) return true
            } catch (e: Exception) {
                // Try next IP candidate
            }
        }
        return false
    }
}
`;
      fs.writeFileSync(path.join(targetDir, 'TransparentAuthActivity.kt'), authContent, 'utf8');

      return cfg;
    },
  ]);

  return config;
};
