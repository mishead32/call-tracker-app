# Call Tracker (GCS)
Android app that sends telecaller call logs (time, number, direction, duration) to a Google Sheet.
- `app/` - Android app (Kotlin). Built automatically by GitHub Actions into `CallTracker.apk` (see Releases).
- `apps-script/Code.gs` - paste into the Google Sheet's Apps Script. Builds Call Log + Daily Summary (calls, talktime, idle).
