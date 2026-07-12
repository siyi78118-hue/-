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
import org.json.JSONArray;
import org.json.JSONObject;

public class AlFirebaseMessagingService extends MessagingService {
    private static final String RUNNER_LABEL = "com.siyi.al.background";
    private static final String RUNNER_SOURCE = "runners/al-background.js";
    private static final String PENDING_PUSH_QUEUE = "pending_push_queue";
    private static final String PUSH_WORK_NAME = RUNNER_LABEL + ":push-queue";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        Map<String, String> data = remoteMessage.getData();
        if (!"proactive".equals(data.get("type"))) return;

        JSONObject payload = new JSONObject(data);
        SharedPreferences prefs = getSharedPreferences(RUNNER_LABEL, Context.MODE_PRIVATE);
        appendPendingPush(prefs, payload);

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
        WorkManager.getInstance(this).enqueueUniqueWork(PUSH_WORK_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, work);
    }

    private static synchronized void appendPendingPush(SharedPreferences prefs, JSONObject payload) {
        JSONArray queue;
        try {
            queue = new JSONArray(prefs.getString(PENDING_PUSH_QUEUE, "[]"));
        } catch (Exception ignored) {
            queue = new JSONArray();
        }
        String jobId = payload.optString("jobId", "");
        for (int i = 0; i < queue.length(); i++) {
            JSONObject queued = queue.optJSONObject(i);
            if (!jobId.isEmpty() && jobId.equals(queued == null ? "" : queued.optString("jobId", ""))) return;
        }
        queue.put(payload);
        prefs.edit().putString(PENDING_PUSH_QUEUE, queue.toString()).commit();
    }
}
