package com.siyi.al;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.siyi.al.execution.AlExecutionService;
import com.siyi.al.execution.RoomExecutionStore;
import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import com.siyi.al.execution.api.ApiConfig;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ChangeEventEntity;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.secure.AlSecretStore;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
            Double temperature = call.getDouble("temperature", 0.8);
            ApiConfig config = new ApiConfig(
                required(call, "baseUrl"),
                required(call, "apiKey"),
                required(call, "model"),
                temperature == null ? 0.8 : temperature
            );
            secrets.saveApiConfig(configId, config);
            JSObject result = new JSObject();
            result.put("saved", true);
            result.put("configId", configId);
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

    private JSObject turnResult(ChatTurnEntity turn) {
        JSObject result = new JSObject();
        result.put("turnId", turn.turnId);
        result.put("characterId", turn.characterId);
        result.put("sourceMessageId", turn.sourceMessageId);
        result.put("kind", turn.kind);
        result.put("storedState", turn.state);
        result.put("state", store.displayState(turn.turnId).name());
        result.put("activeAttemptId", turn.activeAttemptId);
        result.put("createdAt", turn.createdAt);
        result.put("updatedAt", turn.updatedAt);
        result.put("completedAt", turn.completedAt);
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

    private interface Operation {
        JSObject run() throws Exception;
    }
}
