package com.siyi.al.execution;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class AlAutomaticAlarmReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        AlExecutionWakeWorker.enqueue(context);
    }
}
