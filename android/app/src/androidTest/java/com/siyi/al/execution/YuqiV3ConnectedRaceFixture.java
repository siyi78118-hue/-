package com.siyi.al.execution;

import android.content.Context;
import android.content.Intent;
import android.Manifest;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.sqlite.db.SupportSQLiteDatabase;
import com.siyi.al.execution.bridge.BridgeConfig;
import com.siyi.al.execution.bridge.BridgeMode;
import com.siyi.al.execution.bridge.BridgeResult;
import com.siyi.al.execution.bridge.BridgeTurnStatus;
import com.siyi.al.execution.bridge.FallbackJournal;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ConversationCursorEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.secure.AlSecretStore;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** Test-only fixture that seeds through public Room/bridge APIs only. */
public final class YuqiV3ConnectedRaceFixture implements AutoCloseable {
    public final Context context;
    public final AlExecutionDatabase database;
    public final RoomExecutionStore store;
    private final String casePrefix;
    private final Map<String, ?> originalSecretPreferences;
    private final boolean notificationPermissionInitiallyGranted;
    private ServerSocket loopback;
    private Thread loopbackThread;
    private final List<Thread> connectionWorkers = Collections.synchronizedList(new ArrayList<>());
    private volatile LoopbackMode loopbackMode = LoopbackMode.OK;
    private final AtomicInteger requestCount = new AtomicInteger();
    private final CountDownLatch acceptedAny = new CountDownLatch(1);
    private final List<RequestRecord> requestRecords = Collections.synchronizedList(new ArrayList<>());
    private final List<Socket> acceptedSockets = Collections.synchronizedList(new ArrayList<>());
    private volatile Throwable loopbackFailure;
    private volatile boolean closing;
    private volatile CountDownLatch roomHoldEntered;
    private volatile CountDownLatch roomHoldRelease;
    private volatile CountDownLatch roomHoldSeedReady;
    private volatile Thread roomHoldThread;
    private volatile Throwable roomHoldFailure;
    private volatile boolean roomHoldAutoTimedOut;

    private YuqiV3ConnectedRaceFixture(Context context) {
        this.context = context.getApplicationContext();
        this.database = AlExecutionDatabase.get(this.context);
        this.casePrefix = "connected-" + UUID.randomUUID().toString().replace("-", "");
        this.originalSecretPreferences = this.context.getSharedPreferences(
            "al.execution.secrets.v1.prefs", Context.MODE_PRIVATE).getAll();
        this.notificationPermissionInitiallyGranted =
            this.context.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                == PackageManager.PERMISSION_GRANTED;
        // Each connected case owns a clean durable boundary.  This uses only
        // public Room/context APIs; no production table or state transition is
        // replaced by test SQL.
        this.database.clearAllTables();
        this.context.getSharedPreferences(
            "al.execution.secrets.v1.prefs", Context.MODE_PRIVATE).edit().clear().commit();
        NotificationManager notifications =
            (NotificationManager) this.context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (notifications != null) notifications.cancelAll();
        this.store = new RoomExecutionStore(database, "device-connected-race");
    }

