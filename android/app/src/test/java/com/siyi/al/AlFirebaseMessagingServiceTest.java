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
}
