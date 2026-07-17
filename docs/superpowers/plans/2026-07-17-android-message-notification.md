# Android Message Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make completed role messages ring, vibrate, and show the character name plus full text on the lock screen while keeping generation-progress and guard notifications silent.

**Architecture:** Introduce a pure Java notification policy as the single source of channel IDs and alert behavior, then make `AlNotificationFactory` create a fresh versioned message channel and a separate silent progress channel. Expose Android notification status and the system settings deep link through the existing Capacitor plugin, with a small settings-page surface for diagnostics.

**Tech Stack:** Java 21, Android NotificationChannel/NotificationCompat, Capacitor 8 plugin bridge, vanilla HTML/JavaScript, JUnit 4, Node source checks, GitHub Actions APK release workflow.

## Global Constraints

- Final role messages use the system default notification sound, vibration, high importance, and public lock-screen visibility.
- Lock-screen content contains the character nickname and message body.
- Generation progress and the foreground guard remain silent.
- The new message channel ID is fixed and versioned; do not create another channel on every launch.
- Respect system/user notification settings and do not use full-screen intents.
- Do not modify chat generation, proactive scheduling, memory, or message synchronization behavior.

---

### Task 1: Notification Policy

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/AlNotificationPolicy.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/AlNotificationPolicyTest.java`

**Interfaces:**
- Produces: `AlNotificationPolicy.MESSAGE_CHANNEL`, `PROGRESS_CHANNEL`, `messageImportance()`, `progressImportance()`, `messageVisibility()`, and `progressVisibility()`.
- Consumed by: `AlNotificationFactory` and notification diagnostics.

- [ ] **Step 1: Write the failing policy test**

```java
@Test public void completedMessagesUseFreshPublicHighImportanceChannel() {
    assertNotEquals("al_messages", AlNotificationPolicy.MESSAGE_CHANNEL);
    assertEquals(NotificationManager.IMPORTANCE_HIGH, AlNotificationPolicy.messageImportance());
    assertEquals(Notification.VISIBILITY_PUBLIC, AlNotificationPolicy.messageVisibility());
}

