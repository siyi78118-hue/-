package com.siyi.al;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.siyi.al.execution.AlExecutionService;
import com.siyi.al.execution.AlBackgroundCoordinator;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(AlExecutionPlugin.class);
        super.onCreate(savedInstanceState);
        AlBackgroundCoordinator.ensureScheduled(this);
        try {
            AlExecutionService.requestRun(this);
        } catch (RuntimeException ignored) {
            // The UI remains usable; a later WorkManager/FCM wake can retry the service.
        }
    }
}
