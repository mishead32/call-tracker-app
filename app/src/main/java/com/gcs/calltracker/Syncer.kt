package com.gcs.calltracker

import android.Manifest
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.provider.CallLog
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Reads the phone's call log (time, number, direction, duration only) and sends it to the company Sheet.
 * Every run also sends a "heartbeat" so the Sheet knows the app is still installed and working.
 */
object Syncer {

    private const val HOUR = 3600_000L
    const val VERSION = "1.3"

    fun run(ctx: Context): String {
        val p = ctx.getSharedPreferences("ct", Context.MODE_PRIVATE)
        val url = p.getString("url", "")?.trim().orEmpty()
        val token = p.getString("token", "")?.trim().orEmpty()
        if (url.isEmpty() || token.isEmpty()) return finish(p, "Not connected. Ask your manager to set up this phone.")

        val perm = ctx.checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED

        // First run: last 36 hours. Later runs: since last sent call (minus 1 hour overlap; the Sheet removes duplicates).
        val since = p.getLong("last", System.currentTimeMillis() - 36 * HOUR) - HOUR

        val waOn = WaListener.isEnabled(ctx)
        if (waOn) WaListener.rebind(ctx)
        val waEvents = WaQueue.peek(ctx)
        val calls = JSONArray()
        var newest = p.getLong("last", 0L)
        if (perm) {
            try {
                ctx.contentResolver.query(
                    CallLog.Calls.CONTENT_URI,
                    arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION),
                    "${CallLog.Calls.DATE} > ?",
                    arrayOf(since.toString()),
                    "${CallLog.Calls.DATE} ASC"
                )?.use { c ->
                    while (c.moveToNext()) {
                        val number = c.getString(0)?.takeIf { it.isNotBlank() } ?: "unknown"
                        val type = when (c.getInt(1)) {
                            CallLog.Calls.OUTGOING_TYPE -> "OUTGOING"
                            CallLog.Calls.INCOMING_TYPE -> "INCOMING"
                            CallLog.Calls.MISSED_TYPE -> "MISSED"
                            CallLog.Calls.REJECTED_TYPE -> "REJECTED"
                            else -> "OTHER"
                        }
                        val date = c.getLong(2)
                        val dur = c.getLong(3)
                        calls.put(JSONObject().put("time", date).put("number", number).put("type", type).put("duration", dur))
                        if (date > newest) newest = date
                    }
                }
            } catch (e: Exception) {
                return finish(p, "Could not read call log: ${e.message}")
            }
        }

        val total = calls.length()
        var added = 0
        var i = 0
        do {
            val end = minOf(i + 200, total)
            val chunk = JSONArray()
            for (j in i until end) chunk.put(calls.get(j))
            val body = JSONObject()
                .put("action", "sync").put("token", token).put("calls", chunk)
                .put("perm", perm).put("ver", VERSION).put("waAccess", waOn)
                .put("wa", if (i == 0) waEvents else JSONArray()).toString()
            val reply = post(url, body) ?: return finish(p, "Could not reach the Sheet. Check internet. Will retry.")
            if (!reply.contains("\"ok\":true")) return finish(p, "Sheet said: ${reply.take(120)}")
            added += Regex("\"added\":(\\d+)").find(reply)?.groupValues?.get(1)?.toInt() ?: 0
            i = end
        } while (i < total)

        WaQueue.drop(ctx, waEvents.length())
        if (perm && newest > 0) p.edit().putLong("last", newest).apply()
        return finish(
            p,
            when {
                !perm -> "Call log permission is OFF. Please allow it."
                total == 0 -> "Connected. No new calls." + (if (waEvents.length() > 0) " WhatsApp events sent: ${waEvents.length()}." else "")
                else -> "Sent $total calls ($added new)." + (if (waEvents.length() > 0) " WhatsApp events sent: ${waEvents.length()}." else "")
            }
        )
    }

    /** Sends JSON text to the web app; returns the reply text, or null if the network failed. */
    fun post(url: String, body: String): String? {
        return try {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 20000
            conn.readTimeout = 30000
            conn.doOutput = true
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("Content-Type", "text/plain;charset=UTF-8")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val text = (if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            conn.disconnect()
            text
        } catch (e: Exception) {
            null
        }
    }

    private fun finish(p: SharedPreferences, msg: String): String {
        val stamp = SimpleDateFormat("dd MMM, HH:mm", Locale.US).format(Date())
        val full = "$stamp - $msg"
        p.edit().putString("status", full).apply()
        return full
    }
}