    public void enableNotificationsForCase() throws Exception {
        if (!notificationPermissionInitiallyGranted
            && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            InstrumentationRegistry.getInstrumentation().getUiAutomation()
                .grantRuntimePermission(context.getPackageName(), Manifest.permission.POST_NOTIFICATIONS);
        }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager != null) {
                // A dedicated connected-test device may retain an old channel's user-controlled
                // visibility/importance from an earlier APK. Recreate only this test channel,
                // then inspect the real resulting channel; no health assertion is weakened.
                manager.deleteNotificationChannel(AlNotificationPolicy.MESSAGE_CHANNEL);
                new AlNotificationFactory(context).ensureChannels();
            }
        }
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            boolean granted = android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU
                || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
            AlNotificationStatus.Snapshot status = AlNotificationStatus.inspect(context);
            if (granted && status.channelExists) return;
            Thread.sleep(100);
        }
        AlNotificationStatus.Snapshot status = AlNotificationStatus.inspect(context);
        throw new AssertionError("notification setup did not settle: permission="
            + status.permissionGranted + ", appEnabled=" + status.appEnabled
            + ", channelExists=" + status.channelExists + ", importance=" + status.importance
            + ", sound=" + status.hasSound + ", vibration=" + status.vibrationEnabled
            + ", visibility=" + status.lockscreenVisibility + ", summary=" + status.summary);
    }

    public static YuqiV3ConnectedRaceFixture open(Context context) {
        YuqiV3ConnectedRaceFixture fixture = new YuqiV3ConnectedRaceFixture(context);
        fixture.startLoopback();
        return fixture;
    }

    public void saveLoopbackBridgeConfig() {
        new AlSecretStore(context).saveBridgeConfig(new BridgeConfig(
            true, BridgeMode.LAN, "http://127.0.0.1:" + loopback.getLocalPort(), "",
            "device-connected-race", "pairing-secret-123", "", "", 1_200, 2_000, 1, 100
        ));
    }

    public void setLoopbackMode(LoopbackMode mode) {
        this.loopbackMode = mode == null ? LoopbackMode.OK : mode;
    }

    public int loopbackRequestCount() {
        return requestCount.get();
    }

    public int loopbackRequestCountForPath(String path) {
        int count = 0;
        synchronized (requestRecords) {
            for (RequestRecord record : requestRecords) {
                if (path == null ? record.path == null : path.equals(record.path)) count += 1;
            }
        }
        return count;
    }

    public int loopbackRequestCountContaining(String fragment) {
        int count = 0;
        synchronized (requestRecords) {
            for (RequestRecord record : requestRecords) {
                if ((record.path != null && record.path.contains(fragment))
                    || (record.body != null && record.body.contains(fragment))) count += 1;
            }
        }
        return count;
    }

    public JSONObject pendingRecoveryPacket() throws Exception {
        return new FallbackJournal(database.executionDao(), "device-connected-race")
            .pendingPacket(1000);
    }

    /**
     * Holds a real transaction on the singleton Room database.  The connected
     * WebView must continue through DOM application while the production
     * acknowledge CAS waits behind this transaction; no Room data is read or
     * written by the test thread while the latch is held.
     */
    public void startRoomTransactionHold() {
        if (roomHoldThread != null) throw new IllegalStateException("Room hold already active");
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch seedReady = new CountDownLatch(1);
        roomHoldEntered = entered;
        roomHoldRelease = release;
        roomHoldSeedReady = seedReady;
        roomHoldFailure = null;
        roomHoldAutoTimedOut = false;
        roomHoldThread = new Thread(() -> {
            try {
                if (!seedReady.await(120_000L, TimeUnit.MILLISECONDS)) {
                    roomHoldAutoTimedOut = true;
                    throw new IllegalStateException("Room transaction hold seed barrier timed out");
                }
                SupportSQLiteDatabase connection = database.getOpenHelper().getWritableDatabase();
                connection.beginTransactionNonExclusive();
                entered.countDown();
                try { release.await(); }
                catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("Room transaction hold interrupted", interrupted);
                }
                connection.setTransactionSuccessful();
                connection.endTransaction();
            } catch (Throwable failure) {
                roomHoldFailure = failure;
            }
        }, "yuqi-connected-room-ack-hold");
        roomHoldThread.start();
    }

    /** Activate the real transaction after the canonical seed has committed. */
    public void activateRoomTransactionHold() throws InterruptedException {
        CountDownLatch seedReady = roomHoldSeedReady;
        CountDownLatch entered = roomHoldEntered;
        if (seedReady == null || entered == null) throw new IllegalStateException("Room hold not armed");
        seedReady.countDown();
        if (!entered.await(5_000L, TimeUnit.MILLISECONDS)) {
            throw new AssertionError("Room transaction hold did not start");
        }
    }

    public boolean roomTransactionHoldAutoTimedOut() {
        return roomHoldAutoTimedOut;
    }

    public void releaseRoomTransactionHold() throws InterruptedException {
        CountDownLatch release = roomHoldRelease;
        CountDownLatch seedReady = roomHoldSeedReady;
        Thread thread = roomHoldThread;
        if (release == null || thread == null) return;
        if (seedReady != null) seedReady.countDown();
        release.countDown();
        thread.join(10_000L);
        if (thread.isAlive()) throw new AssertionError("Room transaction hold did not stop");
        roomHoldEntered = null;
        roomHoldRelease = null;
        roomHoldThread = null;
        if (roomHoldFailure != null) {
            Throwable failure = roomHoldFailure;
            roomHoldFailure = null;
            throw new AssertionError("Room transaction hold failed", failure);
        }
    }

    /** Wait past the configured real HTTP read timeout without releasing the response. */
    public void awaitTransportTimeout(RequestRecord record, long timeoutMillis)
        throws InterruptedException {
        if (record == null) throw new IllegalArgumentException("request record is required");
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
        while (System.nanoTime() < deadline) {
            Thread.sleep(50L);
        }
    }

    public RequestRecord awaitLoopbackAccepted(long timeoutMillis) throws Exception {
        if (!acceptedAny.await(timeoutMillis, TimeUnit.MILLISECONDS)) {
            throw new AssertionError("loopback accepted barrier was not reached");
        }
        if (loopbackFailure != null) throw new AssertionError("loopback failed", loopbackFailure);
        synchronized (requestRecords) {
            return requestRecords.get(requestRecords.size() - 1);
        }
    }

    public RequestRecord awaitLoopbackRequestCount(int expected, long timeoutMillis)
        throws Exception {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
        while (System.nanoTime() < deadline) {
            synchronized (requestRecords) {
                if (requestRecords.size() >= expected) {
                    return requestRecords.get(expected - 1);
                }
            }
            Thread.sleep(50L);
        }
        throw new AssertionError("loopback request count was not reached: " + expected);
    }

    public void releaseLoopbackResponse() {
        synchronized (requestRecords) {
            if (!requestRecords.isEmpty()) requestRecords.get(requestRecords.size() - 1).release(true);
        }
    }

    public void releaseLoopbackResponse(RequestRecord record) {
        if (record == null) throw new IllegalArgumentException("request record is required");
        record.release(true);
    }

    public void closeLoopbackRequest(RequestRecord record) {
        if (record == null) throw new IllegalArgumentException("request record is required");
        record.release(false);
    }

    public static final class RequestRecord {
        public final String method;
        public final String path;
        public final Map<String, String> headers;
        public final String body;
        public final long acceptedAt;
        public volatile String responseBody;
        private final CountDownLatch release = new CountDownLatch(1);
        private final CountDownLatch accepted = new CountDownLatch(1);
        private volatile boolean respond;
        private RequestRecord(String method, String path, Map<String, String> headers, String body,
            long acceptedAt) {
            this.method = method;
            this.path = path;
            this.headers = Collections.unmodifiableMap(new HashMap<>(headers));
            this.body = body;
            this.acceptedAt = acceptedAt;
        }
        private void markAccepted() { accepted.countDown(); }
        public boolean awaitAccepted(long timeoutMillis) throws InterruptedException {
            return accepted.await(timeoutMillis, TimeUnit.MILLISECONDS);
        }
        private void release(boolean respond) { this.respond = respond; release.countDown(); }
        private boolean awaitRelease() throws InterruptedException {
            if (!release.await(10, TimeUnit.SECONDS)) return false;
            return respond;
        }
    }

    /** Deterministic IDs shared by the production WebView source bubble and Room seed. */
    public String turnIdForCase(String logicalId) {
        return caseTurnId(logicalId);
    }

    public String sourceMessageIdForCase(String logicalId) {
        return "msg-connected-terminal-3-" + caseTurnId(logicalId);
    }

    public ChatTurnEntity submitDirectTurn(String turnId) {
        String actualTurnId = caseTurnId(turnId);
        long now = Math.max(1L, System.currentTimeMillis());
        try {
            return store.submitTurn(yuqiThreeBubbleSubmission(
                actualTurnId, sourceMessageIdForCase(turnId), now));
        } catch (Exception error) {
            throw new IllegalStateException("unable to create connected direct turn", error);
        }
    }

    /** Build a unique direct probe submission for a reopened store/runtime. */
    public TurnSubmission directSubmissionForCase(String logicalId) throws Exception {
        String actualTurnId = caseTurnId(logicalId);
        long now = Math.max(1L, System.currentTimeMillis());
        return yuqiThreeBubbleSubmission(actualTurnId, "source-" + actualTurnId, now);
    }

    /** Exact persisted submission for a probe that has already been inserted. */
    public TurnSubmission persistedDirectSubmissionForCase(String logicalId) {
        return persistedSubmission(caseTurnId(logicalId));
    }

    /** Prepare a real canonical V3 turn but leave its outcome open for race tests. */
    public PreparedSeed prepareCanonicalOpen(String turnId) throws Exception {
        String actualTurnId = caseTurnId(turnId);
        long createdAt = Math.max(1L, System.currentTimeMillis());
        store.submitTurn(yuqiThreeBubbleSubmission(
            actualTurnId, "msg-connected-terminal-3-" + actualTurnId, createdAt));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(actualTurnId), "device-connected-race", createdAt + 1L);
        ExecutionAttemptEntity attempt = store.activeAttempt(actualTurnId);
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        BridgeResult result = BridgeTurnStatus.parseV3(
            canonicalTerminal(checkpoint, "visible", 3, new JSONArray()).toString(),
            "lan",
            null);
        return new PreparedSeed(actualTurnId, attempt.attemptId, result, checkpoint);
    }

    /**
     * Seeds one canonical visible result through the same public production
     * sequence used by RoomExecutionStoreTest: queued submission, public
     * MEMORY transition, bridge checkpoint preparation, v3 parsing and the
     * atomic terminal commit.  No test-only store helper, reflection or SQL is
     * involved; every field used below is the persisted checkpoint/result
     * contract.
     */
    public CanonicalSeed seedCanonicalVisible(String turnId) throws Exception {
        String actualTurnId = caseTurnId(turnId);
        long createdAt = Math.max(1L, System.currentTimeMillis());
        store.submitTurn(yuqiThreeBubbleSubmission(
            actualTurnId, "msg-connected-terminal-3-" + actualTurnId, createdAt));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(actualTurnId), "device-connected-race", createdAt + 1L);
        ExecutionAttemptEntity attempt = store.activeAttempt(actualTurnId);
        if (attempt == null) throw new IllegalStateException("missing active canonical attempt");
        JSONObject checkpoint = new JSONObject(prepared.bridgeAuthorityCheckpointJson);
        BridgeResult result = BridgeTurnStatus.parseV3(
            canonicalTerminal(checkpoint, "visible", 3, new JSONArray()).toString(),
            "lan",
            null);
        RoomExecutionStore.DeliveryDisposition disposition = store.commitBridgedTerminal(
            actualTurnId, attempt.attemptId, result, createdAt + 2L);
        if (disposition != RoomExecutionStore.DeliveryDisposition.APPLY) {
            throw new IllegalStateException("canonical seed did not apply: " + disposition);
        }
        ChatTurnEntity committed = store.turn(actualTurnId);
        if (committed == null || !TurnState.COMPLETED.name().equals(committed.state)) {
            throw new IllegalStateException("canonical seed was not durably completed");
        }
        RoomExecutionStore reopened = new RoomExecutionStore(database, "device-connected-race");
        ChatTurnEntity reopenedTurn = reopened.turn(actualTurnId);
        if (reopenedTurn == null || !TurnState.COMPLETED.name().equals(reopenedTurn.state)
            || !result.visibleGroupId.equals(reopenedTurn.visibleGroupId)) {
            throw new IllegalStateException("canonical seed did not survive Room reopen");
        }
        ConversationCursorEntity reopenedCursor = reopened.getConversationCursor("yuqi");
        if (reopenedCursor == null || !result.visibleGroupId.equals(reopenedCursor.nativeCompletedGroupId)) {
            throw new IllegalStateException("canonical seed cursor did not survive Room reopen");
        }
        return new CanonicalSeed(actualTurnId, attempt.attemptId, result, checkpoint);
    }

    /** Reconstruct the asserted canonical receipt from a real production response. */
    public CanonicalSeed canonicalSeedFromResponse(String turnId, String responseBody)
        throws Exception {
        if (responseBody == null || responseBody.trim().isEmpty()) {
            throw new IllegalArgumentException("production canonical response is required");
        }
        String actualTurnId = caseTurnId(turnId);
        ExecutionAttemptEntity attempt = store.activeAttempt(actualTurnId);
        if (attempt == null || attempt.bridgeAuthorityCheckpointJson == null) {
            throw new IllegalStateException("missing production canonical checkpoint");
        }
        BridgeResult result = BridgeTurnStatus.parseV3(responseBody, "lan", null);
        ChatTurnEntity committed = store.turn(actualTurnId);
        if (committed == null || !TurnState.COMPLETED.name().equals(committed.state)
            || !result.visibleGroupId.equals(committed.visibleGroupId)) {
            throw new IllegalStateException("production canonical response was not durably applied");
        }
        return new CanonicalSeed(
            actualTurnId,
            attempt.attemptId,
            result,
            new JSONObject(attempt.bridgeAuthorityCheckpointJson));
    }

    public FallbackSeed seedAndroidFallbackVisible(String turnId) throws Exception {
        String actualTurnId = caseTurnId(turnId);
        long createdAt = Math.max(1L, System.currentTimeMillis());
        store.submitTurn(yuqiFallbackSubmission(
            actualTurnId, "msg-connected-fallback-" + actualTurnId, createdAt));
        TurnSubmission prepared = store.prepareBridgeSubmission(
            persistedSubmission(actualTurnId), "device_gateway", createdAt + 1L);
        ExecutionAttemptEntity attempt = store.activeAttempt(actualTurnId);
        ReplyPartEntity draft = new ReplyPartEntity();
        draft.replyPartId = "fallback-reply-" + actualTurnId;
        draft.turnId = actualTurnId;
        draft.attemptId = attempt.attemptId;
        draft.sequence = 0;
        draft.type = "TEXT";
        draft.content = "本地回退结果";
        draft.payloadJson = "{}";
        draft.createdAt = createdAt + 2L;
        RoomExecutionStore.DeliveryDisposition disposition = store.commitAndroidFallback(
            actualTurnId, attempt.attemptId, Collections.singletonList(draft), "visible",
            createdAt + 3L);
        if (disposition != RoomExecutionStore.DeliveryDisposition.APPLY) {
            throw new IllegalStateException("Android fallback seed did not apply: " + disposition);
        }
        ChatTurnEntity turn = store.turn(actualTurnId);
        if (turn == null || !TurnState.COMPLETED.name().equals(turn.state)
            || !"android_fallback".equals(turn.authorityOrigin)) {
            throw new IllegalStateException("Android fallback was not durably committed");
        }
        return new FallbackSeed(actualTurnId, turn.visibleGroupId, turn.bridgeCommitChecksum);
    }

    private String caseTurnId(String logicalId) {
        if (logicalId == null || logicalId.trim().isEmpty()) {
            throw new IllegalArgumentException("connected case turn id is required");
        }
        return casePrefix + "-" + logicalId;
    }

    public ChatTurnEntity claimTurn(String turnId) {
        ChatTurnEntity claimed = store.claimNext(System.currentTimeMillis());
        if (claimed == null || !turnId.equals(claimed.turnId)) {
            throw new IllegalStateException("connected race turn was not claimed by production store");
        }
        return claimed;
    }

    public ChatTurnEntity commitVisibleReply(String turnId, String content) {
        ChatTurnEntity turn = store.turn(turnId);
        ExecutionAttemptEntity attempt = store.activeAttempt(turnId);
        if (turn == null || attempt == null) throw new IllegalStateException("missing production attempt");
        ReplyPartEntity part = new ReplyPartEntity();
        part.replyPartId = "reply-" + turnId;
        part.turnId = turnId;
        part.attemptId = attempt.attemptId;
        part.sequence = 0;
        part.type = "TEXT";
        part.content = content;
        part.payloadJson = "{}";
        part.createdAt = System.currentTimeMillis();
        store.commitReply(turnId, attempt.attemptId, Collections.singletonList(part), part.createdAt);
        return store.turn(turnId);
    }

    private TurnSubmission persistedSubmission(String turnId) {
        ChatTurnEntity turn = store.turn(turnId);
        if (turn == null) throw new IllegalStateException("missing persisted turn: " + turnId);
        if (TurnState.QUEUED.name().equals(turn.state)) {
            store.markStage(
                turnId,
                turn.activeAttemptId,
                TurnState.MEMORY_RUNNING,
                AttemptStage.MEMORY,
                Math.max(1L, turn.updatedAt + 1L));
            turn = store.turn(turnId);
        }
        return new TurnSubmission(
            turn.turnId,
            turn.characterId,
            turn.sourceMessageId,
            TurnKind.valueOf(turn.kind),
            turn.inputJson,
            turn.snapshotJson,
            turn.cloudJobId,
            turn.createdAt
        );
    }

    private static TurnSubmission yuqiThreeBubbleSubmission(
        String turnId,
        String lastMessageId,
        long createdAt
    ) throws Exception {
        JSONArray messages = new JSONArray()
            .put(userMessage("msg-prior-1-" + turnId, "第一泡", createdAt - 2L))
            .put(userMessage("msg-prior-2-" + turnId, "第二泡", createdAt - 1L))
            .put(userMessage(lastMessageId, "第三泡", createdAt));
        JSONArray ids = new JSONArray();
        for (int index = 0; index < messages.length(); index += 1) {
            ids.put(messages.getJSONObject(index).getString("messageId"));
        }
        JSONObject input = new JSONObject()
            .put("message", messages.getJSONObject(2))
            .put("options", new JSONObject()
                .put("batchId", "batch-" + turnId)
                .put("batchMessageIds", ids)
                .put("batchMessages", messages)
                .put("batchStartedAt", createdAt - 2L)
                .put("batchCommittedAt", createdAt));
        return new TurnSubmission(
            turnId,
            "yuqi",
            lastMessageId,
            TurnKind.DIRECT_REPLY,
            input.toString(),
            new JSONObject().put("scene", "chat").toString(),
            null,
            createdAt
        );
    }

    private static TurnSubmission yuqiFallbackSubmission(
        String turnId, String lastMessageId, long createdAt
    ) throws Exception {
        TurnSubmission base = yuqiThreeBubbleSubmission(turnId, lastMessageId, createdAt);
        JSONObject snapshot = new JSONObject()
            .put("contract", "cognition-v3")
            .put("schemaVersion", 3)
            .put("roleId", "yuqi")
            .put("hardConstraints", new JSONArray())
            .put("preferences", new JSONArray())
            .put("currentStances", new JSONArray())
            .put("relationship", new JSONObject().put("base", "close"))
            .put("recentGroups", new JSONArray())
            .put("verifiedFacts", new JSONArray())
            .put("lifeSignals", new JSONArray())
            .put("authorSettings", new JSONObject())
            .put("fallbackExecution", new JSONObject()
                .put("contract", "cognition-v3-fallback-v1")
                .put("deviceId", "device_gateway")
                .put("cognition", new JSONObject()
                    .put("configId", "memory-v3")
                    .put("system", "private cognition prompt")
                    .put("messages", new JSONArray()))
                .put("expression", new JSONObject()
                    .put("configId", "chat-v3")
                    .put("system", "private expression prompt")
                    .put("messages", new JSONArray())));
        return new TurnSubmission(base.turnId, base.characterId, base.sourceMessageId, base.kind,
            base.inputJson, snapshot.toString(), base.cloudJobId, base.createdAt);
    }

    public static JSONObject backupReceipt(String roleId, long createdAt) throws Exception {
        String manifestChecksum = repeat('a', 64);
        String snapshotSha256 = repeat('b', 64);
        String logicalChecksum = repeat('c', 64);
        JSONObject basis = new JSONObject()
            .put("contract", "yuqi-backup-receipt-id-v1")
            .put("roleId", roleId)
            .put("manifestChecksum", manifestChecksum)
            .put("snapshotSha256", snapshotSha256)
            .put("logicalChecksum", logicalChecksum)
            .put("createdAt", createdAt);
        JSONObject receipt = new JSONObject()
            .put("receiptVersion", "yuqi-backup-receipt-v1")
            .put("receiptId", "bkrcpt_" + BridgeAuthority.sha256CanonicalJson(basis).substring(0, 24))
            .put("roleId", roleId)
            .put("manifestChecksum", manifestChecksum)
            .put("snapshotSha256", snapshotSha256)
            .put("logicalChecksum", logicalChecksum)
            .put("createdAt", createdAt);
        return receipt.put("receiptChecksum", BridgeAuthority.sha256CanonicalJson(receipt));
    }

    private static String repeat(char value, int length) {
        char[] output = new char[length];
        java.util.Arrays.fill(output, value);
        return new String(output);
    }

    private static JSONObject userMessage(String messageId, String content, long sentAt)
        throws Exception {
        return new JSONObject()
            .put("messageId", messageId)
            .put("speakerType", "user")
            .put("speakerId", "user")
            .put("recipientId", "yuqi")
            .put("content", content)
            .put("sentAt", sentAt)
            .put("attachments", new JSONArray());
    }

    private static JSONObject canonicalTerminal(
        JSONObject checkpoint,
        String disposition,
        int itemCount,
        JSONArray actions
    ) throws Exception {
        String lineageKey = checkpoint.getString("authorityLineageKey");
        String groupId = com.siyi.al.execution.AuthorityIdentity.groupId(lineageKey);
        JSONArray parts = new JSONArray();
        for (int ordinal = 0; ordinal < itemCount; ordinal += 1) {
            JSONObject semantic = new JSONObject()
                .put("content", "虞栖回复第" + (ordinal + 1) + "泡")
                .put("speakerId", "yuqi")
                .put("speakerType", "character")
                .put("recipientId", "user");
            parts.put(new JSONObject(semantic.toString())
                .put("messageId", com.siyi.al.execution.AuthorityIdentity.messageId(groupId, ordinal))
                .put("ordinal", ordinal)
                .put("itemChecksum", BridgeAuthority.sha256CanonicalJson(semantic)));
        }
        return new JSONObject()
            .put("protocolVersion", 3)
            .put("turnId", checkpoint.getString("authoritativeTurnId"))
            .put("roleId", "yuqi")
            .put("authorityOrigin", "pc")
            .put("authorityLineageKey", lineageKey)
            .put("visibleGroupId", groupId)
            .put("lineageRevision", checkpoint.getLong("claimedLineageRevision") + 1L)
            .put("turnRevision", 4L)
            .put("laneKey", checkpoint.getString("laneKey"))
            .put("laneRevision", 8L)
            .put("inputVisibilitySequence", checkpoint.getLong("inputVisibilitySequence"))
            .put("inputClearEpoch", checkpoint.getLong("inputClearEpoch"))
            .put("generationFingerprint", "fp_v3_terminal")
            .put("releaseId", "cognition-v3")
            .put("commitPayloadVersion", "pc-visible-commit-v2")
            .put("commitChecksum", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .put("terminalDisposition", disposition)
            .put("replyParts", parts)
            .put("actions", actions);
    }

    private static JSONObject canonicalDeterministicFailure(
        JSONObject checkpoint, long failedAt
    ) throws Exception {
        JSONObject failure = new JSONObject()
            .put("protocolVersion", 3)
            .put("type", "BACKLOG_FAILED")
            .put("turnId", checkpoint.getString("authoritativeTurnId"))
            .put("roleId", "yuqi")
            .put("authorityLineageKey", checkpoint.getString("authorityLineageKey"))
            .put("lineageRevision", checkpoint.getLong("claimedLineageRevision"))
            .put("turnRevision", 1L)
            .put("laneKey", checkpoint.getString("laneKey"))
            .put("laneRevision", 1L)
            .put("retryOfTurnId", checkpoint.get("retryOfTurnId"))
            .put("inputVisibilitySequence", checkpoint.getLong("inputVisibilitySequence"))
            .put("inputClearEpoch", checkpoint.getLong("inputClearEpoch"))
            .put("generationFingerprint", JSONObject.NULL)
            .put("releaseId", "cognition-v3")
            .put("state", "failed")
            .put("errorCode", "YUQI_DETERMINISTIC_EXECUTION_FAILURE")
            .put("failureClass", "deterministic")
            .put("retryAllowed", false)
            .put("failedAt", failedAt);
        failure.put("rawStatusChecksum", BridgeAuthority.sha256CanonicalJson(failure));
        return failure;
    }

    public static final class CanonicalSeed {
        public final String turnId;
        public final String attemptId;
        public final BridgeResult result;
        public final JSONObject checkpoint;

        private CanonicalSeed(
            String turnId,
            String attemptId,
            BridgeResult result,
            JSONObject checkpoint
        ) {
            this.turnId = turnId;
            this.attemptId = attemptId;
            this.result = result;
            this.checkpoint = checkpoint;
        }
    }

    public static final class FallbackSeed {
        public final String turnId;
        public final String visibleGroupId;
        public final String commitChecksum;
        private FallbackSeed(String turnId, String visibleGroupId, String commitChecksum) {
            this.turnId = turnId;
            this.visibleGroupId = visibleGroupId;
            this.commitChecksum = commitChecksum;
        }
    }

    public static final class PreparedSeed {
        public final String turnId;
        public final String attemptId;
        public final BridgeResult result;
        public final JSONObject checkpoint;
        private PreparedSeed(String turnId, String attemptId, BridgeResult result, JSONObject checkpoint) {
            this.turnId = turnId;
            this.attemptId = attemptId;
            this.result = result;
            this.checkpoint = checkpoint;
        }
    }

    public enum LoopbackMode {
        OK, HOLD_THEN_CLOSE, HOLD_THEN_RESPOND, HOLD_THEN_CANONICAL, HOLD_THEN_FAILURE,
        RECOVERY_ACK, RECOVERY_CANONICAL, DROP
    }

    private void startLoopback() {
        try {
            loopback = new ServerSocket(0);
            loopbackThread = new Thread(() -> {
                while (!loopback.isClosed()) {
                    try {
                        Socket socket = loopback.accept();
                        Thread worker = new Thread(() -> handleLoopbackConnection(socket),
                            "yuqi-connected-race-loopback-connection");
                        connectionWorkers.add(worker);
                        worker.start();
                    } catch (IOException error) {
                        if (!loopback.isClosed()) loopbackFailure = error;
                    }
                }
            }, "yuqi-connected-race-loopback");
            loopbackThread.start();
        } catch (IOException error) {
            throw new IllegalStateException("cannot start connected race loopback", error);
        }
    }

    private void handleLoopbackConnection(Socket socket) {
        acceptedSockets.add(socket);
        try (Socket owned = socket) {
            InputStream input = owned.getInputStream();
            ByteArrayOutputStream headerBytes = new ByteArrayOutputStream();
            int matched = 0;
            int value;
            while ((value = input.read()) != -1) {
                headerBytes.write(value);
                if ((matched == 0 && value == '\r') || (matched == 2 && value == '\r')) {
                    matched += 1;
                } else if ((matched == 1 && value == '\n') || (matched == 3 && value == '\n')) {
                    matched += 1;
                    if (matched == 4) break;
                } else {
                    matched = value == '\r' ? 1 : 0;
                }
            }
            if (matched != 4) throw new IOException("loopback request did not contain complete headers");
            String header = headerBytes.toString(StandardCharsets.UTF_8.name());
            String[] requestLine = header.split("\\r\\n", 2)[0].split(" ", 3);
            String method = requestLine.length > 0 ? requestLine[0] : "";
            String path = requestLine.length > 1 ? requestLine[1] : "";
            int contentLength = 0;
            Map<String, String> headers = new HashMap<>();
            String[] lines = header.split("\\r\\n");
            for (int index = 1; index < lines.length; index += 1) {
                String line = lines[index];
                int colon = line.indexOf(':');
                if (colon <= 0) continue;
                String name = line.substring(0, colon).trim().toLowerCase(java.util.Locale.ROOT);
                String headerValue = line.substring(colon + 1).trim();
                headers.put(name, headerValue);
                if ("content-length".equals(name)) contentLength = Integer.parseInt(headerValue);
            }
            if (contentLength < 0 || contentLength > 4 * 1024 * 1024) {
                throw new IOException("invalid loopback content length: " + contentLength);
            }
            byte[] body = new byte[contentLength];
            int offset = 0;
            while (offset < contentLength) {
                int read = input.read(body, offset, contentLength - offset);
                if (read < 0) throw new IOException("short loopback body");
                offset += read;
            }
            requestCount.incrementAndGet();
            RequestRecord record = new RequestRecord(
                method, path, headers, new String(body, StandardCharsets.UTF_8),
                System.currentTimeMillis());
            requestRecords.add(record);
            LoopbackMode requestMode = loopbackMode;
            String heldCanonicalCheckpoint = null;
            if (requestMode == LoopbackMode.HOLD_THEN_CANONICAL
                || requestMode == LoopbackMode.HOLD_THEN_FAILURE) {
                JSONObject request = new JSONObject(record.body == null ? "{}" : record.body);
                String turnId = request.optString("turnId", "");
                ChatTurnEntity turn = store.turn(turnId);
                ExecutionAttemptEntity attempt = turn == null ? null : store.activeAttempt(turnId);
                if (attempt == null || attempt.bridgeAuthorityCheckpointJson == null) {
                    throw new IOException("missing held canonical checkpoint: " + turnId);
                }
                // Capture the valid open checkpoint before the clear transaction
                // redacts it. The response remains a real canonical terminal;
                // production commit validates it against the persisted tombstone.
                heldCanonicalCheckpoint = attempt.bridgeAuthorityCheckpointJson;
            }
            // For HOLD_THEN_CANONICAL, accepted means the open checkpoint is
            // already captured; the clear transaction may now race safely.
            record.markAccepted();
            acceptedAny.countDown();
            boolean respond = true;
            if (requestMode == LoopbackMode.HOLD_THEN_CANONICAL
                || requestMode == LoopbackMode.HOLD_THEN_FAILURE) {
                respond = record.awaitRelease();
            } else if (requestMode == LoopbackMode.HOLD_THEN_RESPOND
                || requestMode == LoopbackMode.HOLD_THEN_CLOSE) {
                respond = record.awaitRelease() && requestMode == LoopbackMode.HOLD_THEN_RESPOND;
            }
            if (requestMode == LoopbackMode.DROP || !respond) return;
            OutputStream output = owned.getOutputStream();
            String responseJson = "{\"ok\":true}";
            if (requestMode == LoopbackMode.RECOVERY_ACK) {
                JSONObject request = new JSONObject(record.body == null ? "{}" : record.body);
                JSONObject recovery = request.optJSONObject("recovery");
                long ackSeq = recovery == null ? 0L : recovery.optLong("lastSeq", 0L);
                String turnId = request.optString("turnId", "");
                ChatTurnEntity turn = store.turn(turnId);
                ExecutionAttemptEntity attempt = turn == null ? null : store.activeAttempt(turnId);
                if (attempt == null || attempt.bridgeAuthorityCheckpointJson == null) {
                    throw new IOException("missing recovery probe checkpoint: " + turnId);
                }
                JSONObject checkpoint = new JSONObject(attempt.bridgeAuthorityCheckpointJson);
                responseJson = canonicalDeterministicFailure(checkpoint, System.currentTimeMillis())
                    .put("terminal", true)
                    .put("recoveryAckSeq", ackSeq)
                    .toString();
            } else if (requestMode == LoopbackMode.RECOVERY_CANONICAL
                || requestMode == LoopbackMode.HOLD_THEN_CANONICAL
                || requestMode == LoopbackMode.HOLD_THEN_FAILURE) {
                JSONObject request = new JSONObject(record.body == null ? "{}" : record.body);
                String turnId = request.optString("turnId", "");
                String checkpointJson = heldCanonicalCheckpoint;
                if (checkpointJson == null) {
                    ChatTurnEntity turn = store.turn(turnId);
                    ExecutionAttemptEntity attempt = turn == null ? null : store.activeAttempt(turnId);
                    checkpointJson = attempt == null ? null : attempt.bridgeAuthorityCheckpointJson;
                }
                if (checkpointJson == null) {
                    throw new IOException("missing recovery canonical checkpoint: " + turnId);
                }
                JSONObject checkpoint = new JSONObject(checkpointJson);
                // Canonical terminal responses are closed protocol values; the
                // transport recovery acknowledgement is not a terminal payload
                // field and must not be smuggled into this JSON object.
                if (requestMode == LoopbackMode.HOLD_THEN_FAILURE) {
                    responseJson = canonicalDeterministicFailure(checkpoint, System.currentTimeMillis())
                        .put("terminal", true)
                        .toString();
                } else {
                    responseJson = canonicalTerminal(checkpoint, "visible", 3, new JSONArray())
                        .put("terminal", true)
                        .toString();
                }
            }
            byte[] responseBody = responseJson.getBytes(StandardCharsets.UTF_8);
            record.responseBody = responseJson;
            output.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                + "Content-Length: " + responseBody.length + "\r\nConnection: close\r\n\r\n")
                .getBytes(StandardCharsets.UTF_8));
            output.write(responseBody);
            output.flush();
        } catch (Throwable error) {
            if (!closing) loopbackFailure = error;
            acceptedAny.countDown();
        } finally {
            acceptedSockets.remove(socket);
        }
    }

    @Override public void close() {
        if (closing) return;
        closing = true;
        try { releaseRoomTransactionHold(); } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("interrupted releasing Room transaction hold", interrupted);
        }
        // Stop any service/runtime started by this case before preferences and
        // Room state are restored.  This is a fixture lifecycle fence, not a
        // production fallback; workers are still joined below.
        context.stopService(new Intent(context, AlExecutionService.class));
        awaitExecutionServiceStopped();
        try { if (loopback != null) loopback.close(); } catch (IOException ignored) { }
        synchronized (requestRecords) {
            for (RequestRecord record : requestRecords) record.release(false);
        }
        synchronized (acceptedSockets) {
            for (Socket socket : acceptedSockets) {
                try { socket.close(); } catch (IOException ignored) { }
            }
        }
        if (loopbackThread != null) {
            loopbackThread.interrupt();
            try { loopbackThread.join(2_000L); } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
        boolean workerAlive = false;
        synchronized (connectionWorkers) {
            for (Thread worker : connectionWorkers) worker.interrupt();
            for (Thread worker : connectionWorkers) {
                try { worker.join(2_000L); } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                workerAlive |= worker.isAlive();
            }
            connectionWorkers.clear();
        }
        if (loopbackThread != null && loopbackThread.isAlive()) {
            throw new AssertionError("loopback accept worker did not stop");
        }
        if (workerAlive) throw new AssertionError("loopback connection worker did not stop");
        android.content.SharedPreferences prefs = context.getSharedPreferences(
            "al.execution.secrets.v1.prefs", Context.MODE_PRIVATE);
        android.content.SharedPreferences.Editor restore = prefs.edit().clear();
        for (Map.Entry<String, ?> entry : originalSecretPreferences.entrySet()) {
            Object value = entry.getValue();
            if (value instanceof String) restore.putString(entry.getKey(), (String) value);
            else if (value instanceof Boolean) restore.putBoolean(entry.getKey(), (Boolean) value);
            else if (value instanceof Integer) restore.putInt(entry.getKey(), (Integer) value);
            else if (value instanceof Long) restore.putLong(entry.getKey(), (Long) value);
            else if (value instanceof Float) restore.putFloat(entry.getKey(), (Float) value);
            else if (value instanceof java.util.Set) {
                @SuppressWarnings("unchecked") java.util.Set<String> values =
                    (java.util.Set<String>) value;
                restore.putStringSet(entry.getKey(), values);
            }
        }
        if (!restore.commit()) throw new AssertionError("connected fixture secret restore failed");
        // Do not revoke a runtime permission from the target process while the
        // instrumentation process is still alive: Android terminates the target
        // on revoke, which makes a passing test look like an instrumentation
        // crash.  NotificationManager.cancelAll above removes every case
        // notification; UTP uninstalls the target APK after the run, restoring
        // the permission boundary without a self-inflicted process kill.
        if (loopbackFailure != null) throw new AssertionError("connected loopback failed", loopbackFailure);
    }

    private void awaitExecutionServiceStopped() {
        try {
            if (!AlExecutionService.awaitStoppedForTest(20_000L)) {
                throw new AssertionError("AlExecutionService did not publish STOPPED cleanup");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("interrupted waiting for AlExecutionService cleanup", interrupted);
        }
    }
}
