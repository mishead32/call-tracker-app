package com.gcs.calltracker

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        ServiceStarter.start(applicationContext)
        Syncer.run(applicationContext)
        return Result.success()
    }
}
