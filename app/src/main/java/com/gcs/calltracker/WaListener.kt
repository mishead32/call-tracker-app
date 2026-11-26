package com.gcs.calltracker

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

/** Small on-phone queue of WhatsApp events waiting to be sent to the Sheet. */
object WaQueue {
    private const val KEY = "queue"
    @Synchronized fun add(ctx: Context, e: JSONObject) {
        val p = ctx.getSharedPreferences("ct_wa", Context.MODE_PRIVATE)
        val arr = try { JSONArray(p.getString(KEY, "[]")) } catch (x: Exception) { JSONArray() }
        arr.put(e)
        // keep it bounded (phone offline for days)
        val keep = JSONArray()
        for (i in maxOf(0, arr.length() - 2000) until arr.length()) keep.put(arr.get(i))
        p.edit().putString(KEY, keep.toString()).apply()
    }
    @Synchronized fun peek(ctx: Context): JSONArray {
        val p = ctx.getSharedPreferences("ct_wa", Context.MODE_PRIVATE)
        return try { JSONArray(p.getString(KEY, "[]")) } catch (x: Exception) { JSONArray() }
    }
    /** Removes the first [n] events (the ones that were just sent). */
    @Synchronized fun drop(ctx: Context, n: Int) {
        val p = ctx.getSharedPreferences("ct_wa", Context.MODE_PRIVATE)
        val arr = peek(ctx)
        val rest = JSONArray()
        for (i in n until arr.length()) rest.put(arr.get(i))
        p.edit().putString(KEY, rest.toString()).apply()
    }
}

/**
 * Watches WhatsApp notifications ONLY to count calls and messages. It never saves message text, names or numbers:
 * the notification text is looked at on the phone for words like "missed" / "ongoing" and then forgotten.
 * Calls: ringing, ongoing (start/end gives duration), missed.   Messages: incoming only (outgoing is not visible).
 */
class WaListener : NotificationListenerService() {

    companion object {
        val PACKAGES = setOf("com.whatsapp", "com.whatsapp.w4b")

        fun isEnabled(ctx: Context): Boolean {
            val s = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return false
            return s.contains(ctx.packageName)
        }

        fun rebind(ctx: Context) {
            try { requestRebind(ComponentName(ctx, WaListener::class.java)) } catch (e: Exception) {}
        }

        // in-memory call state (one WhatsApp call at a time)
        private var ringAt = 0L
        private var lastMissed = 0L
        private var ringVideo = false
        private var activeKey: String? = null
        private var activeStart = 0L
        private var activeIncoming = false
        private var activeVideo = false
        private val msgSeen = HashMap<String, Int>()
    }

    private fun ev(kind: String, time: Long, video: Boolean, duration: Long, count: Int): JSONObject =
        JSONObject().put("time", time).put("kind", kind).put("video", video).put("duration", duration).put("count", count)

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in PACKAGES) return
        val n = sbn.notification ?: return
        val ex = n.extras ?: return
        val text = ((ex.getCharSequence(Notification.EXTRA_TEXT) ?: "").toString() + " " +
                (ex.getCharSequence(Notification.EXTRA_TITLE) ?: "").toString()).lowercase()
        val now = System.currentTimeMillis()
        val isCallCat = n.category == Notification.CATEGORY_CALL
        val callWords = Regex("(voice|video) call|calling|ringing|incoming|ongoing|missed")
        val looksLikeCall = isCallCat || (n.category != Notification.CATEGORY_MESSAGE && callWords.containsMatchIn(text))

        if (looksLikeCall) {
            val video = text.contains("video")
            when {
                text.contains("missed") -> {
                    if (sbn.postTime != lastMissed) {
                        lastMissed = sbn.postTime
                        WaQueue.add(this, ev("MISSED", sbn.postTime, video, 0, 1))
                    }
                }
                text.contains("ongoing") || (n.flags and Notification.FLAG_ONGOING_EVENT != 0 && !text.contains("incoming")) -> {
                    if (activeKey != sbn.key) {
                        activeKey = sbn.key; activeStart = now; activeVideo = video
                        activeIncoming = now - ringAt < 120_000
                    }
                }
                text.contains("incoming") || text.contains("ringing") -> { ringAt = now; ringVideo = video }
                else -> { /* "calling..." for outgoing: nothing to store until it becomes ongoing */ }
            }
            return
        }

        if (n.category == Notification.CATEGORY_MESSAGE && (n.flags and Notification.FLAG_GROUP_SUMMARY) == 0) {
            val msgs = ex.getParcelableArray(Notification.EXTRA_MESSAGES)
            val count = msgs?.size ?: 1
            val before = msgSeen[sbn.key] ?: 0
            val add = if (before == 0) maxOf(1, count) else maxOf(0, count - before)
            msgSeen[sbn.key] = count
            if (msgSeen.size > 300) msgSeen.clear()
            if (add > 0) WaQueue.add(this, ev("MSG_IN", now, false, 0, add))
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        if (sbn.packageName !in PACKAGES) return
        msgSeen.remove(sbn.key)
        if (activeKey != null && activeKey == sbn.key) {
            val end = System.currentTimeMillis()
            val sec = (end - activeStart) / 1000
            if (sec >= 3) WaQueue.add(this, ev(if (activeIncoming) "CALL_IN" else "CALL_OUT", activeStart, activeVideo, sec, 1))
            activeKey = null
        }
    }
}
