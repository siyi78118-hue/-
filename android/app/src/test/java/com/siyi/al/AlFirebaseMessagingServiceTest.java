package com.siyi.al;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import com.siyi.al.execution.db.CharacterSnapshotEntity;
import java.util.HashMap;
import org.junit.Test;

public class AlFirebaseMessagingServiceTest {
    @Test
    public void rolePlanSnapshotUsesStablePlanIdentifier() {
        assertEquals("char-a:role-plan:plan-a", AlFirebaseMessagingService.rolePlanSnapshotId("char-a", "plan-a"));
    }
    @Test
    public void cloudJobUsesJobSpecificSnapshotId() {
        assertEquals(
            "char-1:chat:pro-123",
            AlFirebaseMessagingService.snapshotId("char-1", "chat", "pro-123")
        );
    }

    @Test
    public void acceptsOnlyTheCloudJobStoredInLatestSnapshot() {
        CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
        snapshot.contextJson = "{\"cloudJobId\":\"job-current\"}";

        assertTrue(AlFirebaseMessagingService.matchesSnapshotJob(snapshot, "job-current"));
        assertFalse(AlFirebaseMessagingService.matchesSnapshotJob(snapshot, "job-old"));
        assertFalse(AlFirebaseMessagingService.matchesSnapshotJob(snapshot, ""));
    }

    @Test
    public void rejectsSnapshotWhenAutomaticTasksAreDisabled() {
        CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
        snapshot.contextJson = "{\"cloudJobId\":\"job-current\",\"automaticTasksEnabled\":false}";

        assertFalse(AlFirebaseMessagingService.snapshotAllowsAutomaticTask(snapshot, "job-current"));
    }

    @Test
    public void proactiveFcmRequiresTheCompleteAuthorityToken() {
        HashMap<String, String> data = new HashMap<>();
        data.put("type", "proactive");
        data.put("charId", "yuqi");
        data.put("kind", "chat");
        data.put("jobId", "pro_1234567890abcdef_7");
        data.put("authorityEpoch", "00112233445566778899aabbccddeeff");
        data.put("generation", "7");

        assertEquals(7L, AlFirebaseMessagingService.automaticClaimToken(data).generation);
        data.remove("authorityEpoch");
        org.junit.Assert.assertThrows(IllegalArgumentException.class,
            () -> AlFirebaseMessagingService.automaticClaimToken(data));
    }

    @Test
    public void manualCloudTimerTestIsNotParsedAsAnAutomaticAuthorityClaim() {
        HashMap<String, String> data = new HashMap<>();
        data.put("type", "proactive");
        data.put("test", "true");
        data.put("charId", "yuqi");
        data.put("jobId", "manual-test-job");

        assertTrue(AlFirebaseMessagingService.isManualCloudTimerTest(data));
        data.put("test", "false");
        assertFalse(AlFirebaseMessagingService.isManualCloudTimerTest(data));
    }

    @Test
    public void replayWakesExecutionButDoesNotNotifyAgain() {
        assertTrue(AlFirebaseMessagingService.shouldWake(
            com.siyi.al.execution.AutomaticTaskCoordinator.DispatchOutcome.REPLAY));
        assertFalse(AlFirebaseMessagingService.shouldNotify(
            com.siyi.al.execution.AutomaticTaskCoordinator.DispatchOutcome.REPLAY));
        assertEquals("push_replay_wake", AlFirebaseMessagingService.automaticDeliveryStage(
            com.siyi.al.execution.AutomaticTaskCoordinator.DispatchOutcome.REPLAY));
    }

    @Test
    public void staleAndClaimedHaveDistinctMetadataStages() {
        assertFalse(AlFirebaseMessagingService.shouldWake(
            com.siyi.al.execution.AutomaticTaskCoordinator.DispatchOutcome.STALE));
        assertFalse(AlFirebaseMessagingService.shouldNotify(
            com.siyi.al.execution.AutomaticTaskCoordinator.DispatchOutcome.STALE));
        assertEquals("push_stale_resync", AlFirebaseMessagingService.automaticDeliveryStage(
            com.siyi.al.execution.AutomaticTaskCoordinator.DispatchOutcome.STALE));
        assertTrue(AlFirebaseMessagingService.shouldWake(
            com.siyi.al.execution.AutomaticTaskCoordinator.DispatchOutcome.CLAIMED));
        assertTrue(AlFirebaseMessagingService.shouldNotify(
            com.siyi.al.execution.AutomaticTaskCoordinator.DispatchOutcome.CLAIMED));
        assertEquals("push_claimed", AlFirebaseMessagingService.automaticDeliveryStage(
            com.siyi.al.execution.AutomaticTaskCoordinator.DispatchOutcome.CLAIMED));
    }

    @Test
    public void invalidTokenIdentityIsBoundedAndNeverCarriesEpoch() {
        HashMap<String, String> data = new HashMap<>();
        data.put("charId", "yuqi");
        data.put("kind", "chat");
        data.put("jobId", "pro_1234567890abcdef_7");
        data.put("authorityEpoch", "not-a-lowercase-epoch");
        com.siyi.al.execution.AutomaticTaskCoordinator.SafeClaimIdentity identity =
            com.siyi.al.execution.AutomaticTaskCoordinator.ClaimToken.safeIdentity(data);
        assertEquals("yuqi", identity.characterId);
        assertEquals("chat", identity.kind);
        assertEquals("pro_1234567890abcdef_7", identity.jobId);
        assertFalse(identity.hasAuthorityEpoch);
    }
}
