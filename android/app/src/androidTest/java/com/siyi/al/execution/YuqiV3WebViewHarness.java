package com.siyi.al.execution;

import static org.junit.Assert.assertNotNull;

import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import com.siyi.al.MainActivity;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Test-only harness around the shipped MainActivity/Capacitor WebView. */
public final class YuqiV3WebViewHarness implements AutoCloseable {
    private final ActivityScenario<MainActivity> scenario;

    private YuqiV3WebViewHarness(ActivityScenario<MainActivity> scenario) {
        this.scenario = scenario;
    }

    public static YuqiV3WebViewHarness launch() {
        return new YuqiV3WebViewHarness(ActivityScenario.launch(MainActivity.class));
    }

    public String evaluate(String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        scenario.onActivity(activity -> {
            WebView webView = activity.getBridge().getWebView();
            assertNotNull(webView);
            webView.evaluateJavascript(script, result -> {
                value.set(result);
                done.countDown();
            });
        });
        if (!done.await(15, TimeUnit.SECONDS)) throw new AssertionError("WebView evaluation timed out");
        return value.get();
    }

    public String waitForMarker(String marker) throws Exception {
        String escaped = marker.replace("\\", "\\\\").replace("'", "\\'");
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        String value = null;
        while (System.nanoTime() < deadline) {
            value = evaluate("document.body && document.body.innerText.includes('" + escaped + "')");
            if ("true".equals(value)) return value;
            Thread.sleep(100);
        }
        throw new AssertionError("WebView marker not observed: " + marker + " value=" + value);
    }

