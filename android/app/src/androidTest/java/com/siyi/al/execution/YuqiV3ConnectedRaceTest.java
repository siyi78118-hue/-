package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.app.NotificationManager;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.AlExecutionPlugin;
import com.siyi.al.execution.AlNotificationFactory;
import com.siyi.al.execution.db.ChatTurnEntity;
import com.siyi.al.execution.db.ConversationAuthorityEntity;
import com.siyi.al.execution.db.ConversationCursorEntity;
import com.siyi.al.execution.db.ExecutionAttemptEntity;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.ReplyPartEntity;
import com.siyi.al.execution.bridge.FallbackJournal;
import com.siyi.al.execution.bridge.BridgeConfig;
import com.siyi.al.execution.bridge.BridgePendingException;
import com.siyi.al.execution.secure.AlSecretStore;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.room.Room;

/**
 * Device-only release gate for the eleven cross-runtime races deferred by the
 * PC matrix.  Every method enters through the production ExecutionRuntime and
 * Room database; the readiness verifier, rather than these tests, owns the
 * pass/skip accounting and will never synthesize a result without a device.
 */
@RunWith(AndroidJUnit4.class)
public final class YuqiV3ConnectedRaceTest {
    @Test public void native_completed_before_ui_open() throws Exception {
            Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (YuqiV3ConnectedRaceFixture fixture = YuqiV3ConnectedRaceFixture.open(context)) {
            final String logicalId = "connected-native-completed-before-ui-open";
            final String sourceMessageId = fixture.sourceMessageIdForCase(logicalId);
            ConversationCursorEntity initialCursor = fixture.store.getConversationCursor("yuqi");
            assertEquals(true, initialCursor == null || initialCursor.nativeCompletedSequence == 0L);
            // The source role/user bubble is a real shipped WebView record.  It
            // must be persisted while the UI is alive, then the Activity is
            // closed before Room receives the canonical terminal result.
            try (YuqiV3WebViewHarness web = YuqiV3WebViewHarness.launch()) {
                web.waitForScriptValue("document.readyState", "\"complete\"");
                web.resetCaseWebState("connected-native-completed-before-ui-open");
                web.prepareCanonicalSourceMessage(
                    "yuqi", sourceMessageId, "第三泡");
                web.waitForScriptContains(
                    "JSON.stringify((allChats.yuqi?.messages||[]).map(m=>m.id))", sourceMessageId);
                assertNullCursorShape(new JSONObject(web.waitForConversationCursor("yuqi")));
            }
            YuqiV3ConnectedRaceFixture.CanonicalSeed seed = fixture.seedCanonicalVisible(logicalId);
            ChatTurnEntity committed = fixture.store.turn(seed.turnId);
            assertEquals(TurnState.COMPLETED.name(), committed.state);
            assertEquals(seed.result.visibleGroupId, committed.visibleGroupId);
            try (YuqiV3WebViewHarness web = YuqiV3WebViewHarness.launch()) {
                web.waitForScriptValue("document.readyState", "\"complete\"");
                web.waitForShippedUiBootstrap();
                // Reopen the shipped chat route before production reconciliation;
                // the native apply path requires the existing Yuqi source bubble
                // and only renders assistant messages on the chat screen.
                web.showYuqiChat();
                web.waitForScriptValue("nativeExecutionCompletedListenerReady", "true");
                JSONObject cursorShape = new JSONObject(web.waitForConversationCursor("yuqi"));
                assertNativePendingCursorShape(cursorShape, seed.turnId, seed.result.visibleGroupId);
                // Wake the shipped production listener through its real event
                // path; the cursor poll below remains the observation barrier.
                AlExecutionService.requestRun(context);
                AlExecutionPlugin.notifyCompletedTurn(seed.turnId, System.currentTimeMillis());
                String cursorScript = "(async()=>{try{const p=window.Capacitor?.Plugins?.AlExecution;"
                    + "if(!p){window.__yuqiConnectedCursor=JSON.stringify({error:'missing-production-plugin',"
                    + "keys:Object.keys(window.Capacitor?.Plugins||{})});return;}"
                    + "for(let i=0;i<240;i++){const r=await p.getConversationCursor({characterId:'yuqi'});"
                    + "window.__yuqiConnectedCursor=JSON.stringify({result:r});"
                    + "if(r?.uiAppliedTurnId==='" + seed.turnId + "')break;"
                    + "await new Promise(resolve=>setTimeout(resolve,100));}"
                    + "}catch(e){window.__yuqiConnectedCursor=JSON.stringify({error:String(e),stack:e?.stack||''});}})()";
                web.evaluate(cursorScript);
                String cursor;
                try {
                    cursor = web.waitForScriptContains(
                        "window.__yuqiConnectedCursor || ''", "\\\"uiAppliedTurnId\\\":\\\"" + seed.turnId);
                } catch (AssertionError failure) {
                    String debug = web.evaluate(
                        "JSON.stringify({activeScreen,character:characters.find(c=>c.id==='yuqi')||null,"
                            + "chat:allChats.yuqi||null,source:(allChats.yuqi?.messages||[]).find(m=>m.id==='"
                            + sourceMessageId + "')||null,plugin:Object.keys(window.Capacitor?.Plugins||{}),"
                            + "reconcile:window.__yuqiConnectedReconcile||null})");
                    throw new AssertionError(failure.getMessage() + " debug=" + debug, failure);
                }
                assertEquals(true, cursor.contains(seed.turnId));
                // Use the shipped navigation/render path so the persisted
                // landing is observable in the DOM after a fresh Activity.
                web.evaluate("currentCharId='yuqi';showScreen('chat');renderMessages({forceBottom:true});");
                web.waitForStructuredAssistantDom(seed.turnId, 3);
                JSONObject landing = new JSONObject(web.chatLandingStructuredSummary(seed.turnId, sourceMessageId));
                JSONArray assistant = landing.getJSONArray("assistant");
                assertExactAssistantDom(landing, 3);
                assertEquals(1, landing.getJSONArray("source").length());
                for (int ordinal = 0; ordinal < assistant.length(); ordinal += 1) {
                    JSONObject message = assistant.getJSONObject(ordinal);
                    assertEquals("native:" + seed.turnId, message.getString("sourceTurnId"));
                    assertEquals(sourceMessageId, message.getString("replyToMessageId"));
                    assertEquals(0, message.getJSONArray("actions").length());
                }
                ChatTurnEntity firstAppliedTurn = fixture.store.turn(seed.turnId);
                ConversationCursorEntity firstAppliedCursor = fixture.store.getConversationCursor("yuqi");
                String firstPartsSnapshot = canonicalReplyPartsSnapshot(fixture.store.replyParts(seed.turnId));
                assertCanonicalReplyParts(seed, fixture.store.replyParts(seed.turnId));
                web.reload();
                web.waitForShippedUiReady();
                web.showYuqiChat();
                web.waitForScriptValue("!!(allChats.yuqi&&Array.isArray(allChats.yuqi.messages))", "true");
                web.waitForScriptContains(
                    "JSON.stringify((allChats.yuqi.messages||[]).map(m=>m.id))", sourceMessageId);
                // Boot may finish restoring messages after the initial route
                // call; navigate through the shipped renderer once data exists.
                web.showYuqiChat();
                web.waitForStructuredAssistantDom(seed.turnId, 3);
                JSONObject replay = new JSONObject(web.chatLandingStructuredSummary(seed.turnId, sourceMessageId));
                assertExactAssistantDom(replay, 3);
                assertEquals(1, replay.getJSONArray("source").length());
                assertEquals(firstPartsSnapshot, canonicalReplyPartsSnapshot(fixture.store.replyParts(seed.turnId)));
                assertReceiptTupleUnchanged(firstAppliedTurn, firstAppliedCursor,
                    fixture.store.turn(seed.turnId), fixture.store.getConversationCursor("yuqi"));
            }
            RoomExecutionStore reopened = new RoomExecutionStore(fixture.database, "device-connected-race");
            ChatTurnEntity reopenedTurn = reopened.turn(seed.turnId);
            ConversationCursorEntity reopenedCursor = reopened.getConversationCursor("yuqi");
            assertEquals(true, reopenedTurn.uiAppliedAt != null);
            assertEquals(seed.result.visibleGroupId, reopenedCursor.uiAppliedGroupId);
            assertEquals(seed.turnId, reopenedCursor.uiAppliedTurnId);
            assertEquals(1L, reopenedCursor.nativeCompletedSequence);
            assertEquals(1L, reopenedCursor.uiAppliedSequence);
            assertEquals(seed.result.commitChecksum, reopenedTurn.bridgeCommitChecksum);
            assertEquals(seed.result.authorityLineageKey, reopenedTurn.authorityLineageKey);
            assertEquals(seed.result.lineageRevision, reopenedTurn.lineageRevision.longValue());
            assertEquals(seed.result.turnRevision, reopenedTurn.turnRevision.longValue());
            assertEquals(seed.result.laneKey, reopenedTurn.laneKey);
            assertEquals(seed.result.laneRevision, reopenedTurn.laneRevision.longValue());
            assertEquals(seed.result.generationFingerprint, reopenedTurn.generationFingerprint);
            assertEquals(seed.result.releaseId, reopenedTurn.pipelineReleaseId);
            assertEquals(seed.result.terminalDisposition, reopenedTurn.terminalDisposition);
            assertEquals(seed.result.inputVisibilitySequence, reopenedTurn.inputVisibilitySequence.longValue());
            assertEquals(seed.result.inputClearEpoch, reopenedTurn.inputClearEpoch.longValue());
            assertEquals(canonicalReplyPartsSnapshot(fixture.store.replyParts(seed.turnId)),
                canonicalReplyPartsSnapshot(reopened.replyParts(seed.turnId)));
            assertCanonicalReplyParts(seed, reopened.replyParts(seed.turnId));
        }
    }
    @Test public void ui_open_before_notification() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (YuqiV3ConnectedRaceFixture fixture = YuqiV3ConnectedRaceFixture.open(context);
             YuqiV3WebViewHarness web = YuqiV3WebViewHarness.launch()) {
            fixture.enableNotificationsForCase();
            String logicalId = "ui-open-before-notification";
            String source = fixture.sourceMessageIdForCase(logicalId);
            web.waitForScriptValue("document.readyState", "\"complete\"");
            web.resetCaseWebState("connected-native-completed-before-ui-open");
            web.waitForScriptValue("document.readyState", "\"complete\"");
            web.waitForScriptValue("nativeExecutionCompletedListenerReady", "true");
            web.prepareCanonicalSourceMessage("yuqi", source, "UI先开");
            web.waitForScriptValue("nativeExecutionCompletedListenerReady", "true");
            fixture.setLoopbackMode(YuqiV3ConnectedRaceFixture.LoopbackMode.RECOVERY_CANONICAL);
            fixture.saveLoopbackBridgeConfig();
            fixture.submitDirectTurn(logicalId);
            // requestRun starts the real service worker, which claims the queued
            // turn, calls ExecutionRuntime.runNext, and owns notification side effects.
            web.observeExecutionCompletedEvents(fixture.turnIdForCase(logicalId));
            YuqiV3ConnectedRaceFixture.RequestRecord request;
            YuqiV3ConnectedRaceFixture.CanonicalSeed seed;
            try {
                AlExecutionService.requestRun(context);
                request = fixture.awaitLoopbackAccepted(20_000L);
                assertEquals("POST", request.method);
                assertEquals("/v2/turns", request.path);
                // The production service is START_STICKY and remains alive after
                // draining its queue; STOPPED is an onDestroy cleanup state, not a
                // per-turn completion barrier.  Wait on the persisted production
                // turn instead, then let fixture.close() stop and join the service.
                waitForRoomTurnCompleted(fixture.store, fixture.turnIdForCase(logicalId));
                assertNotNull(request.responseBody);
                seed = fixture.canonicalSeedFromResponse(logicalId, request.responseBody);
                waitForRoomUiApplied(fixture.store, seed.turnId);
                web.waitForExecutionCompletedEventCount(1);
                assertEquals("production completion event must execute independently of poll",
                    1, web.executionCompletedEventCount());
            } finally {
                web.clearExecutionCompletedEventObserver();
            }
            AlNotificationStatus.Snapshot notificationStatus = AlNotificationStatus.inspect(context);
            assertTrue("notification health is required for this device gate: permission="
                + notificationStatus.permissionGranted + ", appEnabled=" + notificationStatus.appEnabled
                + ", channelExists=" + notificationStatus.channelExists + ", importance="
                + notificationStatus.importance + ", sound=" + notificationStatus.hasSound
                + ", vibration=" + notificationStatus.vibrationEnabled + ", visibility="
                + notificationStatus.lockscreenVisibility + ", summary=" + notificationStatus.summary,
                notificationStatus.healthy);
            ChatTurnEntity notifiedTurn = fixture.store.turn(seed.turnId);
            assertNotNull(notifiedTurn.notificationShownAt);
            NotificationManager notificationManager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            assertNotNull(notificationManager);
            int notificationId = AlNotificationFactory.messageNotificationId(seed.turnId);
            int activeCount = 0;
            int publicVisibilityCount = 0;
            for (android.service.notification.StatusBarNotification item : notificationManager.getActiveNotifications()) {
                if (item.getId() == notificationId) {
                    activeCount += 1;
                    if (item.getNotification().visibility == android.app.Notification.VISIBILITY_PUBLIC) {
                        publicVisibilityCount += 1;
                    }
                }
            }
            assertTrue("exact notification id must be observable", activeCount == 1);
            assertEquals("posted message notification must expose PUBLIC visibility", 1,
                publicVisibilityCount);
            web.showYuqiChat();
            web.waitForStructuredAssistantDom(seed.turnId, 3);
            JSONObject summary = new JSONObject(web.chatLandingStructuredSummary(seed.turnId, source));
            assertExactAssistantDom(summary, 3);
            assertEquals(1, summary.getJSONArray("source").length());
            assertEquals(TurnState.COMPLETED.name(), fixture.store.turn(seed.turnId).state);
            context.stopService(new Intent(context, AlExecutionService.class));
        }
    }

    @Test public void event_and_poll_same_group() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (YuqiV3ConnectedRaceFixture fixture = YuqiV3ConnectedRaceFixture.open(context)) {
            fixture.enableNotificationsForCase();
            String logicalId = "event-and-poll-same-group";
            String source = fixture.sourceMessageIdForCase(logicalId);
            try (YuqiV3WebViewHarness sourceWeb = YuqiV3WebViewHarness.launch()) {
                sourceWeb.waitForScriptValue("document.readyState", "\"complete\"");
                sourceWeb.resetCaseWebState("connected-native-completed-before-ui-open");
                sourceWeb.prepareCanonicalSourceMessage("yuqi", source, "事件与轮询");
            }
            YuqiV3ConnectedRaceFixture.CanonicalSeed seed;
            try (YuqiV3WebViewHarness web = YuqiV3WebViewHarness.launch()) {
                web.waitForScriptValue("document.readyState", "\"complete\"");
                web.waitForShippedUiReady();
                web.suspendProductionReconcilePollForTest();
                web.observeProductionReconcileCallsForTest();
                web.observeNativeBridgeAcknowledgeUiAppliedCallsForTest(
                    fixture.turnIdForCase(logicalId));
                seed = fixture.seedCanonicalVisible(logicalId);
                AlExecutionPlugin.notifyCompletedTurn(seed.turnId, System.currentTimeMillis());
                web.waitForProductionReconcileCallCount(1);
                waitForRoomUiApplied(fixture.store, seed.turnId);
                web.waitForNativeBridgeAcknowledgeUiAppliedCallCount(1);
                web.showYuqiChat();
                web.waitForStructuredAssistantDom(seed.turnId, 3);
                JSONObject first = new JSONObject(web.chatLandingStructuredSummary(seed.turnId, source));
                web.resumeProductionReconcilePollForTest();
                web.waitForProductionReconcileCallCount(2);
                assertEquals(1, web.nativeBridgeAcknowledgeUiAppliedCallCount());
                web.reload();
                web.waitForShippedUiReady();
                waitForRoomUiApplied(fixture.store, seed.turnId);
                web.waitForProductionUiApplied(seed.turnId);
                web.showYuqiChat();
                web.waitForStructuredAssistantDom(seed.turnId, 3);
                JSONObject second = new JSONObject(web.chatLandingStructuredSummary(seed.turnId, source));
                assertExactAssistantDom(first, 3);
                assertExactAssistantDom(second, 3);
                assertEquals(1, second.getJSONArray("source").length());
            }
            assertEquals(1L, fixture.store.getConversationCursor("yuqi").uiAppliedSequence);
            assertEquals(fixture.store.turn(seed.turnId).bridgeCommitChecksum,
                new RoomExecutionStore(fixture.database, "device-connected-race")
                    .turn(seed.turnId).bridgeCommitChecksum);
        }
    }

    @Test public void event_lost_poll_recovers() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (YuqiV3ConnectedRaceFixture fixture = YuqiV3ConnectedRaceFixture.open(context)) {
            String logicalId = "event-lost-poll-recovers";
            String source = fixture.sourceMessageIdForCase(logicalId);
            try (YuqiV3WebViewHarness sourceWeb = YuqiV3WebViewHarness.launch()) {
                sourceWeb.waitForScriptValue("document.readyState", "\"complete\"");
                sourceWeb.resetCaseWebState("connected-native-completed-before-ui-open");
                sourceWeb.prepareCanonicalSourceMessage("yuqi", source, "丢失事件");
            }
            YuqiV3ConnectedRaceFixture.CanonicalSeed seed = fixture.seedCanonicalVisible(logicalId);
            assertFalse(context.getSharedPreferences("al.execution.notifications", Context.MODE_PRIVATE)
                .getBoolean("turn." + seed.turnId, false));
            try (YuqiV3WebViewHarness web = YuqiV3WebViewHarness.launch()) {
                // No notifyCompletedTurn call: only the shipped reconciliation poll may apply it.
                waitForRoomUiApplied(fixture.store, seed.turnId);
                web.showYuqiChat();
                web.waitForStructuredAssistantDom(seed.turnId, 3);
                JSONObject summary = new JSONObject(web.chatLandingStructuredSummary(seed.turnId, source));
                assertExactAssistantDom(summary, 3);
                assertEquals(1, summary.getJSONArray("groups").length());
            }
            ConversationCursorEntity cursor = fixture.store.getConversationCursor("yuqi");
            assertEquals(seed.turnId, cursor.uiAppliedTurnId);
            assertEquals(1L, cursor.uiAppliedSequence);
        }
    }

    @Test public void plugin_promise_hangs_then_replay() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (YuqiV3ConnectedRaceFixture fixture = YuqiV3ConnectedRaceFixture.open(context)) {
            String logicalId = "plugin-promise-hangs-then-replay";
            String source = fixture.sourceMessageIdForCase(logicalId);
            YuqiV3ConnectedRaceFixture.CanonicalSeed seed;
            try (YuqiV3WebViewHarness web = YuqiV3WebViewHarness.launch()) {
                web.waitForScriptValue("document.readyState", "\"complete\"");
                web.resetCaseWebState("connected-native-completed-before-ui-open");
                web.prepareCanonicalSourceMessage("yuqi", source, "插件挂起");
                // Install the hold while the canonical result does not yet
                // exist; no boot poll can observe and apply this turn first.
                web.holdNextNativeBridgeUnappliedCompletedTurns();
                seed = fixture.seedCanonicalVisible(logicalId);
                web.startProductionReconcilePoll();
                web.waitForHeldNativeInboxUse();
                web.waitForHeldNativeInboxNativeSettled();
                JSONObject heldBeforeTimeout = new JSONObject(web.heldNativeInboxState());
                assertTrue(heldBeforeTimeout.getBoolean("used"));
                assertEquals(1, heldBeforeTimeout.getInt("nativeSettled"));
                assertEquals(0, heldBeforeTimeout.getInt("outerSettled"));
                ChatTurnEntity heldTurn = fixture.store.turn(seed.turnId);
                ConversationCursorEntity heldCursor = fixture.store.getConversationCursor("yuqi");
                assertNull(heldTurn.uiAppliedAt);
                assertEquals(0L, heldCursor.uiAppliedSequence);
                // This case drives the real production reconcile directly;
                // background poll/listener startup is not part of the held
                // Promise contract and may be stopped by the prior fixture.
                web.waitForShippedUiBootstrap();
                web.showYuqiChat();
                JSONObject heldSummary = new JSONObject(
                    web.chatLandingStructuredSummary(seed.turnId, source));
                assertExactAssistantDom(heldSummary, 0);
                web.waitForHeldNativeInboxTimeout();
                JSONObject timedOut = new JSONObject(web.heldNativeInboxState());
                assertTrue(timedOut.getBoolean("timedOut"));
                assertEquals(8000L, timedOut.getLong("timeoutMs"));
                long timeoutElapsed = timedOut.getLong("timedOutAt") - timedOut.getLong("startedAt");
                assertTrue("inner bridge timeout must be about 8s: " + timeoutElapsed,
                    timeoutElapsed >= 7600L && timeoutElapsed < 12000L);
                web.waitForScriptValue("nativeExecutionReconcilePromise===null", "true");
                JSONObject outerSettled = new JSONObject(web.heldNativeInboxState());
                long outerElapsed = outerSettled.getLong("outerSettledAt")
                    - outerSettled.getLong("startedAt");
                assertTrue("outer reconcile must settle within the 8-12s contract: " + outerElapsed,
                    outerElapsed >= 8000L && outerElapsed < 12000L);
                web.restoreHeldNativeBridgeCall();
                web.reload();
                web.waitForProductionUiApplied(seed.turnId);
                web.showYuqiChat();
                web.waitForStructuredAssistantDom(seed.turnId, 3);
                JSONObject replay = new JSONObject(web.chatLandingStructuredSummary(seed.turnId, source));
                assertExactAssistantDom(replay, 3);
                assertEquals(1L, fixture.store.getConversationCursor("yuqi").uiAppliedSequence);
            }
            assertEquals(3, fixture.store.replyParts(seed.turnId).size());
            assertEquals(1L, fixture.store.getConversationCursor("yuqi").uiAppliedSequence);
        }
    }

    @Test public void page_reload_before_ui_ack() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (YuqiV3ConnectedRaceFixture fixture = YuqiV3ConnectedRaceFixture.open(context)) {
            String logicalId = "page-reload-before-ui-ack";
            String source = fixture.sourceMessageIdForCase(logicalId);
            YuqiV3ConnectedRaceFixture.CanonicalSeed seed;
            try (YuqiV3WebViewHarness web = YuqiV3WebViewHarness.launch()) {
                boolean mirrorReleased = false;
                web.waitForScriptValue("document.readyState", "\"complete\"");
                web.resetCaseWebState("connected-native-completed-before-ui-open");
                web.prepareCanonicalSourceMessage("yuqi", source, "重载前确认");
                // The real inbox applies the DOM first and only then calls the
                // native acknowledgement.  Hold the singleton Room transaction
                // so the production ACK CAS is genuinely blocked; the Web seam
                // only observes the call and immediately forwards it.
                String expectedTurnId = fixture.turnIdForCase(logicalId);
                web.holdNextMemoryAppStateMirror();
                web.observeNextNativeBridgeAcknowledgeUiApplied(expectedTurnId);
                fixture.startRoomTransactionHold();
                seed = fixture.seedCanonicalVisible(logicalId);
                assertEquals(expectedTurnId, seed.turnId);
                ChatTurnEntity beforeHold = fixture.store.turn(seed.turnId);
                ConversationCursorEntity beforeHoldCursor = fixture.store.getConversationCursor("yuqi");
                assertNotNull(beforeHold);
                assertNull(beforeHold.uiAppliedAt);
                assertEquals(0L, beforeHoldCursor.uiAppliedSequence);
                fixture.activateRoomTransactionHold();
                try {
                    web.startProductionReconcilePoll();
                    web.waitForHeldMemoryAppStateUse();
                    web.waitForHeldMemoryAppStateNativeWrite();
                    JSONObject mirrorState = new JSONObject(web.heldMemoryAppStateState());
                    assertEquals(1, mirrorState.getInt("nativeWriteSettled"));
                    assertEquals(1, mirrorState.getInt("nativeWriteOk"));
                    assertEquals(0, mirrorState.getInt("outerSettled"));
                    assertEquals(0, new JSONObject(web.observedNativeAcknowledgementState()).getInt("forwarded"));
                    web.releaseHeldMemoryAppStateMirror();
                    mirrorReleased = true;
                    web.waitForObservedNativeAcknowledgementUse();
                    web.evaluate("currentCharId='yuqi';showScreen('chat');renderMessages({forceBottom:true});");
                    web.waitForStructuredAssistantDom(seed.turnId, 3);
                    JSONObject inserted = new JSONObject(
                        web.chatLandingStructuredSummary(seed.turnId, source));
                    assertExactAssistantDom(inserted, 3);
                    assertEquals(1, inserted.getJSONArray("groups").length());
                    assertEquals(3, inserted.getInt("dom"));
                    assertEquals(3, inserted.getInt("replyLinks"));
                    JSONObject observed = new JSONObject(web.observedNativeAcknowledgementState());
                    assertEquals(1, observed.getInt("forwarded"));
                    assertEquals(0, observed.getInt("nativeSettled"));
                    // Navigation is completed before releasing Room so the
                    // stale page cannot settle its blocked ACK in this context.
                    web.reloadDocumentForRoomAckRace();
                } finally {
                    if (!mirrorReleased) {
                        try { web.releaseHeldMemoryAppStateMirror(); } catch (Throwable ignored) { }
                    }
                    assertFalse("Room hold must end only by explicit release", fixture.roomTransactionHoldAutoTimedOut());
                    fixture.releaseRoomTransactionHold();
                }
                web.waitForReloadCursorHandshake();
                web.waitForProductionUiApplied(seed.turnId);
                web.evaluate("currentCharId='yuqi';showScreen('chat');renderMessages({forceBottom:true});");
                web.waitForStructuredAssistantDom(seed.turnId, 3);
                JSONObject mirrored = new JSONObject(web.memoryAppStateSummary(seed.turnId, source));
                JSONArray mirroredIds = mirrored.getJSONArray("assistantIds");
                List<String> expectedMirroredIds = new ArrayList<>();
                for (int ordinal = 0; ordinal < 3; ordinal += 1) {
                    expectedMirroredIds.add("native_" + seed.turnId + "_"
                        + AuthorityIdentity.messageId(seed.result.visibleGroupId, ordinal) + "_0");
                }
                Collections.sort(expectedMirroredIds);
                List<String> actualMirroredIds = new ArrayList<>();
                for (int i = 0; i < mirroredIds.length(); i += 1) {
                    actualMirroredIds.add(mirroredIds.getString(i));
                }
                Collections.sort(actualMirroredIds);
                assertEquals("MemoryDB app_state assistant IDs must be exact", expectedMirroredIds,
                    actualMirroredIds);
                assertEquals(1, mirrored.getJSONArray("sourceIds").length());
                assertEquals(source, mirrored.getJSONArray("sourceIds").getString(0));
                assertTrue("durable mirror updatedAt must not lag local state",
                    mirrored.getLong("updatedAt") >= mirrored.getLong("localUpdatedAt"));
                JSONObject replay = new JSONObject(
                    web.chatLandingStructuredSummary(seed.turnId, source));
                assertExactAssistantDom(replay, 3);
                assertEquals(1, replay.getJSONArray("groups").length());
                assertEquals(3, replay.getInt("dom"));
                assertEquals(3, replay.getInt("replyLinks"));
                for (int ordinal = 0; ordinal < 3; ordinal += 1) {
                    JSONObject message = replay.getJSONArray("assistant").getJSONObject(ordinal);
                    assertEquals(AuthorityIdentity.messageId(seed.result.visibleGroupId, ordinal),
                        message.getString("sourceReplyPartId"));
                    assertEquals("native:" + seed.turnId, message.getString("sourceTurnId"));
                    assertEquals(source, message.getString("replyToMessageId"));
                    assertEquals(0, message.getJSONArray("actions").length());
                }
            }
            ChatTurnEntity first = fixture.store.turn(seed.turnId);
            ConversationCursorEntity firstCursor = fixture.store.getConversationCursor("yuqi");
            assertNotNull(first.uiAppliedAt);
            assertEquals(1L, firstCursor.uiAppliedSequence);
            String parts = canonicalReplyPartsSnapshot(fixture.store.replyParts(seed.turnId));
            RoomExecutionStore reopened = new RoomExecutionStore(fixture.database, "device-connected-race");
            assertEquals(parts, canonicalReplyPartsSnapshot(reopened.replyParts(seed.turnId)));
            assertReceiptTupleUnchanged(first, firstCursor, reopened.turn(seed.turnId),
                reopened.getConversationCursor("yuqi"));
        }
    }

    @Test public void ambiguous_remote_timeout_never_falls_back() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (YuqiV3ConnectedRaceFixture fixture = YuqiV3ConnectedRaceFixture.open(context)) {
            fixture.setLoopbackMode(YuqiV3ConnectedRaceFixture.LoopbackMode.HOLD_THEN_CLOSE);
            fixture.saveLoopbackBridgeConfig();
            ChatTurnEntity submitted = fixture.submitDirectTurn("ambiguous-remote-timeout");
            AtomicReference<Throwable> workerFailure = new AtomicReference<>();
            Thread worker = new Thread(() -> {
                try {
                    ExecutionRuntime.create(context).runNext();
                } catch (Throwable error) {
                    workerFailure.set(error);
                }
            }, "connected-ambiguous-timeout");
            worker.start();
            YuqiV3ConnectedRaceFixture.RequestRecord request =
                fixture.awaitLoopbackAccepted(20_000L);
            assertEquals("POST", request.method);
            assertEquals("/v2/turns", request.path);
            assertTrue(request.body != null && request.body.contains("\"turnId\""));
            assertEquals(1, fixture.loopbackRequestCountForPath("/v2/turns"));
            // The request is accepted, but no response bytes are released.
            // Wait past the real BridgeConfig read timeout, then close the
            // held socket and join the production worker.
            fixture.awaitTransportTimeout(request, 3_500L);
            fixture.closeLoopbackRequest(request);
            worker.join(15_000L);
            assertFalse("production runtime worker must finish", worker.isAlive());
            assertNull(workerFailure.get());
            ChatTurnEntity after = fixture.store.turn(submitted.turnId);
            assertNotNull(after);
            assertEquals(TurnState.FAILED_RETRYABLE.name(), after.state);
            assertTrue(fixture.store.replyParts(submitted.turnId).isEmpty());
            assertEquals("BRIDGE_PENDING",
                fixture.store.activeAttempt(submitted.turnId).errorCode);
            assertNull(after.visibleGroupId);
            assertNull(after.authorityOrigin);
            assertEquals(0, fixture.pendingRecoveryPacket().getJSONArray("entries").length());
            // A later production retry uses the same authoritative turn and
            // checkpoint.  The PC response is now released as a canonical V3
            // result; this is the exact recovery path, not a local fallback.
            fixture.store.startRetry(submitted.turnId, System.currentTimeMillis());
            fixture.setLoopbackMode(YuqiV3ConnectedRaceFixture.LoopbackMode.RECOVERY_CANONICAL);
            AtomicReference<Throwable> recoveryFailure = new AtomicReference<>();
            Thread recoveryWorker = new Thread(() -> {
                try { ExecutionRuntime.create(context).runNext(); }
                catch (Throwable error) { recoveryFailure.set(error); }
            }, "connected-ambiguous-timeout-recovery");
            recoveryWorker.start();
            YuqiV3ConnectedRaceFixture.RequestRecord recoveryRequest =
                fixture.awaitLoopbackRequestCount(2, 20_000L);
            assertEquals("POST", recoveryRequest.method);
            assertEquals("/v2/turns", recoveryRequest.path);
            assertTrue("recovery must target the submitted local turn: " + recoveryRequest.body,
                recoveryRequest.body != null && recoveryRequest.body.contains(submitted.turnId));
            recoveryWorker.join(15_000L);
            assertFalse(recoveryWorker.isAlive());
            assertNull(recoveryFailure.get());
            assertTrue("recovery response must be canonical terminal: " + recoveryRequest.responseBody,
                recoveryRequest.responseBody != null && recoveryRequest.responseBody.contains("\"terminal\":true"));
            ChatTurnEntity recovered = fixture.store.turn(submitted.turnId);
            assertEquals("recovery state=" + recovered.state + " error="
                    + fixture.store.activeAttempt(submitted.turnId).errorCode + " detail="
                    + fixture.store.activeAttempt(submitted.turnId).errorDetail,
                TurnState.COMPLETED.name(), recovered.state);
            assertEquals("pc", recovered.authorityOrigin);
            assertNotNull(recovered.visibleGroupId);
            assertEquals(3, fixture.store.replyParts(submitted.turnId).size());
            assertEquals(2, fixture.loopbackRequestCountForPath("/v2/turns"));
            RoomExecutionStore reopened = new RoomExecutionStore(fixture.database,
                "device-connected-race");
            assertEquals(TurnState.COMPLETED.name(), reopened.turn(submitted.turnId).state);
            assertEquals(recovered.bridgeCommitChecksum,
                reopened.turn(submitted.turnId).bridgeCommitChecksum);
            assertEquals(recovered.visibleGroupId, reopened.turn(submitted.turnId).visibleGroupId);
            assertEquals(3, reopened.replyParts(submitted.turnId).size());
        }
    }

    @Test public void android_fallback_receipt_syncs_without_pc_redelivery() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (YuqiV3ConnectedRaceFixture fixture = YuqiV3ConnectedRaceFixture.open(context)) {
            String logicalId = "android-fallback-receipt";
            String turnId = fixture.turnIdForCase(logicalId);
            String source = "msg-connected-fallback-" + turnId;
            try (YuqiV3WebViewHarness sourceWeb = YuqiV3WebViewHarness.launch()) {
                sourceWeb.waitForScriptValue("document.readyState", "\"complete\"");
                sourceWeb.resetCaseWebState("android-fallback-receipt-syncs-without-pc-redelivery");
                sourceWeb.prepareCanonicalSourceMessage("yuqi", source, "本地回退");
            }
            YuqiV3ConnectedRaceFixture.FallbackSeed seed = fixture.seedAndroidFallbackVisible(logicalId);
            ChatTurnEntity committed = fixture.store.turn(seed.turnId);
            assertEquals("android_fallback", committed.authorityOrigin);
            JSONObject beforeRecovery = fixture.pendingRecoveryPacket();
            JSONArray beforeEntries = beforeRecovery.getJSONArray("entries");
            assertTrue(beforeEntries.length() >= 1);
            JSONObject receiptEntry = null;
            int authorityReceiptCount = 0;
            for (int index = 0; index < beforeEntries.length(); index += 1) {
                JSONObject candidate = beforeEntries.getJSONObject(index);
                if ("authority_receipt".equals(candidate.optString("entityType"))) {
                    authorityReceiptCount += 1;
                    receiptEntry = candidate;
                }
            }
            assertEquals(1, authorityReceiptCount);
            assertNotNull(receiptEntry);
            assertEquals(seed.visibleGroupId, receiptEntry.getString("entityId"));

            fixture.setLoopbackMode(YuqiV3ConnectedRaceFixture.LoopbackMode.RECOVERY_ACK);
            fixture.saveLoopbackBridgeConfig();
            ChatTurnEntity probe = fixture.submitDirectTurn("android-fallback-recovery-probe");
            AtomicReference<Throwable> probeFailure = new AtomicReference<>();
            Thread probeWorker = new Thread(() -> {
                try { ExecutionRuntime.create(context).runNext(); }
                catch (Throwable error) { probeFailure.set(error); }
            }, "connected-fallback-recovery-probe");
            probeWorker.start();
            YuqiV3ConnectedRaceFixture.RequestRecord recoveryRequest;
            try {
                recoveryRequest = fixture.awaitLoopbackAccepted(20_000L);
            } catch (AssertionError barrier) {
                probeWorker.join(15_000L);
                ChatTurnEntity diagnosticTurn = fixture.store.turn(probe.turnId);
                ExecutionAttemptEntity diagnosticAttempt = fixture.store.activeAttempt(probe.turnId);
                ConversationCursorEntity diagnosticCursor = fixture.store.getConversationCursor("yuqi");
                String checkpointSummary;
                try {
                    JSONObject checkpoint = diagnosticAttempt == null
                        ? null : new JSONObject(diagnosticAttempt.bridgeAuthorityCheckpointJson);
                    checkpointSummary = checkpoint == null ? "null"
                        : "version=" + checkpoint.optInt("version", -1)
                            + ",lineage=" + checkpoint.optString("authorityLineageKey", "")
                            + ",anchor=" + checkpoint.optString("cursorAnchorMessageId", "")
                            + ",fallback=" + checkpoint.optBoolean("fallbackExecution", false)
                            + ",normalizedEnvelope=" + checkpoint.has("normalizedEnvelope")
                            + ",outcome=" + checkpoint.has("outcome");
                } catch (Exception parseError) {
                    checkpointSummary = "parseError=" + parseError.getClass().getSimpleName();
                }
                throw new AssertionError("fallback probe did not reach loopback: requests="
                    + fixture.loopbackRequestCountForPath("/v2/turns")
                    + " workerAlive=" + probeWorker.isAlive()
                    + " workerFailure=" + probeFailure.get()
                    + " state=" + (diagnosticTurn == null ? "null" : diagnosticTurn.state)
                    + " attempt=" + (diagnosticAttempt == null ? "null" : diagnosticAttempt.errorCode)
                    + " detail=" + (diagnosticAttempt == null ? "null" : diagnosticAttempt.errorDetail)
                    + " checkpoint=" + checkpointSummary
                    + " cursor=" + (diagnosticCursor == null ? "null" :
                        "nativeSeq=" + diagnosticCursor.nativeCompletedSequence
                            + ",uiSeq=" + diagnosticCursor.uiAppliedSequence
                            + ",nativeTurn=" + diagnosticCursor.nativeCompletedTurnId
                            + ",nativeGroup=" + diagnosticCursor.nativeCompletedGroupId
                            + ",uiTurn=" + diagnosticCursor.uiAppliedTurnId
                            + ",uiGroup=" + diagnosticCursor.uiAppliedGroupId),
                    barrier);
            }
            assertEquals("POST", recoveryRequest.method);
            assertEquals("/v2/turns", recoveryRequest.path);
            JSONObject recoveryWire = new JSONObject(recoveryRequest.body);
            assertFalse(seed.turnId.equals(recoveryWire.getString("turnId")));
            JSONArray sentEntries = recoveryWire.getJSONObject("recovery").getJSONArray("entries");
            assertTrue(sentEntries.length() >= 1);
            int sentAuthorityReceiptCount = 0;
            JSONObject sentReceipt = null;
            for (int index = 0; index < sentEntries.length(); index += 1) {
                JSONObject candidate = sentEntries.getJSONObject(index);
                if ("authority_receipt".equals(candidate.optString("entityType"))) {
                    sentAuthorityReceiptCount += 1;
                    sentReceipt = candidate;
                }
            }
            assertEquals(1, sentAuthorityReceiptCount);
            assertNotNull(sentReceipt);
            assertEquals(seed.visibleGroupId, sentReceipt.getString("entityId"));
            assertEquals(receiptEntry.getString("checksum"), sentReceipt.getString("checksum"));
            probeWorker.join(15_000L);
            assertFalse(probeWorker.isAlive());
            assertNull(probeFailure.get());
            JSONObject recoveryAck = new JSONObject(recoveryRequest.responseBody);
            assertTrue(recoveryAck.getLong("recoveryAckSeq") > 0L);
            assertEquals(TurnState.FAILED_FINAL.name(), fixture.store.turn(probe.turnId).state);
            assertEquals("YUQI_DETERMINISTIC_EXECUTION_FAILURE",
                fixture.store.activeAttempt(probe.turnId).errorCode);
            JSONObject pendingAfterAck = fixture.pendingRecoveryPacket();
            assertEquals("pending after ACK=" + pendingAfterAck.toString()
                    + " response=" + recoveryAck.toString(),
                0, pendingAfterAck.getJSONArray("entries").length());
            assertEquals(1, fixture.loopbackRequestCountForPath("/v2/turns"));

            // Rebuild both store and runtime after the ACK. A second legal
            // probe must still cross the production LAN path, but its recovery
            // section must be empty: the completed fallback turn is never
            // resubmitted or redelivered to PC.
            RoomExecutionStore reopenedAfterAck = new RoomExecutionStore(
                fixture.database, "device-connected-race");
            ChatTurnEntity secondProbe = reopenedAfterAck.submitTurn(
                fixture.directSubmissionForCase("android-fallback-recovery-probe-2"));
            AtomicReference<Throwable> secondProbeFailure = new AtomicReference<>();
            Thread secondProbeWorker = new Thread(() -> {
                try { ExecutionRuntime.create(context).runNext(); }
                catch (Throwable error) { secondProbeFailure.set(error); }
            }, "connected-fallback-recovery-probe-2");
            secondProbeWorker.start();
            YuqiV3ConnectedRaceFixture.RequestRecord secondRecoveryRequest =
                fixture.awaitLoopbackRequestCount(2, 20_000L);
            JSONObject secondRecoveryWire = new JSONObject(secondRecoveryRequest.body);
            assertFalse(seed.turnId.equals(secondRecoveryWire.getString("turnId")));
            assertEquals(0, secondRecoveryWire.getJSONObject("recovery")
                .getJSONArray("entries").length());
            secondProbeWorker.join(15_000L);
            assertFalse(secondProbeWorker.isAlive());
            assertNull(secondProbeFailure.get());
            assertEquals(TurnState.FAILED_FINAL.name(),
                reopenedAfterAck.turn(secondProbe.turnId).state);
            assertEquals(0, authorityReceiptCount(
                fixture.pendingRecoveryPacket(), seed.visibleGroupId));
            assertEquals(2, fixture.loopbackRequestCountForPath("/v2/turns"));

            ChatTurnEntity receiptBeforeReopen = null;
            ConversationCursorEntity cursorBeforeReopen = null;
            String partsBeforeReopen = null;
            try (YuqiV3WebViewHarness web = YuqiV3WebViewHarness.launch()) {
                web.waitForShippedUiReady();
                web.waitForProductionUiApplied(seed.turnId);
                web.showYuqiChat();
                JSONObject summary = new JSONObject(web.chatLandingStructuredSummary(seed.turnId, source));
                assertExactFallbackSummary(summary, seed, source);
                assertEquals(1, summary.getJSONArray("groups").length());
                assertEquals(1, summary.getInt("dom"));
                assertEquals(1, summary.getInt("replyLinks"));
                ChatTurnEntity beforeReload = fixture.store.turn(seed.turnId);
                ConversationCursorEntity beforeReloadCursor = fixture.store.getConversationCursor("yuqi");
                web.reload();
                web.showYuqiChat();
                web.waitForProductionUiApplied(seed.turnId);
                JSONObject replay = new JSONObject(web.chatLandingStructuredSummary(seed.turnId, source));
                assertExactFallbackSummary(replay, seed, source);
                assertEquals(1, replay.getJSONArray("groups").length());
                assertEquals(1, replay.getInt("dom"));
                assertEquals(1, replay.getInt("replyLinks"));
                assertReceiptTupleUnchanged(beforeReload, beforeReloadCursor,
                    fixture.store.turn(seed.turnId), fixture.store.getConversationCursor("yuqi"));
                receiptBeforeReopen = fixture.store.turn(seed.turnId);
                cursorBeforeReopen = fixture.store.getConversationCursor("yuqi");
                partsBeforeReopen = canonicalReplyPartsSnapshot(fixture.store.replyParts(seed.turnId));
            }
            assertNotNull(receiptBeforeReopen);
            assertNotNull(cursorBeforeReopen);
            assertNotNull(partsBeforeReopen);
            RoomExecutionStore reopened = new RoomExecutionStore(fixture.database, "device-connected-race");
            assertReceiptTupleUnchanged(receiptBeforeReopen, cursorBeforeReopen,
                reopened.turn(seed.turnId), reopened.getConversationCursor("yuqi"));
            assertEquals(partsBeforeReopen, canonicalReplyPartsSnapshot(reopened.replyParts(seed.turnId)));
            JSONObject reopenedPending = new FallbackJournal(
                fixture.database.executionDao(), "device-connected-race").pendingPacket(1000);
            assertEquals("reopened pending fallback receipt=" + reopenedPending, 0,
                authorityReceiptCount(reopenedPending, seed.visibleGroupId));
            assertEquals(2, fixture.loopbackRequestCountForPath("/v2/turns"));
        }
    }

    private static int authorityReceiptCount(JSONObject packet, String groupId) throws Exception {
        int count = 0;
        JSONArray entries = packet.getJSONArray("entries");
        for (int index = 0; index < entries.length(); index += 1) {
            JSONObject entry = entries.getJSONObject(index);
            if ("authority_receipt".equals(entry.optString("entityType"))
                && (groupId == null || groupId.equals(entry.optString("entityId")))) {
                count += 1;
            }
        }
        return count;
    }

    @Test public void conversation_clear_while_result_in_flight() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (YuqiV3ConnectedRaceFixture fixture = YuqiV3ConnectedRaceFixture.open(context);
             YuqiV3WebViewHarness web = YuqiV3WebViewHarness.launch()) {
            String logicalId = "conversation-clear-in-flight";
            String source = fixture.sourceMessageIdForCase(logicalId);
            fixture.enableNotificationsForCase();
            web.waitForShippedUiBootstrap();
            web.resetCaseWebState(logicalId);
            web.waitForShippedUiReady();
            fixture.setLoopbackMode(YuqiV3ConnectedRaceFixture.LoopbackMode.HOLD_THEN_CANONICAL);
            fixture.saveLoopbackBridgeConfig();
            ChatTurnEntity submitted = fixture.submitDirectTurn(logicalId);
            AtomicReference<Throwable> workerFailure = new AtomicReference<>();
            Thread worker = new Thread(() -> {
                try { ExecutionRuntime.create(context).runNext(); }
                catch (Throwable error) { workerFailure.set(error); }
            }, "connected-conversation-clear-in-flight");
            worker.start();
            YuqiV3ConnectedRaceFixture.RequestRecord request =
                fixture.awaitLoopbackAccepted(20_000L);
            assertEquals("POST", request.method);
            assertEquals("/v2/turns", request.path);
            assertTrue(request.body.contains(submitted.turnId));
            assertEquals(1, fixture.loopbackRequestCountForPath("/v2/turns"));

            ConversationCursorEntity before = fixture.store.getConversationCursor("yuqi");
            assertEquals(0L, before.clearEpoch);
            // A second store/connection performs the clear, but the clear
            // authority must retain the persisted checkpoint's store-owned peer.
            AlExecutionDatabase clearDatabase = Room.databaseBuilder(
                context, AlExecutionDatabase.class, "al-execution.db")
                .allowMainThreadQueries().build();
            RoomExecutionStore clearStore = new RoomExecutionStore(
                clearDatabase, "device-connected-race");
            ChatTurnEntity cancelled = null;
            ExecutionAttemptEntity cancelledAttempt = null;
            LifecycleControl control = null;
            try {
                control = clearStore.createConversationClear(
                    "yuqi", RoomExecutionStore.conversationCursorChecksum("yuqi", before));
                assertNotNull(control);
                assertEquals(LifecycleControl.WAITING, control.state);
                ConversationCursorEntity after = clearStore.getConversationCursor("yuqi");
                assertTrue(after.clearEpoch > before.clearEpoch);
                ChatTurnEntity inFlight = clearStore.turn(submitted.turnId);
                assertNotNull(inFlight);
                assertNotNull(inFlight.inputVisibilitySequence);
                assertTrue(after.clearedThroughSequence >= inFlight.inputVisibilitySequence);
                cancelled = clearStore.turn(submitted.turnId);
                assertNotNull(cancelled);
                assertEquals(TurnState.COMPLETED.name(), cancelled.state);
                assertNotNull(cancelled.deletedAt);
                cancelledAttempt = clearStore.activeAttempt(submitted.turnId);
                assertNotNull(cancelledAttempt);
                assertEquals(AttemptStage.FINISHED.name(), cancelledAttempt.stage);
                assertEquals(TurnState.COMPLETED.name(), cancelledAttempt.state);
                assertNull(cancelledAttempt.memoryResult);
                assertNull(cancelledAttempt.rawReply);
                assertEquals("{}", cancelled.inputJson);
                assertEquals("{}", cancelled.snapshotJson);
                assertTrue(clearStore.replyParts(submitted.turnId).isEmpty());
                ConversationAuthorityEntity authority = clearDatabase.executionDao()
                    .conversationAuthority(cancelled.authorityLineageKey);
                assertNotNull(authority);
                assertEquals("CANCELLED", authority.state);
                assertEquals(cancelled.turnId, authority.latestTurnId);
                assertNull(cancelled.visibleGroupId);
                assertNull(cancelled.bridgeCommitChecksum);
            } finally {
                clearDatabase.close();
            }
            assertNotNull(cancelled);
            assertNotNull(cancelledAttempt);
            assertNotNull(control);

            fixture.releaseLoopbackResponse(request);
            worker.join(15_000L);
            assertFalse(worker.isAlive());
            assertNull(workerFailure.get());
            assertEquals(1, fixture.loopbackRequestCountForPath("/v2/turns"));
            assertTrue(request.responseBody != null && request.responseBody.contains("\"terminal\":true"));
            JSONObject tombstone = new JSONObject(cancelledAttempt.bridgeAuthorityCheckpointJson);
            JSONObject outcome = tombstone.getJSONObject("outcome");
            assertEquals("redacted", outcome.getString("type"));
            assertEquals("conversation-clear-redacted-v1",
                outcome.getJSONObject("result").getString("contract"));
            assertEquals(control.controlId, outcome.getJSONObject("result").getString("controlId"));
            AlExecutionDatabase reopenedDatabase = Room.databaseBuilder(
                context, AlExecutionDatabase.class, "al-execution.db")
                .allowMainThreadQueries().build();
            try {
                RoomExecutionStore reopened = new RoomExecutionStore(
                    reopenedDatabase, "device-connected-race");
                assertEquals(TurnState.COMPLETED.name(), reopened.turn(submitted.turnId).state);
                assertEquals(0, reopened.replyParts(submitted.turnId).size());
                assertEquals("CANCELLED", reopenedDatabase.executionDao()
                    .conversationAuthority(cancelled.authorityLineageKey).state);
                assertTrue(reopenedDatabase.executionDao().recentRawMessages("yuqi", 200).stream()
                    .noneMatch(message -> submitted.turnId.equals(message.turnId)));
                assertEquals(0, reopened.latestDiagnostics(200).stream()
                    .filter(diagnostic -> submitted.turnId.equals(diagnostic.turnId)).count());
                assertEquals(0, fixture.loopbackRequestCountForPath("/ack"));
            } finally {
                reopenedDatabase.close();
            }
            // The clear wins before any Room/UI commit.  Exercise the shipped
            // WebView after the late result and prove it has no durable or DOM
            // projection, no UI watermark/ACK, and no notification side effect.
            web.startProductionReconcilePoll();
            web.waitForScriptValue("typeof window.__yuqiConnectedReconcileResult!=='undefined'", "true");
            web.waitForShippedUiBootstrap();
            web.showYuqiChat();
            JSONObject summary = new JSONObject(web.chatLandingStructuredSummary(
                submitted.turnId, source));
            assertExactAssistantDom(summary, 0);
            assertEquals(0, summary.getJSONArray("groups").length());
            assertEquals(0, summary.getInt("replyLinks"));
            assertEquals(0, summary.getJSONArray("source").length());
            assertNullCursorShape(new JSONObject(web.waitForConversationCursor("yuqi")));
            assertNoActiveNotification(context, submitted.turnId);
        }
    }

    @Test public void role_delete_pending_suppresses_late_lan_result() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (YuqiV3ConnectedRaceFixture fixture = YuqiV3ConnectedRaceFixture.open(context);
             YuqiV3WebViewHarness web = YuqiV3WebViewHarness.launch()) {
            final String logicalId = "role-delete-pending-lan";
            final String turnId = fixture.turnIdForCase(logicalId);
            final String source = fixture.sourceMessageIdForCase(logicalId);
            fixture.enableNotificationsForCase();
            web.waitForShippedUiBootstrap();
            web.resetCaseWebState(logicalId);
            web.waitForShippedUiReady();
            fixture.saveLoopbackBridgeConfig();
            fixture.setLoopbackMode(YuqiV3ConnectedRaceFixture.LoopbackMode.HOLD_THEN_CANONICAL);
            fixture.submitDirectTurn(logicalId);
            AtomicReference<Throwable> workerFailure = new AtomicReference<>();
            AtomicReference<RoomExecutionStore.DeliveryDisposition> disposition = new AtomicReference<>();
            RoomExecutionStore.setTestDeliveryDispositionObserver(disposition::set);
            try {
            Thread worker = new Thread(() -> {
                try {
                    assertTrue(ExecutionRuntime.create(context).runNext());
                } catch (Throwable failure) {
                    workerFailure.set(failure);
                }
            }, "yuqi-connected-role-delete-late-lan");
            worker.start();
            YuqiV3ConnectedRaceFixture.RequestRecord request =
                fixture.awaitLoopbackAccepted(15_000L);
            assertEquals("POST", request.method);
            assertEquals("/v2/turns", request.path);
            assertTrue(request.body.contains(turnId));
            RoomExecutionStore deleter = new RoomExecutionStore(fixture.database, "device-connected-race");
            ConversationCursorEntity cursor = deleter.getConversationCursor("yuqi");
            LifecycleControl control = deleter.createRoleDelete(
                "yuqi", RoomExecutionStore.conversationCursorChecksum("yuqi", cursor),
                YuqiV3ConnectedRaceFixture.backupReceipt("yuqi", System.currentTimeMillis()), null);
            assertNotNull(control);
            assertNull(new RoomExecutionStore(fixture.database, "device-connected-race").turn(turnId));
            fixture.releaseLoopbackResponse(request);
            worker.join(15_000L);
            assertFalse(worker.isAlive());
            assertNull(workerFailure.get());
            assertEquals(RoomExecutionStore.DeliveryDisposition.REDACTED, disposition.get());
            assertEquals(1, fixture.loopbackRequestCountForPath("/v2/turns"));
            assertEquals(0, fixture.pendingRecoveryPacket().getJSONArray("entries").length());
            assertNoLateSemanticSideEffects(fixture, turnId);
            assertTrue(fixture.database.executionDao().completedTurns().stream()
                .noneMatch(t -> turnId.equals(t.turnId)));
            assertNotNull(deleter.roleDeleteControl("yuqi"));
            web.startProductionReconcilePoll();
            web.waitForScriptValue("typeof window.__yuqiConnectedReconcileResult!=='undefined'", "true");
            web.waitForShippedUiBootstrap();
            web.showYuqiChat();
            JSONObject summary = new JSONObject(web.chatLandingStructuredSummary(turnId, source));
            assertExactAssistantDom(summary, 0);
            assertEquals(0, summary.getJSONArray("groups").length());
            assertEquals(0, summary.getInt("replyLinks"));
            assertEquals(0, summary.getJSONArray("source").length());
            assertNullCursorShape(new JSONObject(web.waitForConversationCursor("yuqi")));
            assertNoActiveNotification(context, turnId);
            } finally {
                RoomExecutionStore.setTestDeliveryDispositionObserver(null);
            }
        }
        // The same authenticated LAN race must consume a strictly parsed
        // v3 VERIFIED_REMOTE_FAILURE without requiring the deleted turn.
        try (YuqiV3ConnectedRaceFixture fixture = YuqiV3ConnectedRaceFixture.open(context);
             YuqiV3WebViewHarness web = YuqiV3WebViewHarness.launch()) {
            final String logicalId = "role-delete-pending-lan-failure";
            final String turnId = fixture.turnIdForCase(logicalId);
            final String source = fixture.sourceMessageIdForCase(logicalId);
            fixture.enableNotificationsForCase();
            web.waitForShippedUiBootstrap();
            web.resetCaseWebState(logicalId);
            web.waitForShippedUiReady();
            fixture.saveLoopbackBridgeConfig();
            fixture.setLoopbackMode(YuqiV3ConnectedRaceFixture.LoopbackMode.HOLD_THEN_FAILURE);
            fixture.submitDirectTurn(logicalId);
            AtomicReference<Throwable> workerFailure = new AtomicReference<>();
            AtomicReference<RoomExecutionStore.DeliveryDisposition> disposition = new AtomicReference<>();
            RoomExecutionStore.setTestDeliveryDispositionObserver(disposition::set);
            try {
            Thread worker = new Thread(() -> {
                try {
                    assertTrue(ExecutionRuntime.create(context).runNext());
                } catch (Throwable failure) {
                    workerFailure.set(failure);
                }
            }, "yuqi-connected-role-delete-late-lan-failure");
            worker.start();
            YuqiV3ConnectedRaceFixture.RequestRecord request =
                fixture.awaitLoopbackAccepted(15_000L);
            assertEquals("POST", request.method);
            assertEquals("/v2/turns", request.path);
            RoomExecutionStore deleter = new RoomExecutionStore(fixture.database, "device-connected-race");
            ConversationCursorEntity cursor = deleter.getConversationCursor("yuqi");
            assertNotNull(deleter.createRoleDelete(
                "yuqi", RoomExecutionStore.conversationCursorChecksum("yuqi", cursor),
                YuqiV3ConnectedRaceFixture.backupReceipt("yuqi", System.currentTimeMillis()), null));
            fixture.releaseLoopbackResponse(request);
            worker.join(15_000L);
            assertFalse(worker.isAlive());
            assertNull(workerFailure.get());
            assertEquals(RoomExecutionStore.DeliveryDisposition.REDACTED, disposition.get());
            assertNull(deleter.turn(turnId));
            assertEquals(0, fixture.pendingRecoveryPacket().getJSONArray("entries").length());
            assertNoLateSemanticSideEffects(fixture, turnId);
            assertNotNull(deleter.roleDeleteControl("yuqi"));
            web.startProductionReconcilePoll();
            web.waitForScriptValue("typeof window.__yuqiConnectedReconcileResult!=='undefined'", "true");
            web.waitForShippedUiBootstrap();
            web.showYuqiChat();
            JSONObject summary = new JSONObject(web.chatLandingStructuredSummary(turnId, source));
            assertExactAssistantDom(summary, 0);
            assertEquals(0, summary.getJSONArray("groups").length());
            assertEquals(0, summary.getInt("replyLinks"));
            assertEquals(0, summary.getJSONArray("source").length());
            assertNullCursorShape(new JSONObject(web.waitForConversationCursor("yuqi")));
            assertNoActiveNotification(context, turnId);
            } finally {
                RoomExecutionStore.setTestDeliveryDispositionObserver(null);
            }
        }
    }

    @Test public void role_delete_applied_acks_late_cloud_without_semantic_write() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (YuqiV3ConnectedRaceFixture fixture = YuqiV3ConnectedRaceFixture.open(context);
             YuqiV3WebViewHarness web = YuqiV3WebViewHarness.launch()) {
            String logicalId = "role-delete-applied-cloud";
            String source = fixture.sourceMessageIdForCase(logicalId);
            fixture.enableNotificationsForCase();
            web.waitForShippedUiBootstrap();
            web.resetCaseWebState(logicalId);
            YuqiV3ConnectedRaceFixture.CanonicalSeed seed = fixture.seedCanonicalVisible(logicalId);
            fixture.store.markUiApplied("yuqi", seed.turnId, seed.result.visibleGroupId, 1L,
                System.currentTimeMillis());
            RoomExecutionStore deleter = new RoomExecutionStore(fixture.database, "device-connected-race");
            ConversationCursorEntity cursor = deleter.getConversationCursor("yuqi");
            LifecycleControl control = deleter.createRoleDelete(
                "yuqi", RoomExecutionStore.conversationCursorChecksum("yuqi", cursor),
                YuqiV3ConnectedRaceFixture.backupReceipt("yuqi", System.currentTimeMillis()), null);
            assertNotNull(control);
            LifecycleControl claimed = deleter.claimLifecycleControl(System.currentTimeMillis());
            assertNotNull("role delete must be claimed before apply", claimed);
            assertEquals(control.controlId, claimed.controlId);
            assertTrue("role delete apply must use the exact lease",
                deleter.applyLifecycleControl(
                    claimed.controlId, claimed.semanticChecksum,
                    claimed.clearEpoch, claimed.clearedThroughSequence,
                    claimed.leaseId, claimed.leaseAttempt, claimed.leasedAt,
                    System.currentTimeMillis(), System.currentTimeMillis()));
            control = deleter.roleDeleteControl("yuqi");
            assertNotNull(control);
            assertEquals(LifecycleControl.APPLIED, control.state);
            // Clear the Web durable mirror immediately after the retained
            // tombstone wins, before admitting the late cloud delivery.
            web.resetCaseWebState(logicalId);
            web.waitForShippedUiReady();
            BridgeConfig cloudConfig = CloudInboxTestHarness.cloudConfig("device-connected-race");
            new AlSecretStore(context).saveBridgeConfig(cloudConfig);
            AtomicInteger persistCalls = new AtomicInteger();
            JSONObject lateCloud = seed.result.authorityPayload();
            CloudInboxTestHarness.Envelope envelope =
                CloudInboxTestHarness.encryptEnvelope(cloudConfig, "relay-role-delete-late-cloud", lateCloud);
            CloudInboxTestHarness.ScriptedCloudTransport transport =
                new CloudInboxTestHarness.ScriptedCloudTransport(cloudConfig)
                    .pollBatch(envelope.json)
                    .failNextAck();
            try {
                CloudInboxTestHarness.drainOnce(context, transport, persistCalls);
                throw new AssertionError("first ACK failure must remain observable");
            } catch (BridgePendingException expectedAckLoss) {
                // Persist may have completed before the transport ACK was lost.
            }
            assertEquals(1, transport.ackAttempts());
            assertCloudAckBody(transport.ackBodies().get(0), "device-connected-race",
                "relay-role-delete-late-cloud");
            assertEquals(0, transport.successfulAcks());
            assertEquals(1, persistCalls.get());
            transport.pollBatch(envelope.json);
            assertEquals(1, CloudInboxTestHarness.drainOnce(
                context, transport, persistCalls));
            assertEquals(2, transport.ackAttempts());
            assertCloudAckBody(transport.ackBodies().get(1), "device-connected-race",
                "relay-role-delete-late-cloud");
            assertEquals(1, transport.successfulAcks());
            assertEquals(2, persistCalls.get());
            assertNull(deleter.turn(seed.turnId));
            assertTrue(deleter.recentCompletedTurns(50).stream()
                .noneMatch(t -> seed.turnId.equals(t.turnId)));
            assertEquals(0, deleter.latestDiagnostics(100).stream()
                .filter(d -> seed.turnId.equals(d.turnId)).count());
            assertNotNull(deleter.roleDeleteControl("yuqi"));

            // An exact duplicate in one poll is a single relay delivery.  The
            // batch is preflighted and deduplicated before decrypt/persist/ACK.
            CloudInboxTestHarness.ScriptedCloudTransport duplicateTransport =
                new CloudInboxTestHarness.ScriptedCloudTransport(cloudConfig)
                    .pollBatch(envelope.json, envelope.json);
            int beforePersist = persistCalls.get();
            assertEquals(1, CloudInboxTestHarness.drainOnce(
                context, duplicateTransport, persistCalls));
            assertEquals(1, duplicateTransport.ackAttempts());
            assertCloudAckBody(duplicateTransport.ackBodies().get(0), "device-connected-race",
                "relay-role-delete-late-cloud");
            assertEquals(1, duplicateTransport.successfulAcks());
            assertEquals(beforePersist + 1, persistCalls.get());

            // A same-messageId envelope with any changed outer field poisons
            // the complete batch before decrypt, semantic persistence, or ACK.
            JSONObject changed = new JSONObject(envelope.json.toString()).put(
                "createdAt", envelope.json.getLong("createdAt") + 1L);
            CloudInboxTestHarness.ScriptedCloudTransport changedTransport =
                new CloudInboxTestHarness.ScriptedCloudTransport(cloudConfig)
                    .pollBatch(envelope.json, changed);
            int persistBeforeChanged = persistCalls.get();
            try {
                CloudInboxTestHarness.drainOnce(context, changedTransport, persistCalls);
                throw new AssertionError("changed duplicate envelope must fail closed");
            } catch (IllegalArgumentException expectedBatchConflict) {
                assertEquals(0, changedTransport.ackAttempts());
                assertEquals(0, changedTransport.ackBodies().size());
                assertEquals(persistBeforeChanged, persistCalls.get());
            }

            // Reopen a second Room connection against the same on-disk v15
            // database.  The applied tombstone must survive while all semantic
            // turn/message/diagnostic rows remain absent.
            AlExecutionDatabase reopenedDatabase = Room.databaseBuilder(
                context, AlExecutionDatabase.class, "al-execution.db")
                .allowMainThreadQueries().build();
            try {
                RoomExecutionStore reopened = new RoomExecutionStore(
                    reopenedDatabase, "device-connected-race");
                LifecycleControl reopenedControl = reopened.roleDeleteControl("yuqi");
                assertNotNull(reopenedControl);
                assertEquals(LifecycleControl.APPLIED, reopenedControl.state);
                assertNull(reopened.turn(seed.turnId));
                assertEquals(0, reopened.replyParts(seed.turnId).size());
                assertNull(reopenedDatabase.executionDao().conversationCursor("yuqi"));
                assertTrue(reopenedDatabase.executionDao().recentRawMessages("yuqi", 200).stream()
                    .noneMatch(message -> seed.turnId.equals(message.turnId)));
                assertTrue(reopened.recentCompletedTurns(50).stream()
                    .noneMatch(turn -> seed.turnId.equals(turn.turnId)));
                assertEquals(0, reopened.latestDiagnostics(200).stream()
                    .filter(diagnostic -> seed.turnId.equals(diagnostic.turnId)).count());
                NotificationManager notificationManager =
                    (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
                assertNotNull(notificationManager);
                int notificationId = AlNotificationFactory.messageNotificationId(seed.turnId);
                assertTrue(java.util.Arrays.stream(notificationManager.getActiveNotifications())
                    .noneMatch(item -> item.getId() == notificationId));
            } finally {
                reopenedDatabase.close();
            }
            // APPLIED role deletion is a durable Web tombstone boundary.  Start
            // from a clean mirror, then use only the shipped bootstrap/render
            // path; no late cloud replay may resurrect messages or UI ACK state.
            web.resetCaseWebState(logicalId);
            web.waitForShippedUiReady();
            web.startProductionReconcilePoll();
            web.waitForScriptValue("typeof window.__yuqiConnectedReconcileResult!=='undefined'", "true");
            web.showYuqiChat();
            JSONObject summary = new JSONObject(web.chatLandingStructuredSummary(seed.turnId, source));
            assertExactAssistantDom(summary, 0);
            assertEquals(0, summary.getJSONArray("groups").length());
            assertEquals(0, summary.getInt("replyLinks"));
            assertEquals(0, summary.getJSONArray("source").length());
            assertNullCursorShape(new JSONObject(web.waitForConversationCursor("yuqi")));
            assertNoActiveNotification(context, seed.turnId);
            web.reload();
            web.waitForShippedUiBootstrap();
            web.showYuqiChat();
            JSONObject replay = new JSONObject(web.chatLandingStructuredSummary(seed.turnId, source));
            assertExactAssistantDom(replay, 0);
            assertEquals(0, replay.getJSONArray("groups").length());
            assertEquals(0, replay.getInt("replyLinks"));
            assertEquals(0, replay.getJSONArray("source").length());
            assertNullCursorShape(new JSONObject(web.waitForConversationCursor("yuqi")));
        }
    }

    private static void assertCloudAckBody(
        JSONObject body, String expectedDeviceId, String expectedMessageId
    ) throws Exception {
        assertNotNull(body);
        assertEquals(expectedDeviceId, body.getString("deviceId"));
        Set<String> keys = new HashSet<>();
        java.util.Iterator<String> iterator = body.keys();
        while (iterator.hasNext()) keys.add(iterator.next());
        assertEquals(new HashSet<>(java.util.Arrays.asList("deviceId", "messageIds")), keys);
        JSONArray ids = body.getJSONArray("messageIds");
        assertEquals(1, ids.length());
        assertEquals(expectedMessageId, ids.getString(0));
    }

    private static void assertNoActiveNotification(Context context, String turnId) {
        NotificationManager manager = (NotificationManager) context.getSystemService(
            Context.NOTIFICATION_SERVICE);
        assertNotNull(manager);
        int notificationId = AlNotificationFactory.messageNotificationId(turnId);
        for (android.service.notification.StatusBarNotification item : manager.getActiveNotifications()) {
            assertFalse("deleted/in-flight turn must not leave an active notification",
                item.getId() == notificationId);
        }
    }

    private static void assertNoLateSemanticSideEffects(
        YuqiV3ConnectedRaceFixture fixture, String turnId
    ) {
        assertTrue("late LAN result must not create raw messages", fixture.database.executionDao()
            .recentRawMessages("yuqi", 200).stream()
            .noneMatch(message -> turnId.equals(message.turnId)));
        assertTrue("late LAN result must not create diagnostics", fixture.store.latestDiagnostics(200)
            .stream().noneMatch(diagnostic -> turnId.equals(diagnostic.turnId)));
        assertEquals("late LAN result must not create a receipt ACK", 0,
            fixture.loopbackRequestCountForPath("/ack"));
        assertEquals("late LAN result must not create an authority receipt", 0,
            fixture.loopbackRequestCountContaining("AUTHORITY_RECEIPT"));
        assertEquals("late LAN result must not leave receipt attempts", 0,
            fixture.database.executionDao().authorityReceiptAttempts().stream()
                .filter(attempt -> turnId.equals(attempt.turnId)).count());
    }

    private static String canonicalReplyPartsSnapshot(List<ReplyPartEntity> parts) throws Exception {
        JSONArray snapshot = new JSONArray();
        for (ReplyPartEntity part : parts) {
            snapshot.put(new JSONObject()
                .put("replyPartId", part.replyPartId)
                .put("turnId", part.turnId)
                .put("attemptId", part.attemptId)
                .put("sequence", part.sequence)
                .put("type", part.type)
                .put("content", part.content)
                .put("payloadJson", new JSONObject(part.payloadJson))
                .put("createdAt", part.createdAt));
        }
        return BridgeAuthority.canonicalJson(snapshot);
    }

    private static void assertCanonicalReplyParts(
        YuqiV3ConnectedRaceFixture.CanonicalSeed seed,
        List<ReplyPartEntity> parts
    ) throws Exception {
        assertEquals(3, parts.size());
        for (int ordinal = 0; ordinal < parts.size(); ordinal += 1) {
            ReplyPartEntity part = parts.get(ordinal);
            JSONObject payload = new JSONObject(part.payloadJson);
            JSONObject item = payload.getJSONObject("canonicalItem");
            assertEquals(AuthorityIdentity.messageId(seed.result.visibleGroupId, ordinal),
                part.replyPartId);
            assertEquals(ordinal, part.sequence);
            assertEquals(ordinal, item.getInt("ordinal"));
            assertEquals(part.replyPartId, item.getString("messageId"));
            assertEquals(part.content, item.getString("content"));
            JSONObject semantic = new JSONObject()
                .put("content", item.getString("content"))
                .put("speakerId", item.getString("speakerId"))
                .put("speakerType", item.getString("speakerType"))
                .put("recipientId", item.getString("recipientId"));
            assertEquals(BridgeAuthority.sha256CanonicalJson(semantic), item.getString("itemChecksum"));
            assertFalse(item.has("actions"));
            assertEquals("TEXT", part.type);
        }
    }

    private static void assertExactCursorShape(JSONObject cursor) {
        Set<String> expected = new HashSet<>(java.util.Arrays.asList(
            "characterId", "nativeCompletedTurnId", "nativeCompletedGroupId",
            "nativeCompletedSequence", "uiAppliedTurnId", "uiAppliedGroupId",
            "uiAppliedSequence", "localSequence", "clearedThroughSequence",
            "clearEpoch", "clearedAt", "chatOpen", "updatedAt", "cursorChecksum"));
        Set<String> actual = new HashSet<>();
        java.util.Iterator<String> keys = cursor.keys();
        while (keys.hasNext()) actual.add(keys.next());
        assertEquals("conversation cursor must use the exact 14-key bridge contract", expected, actual);
    }

    private static void assertNullCursorShape(JSONObject cursor) throws Exception {
        assertExactCursorShape(cursor);
        assertTrue("no cursor must expose nativeCompletedTurnId as JSON null",
            cursor.has("nativeCompletedTurnId") && cursor.isNull("nativeCompletedTurnId"));
        assertTrue("no cursor must expose nativeCompletedGroupId as JSON null",
            cursor.has("nativeCompletedGroupId") && cursor.isNull("nativeCompletedGroupId"));
        assertTrue("no cursor must expose uiAppliedTurnId as JSON null",
            cursor.has("uiAppliedTurnId") && cursor.isNull("uiAppliedTurnId"));
        assertTrue("no cursor must expose uiAppliedGroupId as JSON null",
            cursor.has("uiAppliedGroupId") && cursor.isNull("uiAppliedGroupId"));
        assertEquals(0L, cursor.getLong("nativeCompletedSequence"));
        assertEquals(0L, cursor.getLong("uiAppliedSequence"));
    }

    private static void assertNativePendingCursorShape(JSONObject cursor, String turnId, String groupId)
        throws Exception {
        assertExactCursorShape(cursor);
        assertEquals(turnId, cursor.getString("nativeCompletedTurnId"));
        assertEquals(groupId, cursor.getString("nativeCompletedGroupId"));
        assertTrue("native completed cursor must precede UI acknowledgement",
            cursor.getLong("nativeCompletedSequence") >= 1L
                && cursor.has("uiAppliedTurnId") && cursor.isNull("uiAppliedTurnId")
                && cursor.has("uiAppliedGroupId") && cursor.isNull("uiAppliedGroupId")
                && cursor.getLong("uiAppliedSequence") == 0L);
    }

    private static void assertExactAssistantDom(JSONObject summary, int expectedCount) throws Exception {
        JSONArray assistant = summary.getJSONArray("assistant");
        JSONArray assistantIds = summary.getJSONArray("assistantIds");
        JSONArray domAssistantIds = summary.getJSONArray("domAssistantIds");
        assertEquals(expectedCount, assistant.length());
        assertEquals(expectedCount, assistantIds.length());
        assertEquals(expectedCount, domAssistantIds.length());
        List<String> expectedIds = new ArrayList<>();
        for (int i = 0; i < assistant.length(); i += 1) {
            String id = assistant.getJSONObject(i).getString("id");
            assertTrue("assistant message id must be non-empty", id != null && !id.isEmpty());
            expectedIds.add(id);
        }
        List<String> reportedIds = new ArrayList<>();
        for (int i = 0; i < assistantIds.length(); i += 1) reportedIds.add(assistantIds.getString(i));
        List<String> domIds = new ArrayList<>();
        for (int i = 0; i < domAssistantIds.length(); i += 1) domIds.add(domAssistantIds.getString(i));
        Collections.sort(expectedIds);
        Collections.sort(reportedIds);
        Collections.sort(domIds);
        assertEquals("structured assistantIds must match assistant records", expectedIds, reportedIds);
        assertEquals("DOM assistant data-message-id set must equal persisted assistant IDs", expectedIds, domIds);
        assertEquals("assistant IDs must be unique", expectedIds.size(), new HashSet<>(expectedIds).size());
        assertEquals("DOM assistant IDs must each occur exactly once", domIds.size(), new HashSet<>(domIds).size());
    }

    private static void assertExactFallbackSummary(
        JSONObject summary,
        YuqiV3ConnectedRaceFixture.FallbackSeed seed,
        String sourceMessageId
    ) throws Exception {
        assertExactAssistantDom(summary, 1);
        assertEquals(1, summary.getJSONArray("source").length());
        assertEquals(sourceMessageId, summary.getJSONArray("source")
            .getJSONObject(0).getString("id"));
        JSONObject assistant = summary.getJSONArray("assistant").getJSONObject(0);
        String expectedReplyPartId = AuthorityIdentity.messageId(seed.visibleGroupId, 0);
        String expectedMessageId = "native_" + seed.turnId + "_" + expectedReplyPartId + "_0";
        assertEquals(expectedMessageId, assistant.getString("id"));
        assertEquals("native:" + seed.turnId, assistant.getString("sourceTurnId"));
        assertEquals(expectedReplyPartId, assistant.getString("sourceReplyPartId"));
        assertEquals(sourceMessageId, assistant.getString("replyToMessageId"));
        assertEquals(0, assistant.getJSONArray("actions").length());
    }

    private static void assertReceiptTupleUnchanged(
        ChatTurnEntity beforeTurn,
        ConversationCursorEntity beforeCursor,
        ChatTurnEntity afterTurn,
        ConversationCursorEntity afterCursor
    ) {
        assertEquals(beforeTurn.bridgeCommitChecksum, afterTurn.bridgeCommitChecksum);
        assertEquals(beforeTurn.authorityLineageKey, afterTurn.authorityLineageKey);
        assertEquals(beforeTurn.lineageRevision, afterTurn.lineageRevision);
        assertEquals(beforeTurn.turnRevision, afterTurn.turnRevision);
        assertEquals(beforeTurn.laneKey, afterTurn.laneKey);
        assertEquals(beforeTurn.laneRevision, afterTurn.laneRevision);
        assertEquals(beforeTurn.generationFingerprint, afterTurn.generationFingerprint);
        assertEquals(beforeTurn.pipelineReleaseId, afterTurn.pipelineReleaseId);
        assertEquals(beforeTurn.terminalDisposition, afterTurn.terminalDisposition);
        assertEquals(beforeTurn.inputVisibilitySequence, afterTurn.inputVisibilitySequence);
        assertEquals(beforeTurn.inputClearEpoch, afterTurn.inputClearEpoch);
        assertEquals(beforeTurn.uiAppliedAt, afterTurn.uiAppliedAt);
        assertEquals(beforeCursor.nativeCompletedSequence, afterCursor.nativeCompletedSequence);
        assertEquals(beforeCursor.uiAppliedSequence, afterCursor.uiAppliedSequence);
        assertEquals(beforeCursor.uiAppliedTurnId, afterCursor.uiAppliedTurnId);
        assertEquals(beforeCursor.uiAppliedGroupId, afterCursor.uiAppliedGroupId);
    }

    private static void waitForRoomUiApplied(RoomExecutionStore store, String turnId)
        throws InterruptedException {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < deadline) {
            ChatTurnEntity turn = store.turn(turnId);
            ConversationCursorEntity cursor = store.getConversationCursor("yuqi");
            if (turn != null && turn.uiAppliedAt != null && cursor != null
                && turnId.equals(cursor.uiAppliedTurnId) && cursor.uiAppliedSequence == 1L) return;
            Thread.sleep(100L);
        }
        ChatTurnEntity finalTurn = store.turn(turnId);
        ConversationCursorEntity finalCursor = store.getConversationCursor("yuqi");
        throw new AssertionError("Room UI acknowledgement was not persisted for " + turnId
            + " turn=" + (finalTurn == null ? "null" : finalTurn.uiAppliedAt)
            + " cursor=" + (finalCursor == null ? "null"
                : finalCursor.uiAppliedTurnId + "/" + finalCursor.uiAppliedSequence));
    }

    private static void waitForRoomTurnCompleted(RoomExecutionStore store, String turnId)
        throws InterruptedException {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < deadline) {
            ChatTurnEntity turn = store.turn(turnId);
            if (turn != null && TurnState.COMPLETED.name().equals(turn.state)) return;
            Thread.sleep(100L);
        }
        ChatTurnEntity finalTurn = store.turn(turnId);
        throw new AssertionError("production service did not persist COMPLETED for " + turnId
            + " state=" + (finalTurn == null ? "null" : finalTurn.state));
    }
}
