package com.gcs.calltracker

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Two screens:
 *  1. Admin setup (only when the phone is not yet connected): URL + admin ID + admin password, then pick the caller.
 *     The caller's secret token is fetched by the app and is never shown.
 *  2. Status screen (after setup): shows only "Connected as <name>" and the last result. No URL, no token.
 */
class MainActivity : Activity() {

    private lateinit var prefs: SharedPreferences
    private var unlocked = false          // true only while the admin is inside the app
    private var keepUnlocked = false      // true while the admin visits an Android settings page and comes back


    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("ct", Context.MODE_PRIVATE)
        render()
    }

    override fun onResume() {
        super.onResume()
        keepUnlocked = false
        if (prefs.getBoolean("enrolled", false)) render()
    }

    /** Every time the app leaves the screen it locks again, so a caller who opens it must log in as admin. */
    override fun onStop() {
        super.onStop()
        if (!keepUnlocked) unlocked = false
    }

    private fun openSettings(i: Intent) {
        keepUnlocked = true
        try { startActivity(i) } catch (e: Exception) { keepUnlocked = false }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        render()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun label(s: String, size: Float = 15f) = TextView(this).apply {
        text = s; textSize = size; setPadding(0, dp(8), 0, dp(4))
    }

    private fun show(root: LinearLayout) {
        setContentView(ScrollView(this).apply {
            addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        })
    }

    private fun newRoot() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(16), dp(16), dp(16))
    }

    private fun render() {
        if (!prefs.getBoolean("enrolled", false)) setupScreen()
        else if (unlocked) statusScreen()
        else lockScreen()
    }

    // ---------------- Locked screen: shown to anyone who opens an already-connected app ----------------
    private fun lockScreen() {
        val root = newRoot()
        root.addView(label("Call Tracker", 22f))
        root.addView(label("This app is running in the background and sends the call log automatically. Only the manager can open its settings."))
        root.addView(label("Admin ID"))
        val idBox = EditText(this).apply { inputType = InputType.TYPE_CLASS_TEXT; hint = "Admin ID" }
        root.addView(idBox)
        root.addView(label("Admin password"))
        val pwBox = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            hint = "Admin password"
        }
        root.addView(pwBox)
        val msg = label("")
        val unlock = Button(this).apply { text = "Unlock (admin only)" }
        unlock.setOnClickListener {
            val id = idBox.text.toString().trim()
            val pw = pwBox.text.toString()
            if (id.isEmpty() || pw.isEmpty()) { msg.text = "Enter the admin ID and password."; return@setOnClickListener }
            val url = prefs.getString("url", "") ?: ""
            msg.text = "Checking..."
            Thread {
                val j = parse(Syncer.post(url, JSONObject().put("action", "login").put("adminId", id).put("adminPass", pw).toString()))
                runOnUiThread {
                    when {
                        j == null -> msg.text = "Cannot check right now. Internet is needed to unlock."
                        !j.optBoolean("ok") -> msg.text = j.optString("msg", "Not allowed.")
                        else -> { unlocked = true; render() }
                    }
                }
            }.start()
        }
        root.addView(unlock)
        root.addView(msg)
        show(root)
    }

    // ---------------- Screen 1: admin setup ----------------
    private fun setupScreen() {
        val root = newRoot()
        root.addView(label("Call Tracker - Admin setup", 22f))
        root.addView(label("This phone is not connected yet. Only the manager can set it up."))

        root.addView(label("Web App URL"))
        val urlBox = EditText(this).apply {
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            hint = "https://script.google.com/macros/s/.../exec"
        }
        root.addView(urlBox)

        root.addView(label("Admin ID"))
        val idBox = EditText(this).apply { inputType = InputType.TYPE_CLASS_TEXT; hint = "Admin ID" }
        root.addView(idBox)

        root.addView(label("Admin password"))
        val pwBox = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            hint = "Admin password"
        }
        root.addView(pwBox)

        val msg = label("")
        val connect = Button(this).apply { text = "Connect (admin only)" }
        connect.setOnClickListener {
            val url = urlBox.text.toString().trim()
            val id = idBox.text.toString().trim()
            val pw = pwBox.text.toString()
            if (url.isEmpty() || id.isEmpty() || pw.isEmpty()) { msg.text = "Fill all three boxes."; return@setOnClickListener }
            msg.text = "Checking..."
            Thread {
                val reply = Syncer.post(url, JSONObject().put("action", "login").put("adminId", id).put("adminPass", pw).toString())
                val j = parse(reply)
                runOnUiThread {
                    when {
                        reply == null -> msg.text = "Could not reach the Sheet. Check the URL and internet."
                        j == null -> msg.text = "The Sheet did not accept the request. Check the URL and that the web app access is set to Anyone."
                        !j.optBoolean("ok") -> msg.text = j.optString("msg", "Not allowed.")
                        else -> {
                            val arr = j.optJSONArray("callers")
                            val names = Array(arr?.length() ?: 0) { arr!!.getString(it) }
                            if (names.isEmpty()) {
                                msg.text = "No callers with a token found in the Callers tab."
                            } else {
                                msg.text = ""
                                AlertDialog.Builder(this)
                                    .setTitle("Whose phone is this?")
                                    .setItems(names) { _, which -> enroll(url, id, pw, names[which], msg) }
                                    .setNegativeButton("Cancel", null)
                                    .show()
                            }
                        }
                    }
                }
            }.start()
        }
        root.addView(connect)
        root.addView(msg)
        show(root)
    }

    private fun enroll(url: String, id: String, pw: String, caller: String, msg: TextView) {
        msg.text = "Connecting $caller..."
        Thread {
            val reply = Syncer.post(url, JSONObject().put("action", "enroll").put("adminId", id).put("adminPass", pw).put("caller", caller).toString())
            val j = parse(reply)
            runOnUiThread {
                if (j == null || !j.optBoolean("ok")) {
                    msg.text = j?.optString("msg", "Could not connect.") ?: "Could not connect. Try again."
                } else {
                    prefs.edit()
                        .putString("url", url)
                        .putString("token", j.getString("token"))
                        .putString("caller", caller)
                        .putBoolean("enrolled", true)
                        .apply()
                    unlocked = true
                    schedule()
                    requestPermissions(arrayOf(Manifest.permission.READ_CALL_LOG), 1)
                    Thread { Syncer.run(applicationContext); runOnUiThread { render() } }.start()
                    render()
                }
            }
        }.start()
    }

    private fun parse(s: String?): JSONObject? = try { if (s == null) null else JSONObject(s) } catch (e: Exception) { null }

    // ---------------- Screen 2: status only ----------------
    private fun statusScreen() {
        val root = newRoot()
        root.addView(label("Call Tracker", 22f))
        root.addView(label("Connected as: ${prefs.getString("caller", "")}", 18f))
        root.addView(label("Your manager can see your call time, number, direction and duration. Call audio and message text are never recorded. For WhatsApp only call time, duration and message counts are counted."))

        val granted = checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            root.addView(label("Call log permission is OFF. Calls cannot be tracked until you allow it."))
            root.addView(Button(this).apply {
                text = "Allow call log"
                setOnClickListener { requestPermissions(arrayOf(Manifest.permission.READ_CALL_LOG), 1) }
            })
        }

        if (!WaListener.isEnabled(this)) {
            root.addView(label("WhatsApp tracking is OFF. Tap the button, find Call Tracker in the list and switch it ON."))
            root.addView(Button(this).apply {
                text = "Allow WhatsApp tracking"
                setOnClickListener {
                    openSettings(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                }
            })
        } else {
            root.addView(label("WhatsApp tracking: ON (calls and incoming message counts only)."))
        }

        val status = label("Last result: " + prefs.getString("status", "nothing sent yet"))
        root.addView(Button(this).apply {
            text = "Send calls now"
            setOnClickListener {
                status.text = "Sending..."
                Thread {
                    val r = Syncer.run(applicationContext)
                    runOnUiThread { status.text = "Last result: $r" }
                }.start()
            }
        })
        root.addView(Button(this).apply {
            text = "Battery: set to Unrestricted"
            setOnClickListener {
                openSettings(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
        })
        root.addView(status)
        root.addView(label("Please keep this app installed and the call log permission allowed. The app sends automatically every 15 minutes."))
        show(root)
    }

    private fun schedule() {
        val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(applicationContext)
            .enqueueUniquePeriodicWork("sync", ExistingPeriodicWorkPolicy.UPDATE, req)
    }
}
