package com.gcs.calltracker

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
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
import java.util.concurrent.TimeUnit

class MainActivity : Activity() {

    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("ct", Context.MODE_PRIVATE)
        val pad = (16 * resources.displayMetrics.density).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        fun text(s: String, size: Float = 15f) = TextView(this).apply { text = s; textSize = size; setPadding(0, pad / 2, 0, pad / 4) }

        root.addView(text("Call Tracker", 22f))
        root.addView(text("Sends only call time, number, direction and duration to your company Sheet. No call audio."))

        root.addView(text("Web App URL (from your manager)"))
        val urlBox = EditText(this).apply {
            setText(prefs.getString("url", ""))
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            hint = "https://script.google.com/macros/s/.../exec"
        }
        root.addView(urlBox)

        root.addView(text("Secret token (your name's token)"))
        val tokenBox = EditText(this).apply {
            setText(prefs.getString("token", ""))
            hint = "e.g. a1b2c3d4"
            inputType = InputType.TYPE_CLASS_TEXT
        }
        root.addView(tokenBox)

        val save = Button(this).apply { text = "1. Save and allow call log" }
        save.setOnClickListener {
            prefs.edit().putString("url", urlBox.text.toString().trim()).putString("token", tokenBox.text.toString().trim()).apply()
            requestPermissions(arrayOf(Manifest.permission.READ_CALL_LOG), 1)
            schedule()
            refresh()
        }
        root.addView(save)

        val sync = Button(this).apply { text = "2. Send calls now (test)" }
        sync.setOnClickListener {
            status.text = "Sending..."
            Thread {
                val r = Syncer.run(applicationContext)
                runOnUiThread { status.text = r }
            }.start()
        }
        root.addView(sync)

        val battery = Button(this).apply { text = "3. Battery: set to Unrestricted" }
        battery.setOnClickListener {
            try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (e: Exception) {}
        }
        root.addView(battery)

        status = text("")
        root.addView(status)
        root.addView(text("After step 3, find Call Tracker in the list and choose Don't optimize / Unrestricted, so it keeps sending in the background every 15 minutes."))

        setContentView(ScrollView(this).apply {
            addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        })
        schedule()
        refresh()
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        status.text = "Last result: " + getSharedPreferences("ct", Context.MODE_PRIVATE).getString("status", "nothing sent yet")
    }

    private fun schedule() {
        val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(applicationContext)
            .enqueueUniquePeriodicWork("sync", ExistingPeriodicWorkPolicy.UPDATE, req)
    }
}
