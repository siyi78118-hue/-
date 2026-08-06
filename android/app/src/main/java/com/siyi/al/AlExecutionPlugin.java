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
import com.siyi.al.execution.BridgeReceiptCheckpoint;
import com.siyi.al.execution.ExecutionServicePolicy;
import com.siyi.al.execution.RoomExecutionStore;
import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import com.siyi.al.execution.api.ApiConfig;
import com.siyi.al.execution.bridge.BridgeConfig;
import com.siyi.al.execution.bridge.BridgeMode;
import com.siyi.al.execution.bridge.BridgeStatusProbe;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ChangeEventEntity;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.CharacterSnapshotEntity;
import com.siyi.al.execution.db.ConversationCursorEntity;
import com.siyi.al.execution.db.DiagnosticEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.db.RawMessageEntity;
import com.siyi.al.execution.db.RolePlanEntity;
import com.siyi.al.execution.db.RolePlanHistoryEntity;
import com.siyi.al.execution.db.SyncCursorEntity;
import com.siyi.al.execution.db.YuqiAnnotationEntity;
import com.siyi.al.execution.RolePlanAlarmScheduler;
import com.siyi.al.execution.AutomaticTaskAlarmScheduler;
import com.siyi.al.execution.secure.AlSecretStore;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.UUID;
import java.lang.ref.WeakReference;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "AlExecution")
public final class AlExecutionPlugin extends Plugin {
    private static WeakReference<AlExecutionPlugin> activeInstance = new WeakReference<>(null);
    private ExecutorService io;
    private RoomExecutionStore store;
    private AlSecretStore secrets;

    @Override
    public void load() {
        io = Executors.newSingleThreadExecutor();
        store = new RoomExecutionStore(AlExecutionDatabase.get(getContext()));
        secrets = new AlSecretStore(getContext());
        activeInstance = new WeakReference<>(this);
    }

    @Override
    protected void handleOnDestroy() {
        AlExecutionPlugin current = activeInstance.get();
        if (current == this) activeInstance.clear();
        if (io != null) io.shutdownNow();
    }

