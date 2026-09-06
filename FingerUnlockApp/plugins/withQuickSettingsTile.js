// Expo config plugin: Register Android Quick Settings TileService (Approved Option 1 5-State Design), Native SharedPreferences, & TransparentAuthActivity
const { withMainApplication, withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withQuickSettingsTile(config) {
  // 1) Register SharedPreferencesPackage in MainApplication.kt
  config = withMainApplication(config, (cfg) => {
    let content = cfg.modResults.contents;
    if (!content.includes('SharedPreferencesPackage()')) {
      content = content.replace(
        'PackageList(this).packages',
        'PackageList(this).packages.apply { add(SharedPreferencesPackage()) }'
      );
      cfg.modResults.contents = content;
    }
    return cfg;
  });

  // 2) Add TileService & TransparentAuthActivity to AndroidManifest.xml
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

  // 3) Write Drawables and Kotlin source files automatically during prebuild
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

      // State 1: Default (Option 1 Approved — Laptop outline + fingerprint arc above screen)
      const icDefaultXml = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M4,17h16c0.55,0 1,0.45 1,1v0.5c0,0.55 -0.45,1 -1,1H4c-0.55,0 -1,-0.45 -1,-1V18c0,-0.55 0.45,-1 1,-1z"/>
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M6,10h12v6H6zM5,9c-0.55,0 -1,0.45 -1,1v6h16v-6c0,-0.55 -0.45,-1 -1,-1H5z"/>
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M17.81,4.47A9.94,9.94 0,0 0,12 2.5C9.4,2.5 6.9,3.5 5,5.32c-0.2,0.19 -0.2,0.5 0,0.7 0.2,0.2 0.51,0.2 0.71,0A8.93,8.93 0,0 1,12 4.5c2.25,0 4.41,0.87 6.04,2.44 0.2,0.19 0.51,0.19 0.71,0 0.19,-0.2 0.19,-0.51 0.06,-0.67zM12,7.5c-1.38,0 -2.5,1.12 -2.5,2.5 0,0.28 0.22,0.5 0.5,0.5s0.5,-0.22 0.5,-0.5c0,-0.83 0.67,-1.5 1.5,-1.5s1.5,0.67 1.5,1.5c0,0.28 0.22,0.5 0.5,0.5s0.5,-0.22 0.5,-0.5c0,-1.38 -1.12,-2.5 -2.5,-2.5z"/>
</vector>`;
      fs.writeFileSync(path.join(drawableDir, 'ic_tile_default.xml'), icDefaultXml, 'utf8');

      // State 2: Pressed (Option 1 Approved — Laptop + radiating signal arcs)
      const icPressedXml = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M4,17h16c0.55,0 1,0.45 1,1v0.5c0,0.55 -0.45,1 -1,1H4c-0.55,0 -1,-0.45 -1,-1V18c0,-0.55 0.45,-1 1,-1z"/>
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M6,10h12v6H6zM5,9c-0.55,0 -1,0.45 -1,1v6h16v-6c0,-0.55 -0.45,-1 -1,-1H5z"/>
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M12,2A5,5 0,0 0,7 7h1.5a3.5,3.5 0,0 1,7 0H17A5,5 0,0 0,12 2zM12,4.5A2.5,2.5 0,0 0,9.5 7h1.5a1,1 0,0 1,2 0H14.5A2.5,2.5 0,0 0,12 4.5z"/>
</vector>`;
      fs.writeFileSync(path.join(drawableDir, 'ic_tile_pressed.xml'), icPressedXml, 'utf8');

      // State 3: Authenticating (Option 1 Approved — Fingerprint + progress ring)
      const icAuthXml = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M12,2A10,10 0,1 0,22 12,10 10 0,0 0,12 2zm0,18a8,8 0,1 1,8 -8,8 8 0,0 1,-8 8z"/>
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M12,6.5c-3.03,0 -5.5,2.47 -5.5,5.5 0,0.28 0.22,0.5 0.5,0.5s0.5,-0.22 0.5,-0.5c0,-2.48 2.02,-4.5 4.5,-4.5s4.5,2.02 4.5,4.5c0,0.28 0.22,0.5 0.5,0.5s0.5,-0.22 0.5,-0.5c0,-3.03 -2.47,-5.5 -5.5,-5.5zM12,9.5c-1.38,0 -2.5,1.12 -2.5,2.5 0,0.28 0.22,0.5 0.5,0.5s0.5,-0.22 0.5,-0.5c0,-0.83 0.67,-1.5 1.5,-1.5s1.5,0.67 1.5,1.5c0,1.93 -1.57,3.5 -3.5,3.5 -0.28,0 -0.5,0.22 -0.5,0.5s0.22,0.5 0.5,0.5c2.48,0 4.5,-2.02 4.5,-4.5 0,-1.93 -1.57,-3.5 -3.5,-3.5z"/>
</vector>`;
      fs.writeFileSync(path.join(drawableDir, 'ic_tile_authenticating.xml'), icAuthXml, 'utf8');

      // State 4: Success (Option 1 Approved — Laptop display + checkmark shield)
      const icSuccessXml = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M4,17h16c0.55,0 1,0.45 1,1v0.5c0,0.55 -0.45,1 -1,1H4c-0.55,0 -1,-0.45 -1,-1V18c0,-0.55 0.45,-1 1,-1z"/>
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M12,3L5,6v5c0,4.55 3.03,8.74 7,9.93 3.97,-1.19 7,-5.38 7,-9.93V6l-7,-3zM10.5,14.5l-3,-3 1.41,-1.41L10.5,11.67l4.59,-4.59L16.5,8.5l-6,6z"/>
</vector>`;
      fs.writeFileSync(path.join(drawableDir, 'ic_tile_success.xml'), icSuccessXml, 'utf8');

      // State 5: Error (Option 1 Approved — Laptop display + warning triangle)
      const icErrorXml = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M4,17h16c0.55,0 1,0.45 1,1v0.5c0,0.55 -0.45,1 -1,1H4c-0.55,0 -1,-0.45 -1,-1V18c0,-0.55 0.45,-1 1,-1z"/>
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M1,21h22L12,2 1,21zm12,-3h-2v-2h2v2zm0,-4h-2v-4h2v4z"/>
</vector>`;
      fs.writeFileSync(path.join(drawableDir, 'ic_tile_error.xml'), icErrorXml, 'utf8');

      // Target Source Directory
      const targetDir = path.join(
        platformRoot,
        'app/src/main/java',
        packagePath
      );
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // 1. SharedPreferencesModule.kt
      const spModuleContent = `package ${packageName}

import android.content.Context
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class SharedPreferencesModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = "SharedPreferences"

    @ReactMethod
    fun setItem(key: String, value: String) {
        val prefs = reactApplicationContext.getSharedPreferences("fu_prefs", Context.MODE_PRIVATE)
        prefs.edit().putString(key, value).apply()
    }
}
`;
      fs.writeFileSync(path.join(targetDir, 'SharedPreferencesModule.kt'), spModuleContent, 'utf8');

      // 2. SharedPreferencesPackage.kt
      const spPackageContent = `package ${packageName}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class SharedPreferencesPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(SharedPreferencesModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
`;
      fs.writeFileSync(path.join(targetDir, 'SharedPreferencesPackage.kt'), spPackageContent, 'utf8');

      // 3. TileService.kt
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
            // State 2: PRESSED
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

      // 4. TransparentAuthActivity.kt (Multi-endpoint parallel racing execution)
      const authContent = `package ${packageName}

import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.service.quicksettings.Tile
import android.view.WindowManager
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

        // Window overlay flags to prevent system bar glitches & allow unlock from lock screen / apps
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            )
        }
        window.setBackgroundDrawableResource(android.R.color.transparent)

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
                    // State 4: SUCCESS
                    FingerUnlockTileService.updateState(
                        Tile.STATE_ACTIVE,
                        R.drawable.ic_tile_success,
                        "Laptop Unlocked"
                    )
                    Toast.makeText(applicationContext, "✅ Laptop Unlocked!", Toast.LENGTH_SHORT).show()
                } else {
                    // State 5: ERROR
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
            val prefs = getSharedPreferences("fu_prefs", MODE_PRIVATE)
            val laptopsJson = prefs.getString("laptops_json", null)
            if (laptopsJson != null) {
                val arr = JSONArray(laptopsJson)
                for (i in 0 until arr.length()) {
                    val obj = arr.getJSONObject(i)
                    val mainIp = obj.optString("ip", "").trim()
                    val tsIp = obj.optString("tailscaleIp", "").trim()
                    val token = obj.optString("token", "changeme").trim()
                    if (mainIp.isNotEmpty()) candidates.add(Pair(mainIp, token))
                    if (tsIp.isNotEmpty() && tsIp != mainIp) candidates.add(Pair(tsIp, token))
                }
            }
            val singleIp = prefs.getString("ip", "")?.trim() ?: ""
            val singleTsIp = prefs.getString("tailscaleIp", "")?.trim() ?: ""
            val singleToken = prefs.getString("token", "changeme")?.trim() ?: "changeme"
            if (singleIp.isNotEmpty() && !candidates.any { it.first == singleIp }) {
                candidates.add(Pair(singleIp, singleToken))
            }
            if (singleTsIp.isNotEmpty() && singleTsIp != singleIp && !candidates.any { it.first == singleTsIp }) {
                candidates.add(Pair(singleTsIp, singleToken))
            }
        } catch (e: Exception) {}

        if (candidates.isEmpty()) {
            runOnUiThread {
                Toast.makeText(applicationContext, "⚠️ Please open FingerUnlock app once to sync setup", Toast.LENGTH_LONG).show()
            }
            return false
        }

        val poolSize = candidates.size.coerceAtLeast(1)
        val executor = java.util.concurrent.Executors.newFixedThreadPool(poolSize)
        val cs = java.util.concurrent.ExecutorCompletionService<Boolean>(executor)

        for (candidate in candidates) {
            val (ip, token) = candidate
            cs.submit {
                try {
                    val url = URL("http://$ip:5599/unlock")
                    val conn = url.openConnection() as HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.setRequestProperty("X-Token", token)
                    conn.setRequestProperty("Host", "$ip:5599")
                    conn.setRequestProperty("Connection", "close")
                    conn.connectTimeout = 2500
                    conn.readTimeout = 2500
                    conn.doOutput = true

                    val json = JSONObject()
                    json.put("token", token)

                    conn.outputStream.use { os ->
                        os.write(json.toString().toByteArray(Charsets.UTF_8))
                    }
                    val resCode = conn.responseCode
                    conn.disconnect()
                    resCode == 200
                } catch (e: Exception) {
                    false
                }
            }
        }

        var success = false
        for (i in candidates.indices) {
            try {
                val future = cs.poll(2800, java.util.concurrent.TimeUnit.MILLISECONDS)
                if (future != null && future.get() == true) {
                    success = true
                    break
                }
            } catch (e: Exception) {}
        }
        executor.shutdownNow()
        return success
    }
}
`;
      fs.writeFileSync(path.join(targetDir, 'TransparentAuthActivity.kt'), authContent, 'utf8');

      return cfg;
    },
  ]);

  return config;
};
