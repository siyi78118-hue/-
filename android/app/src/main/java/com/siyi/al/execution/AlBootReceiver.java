package com.siyi.al.execution;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class AlBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        try {
            AlExecutionService.requestRun(context);
        } catch (RuntimeException error) {
            AlExecutionWakeWorker.enqueue(context, 5);
        }
    }
}
