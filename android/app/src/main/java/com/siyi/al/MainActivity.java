package com.siyi.al;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.siyi.al.execution.AlExecutionService;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(AlExecutionPlugin.class);
        registerPlugin(AlReplyQueuePlugin.class);
        super.onCreate(savedInstanceState);
        try {
            AlExecutionService.requestRun(this);
        } catch (RuntimeException ignored) {
            // The UI remains usable; a later WorkManager/FCM wake can retry the service.
        }
    }
}
