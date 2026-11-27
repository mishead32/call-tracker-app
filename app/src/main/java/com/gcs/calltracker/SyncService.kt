package com.gcs.calltracker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.database.ContentObserver
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.CallLog

/** Starts the always-on service (only on phones that were set up by the admin). */
object ServiceStarter {
    fun start(ctx: Context) {
        try {
            if (!ctx.getSharedPreferences("ct", Context.MODE_PRIVATE).getBoolean("enrolled", false)) return
            val i = Intent(ctx, SyncService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        } catch (e: Exception) { /* Android may refuse from the background; the 15-minute job and the next app start retry */ }
    }
}

/**
 * Keeps the app alive so Android does not put it to sleep. It sends the call log about 20 seconds after
 * every call (it watches the phone's call log) and also every 15 minutes as a backup.
 */
class SyncService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var pending = false

    private val observer = object : ContentObserver(handler) {
        override fun onChange(selfChange: Boolean) { scheduleSync(20_000) }
    }

    private val tick = object : Runnable {
        override fun run() { scheduleSync(0); handler.postDelayed(this, 15 * 60_000L) }
    }

    private fun scheduleSync(delayMs: Long) {
        if (pending) return
        pending = true
        handler.postDelayed({
            pending = false
            Thread { try { Syncer.run(applicationContext) } catch (e: Exception) {} }.start()
        }, delayMs)
    }

    override fun onCreate() {
        super.onCreate()
        val ch = "ct_running"
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val n: Notification = if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(ch, "Call Tracker", NotificationManager.IMPORTANCE_MIN))
            Notification.Builder(this, ch)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }.setContentTitle("Call Tracker is running")
            .setContentText("Calls are sent to your manager automatically.")
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setOngoing(true)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            else startForeground(1, n)
        } catch (e: Exception) { stopSelf(); return }
        try { contentResolver.registerContentObserver(CallLog.Calls.CONTENT_URI, true, observer) } catch (e: Exception) {}
        handler.postDelayed(tick, 5_000)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int) = START_STICKY
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        try { contentResolver.unregisterContentObserver(observer) } catch (e: Exception) {}
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}

/** Restarts the service after the phone reboots or the app is updated. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent?) { ServiceStarter.start(ctx) }
}
