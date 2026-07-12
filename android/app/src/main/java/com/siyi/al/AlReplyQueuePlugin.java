package com.siyi.al;

import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import io.ionic.backgroundrunner.plugin.RunnerWorker;

@CapacitorPlugin(name = "AlReplyQueue")
public class AlReplyQueuePlugin extends Plugin {
    private static final String RUNNER_LABEL = "com.siyi.al.background";
    private static final String RUNNER_SOURCE = "runners/al-background.js";

    @PluginMethod
    public void enqueue(PluginCall call) {
        String taskId = call.getString("taskId");
        if (taskId == null || taskId.trim().isEmpty()) {
            call.reject("taskId is required");
            return;
        }

        Data input = new Data.Builder()
            .putString("label", RUNNER_LABEL)
            .putString("src", RUNNER_SOURCE)
            .putString("event", "pendingUserReply")
            .build();
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(RunnerWorker.class)
            .setInputData(input)
            .setConstraints(constraints)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .addTag(RUNNER_LABEL)
            .addTag("al-user-reply")
            .build();

        String workName = RUNNER_LABEL + ":user-reply:" + taskId.trim();
        WorkManager.getInstance(getContext()).enqueueUniqueWork(workName, ExistingWorkPolicy.KEEP, work);
        JSObject result = new JSObject();
        result.put("accepted", true);
        result.put("taskId", taskId.trim());
        call.resolve(result);
    }
}
