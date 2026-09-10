package com.rabi.link.modules.rokid

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.rabi.link.recording.RabiRecordingHubActivity

/** Compatibility for existing notifications; the hub owns all daily recording UI. */
class RabiLiveRecordingActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        startActivity(Intent(this, RabiRecordingHubActivity::class.java).putExtra("video", true)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }
}
