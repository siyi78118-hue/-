package com.siyi.al.execution;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.webkit.WebView;
import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.sqlite.db.SupportSQLiteDatabase;
import com.siyi.al.AlExecutionPlugin;
import com.siyi.al.MainActivity;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.RoleNotificationCancellationEntity;
import com.siyi.al.execution.bridge.BridgeConfig;
import com.siyi.al.execution.bridge.BridgeMode;
import com.siyi.al.execution.secure.AlSecretStore;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.Map;
import java.util.UUID;
import java.util.HashMap;
import java.util.Set;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real Capacitor/WebView startup contract for the AlExecution plugin. */
@RunWith(AndroidJUnit4.class)
public final class AlExecutionPluginStartupTest {
    @Test
    public void productionWebViewRegistersAlExecutionAndResolvesCursor() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            WebView webView = awaitWebView(scenario);
            String plugin = evaluate(webView,
                "typeof window.Capacitor?.Plugins?.AlExecution");
            assertTrue("AlExecution plugin missing from production Capacitor map: " + plugin,
                "\"object\"".equals(plugin) || "\"function\"".equals(plugin));

            String request = "(async()=>{try{"
                + "const value=await window.Capacitor.Plugins.AlExecution"
                + ".getConversationCursor({characterId:'yuqi'});"
                + "window.__alExecutionStartupResult=JSON.stringify({ok:true,value});"
                + "}catch(error){window.__alExecutionStartupResult=JSON.stringify({"
                + "ok:false,error:String(error)});}})();";
            evaluate(webView, request);
            String result = waitForValue(webView,
                "window.__alExecutionStartupResult || ''", 20);
            assertTrue("getConversationCursor did not resolve a cursor: " + result,
                result.contains("\\\"ok\\\":true") && result.contains("cursorChecksum"));
        }
    }

    @Test
    public void failedWorkerInitializationCanRetryWithoutPartialGraph() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SharedPreferences preferences = context.getSharedPreferences(
            "al.execution.secrets.v1.prefs", Context.MODE_PRIVATE);
        Map<String, ?> before = preferences.getAll();
        try {
            // Corrupt the persisted authority before the production Activity and
            // plugin are created; otherwise a prior READY graph can satisfy the
            // first request before the worker observes the invalid value.
            preferences.edit().putString("yuqi-bridge:enabled", "not-encrypted").commit();
            try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
                WebView webView = awaitWebView(scenario);
                assertPluginObject(webView);
                String failedVariable = "__alExecutionStartupRetryFailure";
                startCursorRequest(webView, failedVariable);
                String failed = waitForValue(webView,
                    "window." + failedVariable + " || ''", 20);
                assertTrue("first worker initialization unexpectedly succeeded: " + failed,
                    failed.contains("\\\"ok\\\":false")
                        && failed.contains("Encrypted API configuration is invalid"));

                preferences.edit().remove("yuqi-bridge:enabled").commit();
                String retryVariable = "__alExecutionStartupRetrySuccess";
                startCursorRequest(webView, retryVariable);
                String recovered = waitForValue(webView,
                    "window." + retryVariable + " || ''", 20);
                assertTrue("retry did not publish a complete graph: " + recovered,
                    recovered.contains("\\\"ok\\\":true")
                        && recovered.contains("cursorChecksum"));
            }
        } finally {
            SharedPreferences.Editor restore = preferences.edit().clear();
            for (Map.Entry<String, ?> entry : before.entrySet()) {
                Object value = entry.getValue();
                if (value instanceof String) restore.putString(entry.getKey(), (String) value);
                else if (value instanceof Boolean) restore.putBoolean(entry.getKey(), (Boolean) value);
                else if (value instanceof Integer) restore.putInt(entry.getKey(), (Integer) value);
                else if (value instanceof Long) restore.putLong(entry.getKey(), (Long) value);
                else if (value instanceof Float) restore.putFloat(entry.getKey(), (Float) value);
                else if (value instanceof java.util.Set) {
                    @SuppressWarnings("unchecked")
                    java.util.Set<String> values = (java.util.Set<String>) value;
                    restore.putStringSet(entry.getKey(), values);
                }
            }
            restore.commit();
        }
    }

    @Test
    public void destroyRejectsQueuedCallsInsteadOfLeavingPromisesPending() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            WebView webView = awaitWebView(scenario);
            assertPluginObject(webView);
            evaluate(webView, "localStorage.setItem('alTask24BQueuedCalls',JSON.stringify("
                + "{submitted:0,resolved:0,rejected:0,pending:0}));"
                + "(async()=>{for(let i=0;i<120;i++){const s=JSON.parse(localStorage.getItem('alTask24BQueuedCalls'));"
                + "s.submitted++;s.pending++;localStorage.setItem('alTask24BQueuedCalls',JSON.stringify(s));"
                + "window.Capacitor.Plugins.AlExecution.getConversationCursor({characterId:'yuqi'})"
                + ".then(()=>{const n=JSON.parse(localStorage.getItem('alTask24BQueuedCalls'));n.pending--;n.resolved++;"
                + "localStorage.setItem('alTask24BQueuedCalls',JSON.stringify(n));})"
                + ".catch(()=>{const n=JSON.parse(localStorage.getItem('alTask24BQueuedCalls'));n.pending--;n.rejected++;"
                + "localStorage.setItem('alTask24BQueuedCalls',JSON.stringify(n));});}})();");
            evaluate(webView, "(()=>{const s=JSON.parse(localStorage.getItem('alTask24BQueuedCalls'));"
                + "s.destroyRequested=true;localStorage.setItem('alTask24BQueuedCalls',JSON.stringify(s));})()");
            scenario.recreate();
            WebView recreated = awaitWebView(scenario);
            JSONObject queued = waitForJsonObject(recreated,
                "localStorage.getItem('alTask24BQueuedCalls') || ''", value ->
                    value.optInt("submitted", -1) == 120
                        && value.optInt("pending", -1) == 0
                        && value.optBoolean("destroyRequested", false)
                        && value.optInt("resolved", -1) + value.optInt("rejected", -1) == 120,
                20);
            assertEquals(120, queued.optInt("submitted", -1));
            assertEquals(0, queued.optInt("pending", -1));
            assertEquals(120, queued.optInt("resolved", -1) + queued.optInt("rejected", -1));
            startCursorRequest(recreated, "__alExecutionAfterRecreate");
            String afterRecreate = waitForValue(recreated,
                "window.__alExecutionAfterRecreate || ''", 20);
            assertTrue("new plugin instance did not resolve after recreate: " + afterRecreate,
                afterRecreate.contains("\\\"ok\\\":true")
                    && afterRecreate.contains("cursorChecksum"));
        }
    }

    @Test
    public void runningRoomCallDoesNotResolveSuccessAfterDestroy() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            WebView webView = awaitWebView(scenario);
            assertPluginObject(webView);
            startCursorRequest(webView, "__alExecutionHeldWarmup");
            String warmup = waitForValue(webView, "window.__alExecutionHeldWarmup || ''", 20);
            assertTrue("plugin did not reach READY before held call: " + warmup,
                warmup.contains("\\\"ok\\\":true"));
            SupportSQLiteDatabase heldTransaction = database.getOpenHelper().getWritableDatabase();
            heldTransaction.beginTransaction();
            try {
                evaluate(webView, "localStorage.setItem('alTask24BHeld',JSON.stringify("
                    + "{submitted:0,resolved:0,rejected:0,pending:0}));"
                    + "(()=>{const s=JSON.parse(localStorage.getItem('alTask24BHeld'));s.submitted++;s.pending++;"
                    + "localStorage.setItem('alTask24BHeld',JSON.stringify(s));"
                    + "window.Capacitor.Plugins.AlExecution.saveProactiveSnapshot({snapshotId:'task24b-held',"
                    + "characterId:'yuqi',snapshotJson:'{}'})"
                    + ".then(()=>{const n=JSON.parse(localStorage.getItem('alTask24BHeld'));n.pending--;n.resolved++;"
                    + "localStorage.setItem('alTask24BHeld',JSON.stringify(n));})"
                    + ".catch(()=>{const n=JSON.parse(localStorage.getItem('alTask24BHeld'));n.pending--;n.rejected++;"
                    + "localStorage.setItem('alTask24BHeld',JSON.stringify(n));});})()");
                scenario.recreate();
                heldTransaction.setTransactionSuccessful();
                heldTransaction.endTransaction();
                WebView recreated = awaitWebView(scenario);
                JSONObject held = waitForJsonObject(recreated,
                    "localStorage.getItem('alTask24BHeld') || ''", value ->
                        value.optInt("submitted", -1) == 1
                            && value.optInt("resolved", -1) == 0
                            && value.optInt("rejected", -1) == 1
                            && value.optInt("pending", -1) == 0,
                    20);
                assertEquals(1, held.optInt("submitted", -1));
                assertEquals(0, held.optInt("resolved", -1));
                assertEquals(1, held.optInt("rejected", -1));
                assertEquals(0, held.optInt("pending", -1));
                startCursorRequest(recreated, "__alExecutionHeldAfterDestroy");
                String result = waitForValue(recreated, "window.__alExecutionHeldAfterDestroy || ''", 20);
                assertTrue("new instance did not recover after held call: " + result,
                    result.contains("\\\"ok\\\":true") && result.contains("cursorChecksum"));
            } finally {
                if (heldTransaction.inTransaction()) heldTransaction.endTransaction();
            }
        }
    }

    @Test
    public void saveBridgeConfigUsesOneAtomicCommit() {
        Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SharedPreferences before = base.getSharedPreferences(
            "al.execution.secrets.v1.prefs", Context.MODE_PRIVATE);
        HashMap<String, ?> snapshot = new HashMap<>(before.getAll());
        BridgeConfig realConfig = new BridgeConfig(
            true, BridgeMode.AUTO, "http://127.0.0.1:17892", "https://cloud.invalid",
            "atomic-real-device", "pairing-secret-123", "device-token-1234567890",
            "ZW5jcnlwdGlvbi1rZXk=", 1200, 90_000, 60, 1000, 1_200_000);
        try {
            AlSecretStore realSecrets = new AlSecretStore(base);
            realSecrets.saveBridgeConfig(realConfig);
            assertEquals("atomic-real-device", realSecrets.loadBridgeConfig().deviceId);
            HashMap<String, ?> committedSnapshot = new HashMap<>(before.getAll());
            Context failing = new CommitFailingContext(base);
            AlSecretStore secrets = new AlSecretStore(failing);
            try {
                secrets.saveBridgeConfig(new BridgeConfig(
                    true, BridgeMode.AUTO, "http://127.0.0.1:17892", "https://cloud.invalid",
                    "atomic-new-device", "pairing-secret-123", "device-token-1234567890",
                    "ZW5jcnlwdGlvbi1rZXk=", 1200, 90_000, 60, 1000, 1_200_000));
                assertTrue("saveBridgeConfig unexpectedly succeeded", false);
            } catch (IllegalStateException expected) {
                // The injected commit failure must leave every previous field intact.
                assertEquals("commit failure changed preferences", committedSnapshot, before.getAll());
                assertEquals("logical bridge config changed after failed commit",
                    "atomic-real-device", realSecrets.loadBridgeConfig().deviceId);
            }
        } finally {
            SharedPreferences.Editor restore = before.edit().clear();
            for (Map.Entry<String, ?> entry : snapshot.entrySet()) {
                Object value = entry.getValue();
                if (value instanceof String) restore.putString(entry.getKey(), (String) value);
                else if (value instanceof Boolean) restore.putBoolean(entry.getKey(), (Boolean) value);
                else if (value instanceof Integer) restore.putInt(entry.getKey(), (Integer) value);
                else if (value instanceof Long) restore.putLong(entry.getKey(), (Long) value);
                else if (value instanceof Float) restore.putFloat(entry.getKey(), (Float) value);
                else if (value instanceof Set) {
                    @SuppressWarnings("unchecked") Set<String> values = (Set<String>) value;
                    restore.putStringSet(entry.getKey(), values);
                }
            }
            restore.commit();
        }
    }

    @Test
    public void realWebViewSaveBridgeConfigCommitFailureKeepsPeerAndStore() throws Exception {
        Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SharedPreferences preferences = base.getSharedPreferences(
            "al.execution.secrets.v1.prefs", Context.MODE_PRIVATE);
        Map<String, ?> rawSnapshot = new HashMap<>(preferences.getAll());
        AlSecretStore baseline = new AlSecretStore(base);
        BridgeConfig oldConfig = new BridgeConfig(
            true, BridgeMode.AUTO, "http://127.0.0.1:17892", "https://cloud.invalid",
            "webview-old-peer", "pairing-secret-123", "device-token-1234567890",
            "ZW5jcnlwdGlvbi1rZXk=", 1200, 90_000, 60, 1000, 1_200_000);
        baseline.saveBridgeConfig(oldConfig);
        try {
            setForcedCommitOutcome("webview-new-peer");
            try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
                WebView webView = awaitWebView(scenario);
                assertPluginObject(webView);
                startCursorRequest(webView, "__alExecutionCommitFailureWarmup");
                JSONObject warmup = waitForJsonObject(webView,
                    "window.__alExecutionCommitFailureWarmup || ''",
                    value -> value.has("ok") && value.optBoolean("ok", false), 20);
                assertTrue("plugin did not initialize before commit failure: " + warmup,
                    warmup.optBoolean("ok", false));
                evaluate(webView, "window.__alExecutionCommitFailure='';(async()=>{try{"
                    + "await window.Capacitor.Plugins.AlExecution.saveBridgeConfig({enabled:true,"
                    + "mode:'AUTO',deviceId:'webview-new-peer'});"
                    + "window.__alExecutionCommitFailure=JSON.stringify({ok:true});"
                    + "}catch(error){window.__alExecutionCommitFailure=JSON.stringify({ok:false,error:String(error)});}})();");
                JSONObject failed = waitForJsonObject(webView,
                    "window.__alExecutionCommitFailure || ''",
                    value -> value.has("ok"), 20);
                assertTrue("real WebView saveBridgeConfig unexpectedly succeeded: " + failed,
                    !failed.optBoolean("ok", true));
                evaluate(webView, "window.__alExecutionCommitFailureConfig='';(async()=>{try{"
                    + "const value=await window.Capacitor.Plugins.AlExecution.loadBridgeConfig();"
                    + "window.__alExecutionCommitFailureConfig=JSON.stringify(value);"
                    + "}catch(error){window.__alExecutionCommitFailureConfig=JSON.stringify({error:String(error)});}})();");
                JSONObject loaded = waitForJsonObject(webView,
                    "window.__alExecutionCommitFailureConfig || ''",
                    value -> value.has("deviceId"), 20);
                assertEquals("webview-old-peer", loaded.optString("deviceId"));
                startCursorRequest(webView, "__alExecutionCommitFailureCursor");
                JSONObject cursor = waitForJsonObject(webView,
                    "window.__alExecutionCommitFailureCursor || ''",
                    value -> value.has("ok") && value.optBoolean("ok", false), 20);
                assertTrue("old in-memory store failed after commit rejection: " + cursor,
                    cursor.optBoolean("ok", false));
            }
        } finally {
            setForcedCommitOutcome(null);
            SharedPreferences.Editor restore = preferences.edit().clear();
            for (Map.Entry<String, ?> entry : rawSnapshot.entrySet()) {
                Object value = entry.getValue();
                if (value instanceof String) restore.putString(entry.getKey(), (String) value);
                else if (value instanceof Boolean) restore.putBoolean(entry.getKey(), (Boolean) value);
                else if (value instanceof Integer) restore.putInt(entry.getKey(), (Integer) value);
                else if (value instanceof Long) restore.putLong(entry.getKey(), (Long) value);
                else if (value instanceof Float) restore.putFloat(entry.getKey(), (Float) value);
                else if (value instanceof Set) {
                    @SuppressWarnings("unchecked") Set<String> values = (Set<String>) value;
                    restore.putStringSet(entry.getKey(), values);
                }
            }
            assertTrue("failed to restore raw bridge preferences after WebView test", restore.commit());
        }
    }

    @Test
    public void realWebViewSaveBridgeConfigOtherPeerCommitsAndRebindsStore() throws Exception {
        Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SharedPreferences preferences = base.getSharedPreferences(
            "al.execution.secrets.v1.prefs", Context.MODE_PRIVATE);
        Map<String, ?> rawSnapshot = new HashMap<>(preferences.getAll());
        AlExecutionDatabase database = AlExecutionDatabase.get(base);
        String characterId = "task24b-commit-success-" + UUID.randomUUID().toString().replace("-", "");
        String newPeer = "webview-success-" + UUID.randomUUID().toString().replace("-", "");
        AtomicReference<String> controlId = new AtomicReference<>();
        AlSecretStore baseline = new AlSecretStore(base);
        baseline.saveBridgeConfig(new BridgeConfig(
            true, BridgeMode.AUTO, "http://127.0.0.1:17892", "https://cloud.invalid",
            "webview-success-old", "pairing-secret-123", "device-token-1234567890",
            "ZW5jcnlwdGlvbi1rZXk=", 1200, 90_000, 60, 1000, 1_200_000));
        try {
            setForcedCommitOutcome("different-device-token");
            try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
                WebView webView = awaitWebView(scenario);
                assertPluginObject(webView);
                startCursorRequest(webView, "__alExecutionCommitSuccessWarmup");
                JSONObject warmup = waitForJsonObject(webView,
                    "window.__alExecutionCommitSuccessWarmup || ''",
                    value -> value.optBoolean("ok", false), 20);
                assertTrue("plugin did not initialize before commit success: " + warmup,
                    warmup.optBoolean("ok", false));
                evaluate(webView, "window.__alExecutionCommitSuccess='';(async()=>{try{"
                    + "await window.Capacitor.Plugins.AlExecution.saveBridgeConfig({enabled:true,"
                    + "mode:'AUTO',deviceId:'" + newPeer + "'});"
                    + "window.__alExecutionCommitSuccess=JSON.stringify({ok:true});"
                    + "}catch(error){window.__alExecutionCommitSuccess=JSON.stringify({ok:false,error:String(error)});}})();");
                JSONObject saved = waitForJsonObject(webView,
                    "window.__alExecutionCommitSuccess || ''",
                    value -> value.has("ok"), 20);
                assertTrue("non-target device was incorrectly rejected: " + saved,
                    saved.optBoolean("ok", false));
                evaluate(webView, "window.__alExecutionCommitSuccessConfig='';(async()=>{try{"
                    + "const value=await window.Capacitor.Plugins.AlExecution.loadBridgeConfig();"
                    + "window.__alExecutionCommitSuccessConfig=JSON.stringify(value);"
                    + "}catch(error){window.__alExecutionCommitSuccessConfig=JSON.stringify({error:String(error)});}})();");
                JSONObject loaded = waitForJsonObject(webView,
                    "window.__alExecutionCommitSuccessConfig || ''",
                    value -> value.has("deviceId"), 20);
                assertEquals(newPeer, loaded.optString("deviceId"));
                startCursorRequestForCharacter(webView, characterId, "__alExecutionCommitSuccessCursor");
                JSONObject cursor = waitForJsonObject(webView,
                    "window.__alExecutionCommitSuccessCursor || ''",
                    value -> value.optBoolean("ok", false), 20);
                JSONObject cursorValue = cursor.optJSONObject("value");
                assertTrue("new store did not expose a cursor checksum: " + cursor,
                    cursorValue != null && cursorValue.optString("cursorChecksum").matches("[a-f0-9]{64}"));
                String checksum = cursorValue.optString("cursorChecksum");
                evaluate(webView, "window.__alExecutionCommitSuccessClear='';(async()=>{try{"
                    + "const value=await window.Capacitor.Plugins.AlExecution.createConversationClear({"
                    + "characterId:'" + characterId + "',expectedCursorChecksum:'" + checksum + "'});"
                    + "window.__alExecutionCommitSuccessClear=JSON.stringify({ok:true,value});"
                    + "}catch(error){window.__alExecutionCommitSuccessClear=JSON.stringify({ok:false,error:String(error)});}})();");
                JSONObject clear = waitForJsonObject(webView,
                    "window.__alExecutionCommitSuccessClear || ''",
                    value -> value.optBoolean("ok", false), 20);
                String createdControlId = clear.optJSONObject("value") == null
                    ? "" : clear.optJSONObject("value").optString("controlId");
                assertTrue("new store clear did not return a control: " + clear,
                    createdControlId.length() > 0);
                controlId.set(createdControlId);
                assertEquals(newPeer, database.executionDao().lifecycleControl(createdControlId).peerId);
                assertNotNull(database.executionDao().conversationCursor(characterId));
            }
        } finally {
            setForcedCommitOutcome(null);
            if (controlId.get() != null) {
                database.getOpenHelper().getWritableDatabase().execSQL(
                    "DELETE FROM lifecycle_controls WHERE controlId = ?",
                    new Object[] {controlId.get()});
            }
            database.executionDao().deleteConversationCursorForRole(characterId);
            SharedPreferences.Editor restore = preferences.edit().clear();
            for (Map.Entry<String, ?> entry : rawSnapshot.entrySet()) {
                Object value = entry.getValue();
                if (value instanceof String) restore.putString(entry.getKey(), (String) value);
                else if (value instanceof Boolean) restore.putBoolean(entry.getKey(), (Boolean) value);
                else if (value instanceof Integer) restore.putInt(entry.getKey(), (Integer) value);
                else if (value instanceof Long) restore.putLong(entry.getKey(), (Long) value);
                else if (value instanceof Float) restore.putFloat(entry.getKey(), (Float) value);
                else if (value instanceof Set) {
                    @SuppressWarnings("unchecked") Set<String> values = (Set<String>) value;
                    restore.putStringSet(entry.getKey(), values);
                }
            }
            assertTrue("failed to restore raw bridge preferences after WebView success test", restore.commit());
        }
    }

    @Test
    public void queuedCompletionNotificationCannotReachDestroyedPlugin() throws Exception {
        Context application = InstrumentationRegistry.getInstrumentation().getTargetContext()
            .getApplicationContext();
        CountDownLatch destroyed = new CountDownLatch(1);
        Application.ActivityLifecycleCallbacks lifecycle = new Application.ActivityLifecycleCallbacks() {
            @Override public void onActivityCreated(Activity activity, android.os.Bundle state) { }
            @Override public void onActivityStarted(Activity activity) { }
            @Override public void onActivityResumed(Activity activity) { }
            @Override public void onActivityPaused(Activity activity) { }
            @Override public void onActivityStopped(Activity activity) { }
            @Override public void onActivitySaveInstanceState(Activity activity, android.os.Bundle state) { }
            @Override public void onActivityDestroyed(Activity activity) { destroyed.countDown(); }
        };
        ((Application) application).registerActivityLifecycleCallbacks(lifecycle);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            WebView oldWebView = awaitWebView(scenario);
            assertPluginObject(oldWebView);
            evaluate(oldWebView, "localStorage.setItem('alTask24BNotifyCount','{\"old\":0,\"new\":0}');"
                + "window.Capacitor.Plugins.AlExecution.addListener('executionCompleted',()=>{"
                + "const s=JSON.parse(localStorage.getItem('alTask24BNotifyCount')||'{}');s.old++;"
                + "localStorage.setItem('alTask24BNotifyCount',JSON.stringify(s));});");
            scenario.onActivity(Activity::finish);
            assertTrue("old Activity did not reach onDestroy", destroyed.await(20, TimeUnit.SECONDS));
            // The old instance is now definitively STOPPING/cleared.  This
            // invocation still posts through the production Handler path and
            // must not reach the destroyed WebView.
            AlExecutionPlugin.notifyCompletedTurn("old-instance", System.currentTimeMillis());
        } finally {
            ((Application) application).unregisterActivityLifecycleCallbacks(lifecycle);
        }
        try (ActivityScenario<MainActivity> recreated = ActivityScenario.launch(MainActivity.class)) {
            WebView newWebView = awaitWebView(recreated);
            assertPluginObject(newWebView);
            JSONObject oldCount = waitForJsonObject(newWebView,
                "localStorage.getItem('alTask24BNotifyCount') || ''",
                value -> value.optInt("old", -1) == 0 && value.optInt("new", -1) == 0, 10);
            assertEquals(0, oldCount.optInt("old", -1));
            startCursorRequest(newWebView, "__alExecutionNotifyWarmup");
            JSONObject warmup = waitForJsonObject(newWebView, "window.__alExecutionNotifyWarmup || ''",
                value -> value.optBoolean("ok", false), 20);
            assertTrue("new plugin did not reach READY before notification: " + warmup,
                warmup.optBoolean("ok", false));
            evaluate(newWebView, "window.Capacitor.Plugins.AlExecution.addListener('executionCompleted',()=>{"
                + "const s=JSON.parse(localStorage.getItem('alTask24BNotifyCount')||'{}');s.new++;"
                + "localStorage.setItem('alTask24BNotifyCount',JSON.stringify(s));});");
            AlExecutionPlugin.notifyCompletedTurn("new-instance", System.currentTimeMillis());
            JSONObject count = waitForJsonObject(newWebView,
                "localStorage.getItem('alTask24BNotifyCount') || ''",
                value -> value.optInt("old", -1) == 0 && value.optInt("new", -1) == 1, 10);
            assertEquals("new instance receives exactly one completion event", 1, count.optInt("new", -1));
        }
    }

    @Test
    public void failedBridgeRebindDoesNotPersistNewPeerOrSplitMemoryGraph() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String corruptKey = "task24b-corrupt-" + UUID.randomUUID().toString().replace("-", "");
        RoleNotificationCancellationEntity corrupt = new RoleNotificationCancellationEntity();
        corrupt.cancellationKey = corruptKey;
        corrupt.controlId = "missing-control";
        corrupt.characterId = "yuqi";
        corrupt.notificationId = 72000;
        corrupt.intentChecksum = "0";
        corrupt.state = "waiting";
        corrupt.createdAt = 1L;
        corrupt.updatedAt = 1L;
        AlExecutionDatabase database = AlExecutionDatabase.get(context);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            WebView webView = awaitWebView(scenario);
            assertPluginObject(webView);
            startCursorRequest(webView, "__alExecutionRebindWarmup");
            String warmup = waitForValue(webView,
                "window.__alExecutionRebindWarmup || ''", 20);
            assertTrue("plugin did not warm its valid graph: " + warmup,
                warmup.contains("\\\"ok\\\":true"));
            assertEquals(1L, database.executionDao().insertRoleNotificationCancellation(corrupt));
            String variable = "__alExecutionRebindFailure";
            evaluate(webView, "window." + variable + "='';(async()=>{try{"
                + "await window.Capacitor.Plugins.AlExecution.saveBridgeConfig({enabled:false,"
                + "mode:'AUTO',deviceId:'task24b-rebind-new-peer'});"
                + "window." + variable + "=JSON.stringify({ok:true});"
                + "}catch(error){window." + variable + "=JSON.stringify({ok:false,error:String(error)});}})();");
            String failed = waitForValue(webView,
                "window." + variable + " || ''", 20);
            assertTrue("corrupt rebind unexpectedly succeeded: " + failed,
                failed.contains("\\\"ok\\\":false"));
            evaluate(webView, "window.__alExecutionRebindConfig='';(async()=>{try{"
                + "const value=await window.Capacitor.Plugins.AlExecution.loadBridgeConfig();"
                + "window.__alExecutionRebindConfig=JSON.stringify(value);"
                + "}catch(error){window.__alExecutionRebindConfig=JSON.stringify({error:String(error)});}})();");
            String config = waitForValue(webView,
                "window.__alExecutionRebindConfig || ''", 20);
            assertTrue("persisted peer changed after failed rebind: " + config,
                !config.contains("task24b-rebind-new-peer"));
            startCursorRequest(webView, "__alExecutionRebindCursor");
            String cursor = waitForValue(webView,
                "window.__alExecutionRebindCursor || ''", 20);
            assertTrue("old in-memory graph was lost after failed rebind: " + cursor,
                cursor.contains("\\\"ok\\\":true") && cursor.contains("cursorChecksum"));
        } finally {
            database.executionDao().deleteRoleNotificationCancellationExact(
                corrupt.cancellationKey, corrupt.controlId, corrupt.characterId,
                corrupt.notificationId, corrupt.intentChecksum, corrupt.state,
                corrupt.createdAt, corrupt.updatedAt);
        }
    }

    private static void assertPluginObject(WebView webView) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        String plugin = null;
        while (System.nanoTime() < deadline) {
            plugin = evaluate(webView,
                "typeof window.Capacitor?.Plugins?.AlExecution");
            if ("\"object\"".equals(plugin) || "\"function\"".equals(plugin)) return;
            Thread.sleep(100L);
        }
        assertTrue("AlExecution plugin missing from production Capacitor map: " + plugin, false);
    }

    private static void startCursorRequest(WebView webView, String variable) throws Exception {
        evaluate(webView, "window." + variable + "='';(async()=>{try{const value="
            + "await window.Capacitor.Plugins.AlExecution.getConversationCursor({characterId:'yuqi'});"
            + "window." + variable + "=JSON.stringify({ok:true,value});"
            + "}catch(error){window." + variable + "=JSON.stringify({ok:false,error:String(error)});}})();");
    }

    private static void startCursorRequestForCharacter(WebView webView, String characterId,
        String variable) throws Exception {
        evaluate(webView, "window." + variable + "='';(async()=>{try{const value="
            + "await window.Capacitor.Plugins.AlExecution.getConversationCursor({characterId:'"
            + characterId + "'});window." + variable + "=JSON.stringify({ok:true,value});"
            + "}catch(error){window." + variable + "=JSON.stringify({ok:false,error:String(error)});}})();");
    }

    private static WebView awaitWebView(ActivityScenario<MainActivity> scenario) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<WebView> ref = new AtomicReference<>();
        scenario.onActivity(activity -> {
            ref.set(activity.getBridge().getWebView());
            latch.countDown();
        });
        if (!latch.await(10, TimeUnit.SECONDS) || ref.get() == null) {
            throw new AssertionError("production MainActivity WebView unavailable");
        }
        return ref.get();
    }

    private static String evaluate(WebView webView, String script) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> ref = new AtomicReference<>();
        webView.post(() -> webView.evaluateJavascript(script, value -> {
            ref.set(value);
            latch.countDown();
        }));
        if (!latch.await(15, TimeUnit.SECONDS)) {
            throw new AssertionError("WebView evaluation timed out");
        }
        return ref.get();
    }

    private static String waitForValue(WebView webView, String script, int seconds) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        String value = null;
        while (System.nanoTime() < deadline) {
            value = evaluate(webView, script);
            if (value != null && !"\"\"".equals(value) && !"null".equals(value)) {
                return value;
            }
            Thread.sleep(100L);
        }
        throw new AssertionError("WebView startup result not observed: " + value);
    }

    private interface JsonPredicate { boolean matches(JSONObject json); }

    private static JSONObject waitForJsonObject(WebView webView, String script,
        JsonPredicate predicate, int seconds) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        String last = null;
        while (System.nanoTime() < deadline) {
            String raw = evaluate(webView, script);
            last = raw;
            try {
                Object decoded = new JSONTokener(raw == null ? "" : raw).nextValue();
                String json = decoded instanceof String ? (String) decoded : raw;
                if (json == null || json.trim().isEmpty() || "null".equals(json)) {
                    Thread.sleep(100L);
                    continue;
                }
                JSONObject value = new JSONObject(json);
                if (predicate.matches(value)) return value;
            } catch (Exception ignored) {
                // Keep polling until the exact predicate is observable.
            }
            Thread.sleep(100L);
        }
        throw new AssertionError("WebView exact predicate not observed: " + last);
    }

    private static void setForcedCommitOutcome(String outcome) throws Exception {
        java.lang.reflect.Method method = AlSecretStore.class.getDeclaredMethod(
            "setForcedCommitOutcomeForTests", String.class);
        method.setAccessible(true);
        method.invoke(null, outcome);
    }

    private static final class CommitFailingContext extends ContextWrapper {
        private final SharedPreferences backing;

        CommitFailingContext(Context base) {
            super(base);
            backing = base.getSharedPreferences("al.execution.secrets.v1.prefs", Context.MODE_PRIVATE);
        }

        @Override public Context getApplicationContext() { return this; }

        @Override public SharedPreferences getSharedPreferences(String name, int mode) {
            if (!"al.execution.secrets.v1.prefs".equals(name)) return super.getSharedPreferences(name, mode);
            return new SharedPreferences() {
                @Override public Map<String, ?> getAll() { return backing.getAll(); }
                @Override public String getString(String key, String defValue) { return backing.getString(key, defValue); }
                @Override public Set<String> getStringSet(String key, Set<String> defValues) { return backing.getStringSet(key, defValues); }
                @Override public int getInt(String key, int defValue) { return backing.getInt(key, defValue); }
                @Override public long getLong(String key, long defValue) { return backing.getLong(key, defValue); }
                @Override public float getFloat(String key, float defValue) { return backing.getFloat(key, defValue); }
                @Override public boolean getBoolean(String key, boolean defValue) { return backing.getBoolean(key, defValue); }
                @Override public boolean contains(String key) { return backing.contains(key); }
                @Override public Editor edit() {
                    Editor delegate = backing.edit();
                    return new Editor() {
                        @Override public Editor putString(String key, String value) { delegate.putString(key, value); return this; }
                        @Override public Editor putStringSet(String key, Set<String> value) { delegate.putStringSet(key, value); return this; }
                        @Override public Editor putInt(String key, int value) { delegate.putInt(key, value); return this; }
                        @Override public Editor putLong(String key, long value) { delegate.putLong(key, value); return this; }
                        @Override public Editor putFloat(String key, float value) { delegate.putFloat(key, value); return this; }
                        @Override public Editor putBoolean(String key, boolean value) { delegate.putBoolean(key, value); return this; }
                        @Override public Editor remove(String key) { delegate.remove(key); return this; }
                        @Override public Editor clear() { delegate.clear(); return this; }
                        @Override public boolean commit() { return false; }
                        @Override public void apply() {
                            delegate.apply();
                            throw new IllegalStateException("injected preference apply failure");
                        }
                    };
                }
                @Override public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) { backing.registerOnSharedPreferenceChangeListener(listener); }
                @Override public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) { backing.unregisterOnSharedPreferenceChangeListener(listener); }
            };
        }
    }
}
