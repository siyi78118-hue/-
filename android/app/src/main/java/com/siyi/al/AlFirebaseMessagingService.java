package com.siyi.al;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import com.siyi.al.execution.AlExecutionService;
import com.siyi.al.execution.RoomExecutionStore;
import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.CharacterSnapshotEntity;
import java.util.Map;

public class AlFirebaseMessagingService extends MessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        if (!"proactive".equals(data.get("type"))) {
            super.onMessageReceived(remoteMessage);
            return;
        }
        String characterId = text(data.get("charId"));
        String jobId = text(data.get("jobId"));
        String kindName = "moment".equals(data.get("kind")) ? "moment" : "chat";
        if (characterId.isEmpty() || jobId.isEmpty()) return;

        AlExecutionDatabase database = AlExecutionDatabase.get(this);
        CharacterSnapshotEntity snapshot = database.executionDao().latestSnapshot(characterId + ":" + kindName);
        if (snapshot == null || snapshot.contextJson == null || snapshot.contextJson.trim().isEmpty()) return;

        String safeJobId = jobId.replaceAll("[^a-zA-Z0-9_-]", "_");
        TurnKind kind = "moment".equals(kindName) ? TurnKind.PROACTIVE_MOMENT : TurnKind.PROACTIVE_CHAT;
        RoomExecutionStore store = new RoomExecutionStore(database);
        store.submitTurn(new TurnSubmission(
            "cloud_" + safeJobId,
            characterId,
            "cloud_" + safeJobId,
            kind,
            "{}",
            snapshot.contextJson,
            jobId,
            System.currentTimeMillis()
        ));
        AlExecutionService.requestRun(this);
    }

    private static String text(String value) {
        return value == null ? "" : value.trim();
    }
}
