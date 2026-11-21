package com.gcs.calltracker

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Reads the phone's call log (time, number, direction, duration only) and sends it to the Google Sheet. */
object Syncer {

    private const val HOUR = 3600_000L

    fun run(ctx: Context): String {
        val p = ctx.getSharedPreferences("ct", Context.MODE_PRIVATE)
        val url = p.getString("url", "")?.trim().orEmpty()
        val token = p.getString("token", "")?.trim().orEmpty()
        if (url.isEmpty() || token.isEmpty()) return finish(p, "Not set up: enter URL and token, then press Save.")
        if (ctx.checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
            return finish(p, "Call log permission is not allowed yet.")
        }

        // First run: start from yesterday midnight-ish (last 36 hours). Later runs: since last sent call (minus 1 hour overlap).
        val since = p.getLong("last", System.currentTimeMillis() - 36 * HOUR) - HOUR

        val calls = JSONArray()
        var newest = p.getLong("last", 0L)
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

        if (calls.length() == 0) return finish(p, "No new calls to send.")

        var sent = 0
        var added = 0
        var i = 0
        while (i < calls.length()) {
            val chunk = JSONArray()
            val end = minOf(i + 200, calls.length())
            for (j in i until end) chunk.put(calls.get(j))
            val body = JSONObject().put("token", token).put("calls", chunk).toString()
            val reply = post(url, body) ?: return finish(p, "Could not reach the Sheet. Check internet and URL. Will retry.")
            if (!reply.contains("\"ok\":true")) return finish(p, "Sheet said: ${reply.take(120)}")
            added += Regex("\"added\":(\\d+)").find(reply)?.groupValues?.get(1)?.toInt() ?: 0
            sent += end - i
            i = end
        }
        p.edit().putLong("last", newest).apply()
        return finish(p, "Sent $sent calls ($added new).")
    }

    private fun post(url: String, body: String): String? {
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

    private fun finish(p: android.content.SharedPreferences, msg: String): String {
        val stamp = SimpleDateFormat("dd MMM, HH:mm", Locale.US).format(Date())
        val full = "$stamp - $msg"
        p.edit().putString("status", full).apply()
        return full
    }
}
