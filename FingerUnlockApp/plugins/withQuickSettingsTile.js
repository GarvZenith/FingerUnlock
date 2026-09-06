// Expo config plugin: Register Android Quick Settings TileService (5 Exact States) & TransparentAuthActivity
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
            'android:icon': '@drawable/ic_tile_default',
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

  // 2) Write Drawables and Kotlin source files automatically during prebuild
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const packageName = cfg.android?.package || 'com.garv.fingerunlock';
      const packagePath = packageName.replace(/\./g, '/');
      const platformRoot = cfg.modRequest.platformProjectRoot || path.join(cfg.modRequest.projectRoot, 'android');

      const resDir = path.join(platformRoot, 'app/src/main/res');
      const drawableDir = path.join(resDir, 'drawable');
      if (!fs.existsSync(drawableDir)) {
        fs.mkdirSync(drawableDir, { recursive: true });
      }

      // State 1: Default (Option 6 - Purple/Blue gradient fingerprint)
      const icDefaultXml = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M17.81,4.47A9.94,9.94 0,0 0,12 2.5C9.4,2.5 6.9,3.5 5,5.32c-0.2,0.19 -0.2,0.5 0,0.7 0.2,0.2 0.51,0.2 0.71,0A8.93,8.93 0,0 1,12 4.5c2.25,0 4.41,0.87 6.04,2.44 0.2,0.19 0.51,0.19 0.71,0 0.19,-0.2 0.19,-0.51 0.06,-0.67zM3.5,9.5A9.97,9.97 0,0 1,12 6.5c3.15,0 6.07,1.46 7.97,3.95 0.17,0.22 0.48,0.26 0.7,0.09 0.22,-0.17 0.26,-0.48 0.09,-0.7A10.97,10.97 0,0 0,12 5.5c-3.46,0 -6.67,1.6 -8.76,4.34 -0.17,0.22 -0.13,0.53 0.09,0.7 0.22,0.17 0.53,0.13 0.7,-0.09zM9.5,12c0,-1.38 1.12,-2.5 2.5,-2.5s2.5,1.12 2.5,2.5c0,1.93 -1.57,3.5 -3.5,3.5 -0.28,0 -0.5,0.22 -0.5,0.5s0.22,0.5 0.5,0.5c2.48,0 4.5,-2.02 4.5,-4.5 0,-1.93 -1.57,-3.5 -3.5,-3.5S8.5,10.07 8.5,12c0,0.28 0.22,0.5 0.5,0.5s0.5,-0.22 0.5,-0.5zM12,18.5c-2.48,0 -4.5,-2.02 -4.5,-4.5 0,-0.28 -0.22,-0.5 -0.5,-0.5s-0.5,0.22 -0.5,0.5c0,3.03 2.47,5.5 5.5,5.5 0.28,0 0.5,-0.22 0.5,-0.5s-0.22,-0.5 -0.5,-0.5z"/>
</vector>`;
      fs.writeFileSync(path.join(drawableDir, 'ic_tile_default.xml'), icDefaultXml, 'utf8');

      // State 2: Pressed (Option 9 - Laptop + radiating signal rings)
      const icPressedXml = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#00E5FF"
        android:pathData="M4,15h16c0.55,0 1,0.45 1,1v1c0,0.55 -0.45,1 -1,1H4c-0.55,0 -1,-0.45 -1,-1v-1c0,-0.55 0.45,-1 1,-1z"/>
    <path
        android:fillColor="#00E5FF"
        android:pathData="M6,8h12v6H6zM5,7c-0.55,0 -1,0.45 -1,1v7h16V8c0,-0.55 -0.45,-1 -1,-1H5z"/>
    <path
        android:fillColor="#00E5FF"
        android:pathData="M12,2A4,4 0,0 0,8 6h1.5a2.5,2.5 0,0 1,5 0H16A4,4 0,0 0,12 2z"/>
</vector>`;
      fs.writeFileSync(path.join(drawableDir, 'ic_tile_pressed.xml'), icPressedXml, 'utf8');

      // State 3: Authenticating (Fingerprint + Circular Progress Ring)
      const icAuthXml = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#3399FF"
        android:pathData="M12,2A10,10 0,1 0,22 12,10 10 0,0 0,12 2zm0,18a8,8 0,1 1,8 -8,8 8 0,0 1,-8 8z"/>
    <path
        android:fillColor="#00E5FF"
        android:pathData="M12,4A8,8 0,0 1,20 12h2A10,10 0,0 0,12 2z"/>
</vector>`;
      fs.writeFileSync(path.join(drawableDir, 'ic_tile_authenticating.xml'), icAuthXml, 'utf8');

      // State 4: Success (Green Laptop + Checkmark)
      const icSuccessXml = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#37D67A"
        android:pathData="M4,15h16v2H4zM5,6h14c0.55,0 1,0.45 1,1v7H4V7c0,-0.55 0.45,-1 1,-1zM10.5,12.5l5,-5 -1.4,-1.4 -3.6,3.6 -1.6,-1.6 -1.4,1.4z"/>
</vector>`;
      fs.writeFileSync(path.join(drawableDir, 'ic_tile_success.xml'), icSuccessXml, 'utf8');

      // State 5: Error (Red Laptop + Error Badge)
      const icErrorXml = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FF4D4D"
        android:pathData="M4,15h16v2H4zM5,6h14c0.55,0 1,0.45 1,1v7H4V7c0,-0.55 0.45,-1 1,-1zM11,8h2v3h-2zM11,12h2v2h-2z"/>
