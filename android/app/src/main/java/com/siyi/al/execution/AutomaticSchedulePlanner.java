package com.siyi.al.execution;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Pure deterministic planner. The supplied wall clock is deliberately not a retry input. */
public final class AutomaticSchedulePlanner {
    private final String deviceId;
    private final String characterId;
    private final String kind;
    private final String authorityEpoch;
    private final long generation;
    private final String expectedPreviousJobId;

    public AutomaticSchedulePlanner(String deviceId, String characterId, String kind,
                                    String authorityEpoch, long generation,
                                    String expectedPreviousJobId) {
        this.deviceId = deviceId;
        this.characterId = characterId;
        this.kind = kind;
        this.authorityEpoch = authorityEpoch;
        this.generation = generation;
        this.expectedPreviousJobId = expectedPreviousJobId;
    }

    public static final class Plan {
        public final String streamKey;
        public final String jobId;
        public final long dueAt;
        public final String transitionChecksum;
        public final String semanticChecksum;
        public final String semanticJson;
        public final AutomaticScheduleContract.ValidatedTransition transition;

        private Plan(AutomaticScheduleContract.ValidatedTransition transition, long dueAt) {
            this.transition = transition;
            this.streamKey = transition.streamKey;
            this.jobId = transition.jobId;
            this.dueAt = dueAt;
            this.transitionChecksum = transition.transitionChecksum;
            this.semanticChecksum = transition.scheduleChecksum;
            this.semanticJson = transition.scheduleCanonicalJson;
        }
    }

    public Plan next(AutomaticScheduleContract.Source source,
                     AutomaticScheduleContract.Policy policy, long ignoredWallClockNow) {
        long dueAt;
        if (policy.explicitAt != null) {
            dueAt = Long.parseLong(policy.explicitAt);
        } else {
            if (source.occurredAt <= 0L) {
                throw new IllegalArgumentException("automatic schedule source occurredAt is required");
            }
            long span = policy.maxDelayMs - policy.minDelayMs;
            long offset = deterministicOffset(source, policy, span);
            dueAt = Math.addExact(source.occurredAt, Math.addExact(policy.minDelayMs, offset));
        }
        String streamKey = AutomaticScheduleContract.streamKey(deviceId, characterId, kind);
        AutomaticScheduleContract.ValidatedTransition transition = AutomaticScheduleContract.create(
            "schedule", "android-v1", authorityEpoch, generation, expectedPreviousJobId,
            deviceId, characterId, kind, streamKey, null, dueAt, policy.mode,
            source, policy.revision, policy.checksum
        );
        return new Plan(transition, dueAt);
    }

    private long deterministicOffset(AutomaticScheduleContract.Source source,
                                     AutomaticScheduleContract.Policy policy, long span) {
        if (span == 0L) return 0L;
        try {
            String seed = authorityEpoch + "\u0000" + AutomaticScheduleContract.streamKey(deviceId, characterId, kind)
                + "\u0000" + source.checksum + "\u0000" + policy.revision;
            byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(seed.getBytes(StandardCharsets.UTF_8));
            return new BigInteger(1, digest).mod(BigInteger.valueOf(span + 1L)).longValue();
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }
}
