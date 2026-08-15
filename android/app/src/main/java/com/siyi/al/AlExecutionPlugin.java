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
import com.siyi.al.execution.AutomaticScheduleContract;
import com.siyi.al.execution.AutomaticScheduleStore;
import com.siyi.al.execution.AutomaticTaskCleanupResult;
import com.siyi.al.execution.AutomaticTaskCoordinator;
import com.siyi.al.execution.BridgeAuthority;
import com.siyi.al.execution.BridgeReceiptCheckpoint;
import com.siyi.al.execution.ExecutionServicePolicy;
import com.siyi.al.execution.ExecutionRuntime;
import com.siyi.al.execution.RoomExecutionStore;
import com.siyi.al.execution.TurnKind;
import com.siyi.al.execution.TurnSubmission;
import com.siyi.al.execution.api.ApiConfig;
import com.siyi.al.execution.bridge.BridgeClient;
import com.siyi.al.execution.bridge.BridgeConfig;
import com.siyi.al.execution.bridge.BridgeMode;
import com.siyi.al.execution.bridge.BridgeStatusProbe;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity;
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
import com.siyi.al.execution.LifecycleControl;
import com.siyi.al.execution.RolePlanAlarmScheduler;
import com.siyi.al.execution.AutomaticTaskAlarmScheduler;
import com.siyi.al.execution.secure.AlSecretStore;
import android.content.Context;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.UUID;
import java.lang.ref.WeakReference;
import android.os.Handler;
import android.os.Looper;
import androidx.core.app.NotificationManagerCompat;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "AlExecution")
public final class AlExecutionPlugin extends Plugin {
    private static volatile WeakReference<AlExecutionPlugin> activeInstance = new WeakReference<>(null);
    private static final AtomicLong generationCounter = new AtomicLong(0L);
    private enum LifecycleState { NEW, INITIALIZING, READY, STOPPING }
    private final Object lifecycleLock = new Object();
    private LifecycleState lifecycleState = LifecycleState.NEW;
    private ExecutorService io;
    private RoomExecutionStore store;
    private AlSecretStore secrets;
    private Context applicationContext;
    private long generation;

    @Override
    public void load() {
        synchronized (lifecycleLock) {
            if (lifecycleState != LifecycleState.NEW) return;
            applicationContext = getContext().getApplicationContext();
            io = Executors.newSingleThreadExecutor();
            generation = generationCounter.incrementAndGet();
            activeInstance = new WeakReference<>(this);
        }
    }

    @Override
    protected void handleOnDestroy() {
        ExecutorService executor;
        synchronized (lifecycleLock) {
            if (lifecycleState == LifecycleState.STOPPING) return;
            lifecycleState = LifecycleState.STOPPING;
            AlExecutionPlugin current = activeInstance.get();
            if (current == this) activeInstance.clear();
            executor = io;
        }
        if (executor == null) return;
        try {
            executor.execute(() -> {
                synchronized (lifecycleLock) {
                    secrets = null;
                    store = null;
                    applicationContext = null;
                    io = null;
                }
                executor.shutdown();
            });
        } catch (RejectedExecutionException ignored) {
            // A concurrent executor rejection is terminal cleanup ownership;
            // never clear worker-owned fields on the main thread.
        }
    }

    public static void notifyCompletedTurn(String turnId, long updatedAt) {
        AlExecutionPlugin plugin = activeInstance.get();
        if (plugin == null) return;
        final long postedGeneration;
        synchronized (plugin.lifecycleLock) {
            if (activeInstance.get() != plugin || plugin.lifecycleState == LifecycleState.STOPPING) return;
            postedGeneration = plugin.generation;
        }
        new Handler(Looper.getMainLooper()).post(() -> {
            synchronized (plugin.lifecycleLock) {
                if (activeInstance.get() != plugin
                    || plugin.generation != postedGeneration
                    || plugin.lifecycleState == LifecycleState.STOPPING) {
                    return;
                }
                JSObject payload = new JSObject();
                payload.put("turnId", turnId == null ? "" : turnId);
                payload.put("updatedAt", updatedAt);
                plugin.notifyListeners("executionCompleted", payload, true);
            }
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
            // Build and validate the replacement graph before persisting the
            // new peer.  If either step fails, the old persisted peer and the
            // old in-memory store remain paired.
            RoomExecutionStore rebound = storeForBridgeConfig(
                AlExecutionDatabase.get(applicationContext), config);
            secrets.saveBridgeConfig(config);
            store = rebound;
            return bridgeConfigResult(config);
        });
    }

