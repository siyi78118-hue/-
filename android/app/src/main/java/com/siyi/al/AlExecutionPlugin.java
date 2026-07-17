package com.siyi.al;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.siyi.al.execution.AlBackgroundCoordinator;
import com.siyi.al.execution.AlExecutionService;
import com.siyi.al.execution.AlExecutionWakeWorker;
import com.siyi.al.execution.AlNotificationStatus;
import com.siyi.al.execution.AutomaticTaskCleanupResult;
import com.siyi.al.execution.RoomExecutionStore;
import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import com.siyi.al.execution.api.ApiConfig;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ChangeEventEntity;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.CharacterSnapshotEntity;
import com.siyi.al.execution.db.DiagnosticEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.db.RolePlanEntity;
import com.siyi.al.execution.db.RolePlanHistoryEntity;
import com.siyi.al.execution.RolePlanAlarmScheduler;
import com.siyi.al.execution.AutomaticTaskAlarmScheduler;
import com.siyi.al.execution.secure.AlSecretStore;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "AlExecution")
public final class AlExecutionPlugin extends Plugin {
    private ExecutorService io;
    private RoomExecutionStore store;
    private AlSecretStore secrets;

    @Override
    public void load() {
        io = Executors.newSingleThreadExecutor();
        store = new RoomExecutionStore(AlExecutionDatabase.get(getContext()));
        secrets = new AlSecretStore(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        if (io != null) io.shutdownNow();
    }

    @PluginMethod
    public void saveApiConfig(PluginCall call) {
        execute(call, () -> {
            String configId = required(call, "configId");
            Boolean sendTemperature = call.getBoolean("sendTemperature", true);
            Double temperature = call.getDouble("temperature", 0.8);
            ApiConfig config = new ApiConfig(
                required(call, "baseUrl"),
                required(call, "apiKey"),
                required(call, "model"),
                Boolean.FALSE.equals(sendTemperature) ? null : (temperature == null ? 0.8 : temperature)
            );
            secrets.saveApiConfig(configId, config);
            JSObject result = new JSObject();
            result.put("saved", true);
            result.put("configId", configId);
            return result;
        });
    }

    @PluginMethod
    public void saveProactiveSnapshot(PluginCall call) {
        execute(call, () -> {
            CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
            snapshot.snapshotId = required(call, "snapshotId");
            snapshot.characterId = required(call, "characterId");
            snapshot.characterName = call.getString("characterName", "AL");
            snapshot.playerName = call.getString("playerName", "我");
            snapshot.systemPrompt = call.getString("systemPrompt", "");
            snapshot.momentSystemPrompt = call.getString("momentSystemPrompt", "");
            snapshot.contextJson = required(call, "snapshotJson");
            JSONObject context = new JSONObject(snapshot.contextJson);
            snapshot.scheduledFor = context.has("scheduledFor") && !context.isNull("scheduledFor") ? context.optLong("scheduledFor") : null;
            snapshot.automaticKind = context.optString("proactiveKind", "");
            snapshot.cloudJobId = context.optString("cloudJobId", "").trim();
            snapshot.automaticTasksEnabled = context.optBoolean("automaticTasksEnabled", false);
            snapshot.jobSnapshot = !snapshot.cloudJobId.isEmpty() && snapshot.snapshotId.endsWith(":" + snapshot.cloudJobId);
            snapshot.chatConfigId = call.getString("chatConfigId", "chat-v1");
            snapshot.memoryConfigId = call.getString("memoryConfigId", "memory-v1");
            Long createdAt = call.getLong("createdAt", System.currentTimeMillis());
            snapshot.createdAt = createdAt == null ? System.currentTimeMillis() : createdAt;
            AlExecutionDatabase.get(getContext()).executionDao().upsertSnapshot(snapshot);
            if (snapshot.jobSnapshot && snapshot.scheduledFor != null && snapshot.automaticTasksEnabled) {
                AutomaticTaskAlarmScheduler.schedule(getContext(), snapshot.cloudJobId, snapshot.scheduledFor);
            }
            JSObject result = new JSObject();
            result.put("saved", true);
            result.put("snapshotId", snapshot.snapshotId);
            return result;
        });
    }

    @PluginMethod
    public void submitTurn(PluginCall call) {
        execute(call, () -> {
            String kindName = call.getString("kind", TurnKind.DIRECT_REPLY.name());
            Long createdAt = call.getLong("createdAt", System.currentTimeMillis());
            TurnSubmission submission = new TurnSubmission(
                required(call, "turnId"),
                required(call, "characterId"),
                required(call, "sourceMessageId"),
                TurnKind.valueOf(kindName),
                call.getString("inputJson", "{}"),
                required(call, "snapshotJson"),
                call.getString("cloudJobId"),
                createdAt == null ? System.currentTimeMillis() : createdAt
            );
            ChatTurnEntity turn = store.submitTurn(submission);
            AlExecutionService.requestRun(getContext());
            return turnResult(turn);
        });
    }

    @PluginMethod
    public void retryTurn(PluginCall call) {
        execute(call, () -> {
            String turnId = required(call, "turnId");
            ExecutionAttemptEntity attempt = store.startRetry(turnId, System.currentTimeMillis());
            AlExecutionService.requestRun(getContext());
            JSObject result = turnResult(store.turn(turnId));
            result.put("attemptId", attempt.attemptId);
            return result;
        });
    }

    @PluginMethod
    public void cancelTurn(PluginCall call) {
        execute(call, () -> {
            String turnId = required(call, "turnId");
            Boolean deleted = call.getBoolean("deleted", false);
            store.cancelTurn(turnId, System.currentTimeMillis(), Boolean.TRUE.equals(deleted));
            return turnResult(store.turn(turnId));
        });
    }

    @PluginMethod
    public void clearAutomaticTasks(PluginCall call) {
        execute(call, () -> {
            AutomaticTaskCleanupResult cleanup = store.clearAutomaticTasks(System.currentTimeMillis());
            AlExecutionWakeWorker.cancel(getContext());
            AlBackgroundCoordinator.ensureScheduled(getContext());
            AlExecutionService.requestRun(getContext());
            JSObject result = new JSObject();
            result.put("cancelledTurns", cleanup.cancelledTurns);
            result.put("cancelledAttempts", cleanup.cancelledAttempts);
            result.put("acknowledgedCompletedTurns", cleanup.acknowledgedCompletedTurns);
            result.put("deletedSnapshots", cleanup.deletedSnapshots);
            return result;
        });
    }

    @PluginMethod
    public void getTurn(PluginCall call) {
        execute(call, () -> {
            String turnId = required(call, "turnId");
            ChatTurnEntity turn = store.turn(turnId);
            if (turn == null) throw new IllegalArgumentException("Unknown turn: " + turnId);
            return turnResult(turn);
        });
    }

    @PluginMethod
    public void changesSince(PluginCall call) {
        execute(call, () -> {
            Long cursor = call.getLong("cursor", 0L);
            Integer limit = call.getInt("limit", 100);
            List<ChangeEventEntity> rows = store.changesAfter(
                cursor == null ? 0L : cursor,
                limit == null ? 100 : limit
            );
            JSArray changes = new JSArray();
            long nextCursor = cursor == null ? 0L : cursor;
            for (ChangeEventEntity row : rows) {
                JSObject item = new JSObject();
                item.put("cursor", row.cursor);
                item.put("turnId", row.turnId);
                item.put("type", row.type);
                item.put("payloadJson", row.payloadJson);
                item.put("createdAt", row.createdAt);
                changes.put(item);
                nextCursor = Math.max(nextCursor, row.cursor);
            }
            JSObject result = new JSObject();
            result.put("cursor", nextCursor);
            result.put("changes", changes);
            return result;
        });
    }

    @PluginMethod
    public void unappliedCompletedTurns(PluginCall call) {
        execute(call, () -> {
            Integer limit = call.getInt("limit", 200);
            JSArray turns = new JSArray();
            for (ChatTurnEntity turn : store.unappliedCompletedTurns(limit == null ? 200 : limit)) {
                turns.put(turnResult(turn));
            }
            JSObject result = new JSObject();
            result.put("turns", turns);
            return result;
        });
    }

    @PluginMethod
    public void acknowledgeUiApplied(PluginCall call) {
        execute(call, () -> {
            String turnId = required(call, "turnId");
            store.acknowledgeUiApplied(turnId, System.currentTimeMillis());
            return turnResult(store.turn(turnId));
        });
    }

    @PluginMethod
    public void nativeDiagnostics(PluginCall call) {
        execute(call, () -> {
            Integer limit = call.getInt("limit", 100);
            JSArray diagnostics = new JSArray();
            for (DiagnosticEntity row : store.latestDiagnostics(limit == null ? 100 : limit)) {
                JSObject item = new JSObject();
                item.put("diagnosticId", row.diagnosticId);
                item.put("turnId", row.turnId);
                item.put("attemptId", row.attemptId);
                item.put("level", row.level);
                item.put("code", row.code);
                item.put("detail", row.detail);
                item.put("createdAt", row.createdAt);
                diagnostics.put(item);
            }
            JSObject result = new JSObject();
            result.put("diagnostics", diagnostics);
            return result;
        });
    }

    @PluginMethod
    public void notificationStatus(PluginCall call) {
        execute(call, () -> {
            AlNotificationStatus.Snapshot status = AlNotificationStatus.inspect(getContext());
            JSObject result = new JSObject();
            result.put("permissionGranted", status.permissionGranted);
            result.put("appEnabled", status.appEnabled);
            result.put("channelExists", status.channelExists);
            result.put("importance", status.importance);
            result.put("hasSound", status.hasSound);
            result.put("vibrationEnabled", status.vibrationEnabled);
            result.put("lockscreenVisibility", status.lockscreenVisibility);
            result.put("healthy", status.healthy);
            result.put("summary", status.summary);
            return result;
        });
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        execute(call, () -> {
            getContext().startActivity(AlNotificationStatus.settingsIntent(getContext()));
            JSObject result = new JSObject();
            result.put("opened", true);
            return result;
        });
    }

    @PluginMethod
    public void listRolePlans(PluginCall call) {
        execute(call, () -> {
            String characterId = required(call, "characterId");
            Boolean includeTerminal = call.getBoolean("includeTerminal", true);
            JSArray plans = new JSArray();
            for (RolePlanEntity row : AlExecutionDatabase.get(getContext()).executionDao().rolePlans(characterId)) {
                if (Boolean.FALSE.equals(includeTerminal) && ("completed".equals(row.status) || "cancelled".equals(row.status))) continue;
                plans.put(new JSObject(row.planJson));
            }
            JSObject result = new JSObject();
            result.put("plans", plans);
            return result;
        });
    }

    @PluginMethod
    public void replaceRolePlans(PluginCall call) {
        execute(call, () -> {
            String characterId = required(call, "characterId");
            JSONArray planValues = new JSONArray(call.getString("plansJson", "[]"));
            JSONArray historyValues = new JSONArray(call.getString("historyJson", "[]"));
            List<RolePlanEntity> plans = new ArrayList<>();
            List<RolePlanHistoryEntity> history = new ArrayList<>();
            for (int index = 0; index < planValues.length(); index += 1) {
                JSONObject value = planValues.getJSONObject(index);
                RolePlanEntity row = new RolePlanEntity();
                row.planId = requiredJson(value, "planId");
                row.characterId = characterId;
                row.status = value.optString("status", "active");
                row.planJson = value.toString();
                row.nextRunAt = value.has("nextRunAt") && !value.isNull("nextRunAt") ? value.optLong("nextRunAt") : null;
                row.updatedAt = value.optLong("updatedAt", System.currentTimeMillis());
                plans.add(row);
            }
            for (int index = 0; index < historyValues.length(); index += 1) {
                JSONObject value = historyValues.getJSONObject(index);
                RolePlanHistoryEntity row = new RolePlanHistoryEntity();
                row.historyId = requiredJson(value, "historyId");
                row.planId = requiredJson(value, "planId");
                row.historyJson = value.toString();
                row.createdAt = value.optLong("createdAt", System.currentTimeMillis());
                history.add(row);
            }
            AlExecutionDatabase.get(getContext()).executionDao().replaceRolePlans(characterId, plans, history);
            RolePlanAlarmScheduler.rescheduleAll(getContext());
            JSObject result = new JSObject();
            result.put("saved", true);
            result.put("count", plans.size());
            return result;
        });
    }

    @PluginMethod
    public void rolePlanHistory(PluginCall call) {
        execute(call, () -> {
            String planId = required(call, "planId");
            Integer requestedLimit = call.getInt("limit", 100);
            int limit = Math.max(1, Math.min(requestedLimit == null ? 100 : requestedLimit, 200));
            JSArray history = new JSArray();
            for (RolePlanHistoryEntity row : AlExecutionDatabase.get(getContext()).executionDao().rolePlanHistory(planId, limit)) {
                history.put(new JSObject(row.historyJson));
            }
            JSObject result = new JSObject();
            result.put("history", history);
            return result;
        });
    }

    private JSObject turnResult(ChatTurnEntity turn) {
        JSObject result = new JSObject();
        result.put("turnId", turn.turnId);
        result.put("characterId", turn.characterId);
        result.put("sourceMessageId", turn.sourceMessageId);
        result.put("kind", turn.kind);
        result.put("inputJson", turn.inputJson);
        result.put("cloudJobId", turn.cloudJobId);
        result.put("storedState", turn.state);
        result.put("state", store.displayState(turn.turnId).name());
        result.put("activeAttemptId", turn.activeAttemptId);
        result.put("createdAt", turn.createdAt);
        result.put("updatedAt", turn.updatedAt);
        result.put("completedAt", turn.completedAt);
        result.put("uiAppliedAt", turn.uiAppliedAt);
        ExecutionAttemptEntity attempt = store.activeAttempt(turn.turnId);
        if (attempt != null) {
            result.put("attemptId", attempt.attemptId);
            result.put("errorCode", attempt.errorCode);
            result.put("errorDetail", attempt.errorDetail);
            result.put("retryable", attempt.retryable);
        }
        JSArray parts = new JSArray();
        for (ReplyPartEntity part : store.replyParts(turn.turnId)) {
            JSObject item = new JSObject();
            item.put("replyPartId", part.replyPartId);
            item.put("sequence", part.sequence);
            item.put("type", part.type);
            item.put("content", part.content);
            item.put("payloadJson", part.payloadJson);
            item.put("createdAt", part.createdAt);
            parts.put(item);
        }
        result.put("replyParts", parts);
        return result;
    }

    private void execute(PluginCall call, Operation operation) {
        io.execute(() -> {
            try {
                call.resolve(operation.run());
            } catch (Exception error) {
                String detail = error.getMessage();
                call.reject(detail == null ? error.getClass().getSimpleName() : detail, error);
            }
        });
    }

    private static String required(PluginCall call, String name) {
        String value = call.getString(name);
        if (value == null || value.trim().isEmpty()) throw new IllegalArgumentException(name + " is required");
        return value.trim();
    }

    private static String requiredJson(JSONObject value, String name) {
        String result = value.optString(name, "").trim();
        if (result.isEmpty()) throw new IllegalArgumentException(name + " is required");
        return result;
    }

    private interface Operation {
        JSObject run() throws Exception;
    }
}