    public static void notifyCompletedTurn(String turnId, long updatedAt) {
        AlExecutionPlugin plugin = activeInstance.get();
        if (plugin == null) return;
        new Handler(Looper.getMainLooper()).post(() -> {
            JSObject payload = new JSObject();
            payload.put("turnId", turnId == null ? "" : turnId);
            payload.put("updatedAt", updatedAt);
            plugin.notifyListeners("executionCompleted", payload, true);
        });
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
    public void removeApiConfig(PluginCall call) {
        execute(call, () -> {
            String configId = required(call, "configId");
            secrets.removeApiConfig(configId);
            JSObject result = new JSObject();
            result.put("removed", true);
            result.put("configId", configId);
            return result;
        });
    }

    @PluginMethod
    public void saveBridgeConfig(PluginCall call) {
        execute(call, () -> {
            BridgeConfig current = secrets.loadBridgeConfig();
            String deviceId = optional(call, "deviceId", current.deviceId);
            if (deviceId.isEmpty()) deviceId = "device_" + UUID.randomUUID().toString().replace("-", "");
            BridgeConfig config = new BridgeConfig(
                Boolean.TRUE.equals(call.getBoolean("enabled", current.enabled)),
                BridgeMode.parse(optional(call, "mode", current.mode.name())),
                optional(call, "lanUrl", current.lanUrl),
                optional(call, "cloudUrl", current.cloudUrl),
                deviceId,
                optional(call, "pairingSecret", current.pairingSecret),
                optional(call, "deviceToken", current.deviceToken),
                optional(call, "encryptionKeyBase64", current.encryptionKeyBase64),
                integer(call, "connectTimeoutMs", current.connectTimeoutMs),
                integer(call, "readTimeoutMs", current.readTimeoutMs),
                integer(call, "cloudPollAttempts", current.cloudPollAttempts),
                integer(call, "cloudPollIntervalMs", current.cloudPollIntervalMs),
                integer(call, "turnDeadlineMs", current.turnDeadlineMs)
            );
            secrets.saveBridgeConfig(config);
            return bridgeConfigResult(config);
        });
    }

    @PluginMethod
    public void loadBridgeConfig(PluginCall call) {
        execute(call, () -> bridgeConfigResult(secrets.loadBridgeConfig()));
    }

    @PluginMethod
    public void yuqiBridgeStatus(PluginCall call) {
        execute(call, () -> {
            BridgeConfig config = secrets.loadBridgeConfig();
            SyncCursorEntity cursor = AlExecutionDatabase.get(getContext()).executionDao().syncCursor("yuqi_pc");
            long ackSeq = cursor == null ? 0L : cursor.ackSeq;
            BridgeStatusProbe.Snapshot live = BridgeStatusProbe.probe(config);
            JSObject result = bridgeConfigResult(config);
            result.put("lanReady", config.hasLan());
            result.put("cloudReady", config.hasCloud());
            result.put("syncAckSeq", ackSeq);
            result.put("pendingRawMessages", AlExecutionDatabase.get(getContext()).executionDao().rawMessageCountAfterSync(ackSeq));
            result.put("verifiedFacts", AlExecutionDatabase.get(getContext()).executionDao().verifiedYuqiFactCount());
            result.put("pendingAnnotations", AlExecutionDatabase.get(getContext()).executionDao().pendingYuqiAnnotationCount());
            result.put("lanOnline", live.lanOnline);
            result.put("cloudOnline", live.cloudOnline);
            result.put("quotaWarningLevel", live.quotaWarningLevel);
            result.put("threadHealth", live.threadHealth);
            result.put("presetVersion", live.presetVersion);
            result.put("lanError", live.lanError);
            result.put("cloudError", live.cloudError);
            return result;
        });
    }

    @PluginMethod
    public void saveYuqiAnnotation(PluginCall call) {
        execute(call, () -> {
            String correction = optional(call, "userCorrection", "");
            String desiredBehavior = optional(call, "desiredBehavior", "");
            if (correction.isEmpty() && desiredBehavior.isEmpty()) throw new IllegalArgumentException("annotation content is required");
            YuqiAnnotationEntity annotation = new YuqiAnnotationEntity();
            annotation.annotationId = optional(call, "annotationId", "annotation_" + UUID.randomUUID().toString().replace("-", ""));
            annotation.turnId = required(call, "turnId");
            String sourceMessageId = optional(call, "sourceMessageId", "");
            annotation.sourceMessageId = sourceMessageId.isEmpty() ? null : sourceMessageId;
            annotation.presetVersion = optional(call, "presetVersion", "1.0.0");
            annotation.userCorrection = correction;
            annotation.desiredBehavior = desiredBehavior;
            annotation.status = "proposed";
            annotation.createdAt = System.currentTimeMillis();
            annotation.syncSeq = AlExecutionDatabase.get(getContext()).executionDao()
                .allocateJournalSyncSeq(annotation.createdAt);
            annotation.checksum = annotation.annotationId;
            long inserted = AlExecutionDatabase.get(getContext()).executionDao().insertYuqiAnnotation(annotation);
            JSObject result = new JSObject();
            result.put("saved", inserted != -1L);
            result.put("annotationId", annotation.annotationId);
            result.put("syncSeq", annotation.syncSeq);
            result.put("presetVersion", annotation.presetVersion);
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
    public void ingestVisibleMessages(PluginCall call) {
        execute(call, () -> {
            String characterId = required(call, "characterId");
            JSONArray values = new JSONArray(call.getString("messagesJson", "[]"));
            int inserted = 0;
            for (int index = 0; index < values.length(); index += 1) {
                JSONObject value = values.getJSONObject(index);
                String messageId = requiredJson(value, "messageId");
                if (AlExecutionDatabase.get(getContext()).executionDao().rawMessage(messageId) != null) continue;
                String speakerType = value.optString("speakerType", "").trim();
                String speakerId = value.optString("speakerId", "").trim();
                if ("user".equals(speakerType) && !"user".equals(speakerId)) {
                    throw new IllegalArgumentException("user speaker attribution mismatch");
                }
                if ("character".equals(speakerType) && !characterId.equals(speakerId)) {
                    throw new IllegalArgumentException("character speaker attribution mismatch");
                }
                if (!"user".equals(speakerType) && !"character".equals(speakerType)) {
                    throw new IllegalArgumentException("speakerType is invalid");
                }
                RawMessageEntity row = new RawMessageEntity();
                row.messageId = messageId;
                row.turnId = value.optString("turnId", "turn_legacy_" + messageId).trim();
                if (row.turnId.isEmpty()) row.turnId = "turn_legacy_" + messageId;
                row.characterId = characterId;
                row.speakerId = speakerId;
                row.speakerType = speakerType;
                row.recipientId = "user".equals(speakerType) ? characterId : "user";
                row.content = requiredJson(value, "content");
                row.sentAt = Math.max(1L, value.optLong("sentAt", System.currentTimeMillis()));
                row.origin = value.optString("origin", "user".equals(speakerType) ? "phone" : "legacy_fallback");
                row.deviceId = secrets.loadBridgeConfig().deviceId + ":visible";
                long syncSeq = AlExecutionDatabase.get(getContext()).executionDao()
                    .allocateJournalSyncSeq(System.currentTimeMillis());
                row.deviceSeq = syncSeq;
                row.syncSeq = syncSeq;
                row.checksum = messageId;
                if (AlExecutionDatabase.get(getContext()).executionDao().insertRawMessage(row) != -1L) {
                    inserted += 1;
                }
            }
            JSObject result = new JSObject();
            result.put("saved", true);
            result.put("inserted", inserted);
            result.put("pending", AlExecutionDatabase.get(getContext()).executionDao().rawMessageCountAfterSync(
                AlExecutionDatabase.get(getContext()).executionDao().syncCursor("yuqi_pc") == null
                    ? 0L
                    : AlExecutionDatabase.get(getContext()).executionDao().syncCursor("yuqi_pc").ackSeq
            ));
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
            String inputJson = call.getString("inputJson");
            String snapshotJson = call.getString("snapshotJson");
            ChatTurnEntity existing = store.turn(turnId);
            if (existing == null) throw new IllegalArgumentException("Unknown turn: " + turnId);
            if (TurnKind.DIRECT_REPLY.name().equals(existing.kind) && !hasDirectUserContent(existing.inputJson)) {
                inputJson = required(call, "inputJson");
                snapshotJson = required(call, "snapshotJson");
                if (!hasDirectUserContent(inputJson)) {
                    throw new IllegalArgumentException("retry inputJson must contain the original user message");
                }
            }
            ExecutionAttemptEntity attempt = store.startRetry(turnId, System.currentTimeMillis(), inputJson, snapshotJson);
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
    public void recentCompletedTurns(PluginCall call) {
        execute(call, () -> {
            Integer limit = call.getInt("limit", 50);
            JSArray turns = new JSArray();
            for (ChatTurnEntity turn : store.recentCompletedTurns(limit == null ? 50 : limit)) {
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
            AlExecutionService.requestRun(getContext());
            return turnResult(store.turn(turnId));
        });
    }

    @PluginMethod
    public void getConversationCursor(PluginCall call) {
        execute(call, () -> {
            String characterId = required(call, "characterId");
            return conversationCursorResult(characterId, store.getConversationCursor(characterId));
        });
    }

    @PluginMethod
    public void markConversationCleared(PluginCall call) {
        execute(call, () -> {
            String characterId = required(call, "characterId");
            Long clearedThroughSequence = call.getLong("clearedThroughSequence");
            Long clearEpoch = call.getLong("clearEpoch");
            if (clearedThroughSequence == null || clearEpoch == null) {
                throw new IllegalArgumentException("clearedThroughSequence and clearEpoch are required");
            }
            store.markConversationCleared(
                characterId,
                clearedThroughSequence,
                clearEpoch,
                System.currentTimeMillis()
            );
            return conversationCursorResult(characterId, store.getConversationCursor(characterId));
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
            JSArray deliveryStages = new JSArray();
            int deliveryLimit = Math.max(1, Math.min(limit == null ? 30 : limit, 50));
            for (ChatTurnEntity turn : store.recentCompletedTurns(deliveryLimit)) {
                ExecutionAttemptEntity attempt = store.activeAttempt(turn.turnId);
                JSObject stage = new JSObject();
                stage.put("turnId", turn.turnId);
                stage.put("characterId", turn.characterId);
                stage.put("kind", turn.kind);
                stage.put("cloudConfirmationRequired", cloudConfirmationRequired(turn, attempt));
                stage.put("nativeCompleted", turn.completedAt != null);
                stage.put("nativeCompletedAt", turn.completedAt);
                stage.put("notificationShown", turn.notificationShownAt != null);
                stage.put("notificationShownAt", turn.notificationShownAt);
                stage.put("uiApplied", turn.uiAppliedAt != null);
                stage.put("uiAppliedAt", turn.uiAppliedAt);
                stage.put("cloudConfirmed", turn.cloudConfirmedAt != null);
                stage.put("cloudConfirmedAt", turn.cloudConfirmedAt);
                deliveryStages.put(stage);
            }
            result.put("deliveryStages", deliveryStages);
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

    @PluginMethod
    public void runRolePlanNow(PluginCall call) {
        execute(call, () -> {
            String planId = required(call, "planId");
            boolean queued = new com.siyi.al.execution.RolePlanCoordinator(getContext())
                .runNow(planId, System.currentTimeMillis());
            if (queued) AlExecutionService.requestRun(getContext());
            JSObject result = new JSObject();
            result.put("queued", queued);
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
        result.put("state", ExecutionServicePolicy.publicDisplayState(
            store.displayState(turn.turnId).name(), turn.deletedAt));
        result.put("activeAttemptId", turn.activeAttemptId);
        result.put("createdAt", turn.createdAt);
        result.put("updatedAt", turn.updatedAt);
        result.put("completedAt", turn.completedAt);
        result.put("deletedAt", turn.deletedAt);
        result.put("redacted", ExecutionServicePolicy.isRedacted(turn.deletedAt));
        result.put("notificationShownAt", turn.notificationShownAt);
        result.put("uiAppliedAt", turn.uiAppliedAt);
        result.put("cloudConfirmedAt", turn.cloudConfirmedAt);
        result.put("bridgeProtocolVersion", turn.bridgeProtocolVersion);
        result.put("authorityLineageKey", turn.authorityLineageKey);
        result.put("visibleGroupId", turn.visibleGroupId);
        result.put("commitChecksum", turn.bridgeCommitChecksum);
        result.put("terminalDisposition", turn.terminalDisposition);
        result.put("lineageRevision", turn.lineageRevision);
        result.put("turnRevision", turn.turnRevision);
        result.put("laneKey", turn.laneKey);
        result.put("laneRevision", turn.laneRevision);
        result.put("generationFingerprint", turn.generationFingerprint);
        result.put("pipelineReleaseId", turn.pipelineReleaseId);
        result.put("inputVisibilitySequence", turn.inputVisibilitySequence);
        result.put("inputClearEpoch", turn.inputClearEpoch);
        ExecutionAttemptEntity attempt = store.activeAttempt(turn.turnId);
        result.put("cloudConfirmationRequired", cloudConfirmationRequired(turn, attempt));
        if (attempt != null) {
            result.put("attemptId", attempt.attemptId);
            result.put("errorCode", attempt.errorCode);
            result.put("errorDetail", attempt.errorDetail);
            result.put("retryable", attempt.retryable);
            if (attempt.bridgeAuthorityCheckpointJson != null
                && attempt.bridgeAuthorityCheckpointChecksum != null) {
                JSONObject authorityReceipt = BridgeReceiptCheckpoint
                    .extractAuthorityReceiptFromV12Checkpoint(
                        attempt.bridgeAuthorityCheckpointJson,
                        attempt.bridgeAuthorityCheckpointChecksum);
                if (authorityReceipt != null) {
                    result.put("bridgeAuthorityCheckpointChecksum",
                        attempt.bridgeAuthorityCheckpointChecksum);
                    result.put("bridgeDeliveryRoute",
                        authorityReceipt.optString("_deliveryRoute", ""));
                    result.put("bridgeRelayMessageId",
                        authorityReceipt.has("_relayMessageId")
                            ? authorityReceipt.optString("_relayMessageId", "") : null);
                }
            }
            if (BridgeReceiptCheckpoint.mayReadLegacyMemoryResult(turn.bridgeProtocolVersion)
                && attempt.memoryResult != null && !attempt.memoryResult.trim().isEmpty()) {
                try {
                    JSONObject checkpoint = new JSONObject(attempt.memoryResult);
                    if (checkpoint.has("origin")) {
                        result.put("origin", checkpoint.optString("origin", ""));
                        result.put("fallback", checkpoint.optBoolean("fallback", false));
                        result.put("attemptedRoutes", checkpoint.optJSONArray("attemptedRoutes") == null ? new JSONArray() : checkpoint.optJSONArray("attemptedRoutes"));
                    }
                    JSONObject bridgeResponse = checkpoint.optJSONObject("bridgeResponse");
                    if (bridgeResponse != null && bridgeResponse.optJSONArray("deliveryItems") != null) {
                        result.put("deliveryItems", bridgeResponse.optJSONArray("deliveryItems"));
                    }
                } catch (Exception ignored) {
                    // Ordinary memory-model output is not a bridge checkpoint.
                }
            }
        }
        DiagnosticEntity bridgeStatus = store.latestBridgeStatus(turn.turnId);
        if (bridgeStatus != null && bridgeStatus.detail != null && !bridgeStatus.detail.trim().isEmpty()) {
            try {
                JSONObject status = new JSONObject(bridgeStatus.detail);
                result.put("bridgeStatusCode", "BRIDGE_STATUS");
                result.put("route", status.optString("route", ""));
                result.put("displayStage", status.optString("displayStage", ""));
                result.put("technicalStage", status.optString("technicalStage", ""));
                result.put("stageModel", status.optString("stageModel", ""));
                result.put("stageEffort", status.optString("stageEffort", ""));
                result.put("stageElapsedMs", status.optLong("stageElapsedMs", 0L));
                result.put("totalElapsedMs", status.optLong("totalElapsedMs", 0L));
            } catch (Exception ignored) {
                // A malformed progress row stays available in diagnostics without breaking the turn result.
            }
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

    private static JSObject conversationCursorResult(String characterId, ConversationCursorEntity cursor) {
        JSObject result = new JSObject();
        result.put("characterId", characterId);
        if (cursor == null) {
            result.put("nativeCompletedTurnId", (Object) null);
            result.put("nativeCompletedGroupId", (Object) null);
            result.put("nativeCompletedSequence", 0L);
            result.put("uiAppliedTurnId", (Object) null);
            result.put("uiAppliedGroupId", (Object) null);
            result.put("uiAppliedSequence", 0L);
            result.put("localSequence", 0L);
            result.put("clearedThroughSequence", 0L);
            result.put("clearEpoch", 0L);
            result.put("clearedAt", 0L);
            result.put("chatOpen", false);
            result.put("updatedAt", 0L);
            return result;
        }
        result.put("nativeCompletedTurnId", cursor.nativeCompletedTurnId);
        result.put("nativeCompletedGroupId", cursor.nativeCompletedGroupId);
        result.put("nativeCompletedSequence", cursor.nativeCompletedSequence);
        result.put("uiAppliedTurnId", cursor.uiAppliedTurnId);
        result.put("uiAppliedGroupId", cursor.uiAppliedGroupId);
        result.put("uiAppliedSequence", cursor.uiAppliedSequence);
        result.put("localSequence", cursor.localSequence);
        result.put("clearedThroughSequence", cursor.clearedThroughSequence);
        result.put("clearEpoch", cursor.clearEpoch);
        result.put("clearedAt", cursor.clearedAt);
        result.put("chatOpen", cursor.chatOpen);
        result.put("updatedAt", cursor.updatedAt);
        return result;
    }

    private boolean cloudConfirmationRequired(
        ChatTurnEntity turn,
        ExecutionAttemptEntity attempt
    ) {
        if (attempt == null) return false;
        if (turn.bridgeProtocolVersion != null && turn.bridgeProtocolVersion == 3) {
            return turn.deletedAt == null
                && turn.cloudConfirmedAt == null
                && BridgeReceiptCheckpoint.extractAuthorityReceiptFromV12Checkpoint(
                    attempt.bridgeAuthorityCheckpointJson,
                    attempt.bridgeAuthorityCheckpointChecksum) != null;
        }
        return BridgeReceiptCheckpoint.extract(attempt.memoryResult) != null;
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

    private static String optional(PluginCall call, String name, String fallback) {
        String value = call.getString(name);
        return value == null || value.trim().isEmpty() ? (fallback == null ? "" : fallback) : value.trim();
    }

    private static int integer(PluginCall call, String name, int fallback) {
        Integer value = call.getInt(name, fallback);
        return value == null ? fallback : value;
    }

    private static JSObject bridgeConfigResult(BridgeConfig config) {
        JSObject result = new JSObject();
        result.put("enabled", config.enabled);
        result.put("mode", config.mode.name());
        result.put("lanUrl", config.lanUrl);
        result.put("cloudUrl", config.cloudUrl);
        result.put("deviceId", config.deviceId);
        result.put("pairingSecretSet", !config.pairingSecret.isEmpty());
        result.put("deviceTokenSet", !config.deviceToken.isEmpty());
        result.put("encryptionKeySet", !config.encryptionKeyBase64.isEmpty());
        result.put("connectTimeoutMs", config.connectTimeoutMs);
        result.put("readTimeoutMs", config.readTimeoutMs);
        result.put("cloudPollAttempts", config.cloudPollAttempts);
        result.put("cloudPollIntervalMs", config.cloudPollIntervalMs);
        result.put("turnDeadlineMs", config.turnDeadlineMs);
        return result;
    }

    private static String requiredJson(JSONObject value, String name) {
        String result = value.optString(name, "").trim();
        if (result.isEmpty()) throw new IllegalArgumentException(name + " is required");
        return result;
    }

    private static boolean hasDirectUserContent(String inputJson) {
        try {
            JSONObject input = new JSONObject(inputJson == null ? "{}" : inputJson);
            JSONObject message = input.optJSONObject("message");
            String content = message == null ? "" : message.optString("content", "");
            if (content.trim().isEmpty()) content = input.optString("userText", "");
            if (content.trim().isEmpty()) content = input.optString("text", "");
            return !content.trim().isEmpty();
        } catch (Exception ignored) {
            return false;
        }
    }

    private interface Operation {
        JSObject run() throws Exception;
    }
}
