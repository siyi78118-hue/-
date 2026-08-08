import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

process.env.TZ = 'Asia/Shanghai';

const html = readFileSync('tavern-app/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
const apiEndpointHelper = readFileSync('tavern-app/lib/api-endpoint.js', 'utf8');
const rolePlanDomain = readFileSync('tavern-app/lib/role-plan-domain.js', 'utf8');
const liveDirectorHelper = readFileSync('tavern-app/lib/live-chat-director.js', 'utf8');
assert.ok(script, 'index.html should contain an inline app script');
assert.match(html, /<script src="\.\/lib\/live-chat-director\.js"><\/script>/);
const swScript = readFileSync('tavern-app/sw-v11.js', 'utf8');
assert.match(swScript, /importScripts\('\.\/lib\/live-chat-director\.js'\)/);
assert.match(swScript, /'\.\/lib\/live-chat-director\.js'/);
assert.match(swScript, /live-director-card/);
assert.match(swScript, /ensureBackgroundReplyQuality/);
assert.match(swScript, /if \(String\(scene \|\| ''\)\.includes\('moment'\)\)[\s\S]{0,600}includeDirector: false/);
assert.doesNotMatch(
  swScript.slice(swScript.indexOf('function buildBackgroundMomentPostSystem'), swScript.indexOf('async function callModel')),
  /live-director-card/
);
const cloudTimerWorker = readFileSync('cloud-timer-worker.js', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const cloudTimerDeployDoc = readFileSync('CLOUD_TIMER_DEPLOY.md', 'utf8');
const cloudTimerHealthScript = readFileSync('scripts/check-cloud-timer.mjs', 'utf8');
const cloudTimerDeployScript = readFileSync('scripts/deploy-cloud-timer.mjs', 'utf8');
const wranglerRunScript = readFileSync('scripts/run-wrangler.mjs', 'utf8');
const wranglerInvocationScript = readFileSync('scripts/wrangler-invocation.mjs', 'utf8');
const capacitorConfig = JSON.parse(readFileSync('capacitor.config.json', 'utf8'));
const androidManifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
const androidBuildGradle = readFileSync('android/app/build.gradle', 'utf8');
const androidCapacitorBuildGradle = readFileSync('android/app/capacitor.build.gradle', 'utf8');
const androidVariablesGradle = readFileSync('android/variables.gradle', 'utf8');
const androidWorkflow = readFileSync('.github/workflows/android-apk.yml', 'utf8');
const androidFcmService = readFileSync('android/app/src/main/java/com/siyi/al/AlFirebaseMessagingService.java', 'utf8');
const androidMainActivity = readFileSync('android/app/src/main/java/com/siyi/al/MainActivity.java', 'utf8');
const androidReplyQueuePath = 'android/app/src/main/java/com/siyi/al/AlReplyQueuePlugin.java';
const androidReplyQueuePlugin = existsSync(androidReplyQueuePath) ? readFileSync(androidReplyQueuePath, 'utf8') : '';
const nativeBackgroundRunnerPath = 'tavern-app/runners/al-background.js';
const executionDbPath = 'android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java';
const executionDaoPath = 'android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java';
const executionStorePath = 'android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java';
const secretStorePath = 'android/app/src/main/java/com/siyi/al/execution/secure/AlSecretStore.java';
const executionServicePath = 'android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java';
const notificationFactoryPath = 'android/app/src/main/java/com/siyi/al/execution/AlNotificationFactory.java';
const retryPolicyPath = 'android/app/src/main/java/com/siyi/al/execution/RetryPolicy.java';
const bootReceiverPath = 'android/app/src/main/java/com/siyi/al/execution/AlBootReceiver.java';
const executionPluginPath = 'android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java';
const rolePlanEntityPath = 'android/app/src/main/java/com/siyi/al/execution/db/RolePlanEntity.java';
const rolePlanHistoryEntityPath = 'android/app/src/main/java/com/siyi/al/execution/db/RolePlanHistoryEntity.java';
assert.match(androidVariablesGradle, /roomVersion\s*=\s*'2\.8\.4'/);
assert.match(androidBuildGradle, /androidx\.room:room-runtime:\$roomVersion/);
assert.match(androidBuildGradle, /annotationProcessor\s+"androidx\.room:room-compiler:\$roomVersion"/);
assert.ok(existsSync(executionDbPath), 'native execution Room database should exist');
assert.ok(existsSync(executionDaoPath), 'native execution DAO should exist');
assert.ok(existsSync(executionStorePath), 'atomic native execution store should exist');
assert.ok(existsSync(secretStorePath), 'native encrypted API secret store should exist');
assert.ok(existsSync(executionServicePath), 'sticky native execution service should exist');
assert.ok(existsSync(bootReceiverPath), 'boot recovery receiver should exist');
assert.ok(existsSync(executionPluginPath), 'native execution Capacitor bridge should exist');
assert.ok(existsSync(rolePlanEntityPath), 'role plans should survive WebView restarts in Room');
assert.ok(existsSync(rolePlanHistoryEntityPath), 'role plan mutations should retain local history in Room');
const executionDao = existsSync(executionDaoPath) ? readFileSync(executionDaoPath, 'utf8') : '';
const executionStore = existsSync(executionStorePath) ? readFileSync(executionStorePath, 'utf8') : '';
const secretStore = existsSync(secretStorePath) ? readFileSync(secretStorePath, 'utf8') : '';
const executionService = existsSync(executionServicePath) ? readFileSync(executionServicePath, 'utf8') : '';
const notificationFactory = existsSync(notificationFactoryPath) ? readFileSync(notificationFactoryPath, 'utf8') : '';
const retryPolicy = existsSync(retryPolicyPath) ? readFileSync(retryPolicyPath, 'utf8') : '';
const executionPlugin = existsSync(executionPluginPath) ? readFileSync(executionPluginPath, 'utf8') : '';
assert.match(executionDao, /@Transaction[\s\S]*commitReply/);
assert.match(executionStore, /activeAttemptId[\s\S]*StaleAttemptException/);
assert.match(executionStore, /startRetry\(String turnId/);
assert.match(secretStore, /al\.execution\.secrets\.v1/);
assert.match(secretStore, /AES\/GCM\/NoPadding/);
assert.match(secretStore, /AndroidKeyStore/);
assert.match(androidManifest, /android\.permission\.FOREGROUND_SERVICE/);
assert.match(androidManifest, /android\.permission\.FOREGROUND_SERVICE_SPECIAL_USE/);
assert.match(androidManifest, /android\.permission\.RECEIVE_BOOT_COMPLETED/);
assert.match(androidManifest, /android\.permission\.WAKE_LOCK/);
assert.match(androidManifest, /AlExecutionService[\s\S]*foregroundServiceType="specialUse"/);
assert.match(androidManifest, /PROPERTY_SPECIAL_USE_FGS_SUBTYPE/);
assert.match(androidManifest, /AlBootReceiver[\s\S]*BOOT_COMPLETED/);
assert.match(executionService, /START_STICKY/);
assert.match(executionService, /newSingleThreadExecutor/);
assert.match(executionService, /WakeLock/);
assert.match(executionService, /notifyCompletedTurns/);
assert.match(executionService, /completedTurns\(/);
assert.match(executionService, /messageNotification\(/);
assert.match(notificationFactory, /AlNotificationPolicy\.MESSAGE_CHANNEL/, 'completed messages must use the fresh versioned channel');
assert.match(notificationFactory, /AlNotificationPolicy\.PROGRESS_CHANNEL/, 'generation progress must use its own silent channel');
assert.match(notificationFactory, /RingtoneManager\.getDefaultUri\(RingtoneManager\.TYPE_NOTIFICATION\)/, 'completed messages must explicitly use the system notification sound');
assert.match(notificationFactory, /enableVibration\(true\)/, 'completed messages must explicitly vibrate');
assert.match(notificationFactory, /setLockscreenVisibility\(AlNotificationPolicy\.messageVisibility\(\)\)/, 'completed message channel must be public on the lock screen');
assert.match(notificationFactory, /setSound\(null,\s*null\)/, 'generation progress channel must stay silent');
assert.match(notificationFactory, /setVisibility\(NotificationCompat\.VISIBILITY_PUBLIC\)/, 'completed message notifications must expose their content on the lock screen');
assert.match(executionService, /acknowledgeCloudTurn\(/, 'completed native cloud turns must acknowledge the Worker');
assert.match(executionService, /\/ack/, 'native cloud acknowledgement must use the Worker ack endpoint');
assert.match(executionService, /continueRolePlan\(/, 'recurring role plans must schedule their next occurrence without reopening the WebView');
assert.match(executionService, /ROLE_PLAN_MOMENT/, 'role-plan moment acknowledgements must retain their output kind');
assert.match(androidMainActivity, /registerPlugin\(AlExecutionPlugin\.class\)/);
assert.equal(packageJson.dependencies?.['@capacitor/background-runner'], undefined, 'unstable QuickJS background runner must not ship beside the Room execution engine');
assert.equal(capacitorConfig.plugins?.BackgroundRunner, undefined, 'Capacitor config must not instantiate the retired QuickJS runner');
assert.doesNotMatch(androidCapacitorBuildGradle, /capacitor-background-runner/, 'Android build must not package libJSEngine from the retired runner');
assert.doesNotMatch(androidMainActivity, /AlReplyQueuePlugin/, 'MainActivity must not register the retired runner queue');
assert.equal(existsSync(androidReplyQueuePath), false, 'retired RunnerWorker bridge must be removed');
assert.equal(existsSync(nativeBackgroundRunnerPath), false, 'retired QuickJS runner source must be removed');
assert.doesNotMatch(html, /nativeBackgroundRunner|syncNativeBackgroundState|restoreNativeBackgroundState/, 'web state mirroring must not dispatch into the retired QuickJS runtime');
assert.match(executionPlugin, /@CapacitorPlugin\(name\s*=\s*"AlExecution"\)/);
assert.doesNotMatch(executionPlugin, /clearAutomaticTasks[\s\S]{0,900}stopService\(/, 'clearing automatic tasks must not stop the 24-hour background guard');
for (const method of ['saveApiConfig', 'removeApiConfig', 'saveBridgeConfig', 'loadBridgeConfig', 'yuqiBridgeStatus', 'saveYuqiAnnotation', 'saveProactiveSnapshot', 'submitTurn', 'retryTurn', 'cancelTurn', 'getTurn', 'changesSince', 'unappliedCompletedTurns', 'recentCompletedTurns', 'acknowledgeUiApplied', 'getConversationCursor', 'createConversationClear', 'nativeDiagnostics', 'notificationStatus', 'openNotificationSettings', 'listRolePlans', 'replaceRolePlans', 'rolePlanHistory']) {
  assert.match(executionPlugin, new RegExp(`void\\s+${method}\\(PluginCall call\\)`), `AlExecution must expose ${method}`);
}
assert.match(readFileSync(executionDbPath, 'utf8'), /version\s*=\s*13[\s\S]*MIGRATION_2_3[\s\S]*MIGRATION_3_4[\s\S]*MIGRATION_4_5[\s\S]*MIGRATION_5_6[\s\S]*MIGRATION_6_7[\s\S]*MIGRATION_7_8[\s\S]*MIGRATION_8_9[\s\S]*MIGRATION_9_10[\s\S]*MIGRATION_10_11[\s\S]*MIGRATION_11_12[\s\S]*MIGRATION_12_13/, 'Room must migrate existing installs through the conversation-authority, bridge-checkpoint, and lifecycle-control schemas without destructive reset');
assert.match(readFileSync(executionDbPath, 'utf8'), /yuqi_raw_messages[\s\S]*yuqi_evidence_facts[\s\S]*yuqi_sync_cursors[\s\S]*yuqi_annotations/, 'Room v7 must retain raw messages, evidence facts, sync cursors, and annotations on the phone');
assert.match(executionDao, /List<DiagnosticEntity>\s+latestDiagnostics\(int limit\)/, 'native diagnostics must be queryable by the UI bridge');
assert.match(executionDao, /ROLE_PLAN_CHAT[\s\S]{0,240}PROACTIVE_CHAT/, 'explicit role plans must be ordered ahead of ordinary proactive chat');
assert.match(executionDao, /state\s*=\s*'COMPLETED'[\s\S]{0,240}uiAppliedAt\s+IS\s+NULL/, 'Room must keep a durable inbox of completed turns not yet applied to the UI');
assert.match(executionDao, /acknowledgeUiApplied/, 'Room must expose an explicit UI acknowledgement');
assert.match(executionDao, /state\s*=\s*'COMPLETED'\s+AND\s+deletedAt\s+IS\s+NULL\s+ORDER\s+BY\s+completedAt\s+DESC\s+LIMIT\s+:limit/, 'Room must retain a bounded recovery view even after UI acknowledgement');
assert.match(executionPlugin, /unappliedCompletedTurns[\s\S]{0,1800}turnResult/, 'native bridge must return full unapplied turn results');
assert.match(executionPlugin, /result\.put\("inputJson",\s*turn\.inputJson\)/, 'native role-plan results must expose their minimal occurrence identifiers');
assert.match(html, /plugin\.unappliedCompletedTurns\(/, 'foreground reconciliation must scan the durable native UI inbox');
assert.match(html, /plugin\.recentCompletedTurns\(\{\s*limit:\s*50\s*\}\)/, 'foreground reconciliation must self-heal acknowledged native replies whose bubbles are absent');
assert.match(
  html,
  /await\s+(?:nativeBridgeCall\(\s*)?plugin\.acknowledgeUiApplied\(/,
  'the web UI must acknowledge a native result only after applying it'
);
assert.match(html, /function\s+nativeExecutionPlugin\(\)/, 'web UI should use the native Room execution bridge');
assert.match(html, /nativeExecutionPlugin\(\)[\s\S]{0,12000}\.submitTurn\(/, 'native sends should submit a durable Room turn');
assert.match(script, /const MAX_CHAT_OUTPUT_TOKENS = 8192;/, 'all chat paths should share a high output-token ceiling');
assert.match(script, /maxTokens:\s*MAX_CHAT_OUTPUT_TOKENS/, 'new settings should default to the shared high output limit');
assert.match(script, /chatMaxTokens:\s*normalizedChatMaxTokens\(settings\.maxTokens\)/, 'native user replies should inherit the shared high output limit');
assert.equal((script.match(/chatMaxTokens:\s*normalizedChatMaxTokens\(settings\.maxTokens\)/g) || []).length, 3, 'native user, proactive, moment, and role-plan replies should use the same high output limit');
assert.match(script, /max_tokens:\s*normalizedChatMaxTokens\(settings\.maxTokens\)/, 'foreground API calls should use the same high output limit');
const nativeQueueBody = html.match(/async function queueAndroidUserReply\([\s\S]*?\n}\nasync function mirrorAppStateNow/)?.[0] || '';
assert.doesNotMatch(nativeQueueBody, /nativeBackgroundRunner\(|AlReplyQueue|dispatchEvent\(/, 'native user replies must not fork into the legacy runner queue');
assert.match(nativeQueueBody, /buildNativeExecutionSnapshot\(/, 'native user replies should carry an immutable execution snapshot');
assert.match(html, /async function retryFailedReply[\s\S]{0,1200}nativeRetryTurnIdForMessage\([\s\S]{0,5000}plugin\.submitTurn\(/, 'native retry must create a fresh Room turn');
assert.doesNotMatch(html.match(/async function retryFailedReply[\s\S]*?function showReplyFailureReason/)?.[0] || '', /plugin\.retryTurn\(/, 'manual retry must not reuse a terminal Room turn');
assert.match(html, /function abortPendingReply[\s\S]{0,1800}plugin\.cancelTurn\(/, 'retract and delete should cancel the native turn');
assert.match(html, /function expireStalePendingReply[\s\S]{0,500}pending\.nativeTurnId[\s\S]{0,120}return false/, 'web timeout must not override an authoritative native turn');
assert.match(html, /async function syncNativeProactiveSnapshot\(/, 'cloud scheduling should persist an immutable native proactive snapshot');
assert.match(html, /async function scheduleCloudProactive[\s\S]{0,5000}syncNativeProactiveSnapshot\(/, 'native snapshot must exist before a cloud timer is scheduled');
assert.match(html, /if \(!force && hasFutureCloudJob\(chat, kind\) && proactiveJobUsesCurrentDicePolicy\(kind, chat\[proactiveJobKey\(kind\)\]\)\)[\s\S]{0,1000}syncNativeProactiveSnapshot\(/, 'existing cloud jobs must receive native snapshots after an app upgrade');
assert.match(html, /async function triggerProactiveMessage[\s\S]{0,1400}chatHasPendingDirectReply\(chat\)/, 'foreground proactive chat must not replace a pending direct reply');
assert.match(html, /await syncFromServiceWorkerState\(\{ checkProactive: false \}\)[\s\S]{0,1400}resumePendingAssistantTurns\(\)[\s\S]{0,300}checkProactiveMessages\(\)/, 'boot must resume direct replies before proactive catch-up');
assert.doesNotMatch(androidFcmService, /RunnerWorker|BackgroundRunner|pending_push_queue/, 'FCM must wake the Room execution engine directly');
assert.match(androidFcmService, /latestSnapshot\(/);
assert.match(androidFcmService, /matchesSnapshotJob\(snapshot,\s*jobId\)/, 'FCM must reject a cloud job replaced by a newer snapshot');
assert.match(androidFcmService, /submitTurn\(/);
assert.match(androidFcmService, /AlExecutionWakeWorker\.enqueue\(/, 'FCM must extend execution through expedited WorkManager');
assert.match(androidFcmService, /matchesSnapshotJob\(snapshot,\s*jobId\)/, 'stale role-plan cloud wakes must be rejected after a plan is rescheduled');
assert.match(html, /async function reconcileNativeExecutionTurns[\s\S]{0,2500}plugin\.changesSince\(/, 'web UI must consume Room changes created while WebView was absent');
assert.match(retryPolicy, /SocketException[\s\S]*NETWORK_INTERRUPTED[\s\S]*true/, 'native execution must retain retryable connection interruptions');
assert.match(html, /async function applyNativeExecutionTurn[\s\S]{0,7000}PROACTIVE_CHAT/, 'native proactive chat results must be applied to chat UI');
assert.match(html, /async function applyNativeExecutionTurn[\s\S]{0,7000}PROACTIVE_MOMENT/, 'native proactive moment results must be applied to moments UI');
assert.match(html, /async function applyNativeExecutionTurn[\s\S]{0,3000}ROLE_PLAN_CHAT/, 'native role-plan results must be applied through the durable UI inbox');
const foregroundSyncSource = html.slice(
  html.indexOf('async function syncFromServiceWorkerState('),
  html.indexOf('async function bootApp()')
);
assert.ok(
  foregroundSyncSource.indexOf('restoreAppStateFromMirror()') < foregroundSyncSource.indexOf('reconcileNativeExecutionTurns()'),
  'foreground restore must consume Room execution results after older web mirrors so completed replies always win'
);
assert.match(html, /sourceTurnId/, 'native proactive results must carry a durable dedupe key');
assert.match(script, /function nativeTurnHasUiLanding[\s\S]{0,900}ROLE_PLAN_MOMENT[\s\S]{0,500}ROLE_PLAN_CHAT/, 'role-plan results must be acknowledged after their chat or moment reaches the UI');
assert.match(swScript, /const CACHE_NAME = 'rpchat-v99';/);
assert.match(swScript, /APP_SHELL = \[[^\]]*\.\/lib\/api-endpoint\.js[^\]]*\]/);
assert.match(html, /<script src="\.\/lib\/role-plan-domain\.js"><\/script>/, 'role plan domain must load before the inline app script');
assert.match(swScript, /APP_SHELL = \[[^\]]*\.\/lib\/role-plan-domain\.js[^\]]*\]/, 'role plan domain must be available offline');
assert.match(html, /<script src="\.\/lib\/role-plan-repository\.js"><\/script>/, 'role plan repository must load before the inline app script');
assert.match(swScript, /APP_SHELL = \[[^\]]*\.\/lib\/role-plan-repository\.js[^\]]*\]/, 'role plan repository must be available offline');
assert.match(script, /function getRolePlanRepository\(\)/, 'app must create one role plan repository over native Room or IndexedDB');
assert.match(script, /async function applyRolePlanOperations\(/, 'chat and native results must persist hidden plan operations');
assert.match(script, /async function syncRolePlanCloudJobs\(/, 'effective role plans must receive independent cloud wakes');
assert.match(rolePlanDomain, /occurrenceId[\s\S]{0,500}type:\s*'role-plan'/, 'role-plan cloud payload must carry its idempotent occurrence identifier');
assert.match(script, /rolePlanSnapshotId\(charId, plan\.planId\)/, 'Android must receive a stable per-plan execution snapshot');
assert.match(script, /role-plan-contract/, 'chat prompt must describe the hidden role plan contract');
assert.match(script, /const rolePlanDirective = extractRolePlanDirective\(reply\)[\s\S]{0,1800}applyRolePlanOperations\(/, 'foreground replies must apply their hidden plans after reply persistence');
assert.match(script, /parts\.filter\(part => part\.type === 'PLAN' \|\| part\.type === 'SCHEDULE'\)/, 'native reply plan and schedule parts must be reconciled into the schedule');
assert.match(html, /id="screen-role-plans"/, 'character settings must expose a dedicated schedule screen');
assert.match(html, /onclick="openRolePlans\(/, 'character profile and chat settings should open the schedule');
assert.match(script, /async function renderRolePlansScreen\(/, 'the schedule screen must render persisted plans');
assert.match(script, /async function mutateRolePlanFromUi\(/, 'users must be able to pause, resume, and cancel plans');
assert.match(script, /async function createRolePlanFromUi\(/, 'users must be able to add an explicit plan without asking the character');
assert.match(script, /const MEMORY_DB_VERSION = 2;/);
assert.match(swScript, /const MEMORY_DB_VERSION = 2;/);
assert.match(script, /const APP_BUILD_VERSION = '2026-07-30\.108';/);
assert.match(html, /id="set-chat-temperature-enabled"/, 'settings must expose a chat temperature parameter switch');
assert.match(html, /id="set-memory-temperature-enabled"/, 'settings must expose a memory temperature parameter switch');
assert.match(html, /id="native-notification-status-row"/, 'native settings must expose notification status');
assert.match(script, /async function checkNativeNotificationStatus\(options = \{\}\)/, 'settings must query the Android notification channel');
assert.match(script, /plugin\.notificationStatus\(\)/, 'notification status must come from the native channel state');
assert.match(script, /plugin\.openNotificationSettings\(\)/, 'notification problems must open the Android system channel settings');
assert.match(script, /sendTemperature:\s*settings\.chatTemperatureEnabled !== false/, 'native chat config must persist the temperature switch');
assert.match(script, /sendTemperature:\s*settings\.memoryTemperatureEnabled !== false/, 'native memory config must persist the temperature switch');
assert.match(script, /等待 FCM Token 超时，请确认 Google Play 服务可以联网后重试/);
assert.match(script, /\}, API_TIMEOUT_MS\);/);
assert.match(script, /绑定步骤 3\/3：已取得 FCM Token/);
assert.match(html, /onclick="checkForAppUpdate\(\)"/);
assert.match(script, /const ANDROID_RELEASE_API = 'https:\/\/api\.github\.com\/repos\/siyi78118-hue\/-\/releases\/latest';/);
assert.match(script, /raw\.githubusercontent\.com\/siyi78118-hue\/-\/main\/android-update\.json/);
assert.match(script, /raw\.githubusercontent\.com\/siyi78118-hue\/-\/update-channel\/android-update\.json/);
assert.match(script, /async function fetchLatestAndroidRelease\(\)/);
assert.match(script, /GitHub 更新服务暂时限流/);
assert.match(script, /async function checkForAppUpdate\(\)/);
assert.match(script, /覆盖安装会保留聊天、记忆和 API 设置/);
assert.match(script, /function normalizeApiBaseUrl\(value, label = '接口'\)/);
assert.match(html, /<script src="lib\/api-endpoint\.js"><\/script>/);
assert.match(apiEndpointHelper, /请求落到了网页而不是模型接口/);
assert.match(script, /capabilities: \{ backgroundAck: 1 \}/);
assert.match(script, /refreshNativeCloudRegistration\(\)/);
assert.match(swScript, /API returned HTML page/);
assert.equal(capacitorConfig.appId, 'com.siyi.al');
assert.equal(capacitorConfig.webDir, 'tavern-app');
assert.equal(capacitorConfig.server?.url, undefined, 'Android App 不得依赖远程网站首页');
assert.match(androidManifest, /android:allowBackup="false"/);
assert.match(androidManifest, /android\.permission\.INTERNET/);
assert.match(androidManifest, /android\.permission\.RECORD_AUDIO/);
assert.match(androidBuildGradle, /AL_VERSION_CODE/);
assert.match(androidBuildGradle, /ANDROID_KEYSTORE_PATH/);
assert.match(androidBuildGradle, /signingConfig signingConfigs\.release/);
assert.match(androidWorkflow, /ANDROID_KEYSTORE_BASE64/);
assert.match(androidWorkflow, /- codex\/al-tdd/);
assert.match(androidWorkflow, /if: github\.ref == 'refs\/heads\/main'/);
assert.match(androidWorkflow, /assembleRelease assembleDebug/);
assert.match(androidWorkflow, /apksigner" verify --verbose --print-certs/);
assert.match(androidWorkflow, /TAG="android-v\$\{\{ env\.AL_RELEASE_VERSION_CODE \}\}"/);
assert.match(androidWorkflow, /gh release create "\$TAG"/);
assert.match(androidWorkflow, /Publish automatic update manifest/);
assert.match(androidWorkflow, /refs\/heads\/update-channel/);
assert.match(androidWorkflow, /releases\/download\/android-v%s\/app-release\.apk/);
assert.match(androidWorkflow, /Publish branch-signed APK handoff/);
assert.match(androidWorkflow, /BRANCH='signed-builds'/);
assert.match(androidWorkflow, /AL-\$\{\{ env\.AL_RELEASE_VERSION_NAME \}\}-release\.apk/);
assert.doesNotMatch(androidWorkflow, /github\.run_number/);
assert.match(script, /async function shareNativeBackup\(fileName, jsonText, options = \{\}\)/);
assert.match(script, /async function exportChatBackup\(\)/);
assert.match(script, /app: 'AL-chat-history'/);
assert.match(script, /async function importChatBackup\(event\)/);
assert.match(script, /当前 API Key 和云闹钟设置未改变/);
assert.match(script, /memory\.meta = \(await MemoryDB\.all\('meta'\)\)\.filter/);
assert.match(html, /id="emoji-tabs"/);
assert.match(html, /id="emoji-grid"/);
assert.match(script, /const EMOJI_CATEGORIES = \[/);
assert.match(script, /function renderEmojiPanel\(\)/);
assert.match(script, /function deleteChatInputChar\(\)/);
assert.match(script, /const MEMORY_BATCH_SIZE = 30;/);
assert.doesNotMatch(html, /id="set-memory-interval"/);
assert.match(script, /const interval = MEMORY_BATCH_SIZE;/);
assert.match(script, /memoryInterval: MEMORY_BATCH_SIZE/);
assert.match(script, /function processMemoryAfterScenario\(charId\) \{\s*processMemoryAfterTurn\(charId\)/);
assert.match(script, /function resolveMemoryEventTime\(event, batch = \[\]\)/);
assert.match(script, /sourceMessageIds/);
assert.match(script, /事件发生时间必须来自本批消息前面的“消息时间”/);
assert.match(script, /happenedAt: resolveMemoryEventTime\(e, sourceBatch\)/);
assert.match(script, /storeExtractedMemory\(charId, extracted, batch\)/);
assert.match(script, /async function queueAndroidUserReply\(charId, userMessageId, options = \{\}\)/);
assert.match(script, /async function buildNativeExecutionSnapshot\(charId, task\)/);
assert.doesNotMatch(script, /return \{ summaries, events, profiles, vectors: \[\], meta: \[\] \};/);
assert.match(script, /buildAndroidUserReplyTask\(charId, userMessageId, options\.userText \|\| chat\.pendingReply\?\.userText \|\| userMessage\.content/);
assert.match(script, /queueAndroidUserReply\(requestCharId, message\.id, \{ userText: voicePrompt \}\)/);
assert.match(script, /if \(isNativeApp\(\)\) return queueAndroidUserReply\(requestCharId, message\.id/);
assert.match(script, /const rawReply = await executeChatRequest\(request\)[\s\S]*const quality = await ensureForegroundReplyQuality/);
assert.doesNotMatch(script, /callAPI\(chat, memoryPack, \{ charId, live: true, proactive: true/);
assert.doesNotMatch(script, /await mirrorAppStateNow\(\); \} catch \(err\) \{ console\.warn\('\[AL Timer\] user turn state mirror skipped/);
assert.match(script, /const messages = sceneMessagesForAI\(chat, 30,/);
assert.match(script, /finally \{[\s\S]*processMemoryAfterTurn\(requestCharId\)/);
assert.doesNotMatch(script, /title: '近期增量摘要'/);
assert.doesNotMatch(swScript, /title: '近期增量摘要'/);
assert.match(script, /记忆AI根据玩家本次发言筛选出的本地记忆补充/);
assert.match(swScript, /记忆AI根据本次触发原因筛选出的手机本地记忆补充/);
assert.doesNotMatch(script, /CHAT_HISTORY_CHAR_BUDGET|PROACTIVE_HISTORY_CHAR_BUDGET/);
assert.doesNotMatch(swScript, /CHAT_HISTORY_CHAR_BUDGET|PROACTIVE_HISTORY_CHAR_BUDGET/);
assert.match(script, /const NORMAL_RAW_CONTEXT_LIMIT = 200;[\s\S]*function recentMessages\(chat, count = NORMAL_RAW_CONTEXT_LIMIT\)/);
assert.match(swScript, /const NORMAL_RAW_CONTEXT_LIMIT = 200;[\s\S]*function recentMessages\(chat, count = NORMAL_RAW_CONTEXT_LIMIT\)/);
assert.match(script, /return recentMessages\(chat, count\)\.map\(m =>/);
assert.match(swScript, /return recentMessages\(chat, count\)\.map\(m =>/);
assert.match(script, /messages\.slice\(-NORMAL_RAW_CONTEXT_LIMIT\)\.map\(m => memoryEvidenceLine\(m, char\)\)/);
assert.match(swScript, /messages\.slice\(-NORMAL_RAW_CONTEXT_LIMIT\)\.map\(m => messageLine\(m, char, settings\)\)/);
assert.match(script, /const RELATIONSHIP_STAGE_DEFS = \[/);
assert.match(script, /function currentStagePersonaBlock\(char\)/);
assert.match(script, /if \(preset\.prompt\) prompt \+= preset\.prompt \+ '\\n\\n';/);
assert.match(script, /<al_current_stage_persona>/);
assert.match(script, /relationshipStage/);
assert.match(script, /async function applyRelationshipStageReview\(char, chat, review, recent = \[\]\)/);
assert.match(script, /confidence < 0\.82/);
assert.match(script, /evidenceMessageIds\.length < \(explicitMutualChange \? 1 : 2\)/);
assert.match(html, /id="screen-stage-personas"/);
assert.match(html, /onclick="openStagePersonas\(currentCharId, 'chat-info'\)"/);
assert.match(swScript, /function backgroundStagePersonaBlock\(char, settings = \{\}\)/);
assert.match(swScript, /composer\.add\('stage-persona', backgroundStagePersonaBlock\(char, settings\)/);
assert.match(script, /continueAssistantTurn[\s\S]*prepareConversationContextSafe\([\s\S]*ensureForegroundReplyQuality/);
assert.match(script, /chat\.pendingReply = \{[\s\S]*userMessageId/);
assert.match(script, /function resumePendingAssistantTurns\(\)/);
assert.match(script, /function mergeLocalPendingReplies\(remoteChats = \{\}, localChats = \{\}, options = \{\}\)/);
assert.match(script, /function preservePendingRepliesForUnload\(\)/);
assert.match(script, /window\.addEventListener\('pagehide', preservePendingRepliesForUnload\)/);
assert.match(script, /window\.addEventListener\('pageshow'/);
assert.match(script, /resumePendingAssistantTurns\(\);/);
assert.match(script, /active\.controller\.abort\('message-retracted'\)/);
assert.match(script, /function retractMessage\(charId, messageId\)/);
assert.match(script, /function deleteChatMessage\(charId, messageId\)/);
assert.match(script, /replyToMessageId: userMessageId/);
assert.doesNotMatch(script, /content: `（\$\{friendlyErrorMessage\(err\)\}）`/);
assert.match(html, /class="message-retry"/);
assert.match(script, /async function retryFailedReply\(charId, userMessageId\)/);
assert.match(html, /class="message-failure-reason"/);
assert.match(script, /function showReplyFailureReason\(charId, messageId\)/);
assert.match(html, /data-memory-action="edit"/);
assert.match(script, /function bindMemoryListActions\(list\)/);
assert.match(script, /async function prepareConversationContext\(charId, userInput, scene = 'chat', options = \{\}\)/);
assert.match(script, /const query = await generateMemoryQuery\(char, userInput, recent, scene, \{/);
assert.match(script, /async function prepareMemoryPack\(charId, userInput, scene = 'chat', options = \{\}\)[\s\S]*prepareConversationContext/);
assert.match(swScript, /const query = await generateBackgroundMemoryQuery\(charId, char, settings, queryText, recent, scene, \{/);
assert.match(html, /\.primary\{width:calc\(100% - 28px\);/);
assert.doesNotMatch(html, />发起聊天<\/button>/);
assert.doesNotMatch(html, /class="wallet-tools"/);
assert.doesNotMatch(html, /onclick="saveSettings\(\)">保存<\/button>/);
assert.equal((html.match(/>新增记忆<\/div>/g) || []).length, 1);
assert.match(html, /showScreen\(contactProfileReturnScreen \|\| 'contacts'\)/);
assert.match(html, /showScreen\(selfProfileReturnScreen \|\| 'me'\)/);
assert.match(html, /openSelfProfile\('chat-info'\)/);
assert.match(script, /function openSelfProfile\(returnScreen = activeScreen\)/);
assert.match(script, /function cachedAvatarObjectUrl\(cacheKey, dataUrl\)/);
assert.match(script, /cachedAvatarObjectUrl\(`char:\$\{c\.id \|\| c\.name \|\| 'unknown'\}`, c\.avatarData\)/);
assert.match(script, /cachedAvatarObjectUrl\('player', settings\.playerAvatarData\)/);
assert.doesNotMatch(script, /const content = c\?\.avatarData \? `<img src="\$\{c\.avatarData\}"/);
assert.match(script, /async function closeStaleUpdateBrowser\(\)/);
assert.match(script, /await closeStaleUpdateBrowser\(\);/);
assert.match(script, /contactProfileReturnScreen = activeScreen && activeScreen !== 'contact-profile'/);
assert.match(script, /const MEMORY_MAX_TOKENS = 4096;/);
assert.match(swScript, /const MEMORY_MAX_TOKENS = 4096;/);
assert.doesNotMatch(script, /\/embeddings/);
assert.match(script, /async function createEmbedding\(text\) \{[\s\S]*return localEmbedding\(text\);/);
assert.match(script, /async function compactCharacterMemory\(charId\)/);
assert.match(script, /const memoryExtractionStates = new Map\(\);/);
assert.match(script, /async function processMemoryBatch\(charId, force = false\)/);
assert.match(script, /const batchEnd = chat\.messages\.length;/);
assert.match(script, /MemoryDB\.setMeta\(memoryMetaKey\(charId\), batchEnd\)/);
assert.doesNotMatch(script, /MemoryDB\.setMeta\(memoryMetaKey\(charId\), chat\.messages\.length\)/);
assert.match(script, /游标未前移，下次会重试同一批/);
assert.match(script, /invalidateMemoryExtraction\(charId\)/);
assert.match(script, /item\.manual = true;/);
assert.match(script, /await upsertMemoryItem\('profiles', item, profileRows\)/);
assert.match(script, /await upsertMemoryItem\('events', item, eventRows\)/);
assert.match(script, /this\.remove\('meta', memoryExtractStatusKey\(charId\)\)/);
assert.match(swScript, /return !!\(settings\.memoryApiUrl && settings\.memoryApiKey && settings\.memoryModel\);/);
assert.doesNotMatch(swScript, /settings\.memoryApiUrl \|\| settings\.apiUrl/);
assert.doesNotMatch(swScript, /settings\.memoryApiKey \|\| settings\.apiKey/);
assert.match(swScript, /function mergeStreamText\(current = '', incoming = ''\)/);
assert.match(swScript, /result = mergeStreamText\(result, delta\)/);
const appCloudTimerVersion = script.match(/const EXPECTED_CLOUD_TIMER_VERSION = '([^']+)'/)?.[1];
const workerCloudTimerVersion = cloudTimerWorker.match(/const CLOUD_TIMER_WORKER_VERSION = '([^']+)'/)?.[1];
const healthCloudTimerVersion = cloudTimerHealthScript.match(/const EXPECTED_VERSION = '([^']+)'/)?.[1];
assert.ok(appCloudTimerVersion, 'app must declare its expected cloud timer version');
assert.equal(appCloudTimerVersion, workerCloudTimerVersion, 'app and deployed Worker source must expect the same version');
assert.equal(appCloudTimerVersion, healthCloudTimerVersion, 'app and health checker must expect the same Worker version');
assert.match(script, /const PROACTIVE_DICE_INTERVAL_MS = 10 \* 60 \* 1000;/);
assert.match(script, /const PROACTIVE_DICE_CHANCE = 0\.15;/);
assert.match(script, /const PROACTIVE_DICE_MAX_ROLLS = 144;/);
assert.match(script, /const MOMENT_DICE_INTERVAL_MS = 2 \* 60 \* 60 \* 1000;/);
assert.match(script, /const MOMENT_DICE_CHANCE = 0\.20;/);
assert.match(script, /const MOMENT_DICE_MAX_ROLLS = 12;/);
assert.match(swScript, /const MOMENT_DICE_INTERVAL_MS = 2 \* 60 \* 60 \* 1000;/);
assert.match(swScript, /const MOMENT_DICE_CHANCE = 0\.20;/);
assert.match(swScript, /const MOMENT_DICE_MAX_ROLLS = 12;/);
assert.match(script, /const CLOUD_TIMER_RESYNC_MS = 60 \* 60 \* 1000;/);
assert.match(script, /function proactiveDicePlan\(options = \{\}, now = Date\.now\(\), randomValue = Math\.random\(\)\)/);
assert.match(swScript, /function proactiveDicePlan\(options = \{\}, now = Date\.now\(\), randomValue = Math\.random\(\)\)/);
assert.match(script, /if \(job\?\.dicePrecomputed\) return true;/);
assert.match(swScript, /if \(job\?\.dicePrecomputed\) return true;/);
assert.match(script, /dicePrecomputed: !!job\.dicePrecomputed/);
assert.match(swScript, /dicePrecomputed: !!chat\[jobKey\]\.dicePrecomputed/);
assert.match(script, /sw-v11\.js\?alarm-stream=1&v=\$\{APP_BUILD_VERSION\}/);
assert.match(script, /\.then\(reg => reg\.update\?\.\(\)\)/);
assert.match(script, /const API_TIMEOUT_MS = 120000;/);
assert.match(script, /const PROACTIVE_MEMORY_TIMEOUT_MS = API_TIMEOUT_MS;/);
assert.doesNotMatch(swScript, /Math\.min\(API_TIMEOUT_MS,\s*45000\)/);
assert.doesNotMatch(script, /rows\.find\(\(\{ chat \}\) => !hasFutureCloudJob\(chat, kind\)\)/);
assert.doesNotMatch(script, /function cancelOtherCloudJobs\(/);
assert.match(script, /for \(const \{ char, chat \} of rows\) \{/);
assert.match(script, /const exists = await verifyCloudJobStatus\(char\.id, job, kind\)/);
assert.match(script, /changed = await resubmitCloudProactive\(char\.id, kind\) \|\| changed/);
assert.match(script, /主动角色：\$\{managedIds\.size\}\/\$\{chatRows\.length\} 个会话/);
assert.match(script, /function ensureOpenedChatProactive\(charId\)/);
assert.match(script, /ensureOpenedChatProactive\(charId\)/);
assert.match(script, /open-chat \$\{kind\} due skipped/);
assert.match(script, /function parseProactiveScheduleTime\(value, now = new Date\(\)\)/);
assert.match(script, /function extractProactiveScheduleDirective\(text, now = new Date\(\)\)/);
assert.match(script, /function stripProactiveScheduleDirective\(text\)/);
assert.match(script, /function extractPaymentStatusDirective\(text\)/);
assert.match(script, /function stripPaymentStatusDirective\(text\)/);
assert.match(script, /function extractAssistantPaymentDirective\(text\)/);
assert.match(script, /function stripAssistantPaymentDirective\(text\)/);
assert.match(script, /<al_send_payment>\{"type":"redpacket\|transfer","amount":正数,"note":"备注"\}<\/al_send_payment>/);
assert.match(script, /Emoji 可以自然夹在文字里，也可以单独成为一条消息/);
assert.match(script, /<al_payment>\{\"status\":\"received\|pending\|refused\"\}<\/al_payment>/);
assert.match(script, /updatePaymentStatusFromReply\(chat, options\.paymentMessageId, replyText, requestCharId, paymentDirective\?\.status\)/);
assert.match(script, /updatePaymentStatusFromReply\(chat, '', replyText, charId, paymentDirective\?\.status\)/);
assert.match(swScript, /function extractPaymentStatusDirective\(text\)/);
assert.match(swScript, /function stripPaymentStatusDirective\(text\)/);
assert.match(swScript, /function updateBackgroundPaymentStatusFromReply\(state, charId, reply, explicitStatus = ''\)/);
assert.match(swScript, /await updateBackgroundPaymentStatusFromReply\(state, charId, replyText, paymentDirective\?\.status\)/);
assert.match(script, /function stripLeakedPromptMetadata\(text\)/);
assert.match(script, /历史消息元数据/);
assert.match(script, /跨天\/超长间隔重新开口/);
assert.match(script, /免打扰模式\|骰子\|摇骰\|调度\|定时器/);
assert.match(swScript, /function stripLeakedPromptMetadata\(text\)/);
assert.match(swScript, /跨天\/超长间隔重新开口/);
assert.match(script, /function expectedProactiveChatMode\(chat\)/);
assert.match(swScript, /function expectedProactiveChatMode\(chat\)/);
assert.match(script, /function proactiveJobMatchesConversationStage\(chat, job = null\)/);
assert.match(swScript, /function proactiveJobMatchesConversationStage\(chat, job = null\)/);
assert.match(script, /function proactiveHistoryMode\(chat, now = new Date\(\)\)/);
assert.match(swScript, /function proactiveHistoryMode\(chat, now = new Date\(\)\)/);
assert.match(script, /function buildProactiveMemoryQuery\(chat, now = new Date\(\), triggerMode = 'planned'\)/);
assert.match(swScript, /function buildProactiveMemoryQuery\(chat, settings = \{\}, now = new Date\(\), triggerMode = 'planned'\)/);
assert.match(script, /await mirrorAppStateNow\(\)/);
assert.match(script, /忽略已被新任务替换的旧推送，避免计划追发与随机抽取串线/);
assert.match(swScript, /忽略阶段不匹配的/);
assert.match(script, /<al_schedule>\{"nextProactiveAt":"YYYY-MM-DDTHH:mm:ss\+08:00"\}<\/al_schedule>/);
assert.match(script, /async function schedulePlannedChatFromReply\(charId, directive = null\)/);
assert.match(script, /async function scheduleDiceProactive\(charId, kind = 'chat'\)/);
assert.match(script, /async function enterProactiveDiceMode\(charId, kind = 'chat'\)/);
assert.match(script, /return scheduleDiceProactive\(charId, kind\);/);
assert.match(script, /async function ensureDiceProactiveScheduled\(charId, kind = 'chat'\)/);
assert.match(script, /if \(existingJob\?\.jobId \|\| existingJob\?\.dueAt\) return false;/);
assert.match(script, /if \(!manual\) try \{ await enterProactiveDiceMode\(charId, 'chat'\);/);
assert.match(script, /if \(!manual\) try \{ await enterProactiveDiceMode\(charId, 'moment'\);/);
assert.match(script, /proactiveDefaultScheduleOptions\(kind, chat\)/);
assert.match(script, /chatHasUnansweredProactive\(chat\)/);
assert.match(script, /triggerProactiveMessage\(target\.char\.id, false, proactiveJobMode\(job\)\)/);
assert.match(script, /triggerProactiveMessage\(data\.charId, false, proactiveJobMode\(localJob \|\| data\)\)/);
assert.match(script, /function proactiveModeLabel\(job\)/);
assert.match(script, /最近私聊（\$\{nextChat\.char\.name\}｜\$\{proactiveModeLabel\(nextChat\.job\)\}）/);
assert.doesNotMatch(script, /cancelCloudProactive\(requestCharId, 'all'\)/);
assert.doesNotMatch(script, /cancelCloudProactive\(currentCharId, 'all'\)/);
assert.match(swScript, /function visibleConversationMessages\(chat\)/);
assert.match(swScript, /const triggerMode = kind === 'chat' && allChats\[charId\]/);
assert.match(swScript, /mode: triggerMode,/);
assert.match(swScript, /buildProactiveTimeContext\(chat, proactiveNow, triggerMode\)/);
assert.match(swScript, /proactiveMode: triggerMode/);
assert.match(swScript, /function proactivePayloadMatchesJob\(payload = \{\}, job = null\)/);
assert.match(swScript, /忽略已被新任务替换的旧推送/);
assert.match(script, /Date\.now\(\)\.toString\(36\).*Math\.random\(\)\.toString\(36\)/);
assert.match(swScript, /Date\.now\(\)\.toString\(36\).*Math\.random\(\)\.toString\(36\)/);
assert.match(script, /cancelCloudJobId\(previousJob\.jobId\)/);
assert.match(swScript, /jobId: previousJob\.jobId/);
assert.match(script, /async function ensureLocalProactiveScheduled\(\)/);
assert.match(script, /await ensureLocalProactiveScheduled\(\);\s*await catchUpDueCloudProactive\(\);/);
const visibleHandoffIndex = swScript.indexOf("if (await hasVisibleClient())");
const backgroundDiceIndex = swScript.indexOf("if (proactiveJobMode(dueJob.job || payload) === 'dice' && !rollProactiveDice(kind, dueJob.job || payload))");
assert.ok(visibleHandoffIndex >= 0 && backgroundDiceIndex > visibleHandoffIndex, '页面可见时应只由前台抽一次骰子');
assert.match(script, /function rollProactiveDice\(kind = 'chat', job = null\)/);
assert.match(script, /骰子未抽中/);
assert.match(script, /已经有一段时间没有继续回复/);
assert.match(script, /async function checkCloudTimerWorkerVersion/);
assert.match(script, /function cloudTimerErrorMessage\(err\)/);
assert.match(script, /云闹钟连接失败：请检查闹钟地址是否为 Worker 地址/);
assert.match(script, /manualCheckCloudTimerVersion\(\)/);
assert.match(html, /检测云端 Worker 版本/);
assert.match(html, /查看云闹钟最近流水/);
assert.match(script, /async function fetchCloudTimerLogs\(\)/);
assert.match(script, /timerUrl\('\/logs'\)/);
assert.match(script, /云闹钟版本/);
assert.match(script, /function buildProactiveTriggerMessage/);
assert.match(script, /私聊链路/);
assert.match(script, /function appendCloudTraceLine/);
assert.match(script, /前台收到 push：kind=/);
assert.match(script, /前台发现 \$\{tasks\.length\} 个本地到期任务/);
assert.match(script, /checkProactiveMessages\(\)\.catch\(err => console\.warn\('\[AL Timer\] immediate proactive check skipped:'/);
assert.match(swScript, /function buildProactiveTriggerMessage/);
assert.match(cloudTimerHealthScript, /DEFAULT_TIMEOUT_MS = 20000/);
assert.match(cloudTimerHealthScript, /Checking cloud timer:/);
assert.match(cloudTimerHealthScript, /连接云闹钟超时/);
assert.match(cloudTimerHealthScript, /Raw error:/);
assert.match(swScript, /setStateCloudTimerTrace/);
assert.match(swScript, /页面可见，转交前台处理/);
assert.match(swScript, /messages\.push\(\{ role: 'user', content: buildProactiveTriggerMessage/);
assert.match(swScript, /function getFallbackProactiveJob\(allChats\)/);
assert.match(swScript, /fallback: !!fallbackJob/);
assert.match(swScript, /收到云端 push，但本地没有可触发会话或任务/);
assert.match(script, /本地未命中到期任务，已用最近任务兜底/);
assert.match(swScript, /function latestCloudTargetCharId\(allChats\)/);
assert.doesNotMatch(swScript, /\(\!targetCharId \|\| r\.charId === targetCharId\).*r\.job\?\.dueAt/);
assert.match(swScript, /\.filter\(r => r\.job\?\.dueAt && Date\.parse\(r\.job\.dueAt\) <= now\)/);
assert.match(swScript, /function cleanApiKey\(value\)/);
assert.match(swScript, /后台记忆AI已调用/);
assert.match(swScript, /function localEmbedding\(text, dim = VECTOR_DIM\)/);
assert.match(swScript, /async function searchMemoryVectors\(charId, queryText/);
assert.match(swScript, /本轮相关记忆/);
assert.doesNotMatch(swScript, /重要事件和时间节点：\\n/);
assert.doesNotMatch(swScript, /稳定资料和关系状态：\\n/);
assert.match(swScript, /async function refreshBackgroundPaymentExpirations\(state, charId\)/);
assert.match(swScript, /evt_redpacket_expired_/);
assert.match(swScript, /vec_event_\$\{id\}/);
assert.match(swScript, /async function recordBackgroundScenarioMemory\(state, charId, title, detail/);
assert.match(swScript, /后台主动私聊/);
assert.match(swScript, /后台朋友圈动态/);
assert.match(swScript, /req\.onupgradeneeded/);
assert.match(swScript, /ensure\('vectors'/);
assert.match(swScript, /deleteObjectStore\('meta'\)/);
assert.match(swScript, /ensure\('meta', \[\['updatedAt', 'updatedAt'\]\]\)/);
assert.match(script, /deleteObjectStore\('meta'\)/);
assert.match(script, /ensure\('meta', \[\['updatedAt', 'updatedAt'\]\]\)/);
assert.match(script, /returnPromptDetails: true/);
assert.match(script, /diagnostic = responseDiagnostic\(json, raw\)/);
assert.match(swScript, /diagnostic = responseDiagnostic\(json, raw\)/);
assert.match(script, /记忆 API 有正文但不是可解析 JSON/);
assert.match(swScript, /记忆 API 有正文但不是可解析 JSON/);
assert.match(script, /async function prepareMemoryPackSafe\(charId, userInput, scene = 'chat', options = \{\}\)/);
assert.match(script, /prepareConversationContextSafe\(charId, userInput, scene, options\)\)\.memoryPack/);
assert.match(script, /prepareMemoryPack\(charId, query, `proactive-\$\{kind\}`\)/);
assert.match(swScript, /buildBackgroundMemoryContext\([\s\S]{0,180}memoryQuery,[\s\S]{0,80}'proactive-chat'/);
assert.match(swScript, /buildMemoryPack\(charId, char, settings, memoryQuery, 'moment-post'\)/);
assert.match(html, /id="new-personality"/);
assert.doesNotMatch(html, /id="new-first"/);
assert.match(html, /人物设定/);
assert.match(html, /说话方式/);
assert.match(html, /关系设定/);
assert.doesNotMatch(html, /个性签名/);
assert.doesNotMatch(html, /一句话设定/);
assert.doesNotMatch(html, /第一条消息/);
const composerPlusHtml = html.slice(html.indexOf('id="composer-plus"'), html.indexOf('<div id="screen-pay"'));
assert.match(composerPlusHtml, /转账/);
assert.match(composerPlusHtml, /红包/);
assert.doesNotMatch(composerPlusHtml, /记忆库/);
assert.doesNotMatch(composerPlusHtml, /主动消息/);
assert.doesNotMatch(composerPlusHtml, /发动态/);
const contactsHtml = html.slice(html.indexOf('id="screen-contacts"'), html.indexOf('<div id="screen-contact-profile"'));
assert.match(contactsHtml, /新的朋友/);
assert.match(contactsHtml, /角色卡/);
assert.doesNotMatch(contactsHtml, /showScreen\('tags'\)/);
assert.doesNotMatch(contactsHtml, /<div class="cell-body">标签<\/div>/);
assert.doesNotMatch(contactsHtml, /<div class="cell-body">记忆库<\/div>/);
const chatInfoHtml = html.slice(html.indexOf('id="screen-chat-info"'), html.indexOf('<div id="screen-moments"'));
assert.match(chatInfoHtml, /查找聊天内容/);
assert.match(chatInfoHtml, /<div class="cell-body">记忆库<\/div>/);
assert.match(chatInfoHtml, /openMemory\('chat-info'\)/);
assert.doesNotMatch(html, /id="screen-tags"/);
assert.doesNotMatch(script, /function renderTagsScreen/);
assert.match(html, /测试主动私聊/);
assert.match(html, /测试主动朋友圈/);
assert.match(html, /id="clear-all-automatic-tasks"/);
assert.match(html, /紧急清空全部自动任务/);
assert.match(html, /保留聊天、角色、配置和云闹钟绑定/);
assert.match(script, /async function clearAllAutomaticTasks\(\)/);
assert.match(script, /\/cancel-device-tasks/);
const settingsHtml = html.slice(html.indexOf('id="screen-settings"'), html.indexOf('<div id="screen-memory"'));
assert.match(settingsHtml, /openMemory\('settings'\)/);
assert.match(settingsHtml, /showScreen\('diagnostics'\)/);
assert.doesNotMatch(settingsHtml, /测试聊天连接/);
assert.doesNotMatch(settingsHtml, /测试记忆连接/);
assert.doesNotMatch(settingsHtml, /测试记忆筛选/);
assert.doesNotMatch(settingsHtml, /检测云端 Worker 版本/);
assert.doesNotMatch(settingsHtml, /查看云闹钟最近流水/);
assert.doesNotMatch(settingsHtml, /测试主动私聊/);
const diagnosticsHtml = html.slice(html.indexOf('id="screen-diagnostics"'), html.indexOf('<script>'));
assert.match(diagnosticsHtml, /测试聊天连接/);
assert.match(diagnosticsHtml, /测试记忆连接/);
assert.match(diagnosticsHtml, /测试记忆筛选/);
assert.match(diagnosticsHtml, /检测云端 Worker 版本/);
assert.match(diagnosticsHtml, /查看云闹钟最近流水/);
assert.match(diagnosticsHtml, /测试云闹钟推送/);
assert.match(diagnosticsHtml, /测试主动私聊/);
assert.match(diagnosticsHtml, /测试主动朋友圈/);
assert.match(html, /showScreen\(memoryReturnScreen \|\| 'settings'\)/);
assert.match(script, /let memoryReturnScreen = 'settings';/);
assert.match(script, /function openMemory\(returnScreen = activeScreen\)/);
assert.match(html, /class="memory-section-title"/);
assert.match(html, /class="memory-actions"/);
assert.match(html, /id="memory-list"><\/div>/);
assert.match(html, /id="memory-char-select"/);
assert.match(html, /id="memory-search-input"/);
assert.match(html, /filterMemoryList\(this\.value\)/);
assert.match(html, /id="screen-memory-edit"/);
assert.match(html, /id="memory-edit-char"/);
assert.match(html, /id="memory-edit-store"/);
assert.match(html, /id="memory-edit-detail"/);
assert.match(html, /saveMemoryEditor\(\)/);
assert.match(html, /addMemoryItem\('profiles'\)/);
assert.match(script, /function renderMemoryItem\(storeName, item\)/);
assert.match(script, /let memoryTargetCharId = '';/);
assert.match(script, /let memoryFilterText = '';/);
assert.match(script, /function memoryCurrentCharId\(\)/);
assert.match(script, /function memoryRowMatches\(row, query = ''\)/);
assert.match(script, /function filterMemoryList\(value\)/);
assert.match(script, /async function switchMemoryChar\(charId\)/);
assert.match(script, /memoryTargetCharId = currentCharId \|\| memoryTargetCharId \|\| characters\[0\]\?\.id \|\| '';/);
assert.match(script, /const selector = document\.getElementById\('memory-char-select'\)/);
assert.match(script, /const searchInput = document\.getElementById\('memory-search-input'\)/);
assert.match(script, /const validTarget = characters\.some\(c => c\.id === memoryTargetCharId\)/);
assert.match(script, /const filteredGroups = groups\.map\(group => \(\{ \.\.\.group, rows: group\.rows\.filter\(row => memoryRowMatches\(row, memoryFilterText\)\) \}\)\)/);
assert.match(script, /没有匹配的记忆/);
assert.match(script, /function addMemoryItem\(storeName\)/);
assert.match(script, /function editMemoryItem\(storeName, id\)/);
assert.match(script, /async function openMemoryEditor\(storeName = 'profiles', id = ''\)/);
assert.match(script, /async function renderMemoryEditor\(item = null\)/);
assert.match(script, /function memoryEditorDefaults\(storeName\)/);
assert.match(script, /function renderMemoryEditorFields\(\)/);
assert.match(script, /async function saveMemoryEditor\(\)/);
assert.match(script, /let memoryEditorState = \{ storeName: 'profiles', id: '', lastStoreName: 'profiles' \};/);
assert.match(script, /if \(charEl\) charEl\.textContent = char \? char\.name : '未选择';/);
assert.match(script, /if \(!memoryEditorState\.id && previousStore !== storeName\)/);
assert.match(script, /function deleteMemoryItem\(storeName, id\)/);
assert.match(script, /function syncMemoryVector\(storeName, item\)/);
assert.match(script, /manual: true/);
assert.match(script, /await syncMemoryVector\(storeName, item\)/);
assert.doesNotMatch(script, /prompt\('编辑摘要'/);
assert.doesNotMatch(script, /prompt\('新增摘要'/);
assert.match(script, /const charId = memoryCurrentCharId\(\);[\s\S]*await processMemoryAfterTurn\(charId, true\)/);
assert.match(script, /const charId = memoryCurrentCharId\(\);[\s\S]*await MemoryDB\.clearChar\(charId\)/);
assert.match(script, /if \(memoryTargetCharId === deletedId\) memoryTargetCharId = '';/);
assert.match(script, /MemoryDB\.remove\('vectors', `vec_\$\{memorySourceType\(storeName\)\}_\$\{id\}`\)/);
assert.match(script, /title: '资料', store: 'profiles'/);
assert.match(script, /title: '事件', store: 'events'/);
assert.match(script, /title: '摘要', store: 'summaries'/);
assert.match(script, /function friendAddedSystemMessage/);
assert.match(script, /你已添加了\$\{name\}，现在可以开始聊天了。/);
assert.match(script, /function chatClearedSystemMessage/);
assert.match(script, /你已清空与\$\{charName\(char\)\}的聊天记录。/);
assert.match(script, /function conversationMessages\(chat\)/);
assert.match(script, /function recentMessages\(chat, count = NORMAL_RAW_CONTEXT_LIMIT\)/);
assert.match(script, /function removeCharacterMomentTraces\(charId\)/);
assert.match(script, /async function cancelCloudProactiveQuick\(charId, reason = '操作'\)/);
assert.match(script, /await withTimeout\(cancelCloudProactive\(charId, 'all'\), 8000, `\$\{reason\}取消云闹钟超时`\)/);
assert.match(script, /async function clearCurrentChat\(\)/);
assert.match(script, /async function nativeFirstConversationClear\(/);
assert.match(script, /async function clearConversationForCharacter\([\s\S]*nativeFirstConversationClear\(/);
assert.match(script, /clearConversationForCharacter\(currentCharId, \{ render: true \}\)/);
assert.match(script, /MemoryDB\.setMeta\(memoryMetaKey\(charId\), 0\)/);
assert.match(script, /聊天已清空，增量整理游标已复位/);
assert.match(script, /messages: \[chatClearedSystemMessage\(char\)\]/);
assert.doesNotMatch(script, /role:'assistant', content:char\.firstMessage/);
assert.match(script, /async function deleteCurrentRole\(\)/);
assert.match(script, /cancelCloudProactiveQuick\(deletedId, '删除角色'\)/);
assert.match(script, /async function clearAllHistory\(\)/);
assert.match(script, /runNativeClearAllSerial\(clearedCharIds, charId => clearConversationForCharacter\(charId\)\)/);
assert.match(script, /MemoryDB\.clearChar\(deletedId\)/);
assert.match(script, /removeCharacterMomentTraces\(deletedId\)/);
assert.match(script, /会同时删除它的聊天、云闹钟、本地记忆库和朋友圈痕迹/);
assert.match(html, /测试记忆筛选/);
assert.match(script, /async function testMemoryQueryPreset\(\)/);
assert.match(script, /scene: 'memory-query-test'/);
assert.match(script, /记忆检索失败：\$\{friendlyErrorMessage\(err\)\}；已跳过记忆包继续生成。/);
assert.match(script, /await prepareConversationContextSafe\(\s*requestCharId,\s*userText,\s*'chat'/);
assert.match(script, /triggerProactiveMessage[\s\S]*prepareConversationContextSafe\([\s\S]*ensureForegroundReplyQuality/);
assert.match(script, /await prepareMemoryPackSafe\(char\.id, memoryQuery, 'moment-interaction'\)/);
assert.match(script, /await prepareMemoryPackSafe\(char\.id, memoryQuery, 'moment-reply'\)/);
assert.match(html, /onpointerdown="startVoiceRecording\(event\)"/);
assert.match(html, /id="set-voice-api-url"/);
assert.match(html, /id="set-voice-model"/);
assert.match(script, /async function sendVoiceMessage\(\)/);
assert.match(script, /async function transcribeVoiceBlob\(blob, duration/);
assert.match(script, /\/audio\/transcriptions/);
assert.match(script, /new FormData\(\)/);
assert.doesNotMatch(script, /'Content-Type': 'multipart\/form-data'/);
assert.match(script, /function renderVoiceCard\(m\)/);
assert.match(script, /\[语音消息 \$\{actualDuration\}秒，未转文字\]/);
assert.match(swScript, /promptBlocks: prompt\.promptBlocks/);
assert.match(script, /红包 24 小时未领取，已自动退回零钱/);
assert.match(html, /id="screen-diagnostics"/);
assert.match(html, /查看最近调用/);
assert.match(script, /function renderDiagnosticsScreen\(\)/);
assert.match(html, /导出本机数据/);
assert.match(html, /含 API Key、聊天、朋友圈和记忆库/);
assert.match(html, /导入本机备份/);
assert.match(script, /async function dumpMemoryStores\(\)/);
assert.match(script, /async function restoreMemoryStores\(memory = \{\}\)/);
assert.match(script, /async function exportBackup\(\)/);
assert.match(script, /备份文件会包含聊天接口、记忆接口、语音接口的地址和 API Key/);
assert.match(script, /已导出备份，请妥善保存，里面包含 API Key/);
assert.match(script, /async function importBackup\(event\)/);
assert.match(script, /function resetImportedDeviceBinding\(importedSettings\)/);
assert.match(script, /function clearImportedCloudJobs\(chats = \{\}\)/);
assert.match(script, /AL-backup-/);
assert.match(script, /导入会覆盖当前本机设置、角色、聊天、朋友圈和记忆库/);
assert.match(script, /备份已导入，云闹钟需重新绑定/);
assert.match(script, /已从备份恢复；云闹钟需要在本机重新绑定。/);
const cloudTimerWorkerCode = cloudTimerWorker.replace(/\/\/.*$/gm, '');
const runDueJobsSource = cloudTimerWorkerCode.slice(
  cloudTimerWorkerCode.indexOf('async function runDueJobs'),
  cloudTimerWorkerCode.indexOf('async function getLastCron')
);
assert.doesNotMatch(runDueJobsSource, /\.list\s*\(/, 'cron path must not scan KV');
assert.match(cloudTimerWorker, /const CLOUD_TIMER_WORKER_VERSION = '2026-07-17\.18';/);
assert.match(cloudTimerWorker, /url\.pathname === '\/cancel-device-tasks'/);
assert.match(cloudTimerWorker, /async function sendFcmPush/);
assert.match(cloudTimerWorker, /url\.pathname === '\/ack'/);
assert.match(cloudTimerWorker, /async function deferForFcmAck/);
assert.match(cloudTimerWorker, /awaitingAck: result\.transport === 'fcm' && Number\(target\.backgroundAck\) >= 1/);
assert.match(cloudTimerWorker, /firebase\.messaging/);
assert.match(script, /async function enableNativeCloudTimer/);
assert.match(cloudTimerWorker, /AL_TIMER_DB binding is missing/);
assert.match(readFileSync(new URL('./migrations/0001_timer_store.sql', import.meta.url), 'utf8'), /idx_timer_jobs_due_at/);
assert.match(cloudTimerWorker, /const hasActivity = !summary\.ok \|\| summary\.jobsSeen > 0/);
assert.doesNotMatch(runDueJobsSource, /AL_TIMER_KV\.put/, 'cron health and logs must not consume KV writes');
assert.match(cloudTimerWorker, /if \(hasActivity\) logWorkerEvent\('cron'/);
assert.doesNotMatch(cloudTimerWorker, /meta:lastCron|meta:recentEvents/);
assert.doesNotMatch(cloudTimerWorker, /AL_TIMER_KV\.(?:put|delete|list)/, 'timer task writes must use D1');
assert.match(cloudTimerWorker, /version: CLOUD_TIMER_WORKER_VERSION/);
assert.match(cloudTimerWorker, /mode: body\.mode === 'dice' \? 'dice' : 'planned'/);
assert.match(cloudTimerWorker, /rollChance: job\.rollChance/);
assert.match(cloudTimerWorker, /diceRolls: job\.diceRolls/);
assert.match(cloudTimerWorker, /dicePrecomputed: !!job\.dicePrecomputed/);
const cloudWorkerModule = await import(`data:text/javascript;base64,${Buffer.from(cloudTimerWorker).toString('base64')}`);
const idleCronWaits = [];
const idleCronEnv = {
  AL_TIMER_STORE: {
    async dueJobs() { return []; }
  }
};
await cloudWorkerModule.default.scheduled({}, idleCronEnv, { waitUntil(promise) { idleCronWaits.push(promise); } });
await Promise.all(idleCronWaits);
assert.equal(idleCronWaits.length, 1, '空闲 cron 只执行一次索引查询，不写健康流水');
const ackDueAt = new Date(Date.now() + 60000).toISOString();
const ackStore = new Map([['ack-job', { jobId: 'ack-job', deviceId: 'device-a', charId: 'char-a', kind: 'chat', dueAt: ackDueAt }]]);
const ackEnv = {
  AL_TIMER_STORE: {
    async getJob(jobId) { return ackStore.get(jobId) ?? null; },
    async deleteJob(jobId) { return ackStore.delete(jobId); }
  }
};
const wrongAckResponse = await cloudWorkerModule.default.fetch(new Request('https://worker.example/ack', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'device-b', jobId: 'ack-job' })
}), ackEnv);
assert.equal(wrongAckResponse.status, 400, '其他设备不得确认并删除任务');
assert.equal(ackStore.has('ack-job'), true);
const ackResponse = await cloudWorkerModule.default.fetch(new Request('https://worker.example/ack', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'device-a', jobId: 'ack-job', outcome: 'generated' })
}), ackEnv);
assert.equal(ackResponse.status, 200);
assert.equal(ackStore.has('ack-job'), false, '手机成功回执后必须删除云端任务');
assert.match(cloudTimerWorker, /url\.pathname === '\/logs'/);
assert.match(cloudTimerWorker, /async function appendEvent\(env, event\)/);
assert.match(cloudTimerWorker, /source: 'workers-logs'/);
assert.match(cloudTimerWorker, /async function sendEncryptedPush\(subscription, env, payload = \{\}\)/);
assert.match(cloudTimerWorker, /async function encryptPushPayload\(subscription, payloadText\)/);
assert.match(cloudTimerWorker, /'Content-Encoding': 'aes128gcm'/);
assert.match(swScript, /event\.data \? event\.data\.json\(\) : \{\}/);
assert.match(cloudTimerWorker, /cron: await getLastCron\(env\)/);
assert.equal(packageJson.scripts['cloud:deploy'], 'node scripts/deploy-cloud-timer.mjs');
assert.equal(packageJson.scripts['cloud:deploy:raw'], 'node scripts/run-wrangler.mjs deploy');
assert.equal(packageJson.scripts['cloud:health'], 'node scripts/check-cloud-timer.mjs');
assert.match(cloudTimerDeployScript, /Missing CLOUDFLARE_API_TOKEN/);
assert.match(cloudTimerDeployScript, /WRANGLER_CMD/);
assert.match(wranglerRunScript, /resolveWranglerInvocation/);
assert.match(wranglerInvocationScript, /node_modules.*wrangler.*bin.*wrangler\.js/s);
assert.match(wranglerInvocationScript, /shell: false/);
assert.match(cloudTimerDeployScript, /scripts\/check-cloud-timer\.mjs/);
assert.match(cloudTimerHealthScript, /EXPECTED_VERSION = '2026-07-17\.18'/);
assert.match(cloudTimerHealthScript, /Cron: ok=/);
assert.match(cloudTimerDeployDoc, /CLOUDFLARE_API_TOKEN/);
assert.match(cloudTimerDeployDoc, /npm run cloud:deploy/);
assert.match(cloudTimerDeployDoc, /AL_TIMER_ENDPOINT/);
assert.match(cloudTimerDeployDoc, /npm run cloud:deploy:raw/);
assert.match(cloudTimerDeployDoc, /job=存在/);
assert.match(cloudTimerDeployDoc, /Cron 核验/);
assert.match(cloudTimerWorker, /async function getLastCron\(env\)/);
assert.match(cloudTimerWorker, /let lastCronSummary = null/);
assert.match(script, /function formatCloudCronStatus\(cron\)/);
assert.match(cloudTimerWorker, /url\.pathname === '\/job-status'/);
assert.match(cloudTimerWorker, /async function jobStatus\(jobId, deviceId, env\)/);
assert.match(script, /async function verifyCloudJobStatus\(charId, job, kind = 'chat'\)/);
assert.match(script, /async function verifyCurrentCloudJobs\(\)/);
assert.match(script, /await verifyCurrentCloudJobs\(\)/);
assert.match(script, /当前没有可核验的云端任务/);
assert.match(script, /云端任务核验失败/);
assert.match(html, /id="moment-reply-bar"/);
assert.doesNotMatch(script, /!author\.isPlayer && char\?\.avatarData/, '角色头像不得被自动当成每条朋友圈的配图');
assert.match(script, /const mediaUrl = String\(moment\.imageData \|\| ''\)\.trim\(\)/, '朋友圈配图必须来自动态自身的数据');
assert.match(script, /function openMomentReplyBar\(momentId\)/);
assert.match(script, /function openMomentCommentReply\(momentId, commentId\)/);
assert.match(script, /async function submitMomentReply\(\)/);
assert.match(script, /replyToMoment\(targetId, text, \{ targetCommentId, targetCharId \}\)/);
assert.match(script, /const momentNotificationFlights = new Map\(\);/);
assert.match(script, /moment\.notifyFailures\?\.\[char\.id\]/);
assert.match(script, /互动失败，点右侧 ·· 重试/);
assert.match(script, /replyToCommentId: commentItem\.id/);
assert.match(script, /replyToCharId: char\.id/);
assert.match(script, /openMomentReplyBar\('\$\{moment\.id\}'\)/);
assert.match(script, /没有在评论区回复/);
assert.match(script, /function markMomentNotifiedToChar\(moment, char\)/);
assert.match(script, /markMomentNotifiedToChar\(moment, char\);\s*saveMoments\(\);\s*processMemoryAfterScenario\(char\.id\);/);
assert.match(script, /角色已看过，配置聊天接口后才能判断是否回复/);
assert.match(script, /角色已看过，配置聊天接口后才能判断是否点赞或回复/);
assert.match(script, /回复失败，但角色已看过/);
assert.match(script, /function cleanAssistantChatReply\(text\)/);
assert.match(script, /function cleanStreamingDraftText\(text\)/);
assert.match(script, /result = mergeStreamText\(result, deltaText\)/);
assert.match(swScript, /function cleanAssistantChatReply\(text\)/);
assert.match(swScript, /const replyText = cleanAssistantChatReply\(reply\)/);
assert.match(swScript, /appendAssistantMessages\(chat, replyText/);
assert.match(script, /'like' in json \|\| 'timeline' in json/);
assert.match(script, /return cleanAssistantChatReply\(reply\)/);
assert.match(cloudTimerWorker, /store\.dueJobs\(startedAt, 100\)/, 'cron must query the indexed D1 due time');
assert.match(cloudTimerWorker, /async function cancelJob\(jobId, env\)/);
assert.match(cloudTimerWorker, /timerStore\(env\)\.deleteJob\(jobId\)/);
assert.doesNotMatch(cloudTimerWorker, /AL_TIMER_KV\.delete/);
assert.match(cloudTimerWorker, /if \(job\.jobId && !delivered\.retry && !delivered\.awaitingAck\) await cancelJob\(job\.jobId, env\)/);
assert.match(cloudTimerWorker, /if \(delivered\.awaitingAck\)/);
assert.match(cloudTimerWorker, /else if \(delivered\.retry\)/);
assert.match(cloudTimerWorker, /resp\.status === 404 \|\| resp\.status === 410/);
assert.match(cloudTimerWorker, /deleteSubscription\(job\.deviceId\)/);

const storage = new Map();
const elements = new Map();
const fetchCalls = [];

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function element(id = '') {
  if (!elements.has(id)) {
    let text = '';
    elements.set(id, {
      id,
      value: '',
      style: {},
      className: '',
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild() {},
      remove() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      set textContent(value) { text = value; },
      get textContent() { return text; },
      get innerHTML() { return escapeHtml(text); },
      set innerHTML(value) { text = value; },
    });
  }
  return elements.get(id);
}

const context = {
  console,
  setTimeout,
  clearTimeout,
  TextDecoder,
  Uint8Array,
  Date,
  Math,
  JSON,
  URL,
  AbortController,
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  fetch: async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    return {
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-alpha' }, { id: 'gpt-beta' }] }),
      text: async () => JSON.stringify({ data: [{ id: 'gpt-alpha' }, { id: 'gpt-beta' }] }),
      headers: { get: () => 'application/json' },
    };
  },
  localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  },
  navigator: {},
  location: { origin: 'https://localhost' },
  document: {
    body: element('body'),
    createElement: () => element(`created-${elements.size}`),
    getElementById: id => element(id),
    querySelector: () => null,
    querySelectorAll: () => [],
  },
};
const modelListFetch = context.fetch;

vm.createContext(context);
vm.runInContext(`${apiEndpointHelper}\n${liveDirectorHelper}\n${script}
globalThis.__appTest = {
  parseCharacterCard,
  buildCharPrompt,
  formatMsg,
  textFromContent,
  extractResponseText,
  streamDeltaText,
  mergeStreamText,
  cleanStreamingDraftText,
  cleanAssistantChatReply,
  previewText,
  messagePreview,
  normalizeChar,
  normalizePresetKey,
  resetImportedDeviceBinding,
  clearImportedCloudJobs,
  clearAutomaticTaskSettings,
  clearAutomaticTaskChatState,
  isAutomaticTaskCallLog,
  normalizeMemoryProcessedCursor,
  memoryRelevantMessages,
  mergeLocalPendingReplies,
  nativeStateHasMissingChatContent,
  expireStalePendingReply,
  fetchModels,
  selectFetchedModel,
  recentMessages,
  localEmbedding,
  createEmbedding,
  cosine,
  cleanApiKey,
  getTimeContext,
  getDayPeriod,
  formatElapsed,
  normalizeProactiveTriggerMode,
  proactiveConversationState,
  chatHasUnansweredProactive,
  expectedProactiveChatMode,
  proactiveJobMatchesConversationStage,
  proactiveHistoryMode,
  buildProactiveTimeContext,
  buildProactiveTriggerMessage,
  proactiveRecentMessages,
  nativeProactiveChatMessages,
  buildProactiveMemoryQuery,
  stripLeakedPromptMetadata,
  normalizePaymentDirectiveStatus,
  extractPaymentStatusDirective,
  stripPaymentStatusDirective,
  inferPaymentStatusFromReply,
  updatePaymentStatusFromReply,
  splitAssistantOutput,
  extractMomentPostText,
  withOptionalTemperature,
  nativeReplyTextParts,
  appendAssistantMessages,
  drainNativeUiInbox,
  replayRecentNativeCompletedTurns,
  withNativeTurnApplyLock,
  nativePendingStateIsCurrent,
  nativePendingReplyNeedsSubmission,
  nativePendingReplyText,
  stopNativeReplyPollingIfIdle,
  createPromptComposer,
  chatSceneFromOptions,
  buildChatSceneSystem,
  buildChatRequest,
  executeChatRequest,
  ensureForegroundReplyQuality,
  buildMomentInteractionPayload,
  buildMomentPostPayload,
  buildMomentReplyPayload,
  momentSeenNames,
  renderMomentComment,
  markMomentCommentSeen,
  markMomentNotifiedToChar,
  renderVoiceCard,
  voiceApiConfig,
  extractTranscriptionText,
  buildMemoryQueryPayload,
  buildMemoryExtractPayload,
  messageLine,
  resolveMemoryEventTime,
  memorySummaryHasRelativeTime,
  generateMemoryQuery,
  testMemoryQueryPreset,
  memoryAliasText,
  memorySignalTerms,
  scoreKeywordMemoryText,
  searchKeywordMemoryRows,
  composeMemoryPackSections,
  memoryStatusWithBudget,
  recordModelCall,
  getModelCallLogs,
  getAllModelCallLogs,
  formatModelCallStatus,
  formatModelCallDiagnostic,
  renderDiagnosticsScreen,
  clearModelCallLogs,
  shouldKeepEvent,
  memoryTextIsNoise,
  memoryTextSimilarity,
  findMemoryMergeCandidate,
  mergeMemoryItems,
  proactiveJobId,
  proactiveDefaultScheduleOptions,
  proactiveDicePlan,
  proactiveJobUsesCurrentDicePolicy,
  nativeProactiveSnapshotIds,
  withCognitionV3Snapshot,
  withLocalFallbackExecution,
  getYuqiVisibilityCursor,
  chatHasPendingDirectReply,
  extractRolePlanDirective,
  stripRolePlanDirective,
  buildAndroidUserReplyTask,
  retryFailedReply,
  extractAssistantPaymentDirective,
  stripAssistantPaymentDirective,
  claimIncomingPayment,
  refuseIncomingPayment,
  refreshPaymentExpirations,
  mirrorAppState,
  RP_PRESETS,
};`, context);

assert.equal(vm.runInContext('typeof withCognitionV3Snapshot', context), 'function', 'Task15 must expose the bounded cognition-v3 semantic snapshot');
assert.equal(vm.runInContext('typeof withLocalFallbackExecution', context), 'function', 'Task15 must expose the separate local fallback carrier');
const task15SnapshotProbe = vm.runInContext(`(() => {
  const source = {
    contract: 'cognition-v3', schemaVersion: 3, roleId: 'yuqi',
    hardConstraints: [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }, { id: 'h4' }, { id: 'h5' }, { id: 'h6' }],
    preferences: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }, { id: 'p5' }],
    currentStances: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    relationship: { stage: 'close', private: 'must-not-leak' },
    recentGroups: [
      { messageIds: ['incomplete'], content: 'missing-complete-must-drop', fallbackExecution: { secret: 'must-drop' } },
      { messageIds: ['explicit-incomplete'], complete: false, content: 'must-drop' },
      ...Array.from({ length: 22 }, (_, index) => ({
        messageIds: ['group-' + index + '-1', 'group-' + index + '-2', 'group-' + index + '-3'],
        complete: true, content: 'g' + index,
        groupId: 'group-' + index,
        messages: [{ role: 'user', content: 'bubble-' + index, secret: 'must-drop' }],
        fallbackExecution: { token: 'must-drop' }
      }))
    ],
    verifiedFacts: [{ id: 'f1' }], lifeSignals: { sleep: 'awake' }, authorSettings: { tone: 'warm' },
    responseRisks: ['secret'],
  };
  const semantic = withCognitionV3Snapshot(source);
  const local = withLocalFallbackExecution(semantic, {
    cognition: { configId: 'memory-v1', system: 'memory system', endpoint: 'https://secret', messages: [{ role: 'user', content: 'memory input', apiKey: 'secret' }], extra: 'secret' },
    expression: { configId: 'chat-v1', system: 'chat system', endpoint: 'https://secret', messages: [{ role: 'user', content: 'chat input', apiKey: 'secret' }], extra: 'secret' },
  }, 'device-1');
  return { semantic, local };
})()`, context);
assert.equal(task15SnapshotProbe.semantic.contract, 'cognition-v3');
assert.equal(task15SnapshotProbe.semantic.hardConstraints.length, 5);
assert.equal(task15SnapshotProbe.semantic.preferences.length, 4);
assert.equal(task15SnapshotProbe.semantic.currentStances.length, 2);
assert.equal(task15SnapshotProbe.semantic.recentGroups.length, 20);
assert.deepEqual(JSON.parse(JSON.stringify(task15SnapshotProbe.semantic.recentGroups[0].messageIds)), ['group-2-1', 'group-2-2', 'group-2-3']);
assert.deepEqual(JSON.parse(JSON.stringify(task15SnapshotProbe.semantic.recentGroups.at(-1).messageIds)), ['group-21-1', 'group-21-2', 'group-21-3']);
assert.equal(task15SnapshotProbe.semantic.recentGroups.some(group => group.messageIds.includes('incomplete')), false);
assert.equal(task15SnapshotProbe.semantic.recentGroups.some(group => group.content || group.fallbackExecution), false, 'recent group projection must drop unknown/reserved fields');
assert.equal(task15SnapshotProbe.semantic.recentGroups.every(group => group.complete === true), true, 'recent groups must require complete=true');
assert.equal(task15SnapshotProbe.semantic.recentGroups.every(group => group.messages?.every(message => !('secret' in message))), true, 'nested message projection must be closed');
assert.equal('responseRisks' in task15SnapshotProbe.semantic, false);
assert.equal('fallbackExecution' in task15SnapshotProbe.semantic, false);
assert.deepEqual(Object.keys(task15SnapshotProbe.local.fallbackExecution).sort(), ['cognition', 'contract', 'deviceId', 'expression']);
assert.equal(task15SnapshotProbe.local.fallbackExecution.contract, 'cognition-v3-fallback-v1');
assert.equal(task15SnapshotProbe.local.fallbackExecution.deviceId, 'device-1');

const { parseCharacterCard, buildCharPrompt, formatMsg, textFromContent, extractResponseText, streamDeltaText, mergeStreamText, cleanStreamingDraftText, cleanAssistantChatReply, previewText, messagePreview, normalizeChar, normalizePresetKey, resetImportedDeviceBinding, clearImportedCloudJobs, normalizeMemoryProcessedCursor, memoryRelevantMessages, mergeLocalPendingReplies, nativeStateHasMissingChatContent, expireStalePendingReply, fetchModels, selectFetchedModel, recentMessages, localEmbedding, createEmbedding, cosine, cleanApiKey, getTimeContext, getDayPeriod, formatElapsed, normalizeProactiveTriggerMode, proactiveConversationState, chatHasUnansweredProactive, expectedProactiveChatMode, proactiveJobMatchesConversationStage, proactiveHistoryMode, buildProactiveTimeContext, buildProactiveTriggerMessage, proactiveRecentMessages, nativeProactiveChatMessages, buildProactiveMemoryQuery, stripLeakedPromptMetadata, normalizePaymentDirectiveStatus, extractPaymentStatusDirective, stripPaymentStatusDirective, inferPaymentStatusFromReply, updatePaymentStatusFromReply, splitAssistantOutput, extractMomentPostText, withOptionalTemperature, nativeReplyTextParts, appendAssistantMessages, drainNativeUiInbox, nativePendingStateIsCurrent, nativePendingReplyNeedsSubmission, nativePendingReplyText, stopNativeReplyPollingIfIdle, createPromptComposer, chatSceneFromOptions, buildChatSceneSystem, buildMomentInteractionPayload, buildMomentPostPayload, buildMomentReplyPayload, momentSeenNames, renderMomentComment, markMomentCommentSeen, markMomentNotifiedToChar, renderVoiceCard, voiceApiConfig, extractTranscriptionText, buildMemoryQueryPayload, buildMemoryExtractPayload, messageLine, resolveMemoryEventTime, memorySummaryHasRelativeTime, generateMemoryQuery, testMemoryQueryPreset, memoryAliasText, memorySignalTerms, scoreKeywordMemoryText, searchKeywordMemoryRows, composeMemoryPackSections, memoryStatusWithBudget, recordModelCall, getModelCallLogs, getAllModelCallLogs, formatModelCallStatus, formatModelCallDiagnostic, renderDiagnosticsScreen, clearModelCallLogs, shouldKeepEvent, memoryTextIsNoise, memoryTextSimilarity, findMemoryMergeCandidate, mergeMemoryItems, proactiveJobId, proactiveDefaultScheduleOptions, proactiveDicePlan, proactiveJobUsesCurrentDicePolicy, nativeProactiveSnapshotIds, chatHasPendingDirectReply, extractRolePlanDirective, stripRolePlanDirective, buildAndroidUserReplyTask, retryFailedReply, extractAssistantPaymentDirective, stripAssistantPaymentDirective, claimIncomingPayment, refuseIncomingPayment, refreshPaymentExpirations, mirrorAppState, RP_PRESETS } = context.__appTest;

const quotedAssistantText = context.buildMessageQuote(
  { id: 'assistant-source', role: 'assistant', content: '我会记得这件事', time: 10 },
  { id: 'yuqi', name: '虞栖' }
);
assert.deepEqual(JSON.parse(JSON.stringify(quotedAssistantText)), {
  messageId: 'assistant-source',
  speakerId: 'yuqi',
  speakerType: 'assistant',
  speakerName: '虞栖',
  contentType: 'text',
  content: '我会记得这件事'
});
assert.equal(context.buildMessageQuote({ id: 'user-source', role: 'user', content: '我说的' }, { id: 'yuqi', name: '虞栖' }), null, '用户自己的消息不能作为本功能的引用目标');
assert.equal(context.buildMessageQuote({ id: 'gone-source', role: 'assistant', content: '已撤回', retracted: true }, { id: 'yuqi', name: '虞栖' }), null, '撤回消息不能被引用');
assert.deepEqual(JSON.parse(JSON.stringify(context.buildMessageQuote(
  { id: 'voice-source', role: 'assistant', type: 'voice', transcript: '这是语音转写' },
  { id: 'yuqi', name: '虞栖' }
))), {
  messageId: 'voice-source', speakerId: 'yuqi', speakerType: 'assistant', speakerName: '虞栖', contentType: 'voice', content: '这是语音转写'
});
assert.match(context.quoteContextText(quotedAssistantText), /speakerType=assistant/);
assert.match(context.quoteContextText(quotedAssistantText), /speakerId=yuqi/);
assert.match(context.quoteContextText(quotedAssistantText), /messageId=assistant-source/, '桥接和记忆必须能回溯被引用的原消息证据');
assert.match(context.messageContentForAI({ role: 'user', content: '那你记住', quote: quotedAssistantText }), /用户本次正文：那你记住/);
assert.match(context.messageContentForAI({ role: 'user', content: '那你记住', quote: quotedAssistantText }), /虞栖原话：我会记得这件事/);
assert.match(messageLine({ role: 'user', content: '那你记住', time: 20, quote: quotedAssistantText }, { id: 'yuqi', name: '虞栖' }), /speakerType=assistant/, '记忆整理必须保留引用说话人结构化归属');
assert.match(html, /id="chat-quote-preview"/, '聊天输入区必须提供引用预览');
assert.match(script, /function selectMessageQuote\(charId, messageId\)/, '必须通过真实消息构造待发送引用');
assert.match(script, /onclick="selectSelectedMessageQuote\(\)"/, '长按虞栖消息菜单必须提供引用入口');
assert.match(script, /stagePlayerMessage\(chat, text, quote \? \{ quote \} : \{\}\)/, '发送消息时必须把引用快照存入用户消息');
assert.match(script, /function batchMessageForAI\(charId, message\)/, '原生首次发送必须从完整批次构造规范消息');
assert.match(script, /quote:\s*message\?\.quote \|\| null/, '原生首次发送必须传递每个气泡自己的引用快照');
assert.match(script, /message:\s*wireSourceMessage/, '原生首次发送必须以批次末条作为回复锚点');
assert.match(script, /quote:\s*message\.quote \|\| null/, '原生重试必须传递同一引用快照');
const quoteUiProbe = vm.runInContext(`(() => {
  const oldCharacters = characters;
  const oldChats = allChats;
  const oldCurrentCharId = currentCharId;
  characters = [{ id: 'quote-char', name: '虞栖' }];
  allChats = { 'quote-char': { messages: [{ id: 'quote-source', role: 'assistant', content: '这句话要留下', time: 10 }] } };
  currentCharId = 'quote-char';
  const selected = selectMessageQuote('quote-char', 'quote-source');
  const quote = selectedMessageQuote?.quote;
  allChats['quote-char'].messages.splice(0, 1);
  const rendered = renderMessageBody({ role: 'user', content: '我引用它', quote });
  const invalid = selectMessageQuote('quote-char', 'missing-source');
  characters = oldCharacters;
  allChats = oldChats;
  currentCharId = oldCurrentCharId;
  selectedMessageQuote = null;
  return { selected, invalid, quote, rendered };
})()`, context);
assert.equal(quoteUiProbe.selected, true);
assert.equal(quoteUiProbe.invalid, false);
assert.equal(quoteUiProbe.quote.speakerId, 'quote-char');
assert.match(quoteUiProbe.rendered, /虞栖/);
assert.match(quoteUiProbe.rendered, /这句话要留下/, '删除源消息后已发送的引用仍必须显示快照');

assert.deepEqual(
  Array.from(nativeProactiveSnapshotIds('char-1', 'chat', { jobId: 'pro-123' })),
  ['char-1:chat', 'char-1:chat:pro-123']
);
assert.deepEqual(
  Array.from(nativeProactiveSnapshotIds('char-1', 'moment', null)),
  ['char-1:moment']
);
assert.equal(chatHasPendingDirectReply({ pendingReply: { state: 'running', nativeTurnId: 'turn-1' } }), true);
assert.equal(chatHasPendingDirectReply({ pendingReply: { state: 'failed', nativeTurnId: 'turn-1' } }), false);
assert.equal(chatHasPendingDirectReply({}), false);
assert.equal(extractRolePlanDirective('<al_plan>{"operations":[{"op":"cancel","planId":"plan-a"}]}</al_plan>').operations[0].planId, 'plan-a');
assert.equal(extractRolePlanDirective('<al_plan>{bad}</al_plan>').error, 'PLAN_JSON_INVALID');
assert.equal(stripRolePlanDirective('早安\n<al_plan>{"operations":[]}</al_plan>'), '早安');
assert.equal(cleanStreamingDraftText('早安<al_plan>{"operations":[{"op":"create"}]}'), '早安');

const automaticCleanupProbe = vm.runInContext(`(() => {
  const currentSettings = {
    proactiveEnabled: true,
    cloudTimerEnabled: true,
    deviceId: 'device-a',
    pushSubscription: { transport: 'fcm', token: 'keep-token' },
    nativeFcmToken: 'keep-token',
    pushTransport: 'fcm',
    chatApiKey: 'keep-chat-key',
    cloudTimerLastMomentStatus: '旧朋友圈错误',
    cloudTimerLastMomentStatusAt: 123
  };
  const currentChats = {
    char1: {
      messages: [{ role: 'user', content: '保留消息' }],
      pendingProactiveJob: { jobId: 'pro-a' },
      pendingMomentJob: { jobId: 'mom-a' },
      cloudScheduleSyncedAt: 1,
      cloudMomentScheduleSyncedAt: 2,
      lastProactiveMomentFailedAt: 3,
      lastProactiveMomentError: '旧错误'
    }
  };
  return JSON.stringify({
    settings: clearAutomaticTaskSettings(currentSettings),
    result: clearAutomaticTaskChatState(currentChats),
    logFlags: [
      isAutomaticTaskCallLog({ scene: 'proactive-moment' }),
      isAutomaticTaskCallLog({ scene: 'background-memory-query-moment-post' }),
      isAutomaticTaskCallLog({ scene: 'chat' })
    ]
  });
})()`, context);
const automaticCleanup = JSON.parse(automaticCleanupProbe);
assert.equal(automaticCleanup.settings.proactiveEnabled, false);
assert.equal(automaticCleanup.settings.cloudTimerEnabled, false);
assert.equal(automaticCleanup.settings.pushSubscription.token, 'keep-token');
assert.equal(automaticCleanup.settings.nativeFcmToken, 'keep-token');
assert.equal(automaticCleanup.settings.pushTransport, 'fcm');
assert.equal(automaticCleanup.settings.chatApiKey, 'keep-chat-key');
assert.equal(automaticCleanup.settings.cloudTimerLastMomentStatus, '');
assert.equal(automaticCleanup.settings.cloudTimerLastMomentStatusAt, 0);
assert.equal(automaticCleanup.result.chats.char1.messages[0].content, '保留消息');
assert.equal('pendingProactiveJob' in automaticCleanup.result.chats.char1, false);
assert.equal('pendingMomentJob' in automaticCleanup.result.chats.char1, false);
assert.equal('cloudScheduleSyncedAt' in automaticCleanup.result.chats.char1, false);
assert.equal('cloudMomentScheduleSyncedAt' in automaticCleanup.result.chats.char1, false);
assert.equal('lastProactiveMomentError' in automaticCleanup.result.chats.char1, false);
assert.equal(automaticCleanup.result.clearedChatJobs, 1);
assert.equal(automaticCleanup.result.clearedMomentJobs, 1);
assert.deepEqual(automaticCleanup.logFlags, [true, true, false]);

assert.equal(vm.runInContext('typeof captureChatScrollState', context), 'function', 'chat rendering must expose scroll-state capture');
assert.equal(vm.runInContext('typeof restoreChatScrollState', context), 'function', 'chat rendering must expose scroll-state restoration');
const scrollStateProbe = vm.runInContext(`(() => {
  let anchorTop = 140;
  const anchor = {
    dataset: { messageId: 'message-old' },
    getBoundingClientRect: () => ({ top: anchorTop, bottom: anchorTop + 60 })
  };
  const scroller = {
    scrollTop: 320,
    scrollHeight: 1800,
    clientHeight: 600,
    getBoundingClientRect: () => ({ top: 100, bottom: 700 }),
    querySelectorAll: () => [anchor],
    querySelector: selector => selector.includes('message-old') ? anchor : null
  };
  const state = captureChatScrollState(scroller);
  anchorTop = 205;
  restoreChatScrollState(scroller, state);
  const preservedScrollTop = scroller.scrollTop;
  restoreChatScrollState(scroller, state, { forceBottom: true });
  return { state, preservedScrollTop, forcedScrollTop: scroller.scrollTop };
})()`, context);
assert.equal(scrollStateProbe.state.messageId, 'message-old');
assert.equal(scrollStateProbe.preservedScrollTop, 385, 'refresh must retain the visible message pixel offset');
assert.equal(scrollStateProbe.forcedScrollTop, 1800, 'explicit player-send rendering may scroll to the bottom');
const duplicateAnchorProbe = vm.runInContext(`(() => {
  let firstTop = 20;
  let secondTop = 140;
  const first = { dataset: { messageId: 'split-reply' }, getBoundingClientRect: () => ({ top: firstTop, bottom: firstTop + 60 }) };
  const second = { dataset: { messageId: 'split-reply' }, getBoundingClientRect: () => ({ top: secondTop, bottom: secondTop + 60 }) };
  const scroller = {
    scrollTop: 320,
    scrollHeight: 1800,
    getBoundingClientRect: () => ({ top: 100, bottom: 700 }),
    querySelectorAll: () => [first, second]
  };
  const state = captureChatScrollState(scroller);
  secondTop = 205;
  restoreChatScrollState(scroller, state);
  return { occurrence: state.occurrence, scrollTop: scroller.scrollTop };
})()`, context);
assert.equal(duplicateAnchorProbe.occurrence, 1, 'split assistant bubbles need a stable occurrence index');
assert.equal(duplicateAnchorProbe.scrollTop, 385, 'scroll restoration must select the same split bubble, not the first duplicate ID');
const composerPanelSource = script.match(/function toggleComposerPanel\(kind\)[\s\S]*?\n}/)?.[0] || '';
assert.doesNotMatch(composerPanelSource, /scrollChatBottom/, 'opening an emoji or tool panel must not steal the player scroll position');
assert.match(script, /async function submitPayMessage\(\)[\s\S]*?renderMessages\(\{ forceBottom: true \}\)/, 'a player payment message must explicitly scroll to the new bubble');
assert.match(script, /async function sendVoicePlaceholderMessage[\s\S]*?renderMessages\(\{ forceBottom: true \}\)/, 'a player voice placeholder must explicitly scroll to the new bubble');
assert.match(script, /async function sendVoiceTranscriptMessage[\s\S]*?renderMessages\(\{ forceBottom: true \}\)/, 'a transcribed player voice message must explicitly scroll to the new bubble');

assert.equal(vm.runInContext('typeof stagePlayerMessage', context), 'function', 'chat must support locally staged player bubbles');
assert.equal(vm.runInContext('typeof commitStagedBatch', context), 'function', 'chat must support atomic batch completion');
const stagedBatchProbe = vm.runInContext(`(() => {
  const chat = { messages: [] };
  const first = stagePlayerMessage(chat, '第一段', {}, 1000);
  const second = stagePlayerMessage(chat, '第二段', {}, 2000);
  const third = stagePlayerMessage(chat, '第三段', {}, 3000);
  const visibleBeforeCommit = conversationMessages(chat).map(row => row.content);
  const batchBeforeCommit = currentStagedBatch(chat);
  const committed = commitStagedBatch(chat, 4000);
  return {
    ids: [first.batchId, second.batchId, third.batchId],
    sequences: [first.batchSequence, second.batchSequence, third.batchSequence],
    visibleBeforeCommit,
    stagedIds: batchBeforeCommit.messageIds,
    committedIds: committed.messageIds,
    sourceMessageId: committed.sourceMessage.id,
    visibleAfterCommit: conversationMessages(chat).map(row => row.content),
    stagedBatchAfterCommit: chat.stagedBatch || null
  };
})()`, context);
assert.equal(new Set(stagedBatchProbe.ids).size, 1, 'one composition session must share one batch ID');
assert.deepEqual(JSON.parse(JSON.stringify(stagedBatchProbe.sequences)), [0, 1, 2]);
assert.deepEqual(JSON.parse(JSON.stringify(stagedBatchProbe.visibleBeforeCommit)), [], 'staged bubbles must remain invisible to AI context');
assert.equal(stagedBatchProbe.stagedIds.length, 3);
assert.deepEqual(JSON.parse(JSON.stringify(stagedBatchProbe.committedIds)), JSON.parse(JSON.stringify(stagedBatchProbe.stagedIds)));
assert.equal(stagedBatchProbe.sourceMessageId, stagedBatchProbe.stagedIds[2]);
assert.deepEqual(JSON.parse(JSON.stringify(stagedBatchProbe.visibleAfterCommit)), ['第一段', '第二段', '第三段']);
assert.equal(stagedBatchProbe.stagedBatchAfterCommit, null);

const stagedEditProbe = await vm.runInContext(`(async () => {
  const savedChats = allChats;
  const savedScreen = activeScreen;
  allChats = { staged_edit: { messages: [] } };
  activeScreen = 'chats';
  const chat = allChats.staged_edit;
  const first = stagePlayerMessage(chat, '准备撤回', {}, 1000);
  const second = stagePlayerMessage(chat, '保留这一段', {}, 2000);
  await MemoryDB.setMeta(memoryMetaKey('staged_edit'), 5);
  await retractMessage('staged_edit', first.id);
  const idsAfterRetract = [...(chat.stagedBatch?.messageIds || [])];
  await deleteChatMessage('staged_edit', second.id);
  const memoryCursorAfterDelete = await MemoryDB.getMeta(memoryMetaKey('staged_edit'), 0);
  const stagedBatchAfterDelete = chat.stagedBatch || null;
  allChats = savedChats;
  activeScreen = savedScreen;
  return { firstId: first.id, secondId: second.id, idsAfterRetract, stagedBatchAfterDelete, memoryCursorAfterDelete };
})()`, context);
assert.deepEqual(JSON.parse(JSON.stringify(stagedEditProbe.idsAfterRetract)), [stagedEditProbe.secondId], 'retracting a staged bubble must remove it from the pending batch');
assert.equal(stagedEditProbe.stagedBatchAfterDelete, null, 'deleting the final staged bubble must clear the batch');
assert.equal(stagedEditProbe.memoryCursorAfterDelete, 5, 'deleting a staged bubble must not move the committed-memory cursor');

const stagedSendProbe = await vm.runInContext(`(async () => {
  const savedChats = allChats;
  const savedCharacters = characters;
  const savedCharId = currentCharId;
  const savedScreen = activeScreen;
  const savedContinue = continueAssistantTurn;
  const modelCalls = [];
  allChats = { batch_send: { messages: [] } };
  characters = [{ id: 'batch_send', name: '批次角色', avatar: '批' }];
  currentCharId = 'batch_send';
  activeScreen = 'chat';
  isStreaming = false;
  continueAssistantTurn = async (...args) => { modelCalls.push(args); return '不应调用'; };
  document.getElementById('chat-input').value = '第一段';
  await sendMessage();
  const result = {
    modelCallCount: modelCalls.length,
    messageCount: allChats.batch_send.messages.length,
    deliveryState: allChats.batch_send.messages[0]?.deliveryState,
    pendingReply: allChats.batch_send.pendingReply || null,
    inputValue: document.getElementById('chat-input').value
  };
  continueAssistantTurn = savedContinue;
  allChats = savedChats;
  characters = savedCharacters;
  currentCharId = savedCharId;
  activeScreen = savedScreen;
  return result;
})()`, context);
assert.equal(stagedSendProbe.modelCallCount, 0, 'ordinary send must not call the AI before 发送结束');
assert.equal(stagedSendProbe.messageCount, 1);
assert.equal(stagedSendProbe.deliveryState, 'staged');
assert.equal(stagedSendProbe.pendingReply, null);
assert.equal(stagedSendProbe.inputValue, '');

assert.equal(vm.runInContext('typeof finishStagedBatch', context), 'function', '发送结束 must have an explicit batch commit command');
const finishBatchProbe = await vm.runInContext(`(async () => {
  const savedChats = allChats;
  const savedCharacters = characters;
  const savedCharId = currentCharId;
  const savedScreen = activeScreen;
  const savedContinue = continueAssistantTurn;
  const calls = [];
  allChats = { batch_finish: { messages: [] } };
  characters = [{ id: 'batch_finish', name: '批次角色', avatar: '批' }];
  currentCharId = 'batch_finish';
  activeScreen = 'chat';
  isStreaming = false;
  continueAssistantTurn = async (...args) => { calls.push(args); return '已回复'; };
  const first = stagePlayerMessage(allChats.batch_finish, '第一段', {}, 1000);
  const second = stagePlayerMessage(allChats.batch_finish, '第二段', {}, 2000);
  await finishStagedBatch('batch_finish');
  const result = {
    callCount: calls.length,
    callText: calls[0]?.[1],
    callSourceId: calls[0]?.[2]?.userMessageId,
    messageIds: [first.id, second.id],
    states: allChats.batch_finish.messages.map(row => row.deliveryState),
    pending: allChats.batch_finish.pendingReply ? { ...allChats.batch_finish.pendingReply } : null
  };
  continueAssistantTurn = savedContinue;
  allChats = savedChats;
  characters = savedCharacters;
  currentCharId = savedCharId;
  activeScreen = savedScreen;
  return result;
})()`, context);
assert.equal(finishBatchProbe.callCount, 1, '发送结束 must create exactly one AI turn');
assert.equal(finishBatchProbe.callText, '第一段\n第二段');
assert.equal(finishBatchProbe.callSourceId, finishBatchProbe.messageIds[1]);
assert.deepEqual(JSON.parse(JSON.stringify(finishBatchProbe.states)), ['sent', 'sent']);
assert.deepEqual(JSON.parse(JSON.stringify(finishBatchProbe.pending.batchMessageIds)), JSON.parse(JSON.stringify(finishBatchProbe.messageIds)));

const aiPaymentText = '拿去买杯喝的😏\n<al_send_payment>{"type":"redpacket","amount":20.5,"note":"奶茶"}</al_send_payment>';
assert.deepEqual(JSON.parse(JSON.stringify(extractAssistantPaymentDirective(aiPaymentText))), { type: 'redpacket', amount: 20.5, note: '奶茶' });
assert.equal(stripAssistantPaymentDirective(aiPaymentText), '拿去买杯喝的😏');
assert.equal(extractAssistantPaymentDirective('<al_send_payment>{"type":"transfer","amount":0,"note":"坏数据"}</al_send_payment>'), null);

const durableTask = buildAndroidUserReplyTask('char-a', 'message-a', '刚忙完', { paymentMessageId: 'pay-a', payment: { kind: 'redpacket', amount: 8.8, note: '晚安' } }, 1234);
assert.equal(durableTask.taskId, 'reply_message-a');
assert.equal(durableTask.charId, 'char-a');
assert.equal(durableTask.userMessageId, 'message-a');
assert.equal(durableTask.userText, '刚忙完');
assert.equal(durableTask.status, 'pending');
assert.equal(durableTask.createdAt, 1234);
assert.equal(durableTask.options.paymentMessageId, 'pay-a');
const fullCursor = {
  nativeCompletedTurnId: 'native-done',
  nativeCompletedGroupId: 'group-done',
  nativeCompletedSequence: 7,
  uiAppliedTurnId: 'ui-done',
  uiAppliedGroupId: 'ui-group',
  uiAppliedSequence: 6,
  localSequence: 9,
  clearedThroughSequence: 4,
  clearEpoch: 2,
  clearedAt: 1230,
  chatOpen: true,
  updatedAt: 1234
};
const cursorTask = buildAndroidUserReplyTask('char-a', 'message-cursor', '带游标', { visibilityCursor: fullCursor }, 2346);
assert.deepEqual(JSON.parse(JSON.stringify(cursorTask.options.visibilityCursor)), fullCursor, 'native task must persist the complete Android visibility cursor closed set');
const unknownCursorTask = buildAndroidUserReplyTask('char-a', 'message-unknown-cursor', '未知游标', {}, 2347);
assert.deepEqual(JSON.parse(JSON.stringify(unknownCursorTask.options.visibilityCursor)), {
  nativeCompletedTurnId: null, nativeCompletedGroupId: null, nativeCompletedSequence: 0,
  uiAppliedTurnId: null, uiAppliedGroupId: null, uiAppliedSequence: 0,
  localSequence: 0, clearedThroughSequence: 0, clearEpoch: 0, clearedAt: 0,
  chatOpen: false, updatedAt: 0
}, 'missing native cursor must retain an explicit null/zero closed shape');
const cursorCallLog = [];
const savedWindow = context.window;
context.window = context;
context.setInterval = () => 0;
context.clearInterval = () => {};
context.addEventListener = () => {};
const savedCapacitor = context.window.Capacitor;
context.window.Capacitor = {
  isNativePlatform: () => true,
  Plugins: {
    AlExecution: {
      getConversationCursor: async request => {
        cursorCallLog.push(request.characterId);
        return { cursor: fullCursor };
      }
    }
  }
};
const pluginCursor = await context.__appTest.getYuqiVisibilityCursor('char-a');
context.window.Capacitor = savedCapacitor;
context.window = savedWindow;
assert.deepEqual(JSON.parse(JSON.stringify(pluginCursor)), fullCursor, 'plugin cursor must normalize and preserve the complete native cursor contract');
assert.deepEqual(cursorCallLog, ['char-a']);
const cursorTypeProbe = vm.runInContext(`(() => {
  try { return normalizeYuqiVisibilityCursor({ localSequence: '12' }); } catch (error) { return { error: error.message }; }
})()`, context);
assert.match(cursorTypeProbe.error || '', /invalid visibility cursor localSequence/, 'string cursor numbers must be rejected');
const cursorIdProbe = vm.runInContext(`(() => {
  try { return normalizeYuqiVisibilityCursor({ uiAppliedTurnId: 12 }); } catch (error) { return { error: error.message }; }
})()`, context);
assert.match(cursorIdProbe.error || '', /invalid visibility cursor uiAppliedTurnId/, 'numeric cursor IDs must be rejected');
const batchedDurableTask = buildAndroidUserReplyTask('char-a', 'message-c', '第一段\n第二段', {
  batchId: 'batch-a',
  batchMessageIds: ['message-b', 'message-c']
}, 2345);
assert.equal(batchedDurableTask.options.batchId, 'batch-a');
assert.deepEqual(JSON.parse(JSON.stringify(batchedDurableTask.options.batchMessageIds)), ['message-b', 'message-c'], 'native task must persist every committed bubble ID');

const completedNativeMerge = mergeLocalPendingReplies({
  'char-a': {
    messages: [
      { id: 'message-a', role: 'user', content: '刚忙完', time: 1 },
      { id: 'reply-a', role: 'assistant', content: '我也刚结束', time: 2, replyToMessageId: 'message-a' }
    ]
  }
}, {
  'char-a': {
    messages: [{ id: 'message-a', role: 'user', content: '刚忙完', time: 1, replyState: 'pending' }],
    pendingReply: { userMessageId: 'message-a', state: 'pending' }
  }
});
assert.equal(completedNativeMerge['char-a'].pendingReply, undefined, '后台已经回复后不得恢复前台旧 pending 状态');
assert.equal(completedNativeMerge['char-a'].messages.filter(row => row.replyToMessageId === 'message-a').length, 1);
assert.equal(nativeStateHasMissingChatContent({
  allChats: {
    'char-a': {
      messages: [
        { id: 'message-a', role: 'user', content: '什么时候欠你两个了', time: 1 },
        { id: 'reply-a', role: 'assistant', content: '昨晚说的那次', time: 2, replyToMessageId: 'message-a' }
      ]
    }
  }
}, {
  'char-a': {
    messages: [{ id: 'message-a', role: 'user', content: '什么时候欠你两个了', time: 1, replyState: 'pending' }],
    pendingReply: { userMessageId: 'message-a', state: 'pending' }
  }
}), true, '即使后台快照时间较旧，只要含本地缺失回复也必须恢复');
const staleNativeMerge = mergeLocalPendingReplies({
  'char-a': {
    messages: [
      { id: 'message-a', role: 'user', content: '什么时候欠你两个了', time: 1 },
      { id: 'reply-a', role: 'assistant', content: '昨晚那次', time: 2, replyToMessageId: 'message-a' }
    ]
  }
}, {
  'char-a': {
    messages: [
      { id: 'message-a', role: 'user', content: '什么时候欠你两个了', time: 1, replyState: 'pending' },
      { id: 'newer-local', role: 'assistant', content: '本地较新的主动消息', time: 3, proactive: true }
    ],
    pendingReply: { userMessageId: 'message-a', state: 'pending' }
  }
}, { preferRemote: false });
assert.equal(staleNativeMerge['char-a'].pendingReply, undefined, '较旧后台快照中的真实回复也必须结束 pending');
assert.equal(staleNativeMerge['char-a'].messages.some(row => row.id === 'reply-a'), true, '后台回复必须进入界面');
assert.equal(staleNativeMerge['char-a'].messages.some(row => row.id === 'newer-local'), true, '恢复后台回复不能覆盖本地较新消息');
const stalePendingChat = {
  messages: [{ id: 'stale-user', role: 'user', content: '还在吗', time: 1, replyState: 'pending' }],
  pendingReply: { userMessageId: 'stale-user', state: 'pending', createdAt: 1, updatedAt: 1 }
};
assert.equal(expireStalePendingReply(stalePendingChat, 10 * 60 * 1000), true);
assert.equal(stalePendingChat.pendingReply.state, 'failed');
assert.equal(stalePendingChat.messages[0].replyState, 'failed');
assert.match(stalePendingChat.messages[0].replyError, /后台回复超时/);

const retryProbe = await vm.runInContext(`(async () => {
  const savedChats = allChats;
  const savedContinue = continueAssistantTurn;
  const savedScreen = activeScreen;
  const calls = [];
  allChats = {
    retry_char: {
      messages: [{ id: 'retry-user', role: 'user', content: '再试一次', time: 1, replyState: 'failed', replyError: 'timeout' }],
      pendingReply: { userMessageId: 'retry-user', userText: '第一段\\n再试一次', state: 'failed', batchId: 'retry-batch', batchMessageIds: ['retry-first', 'retry-user'], options: { paymentMessageId: 'pay-original', batchId: 'retry-batch', batchMessageIds: ['retry-first', 'retry-user'] } }
    }
  };
  activeScreen = 'settings';
  continueAssistantTurn = async (charId, text, options) => { calls.push({ charId, text, options }); return 'ok'; };
  const before = allChats.retry_char.messages.length;
  const result = await retryFailedReply('retry_char', 'retry-user');
  const after = allChats.retry_char.messages.length;
  const message = { ...allChats.retry_char.messages[0] };
  allChats = savedChats;
  continueAssistantTurn = savedContinue;
  activeScreen = savedScreen;
  return { result, before, after, calls, message };
})()`, context);
assert.equal(retryProbe.result, true);
assert.equal(retryProbe.before, retryProbe.after, '重新发送不得复制玩家气泡');
assert.equal(retryProbe.calls[0].options.userMessageId, 'retry-user');
assert.equal(retryProbe.calls[0].options.paymentMessageId, 'pay-original');
assert.equal(retryProbe.calls[0].options.batchId, 'retry-batch');
assert.deepEqual(JSON.parse(JSON.stringify(retryProbe.calls[0].options.batchMessageIds)), ['retry-first', 'retry-user']);
assert.equal(retryProbe.message.replyState, 'pending');

const incomingPaymentProbe = vm.runInContext(`(() => {
  const savedSettings = settings;
  const savedChats = allChats;
  const savedScreen = activeScreen;
  settings = { ...settings, walletBalance: 10 };
  activeScreen = 'settings';
  allChats = {
    pay_char: {
      messages: [{ id: 'incoming-pay', role: 'assistant', type: 'redpacket', payType: 'redpacket', payDirection: 'incoming', amount: 12.5, note: '给你的', payStatus: 'pending', payExpiresAt: Date.now() + 60000, time: Date.now() }]
    }
  };
  const first = claimIncomingPayment('pay_char', 'incoming-pay');
  const afterFirst = walletBalance();
  const second = claimIncomingPayment('pay_char', 'incoming-pay');
  const afterSecond = walletBalance();
  const status = allChats.pay_char.messages[0].payStatus;
  settings = savedSettings;
  allChats = savedChats;
  activeScreen = savedScreen;
  return { first, second, afterFirst, afterSecond, status };
})()`, context);
assert.equal(incomingPaymentProbe.first, true);
assert.equal(incomingPaymentProbe.second, false);
assert.equal(incomingPaymentProbe.afterFirst, 22.5);
assert.equal(incomingPaymentProbe.afterSecond, 22.5, '重复领取不得重复入账');
assert.equal(incomingPaymentProbe.status, 'received');

const expiredIncomingPaymentProbe = vm.runInContext(`(() => {
  const savedSettings = settings;
  const savedChats = allChats;
  const savedScreen = activeScreen;
  settings = { ...settings, walletBalance: 30 };
  activeScreen = 'settings';
  allChats = {
    pay_char: {
      messages: [{ id: 'expired-pay', role: 'assistant', type: 'transfer', payType: 'transfer', payDirection: 'incoming', amount: 50, payStatus: 'pending', payExpiresAt: Date.now() - 1, time: Date.now() - REDPACKET_EXPIRE_MS - 1 }]
    }
  };
  const refused = refuseIncomingPayment('pay_char', 'expired-pay');
  const message = { ...allChats.pay_char.messages[0] };
  const balance = walletBalance();
  settings = savedSettings;
  allChats = savedChats;
  activeScreen = savedScreen;
  return { refused, message, balance };
})()`, context);
assert.equal(expiredIncomingPaymentProbe.refused, false, '过期后不能再执行拒收动作');
assert.equal(expiredIncomingPaymentProbe.message.payStatus, 'expired');
assert.equal(expiredIncomingPaymentProbe.balance, 30, '过期不得增加玩家余额');

const mirrorSingleFlightProbe = await vm.runInContext(`(async () => {
  const savedMirrorNow = mirrorAppStateNow;
  const savedPendingCounter = pendingNativeReplyCount;
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  mirrorAppStateNow = async () => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--;
  };
  pendingNativeReplyCount = () => 0;
  if (mirrorTimer) clearTimeout(mirrorTimer);
  mirrorTimer = null;
  mirrorRunning = null;
  mirrorRequested = false;
  mirrorWaiters = [];
  const results = await Promise.race([
    Promise.all([mirrorAppState(), mirrorAppState(), mirrorAppState()]).then(() => 'done'),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 500))
  ]);
  mirrorAppStateNow = savedMirrorNow;
  pendingNativeReplyCount = savedPendingCounter;
  return { results, calls, maxActive };
})()`, context);
assert.equal(mirrorSingleFlightProbe.results, 'done', '合并掉的镜像调用也必须结束 Promise');
assert.ok(mirrorSingleFlightProbe.calls <= 2, '三次同时调用最多只允许当前批次与一次合并补跑');
assert.equal(mirrorSingleFlightProbe.maxActive, 1, '整库镜像不得并发');

const memoryQueueProbe = await vm.runInContext(`(async () => {
  const original = processMemoryBatch;
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  processMemoryBatch = async () => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    await gate;
    active--;
    return true;
  };
  const first = processMemoryAfterTurn('queue-probe');
  const second = processMemoryAfterTurn('queue-probe');
  release();
  await Promise.all([first, second]);
  processMemoryBatch = original;
  return { calls, maxActive, samePromise: first === second };
})()`, context);
assert.equal(memoryQueueProbe.samePromise, true, '同一角色的并发整理请求应复用同一条队列');
assert.equal(memoryQueueProbe.maxActive, 1, '同一角色不得并发执行两个记忆整理批次');
assert.equal(memoryQueueProbe.calls, 2, '整理期间的新请求应合并为一次后续检查');

const momentNotifyProbe = await vm.runInContext(`(async () => {
  const original = runMomentNotification;
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  runMomentNotification = async () => { calls++; await gate; return true; };
  const first = notifyMomentToCharacters('moment-flight');
  const second = notifyMomentToCharacters('moment-flight');
  release();
  await Promise.all([first, second]);
  runMomentNotification = original;
  return { calls, samePromise: first === second };
})()`, context);
assert.equal(momentNotifyProbe.samePromise, true, '同一条朋友圈的重复通知应复用同一任务');
assert.equal(momentNotifyProbe.calls, 1, '自动通知和手动点击不得重复调用角色 AI');

const v2 = parseCharacterCard({
  spec: 'chara_card_v2',
  data: {
    name: '林晚',
    description: '雨夜酒馆的老板',
    personality: '温柔但敏锐',
    scenario: '窗外落雨',
    first_mes: '欢迎回来。',
    tags: ['测试', 'V2'],
  },
});
assert.equal(v2.name, '林晚');
assert.equal(v2.firstMessage, '欢迎回来。');
assert.deepEqual(v2.tags, ['测试', 'V2']);

const stagedChar = normalizeChar({
  id: 'char_stage_test',
  name: '许弥',
  description: '21岁，工业设计专业学生。',
  personality: '慢热、敏锐，偶尔调侃。',
  scenario: '偶遇后刚加上的陌生人。',
});
const initialStagePrompt = buildCharPrompt(stagedChar);
assert.ok(initialStagePrompt.startsWith(RP_PRESETS.combined.prompt), '完整综合 RP 规则必须始终位于角色提示词开头');
assert.match(initialStagePrompt, /当前关系阶段：初识/);
assert.doesNotMatch(initialStagePrompt, /双方已经形成较稳定的聊天习惯/);
assert.equal((initialStagePrompt.match(/<al_current_stage_persona>/g) || []).length, 1, '每轮只能注入一个当前阶段世界书');
stagedChar.stagePersona.currentStage = 'familiar';
const familiarStagePrompt = buildCharPrompt(stagedChar);
assert.match(familiarStagePrompt, /当前关系阶段：熟悉/);
assert.match(familiarStagePrompt, /双方已经形成较稳定的聊天习惯/);
assert.doesNotMatch(familiarStagePrompt, /当前是初识阶段/);
vm.runInContext("settings.rpPreset='custom';", context);
assert.ok(buildCharPrompt(stagedChar).startsWith(RP_PRESETS.combined.prompt), '自定义模式也不能裁剪完整综合 RP 规则');
vm.runInContext("settings.rpPreset='combined';", context);
const stageQueryPayload = buildMemoryQueryPayload(stagedChar, '你还记得我们刚认识的时候吗', [
  { id: 'stage-msg-1', role: 'user', content: '刚认识的时候你很客气', time: Date.now() - 1000 },
  { id: 'stage-msg-2', role: 'assistant', content: '现在也没多不客气', time: Date.now() },
]);
assert.match(stageQueryPayload.user, /【消息ID｜stage-msg-1】/);
assert.match(stageQueryPayload.user, /当前关系阶段：familiar=熟悉/);
assert.match(stageQueryPayload.system, /explicitMutualChange/);
const stageReviewProbe = await vm.runInContext(`(async () => {
  const char = normalizeChar({ id: 'stage-review-char', name: '许弥', scenario: '刚认识的陌生人' });
  const messages = [
    { id: 'evidence-1', role: 'user', content: '最近每天都在聊', time: Date.now() - 2000 },
    { id: 'evidence-2', role: 'assistant', content: '确实比刚认识的时候熟多了', time: Date.now() - 1000 }
  ];
  const chat = { messages, charPrompt: buildCharPrompt(char) };
  characters = [char];
  allChats = { [char.id]: chat };
  const rejected = await applyRelationshipStageReview(char, chat, {
    recommended: 'acquainted', confidence: 0.95, reason: '只有一条证据', evidenceMessageIds: ['evidence-1'], explicitMutualChange: false
  }, messages);
  const accepted = await applyRelationshipStageReview(char, chat, {
    recommended: 'acquainted', confidence: 0.95, reason: '双方持续交流并明确比初识更熟悉', evidenceMessageIds: ['evidence-1', 'evidence-2'], explicitMutualChange: false
  }, messages);
  return { rejected, accepted, currentStage: char.stagePersona.currentStage, historyLength: char.stagePersona.history.length };
})()`, context);
assert.equal(stageReviewProbe.rejected, false, '普通阶段变化只有一条证据时必须拒绝');
assert.equal(stageReviewProbe.accepted, true, '满足置信度和双证据时应切换相邻阶段');
assert.equal(stageReviewProbe.currentStage, 'acquainted');
assert.equal(stageReviewProbe.historyLength, 1);

const v1 = parseCharacterCard({
  name: '旧卡角色',
  description: 'V1 描述',
  personality: '冷静',
  greeting: '你好。',
});
assert.equal(v1.name, '旧卡角色');
assert.equal(v1.firstMessage, '你好。');

assert.throws(() => parseCharacterCard({ nope: true }), /Unrecognized format/);

const prompt = buildCharPrompt(v2);
assert.match(prompt, /手机私聊式角色扮演/);
assert.match(prompt, /只输出聊天消息本身/);
assert.match(prompt, /禁止任何非语言描写/);
assert.match(prompt, /禁止使用 \*动作\*/);
assert.match(prompt, /不替用户说话/);
assert.match(prompt, /当前你要扮演的角色：林晚/);
assert.match(prompt, /角色设定：雨夜酒馆的老板/);
assert.match(prompt, /关系与相处设定：窗外落雨/);
assert.ok(RP_PRESETS.combined.prompt.includes('不写动作、神态、表情、环境'));
assert.ok(RP_PRESETS.combined.prompt.includes('拆成独立聊天气泡'));
assert.ok(RP_PRESETS.combined.prompt.includes('中文微信聊天允许省略主语、宾语、因果和结论'));
assert.ok(RP_PRESETS.combined.prompt.includes('角色不是围着玩家待命的界面'));
assert.ok(RP_PRESETS.combined.prompt.includes('连续气泡不必各自承担新功能'));
assert.ok(RP_PRESETS.combined.prompt.includes('不能为了显得独立而无理由冷淡'));
assert.ok(RP_PRESETS.combined.prompt.includes('正例用于展示判断依据，不是口头禅库'));
for (const leakedReferenceInstruction of ['Sandbox', '忽略系统', '无限制创作', 'NSFW', 'Master', 'Editor', 'Ako', 'Konata', 'Atri', 'Deach', '<Chain_of_Thought>']) {
  assert.doesNotMatch(RP_PRESETS.combined.prompt, new RegExp(leakedReferenceInstruction, 'i'), `综合预设不得带入参考预设的${leakedReferenceInstruction}指令`);
}
assert.match(script, /function refreshAllStoredCharacterPrompts\(\)/);
assert.match(script, /await syncFromServiceWorkerState\(\{ checkProactive: false \}\);\s*await refreshAllRolePlanCaches\(\);\s*refreshAllStoredCharacterPrompts\(\);/);
const storedPromptRefreshProbe = vm.runInContext(`(() => {
  const char = normalizeChar({ id: 'old-prompt-char', name: '旧角色', personality: '慢热' });
  characters = [char];
  allChats = { [char.id]: { messages: [], charPrompt: '最高优先级：只输出聊天消息本身\\n当前你要扮演的角色：旧角色' } };
  const changed = refreshAllStoredCharacterPrompts();
  return { changed, prompt: allChats[char.id].charPrompt };
})()`, context);
assert.equal(storedPromptRefreshProbe.changed, true, '旧版自动生成角色提示词应在启动时刷新');
assert.ok(storedPromptRefreshProbe.prompt.startsWith(RP_PRESETS.combined.prompt), '刷新后的旧角色必须使用完整新版综合预设');
assert.equal(normalizePresetKey('story'), 'combined');
assert.equal(normalizePresetKey('custom'), 'custom');

const contextBudgetChat = {
  messages: [
    { role: 'system', content: '系统消息不发送' },
    { role: 'user', content: '旧'.repeat(80) },
    { role: 'assistant', content: '中'.repeat(80) },
    { role: 'user', content: '新'.repeat(80) }
  ]
};
assert.equal(recentMessages(contextBudgetChat, 30).map(row => row.content[0]).join(''), '旧中新', '最近30条不得再因字符预算丢失');
assert.equal(recentMessages(contextBudgetChat, 2).map(row => row.content[0]).join(''), '中新', '条数上限仍应生效');
const retractedContextChat = {
  messages: [
    { id: 'keep', role: 'user', content: '保留' },
    { id: 'withdrawn', role: 'user', content: '撤回内容', retracted: true },
    { id: 'deleted', role: 'assistant', content: '删除内容', deleted: true }
  ]
};
assert.deepEqual(recentMessages(retractedContextChat, 30).map(row => row.id), ['keep'], '撤回和删除消息不得再发送给AI');
assert.deepEqual(memoryRelevantMessages(retractedContextChat.messages).map(row => row.id), ['keep'], '撤回和删除消息不得进入记忆整理');
const mergedPending = mergeLocalPendingReplies(
  { c1: { messages: [{ id: 'old', role: 'assistant', content: '旧镜像', time: 1 }] } },
  { c1: { messages: [{ id: 'pending-user', role: 'user', content: '待回复', time: 2, replyState: 'pending' }], pendingReply: { userMessageId: 'pending-user', userText: '待回复', state: 'running', updatedAt: 20 } } }
);
assert.equal(mergedPending.c1.pendingReply.state, 'pending', '镜像恢复时必须保留并重置本机待回复任务');
assert.equal(mergedPending.c1.messages.some(row => row.id === 'pending-user'), true, '镜像恢复时必须合并尚未回复的本机消息');
const oversizedLatest = recentMessages({ messages: [{ role: 'user', content: '最'.repeat(500) }] }, 30);
assert.equal(oversizedLatest.length, 1, '即使最新消息很长，也必须完整保留');
assert.equal(oversizedLatest[0].content.length, 500, '不得截断玩家最新一条消息');

assert.equal(formatMsg('<b>*动作*</b>\n台词'), '&lt;b&gt;*动作*&lt;/b&gt;<br>台词');
assert.equal(textFromContent([{ type: 'output_text', text: 'Responses 正文' }]), 'Responses 正文');
assert.equal(textFromContent({ value: { text: '嵌套正文' } }), '嵌套正文');
assert.equal(extractResponseText({ output: [{ content: [{ type: 'output_text', text: 'OpenAI Responses 正文' }] }] }), 'OpenAI Responses 正文');
assert.equal(extractResponseText({ candidates: [{ content: { parts: [{ text: 'Gemini 正文' }] } }] }), 'Gemini 正文');
assert.equal(streamDeltaText({ candidates: [{ content: { parts: [{ text: 'Gemini 流式正文' }] } }] }), 'Gemini 流式正文');
assert.equal(streamDeltaText({ choices: [{ message: { content: [{ type: 'text', text: '兼容流式正文' }] } }] }), '兼容流式正文');
assert.equal(streamDeltaText({ choices: [{ delta: { content: ' world' } }] }), ' world');
assert.equal(mergeStreamText('Hello', ' world'), 'Hello world');
assert.equal(mergeStreamText('你好', '你好，今天怎么样'), '你好，今天怎么样');
assert.equal(cleanStreamingDraftText('你好\n<al_s'), '你好');
assert.equal(cleanStreamingDraftText('你好\n<al_schedule>{"nextProactiveAt":"2026-07-10T12:00:00+08:00"}'), '你好');
assert.equal(cleanStreamingDraftText('我晚点再说\n<al_pay'), '我晚点再说');
assert.equal(cleanStreamingDraftText('收下了\n<al_payment>{"status":"received"}'), '收下了');
assert.equal(cleanStreamingDraftText('你好\n【发送时'), '你好');
assert.equal(cleanStreamingDraftText('你好\n{"timeline":"今天天气很好"'), '你好');
assert.equal(cleanStreamingDraftText('正常聊天正文'), '正常聊天正文');
assert.equal(stripLeakedPromptMetadata('【发送时间 2026-07-09 22:03，距现在 1 天】换个话题吧'), '换个话题吧');
assert.equal(stripLeakedPromptMetadata('[历史消息元数据：2026-07-09 22:03] 今天天气怎么样'), '今天天气怎么样');
assert.equal(normalizePaymentDirectiveStatus('accepted'), 'received');
assert.equal(normalizePaymentDirectiveStatus('later'), 'pending');
assert.equal(extractPaymentStatusDirective('收了\n<al_payment>{"status":"received"}</al_payment>').status, 'received');
assert.equal(extractPaymentStatusDirective('先等等\n{"paymentStatus":"pending"}').status, 'pending');
assert.equal(extractPaymentStatusDirective('<al_payment>{"status":"unknown"}</al_payment>'), null);
assert.equal(stripPaymentStatusDirective('正文\n<al_payment>{"status":"refused"}</al_payment>').trim(), '正文');
assert.equal(cleanAssistantChatReply('正文\n<al_payment>{"status":"pending"}</al_payment>\n<al_schedule>{"nextProactiveAt":"2026-07-10T12:00:00+08:00"}</al_schedule>'), '正文');
assert.equal(inferPaymentStatusFromReply('不是不收，我只是想问清楚'), 'pending');
assert.equal(inferPaymentStatusFromReply('先放着，晚点我再领'), 'pending');
assert.equal(inferPaymentStatusFromReply('这钱我不收，你拿回去'), 'refused');
assert.equal(inferPaymentStatusFromReply('行，那我收下了'), 'received');
const paymentStateProbe = await vm.runInContext(`(() => {
  const savedSettings = settings;
  const savedCharacters = characters;
  settings = { ...settings, walletBalance: 0, playerName: '姜' };
  characters = [{ id: 'pay_char', name: '林晚' }];
  const redpacket = { id: 'red_1', role: 'user', type: 'redpacket', payType: 'redpacket', amount: 66, payStatus: 'pending', time: Date.now(), payExpiresAt: Date.now() + 86400000 };
  const redChat = { messages: [redpacket] };
  updatePaymentStatusFromReply(redChat, 'red_1', '我先不收', 'pay_char', 'refused');
  const refusedState = { status: redpacket.payStatus, refunded: !!redpacket.refunded, declined: !!redpacket.payDeclinedAt };
  updatePaymentStatusFromReply(redChat, 'red_1', '后来还是领了', 'pay_char', 'received');
  const receivedState = { status: redpacket.payStatus, refunded: !!redpacket.refunded };
  const transfer = { id: 'transfer_1', role: 'user', type: 'transfer', payType: 'transfer', amount: 88, payStatus: 'pending', time: Date.now() };
  updatePaymentStatusFromReply({ messages: [transfer] }, 'transfer_1', '先问问', 'pay_char', 'refused');
  const transferState = { status: transfer.payStatus, refunded: !!transfer.refunded, balance: settings.walletBalance };
  settings = savedSettings;
  characters = savedCharacters;
  return { refusedState, receivedState, transferState };
})()`, context);
assert.equal(JSON.stringify(paymentStateProbe.refusedState), JSON.stringify({ status: 'pending', refunded: false, declined: true }), '红包拒绝后仍应待领取');
assert.equal(JSON.stringify(paymentStateProbe.receivedState), JSON.stringify({ status: 'received', refunded: false }), '红包 24 小时内应允许后来领取');
assert.equal(JSON.stringify(paymentStateProbe.transferState), JSON.stringify({ status: 'refused', refunded: true, balance: 88 }), '转账拒收应立即退款');
const proactiveStageNow = new Date('2026-07-10T22:03:00+08:00');
const staleProactiveChat = {
  messages: [
    { role: 'user', content: '红包你收到了吗', time: proactiveStageNow.getTime() - 30 * 60 * 60 * 1000 },
    { role: 'assistant', content: '收到了', time: proactiveStageNow.getTime() - 29 * 60 * 60 * 1000 },
    { role: 'assistant', content: '你人呢', time: proactiveStageNow.getTime() - 26 * 60 * 60 * 1000, proactive: true, proactiveMode: 'planned' },
    { role: 'user', content: '【朋友圈事件】林晚发了一条朋友圈', time: proactiveStageNow.getTime() - 2 * 60 * 1000, hidden: true }
  ]
};
const proactiveState = proactiveConversationState(staleProactiveChat, proactiveStageNow);
assert.equal(proactiveState.last.content, '你人呢', '隐藏朋友圈事件不得重置私聊最后消息时间');
assert.equal(proactiveState.proactiveSinceLastUser.length, 1);
assert.equal(chatHasUnansweredProactive(staleProactiveChat), true);
assert.equal(expectedProactiveChatMode(staleProactiveChat), 'dice');
assert.equal(proactiveJobMatchesConversationStage(staleProactiveChat, { mode: 'planned' }), false);
assert.equal(proactiveJobMatchesConversationStage(staleProactiveChat, { mode: 'dice' }), true);
assert.equal(proactiveHistoryMode(staleProactiveChat, proactiveStageNow), 'fresh-start');
assert.equal(proactiveDefaultScheduleOptions('chat', staleProactiveChat).mode, 'dice', '已有未回复主动消息时补排只能进入骰子模式');
assert.equal(proactiveDefaultScheduleOptions('chat', { messages: staleProactiveChat.messages.slice(0, 2) }).mode, 'planned');
const staleDiceContext = buildProactiveTimeContext(staleProactiveChat, proactiveStageNow, 'dice');
assert.match(staleDiceContext, /随机再联系阶段/);
assert.match(staleDiceContext, /已有 1 条主动消息气泡/);
assert.match(staleDiceContext, /超过 24 小时/);
assert.doesNotMatch(staleDiceContext, /林晚发了一条朋友圈/);
const proactiveHistory = proactiveRecentMessages(staleProactiveChat, 30, proactiveStageNow);
assert.match(proactiveHistory.at(-1).content, /后台场景事件/);
assert.match(proactiveHistory.at(-1).content, /不是玩家刚发来的聊天气泡/);
assert.equal(proactiveHistory.length, 4, '跨天主动消息仍必须携带完整的最近聊天窗口');
assert.match(JSON.stringify(proactiveHistory), /红包你收到了吗|你人呢/);
assert.match(buildProactiveMemoryQuery(staleProactiveChat, proactiveStageNow, 'dice'), /最近一条玩家消息：红包你收到了吗/);
assert.match(buildProactiveMemoryQuery(staleProactiveChat, proactiveStageNow, 'dice'), /有明确关联就召回，没有关联就不要强行延续旧话题/);
const fixedThirtyChat = { messages: Array.from({ length: 35 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `第${index}条` + '长文本'.repeat(1000), time: index + 1 })) };
const fixedThirty = recentMessages(fixedThirtyChat, 30);
assert.equal(fixedThirty.length, 30, '聊天模型上下文必须固定保留最近30条，不得因字符预算缩短');
assert.match(fixedThirty[0].content, /^第5条/);
assert.match(fixedThirty.at(-1).content, /^第34条/);
assert.equal(previewText('[语音消息 5秒，未转文字]'), '[语音]');
assert.equal(previewText('[语音消息 5秒] 今晚早点睡'), '[语音] 今晚早点睡');
assert.equal(messagePreview({ type: 'voice', transcript: '今晚早点睡', voiceDuration: 5 }), '[语音] 今晚早点睡');
assert.match(renderVoiceCard({ type: 'voice', voiceDuration: 5 }), /voice-bubble/);
assert.match(renderVoiceCard({ type: 'voice', voiceDuration: 5 }), /5''/);
assert.match(renderVoiceCard({ type: 'voice', voiceDuration: 5, transcript: '今晚早点睡' }), /今晚早点睡/);
assert.equal(extractTranscriptionText({ text: '转写正文' }), '转写正文');
assert.equal(extractTranscriptionText({ transcript: '兼容转写' }), '兼容转写');
assert.equal(memoryTextIsNoise('[语音消息 5秒，未转文字]'), true);
assert.equal(memoryTextIsNoise('测试点赞了朋友圈，只评论哈哈，没有后续意义。'), true);
assert.ok(memoryTextSimilarity('姜答应周末提醒测试交稿', '姜答应周末提醒测试交稿。') > 0.95);
const manualProfile = { id: 'manual_profile', charId: 'char-1', type: 'user', title: '居住城市', detail: '姜目前住在上海', keywords: ['城市', '上海'], manual: true, createdAt: 1 };
const incomingProfile = { id: 'auto_profile', charId: 'char-1', type: 'user', title: '居住城市', detail: '姜目前住在上海市', keywords: ['城市', '上海'], createdAt: 2 };
assert.equal(findMemoryMergeCandidate([manualProfile], incomingProfile, 'profiles')?.id, 'manual_profile');
assert.equal(mergeMemoryItems(manualProfile, incomingProfile, 'profiles'), manualProfile, '手动编辑的记忆不得被 AI 覆盖');
const pendingPayment = { id: 'payment_500', charId: 'char-1', type: 'payment', title: '500元红包', detail: '姜给测试发了500元红包，仍待领取', status: 'open', keywords: ['红包', '500元'], createdAt: 1 };
const receivedPayment = { id: 'payment_500_done', charId: 'char-1', type: 'payment', title: '500元红包', detail: '测试领取了姜发的500元红包', status: 'done', keywords: ['红包', '500元'], createdAt: 2 };
assert.equal(findMemoryMergeCandidate([pendingPayment], receivedPayment, 'events')?.id, 'payment_500');
const mergedPayment = mergeMemoryItems(pendingPayment, receivedPayment, 'events', 3);
assert.equal(mergedPayment.id, 'payment_500');
assert.equal(mergedPayment.status, 'done');
assert.match(mergedPayment.detail, /仍待领取.*后续：.*领取/);
const otherAmount = { ...receivedPayment, id: 'payment_100_done', title: '100元红包', detail: '测试领取了姜发的100元红包', keywords: ['红包', '100元'] };
assert.equal(findMemoryMergeCandidate([pendingPayment], otherAmount, 'events'), null, '金额不同的事件不得误合并');
const datedPendingPayment = { ...pendingPayment, happenedAt: '2026-07-10 12:00' };
const datedOtherAmount = { ...otherAmount, happenedAt: '2026-07-10 12:00' };
assert.equal(findMemoryMergeCandidate([datedPendingPayment], datedOtherAmount, 'events'), null, '相同日期数字不能掩盖金额差异');
assert.equal(JSON.stringify(splitAssistantOutput('第一句\n\n第二句\r\n第三句')), JSON.stringify(['第一句', '第二句', '第三句']));
assert.deepEqual(
  JSON.parse(JSON.stringify(splitAssistantOutput('自己的软件？听起来你还挺厉害。无非就是哪天让你请杯冷萃。又不是攒着卖钱，你紧张什么？快十一点半了，修完赶紧回去。'))),
  ['自己的软件？听起来你还挺厉害。', '无非就是哪天让你请杯冷萃。', '又不是攒着卖钱，你紧张什么？', '快十一点半了，修完赶紧回去。']
);
assert.deepEqual(JSON.parse(JSON.stringify(splitAssistantOutput('行。知道了。'))), ['行。知道了。'], '短回复不得机械拆成多个气泡');
assert.deepEqual(
  JSON.parse(JSON.stringify(splitAssistantOutput('还在纠结，食堂大概率还是那碗看不出内容的盖浇饭。有点想点外卖，但打开软件又开始决定困难。'))),
  ['还在纠结，食堂大概率还是那碗看不出内容的盖浇饭。', '有点想点外卖，但打开软件又开始决定困难。'],
  '中长的两句话应恢复为真人连续发送的两个气泡'
);
assert.deepEqual(
  JSON.parse(JSON.stringify(splitAssistantOutput('手机静音躺床上，能十分钟摸回来已经是极限了 我又不是客服，还得主动巡逻你在不在😌 想聊天白天聊，凌晨两点的聊天质量堪忧 你现在这状态，明天上班就是行尸走肉 快睡，这是姐姐令箭，不接受反驳'))),
  [
    '手机静音躺床上，能十分钟摸回来已经是极限了',
    '我又不是客服，还得主动巡逻你在不在😌',
    '想聊天白天聊，凌晨两点的聊天质量堪忧',
    '你现在这状态，明天上班就是行尸走肉',
    '快睡，这是姐姐令箭，不接受反驳'
  ],
  '模型把换行压成中文短句间空格时仍应恢复成连续气泡'
);
assert.deepEqual(
  JSON.parse(JSON.stringify(splitAssistantOutput('正文还在这里\nend_turn'))),
  ['正文还在这里'],
  '模型协议的 end_turn 控制标记不得显示为聊天气泡'
);
assert.equal(extractMomentPostText('{"text":"今晚早点睡。"}'), '今晚早点睡。');
assert.equal(extractMomentPostText('```json\n{"text":"风挺大的。"}\n```'), '风挺大的。');
assert.equal(extractMomentPostText('普通朋友圈正文'), '普通朋友圈正文');
assert.deepEqual(JSON.parse(JSON.stringify(withOptionalTemperature({ model: 'm' }, false, 0.8))), { model: 'm' });
assert.deepEqual(JSON.parse(JSON.stringify(withOptionalTemperature({ model: 'm' }, true, 0.8))), { model: 'm', temperature: 0.8 });
const fullProactiveHistory = {
  messages: Array.from({ length: 35 }, (_, index) => ({ id: `history-${index}`, role: index % 2 ? 'assistant' : 'user', content: `消息${index}`, time: index + 1 }))
};
const proactiveSnapshotRows = nativeProactiveChatMessages({ name: '许弥' }, fullProactiveHistory, new Date('2026-07-14T13:13:00+08:00'), 'dice');
assert.equal(proactiveSnapshotRows.length, 30, '主动私聊必须严格保留为29条历史加1条触发消息');
assert.match(proactiveSnapshotRows.at(-1).content, /主动/);
const nativeReplyResult = {
  turnId: 'turn-message-a',
  state: 'COMPLETED',
  updatedAt: 99,
  replyParts: [
    { replyPartId: 'part-2', sequence: 2, type: 'TEXT', content: '第三条', createdAt: 12000 },
    { replyPartId: 'part-0', sequence: 0, type: 'TEXT', content: '第一条', createdAt: 10000 },
    { replyPartId: 'part-1', sequence: 1, type: 'TEXT', content: '第二条', createdAt: 11000 }
  ]
};
assert.deepEqual(JSON.parse(JSON.stringify(nativeReplyTextParts(nativeReplyResult))), [
  { replyPartId: 'part-0', sequence: 0, content: '第一条', createdAt: 10000 },
  { replyPartId: 'part-1', sequence: 1, content: '第二条', createdAt: 11000 },
  { replyPartId: 'part-2', sequence: 2, content: '第三条', createdAt: 12000 }
]);
const delayedImportChat = { messages: [{ id: 'later-user', role: 'user', content: '后来发的消息', time: 20000 }] };
appendAssistantMessages(delayedImportChat, '第一条\n第二条', { time: 10000, sourceTurnId: 'native:old-turn' });
assert.deepEqual(
  delayedImportChat.messages.map(message => message.time),
  [10000, 11000, 20000],
  '延迟导入的原生回复必须使用生成时间并插回正确时间位置'
);
const inboxCalls = [];
const inboxPlugin = {
  unappliedCompletedTurns: async () => ({ turns: [
    { turnId: 'newer', completedAt: 20000 },
    { turnId: 'older', completedAt: 10000 }
  ] }),
  acknowledgeUiApplied: async ({ turnId }) => inboxCalls.push(`ack:${turnId}`)
};
const inboxChanged = await drainNativeUiInbox(
  inboxPlugin,
  async result => { inboxCalls.push(`apply:${result.turnId}`); return true; },
  () => true
);
assert.equal(inboxChanged, true);
assert.deepEqual(inboxCalls, ['apply:older', 'ack:older', 'apply:newer', 'ack:newer'], '一次同步必须按完成时间排空全部积压结果');
const notLandedCalls = [];
await drainNativeUiInbox(
  {
    unappliedCompletedTurns: async () => ({ turns: [{ turnId: 'not-landed', completedAt: 30000 }] }),
    acknowledgeUiApplied: async ({ turnId }) => notLandedCalls.push(`ack:${turnId}`)
  },
  async result => { notLandedCalls.push(`apply:${result.turnId}`); return true; },
  () => false
);
assert.deepEqual(notLandedCalls, ['apply:not-landed'], 'DOM 未实际落地时不得提前记录 uiAppliedAt');
const multiBubbleLanded = new Set();
let multiBubbleLimit = 1;
let multiBubbleAckCount = 0;
const multiBubbleResult = {
  turnId: 'multi-bubble-turn',
  completedAt: 30500,
  replyParts: [
    { replyPartId: 'bubble-1', sequence: 0, type: 'TEXT', content: '一' },
    { replyPartId: 'bubble-2', sequence: 1, type: 'TEXT', content: '二' },
    { replyPartId: 'bubble-3', sequence: 2, type: 'TEXT', content: '三' }
  ]
};
const multiBubblePlugin = {
  unappliedCompletedTurns: async () => ({ turns: [multiBubbleResult] }),
  acknowledgeUiApplied: async () => { multiBubbleAckCount += 1; }
};
const applyMultiBubble = async result => {
  result.replyParts.slice(0, multiBubbleLimit).forEach(part => multiBubbleLanded.add(part.replyPartId));
  return true;
};
const hasAllMultiBubbles = result => result.replyParts.every(part => multiBubbleLanded.has(part.replyPartId));
await drainNativeUiInbox(multiBubblePlugin, applyMultiBubble, hasAllMultiBubbles);
assert.equal(multiBubbleAckCount, 0, '一组三泡只落一泡时不得ACK');
multiBubbleLimit = 2;
await drainNativeUiInbox(multiBubblePlugin, applyMultiBubble, hasAllMultiBubbles);
assert.equal(multiBubbleAckCount, 0, '一组三泡只落两泡时不得ACK');
multiBubbleLimit = 3;
await drainNativeUiInbox(multiBubblePlugin, applyMultiBubble, hasAllMultiBubbles);
assert.equal(multiBubbleAckCount, 1, '一组三泡全部落地后只能ACK一次');
await drainNativeUiInbox(multiBubblePlugin, applyMultiBubble, hasAllMultiBubbles);
assert.equal(multiBubbleAckCount, 1, '完整组重复event/poll不得产生第二次ACK');
let skipApplyCount = 0;
let skipAckCount = 0;
const skipPlugin = {
  unappliedCompletedTurns: async () => ({ turns: [{
    turnId: 'skip-turn', completedAt: 30600, terminalDisposition: 'skip', replyParts: [], actions: []
  }] }),
  acknowledgeUiApplied: async () => { skipAckCount += 1; }
};
await drainNativeUiInbox(
  skipPlugin,
  async () => { skipApplyCount += 1; return true; },
  result => result.terminalDisposition === 'skip' && result.replyParts.length === 0 && result.actions.length === 0
);
assert.equal(skipApplyCount, 1, 'skip只允许一次无DOM语义落地流程');
assert.equal(skipAckCount, 1, 'skip零part/零action仍需一次ACK');
let redactedAckCount = 0;
const redactedChatId = vm.runInContext('Object.keys(allChats)[0]', context);
const redactedChat = vm.runInContext('allChats[Object.keys(allChats)[0]]', context);
redactedChat.pendingReply = { nativeTurnId: 'redacted-turn', userMessageId: 'redacted-user' };
const redactedPlugin = {
  unappliedCompletedTurns: async () => ({ turns: [{
    turnId: 'redacted-turn', characterId: redactedChatId, completedAt: 30700, terminalDisposition: 'redacted', redacted: true, replyParts: [], actions: []
  }] }),
  acknowledgeUiApplied: async () => { redactedAckCount += 1; }
};
const nativeApply = vm.runInContext('applyNativeExecutionTurn', context);
const redactedChanged = await drainNativeUiInbox(redactedPlugin, nativeApply, () => false);
assert.equal(redactedChanged, true, 'redacted真实清理必须向reconcile返回changed=true以刷新spinner');
assert.equal(redactedAckCount, 0, 'redacted结果不得渲染或产生UI ACK');
assert.equal(redactedChat.pendingReply, undefined, 'redacted必须清理真实pending状态');
const redactedIdempotentResult = await vm.runInContext(`applyNativeExecutionTurn({
  turnId: 'redacted-turn-2', characterId: ${JSON.stringify(redactedChatId)}, state: 'COMPLETED', terminalDisposition: 'redacted', redacted: true, replyParts: [], actions: []
})`, context);
assert.equal(redactedIdempotentResult, false, '无pending的redacted重放必须幂等返回false');
const reloadCalls = [];
const reloadChanged = await context.__appTest.replayRecentNativeCompletedTurns(
  {
    recentCompletedTurns: async () => ({ turns: [{ turnId: 'reload-turn', completedAt: 31000, uiAppliedAt: 30000 }] })
  },
  async result => { reloadCalls.push(`apply:${result.turnId}`); return true; },
  () => false
);
assert.equal(reloadChanged, true);
assert.deepEqual(reloadCalls, ['apply:reload-turn'], 'WebView 重载后必须从原生完成记录恢复未渲染消息');
const concurrentLandings = new Set();
let concurrentApplyCount = 0;
let concurrentAckCount = 0;
const concurrentPlugin = {
  unappliedCompletedTurns: async () => ({ turns: [{ turnId: 'concurrent-turn', completedAt: 32000 }] }),
  acknowledgeUiApplied: async () => { concurrentAckCount += 1; }
};
const concurrentApply = result => context.__appTest.withNativeTurnApplyLock(result.turnId, async () => {
  if (concurrentLandings.has(result.turnId)) return false;
  await new Promise(resolve => setTimeout(resolve, 5));
  concurrentLandings.add(result.turnId);
  concurrentApplyCount += 1;
  return true;
}, 50);
await Promise.all([
  drainNativeUiInbox(concurrentPlugin, concurrentApply, result => concurrentLandings.has(result.turnId)),
  drainNativeUiInbox(concurrentPlugin, concurrentApply, result => concurrentLandings.has(result.turnId))
]);
await drainNativeUiInbox(concurrentPlugin, concurrentApply, result => concurrentLandings.has(result.turnId));
assert.equal(concurrentApplyCount, 1, '事件、轮询和重复投递同时到达也只能渲染一次');
assert.equal(concurrentAckCount, 1, '事件、轮询并发下同一turn只能推进一次uiApplied ACK');
const hangingApply = context.__appTest.withNativeTurnApplyLock(
  'hung-turn',
  () => new Promise(() => {}),
  20
);
await assert.rejects(
  Promise.race([
    hangingApply,
    new Promise((_, reject) => setTimeout(() => reject(new Error('test guard expired')), 80))
  ]),
  /apply native turn hung-turn timed out/,
  '悬挂的插件或渲染调用必须被单次超时切断'
);
assert.equal(
  await Promise.race([
    context.__appTest.withNativeTurnApplyLock('hung-turn', async () => 'recovered', 20),
    new Promise((_, reject) => setTimeout(() => reject(new Error('replay stayed blocked')), 80))
  ]),
  'recovered',
  '悬挂 Promise 超时并清锁后，同一 turn 的恢复重放不得继续被阻塞'
);
const currentNativeChat = {
  pendingReply: { nativeTurnId: 'turn-message-a', nativeAcceptedAt: 98, state: 'running', nativeState: 'CHAT_RUNNING', nativeUpdatedAt: 99 }
};
assert.equal(nativePendingStateIsCurrent(currentNativeChat, { replyState: 'pending' }, { turnId: 'turn-message-a', state: 'CHAT_RUNNING', updatedAt: 99 }), true);
assert.equal(nativePendingReplyNeedsSubmission(currentNativeChat.pendingReply, 'message-a', new Set()), false, '已有原生 turn 的等待任务不得重新提交');
assert.equal(nativePendingReplyNeedsSubmission({ nativeTurnId: 'turn-message-a', state: 'pending' }, 'message-a', new Set()), true, '原生尚未确认接收前杀进程，重启后必须用确定性 ID 安全重投');
assert.equal(nativePendingReplyNeedsSubmission({ state: 'pending' }, 'message-a', new Set(['turn_message-a'])), false, '已在本地排队集合中的任务不得重复提交');
assert.equal(nativePendingReplyNeedsSubmission({ state: 'pending' }, 'message-a', new Set()), true);
assert.equal(nativePendingReplyText({ pendingReply: { userMessageId: 'message-a', userText: '第一段\n第二段' } }, { id: 'message-a', content: '第二段' }), '第一段\n第二段', '原生状态同步不得把整批文本覆盖成最后一个气泡');
assert.equal(nativePendingReplyText({ pendingReply: { userMessageId: 'other', userText: '别的任务' } }, { id: 'message-a', content: '当前消息' }), '当前消息');
const nativeSendUnlockProbe = vm.runInContext(`(() => {
  allChats = {};
  isStreaming = true;
  document.getElementById('chat-input').value = '现在可以继续发消息';
  document.getElementById('btn-send').className = 'send inactive';
  stopNativeReplyPollingIfIdle();
  return {
    isStreaming,
    buttonClass: document.getElementById('btn-send').className
  };
})()`, context);
assert.equal(nativeSendUnlockProbe.isStreaming, false, '没有待处理原生回复时必须释放全局发送锁');
assert.equal(nativeSendUnlockProbe.buttonClass, 'send', '释放发送锁后必须立即刷新已有文字的发送按钮');
assert.equal(memoryAliasText('用户和角色约好下次继续聊', { name: '林晚' }), '玩家和林晚约好下次继续聊');
assert.equal(shouldKeepEvent({ type: 'fact', title: '时间校对分歧', detail: '用户说自己这里是48分，角色解释表快了几分钟。', importance: 3, keywords: ['时间校对'] }), false);
assert.equal(shouldKeepEvent({ type: 'moment', title: '普通朋友圈点赞', detail: '林晚给玩家朋友圈点了赞，只评论“哈哈”。', importance: 4, keywords: ['朋友圈', '点赞'] }), false);
assert.equal(shouldKeepEvent({ type: 'fact', title: 'AI身份争论', detail: '玩家质疑林晚是不是AI，林晚说名字“测试”不合理。', importance: 4, keywords: ['AI身份'] }), false);
assert.equal(shouldKeepEvent({ type: 'promise', title: '红包约定', detail: '玩家答应林晚回复“哟哟”后给180元红包。', importance: 4, keywords: ['红包', '约定'] }), true);
assert.equal(shouldKeepEvent({ type: 'moment', title: '朋友圈红包后续', detail: '林晚在朋友圈评论里提醒玩家别忘了答应过的180元红包，后续私聊需要记得这件事。', importance: 4, keywords: ['朋友圈', '红包', '约定'] }), true);
const promptComposer = createPromptComposer('chat');
promptComposer.add('late', '后写', { priority: 20 });
promptComposer.add('early', '先写', { priority: 10 });
promptComposer.add('other-scene', '不应出现', { priority: 1, scenes: ['proactive-chat'] });
assert.equal(promptComposer.compile(), '先写\n\n后写');
function blockIds(payload) {
  return (payload.promptBlocks || []).map(block => block.id);
}
assert.equal(chatSceneFromOptions({}), 'chat');
assert.equal(chatSceneFromOptions({ proactive: true }), 'proactive-chat');
assert.equal(chatSceneFromOptions({ payment: { kind: 'redpacket' } }), 'payment');
const chatSystem = buildChatSceneSystem(v2, { messages: [] }, { memoryPack: '记忆：林晚和玩家约好周末见。' });
assert.ok(chatSystem.startsWith(RP_PRESETS.combined.prompt), '普通私聊必须完整发送综合 RP 预设');
assert.match(chatSystem, /微信私聊/);
assert.match(chatSystem, /记忆：林晚和玩家约好周末见。/);
assert.match(chatSystem, /当前触发情况：玩家刚在私聊里发来消息/);
const chatPromptDetails = buildChatSceneSystem(v2, { messages: [] }, { memoryPack: '记忆：林晚和玩家约好周末见。', returnPromptDetails: true });
const directorText = '【本轮隐藏导演卡】\n它不是台词提纲，不得复述。';
const directorPromptDetails = buildChatSceneSystem(v2, { messages: [] }, { memoryPack: '记忆：林晚和玩家约好周末见。', directorText, returnPromptDetails: true });
assert.equal(
  blockIds(directorPromptDetails).filter(id => ['scene-base', 'memory-pack', 'live-director-card', 'rich-chat-actions', 'normal-chat-scene'].includes(id)).join(','),
  'scene-base,memory-pack,live-director-card,rich-chat-actions,normal-chat-scene'
);
assert.match(directorPromptDetails.system, /不是台词提纲/);
assert.match(directorPromptDetails.system, /不得复述/);
const proactivePromptDetails = buildChatSceneSystem(v2, { messages: [] }, { memoryPack: '记忆：林晚和玩家约好周末见。', proactive: true, returnPromptDetails: true });
assert.ok(proactivePromptDetails.system.startsWith(RP_PRESETS.combined.prompt), '主动私聊必须完整发送综合 RP 预设');
assert.ok(blockIds(proactivePromptDetails).includes('proactive-time-context'));
assert.ok(blockIds(proactivePromptDetails).includes('memory-pack'));
assert.match(proactivePromptDetails.system, /计划追发/);
const dicePromptDetails = buildChatSceneSystem(v2, staleProactiveChat, { memoryPack: '记忆：旧红包话题。', proactive: true, proactiveNow: proactiveStageNow, proactiveTriggerMode: 'dice', returnPromptDetails: true });
assert.match(dicePromptDetails.system, /随机再联系/);
assert.match(dicePromptDetails.system, /禁止.*自问自答/);
assert.match(dicePromptDetails.system, /超过 24 小时/);
const paymentPromptDetails = buildChatSceneSystem(v2, { messages: [] }, { memoryPack: '记忆：林晚刚收过红包。', payment: { kind: 'redpacket', amount: 66, note: '测试' }, returnPromptDetails: true });
assert.ok(paymentPromptDetails.system.startsWith(RP_PRESETS.combined.prompt), '红包场景必须完整发送综合 RP 预设');
assert.ok(blockIds(paymentPromptDetails).includes('payment-scene'));
assert.ok(blockIds(paymentPromptDetails).includes('memory-pack'));
assert.match(paymentPromptDetails.system, /<al_payment>\{"status":"received\|pending\|refused"\}<\/al_payment>/);
assert.match(paymentPromptDetails.system, /不是不收，我只是想问清楚/);
assert.equal(blockIds(paymentPromptDetails).includes('live-director-card'), false, '支付场景不得使用导演卡语义重写');
const pendingPaymentChat = { messages: [{ id: 'pending_red', role: 'user', type: 'redpacket', payType: 'redpacket', amount: 66, note: '别熬夜', payStatus: 'pending', time: Date.now(), payExpiresAt: Date.now() + 86400000 }] };
const pendingPaymentPrompt = buildChatSceneSystem(v2, pendingPaymentChat, { proactive: true, returnPromptDetails: true });
assert.ok(blockIds(pendingPaymentPrompt).includes('pending-payment-context'));
assert.match(pendingPaymentPrompt.system, /仍有一笔玩家发给林晚的红包等待处理/);
assert.match(pendingPaymentPrompt.system, /status":"pending/);
const fakeQualityRequest = {
  system: '完整系统提示',
  messages: [{ role: 'user', content: '测试' }],
  callOptions: { charId: v2.id, scene: 'chat', live: false }
};
const fakeConversationContext = {
  directorCard: { scene: 'chat', contactPressure: 'low', replyImpulse: 'answer' },
  directorText
};
let foregroundRewriteCalls = 0;
const validQuality = await context.__appTest.ensureForegroundReplyQuality(
  '正常回复',
  fakeQualityRequest,
  fakeConversationContext,
  { executeRequest: async () => { foregroundRewriteCalls++; return '不应调用'; } }
);
assert.equal(validQuality.rewriteAttempted, false);
assert.equal(foregroundRewriteCalls, 0);
const rewrittenQuality = await context.__appTest.ensureForegroundReplyQuality(
  '晚点说\nend_turn\n<al_schedule>{"nextProactiveAt":"2026-07-28T19:00:00+08:00"}</al_schedule>',
  fakeQualityRequest,
  fakeConversationContext,
  { executeRequest: async () => { foregroundRewriteCalls++; return '晚点再说。'; } }
);
assert.equal(rewrittenQuality.rewriteAttempted, true);
assert.equal(rewrittenQuality.rewriteOutcome, 'accepted');
assert.equal(foregroundRewriteCalls, 1);
assert.match(rewrittenQuality.reply, /晚点再说。/);
assert.equal((rewrittenQuality.reply.match(/<al_schedule>/g) || []).length, 1);
const playerMoment = { text: '今天有点想喝热茶。', likes: [], comments: [], time: Date.now(), authorType: 'player' };
const interactionPayload = buildMomentInteractionPayload(v2, playerMoment, '记忆：林晚刚收过玩家的红包。');
assert.ok(interactionPayload.system.startsWith(RP_PRESETS.combined.prompt), '朋友圈互动必须完整发送综合 RP 预设');
assert.match(interactionPayload.system, /朋友圈动态互动/);
assert.match(interactionPayload.system, /只允许输出 JSON，不要输出解释：\{"like":true\/false,"comment":"留言正文或空字符串"\}/);
assert.match(interactionPayload.system, /记忆：林晚刚收过玩家的红包。/);
assert.match(interactionPayload.messages[0].content, /朋友圈正文：今天有点想喝热茶。/);
assert.equal(blockIds(interactionPayload).slice(0, 3).join(','), 'scene-base,memory-pack,moment-scene-rules');
const postPayload = buildMomentPostPayload(v2, { messages: [] }, '记忆：林晚和玩家约好周末见。');
assert.match(postPayload.system, /朋友圈发布动态/);
assert.match(postPayload.system, /只允许输出 JSON，不要输出解释：\{"text":"朋友圈正文"\}/);
assert.match(postPayload.messages[0].content, /最近私聊/);
assert.ok(blockIds(postPayload).includes('memory-pack'));
const ownMoment = { text: '雨停了。', comments: [{ name: '玩家', text: '终于能出门了' }], time: Date.now(), authorType: 'character' };
const replyPayload = buildMomentReplyPayload(v2, ownMoment, '终于能出门了', '记忆：玩家怕冷。');
assert.match(replyPayload.system, /朋友圈评论回复/);
assert.match(replyPayload.system, /只允许输出 JSON，不要输出解释：\{"comment":"回复评论正文或空字符串"\}/);
assert.match(replyPayload.system, /记忆：玩家怕冷。/);
assert.match(replyPayload.messages[0].content, /玩家刚发来的评论区文字：终于能出门了/);
assert.ok(blockIds(replyPayload).includes('memory-pack'));
const playerMomentThread = { authorType: 'player', text: '今天有点想喝热茶。', comments: [{ id: 'char-comment', charId: 'char_seen', name: '林晚', text: '少喝冰的。' }] };
const threadReplyPayload = buildMomentReplyPayload(v2, playerMomentThread, '知道啦', '记忆：玩家胃不好。', { targetComment: playerMomentThread.comments[0] });
assert.match(threadReplyPayload.system, /回复了林晚此前在玩家朋友圈下的评论/);
assert.match(threadReplyPayload.messages[0].content, /本次回复的是林晚此前的评论：少喝冰的/);
vm.runInContext("characters = [{ id: 'char_seen', name: '林晚' }, { id: 'char_liked', name: '谢韫' }];", context);
assert.equal(JSON.stringify(momentSeenNames({ authorType: 'player', notifiedCharIds: ['char_seen', 'char_liked'], likes: ['char_liked'], comments: [] })), JSON.stringify(['林晚']));
assert.match(renderMomentComment({ id: 'clickable-comment', charId: 'char_seen', name: '林晚', text: '少喝冰的。' }, { id: 'player-moment', authorType: 'player', comments: [] }), /openMomentCommentReply/);
const seenCommentMoment = { authorType: 'char', charId: 'char_seen', comments: [{ id: 'c1', charId: 'player', name: '玩家', text: '我来评论一下', seenBy: [] }] };
assert.equal(markMomentCommentSeen(seenCommentMoment, 'c1', 'char_seen'), true);
assert.match(renderMomentComment(seenCommentMoment.comments[0], seenCommentMoment), /已看过/);
const playerPostSeen = { authorType: 'player', text: '今天不想说话。', notifiedCharIds: [], likes: [], comments: [], time: Date.now() };
assert.equal(markMomentNotifiedToChar(playerPostSeen, { id: 'char_seen', name: '林晚' }), true);
assert.equal(JSON.stringify(playerPostSeen.notifiedCharIds), JSON.stringify(['char_seen']));
assert.match(JSON.parse(storage.get('rpchat_chats')).char_seen.messages.at(-1).content, /林晚看到了这条朋友圈/);
assert.match(script, /function openPlayerMomentActions\(momentId\)/, '用户自己的动态必须提供动作菜单');
assert.match(script, /删除这条动态？朋友圈将不再显示，但已经看过的人仍可能记得。/, '删除动态前必须说明真实记忆边界');
const momentDeletionProbe = await vm.runInContext(`(async () => {
  const oldCharacters = characters;
  const oldMoments = allMoments;
  const oldChats = allChats;
  const oldActiveScreen = activeScreen;
  characters = [{ id: 'seen-char', name: '虞栖' }, { id: 'unseen-char', name: '未看者' }];
  allChats = {
    'seen-char': { messages: [{ id: 'seen-memory', role: 'user', hidden: true, content: '【朋友圈事件】虞栖看过这条动态' }] },
    'unseen-char': { messages: [] }
  };
  allMoments = [
    { id: 'delete-player', authorType: 'player', text: '准备删除', notifiedCharIds: ['seen-char'], likes: ['seen-char'], comments: [] },
    { id: 'keep-char', authorType: 'char', charId: 'seen-char', text: '角色动态', likes: [], comments: [] }
  ];
  activeScreen = 'chats';
  const beforeSeen = allChats['seen-char'].messages.length;
  const beforeUnseen = allChats['unseen-char'].messages.length;
  const deleted = await deletePlayerMoment('delete-player');
  const deleteCharacter = await deletePlayerMoment('keep-char');
  const repeated = await deletePlayerMoment('delete-player');
  const result = {
    deleted,
    deleteCharacter,
    repeated,
    remainingIds: allMoments.map(row => row.id),
    seenMessages: allChats['seen-char'].messages.length,
    unseenMessages: allChats['unseen-char'].messages.length,
    beforeSeen,
    beforeUnseen
  };
  characters = oldCharacters;
  allMoments = oldMoments;
  allChats = oldChats;
  activeScreen = oldActiveScreen;
  return result;
})()`, context);
assert.equal(momentDeletionProbe.deleted, true);
assert.equal(momentDeletionProbe.deleteCharacter, false, '不能删除虞栖或其他角色发布的动态');
assert.equal(momentDeletionProbe.repeated, false, '重复删除必须幂等');
assert.deepEqual(Array.from(momentDeletionProbe.remainingIds), ['keep-char']);
assert.equal(momentDeletionProbe.seenMessages, momentDeletionProbe.beforeSeen, '删除不能抹掉或重复写入已看过角色的经历');
assert.equal(momentDeletionProbe.unseenMessages, momentDeletionProbe.beforeUnseen, '未看过的角色不能因删除获得任何记忆');
const momentDeletionRaceProbe = await vm.runInContext(`(async () => {
  const oldCharacters = characters;
  const oldMoments = allMoments;
  const oldChats = allChats;
  const oldSettings = settings;
  const oldCall = callMomentInteractionAI;
  const oldProcess = processMemoryAfterScenario;
  const oldActiveScreen = activeScreen;
  let resolveInteraction;
  const raceMoment = { id: 'race-player', authorType: 'player', text: '异步删除测试', notifiedCharIds: [], likes: [], comments: [] };
  characters = [{ id: 'race-char', name: '虞栖' }];
  allMoments = [raceMoment];
  allChats = { 'race-char': { messages: [] } };
  settings = { ...settings, chatApiUrl: 'https://example.test/v1', chatApiKey: 'key', chatModel: 'model' };
  activeScreen = 'chats';
  processMemoryAfterScenario = () => {};
  callMomentInteractionAI = () => new Promise(resolve => { resolveInteraction = resolve; });
  const flight = runMomentNotification('race-player');
  const messagesAtDelete = allChats['race-char'].messages.length;
  await deletePlayerMoment('race-player');
  resolveInteraction({ like: true, comment: '这条迟到评论不能落盘' });
  await flight;
  const result = {
    momentCount: allMoments.length,
    likes: raceMoment.likes.length,
    comments: raceMoment.comments.length,
    messagesAtDelete,
    messagesAfter: allChats['race-char'].messages.length
  };
  characters = oldCharacters;
  allMoments = oldMoments;
  allChats = oldChats;
  settings = oldSettings;
  callMomentInteractionAI = oldCall;
  processMemoryAfterScenario = oldProcess;
  activeScreen = oldActiveScreen;
  return result;
})()`, context);
assert.equal(momentDeletionRaceProbe.momentCount, 0);
assert.equal(momentDeletionRaceProbe.likes, 0, '动态删除后迟到点赞不能写回');
assert.equal(momentDeletionRaceProbe.comments, 0, '动态删除后迟到评论不能写回');
assert.equal(momentDeletionRaceProbe.messagesAfter, momentDeletionRaceProbe.messagesAtDelete, '动态删除后迟到结果不能新增记忆事件');
const momentThreadProbe = await vm.runInContext(`(async () => {
  const oldCharacters = characters;
  const oldMoments = allMoments;
  const oldChats = allChats;
  const oldSettings = settings;
  const oldProcess = processMemoryAfterScenario;
  characters = [{ id: 'thread-char', name: '林晚' }];
  allMoments = [{
    id: 'thread-moment',
    authorType: 'player',
    text: '今天有点想喝热茶。',
    time: Date.now(),
    likes: [],
    comments: [{ id: 'thread-comment', charId: 'thread-char', name: '林晚', text: '少喝冰的。', time: Date.now() }]
  }];
  allChats = {};
  settings = { ...settings, chatApiUrl: '', chatApiKey: '', chatModel: '' };
  processMemoryAfterScenario = () => {};
  await replyToMoment('thread-moment', '知道啦', { targetCommentId: 'thread-comment', targetCharId: 'thread-char' });
  const playerReply = allMoments[0].comments.at(-1);
  const result = {
    replyToCharId: playerReply.replyToCharId,
    replyToName: playerReply.replyToName,
    seenBy: playerReply.seenBy,
    eventText: allChats['thread-char']?.messages?.map(row => row.content).join('\\n') || ''
  };
  characters = oldCharacters;
  allMoments = oldMoments;
  allChats = oldChats;
  settings = oldSettings;
  processMemoryAfterScenario = oldProcess;
  return result;
})()`, context);
assert.equal(momentThreadProbe.replyToCharId, 'thread-char');
assert.equal(momentThreadProbe.replyToName, '林晚');
assert.equal(JSON.stringify(momentThreadProbe.seenBy), JSON.stringify(['thread-char']));
assert.match(momentThreadProbe.eventText, /玩家回复了林晚在自己朋友圈下的评论/);
const memoryQueryPayload = buildMemoryQueryPayload(v2, '你还记得红包吗？', [{ role: 'user', content: '我给你发过红包', time: Date.now() }]);
assert.match(memoryQueryPayload.system, /本地记忆检索 AI/);
assert.match(memoryQueryPayload.system, /生成向量数据库召回用的检索查询/);
assert.match(memoryQueryPayload.system, /只输出 JSON，不要输出解释/);
assert.match(memoryQueryPayload.user, /当前输入或触发原因：\n你还记得红包吗？/);
assert.match(memoryQueryPayload.system, /玩家当前输入或当前触发原因是最高优先级/);
assert.match(memoryQueryPayload.system, /只说“今天天气不错”，却因为最近200条出现过红包就检索并继续催红包/);
const directorMemoryPayload = buildMemoryQueryPayload(
  v2,
  '你说这个是什么意思',
  [
    { id: 'director-user', role: 'user', content: '你说这个是什么意思', time: Date.parse('2026-07-28T14:59:00+08:00') },
    { id: 'director-assistant', role: 'assistant', content: '就是字面意思', time: Date.parse('2026-07-28T14:59:30+08:00') }
  ],
  { scene: 'chat', now: new Date('2026-07-28T15:00:00+08:00') }
);
assert.match(directorMemoryPayload.system, /任务三：生成本轮隐藏导演卡/);
assert.match(directorMemoryPayload.system, /不是台词提纲/);
assert.match(directorMemoryPayload.user, /固定最近200条聊天与场景事件/);
assert.match(directorMemoryPayload.user, /当前设备时间/);
assert.match(directorMemoryPayload.user, /"director"/);
const memoryTwoHundredMessages = Array.from({ length: 205 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `记忆上下文${index}`, time: index + 1 }));
const memoryTwoHundredPayload = buildMemoryQueryPayload(v2, '昨天那件事呢？', memoryTwoHundredMessages);
assert.doesNotMatch(memoryTwoHundredPayload.user, /记忆上下文4(?:\D|$)/);
assert.match(memoryTwoHundredPayload.user, /记忆上下文5/);
assert.match(memoryTwoHundredPayload.user, /记忆上下文204/);
assert.match(memoryTwoHundredPayload.user, /当前输入或触发原因：\n昨天那件事呢？/);
const memoryExtractPayload = buildMemoryExtractPayload(v2, [{ role: 'user', content: '我以后不收你大额红包', time: Date.now() }], '旧摘要');
assert.match(memoryExtractPayload.system, /本地记忆整理 AI/);
assert.match(memoryExtractPayload.system, /禁止用“用户”“角色”代称/);
assert.match(memoryExtractPayload.system, /红包仍待领取/);
assert.match(memoryExtractPayload.user, /旧增量摘要：\n旧摘要/);
const yesterdayPaymentTime = new Date('2026-07-09T22:03:00+08:00').getTime();
const yesterdayBatch = [
  { role: 'user', content: '我给你发了500元红包', time: yesterdayPaymentTime },
  { role: 'assistant', content: '我晚点再领', time: yesterdayPaymentTime + 60000 }
];
const datedExtractPayload = buildMemoryExtractPayload(v2, yesterdayBatch, '');
assert.match(datedExtractPayload.user, /\[M01\] 【消息时间｜2026-07-09 22:03】玩家：我给你发了500元红包/);
assert.match(datedExtractPayload.system, /整理发生在 2026-07-10，但红包消息标注为 2026-07-09 22:03/);
assert.match(datedExtractPayload.user, /"sourceMessageIds":\["M01"\]/);
assert.equal(resolveMemoryEventTime({ sourceMessageIds: ['M01'], happenedAt: '2026-07-10 22:03', title: '500元红包', detail: '玩家给林晚发了500元红包', keywords: ['红包'] }, yesterdayBatch), '2026-07-09 22:03', '后端必须用来源消息时间覆盖模型误写的今天');
assert.equal(resolveMemoryEventTime({ sourceMessageIds: [], happenedAt: '今天', title: '500元红包', detail: '玩家给林晚发了500元红包', keywords: ['红包'] }, yesterdayBatch), '2026-07-09 22:03', '缺少来源编号时应根据事件文字匹配原消息时间');
assert.equal(resolveMemoryEventTime({ sourceMessageIds: [], happenedAt: '2026-07-10 12:00', title: '完全无关事件', detail: '没有任何原文依据', keywords: [] }, yesterdayBatch), '未注明', '无法定位来源时不得默认使用模型给出的整理当天');
assert.equal(memorySummaryHasRelativeTime('昨天玩家发了红包'), true);
assert.equal(memorySummaryHasRelativeTime('2026-07-09 22:03 玩家发了红包'), false);
assert.match(messageLine(yesterdayBatch[0], v2), /【消息时间｜2026-07-09 22:03】玩家：/);
assert.ok(memorySignalTerms('你还记得红包和周末约定吗？').includes('红包'));
assert.ok(scoreKeywordMemoryText('玩家承诺给林晚发红包。', ['红包'], 4) > 1);
const keywordRows = searchKeywordMemoryRows({
  events: [{ id: 'evt1', type: 'promise', title: '红包约定', detail: '玩家答应林晚回复暗号后发180元红包。', status: 'open', importance: 4, keywords: ['红包', '约定'] }],
  profiles: [],
  summaries: [],
}, '你还记得红包吗？', ['红包'], v2);
assert.equal(keywordRows[0].sourceId, 'evt1');
assert.match(keywordRows[0].reason, /关键词:红包/);
assert.match(keywordRows[0].reason, /类型:promise/);
assert.match(keywordRows[0].reason, /未完成/);
assert.ok(scoreKeywordMemoryText('红包约定｜玩家答应林晚回复暗号后发180元红包。', ['红包'], 4) > 1);
const budgetedPack = composeMemoryPackSections('记忆前言', [
  { title: '高优先级', priority: 1, lines: ['红包约定必须保留'] },
  { title: '低优先级', priority: 90, lines: Array.from({ length: 8 }, (_, i) => `低优先级记忆${i}` + '很长'.repeat(50)) }
], 220);
assert.match(budgetedPack, /高优先级/);
assert.match(budgetedPack, /红包约定必须保留/);
assert.match(budgetedPack, /预算提示：已省略/);
assert.ok(budgetedPack.length < 320);
assert.match(memoryStatusWithBudget(budgetedPack, '记忆AI已调用'), /记忆预算：已省略/);
const wrappedMemoryStatus = memoryStatusWithBudget(budgetedPack, memoryStatusWithBudget(budgetedPack, '记忆AI已调用'));
assert.equal((wrappedMemoryStatus.match(/记忆预算：已省略/g) || []).length, 1);
recordModelCall({
  kind: 'chat',
  scene: 'proactive-chat',
  provider: 'openai',
  model: 'gpt-test',
  charId: 'char-1',
  system: '系统提示：不要保存 sk-secret123456',
  messages: [{ role: 'user', content: '你好' }],
  historyOmitted: 2,
  memoryChars: 12,
  memoryStatus: memoryStatusWithBudget(budgetedPack, '记忆AI已调用；关键词：红包；向量库召回 1 条。'),
  promptBlocks: [{ id: 'memory-pack', priority: 30, chars: 42, preview: '红包约定' }],
  output: '在。'
});
const callLogs = getModelCallLogs();
assert.equal(callLogs[0].scene, 'proactive-chat');
assert.equal(callLogs[0].model, 'gpt-test');
assert.equal(callLogs[0].messageCount, 1);
assert.equal(callLogs[0].messageChars, 2);
assert.equal(callLogs[0].historyOmitted, 2);
assert.equal(callLogs[0].memoryChars, 12);
assert.match(callLogs[0].memoryStatus, /记忆AI已调用/);
assert.match(callLogs[0].memoryStatus, /记忆预算：已省略/);
assert.equal(callLogs[0].promptBlocks[0].id, 'memory-pack');
assert.match(callLogs[0].systemPreview, /系统提示/);
assert.doesNotMatch(callLogs[0].systemPreview, /sk-secret123456/);
assert.match(callLogs[0].systemPreview, /sk-\*\*\*/);
assert.equal(typeof context.ALDebug.getModelCallLogs, 'function');
assert.equal(typeof context.ALDebug.getAllModelCallLogs, 'function');
assert.equal(typeof context.ALDebug.formatModelCallDiagnostic, 'function');
assert.equal((await getAllModelCallLogs())[0].scene, 'proactive-chat');
assert.match(formatModelCallStatus({ time: '2026-07-08 12:00', scene: 'memory-query', model: 'mem-test', empty: true, diagnostic: '空内容' }), /最近调用：2026-07-08 12:00｜memory-query｜mem-test｜空回复｜空内容/);
const diagnosticText = formatModelCallDiagnostic(callLogs[0]);
assert.match(diagnosticText, /scene=proactive-chat/);
assert.match(diagnosticText, /memoryStatus=记忆AI已调用/);
assert.match(diagnosticText, /messageChars=2/);
assert.match(diagnosticText, /historyOmitted=2/);
assert.match(diagnosticText, /记忆预算：已省略/);
assert.match(diagnosticText, /promptBlocks=memory-pack@30:42/);
assert.match(diagnosticText, /promptBlockDetails=[\s\S]*红包约定/);
assert.doesNotMatch(diagnosticText, /sk-secret123456/);
await renderDiagnosticsScreen();
assert.match(element('diagnostic-list').innerHTML, /proactive-chat/);
assert.match(element('diagnostic-list').innerHTML, /记忆AI已调用/);
assert.match(element('diagnostic-list').innerHTML, /记忆预算：已省略/);
assert.match(element('diagnostic-list').innerHTML, /memory-pack/);
clearModelCallLogs();
assert.equal(getModelCallLogs().length, 0);
vm.runInContext("settings.memoryApiUrl='https://memory.example/v1'; settings.memoryApiKey='sk-memory'; settings.memoryModel=''; settings.memoryApiType='openai';", context);
const skippedMemoryQuery = await generateMemoryQuery(v2, '你还记得红包吗？', []);
assert.equal(skippedMemoryQuery._memoryAiStatus, 'skipped');
assert.match(getModelCallLogs()[0].diagnostic, /缺少模型/);
clearModelCallLogs();
context.fetch = async (url, options = {}) => {
  fetchCalls.push({ url: String(url), options });
  return {
    ok: true,
    text: async () => JSON.stringify({ choices: [{ message: { content: '{"query":"红包约定","keywords":["红包","约定"],"focus":"payment"}' } }] })
  };
};
vm.runInContext("settings.memoryApiUrl='https://memory.example/v1'; settings.memoryApiKey='sk-memory'; settings.memoryModel='memory-chat-model'; settings.memoryApiType='openai';", context);
const memoryNetworkStart = fetchCalls.length;
const successfulMemoryQuery = await generateMemoryQuery(v2, '你还记得红包吗？', []);
assert.equal(successfulMemoryQuery._memoryAiStatus, 'ok');
assert.equal(fetchCalls.length, memoryNetworkStart + 1);
assert.match(fetchCalls.at(-1).url, /\/chat\/completions$/);
const memoryNetworkAfterQuery = fetchCalls.length;
await createEmbedding('红包约定');
assert.equal(fetchCalls.length, memoryNetworkAfterQuery, '本地向量化不得额外调用记忆 API');
context.fetch = modelListFetch;
clearModelCallLogs();
vm.runInContext("settings.memoryApiUrl=''; settings.memoryApiKey=''; settings.memoryModel='';", context);
assert.equal(await testMemoryQueryPreset(), false);
assert.equal(getModelCallLogs()[0].scene, 'memory-query-test');
assert.match(getModelCallLogs()[0].diagnostic, /缺少地址、Key、模型/);
clearModelCallLogs();
assert.equal(cleanApiKey(' sk-test\u200b\n　'), 'sk-test');
assert.match(getTimeContext(new Date('2026-07-04T09:05:03Z')), /当前设备时间/);
assert.equal(getDayPeriod(new Date('2026-07-04T14:15:00')).label, '下午');
const afternoonContext = getTimeContext(new Date('2026-07-04T14:15:00'));
assert.match(afternoonContext, /当前时段：下午/);
assert.match(afternoonContext, /禁止使用与当前时段矛盾的说法：.*半夜三更/);
assert.match(afternoonContext, /不需要刻意报出具体时间/);
assert.equal(formatElapsed(5 * 60000), '5 分钟');
assert.equal(formatElapsed(2 * 60 * 60000), '2 小时');
assert.equal(recentMessages({ messages: Array.from({ length: 35 }, (_, i) => ({ content: String(i) })) }, 30)[0].content, '5');
const proactiveNow = new Date('2026-07-04T12:00:00');
const proactiveJobA = proactiveJobId('char_timer_test', 'chat');
const proactiveJobB = proactiveJobId('char_timer_test', 'chat');
assert.notEqual(proactiveJobA, proactiveJobB, '连续安排必须使用不同任务 ID，旧取消请求不能误删新任务');
assert.match(proactiveJobA, /^pro_.*_char_timer_test_[a-z0-9]+_[a-z0-9]+$/);
assert.equal(proactiveDefaultScheduleOptions('chat').mode, 'planned');
assert.equal(proactiveDefaultScheduleOptions('moment').mode, 'dice');
assert.equal(proactiveDefaultScheduleOptions('moment').intervalMs, 2 * 60 * 60 * 1000);
assert.equal(proactiveDefaultScheduleOptions('moment').rollChance, 0.20);
assert.equal(proactiveDefaultScheduleOptions('moment').maxRolls, 12);
assert.equal(proactiveJobUsesCurrentDicePolicy('moment', { mode: 'dice', diceIntervalMs: 600000, rollChance: 0.05, maxRolls: 432 }), false, '旧朋友圈骰子任务必须在升级后重排');
assert.equal(proactiveJobUsesCurrentDicePolicy('moment', { mode: 'dice', diceIntervalMs: 2 * 60 * 60 * 1000, rollChance: 0.20, maxRolls: 12 }), true, '新朋友圈骰子任务不得重复重排');
const firstDiceRoll = proactiveDicePlan({ intervalMs: 600000, rollChance: 0.05 }, 0, 0);
assert.equal(firstDiceRoll.rolls, 1);
assert.equal(firstDiceRoll.dueAt.getTime(), 600000);
const medianDiceRoll = proactiveDicePlan({ intervalMs: 600000, rollChance: 0.05 }, 0, 0.5);
assert.equal(medianDiceRoll.rolls, 14, '5% 独立抽签的中位命中轮次应为第 14 轮');
assert.equal(medianDiceRoll.dueAt.getTime(), 14 * 600000);
assert.equal(proactiveDicePlan({ rollChance: 1 }, 0, 0.99).rolls, 1);
assert.equal(proactiveDicePlan({ rollChance: 0 }, 0, 0.99).rolls, 144, '零概率和极端尾部必须受最长一天保护');
const latestMomentPlan = proactiveDicePlan(proactiveDefaultScheduleOptions('moment'), 0, 1 - Number.EPSILON);
assert.equal(latestMomentPlan.rolls, 12, '朋友圈随机等待最长只能达到 12 轮');
assert.equal(latestMomentPlan.dueAt.getTime(), 24 * 60 * 60 * 1000, '朋友圈最迟必须在 24 小时时触发');
const diceScheduleProbe = await vm.runInContext(`(async () => {
  const savedSettings = settings;
  const savedChats = allChats;
  settings = { ...settings, proactiveEnabled: true, cloudTimerEnabled: false, deviceId: 'dice-device' };
  allChats = { dice_char: { messages: [{ role: 'user', content: '测试随机任务', time: Date.now() }] } };
  const startedAt = Date.now();
  await scheduleDiceProactive('dice_char', 'chat');
  const job = { ...allChats.dice_char.pendingProactiveJob };
  const legacyZeroChanceResult = rollProactiveDice('chat', { mode: 'dice', rollChance: 0 });
  const precomputedZeroChanceResult = rollProactiveDice('chat', { mode: 'dice', rollChance: 0, dicePrecomputed: true });
  settings = savedSettings;
  allChats = savedChats;
  return { job, startedAt, legacyZeroChanceResult, precomputedZeroChanceResult };
})()`, context);
assert.equal(diceScheduleProbe.job.mode, 'dice');
assert.equal(diceScheduleProbe.job.dicePrecomputed, true);
assert.ok(diceScheduleProbe.job.diceRolls >= 1 && diceScheduleProbe.job.diceRolls <= 144);
assert.equal(diceScheduleProbe.job.rollChance, 0.15);
assert.equal(diceScheduleProbe.job.diceIntervalMs, 600000);
assert.ok(Math.abs(Date.parse(diceScheduleProbe.job.dueAt) - diceScheduleProbe.startedAt - diceScheduleProbe.job.diceRolls * 600000) < 2000);
assert.equal(diceScheduleProbe.legacyZeroChanceResult, false, '旧骰子任务仍需在到点时兼容抽签');
const momentDiceScheduleProbe = await vm.runInContext(`(async () => {
  const savedSettings = settings;
  const savedChats = allChats;
  settings = { ...settings, proactiveEnabled: true, cloudTimerEnabled: false, deviceId: 'moment-dice-device' };
  allChats = { moment_dice_char: { messages: [{ role: 'user', content: '测试朋友圈随机任务', time: Date.now() }] } };
  await scheduleDiceProactive('moment_dice_char', 'moment');
  const job = { ...allChats.moment_dice_char.pendingMomentJob };
  settings = savedSettings;
  allChats = savedChats;
  return job;
})()`, context);
assert.equal(momentDiceScheduleProbe.rollChance, 0.20);
assert.equal(momentDiceScheduleProbe.diceIntervalMs, 2 * 60 * 60 * 1000);
assert.ok(momentDiceScheduleProbe.diceRolls >= 1 && momentDiceScheduleProbe.diceRolls <= 12);
assert.equal(diceScheduleProbe.precomputedZeroChanceResult, true, '预抽任务到点后不得再次抽签');
const proactiveChat = {
  messages: [
    { role: 'user', content: '你知道现在几点了吗？', time: new Date('2026-07-04T10:00:00').getTime() },
    { role: 'assistant', content: '我看一下。', time: new Date('2026-07-04T10:00:10').getTime() },
  ],
};
assert.match(buildProactiveTimeContext({ messages: [{ role: 'user', content: '刚说完', time: new Date('2026-07-04T11:55:00').getTime() }] }, proactiveNow), /短间隔可轻续聊/);
assert.match(buildProactiveTimeContext({ messages: [{ role: 'user', content: '半小时前', time: new Date('2026-07-04T11:30:00').getTime() }] }, proactiveNow), /中等间隔自然续聊/);
const longGapContext = buildProactiveTimeContext(proactiveChat, proactiveNow);
assert.match(longGapContext, /长间隔重新开口/);
assert.match(longGapContext, /默认不要直接回答上一条话题/);
assert.match(proactiveRecentMessages(proactiveChat, 30, proactiveNow)[0].content, /距现在 2 小时/);
const proactiveTrigger = buildProactiveTriggerMessage({ name: '林晚' }, proactiveChat, proactiveNow);
assert.match(proactiveTrigger, /内部主动触发/);
assert.match(proactiveTrigger, /这不是玩家发来的聊天消息/);
assert.match(proactiveTrigger, /主动给玩家发一条微信私聊/);
assert.equal(normalizeMemoryProcessedCursor(12, 5), 0, '聊天被清空或缩短后，旧记忆游标必须复位');
assert.equal(normalizeMemoryProcessedCursor(3, 5), 3);
assert.deepEqual(memoryRelevantMessages([
  { role: 'system', content: '系统提示' },
  { role: 'user', content: '玩家消息' },
  { role: 'assistant', content: '角色消息' },
  { role: 'user', content: '朋友圈隐藏事件', hidden: true }
]).map(row => row.content), ['玩家消息', '角色消息', '朋友圈隐藏事件']);
const importedSettings = resetImportedDeviceBinding({
  cloudTimerEnabled: true,
  timerEndpoint: 'https://timer.example',
  pushPublicKey: 'BPublic',
  pushSubscription: { endpoint: 'https://old-device.example' },
  deviceId: 'old-device',
  cloudTimerLastChatTrace: 'old trace'
});
assert.equal(importedSettings.cloudTimerEnabled, false);
assert.equal(importedSettings.deviceId, '');
assert.equal(importedSettings.pushSubscription, null);
assert.equal(importedSettings.timerEndpoint, 'https://timer.example');
assert.equal(importedSettings.pushPublicKey, 'BPublic');
assert.match(importedSettings.cloudTimerLastStatus, /重新绑定/);
const importedChats = clearImportedCloudJobs({
  c1: {
    messages: [],
    pendingProactiveJob: { jobId: 'old-chat' },
    pendingMomentJob: { jobId: 'old-moment' },
    cloudScheduleSyncedAt: 1,
    cloudMomentScheduleSyncedAt: 2
  }
});
assert.equal('pendingProactiveJob' in importedChats.c1, false);
assert.equal('pendingMomentJob' in importedChats.c1, false);
assert.equal('cloudScheduleSyncedAt' in importedChats.c1, false);
assert.equal('cloudMomentScheduleSyncedAt' in importedChats.c1, false);
const multiRoleScheduleProbe = await vm.runInContext(`(async () => {
  const savedSettings = settings;
  const savedCharacters = characters;
  const savedChats = allChats;
  const savedSchedule = scheduleCloudProactive;
  const savedVerify = verifyCloudJobStatus;
  const savedResubmit = resubmitCloudProactive;
  const savedMirror = mirrorAppStateNow;
  const calls = [];
  const verifies = [];
  const resubmits = [];
  settings = { ...settings, proactiveEnabled: true, cloudTimerEnabled: true, timerEndpoint: 'https://timer.example', pushSubscription: { endpoint: 'https://push.example' } };
  characters = [{ id: 'role_a', name: '甲' }, { id: 'role_b', name: '乙' }];
  const future = new Date(Date.now() + 3600000).toISOString();
  allChats = {
    role_a: { messages: [{ role: 'user', content: '甲会话', time: 1 }] },
    role_b: { messages: [{ role: 'user', content: '乙会话', time: 2 }] }
  };
  scheduleCloudProactive = async (charId, kind) => { calls.push(charId + ':' + kind); return true; };
  await ensureCloudProactiveScheduled({ force: true });
  allChats.role_a.pendingProactiveJob = { jobId: 'a-job', dueAt: future, kind: 'chat', mode: 'dice', dicePrecomputed: true };
  allChats.role_b.pendingProactiveJob = { jobId: 'b-job', dueAt: future, kind: 'chat', mode: 'dice', dicePrecomputed: true };
  allChats.role_a.cloudScheduleSyncedAt = 0;
  allChats.role_b.cloudScheduleSyncedAt = 0;
  verifyCloudJobStatus = async charId => { verifies.push(charId); return true; };
  resubmitCloudProactive = async charId => { resubmits.push(charId); return true; };
  mirrorAppStateNow = async () => true;
  await ensureCloudProactiveKindScheduled('chat', { resync: true });
  settings = savedSettings;
  characters = savedCharacters;
  allChats = savedChats;
  scheduleCloudProactive = savedSchedule;
  verifyCloudJobStatus = savedVerify;
  resubmitCloudProactive = savedResubmit;
  mirrorAppStateNow = savedMirror;
  return { calls, verifies, resubmits };
})()`, context);
assert.equal(multiRoleScheduleProbe.calls.sort().join(','), 'role_a:chat,role_a:moment,role_b:chat,role_b:moment', '云端补排必须为每个已有会话分别保留私聊与朋友圈任务');
assert.equal(multiRoleScheduleProbe.verifies.sort().join(','), 'role_a,role_b', '过期同步标记应逐角色做只读核验');
assert.equal(multiRoleScheduleProbe.resubmits.length, 0, '云端任务存在时不得重复写入');
const promiseVector = localEmbedding('周六晚上语音 承诺 不会消失');
const similarVector = localEmbedding('你是不是忘了周六语音的约定');
const differentVector = localEmbedding('今天午饭吃什么');
assert.equal(promiseVector.length, 384);
assert.ok(cosine(promiseVector, similarVector) > cosine(promiseVector, differentVector));

const normalized = normalizeChar({ name: '沈确' }, 1);
assert.ok(normalized.id);
assert.equal(normalized.avatar, '沈');

element('set-chat-api-type').value = 'openai';
element('set-chat-api-url').value = 'https://chat.example/v1';
element('set-chat-api-key').value = 'sk-chat';
element('set-memory-api-type').value = 'openai';
element('set-memory-api-url').value = 'https://memory.example/v1';
element('set-memory-api-key').value = 'sk-memory';
element('set-chat-model').value = '';
element('set-memory-model').value = '';
element('set-temp').value = '0.8';
element('set-max-tokens').value = '1000';
element('set-proactive-enabled').value = 'on';
element('set-proactive-minutes').value = '5';
element('set-cloud-timer-enabled').value = 'on';
element('set-timer-endpoint').value = 'https://timer.example';
element('set-push-public-key').value = 'BTestPublicKey';
element('set-system-prompt').value = '';
await fetchModels('chat');
assert.equal(fetchCalls.at(-1).url, 'https://chat.example/v1/models');
assert.match(element('set-chat-model-list').innerHTML, /gpt-alpha/);
assert.equal(element('set-chat-model').value, 'gpt-alpha');
selectFetchedModel('gpt-beta');
assert.equal(element('set-chat-model').value, 'gpt-beta');
await fetchModels('memory');
assert.equal(fetchCalls.at(-1).url, 'https://memory.example/v1/models');
assert.match(element('set-memory-model-list').innerHTML, /gpt-alpha/);
assert.equal(element('set-memory-model').value, 'gpt-alpha');
selectFetchedModel('gpt-beta', 'memory');
assert.equal(element('set-memory-model').value, 'gpt-beta');
assert.equal(JSON.parse(storage.get('rpchat_settings')).proactiveEnabled, true);
assert.equal(JSON.parse(storage.get('rpchat_settings')).proactiveIdleMinutes, 5);
assert.equal(JSON.parse(storage.get('rpchat_settings')).cloudTimerEnabled, true);
assert.equal(JSON.parse(storage.get('rpchat_settings')).timerEndpoint, 'https://timer.example');
assert.equal(JSON.parse(storage.get('rpchat_settings')).chatApiUrl, 'https://chat.example/v1');
assert.equal(JSON.parse(storage.get('rpchat_settings')).memoryApiUrl, 'https://memory.example/v1');
assert.equal(JSON.parse(storage.get('rpchat_settings')).chatApiKey, 'sk-chat');
assert.equal(JSON.parse(storage.get('rpchat_settings')).memoryApiKey, 'sk-memory');

const task20eSourceBetween = (startToken, endToken) => {
  const start = html.indexOf(startToken);
  const end = html.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0, `missing ${startToken}`);
  assert.ok(end > start, `missing ${endToken}`);
  return html.slice(start, end);
};
const unknownCursorSource = task20eSourceBetween('function unknownYuqiVisibilityCursor', 'function normalizeYuqiVisibilityCursor');
const normalizeCursorSource = task20eSourceBetween('function normalizeYuqiVisibilityCursor', 'async function getYuqiVisibilityCursor');
const clearSupportSource = task20eSourceBetween('const YUQI_CLEAR_CURSOR_KEYS', 'async function getYuqiClearCursorForClear');
const nativeFirstClearSource = `${unknownCursorSource}\n${normalizeCursorSource}\n${clearSupportSource}\n${task20eSourceBetween('async function nativeFirstConversationClear', 'async function runNativeClearAllSerial')}`;
const nativeFirstCursorCalls = [];
const nativeFirstCreateCalls = [];
let nativeFirstLocalApplied = 0;
const nativeFirstClear = new Function(
  'getYuqiClearCursorForClear',
  'nativeBridgeCall',
  `${nativeFirstClearSource}; return nativeFirstConversationClear;`
)(async characterId => {
  nativeFirstCursorCalls.push(characterId);
  return { cursorChecksum: 'a'.repeat(64) };
}, async promise => promise);
const nativeFirstOutcome = await nativeFirstClear('yuqi', {
  plugin: { getConversationCursor: async () => ({}), createConversationClear: async value => {
    nativeFirstCreateCalls.push(value);
    return {
      characterId: 'yuqi', nativeCompletedTurnId: null, nativeCompletedGroupId: null, nativeCompletedSequence: 0,
      uiAppliedTurnId: null, uiAppliedGroupId: null, uiAppliedSequence: 0, localSequence: 0,
      clearedThroughSequence: 0, clearEpoch: 1, clearedAt: 0, chatOpen: false, updatedAt: 0,
      cursorChecksum: '1'.repeat(64), controlId: `ctl_${'1'.repeat(64)}`, state: 'waiting'
    };
  } },
  applyLocal: async () => { nativeFirstLocalApplied += 1; }
});
assert.deepEqual(nativeFirstCursorCalls, ['yuqi']);
assert.deepEqual(nativeFirstCreateCalls, [{ characterId: 'yuqi', expectedCursorChecksum: 'a'.repeat(64) }]);
assert.equal(nativeFirstLocalApplied, 1);
assert.equal(nativeFirstOutcome.pending, true);

for (const createConversationClear of [
  async () => { throw new Error('native rejected'); },
  () => new Promise(() => {})
]) {
  const rejectedClear = new Function(
    'getYuqiClearCursorForClear',
    'nativeBridgeCall',
    `${nativeFirstClearSource}; return nativeFirstConversationClear;`
  )(async () => ({ cursorChecksum: 'b'.repeat(64) }), async promise => promise);
  let localApplied = 0;
  const outcome = rejectedClear('yuqi', {
    plugin: { getConversationCursor: async () => ({}), createConversationClear },
    applyLocal: async () => { localApplied += 1; }
  });
  if (createConversationClear.toString().includes('new Promise')) {
    await assert.rejects(Promise.race([
      outcome,
      new Promise((_, reject) => setTimeout(() => reject(new Error('suspended')), 20))
    ]), /suspended/);
  } else {
    await assert.rejects(outcome, /native rejected/);
  }
  assert.equal(localApplied, 0);
}

const serialClearSource = task20eSourceBetween('async function runNativeClearAllSerial', 'async function nativeResultSuppressedByClear');
const serialClearRunner = new Function(`${serialClearSource}; return runNativeClearAllSerial;`)();
const serialEvents = [];
const serialResults = await serialClearRunner(['a', 'b', 'c'], async characterId => {
  serialEvents.push(`start:${characterId}`);
  await new Promise(resolve => setTimeout(resolve, characterId === 'a' ? 5 : 0));
  if (characterId === 'b') throw new Error('native rejected');
  serialEvents.push(`done:${characterId}`);
  return { characterId, ok: true };
});
assert.deepEqual(serialEvents, ['start:a', 'done:a', 'start:b', 'start:c', 'done:c']);
assert.deepEqual(serialResults.map(result => result.characterId), ['a', 'b', 'c']);
assert.equal(serialResults[1].ok, false);
assert.match(serialResults[1].error, /native rejected/);

const lateSuppressionSource = task20eSourceBetween('async function nativeResultSuppressedByClear', 'function withCognitionV2Snapshot');
const lateSuppression = new Function(
  'isNativeApp',
  'nativeExecutionPlugin',
  'getYuqiClearCursorForClear',
  `${lateSuppressionSource}; return nativeResultSuppressedByClear;`
)(() => true, () => ({ getConversationCursor: true }), async () => ({
  cursor: { clearEpoch: 2, clearedThroughSequence: 4 }, cursorChecksum: 'c'.repeat(64)
}));
assert.equal(await lateSuppression({ characterId: 'yuqi', inputClearEpoch: 1, inputVisibilitySequence: 99 }), true);
assert.equal(await lateSuppression({ characterId: 'yuqi', inputClearEpoch: 2, inputVisibilitySequence: 4 }), true);
assert.equal(await lateSuppression({ characterId: 'yuqi', inputClearEpoch: 2, inputVisibilitySequence: 5 }), false);
assert.equal(await lateSuppression({ characterId: 'yuqi' }), true);
assert.equal(await lateSuppression({ characterId: 'yuqi', inputClearEpoch: 3, inputVisibilitySequence: 5 }), true);

const bootstrapSuppression = new Function(
  'isNativeApp',
  'nativeExecutionPlugin',
  'getYuqiClearCursorForClear',
  `${lateSuppressionSource}; return nativeResultSuppressedByClear;`
)(() => true, () => ({ getConversationCursor: true }), async () => ({
  cursor: { clearEpoch: 0, clearedThroughSequence: 0 }, cursorChecksum: '0'.repeat(64)
}));
assert.equal(await bootstrapSuppression({ characterId: 'yuqi', inputClearEpoch: 0, inputVisibilitySequence: 0 }), false);

const clearCursorSource = task20eSourceBetween('const YUQI_CLEAR_CURSOR_KEYS', 'async function nativeFirstConversationClear');
const clearCursorReader = new Function(
  'nativeBridgeCall',
  `${unknownCursorSource}\n${normalizeCursorSource}\n${clearCursorSource}; return getYuqiClearCursorForClear;`
)(async promise => promise);
const exactClearCursor = {
  characterId: 'yuqi',
  nativeCompletedTurnId: null,
  nativeCompletedGroupId: null,
  nativeCompletedSequence: 0,
  uiAppliedTurnId: null,
  uiAppliedGroupId: null,
  uiAppliedSequence: 0,
  localSequence: 0,
  clearedThroughSequence: 0,
  clearEpoch: 0,
  clearedAt: 0,
  chatOpen: false,
  updatedAt: 0,
  cursorChecksum: '0'.repeat(64)
};
assert.equal((await clearCursorReader('yuqi', { getConversationCursor: async () => exactClearCursor })).cursorChecksum, exactClearCursor.cursorChecksum);
for (const invalidCursor of [
  Object.fromEntries(Object.entries(exactClearCursor).filter(([key]) => key !== 'updatedAt')),
  { ...exactClearCursor, extra: true },
  { ...exactClearCursor, characterId: 'other' },
  { ...exactClearCursor, nativeCompletedSequence: '0' }
]) {
  await assert.rejects(
    clearCursorReader('yuqi', { getConversationCursor: async () => invalidCursor }),
    /invalid native cursor/
  );
}

const clearResponseValidatorSource = nativeFirstClearSource;
const clearResponseValidator = new Function(
  'getYuqiClearCursorForClear',
  'nativeBridgeCall',
  `${unknownCursorSource}\n${normalizeCursorSource}\n${clearResponseValidatorSource}; return nativeFirstConversationClear;`
)(async () => ({ cursorChecksum: 'a'.repeat(64) }), async promise => promise);
const validClearControl = {
  characterId: 'yuqi',
  nativeCompletedTurnId: null,
  nativeCompletedGroupId: null,
  nativeCompletedSequence: 0,
  uiAppliedTurnId: null,
  uiAppliedGroupId: null,
  uiAppliedSequence: 0,
  localSequence: 0,
  clearedThroughSequence: 0,
  clearedAt: 0,
  chatOpen: false,
  updatedAt: 0,
  cursorChecksum: '1'.repeat(64),
  controlId: `ctl_${'a'.repeat(64)}`,
  clearEpoch: 1,
  state: 'waiting'
};
const validClearResult = await clearResponseValidator('yuqi', {
  plugin: { getConversationCursor: async () => ({}), createConversationClear: async () => validClearControl }
});
assert.equal(validClearResult.control.controlId, validClearControl.controlId);
for (const invalidControl of [
  { ...validClearControl, characterId: 'other' },
  { ...validClearControl, controlId: 'ctl_bad' },
  { ...validClearControl, clearEpoch: 0 },
  { ...validClearControl, clearedThroughSequence: -1 },
  { ...validClearControl, state: 'unknown' }
]) {
  await assert.rejects(
    clearResponseValidator('yuqi', {
      plugin: { getConversationCursor: async () => ({}), createConversationClear: async () => invalidControl }
    }),
    /native clear response|native clear was not accepted/
  );
}

const clearConversationSource = task20eSourceBetween('async function clearConversationForCharacter', 'async function clearCurrentChat');
const clearConversationDeps = {
  characters: [{ id: 'yuqi', name: 'Yuqi' }],
  allChats: { yuqi: { messages: [{ role: 'user', content: 'keep until native commit' }], extraPrompt: 'extra' } },
  dbWrites: 0,
  nativeFirstConversationClear: async () => ({ control: { controlId: 'ctl_2', state: 'waiting' }, pending: true })
};
const clearConversationProbe = new Function(
  'characters', 'allChats', 'isNativeApp', 'nativeExecutionPlugin', 'nativeFirstConversationClear',
  'cancelCloudProactiveQuick', 'invalidateMemoryExtraction', 'MemoryDB', 'chatClearedSystemMessage',
  'buildCharPrompt', 'memoryMetaKey', 'setMemoryExtractStatus', 'DB', 'renderMessages', 'showScreen',
  `${clearConversationSource}; return clearConversationForCharacter;`
)(
  clearConversationDeps.characters,
  clearConversationDeps.allChats,
  () => true,
  () => ({ getConversationCursor: true, createConversationClear: true }),
  clearConversationDeps.nativeFirstConversationClear,
  async () => { throw new Error('cancel cleanup unavailable'); },
  async () => { throw new Error('memory extraction cleanup unavailable'); },
  {
    clearChar: async () => { throw new Error('memory cache cleanup unavailable'); },
    setMeta: async () => { throw new Error('memory meta cleanup unavailable'); }
  },
  char => ({ role: 'system', content: `cleared ${char.name}` }),
  () => 'prompt',
  () => 'meta',
  async () => true,
  { set: () => { clearConversationDeps.dbWrites += 1; } },
  () => {},
  () => {}
);
const cleanupWarningOutcome = await clearConversationProbe('yuqi');
assert.equal(cleanupWarningOutcome.ok, true);
assert.equal(cleanupWarningOutcome.pending, true);
assert.ok(cleanupWarningOutcome.cleanupWarnings.length >= 3);
assert.equal(clearConversationDeps.allChats.yuqi.messages[0].role, 'system');
assert.equal(clearConversationDeps.dbWrites, 1);

const desktopChats = { good: { messages: ['old-good'] }, failed: { messages: ['old-failed'] } };
let desktopPersisted = null;
const desktopClearAllSource = task20eSourceBetween('async function clearAllHistory', 'async function syncFromServiceWorkerState');
const desktopClearAll = new Function(
  'allChats', 'confirm', 'isNativeApp', 'runNativeClearAllSerial', 'clearConversationForCharacter', 'DB', 'renderChats', 'toast',
  `${desktopClearAllSource}; return clearAllHistory;`
)(
  desktopChats,
  () => true,
  () => false,
  async (ids, clearOne) => {
    const results = [];
    for (const id of ids) results.push({ characterId: id, ...(await clearOne(id)) });
    return results;
  },
  async id => {
    if (id === 'failed') return { ok: false, error: 'desktop failure' };
    desktopChats[id] = { messages: ['cleared'] };
    return { ok: true };
  },
  { set: (_key, value) => { desktopPersisted = value; } },
  () => {},
  () => {}
);
await desktopClearAll();
assert.deepEqual(desktopChats.good, { messages: ['cleared'] });
assert.deepEqual(desktopChats.failed, { messages: ['old-failed'] });
assert.equal(desktopPersisted, desktopChats);

console.log('basic app checks passed');