    public String waitForScriptValue(String script, String expected) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        String value = null;
        while (System.nanoTime() < deadline) {
            value = evaluate(script);
            if (expected.equals(value)) return value;
            Thread.sleep(100);
        }
        throw new AssertionError("WebView script value not observed: expected="
            + expected + " value=" + value);
    }

    public String waitForScriptContains(String script, String expected) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        String value = null;
        while (System.nanoTime() < deadline) {
            value = evaluate(script);
            if (value != null && value.contains(expected)) return value;
            Thread.sleep(100);
        }
        throw new AssertionError("WebView script content not observed: expected="
            + expected + " value=" + value);
    }

    /** Waits for the actual Capacitor bridge/plugin registration after a page lifecycle change. */
    public void waitForProductionPluginReady() throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        String value = null;
        while (System.nanoTime() < deadline) {
            value = evaluate("JSON.stringify({ready:document.readyState==='complete'"
                + "&& !!window.Capacitor?.Plugins?.AlExecution,"
                + "state:document.readyState,plugins:Object.keys(window.Capacitor?.Plugins||{})})");
            // evaluateJavascript returns a quoted JSON string; match the escaped
            // key rather than treating the wrapper as the object itself.
            if (value != null && value.contains("\\\"ready\\\":true")) return;
            Thread.sleep(100);
        }
        throw new AssertionError("production Capacitor plugin did not become ready: " + value);
    }

    /** Waits for shipped app state/render functions, not merely document.readyState. */
    public void waitForShippedUiBootstrap() throws Exception {
        waitForScriptValue("typeof allChats!=='undefined'&&typeof showScreen==='function'"
            + "&&typeof renderMessages==='function'", "true");
    }

    /** Waits for shipped app state/render functions and the production poll/listener. */
    public void waitForShippedUiReady() throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        String value = null;
        while (System.nanoTime() < deadline) {
            value = evaluate("JSON.stringify({ui:typeof allChats!=='undefined'"
                + "&&typeof showScreen==='function'&&typeof renderMessages==='function',"
                + "listener:typeof nativeExecutionCompletedListenerReady!=='undefined'"
                + "&&nativeExecutionCompletedListenerReady===true,"
                + "poll:typeof nativeReplyPollTimer!=='undefined'&&nativeReplyPollTimer!==null})");
            if (value != null && value.contains("\\\"ui\\\":true")
                && value.contains("\\\"listener\\\":true")
                && value.contains("\\\"poll\\\":true")) return;
            Thread.sleep(100);
        }
        throw new AssertionError("shipped UI/poll milestone not observed: " + value);
    }

    /** Polls the real production plugin cursor until this turn is UI-applied. */
    public String waitForProductionUiApplied(String turnId) throws Exception {
        waitForProductionPluginReady();
        String expected = turnId.replace("\\", "\\\\").replace("'", "\\'");
        evaluate("(async()=>{const p=window.Capacitor?.Plugins?.AlExecution;"
            + "window.__yuqiConnectedApplied='';"
            + "if(!p){window.__yuqiConnectedApplied='missing-production-plugin';return;}"
            + "for(let i=0;i<240;i++){const result=await p.getConversationCursor({characterId:'yuqi'});"
            + "if(result?.uiAppliedTurnId==='" + expected + "'){window.__yuqiConnectedApplied='READY:'+result.uiAppliedTurnId;break;}"
            + "window.__yuqiConnectedApplied='WAIT:'+String(result?.uiAppliedTurnId||'');"
            + "await new Promise(resolve=>setTimeout(resolve,100));}})()");
        try {
            return waitForScriptContains(
                "window.__yuqiConnectedApplied || ''",
                "READY:" + turnId);
        } catch (AssertionError failure) {
            String debug = evaluate("JSON.stringify({marker:window.__yuqiConnectedApplied||null})");
            throw new AssertionError(failure.getMessage() + " debug=" + debug, failure);
        }
    }

    /** Navigate through shipped UI functions; it does not create or apply messages. */
    public void showYuqiChat() throws Exception {
        evaluate("currentCharId='yuqi';showScreen('chat');renderMessages({forceBottom:true});");
    }

    /** Reads the real plugin cursor so nullable keys are tested at the bridge boundary. */
    public String waitForConversationCursor(String characterId) throws Exception {
        String escaped = characterId.replace("\\", "\\\\").replace("'", "\\'");
        evaluate("(async()=>{try{const p=window.Capacitor?.Plugins?.AlExecution;"
            + "window.__yuqiConnectedCursorShape=JSON.stringify(await p.getConversationCursor({characterId:'"
            + escaped + "'}));}catch(e){window.__yuqiConnectedCursorShape=JSON.stringify({error:String(e)});}})()");
        String encoded = waitForScriptContains("window.__yuqiConnectedCursorShape || ''", "characterId");
        Object decoded = new JSONTokener(encoded).nextValue();
        return decoded instanceof String ? (String) decoded : encoded;
    }

    /** Clears only the shipped WebView's durable app state before a new case. */
    public void resetCaseWebState() throws Exception {
        resetCaseWebState("");
    }

    /** Clears the durable mirror and proves a stale scenario marker did not rehydrate. */
    public void resetCaseWebState(String staleScenarioMarker) throws Exception {
        evaluate("(async()=>{const sentinel='task25-reset-sentinel-'+Date.now()+'-'+Math.random().toString(16).slice(2);"
            + "window.__yuqiMirrorResetSeeded=false;window.__yuqiMirrorReset=false;"
            + "const prior=await MemoryDB.getMeta('app_state',null);"
            + "const base=prior&&typeof prior==='object'&&!Array.isArray(prior)?prior:{};"
            + "await MemoryDB.setMeta('app_state',{...base,__yuqiResetSentinel:sentinel});"
            + "const seeded=await MemoryDB.getMeta('app_state',null);"
            + "window.__yuqiMirrorResetSeeded=seeded?.__yuqiResetSentinel===sentinel;"
            + "if(!window.__yuqiMirrorResetSeeded)throw new Error('reset sentinel was not durably written');"
            + "await MemoryDB.remove('meta','app_state');localStorage.clear();sessionStorage.clear();"
            + "window.__yuqiMirrorReset=true;})() ");
        waitForScriptValue("window.__yuqiMirrorResetSeeded===true", "true");
        waitForScriptValue("window.__yuqiMirrorReset===true", "true");
        reload();
        waitForProductionPluginReady();
        waitForScriptValue("typeof ensureYuqiFirstAcquaintance", "\"function\"");
        evaluate("(async()=>{const state=await MemoryDB.getMeta('app_state',null);"
            + "window.__yuqiMirrorResetCheck=JSON.stringify(state||null);})()");
        waitForScriptValue("typeof window.__yuqiMirrorResetCheck!=='undefined'", "true");
        String encoded = evaluate("window.__yuqiMirrorResetCheck");
        Object decoded = new JSONTokener(encoded).nextValue();
        String snapshot = decoded instanceof String ? (String) decoded : encoded;
        if (snapshot.contains("__yuqiResetSentinel")
            || (staleScenarioMarker != null && !staleScenarioMarker.isEmpty() && snapshot.contains(staleScenarioMarker))) {
            throw new AssertionError("stale app_state mirror marker survived reset: " + staleScenarioMarker);
        }
    }

    public String chatLandingSummary(String turnId, String sourceMessageId) throws Exception {
        String turnJson = JSONObject.quote(turnId);
        String sourceJson = JSONObject.quote(sourceMessageId);
        return evaluate("JSON.stringify((()=>{const ms=allChats.yuqi?.messages||[];"
            + "const t=" + turnJson + ",s=" + sourceJson + ";"
            + "const assistant=ms.filter(m=>m.role==='assistant'&&m.sourceTurnId==='native:'+t);"
            + "const groups=new Set(assistant.map(m=>m.sourceTurnId)).size;"
            + "const dom=[...document.querySelectorAll('#chat-messages .msg-wrap:not(.me)')].filter(e=>e.textContent.includes('虞栖回复第1泡')).length;"
            + "return {assistant:assistant.length,groups,replyLinks:assistant.filter(m=>m.replyToMessageId===s).length,dom,source:ms.filter(m=>m.id===s).length};})())");
    }

    /** Structured, persisted WebView evidence; callers must parse the JSON. */
    public String chatLandingStructuredSummary(String turnId, String sourceMessageId) throws Exception {
        String turnJson = JSONObject.quote(turnId);
        String sourceJson = JSONObject.quote(sourceMessageId);
        String encoded = evaluate("JSON.stringify((()=>{const ms=allChats.yuqi?.messages||[];"
            + "const t=" + turnJson + ",s=" + sourceJson + ";"
            + "const assistant=ms.filter(m=>m.role==='assistant'&&m.sourceTurnId==='native:'+t);"
            + "const assistantIds=assistant.map(m=>m.id).sort();"
            + "const domIds=[...document.querySelectorAll('#chat-messages [data-message-id]')]"
            + ".map(e=>e.getAttribute('data-message-id')).filter(Boolean);"
            + "const domAssistantIds=domIds.filter(id=>assistantIds.includes(id)).sort();"
            + "const dom=domAssistantIds.length;"
            + "return {assistant:assistant.map(m=>({id:m.id,sourceTurnId:m.sourceTurnId,"
            + "sourceReplyPartId:m.sourceReplyPartId||null,replyToMessageId:m.replyToMessageId||null,"
            + "content:m.content||'',actions:Array.isArray(m.actions)?m.actions:[]})),"
            + "groups:[...new Set(assistant.map(m=>m.sourceTurnId))],"
            + "replyLinks:assistant.filter(m=>m.replyToMessageId===s).length,dom,domAssistantIds,assistantIds,"
            + "source:ms.filter(m=>m.id===s).map(m=>({id:m.id,content:m.content||''}))};})())");
        Object decoded = new JSONTokener(encoded).nextValue();
        return decoded instanceof String ? (String) decoded : encoded;
    }

    /** Read the durable MemoryDB app_state mirror, not only the live WebView globals. */
    public String memoryAppStateSummary(String turnId, String sourceMessageId) throws Exception {
        String turnJson = JSONObject.quote(turnId);
        String sourceJson = JSONObject.quote(sourceMessageId);
        evaluate("(async()=>{const state=await MemoryDB.getMeta('app_state',null);"
            + "const ms=state?.allChats?.yuqi?.messages||[];const t=" + turnJson + ",s=" + sourceJson + ";"
            + "const assistant=ms.filter(m=>m.role==='assistant'&&m.sourceTurnId==='native:'+t);"
            + "window.__yuqiMemoryAppStateSummary=JSON.stringify({updatedAt:Number(state?.updatedAt||0),"
            + "localUpdatedAt:Number(localStorage.getItem('rpchat_app_state_updated_at')||0),"
            + "assistantIds:assistant.map(m=>m.id).sort(),sourceIds:ms.filter(m=>m.id===s).map(m=>m.id)});})()");
        waitForScriptContains("window.__yuqiMemoryAppStateSummary||''", "assistantIds");
        String encoded = evaluate("window.__yuqiMemoryAppStateSummary");
        Object decoded = new JSONTokener(encoded).nextValue();
        return decoded instanceof String ? (String) decoded : encoded;
    }

    /** Hold only the mirror scheduler's outer app_state write; its real IndexedDB write still runs. */
    public void holdNextMemoryAppStateMirror() throws Exception {
        waitForProductionPluginReady();
        evaluate("(()=>{window.__yuqiMirrorHold={used:false,nativeWriteSettled:0,nativeWriteOk:0,outerSettled:0,"
            + "resolve:null,reject:null,durable:null,outerPromise:null,original:null};const original=MemoryDB.setMeta.bind(MemoryDB);"
            + "window.__yuqiMirrorHold.original=original;MemoryDB.setMeta=async function(key,value){"
            + "if(key!=='app_state')return original(key,value);"
            + "if(window.__yuqiMirrorHold.used)return window.__yuqiMirrorHold.outerPromise;"
            + "window.__yuqiMirrorHold.used=true;const durable=original(key,value);"
            + "window.__yuqiMirrorHold.durable=Promise.resolve(durable);"
            + "window.__yuqiMirrorHold.durable.then(()=>{window.__yuqiMirrorHold.nativeWriteSettled=1;"
            + "window.__yuqiMirrorHold.nativeWriteOk=1;},e=>{window.__yuqiMirrorHold.nativeWriteSettled=1;"
            + "window.__yuqiMirrorHold.nativeWriteOk=0;window.__yuqiMirrorHold.error=String(e);});"
            + "window.__yuqiMirrorHold.outerPromise=new Promise((resolve,reject)=>{window.__yuqiMirrorHold.resolve=resolve;"
            + "window.__yuqiMirrorHold.reject=reject;});return window.__yuqiMirrorHold.outerPromise;};})()")
            .trim();
        waitForScriptValue("window.__yuqiMirrorHold?.original!==null", "true");
    }

    public void waitForHeldMemoryAppStateUse() throws Exception {
        waitForScriptValue("window.__yuqiMirrorHold?.used===true", "true");
    }

    public void waitForHeldMemoryAppStateNativeWrite() throws Exception {
        waitForScriptValue("window.__yuqiMirrorHold?.nativeWriteSettled===1", "true");
    }

    public String heldMemoryAppStateState() throws Exception {
        String encoded = evaluate("JSON.stringify({used:!!window.__yuqiMirrorHold?.used,"
            + "nativeWriteSettled:Number(window.__yuqiMirrorHold?.nativeWriteSettled||0),"
            + "nativeWriteOk:Number(window.__yuqiMirrorHold?.nativeWriteOk||0),"
            + "error:window.__yuqiMirrorHold?.error||null,"
            + "outerSettled:Number(window.__yuqiMirrorHold?.outerSettled||0)})");
        Object decoded = new JSONTokener(encoded).nextValue();
        return decoded instanceof String ? (String) decoded : encoded;
    }

    public void releaseHeldMemoryAppStateMirror() throws Exception {
        evaluate("(()=>{const h=window.__yuqiMirrorHold;if(!h)return;"
            + "if(h.original)MemoryDB.setMeta=h.original;"
            + "Promise.resolve(h.durable).then(v=>{h.outerSettled=1;if(h.resolve)h.resolve(v);},"
            + "e=>{h.outerSettled=1;if(h.reject)h.reject(e);});window.__yuqiMirrorHoldRestored=true;})()")
            .trim();
        waitForScriptValue("window.__yuqiMirrorHoldRestored===true", "true");
    }

    /** Waits for the shipped UI to expose the exact assistant/DOM identity set. */
    public void waitForStructuredAssistantDom(String turnId, int expectedCount) throws Exception {
        String escaped = turnId.replace("\\", "\\\\").replace("'", "\\'");
        String script = "(()=>{const ms=allChats.yuqi?.messages||[];"
            + "const a=ms.filter(m=>m.role==='assistant'&&m.sourceTurnId==='native:'+'" + escaped + "');"
            + "const ids=a.map(m=>m.id).filter(Boolean);const idSet=new Set(ids);"
            + "const dom=[...document.querySelectorAll('#chat-messages [data-message-id]')]"
            + ".map(e=>e.getAttribute('data-message-id')).filter(id=>idSet.has(id));"
            + "return a.length===" + expectedCount + "&&ids.length===" + expectedCount
            + "&&idSet.size===" + expectedCount + "&&dom.length===" + expectedCount
            + "&&new Set(dom).size===" + expectedCount + "})()";
        try {
            waitForScriptValue(script, "true");
        } catch (AssertionError failure) {
            String debug = evaluate("JSON.stringify((()=>{const ms=typeof allChats!=='undefined'"
                + "?(allChats.yuqi?.messages||[]):[];const ids=ms.filter(m=>m.role==='assistant'"
                + "&&m.sourceTurnId==='native:'+'" + escaped + "').map(m=>m.id);"
                + "const dom=[...document.querySelectorAll('#chat-messages [data-message-id]')]"
                + ".map(e=>e.getAttribute('data-message-id')).filter(Boolean);"
                + "return {activeScreen:typeof activeScreen==='undefined'?null:activeScreen,"
                + "allChats:typeof allChats!=='undefined',assistantIds:ids,domIds:dom,"
                + "sourceStage:window.__yuqiConnectedSourceStage||null};})())");
            throw new AssertionError(failure.getMessage() + " debug=" + debug, failure);
        }
    }

    /** Start the shipped reconciliation function without waiting for its result. */
    public void startProductionReconcilePoll() throws Exception {
        waitForProductionPluginReady();
        evaluate("(async()=>{window.__yuqiConnectedReconcile='started';"
            + "try{window.__yuqiConnectedReconcileResult=await reconcileNativeReplyState();}"
            + "catch(e){window.__yuqiConnectedReconcile='error:'+String(e);}})()");
    }

    /** Test-only event/poll split: stop the shipped interval without replacing reconciliation. */
    public void suspendProductionReconcilePollForTest() throws Exception {
        evaluate("(()=>{if(typeof nativeReplyPollTimer!=='undefined'&&nativeReplyPollTimer)"
            + "clearInterval(nativeReplyPollTimer);nativeReplyPollTimer=null;"
            + "window.__yuqiConnectedPollSuspended=true;})()");
        waitForScriptValue("window.__yuqiConnectedPollSuspended===true"
            + "&&nativeReplyPollTimer===null", "true");
        waitForScriptValue("typeof nativeExecutionReconcilePromise==='undefined'"
            + "||nativeExecutionReconcilePromise===null", "true");
    }

    /** Observe the actual shipped reconciliation function, preserving its body and caller. */
    public void observeProductionReconcileCallsForTest() throws Exception {
        evaluate("(()=>{if(typeof reconcileNativeReplyState!=='function')"
            + "throw new Error('missing reconcileNativeReplyState');"
            + "const original=reconcileNativeReplyState;window.__yuqiConnectedReconcileObserver="
            + "{count:0,original};reconcileNativeReplyState=async function(){"
            + "window.__yuqiConnectedReconcileObserver.count++;"
            + "return original.apply(this,arguments);};})()");
        waitForScriptValue("window.__yuqiConnectedReconcileObserver?.original!==undefined", "true");
    }

    public void waitForProductionReconcileCallCount(int expected) throws Exception {
        waitForScriptValue("Number(window.__yuqiConnectedReconcileObserver?.count||0)>=" + expected,
            "true");
    }

    /** Resume the actual shipped interval; no direct reconciliation call is substituted. */
    public void resumeProductionReconcilePollForTest() throws Exception {
        evaluate("(()=>{if(typeof startNativeReplyPolling!=='function')"
            + "throw new Error('missing startNativeReplyPolling');"
            + "startNativeReplyPolling();window.__yuqiConnectedPollResumed=true;})()");
        waitForScriptValue("window.__yuqiConnectedPollResumed===true&&nativeReplyPollTimer!==null", "true");
    }

    /**
     * Observe the actual Capacitor executionCompleted dispatch boundary.  This
     * installs a real plugin listener in the WebView; it does not increment a
     * counter from notifyCompletedTurn or from a native test callback.
     */
    public void observeExecutionCompletedEvents(String targetTurnId) throws Exception {
        String target = JSONObject.quote(targetTurnId);
        evaluate("(async()=>{const p=window.Capacitor?.Plugins?.AlExecution;"
            + "if(!p?.addListener)throw new Error('missing AlExecution.addListener');"
            + "window.__yuqiExecutionEvents={target:" + target + ",count:0,ready:false,error:null,enabled:true};"
            + "try{await p.addListener('executionCompleted',payload=>{"
            + "if(window.__yuqiExecutionEvents?.enabled){const eventTurnId=payload?.turnId||payload?.data?.turnId||null;"
            + "if(!eventTurnId||String(eventTurnId)===window.__yuqiExecutionEvents.target){"
            + "window.__yuqiExecutionEvents.count++;window.__yuqiExecutionEvents.payload=payload;}}});"
            + "window.__yuqiExecutionEvents.ready=true;}catch(error){"
            + "window.__yuqiExecutionEvents.error=String(error);window.__yuqiExecutionEvents.ready=true;}})()")
            .trim();
        waitForScriptValue("window.__yuqiExecutionEvents?.ready===true", "true");
        String state = evaluate("JSON.stringify(window.__yuqiExecutionEvents||null)");
        String error = evaluate("String(window.__yuqiExecutionEvents?.error||'')");
        if (error != null && !error.isEmpty() && !"\"\"".equals(error)) {
            throw new AssertionError("executionCompleted listener failed: " + state);
        }
    }

    public void waitForExecutionCompletedEventCount(int expected) throws Exception {
        waitForScriptValue("Number(window.__yuqiExecutionEvents?.count||0)===" + expected, "true");
    }

    public int executionCompletedEventCount() throws Exception {
        String value = evaluate("String(Number(window.__yuqiExecutionEvents?.count||0))");
        return Integer.parseInt(value.replace("\"", "").trim());
    }

    public void clearExecutionCompletedEventObserver() throws Exception {
        evaluate("if(window.__yuqiExecutionEvents)window.__yuqiExecutionEvents.enabled=false;");
    }

    /**
     * Hold the first real getTurn bridge call made by production reconciliation.
     * Capacitor's Plugins object is a Proxy, so replacing p.getTurn is not a
     * reliable seam.  The shipped global nativeBridgeCall is the narrow seam:
     * the plugin still creates the real native Promise, while only the outer
     * bridge Promise is held for this one call.
     */
    public void holdNextNativeBridgeGetTurn(String turnId) throws Exception {
        String turnJson = JSONObject.quote(turnId);
        evaluate("(()=>{if(typeof window.nativeBridgeCall!=='function')"
            + "throw new Error('missing nativeBridgeCall');"
            + "const original=window.nativeBridgeCall,target=" + turnJson + ";"
            + "window.__yuqiHeld={target,used:false,settled:0,nativeSettled:0,nativeValue:null,"
            + "nativeError:null,resolve:null,reject:null,original};"
            + "window.nativeBridgeCall=(promise,label,timeoutMs)=>{"
            + "const checked=original(promise,label,timeoutMs);"
            + "if(label!=='getTurn'||window.__yuqiHeld.used)return checked;"
            + "return new Promise((resolve,reject)=>{checked.then(value=>{"
            + "if(String(value?.turnId||'')!==target){resolve(value);return;}"
            + "window.__yuqiHeld.used=true;window.__yuqiHeld.nativePromise=checked;"
            + "window.__yuqiHeld.nativeSettled=1;window.__yuqiHeld.nativeValue=value;"
            + "window.__yuqiHeld.resolve=v=>{window.__yuqiHeld.settled++;resolve(v);};"
            + "window.__yuqiHeld.reject=e=>{window.__yuqiHeld.settled++;reject(e);};"
            + "},error=>{reject(error);});});};"
            + "window.__yuqiHeldStarted=true;})()");
        waitForScriptValue("window.__yuqiHeldStarted===true", "true");
    }

    /**
     * Holds the first production inbox call behind the real native bridge
     * timeout.  The plugin promise remains the real promise and is observed for
     * a late settle, while a separate pending promise is the one passed to the
     * shipped timeout wrapper; no inbox result can be applied during the hold.
     */
    public void holdNextNativeBridgeUnappliedCompletedTurns() throws Exception {
        evaluate("(()=>{if(typeof window.nativeBridgeCall!=='function')"
            + "throw new Error('missing nativeBridgeCall');const original=window.nativeBridgeCall;"
            + "window.__yuqiHeldInbox={used:false,nativeSettled:0,outerSettled:0,timedOut:false,"
            + "startedAt:null,timeoutMs:null,timedOutAt:null,outerSettledAt:null,nativeValue:null,nativeError:null,"
            + "original,release:null};"
            + "window.nativeBridgeCall=(promise,label,timeoutMs)=>{"
            + "if(label!=='unappliedCompletedTurns'||window.__yuqiHeldInbox.used)"
            + "return original(promise,label,timeoutMs);"
            + "window.__yuqiHeldInbox.used=true;window.__yuqiHeldInbox.startedAt=Date.now();"
            + "window.__yuqiHeldInbox.timeoutMs=Number(timeoutMs||8000);"
            + "const held=new Promise((resolve,reject)=>{window.__yuqiHeldInbox.release=resolve;"
            + "promise.then(value=>{window.__yuqiHeldInbox.nativeSettled=1;"
            + "window.__yuqiHeldInbox.nativeValue=value;},error=>{window.__yuqiHeldInbox.nativeSettled=1;"
            + "window.__yuqiHeldInbox.nativeError=String(error);});});"
            + "const outer=original(held,label,timeoutMs);"
            + "outer.then(()=>{window.__yuqiHeldInbox.outerSettled=1;window.__yuqiHeldInbox.outerSettledAt=Date.now();},error=>{"
            + "window.__yuqiHeldInbox.outerSettled=1;window.__yuqiHeldInbox.outerSettledAt=Date.now();window.__yuqiHeldInbox.timedOut="
            + "String(error?.message||'').includes('timed out');if(window.__yuqiHeldInbox.timedOut)"
            + "window.__yuqiHeldInbox.timedOutAt=Date.now();});return outer;};"
            + "window.__yuqiHeldInboxStarted=true;})()");
        waitForScriptValue("window.__yuqiHeldInboxStarted===true", "true");
    }

    public void waitForHeldNativeInboxUse() throws Exception {
        waitForScriptValue("window.__yuqiHeldInbox?.used===true", "true");
    }

    public void waitForHeldNativeInboxNativeSettled() throws Exception {
        waitForScriptValue("window.__yuqiHeldInbox?.nativeSettled===1", "true");
    }

    public void waitForHeldNativeInboxTimeout() throws Exception {
        waitForScriptValue("window.__yuqiHeldInbox?.outerSettled===1&&window.__yuqiHeldInbox?.timedOut===true", "true");
    }

    public String heldNativeInboxState() throws Exception {
        String encoded = evaluate("JSON.stringify({used:!!window.__yuqiHeldInbox?.used,"
            + "nativeSettled:Number(window.__yuqiHeldInbox?.nativeSettled||0),"
            + "outerSettled:Number(window.__yuqiHeldInbox?.outerSettled||0),"
            + "timedOut:!!window.__yuqiHeldInbox?.timedOut,startedAt:Number(window.__yuqiHeldInbox?.startedAt||0),"
            + "timeoutMs:Number(window.__yuqiHeldInbox?.timeoutMs||0),"
            + "timedOutAt:Number(window.__yuqiHeldInbox?.timedOutAt||0),"
            + "outerSettledAt:Number(window.__yuqiHeldInbox?.outerSettledAt||0)})");
        Object decoded = new JSONTokener(encoded).nextValue();
        return decoded instanceof String ? (String) decoded : encoded;
    }

    /** Hold the real UI acknowledgement after production has inserted messages. */
    public void holdNextNativeBridgeAcknowledgeUiApplied(String turnId) throws Exception {
        waitForProductionPluginReady();
        String turnJson = JSONObject.quote(turnId);
        evaluate("(()=>{window.__yuqiAckHeldError=null;const target=" + turnJson + ";"
            + "window.__yuqiAckHeld={target,used:false,settled:0,nativeSettled:0,"
            + "resolve:null,reject:null,original:null,factoryOriginal:null};"
            + "if(typeof acknowledgeNativeUiAppliedOnce==='function'){"
            + "const original=acknowledgeNativeUiAppliedOnce;window.__yuqiAckHeld.original=original;"
            + "acknowledgeNativeUiAppliedOnce=async(plugin,result)=>{"
            + "if(String(result?.turnId||'')!==target||window.__yuqiAckHeld.used)"
            + "return original(plugin,result);"
            + "window.__yuqiAckHeld.used=true;"
            + "return new Promise((resolve,reject)=>{window.__yuqiAckHeld.resolve=v=>{"
            + "window.__yuqiAckHeld.settled++;resolve(v);};window.__yuqiAckHeld.reject=e=>{"
            + "window.__yuqiAckHeld.settled++;reject(e);};});};"
            + "}else if(typeof nativeExecutionPlugin==='function'){"
            + "const factoryOriginal=nativeExecutionPlugin;window.__yuqiAckHeld.factoryOriginal=factoryOriginal;"
            + "nativeExecutionPlugin=()=>{const plugin=factoryOriginal();if(!plugin)return plugin;"
            + "const facade=Object.create(plugin);Object.defineProperty(facade,'acknowledgeUiApplied',{"
            + "configurable:true,value:async payload=>{if(String(payload?.turnId||'')!==target||window.__yuqiAckHeld.used)"
            + "return plugin.acknowledgeUiApplied(payload);window.__yuqiAckHeld.used=true;"
            + "return new Promise((resolve,reject)=>{window.__yuqiAckHeld.resolve=v=>{window.__yuqiAckHeld.settled++;resolve(v);};"
            + "window.__yuqiAckHeld.reject=e=>{window.__yuqiAckHeld.settled++;reject(e);};});}});return facade;};"
            + "}else{window.__yuqiAckHeldError='missing acknowledgeNativeUiAppliedOnce and nativeExecutionPlugin';"
            + "throw new Error(window.__yuqiAckHeldError);}window.__yuqiAckHeldStarted=true;})()")
            .trim();
        try {
            waitForScriptValue("window.__yuqiAckHeldStarted===true", "true");
        } catch (AssertionError failure) {
            String debug = evaluate("JSON.stringify({started:window.__yuqiAckHeldStarted||false,"
                + "has:typeof acknowledgeNativeUiAppliedOnce,factory:typeof nativeExecutionPlugin,"
                + "error:window.__yuqiAckHeldError||null,ready:document.readyState})");
            throw new AssertionError(failure.getMessage() + " debug=" + debug, failure);
        }
    }

    /** Observe the production ACK call and immediately forward it unchanged. */
    public void observeNextNativeBridgeAcknowledgeUiApplied(String turnId) throws Exception {
        waitForProductionPluginReady();
        String turnJson = JSONObject.quote(turnId);
        evaluate("(()=>{const target=" + turnJson + ";window.__yuqiAckObserved={target,used:false,forwarded:0,"
            + "nativeSettled:0,"
            + "original:null};if(typeof acknowledgeNativeUiAppliedOnce==='function'){"
            + "const original=acknowledgeNativeUiAppliedOnce;window.__yuqiAckObserved.original=original;"
            + "acknowledgeNativeUiAppliedOnce=async(plugin,result)=>{"
            + "const matches=String(result?.turnId||'')===target&&!window.__yuqiAckObserved.used;"
            + "if(matches)window.__yuqiAckObserved.used=true;const forwarded=original(plugin,result);"
            + "if(matches){window.__yuqiAckObserved.forwarded++;Promise.resolve(forwarded).then(()=>"
            + "window.__yuqiAckObserved.nativeSettled++,()=>window.__yuqiAckObserved.nativeSettled++);}return forwarded;};"
            + "}else{throw new Error('missing acknowledgeNativeUiAppliedOnce');}})()")
            .trim();
        waitForScriptValue("window.__yuqiAckObserved?.target===" + turnJson, "true");
    }

    public void waitForObservedNativeAcknowledgementUse() throws Exception {
        waitForScriptValue("window.__yuqiAckObserved?.used===true", "true");
    }

    public String observedNativeAcknowledgementState() throws Exception {
        String encoded = evaluate("JSON.stringify({target:window.__yuqiAckObserved?.target||null,"
            + "used:!!window.__yuqiAckObserved?.used,forwarded:Number(window.__yuqiAckObserved?.forwarded||0),"
            + "nativeSettled:Number(window.__yuqiAckObserved?.nativeSettled||0)})");
        Object decoded = new JSONTokener(encoded).nextValue();
        return decoded instanceof String ? (String) decoded : encoded;
    }

    /** Count every matching production ACK call; the original implementation is always forwarded. */
    public void observeNativeBridgeAcknowledgeUiAppliedCallsForTest(String turnId) throws Exception {
        waitForProductionPluginReady();
        String turnJson = JSONObject.quote(turnId);
        evaluate("(()=>{if(typeof acknowledgeNativeUiAppliedOnce!=='function')"
            + "throw new Error('missing acknowledgeNativeUiAppliedOnce');"
            + "const original=acknowledgeNativeUiAppliedOnce;window.__yuqiAckCountObserver="
            + "{target:" + turnJson + ",count:0,original};"
            + "acknowledgeNativeUiAppliedOnce=async function(plugin,result){"
            + "if(String(result?.turnId||'')===window.__yuqiAckCountObserver.target)"
            + "window.__yuqiAckCountObserver.count++;"
            + "return original.apply(this,arguments);};})()");
        waitForScriptValue("window.__yuqiAckCountObserver?.original!==undefined", "true");
    }

    public void waitForNativeBridgeAcknowledgeUiAppliedCallCount(int expected) throws Exception {
        waitForScriptValue("Number(window.__yuqiAckCountObserver?.count||0)>=" + expected, "true");
    }

    public int nativeBridgeAcknowledgeUiAppliedCallCount() throws Exception {
        String value = evaluate("String(Number(window.__yuqiAckCountObserver?.count||0))");
        return Integer.parseInt(value.replace("\"", "").trim());
    }

    public void waitForHeldNativeAcknowledgementUse() throws Exception {
        waitForScriptValue("window.__yuqiAckHeld?.used===true", "true");
    }

    public void waitForHeldNativeAcknowledgementSettled() throws Exception {
        waitForScriptValue("window.__yuqiAckHeld?.nativeSettled===1", "true");
    }

    public String heldNativeAcknowledgementState() throws Exception {
        String encoded = evaluate("JSON.stringify({target:window.__yuqiAckHeld?.target||null,"
            + "used:!!window.__yuqiAckHeld?.used,settled:Number(window.__yuqiAckHeld?.settled||0),"
            + "nativeSettled:Number(window.__yuqiAckHeld?.nativeSettled||0)})");
        Object decoded = new JSONTokener(encoded).nextValue();
        return decoded instanceof String ? (String) decoded : encoded;
    }

    public void releaseHeldNativeAcknowledgement() throws Exception {
        evaluate("(()=>{if(window.__yuqiAckHeld?.original)acknowledgeNativeUiAppliedOnce="
            + "window.__yuqiAckHeld.original; if(window.__yuqiAckHeld?.resolve)"
            + "window.__yuqiAckHeld.resolve(true);"
            + "window.__yuqiAckHeldRestored=true;})()")
            .trim();
        waitForScriptValue("window.__yuqiAckHeldRestored===true", "true");
    }

    /** Restore the old page's function without resolving its intentionally stale promise. */
    public void restoreHeldNativeAcknowledgementCallOnly() throws Exception {
        evaluate("(()=>{if(window.__yuqiAckHeld?.original)acknowledgeNativeUiAppliedOnce="
            + "window.__yuqiAckHeld.original;window.__yuqiAckHeldRestored=true;})()")
            .trim();
        waitForScriptValue("window.__yuqiAckHeldRestored===true", "true");
    }

    public void waitForHeldNativeBridgeUse() throws Exception {
        waitForScriptValue("window.__yuqiHeld?.used===true", "true");
    }

    public void waitForHeldNativeBridgeSettled() throws Exception {
        waitForScriptValue("window.__yuqiHeld?.nativeSettled===1", "true");
    }

    public String heldPluginState() throws Exception {
        String encoded = evaluate("JSON.stringify({started:!!window.__yuqiHeldStarted,used:!!window.__yuqiHeld?.used,"
            + "settled:Number(window.__yuqiHeld?.settled||0),nativeSettled:Number(window.__yuqiHeld?.nativeSettled||0)})");
        Object decoded = new JSONTokener(encoded).nextValue();
        return decoded instanceof String ? (String) decoded : encoded;
    }

    /** Restore the shipped bridge helper while the old WebView context is alive. */
    public void restoreHeldNativeBridgeCall() throws Exception {
        evaluate("(()=>{if(window.__yuqiHeld?.original)window.nativeBridgeCall=window.__yuqiHeld.original;"
            + "if(window.__yuqiHeldInbox?.original)window.nativeBridgeCall=window.__yuqiHeldInbox.original;"
            + "window.__yuqiHeldRestored=true;})()");
    }

    /**
     * Seeds the real shipped chat state through its own batch/message helpers so
     * the persisted Room result has a user message that production reconciliation
     * can own.  This is not a plugin or Room fallback: the next reload exercises
     * the normal native cursor/event/poll/UI path against the shipped WebView.
     */
    public void prepareCanonicalSourceMessage(String characterId, String messageId,
        String content) throws Exception {
        waitForScriptValue("typeof ensureYuqiFirstAcquaintance", "\"function\"");
        waitForShippedUiBootstrap();
        evaluate("window.__yuqiConnectedSourceStage={started:true,dbCharacters:'not_started',"
            + "dbChats:'not_started',mirror:'not_started',render:'not_started',error:null};true");
        String charJson = JSONObject.quote(characterId);
        String messageJson = JSONObject.quote(messageId);
        String contentJson = JSONObject.quote(content);
        evaluate("(async()=>{const charId=" + charJson + ",messageId=" + messageJson
            + ",content=" + contentJson + ";"
            + "await new Promise((resolve,reject)=>{const deadline=Date.now()+30000;"
            + "const check=()=>{if(typeof ensureYuqiFirstAcquaintance==='function')return resolve();"
            + "if(Date.now()>=deadline)return reject(new Error('shipped character bootstrap unavailable'));"
            + "setTimeout(check,50);};check();});"
            + "ensureYuqiFirstAcquaintance();"
            + "const chat=allChats[charId]||(allChats[charId]={"
            + "messages:[],charPrompt:'',extraPrompt:'',unread:0});"
            + "if(typeof stagePlayerMessage!=='function'||typeof commitStagedBatch!=='function')"
            + "throw new Error('shipped chat batch helpers unavailable');"
            + "window.__yuqiConnectedSourceStage={started:true,dbCharacters:'pending',dbChats:'pending',"
            + "mirror:'not_started',render:'not_started',error:null};"
            + "stagePlayerMessage(chat,content,{id:messageId},Date.now());"
            + "commitStagedBatch(chat,Date.now());DB.set('characters',characters);"
            + "window.__yuqiConnectedSourceStage.dbCharacters='done';DB.set('chats',allChats);"
            + "window.__yuqiConnectedSourceStage.dbChats='done';"
            + "if(typeof mirrorAppStateNow==='function'){window.__yuqiConnectedSourceStage.mirror='started';"
            + "try{await mirrorAppStateNow();window.__yuqiConnectedSourceStage.mirror='done';}"
            + "catch(e){window.__yuqiConnectedSourceStage.mirror='error';window.__yuqiConnectedSourceStage.error=String(e);throw e;}}"
            + "currentCharId=charId;showScreen('chat');renderMessages({forceBottom:true});"
            + "window.__yuqiConnectedSourceStage.render='done';"
            + "window.__yuqiConnectedSource=JSON.stringify({ok:true,messageId,character:!!characters.find(c=>c.id===charId),messages:chat.messages.length,stage:window.__yuqiConnectedSourceStage});})()"
            + ".catch(e=>{window.__yuqiConnectedSourceStage=window.__yuqiConnectedSourceStage||{};"
            + "window.__yuqiConnectedSourceStage.error=String(e);window.__yuqiConnectedSource=JSON.stringify({ok:false,error:String(e),stage:window.__yuqiConnectedSourceStage});})");
        try {
            waitForScriptContains("window.__yuqiConnectedSource || ''", "\\\"ok\\\":true");
        } catch (AssertionError failure) {
            String debug = evaluate("JSON.stringify({result:window.__yuqiConnectedSource||null,"
                + "stage:window.__yuqiConnectedSourceStage||null})");
            throw new AssertionError(failure.getMessage() + " debug=" + debug, failure);
        }
    }

    public void reload() throws Exception {
        reloadDocumentForRoomAckRace();
        waitForReloadCursorHandshake();
    }

    /** Reload only to a fresh document; callers may release a Room barrier before cursor reads. */
    public void reloadDocumentForRoomAckRace() throws Exception {
        String token = "yuqi-reload-" + System.nanoTime();
        String generation = "yuqi-generation-" + System.nanoTime();
        String tokenJson = JSONObject.quote(token);
        String generationJson = JSONObject.quote(generation);
        evaluate("window.__yuqiHarnessReloadToken=" + tokenJson + ";true");
        scenario.onActivity(activity -> activity.getBridge().getWebView().reload());
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        String value = null;
        while (System.nanoTime() < deadline) {
            try {
                value = evaluate("typeof window.__yuqiHarnessReloadToken==='undefined'");
                if ("true".equals(value)) break;
            } catch (Exception ignored) {
                // During navigation evaluateJavascript may briefly have no page;
                // the token-absence loop is the lifecycle barrier, not a delay.
            }
            Thread.sleep(100);
        }
        if (!"true".equals(value)) {
            throw new AssertionError("fresh WebView document was not observed after reload: " + value);
        }
        waitForProductionPluginReady();
        waitForShippedUiBootstrap();
        evaluate("window.__yuqiHarnessGeneration=" + generationJson + ";true");
        waitForScriptValue("window.__yuqiHarnessGeneration===" + generationJson, "true");
    }

    public void waitForReloadCursorHandshake() throws Exception {
        JSONObject cursor = new JSONObject(waitForConversationCursor("yuqi"));
        Set<String> expected = new HashSet<>();
        expected.add("characterId");
        expected.add("nativeCompletedTurnId");
        expected.add("nativeCompletedGroupId");
        expected.add("nativeCompletedSequence");
        expected.add("uiAppliedTurnId");
        expected.add("uiAppliedGroupId");
        expected.add("uiAppliedSequence");
        expected.add("localSequence");
        expected.add("clearedThroughSequence");
        expected.add("clearEpoch");
        expected.add("clearedAt");
        expected.add("chatOpen");
        expected.add("updatedAt");
        expected.add("cursorChecksum");
        Set<String> actual = new HashSet<>();
        for (java.util.Iterator<String> it = cursor.keys(); it.hasNext();) actual.add(it.next());
        if (!expected.equals(actual)) throw new AssertionError("cursor handshake keys mismatch: " + actual);
        if (!"yuqi".equals(cursor.optString("characterId"))) {
            throw new AssertionError("cursor handshake character mismatch: " + cursor);
        }
        String checksum = cursor.optString("cursorChecksum", "");
        if (!checksum.matches("[0-9a-f]{64}")) {
            throw new AssertionError("cursor handshake checksum mismatch: " + checksum);
        }
    }

    @Override public void close() {
        scenario.close();
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
    }
}