</vector>`;
      fs.writeFileSync(path.join(drawableDir, 'ic_tile_error.xml'), icErrorXml, 'utf8');

      // Write Kotlin Target Directory
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

import android.app.ActivityOptions
import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

class FingerUnlockTileService : TileService() {
    companion object {
        var activeInstance: FingerUnlockTileService? = null

        fun updateState(state: Int, iconRes: Int, label: String) {
            val service = activeInstance ?: return
            try {
                val tile = service.qsTile ?: return
                tile.state = state
                tile.icon = Icon.createWithResource(service, iconRes)
                tile.label = label
                tile.updateTile()
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    override fun onStartListening() {
        super.onStartListening()
        activeInstance = this
        setTileDefaultState()
    }

    override fun onStopListening() {
        super.onStopListening()
        if (activeInstance == this) activeInstance = null
    }

    private fun setTileDefaultState() {
        try {
            val tile = qsTile ?: return
            tile.state = Tile.STATE_INACTIVE
            tile.icon = Icon.createWithResource(this, R.drawable.ic_tile_default)
            tile.label = "Unlock Laptop"
            tile.updateTile()
        } catch (e: Exception) {}
    }

    override fun onClick() {
        super.onClick()
        activeInstance = this
        try {
            // State 2: PRESSED (Option 9 design)
            val tile = qsTile
            if (tile != null) {
                tile.state = Tile.STATE_ACTIVE
                tile.icon = Icon.createWithResource(this, R.drawable.ic_tile_pressed)
                tile.label = "Unlock Laptop"
                tile.updateTile()
            }

            val intent = Intent(this, TransparentAuthActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NO_ANIMATION
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                val options = ActivityOptions.makeBasic().apply {
                    setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
                }
                val pendingIntent = PendingIntent.getActivity(
                    this,
                    0,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    options.toBundle()
                )
                startActivityAndCollapse(pendingIntent)
            } else {
                @Suppress("DEPRECATION")
                startActivityAndCollapse(intent)
            }
        } catch (e: Exception) {
            e.printStackTrace()
            updateState(Tile.STATE_INACTIVE, R.drawable.ic_tile_error, "Connection failed")
            Handler(Looper.getMainLooper()).postDelayed({ setTileDefaultState() }, 2500)
        }
    }
}
`;
      fs.writeFileSync(path.join(targetDir, 'FingerUnlockTileService.kt'), tileContent, 'utf8');

      // TransparentAuthActivity.kt
      const authContent = `package ${packageName}

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.service.quicksettings.Tile
import android.widget.Toast
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONArray
import org.json.JSONObject

class TransparentAuthActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // State 3: AUTHENTICATING
        FingerUnlockTileService.updateState(
            Tile.STATE_ACTIVE,
            R.drawable.ic_tile_authenticating,
            "Authenticating..."
        )

        val executor = ContextCompat.getMainExecutor(this)
        val biometricPrompt = BiometricPrompt(this, executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    super.onAuthenticationSucceeded(result)
                    performUnlock()
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    super.onAuthenticationError(errorCode, errString)
                    resetTileDefault()
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
                    // State 4: SUCCESS (Green Tile)
                    FingerUnlockTileService.updateState(
                        Tile.STATE_ACTIVE,
                        R.drawable.ic_tile_success,
                        "Laptop Unlocked"
                    )
                    Toast.makeText(applicationContext, "✅ Laptop Unlocked!", Toast.LENGTH_SHORT).show()
                } else {
                    // State 5: ERROR (Red Tile)
                    FingerUnlockTileService.updateState(
                        Tile.STATE_INACTIVE,
                        R.drawable.ic_tile_error,
                        "Connection failed"
                    )
                    Toast.makeText(applicationContext, "❌ Connection failed", Toast.LENGTH_SHORT).show()
                }

                Handler(Looper.getMainLooper()).postDelayed({
                    resetTileDefault()
                }, 2000)

                finish()
            }
        }.start()
    }

    private fun resetTileDefault() {
        FingerUnlockTileService.updateState(
            Tile.STATE_INACTIVE,
            R.drawable.ic_tile_default,
            "Unlock Laptop"
        )
    }

    private fun sendUnlockRequest(): Boolean {
        val candidates = mutableListOf<Pair<String, String>>()

        try {
            val ss = getSharedPreferences("SecureStore", MODE_PRIVATE)
            val laptopsJson = ss.getString("fu_laptops", null)
            if (laptopsJson != null) {
                val arr = JSONArray(laptopsJson)
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
                conn.connectTimeout = 2000
                conn.readTimeout = 2000
                conn.doOutput = true

                val json = JSONObject()
                json.put("token", token)

                conn.outputStream.use { os ->
                    os.write(json.toString().toByteArray(Charsets.UTF_8))
                }

                if (conn.responseCode == 200) return true
            } catch (e: Exception) {
                // Try next candidate IP
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