@Test public void progressUsesSeparatePrivateLowImportanceChannel() {
    assertNotEquals(AlNotificationPolicy.MESSAGE_CHANNEL, AlNotificationPolicy.PROGRESS_CHANNEL);
    assertEquals(NotificationManager.IMPORTANCE_LOW, AlNotificationPolicy.progressImportance());
    assertEquals(Notification.VISIBILITY_SECRET, AlNotificationPolicy.progressVisibility());
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd android && gradlew.bat testDebugUnitTest --tests com.siyi.al.execution.AlNotificationPolicyTest`

Expected: compilation fails because `AlNotificationPolicy` does not exist.

- [ ] **Step 3: Add the minimal policy implementation**

```java
public final class AlNotificationPolicy {
    public static final String MESSAGE_CHANNEL = "al_messages_v2";
    public static final String PROGRESS_CHANNEL = "al_message_progress";
    public static int messageImportance() { return NotificationManager.IMPORTANCE_HIGH; }
    public static int progressImportance() { return NotificationManager.IMPORTANCE_LOW; }
    public static int messageVisibility() { return Notification.VISIBILITY_PUBLIC; }
    public static int progressVisibility() { return Notification.VISIBILITY_SECRET; }
    private AlNotificationPolicy() {}
}
```

- [ ] **Step 4: Re-run the focused test and verify GREEN**

Run: `cd android && gradlew.bat testDebugUnitTest --tests com.siyi.al.execution.AlNotificationPolicyTest`

Expected: PASS.

### Task 2: Channel and Notification Construction

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlNotificationFactory.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/AlNotificationText.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/AlNotificationTextTest.java`
- Modify: `test-basic.mjs`

**Interfaces:**
- Consumes: Task 1 policy constants and methods.
- Produces: one silent progress notification and one audible public final-message notification using the same task notification ID.

- [ ] **Step 1: Add failing source-contract checks**

Add assertions that require `RingtoneManager.TYPE_NOTIFICATION`, `enableVibration(true)`, public visibility for final messages, `setSound(null, null)` for progress, and builders using separate policy channel IDs.

- [ ] **Step 2: Run the source checks and verify RED**

Run: `node test-basic.mjs`

Expected: FAIL because the factory still uses `al_messages` for both notifications and has no explicit sound/visibility policy.

- [ ] **Step 3: Implement channel creation and builders**

Create the final channel with default notification URI plus notification audio attributes, vibration, high importance, and public visibility. Create the progress channel with low importance, no sound, no vibration, and secret visibility. Add `.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)` plus sound/vibration defaults to final notifications; keep progress notifications silent. Combine every visible reply part into the final notification body instead of dropping all but the first bubble.

- [ ] **Step 4: Run Java and source checks and verify GREEN**

Run: `cd android && gradlew.bat testDebugUnitTest`

Run: `node test-basic.mjs`

Expected: both commands pass.

### Task 3: Notification Diagnostics and Settings Link

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/AlNotificationStatus.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/AlNotificationStatusTest.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `tavern-app/index.html`
- Modify: `test-basic.mjs`

**Interfaces:**
- Produces: Capacitor methods `notificationStatus()` and `openNotificationSettings()`.
- Web response fields: `permissionGranted`, `appEnabled`, `channelExists`, `importance`, `hasSound`, `vibrationEnabled`, `lockscreenVisibility`, `healthy`, and `summary`.

- [ ] **Step 1: Write failing status-evaluation tests**

```java
@Test public void healthyRequiresPermissionAppChannelSoundAndPublicVisibility() {
    assertTrue(AlNotificationStatus.isHealthy(true, true, true, 4, true, true, 1));
    assertFalse(AlNotificationStatus.isHealthy(true, true, true, 4, false, true, 1));
    assertFalse(AlNotificationStatus.isHealthy(true, true, true, 4, true, true, 0));
}
```

- [ ] **Step 2: Run the focused status test and verify RED**

Run: `cd android && gradlew.bat testDebugUnitTest --tests com.siyi.al.execution.AlNotificationStatusTest`

Expected: compilation fails because `AlNotificationStatus` does not exist.

- [ ] **Step 3: Implement status evaluation and plugin bridge**

Read runtime permission with `ContextCompat.checkSelfPermission`, application notification state with `NotificationManagerCompat.areNotificationsEnabled`, and the final channel with `NotificationManager.getNotificationChannel`. Return the documented fields. Open `Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS` for the final channel on Android 8+, otherwise `Settings.ACTION_APP_NOTIFICATION_SETTINGS`.

- [ ] **Step 4: Add the settings-page status row**

Add a `通知` cell that runs `checkNativeNotificationStatus()` and a status line with an `打开系统设置` command only when the native bridge exists. Do not show dead controls on the web/PWA build.

- [ ] **Step 5: Run focused and web checks and verify GREEN**

Run: `cd android && gradlew.bat testDebugUnitTest --tests com.siyi.al.execution.AlNotificationStatusTest`

Run: `node test-basic.mjs`

Expected: both pass.

### Task 4: Regression, Build, and Release

**Files:**
- Modify only if required by checks: `tavern-app/index.html`
- Generated by CI: Android release and compatibility APKs plus `android-update.json` on `update-channel`.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a signed GitHub Release and update manifest consumed by AL's in-app updater.

- [ ] **Step 1: Run the complete local verification suite**

Run: `npm test`

Run: `cd android && gradlew.bat testDebugUnitTest assembleDebugAndroidTest assembleDebug`

Expected: all checks pass and the debug APK is generated.

- [ ] **Step 2: Review the final diff**

Run: `git diff --check` and inspect only notification, diagnostics, tests, version metadata, design, and plan changes.

- [ ] **Step 3: Commit implementation**

Stage only the scoped files and commit with `fix: restore audible lock-screen message alerts`.

- [ ] **Step 4: Push the implementation branch and main**

Push `codex/al-tdd`, then fast-forward `main` to the verified commit and push `main` to trigger the release workflow.

- [ ] **Step 5: Verify GitHub Actions and update channel**

Use `gh run watch --exit-status`, verify the published Release contains signed release and compatibility APKs, and confirm `android-update.json` reports the new version and valid release URL.