    static RoomExecutionStore storeForBridgeConfig(
        AlExecutionDatabase database,
        BridgeConfig config
    ) {
        return new RoomExecutionStore(database, config == null ? null : config.deviceId);
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
            ChatTurnEntity annotatedTurn = store.turn(annotation.turnId);
            if (annotatedTurn != null) store.assertRoleAcceptsSemanticWrite(annotatedTurn.characterId);
            String sourceMessageId = optional(call, "sourceMessageId", "");
            annotation.sourceMessageId = sourceMessageId.isEmpty() ? null : sourceMessageId;
            annotation.presetVersion = optional(call, "presetVersion", "1.0.0");
            annotation.userCorrection = correction;
            annotation.desiredBehavior = desiredBehavior;
            annotation.status = "proposed";
            annotation.createdAt = System.currentTimeMillis();
            annotation.checksum = annotation.annotationId;
            AlExecutionDatabase database = AlExecutionDatabase.get(getContext());
            final long[] inserted = new long[] { -1L };
            database.runInTransaction(() -> {
                ChatTurnEntity currentTurn = store.turn(annotation.turnId);
                if (currentTurn != null) store.assertRoleAcceptsSemanticWrite(currentTurn.characterId);
                annotation.syncSeq = database.executionDao().allocateJournalSyncSeq(annotation.createdAt);
                inserted[0] = database.executionDao().insertYuqiAnnotation(annotation);
            });
            JSObject result = new JSObject();
            result.put("saved", inserted[0] != -1L);
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
            AlExecutionDatabase database = AlExecutionDatabase.get(getContext());
            database.runInTransaction(() -> {
                store.assertRoleAcceptsSemanticWrite(snapshot.characterId);
                database.executionDao().upsertSnapshot(snapshot);
            });
            if (snapshot.jobSnapshot && snapshot.scheduledFor != null && snapshot.automaticTasksEnabled) {
                AutomaticTaskAlarmScheduler.schedule(getContext(), snapshot.cloudJobId, snapshot.scheduledFor);
                AlExecutionWakeWorker.enqueueAutomatic(getContext(), snapshot.cloudJobId, snapshot.scheduledFor);
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
            AlExecutionDatabase database = AlExecutionDatabase.get(getContext());
            final int[] inserted = new int[] { 0 };
            database.runInTransaction(() -> {
                store.assertRoleAcceptsSemanticWrite(characterId);
                for (int index = 0; index < values.length(); index += 1) {
                    JSONObject value;
                    try {
                        value = values.getJSONObject(index);
                    } catch (JSONException error) {
                        throw new IllegalArgumentException("messagesJson item is invalid", error);
                    }
                    String messageId = requiredJson(value, "messageId");
                    if (database.executionDao().rawMessage(messageId) != null) continue;
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
                    long syncSeq = database.executionDao().allocateJournalSyncSeq(System.currentTimeMillis());
                    row.deviceSeq = syncSeq;
                    row.syncSeq = syncSeq;
                    row.checksum = messageId;
                    if (database.executionDao().insertRawMessage(row) != -1L) inserted[0] += 1;
                }
            });
            JSObject result = new JSObject();
            result.put("saved", true);
            result.put("inserted", inserted[0]);
            result.put("pending", database.executionDao().rawMessageCountAfterSync(
                database.executionDao().syncCursor("yuqi_pc") == null
                    ? 0L
                    : database.executionDao().syncCursor("yuqi_pc").ackSeq
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
    public void configureAutomaticSchedule(PluginCall call) {
        execute(call, () -> {
            String characterId = required(call, "characterId");
            String kind = automaticScheduleKind(required(call, "kind"));
            boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", true));
            String mode = automaticScheduleMode(optional(call, "mode", "planned"));
            long minDelayMs = integer(call, "minDelayMs", 0);
            long maxDelayMs = integer(call, "maxDelayMs", 0);
            String explicitAt = optional(call, "explicitAt", null);
            if (explicitAt.isEmpty()) explicitAt = null;
            long now = System.currentTimeMillis();
            AlExecutionDatabase database = AlExecutionDatabase.get(applicationContext);
            AutomaticScheduleAuthorityEntity current = database.executionDao()
                .automaticScheduleAuthorityForCharacterKind(characterId, kind);
            BridgeConfig bridge = secrets.loadBridgeConfig();
            String deviceId = bridge == null ? "" : bridge.deviceId;
            if (deviceId == null || deviceId.trim().isEmpty()) {
                throw new IllegalStateException("automatic schedule bridge device is required");
            }
            String epoch = current == null
                ? UUID.randomUUID().toString().replace("-", "") : current.authorityEpoch;
            JSONObject policyBasis = automaticPolicyBasis(mode, minDelayMs, maxDelayMs, explicitAt);
            String policyChecksum = BridgeAuthority.sha256CanonicalJson(policyBasis);
            long policyRevision = automaticPolicyRevision(current, policyChecksum);
            String sourceType = current == null ? "bootstrap" : "settings_change";
            JSONObject sourceBasis = new JSONObject()
                .put("characterId", characterId)
                .put("enabled", enabled)
                .put("kind", kind)
                .put("policy", policyBasis);
            String sourceChecksum = BridgeAuthority.sha256CanonicalJson(sourceBasis);
            AutomaticScheduleContract.Source source = new AutomaticScheduleContract.Source(
                sourceType, "cfg_" + sourceChecksum.substring(0, 24), sourceChecksum,
                current == null ? 0L : current.conversationSequence, now);
            AutomaticScheduleStore schedules = new AutomaticScheduleStore(database, deviceId);
            AutomaticScheduleAuthorityEntity next;
            if (enabled) {
                AutomaticScheduleContract.Policy policy = new AutomaticScheduleContract.Policy(
                    policyRevision, policyChecksum, mode, minDelayMs, maxDelayMs, explicitAt);
                next = schedules.configure(characterId, kind, epoch, source, policy, now);
            } else {
                next = schedules.disable(characterId, kind, epoch, source, now);
            }
            new AutomaticTaskCoordinator(applicationContext).reconcileSchedulers(applicationContext);
            AlExecutionWakeWorker.enqueueAutomaticScheduleSync(applicationContext, 0L);
            AlExecutionService.requestRun(applicationContext);
            return automaticScheduleResult(next);
        });
    }

    @PluginMethod
    public void getAutomaticScheduleStatus(PluginCall call) {
        execute(call, () -> {
            String characterId = required(call, "characterId");
            String kind = automaticScheduleKind(required(call, "kind"));
            AutomaticScheduleAuthorityEntity current = AlExecutionDatabase.get(applicationContext)
                .executionDao().automaticScheduleAuthorityForCharacterKind(characterId, kind);
            return automaticScheduleResult(characterId, kind, current);
        });
    }

    @PluginMethod
    public void reconcileAutomaticSchedules(PluginCall call) {
        execute(call, () -> {
            ExecutionRuntime.ReconcileResult reconciliation =
                ExecutionRuntime.reconcileRemotePausedSchedulesResult(applicationContext);
            boolean retryScheduled = false;
            if (reconciliation.status == ExecutionRuntime.ReconcileResult.Status.RECOVERED) {
                AlExecutionWakeWorker.enqueueAutomaticScheduleSync(applicationContext, 0L);
            } else if (reconciliation.status == ExecutionRuntime.ReconcileResult.Status.RETRYABLE) {
                AlExecutionWakeWorker.enqueueAutomaticScheduleSync(applicationContext, 15L * 60L);
                retryScheduled = true;
            }
            JSObject result = new JSObject();
            result.put("status", reconciliation.status.name().toLowerCase(java.util.Locale.ROOT));
            result.put("requeued", reconciliation.requeued);
            result.put("retryScheduled", retryScheduled);
            return result;
        });
    }

    @PluginMethod
    public void migrateLegacyAutomaticScheduleCandidate(PluginCall call) {
        execute(call, () -> {
            String characterId = required(call, "characterId");
            String kind = automaticScheduleKind(required(call, "kind"));
            AlExecutionDatabase database = AlExecutionDatabase.get(applicationContext);
            AutomaticScheduleAuthorityEntity current = database.executionDao()
                .automaticScheduleAuthorityForCharacterKind(characterId, kind);
            if (current != null) return automaticScheduleResult(current);
            long now = System.currentTimeMillis();
            String dueAtText = required(call, "dueAt");
            long dueAt;
            try {
                dueAt = Long.parseLong(dueAtText);
            } catch (NumberFormatException error) {
                throw new IllegalArgumentException("legacy automatic dueAt is invalid", error);
            }
            if (dueAt <= now || dueAt > 9007199254740991L) {
                throw new IllegalArgumentException("legacy automatic dueAt is invalid");
            }
            String mode = automaticScheduleMode(optional(call, "mode", "planned"));
            String legacyJobId = optional(call, "legacyJobId", "");
            JSONObject policyBasis = automaticPolicyBasis(mode, 0L, 0L, dueAtText);
            String policyChecksum = BridgeAuthority.sha256CanonicalJson(policyBasis);
            JSONObject candidate = new JSONObject()
                .put("characterId", characterId)
                .put("dueAt", dueAtText)
                .put("kind", kind)
                .put("legacyJobId", legacyJobId)
                .put("mode", mode);
            String sourceChecksum = BridgeAuthority.sha256CanonicalJson(candidate);
            BridgeConfig bridge = secrets.loadBridgeConfig();
            String deviceId = bridge == null ? "" : bridge.deviceId;
            if (deviceId == null || deviceId.trim().isEmpty()) {
                throw new IllegalStateException("automatic schedule bridge device is required");
            }
            String epoch = UUID.randomUUID().toString().replace("-", "");
            AutomaticScheduleContract.Source source = new AutomaticScheduleContract.Source(
                "migration_claim", "migration_" + sourceChecksum.substring(0, 20),
                sourceChecksum, 0L, now);
            AutomaticScheduleContract.Policy policy = new AutomaticScheduleContract.Policy(
                1L, policyChecksum, mode, 0L, 0L, dueAtText);
            AutomaticScheduleAuthorityEntity next = new AutomaticScheduleStore(database, deviceId)
                .migrateLegacyCandidate(characterId, kind, epoch, source, policy, now);
            if (!legacyJobId.isEmpty()) {
                AutomaticTaskAlarmScheduler.cancel(applicationContext, legacyJobId);
                AlExecutionWakeWorker.cancelAutomatic(applicationContext, legacyJobId);
            }
            new AutomaticTaskCoordinator(applicationContext).reconcileSchedulers(applicationContext);
            AlExecutionWakeWorker.enqueueAutomaticScheduleSync(applicationContext, 0L);
            AlExecutionService.requestRun(applicationContext);
            return automaticScheduleResult(next);
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
    public void inspectAppRecoveryState(PluginCall call) {
        execute(call, () -> {
            JSONObject census = store.inspectAppRecoveryState();
            File database = applicationContext.getDatabasePath("al-execution.db");
            File wal = new File(database.getPath() + "-wal");
            File shm = new File(database.getPath() + "-shm");
            return new JSObject(census.toString())
                .put("databaseBytes", database.isFile() ? database.length() : 0L)
                .put("walBytes", wal.isFile() ? wal.length() : 0L)
                .put("shmBytes", shm.isFile() ? shm.length() : 0L);
        });
    }

    @PluginMethod
    public void readAppRecoveryRoleCandidate(PluginCall call) {
        execute(call, () -> new JSObject(
            store.readAppRecoveryRoleCandidate(required(call, "characterId")).toString()
        ));
    }

    @PluginMethod
    public void readAppRecoveryMessages(PluginCall call) {
        execute(call, () -> {
            String characterId = required(call, "characterId");
            Long afterSentAt = call.getLong("afterSentAt", 0L);
            String afterMessageId = optional(call, "afterMessageId", "");
            Integer limit = call.getInt("limit", 100);
            return new JSObject(store.readAppRecoveryMessages(
                characterId,
                afterSentAt == null ? 0L : afterSentAt,
                afterMessageId,
                limit == null ? 100 : limit
            ).toString());
        });
    }

    @PluginMethod
    public void requestVerifiedYuqiBackup(PluginCall call) {
        execute(call, () -> {
            String characterId = required(call, "characterId");
            long requestedAt = System.currentTimeMillis();
            JSONObject androidRoomHead = store.androidRoomBackupHead(characterId, requestedAt);
            JSONObject receipt = new BridgeClient(secrets.loadBridgeConfig())
                .requestVerifiedBackup(characterId, androidRoomHead, requestedAt);
            return new JSObject(receipt.toString());
        });
    }

    @PluginMethod
    public void createRoleDelete(PluginCall call) {
        execute(call, () -> {
            String characterId = required(call, "characterId");
            String expectedCursorChecksum = required(call, "expectedCursorChecksum");
            JSONObject backupReceipt = new JSONObject(required(call, "backupReceiptJson"));
            LifecycleControl control = store.createRoleDelete(
                characterId,
                expectedCursorChecksum,
                backupReceipt,
                () -> AlExecutionWakeWorker.prearmLifecycle(getContext()),
                notificationId -> NotificationManagerCompat.from(getContext()).cancel(notificationId)
            );
            AlExecutionService.requestRun(getContext());
            return roleDeleteControlResult(characterId, control);
        });
    }

    @PluginMethod
    public void getRoleDeleteStatus(PluginCall call) {
        execute(call, () -> {
            String characterId = required(call, "characterId");
            return roleDeleteControlResult(characterId, store.roleDeleteControl(characterId));
        });
    }

    @PluginMethod
    public void suppressRoleDeletedTurn(PluginCall call) {
        execute(call, () -> {
            String turnId = required(call, "turnId");
            String characterId = required(call, "characterId");
            boolean suppressed = store.suppressRoleDeletedTurn(
                turnId, characterId, System.currentTimeMillis());
            JSObject result = new JSObject();
            result.put("turnId", turnId);
            result.put("characterId", characterId);
            result.put("suppressed", suppressed);
            return result;
        });
    }

    @PluginMethod
    public void createConversationClear(PluginCall call) {
        execute(call, () -> {
            String characterId = required(call, "characterId");
            String expectedCursorChecksum = call.getString("expectedCursorChecksum");
            if (expectedCursorChecksum == null || expectedCursorChecksum.trim().isEmpty()) {
                throw new IllegalArgumentException("expectedCursorChecksum is required");
            }
            LifecycleControl control = store.createConversationClear(
                characterId,
                expectedCursorChecksum,
                () -> AlExecutionWakeWorker.prearmLifecycle(getContext())
            );
            AlExecutionService.requestRun(getContext());
            JSObject result = conversationCursorResult(characterId, store.getConversationCursor(characterId));
            result.put("controlId", control.controlId);
            result.put("clearEpoch", control.clearEpoch);
            result.put("clearedThroughSequence", control.clearedThroughSequence);
            result.put("state", control.state);
            return result;
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
            AlExecutionDatabase database = AlExecutionDatabase.get(getContext());
            database.runInTransaction(() -> {
                store.assertRoleAcceptsSemanticWrite(characterId);
                database.executionDao().replaceRolePlans(characterId, plans, history);
            });
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
            result.put("nativeCompletedTurnId", JSONObject.NULL);
            result.put("nativeCompletedGroupId", JSONObject.NULL);
            result.put("nativeCompletedSequence", 0L);
            result.put("uiAppliedTurnId", JSONObject.NULL);
            result.put("uiAppliedGroupId", JSONObject.NULL);
            result.put("uiAppliedSequence", 0L);
            result.put("localSequence", 0L);
            result.put("clearedThroughSequence", 0L);
            result.put("clearEpoch", 0L);
            result.put("clearedAt", 0L);
            result.put("chatOpen", false);
            result.put("updatedAt", 0L);
            result.put("cursorChecksum", RoomExecutionStore.conversationCursorChecksum(characterId, null));
            return result;
        }
        result.put("nativeCompletedTurnId", cursor.nativeCompletedTurnId == null ? JSONObject.NULL : cursor.nativeCompletedTurnId);
        result.put("nativeCompletedGroupId", cursor.nativeCompletedGroupId == null ? JSONObject.NULL : cursor.nativeCompletedGroupId);
        result.put("nativeCompletedSequence", cursor.nativeCompletedSequence);
        result.put("uiAppliedTurnId", cursor.uiAppliedTurnId == null ? JSONObject.NULL : cursor.uiAppliedTurnId);
        result.put("uiAppliedGroupId", cursor.uiAppliedGroupId == null ? JSONObject.NULL : cursor.uiAppliedGroupId);
        result.put("uiAppliedSequence", cursor.uiAppliedSequence);
        result.put("localSequence", cursor.localSequence);
        result.put("clearedThroughSequence", cursor.clearedThroughSequence);
        result.put("clearEpoch", cursor.clearEpoch);
        result.put("clearedAt", cursor.clearedAt);
        result.put("chatOpen", cursor.chatOpen);
        result.put("updatedAt", cursor.updatedAt);
        result.put("cursorChecksum", RoomExecutionStore.conversationCursorChecksum(characterId, cursor));
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
        ExecutorService executor;
        synchronized (lifecycleLock) {
            if (lifecycleState == LifecycleState.STOPPING || io == null) {
                call.reject("AlExecution plugin is stopping");
                return;
            }
            executor = io;
        }
        try {
            executor.execute(() -> {
                try {
                    synchronized (lifecycleLock) {
                        if (lifecycleState == LifecycleState.STOPPING) {
                            call.reject("AlExecution plugin is stopping");
                            return;
                        }
                    }
                    initializeOnWorker();
                    JSObject result = operation.run();
                    synchronized (lifecycleLock) {
                        if (lifecycleState == LifecycleState.STOPPING) {
                            call.reject("AlExecution plugin is stopping");
                            return;
                        }
                        call.resolve(result);
                    }
                } catch (Exception error) {
                    String detail = error.getMessage();
                    synchronized (lifecycleLock) {
                        if (lifecycleState == LifecycleState.STOPPING) {
                            call.reject("AlExecution plugin is stopping", error);
                        } else {
                            call.reject(detail == null ? error.getClass().getSimpleName() : detail, error);
                        }
                    }
                }
            });
        } catch (RejectedExecutionException error) {
            call.reject("AlExecution plugin is stopping", error);
        }
    }

    private void initializeOnWorker() throws Exception {
        synchronized (lifecycleLock) {
            if (lifecycleState == LifecycleState.STOPPING) {
                throw new IllegalStateException("AlExecution plugin is stopping");
            }
            if (lifecycleState == LifecycleState.READY && secrets != null && store != null) return;
            lifecycleState = LifecycleState.INITIALIZING;
        }

        AlSecretStore localSecrets = null;
        RoomExecutionStore localStore = null;
        try {
            localSecrets = new AlSecretStore(applicationContext);
            BridgeConfig bridgeConfig = localSecrets.loadBridgeConfig();
            AlExecutionDatabase database = AlExecutionDatabase.get(applicationContext);
            localStore = storeForBridgeConfig(database, bridgeConfig);
            synchronized (lifecycleLock) {
                if (lifecycleState == LifecycleState.STOPPING) {
                    throw new IllegalStateException("AlExecution plugin is stopping");
                }
                secrets = localSecrets;
                store = localStore;
                lifecycleState = LifecycleState.READY;
            }
        } catch (Exception error) {
            synchronized (lifecycleLock) {
                if (lifecycleState != LifecycleState.STOPPING) {
                    secrets = null;
                    store = null;
                    lifecycleState = LifecycleState.NEW;
                }
            }
            throw error;
        }
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

    private static String automaticScheduleKind(String kind) {
        if (!("chat".equals(kind) || "moment".equals(kind))) {
            throw new IllegalArgumentException("automatic schedule kind is invalid");
        }
        return kind;
    }

    private static String automaticScheduleMode(String mode) {
        if (!("planned".equals(mode) || "dice".equals(mode))) {
            throw new IllegalArgumentException("automatic schedule mode is invalid");
        }
        return mode;
    }

    private static JSONObject automaticPolicyBasis(
        String mode, long minDelayMs, long maxDelayMs, String explicitAt
    ) throws JSONException {
        if (minDelayMs < 0L || maxDelayMs < minDelayMs || maxDelayMs > 9007199254740991L) {
            throw new IllegalArgumentException("automatic schedule delay is invalid");
        }
        return new JSONObject()
            .put("explicitAt", explicitAt == null ? JSONObject.NULL : explicitAt)
            .put("maxDelayMs", maxDelayMs)
            .put("minDelayMs", minDelayMs)
            .put("mode", mode);
    }

    private static long automaticPolicyRevision(
        AutomaticScheduleAuthorityEntity current, String nextChecksum
    ) throws JSONException {
        if (current == null) return 1L;
        JSONObject semantic = new JSONObject(current.semanticJson);
        long revision = semantic.getLong("policyRevision");
        if (nextChecksum.equals(semantic.getString("policyChecksum"))) return revision;
        return Math.addExact(revision, 1L);
    }

    private JSObject automaticScheduleResult(AutomaticScheduleAuthorityEntity row)
        throws JSONException {
        if (row == null) throw new IllegalStateException("automatic schedule authority is missing");
        return automaticScheduleResult(row.characterId, row.kind, row);
    }

    private JSObject automaticScheduleResult(
        String characterId, String kind, AutomaticScheduleAuthorityEntity row
    ) throws JSONException {
        JSObject result = new JSObject();
        result.put("characterId", characterId);
        result.put("kind", kind);
        result.put("owner", AutomaticScheduleStore.OWNER);
        if (row == null) {
            result.put("epochFingerprint", "");
            result.put("generation", 0L);
            result.put("state", "unclaimed");
            result.put("jobId", JSONObject.NULL);
            result.put("dueAt", JSONObject.NULL);
            result.put("cloudSyncState", "none");
            result.put("lastChangeSource", "none");
            result.put("lastChangedAt", 0L);
            result.put("lastDeliveryStage", "");
            result.put("lastDeliveryAt", 0L);
            return result;
        }
        JSONObject semantic = new JSONObject(row.semanticJson);
        AutomaticScheduleContract.validateTransition(semantic);
        result.put("epochFingerprint", row.authorityEpoch.substring(0, 8));
        result.put("generation", row.generation);
        result.put("state", row.state);
        result.put("jobId", row.activeJobId == null ? JSONObject.NULL : row.activeJobId);
        result.put("dueAt", row.dueAt == null ? JSONObject.NULL : row.dueAt);
        result.put("cloudSyncState", row.cloudSyncState);
        result.put("lastChangeSource", semantic.getString("sourceType"));
        result.put("lastChangedAt", row.updatedAt);
        com.siyi.al.execution.db.AutomaticScheduleEventEntity latest =
            AlExecutionDatabase.get(applicationContext).executionDao()
                .latestAutomaticScheduleEvent(row.streamKey);
        result.put("lastDeliveryStage", latest == null || latest.resultCode == null ? "" : latest.resultCode);
        result.put("lastDeliveryAt", latest == null ? 0L : latest.createdAt);
        return result;
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

    private static JSObject roleDeleteControlResult(String characterId, LifecycleControl control) {
        JSObject result = new JSObject();
        result.put("characterId", characterId);
        if (control == null) {
            result.put("controlId", "");
            result.put("state", "none");
            result.put("requestedAt", 0L);
            result.put("appliedAt", JSONObject.NULL);
            result.put("semanticChecksum", "");
            return result;
        }
        if (!LifecycleControl.ROLE_DELETE_KIND.equals(control.controlKind)
            || !characterId.equals(control.characterId)) {
            throw new IllegalStateException("role delete authority conflict");
        }
        result.put("controlId", control.controlId);
        result.put("state", control.state);
        result.put("requestedAt", control.requestedAt);
        result.put("appliedAt", control.appliedAt == null ? JSONObject.NULL : control.appliedAt);
        result.put("semanticChecksum", control.semanticChecksum);
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
