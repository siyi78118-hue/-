package com.siyi.al;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import io.ionic.backgroundrunner.plugin.RunnerWorker;
import java.util.Map;
import org.json.JSONObject;

public class AlFirebaseMessagingService extends MessagingService {
    private static final String RUNNER_LABEL = "com.siyi.al.background";
    private static final String RUNNER_SOURCE = "runners/al-background.js";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        Map<String, String> data = remoteMessage.getData();
        if (!"proactive".equals(data.get("type"))) return;

        JSONObject payload = new JSONObject(data);
        SharedPreferences prefs = getSharedPreferences(RUNNER_LABEL, Context.MODE_PRIVATE);
        prefs.edit().putString("pending_push", payload.toString()).apply();

        Data input = new Data.Builder()
            .putString("label", RUNNER_LABEL)
            .putString("src", RUNNER_SOURCE)
            .putString("event", "remoteNotification")
            .build();
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(RunnerWorker.class)
            .setInputData(input)
            .setConstraints(constraints)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .addTag(RUNNER_LABEL)
            .build();
        String jobId = data.get("jobId");
        String kind = data.get("kind");
        String uniqueName = RUNNER_LABEL + ":" + (kind == null ? "chat" : kind) + ":" + (jobId == null ? remoteMessage.getMessageId() : jobId);
        WorkManager.getInstance(this).enqueueUniqueWork(uniqueName, ExistingWorkPolicy.KEEP, work);
    }
}
