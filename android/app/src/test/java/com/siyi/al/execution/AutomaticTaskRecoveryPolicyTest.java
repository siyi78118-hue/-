package com.siyi.al.execution;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class AutomaticTaskRecoveryPolicyTest {
    @Test public void onlyCurrentEnabledDueCloudJobIsRecovered() {
        assertTrue(AutomaticTaskRecoveryPolicy.claimable(true, "job-new", "job-new", 999L, 1000L));
        assertFalse(AutomaticTaskRecoveryPolicy.claimable(false, "job-new", "job-new", 999L, 1000L));
        assertFalse(AutomaticTaskRecoveryPolicy.claimable(true, "job-old", "job-new", 999L, 1000L));
        assertFalse(AutomaticTaskRecoveryPolicy.claimable(true, "job-new", "job-new", 1001L, 1000L));
    }

    @Test public void automaticClaimTokenRequiresTheCompleteNativeAuthorityTuple() {
        Map<String, String> input = new HashMap<>();
        input.put("charId", "char-a");
        input.put("kind", "chat");
        input.put("jobId", "pro_53fd68a5b14aec79_7");
        input.put("authorityEpoch", "00112233445566778899aabbccddeeff");
        input.put("generation", "7");

        AutomaticTaskCoordinator.ClaimToken token =
            AutomaticTaskCoordinator.ClaimToken.from(input);
        assertEquals("char-a", token.characterId);
        assertEquals("chat", token.kind);
        assertEquals("pro_53fd68a5b14aec79_7", token.jobId);
        assertEquals("00112233445566778899aabbccddeeff", token.authorityEpoch);
        assertEquals(7L, token.generation);

        Map<String, String> missingEpoch = new HashMap<>(input);
        missingEpoch.remove("authorityEpoch");
        assertThrows(IllegalArgumentException.class,
            () -> AutomaticTaskCoordinator.ClaimToken.from(missingEpoch));
        Map<String, String> stringlyInvalidGeneration = new HashMap<>(input);
        stringlyInvalidGeneration.put("generation", "7.0");
        assertThrows(IllegalArgumentException.class,
            () -> AutomaticTaskCoordinator.ClaimToken.from(stringlyInvalidGeneration));
    }
}
