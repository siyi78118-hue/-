package com.siyi.al.execution;

import android.content.Context;
import com.siyi.al.execution.db.AlExecutionDatabase;
import com.siyi.al.execution.db.AutomaticScheduleAuthorityEntity;
import com.siyi.al.execution.db.CharacterSnapshotEntity;
import java.util.Map;
import java.util.regex.Pattern;
import org.json.JSONObject;

public final class AutomaticTaskCoordinator {
    public enum DispatchOutcome { CLAIMED, REPLAY, STALE }

    /** Bounded identity retained for a rejected push; it deliberately excludes epoch/generation. */
    public static final class SafeClaimIdentity {
        public final String characterId;
        public final String kind;
        public final String jobId;
        public final boolean hasAuthorityEpoch;

        private SafeClaimIdentity(String characterId, String kind, String jobId) {
            this.characterId = characterId;
            this.kind = kind;
            this.jobId = jobId;
            this.hasAuthorityEpoch = false;
        }
    }

    /** Closed authority token shared by FCM, AlarmManager and WorkManager. */
    public static final class ClaimToken {
        private static final Pattern ID =
            Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$");
        private static final Pattern EPOCH = Pattern.compile("^[a-f0-9]{32}$");
        public final String characterId;
        public final String kind;
        public final String jobId;
        public final String authorityEpoch;
        public final long generation;

        private ClaimToken(String characterId, String kind, String jobId,
                           String authorityEpoch, long generation) {
            this.characterId = characterId;
            this.kind = kind;
            this.jobId = jobId;
            this.authorityEpoch = authorityEpoch;
            this.generation = generation;
        }

        public static ClaimToken from(Map<String, String> value) {
            if (value == null) throw new IllegalArgumentException("automatic claim token is required");
            String characterId = requiredId(value.get("charId"), "characterId");
            String kind = required(value.get("kind"), "kind");
            if (!("chat".equals(kind) || "moment".equals(kind))) {
                throw new IllegalArgumentException("automatic claim kind is invalid");
            }
            String jobId = requiredId(value.get("jobId"), "jobId");
            String authorityEpoch = required(value.get("authorityEpoch"), "authorityEpoch");
            if (!EPOCH.matcher(authorityEpoch).matches()) {
                throw new IllegalArgumentException("automatic claim epoch is invalid");
            }
            String generationText = required(value.get("generation"), "generation");
            if (!generationText.matches("[1-9][0-9]{0,15}")) {
                throw new IllegalArgumentException("automatic claim generation is invalid");
            }
            long generation;
            try {
                generation = Long.parseLong(generationText);
            } catch (NumberFormatException error) {
                throw new IllegalArgumentException("automatic claim generation is invalid", error);
            }
            if (generation > 9007199254740991L) {
                throw new IllegalArgumentException("automatic claim generation is invalid");
            }
            return new ClaimToken(characterId, kind, jobId, authorityEpoch, generation);
        }

        /** Extract only a bounded stream identity from malformed push data. */
        public static SafeClaimIdentity safeIdentity(Map<String, String> value) {
            if (value == null) return new SafeClaimIdentity("", "", "");
            String characterId = value.get("charId");
            String kind = value.get("kind");
            String jobId = value.get("jobId");
            if (!isSafeId(characterId) || !isSafeId(jobId)
                || !("chat".equals(kind) || "moment".equals(kind))) {
                return new SafeClaimIdentity("", "", "");
            }
            return new SafeClaimIdentity(characterId.trim(), kind, jobId.trim());
        }

        static ClaimToken from(AutomaticScheduleAuthorityEntity authority) {
            if (authority == null) throw new IllegalArgumentException("automatic authority is required");
            java.util.HashMap<String, String> raw = new java.util.HashMap<>();
            raw.put("charId", authority.characterId);
            raw.put("kind", authority.kind);
            raw.put("jobId", authority.activeJobId);
            raw.put("authorityEpoch", authority.authorityEpoch);
            raw.put("generation", String.valueOf(authority.generation));
            return from(raw);
        }

        public JSONObject toJson() {
            try {
                return new JSONObject()
                    .put("characterId", characterId)
                    .put("kind", kind)
                    .put("jobId", jobId)
                    .put("authorityEpoch", authorityEpoch)
                    .put("generation", generation);
            } catch (org.json.JSONException error) {
                throw new IllegalStateException("automatic claim token projection failed", error);
            }
        }

        private static String requiredId(String value, String label) {
            String normalized = required(value, label);
            if (!isSafeId(normalized)) {
                throw new IllegalArgumentException("automatic claim " + label + " is invalid");
            }
            return normalized;
        }

        private static boolean isSafeId(String value) {
            return value != null && ID.matcher(value.trim()).matches();
        }

        private static String required(String value, String label) {
            String normalized = value == null ? "" : value.trim();
            if (normalized.isEmpty()) {
                throw new IllegalArgumentException("automatic claim " + label + " is required");
            }
            return normalized;
        }
    }

    private final AlExecutionDatabase database;
    private final RoomExecutionStore store;
    public AutomaticTaskCoordinator(Context context) { this(AlExecutionDatabase.get(context)); }
    AutomaticTaskCoordinator(AlExecutionDatabase database) {
        this.database = database;
        this.store = new RoomExecutionStore(database);
    }

    public int dispatchDue(long now) {
        int queued = 0;
        for (AutomaticScheduleAuthorityEntity authority
                : database.executionDao().dueAutomaticScheduleAuthorities(now, 50)) {
            try {
                DispatchOutcome outcome = dispatch(ClaimToken.from(authority), now);
                if (outcome == DispatchOutcome.CLAIMED) queued += 1;
            } catch (IllegalArgumentException ignored) {
                // Invalid persisted claims never become turns or diagnostics.
            }
        }
        return queued;
    }

    public int reconcileSchedulers(Context context) {
        int scheduled = 0;
        for (AutomaticScheduleAuthorityEntity authority
                : database.executionDao().automaticScheduleAuthorities()) {
            try {
                AutomaticScheduleContract.ValidatedTransition transition =
                    AutomaticScheduleContract.validateTransition(new JSONObject(authority.semanticJson));
                String previousJobId = transition.value.isNull("expectedPreviousJobId")
                    ? null : transition.value.getString("expectedPreviousJobId");
                if (previousJobId != null) {
                    AutomaticTaskAlarmScheduler.cancel(context, previousJobId);
                    AlExecutionWakeWorker.cancelAutomatic(context, previousJobId);
                }
                if (store.isRoleDeleteTombstoned(authority.characterId)) {
                    if (authority.activeJobId != null) {
                        AutomaticTaskAlarmScheduler.cancel(context, authority.activeJobId);
                        AlExecutionWakeWorker.cancelAutomatic(context, authority.activeJobId);
                    }
                    continue;
                }
                if (!"scheduled".equals(authority.state) || authority.dueAt == null) continue;
                ClaimToken token = ClaimToken.from(authority);
                boolean allowed = store.runRoleSideEffectIfNotDeleted(authority.characterId, () -> {
                    AutomaticTaskAlarmScheduler.schedule(context, token, authority.dueAt);
                    AlExecutionWakeWorker.enqueueAutomatic(context, token, authority.dueAt);
                });
                if (allowed) scheduled += 1;
            } catch (Exception ignored) {
                // Corrupt or obsolete authority never becomes executable work.
            }
        }
        return scheduled;
    }

    /** Replays durable FCM delivery intents after boot/process recovery. */
    public int recoverPersistedDeliveryIntents(Context context) {
        if (context == null) throw new IllegalArgumentException("recovery context is required");
        int scheduled = 0;
        for (com.siyi.al.execution.db.AutomaticScheduleEventEntity event
                : database.executionDao().pendingAutomaticDeliveryRecoveryEvents()) {
            if (event == null || event.streamKey == null || event.resultCode == null) continue;
            AutomaticScheduleAuthorityEntity authority =
                database.executionDao().automaticScheduleAuthority(event.streamKey);
            if (authority == null || authority.characterId == null
                || authority.generation != event.generation
                || (event.nextJobId != null && authority.activeJobId != null
                    && !event.nextJobId.equals(authority.activeJobId))
                || store.isRoleDeleteTombstoned(authority.characterId)) continue;
            try {
                if ("push_stale_resync".equals(event.resultCode)) {
                    AlExecutionWakeWorker.enqueueAutomaticScheduleReconcile(context);
                    scheduled += 1;
                    continue;
                }
                if (!("scheduled".equals(authority.state) || "claimed".equals(authority.state))
                    || authority.activeJobId == null || authority.authorityEpoch == null) continue;
                ClaimToken token = ClaimToken.from(authority);
                long now = System.currentTimeMillis();
                long dueAt = authority.dueAt == null ? now : Math.max(now, authority.dueAt);
                boolean allowed = store.runRoleSideEffectIfNotDeleted(authority.characterId,
                    () -> AlExecutionWakeWorker.enqueueAutomatic(context, token, dueAt));
                if (allowed) scheduled += 1;
            } catch (RuntimeException ignored) {
                // Malformed/foreign durable rows fail closed without creating work.
            }
        }
        return scheduled;
    }

    public DispatchOutcome dispatch(ClaimToken token, long now) {
        if (token == null || now <= 0L || store.isRoleDeleteTombstoned(token.characterId)) {
            return DispatchOutcome.STALE;
        }
        CharacterSnapshotEntity context =
            database.executionDao().latestSnapshot(token.characterId + ":" + token.kind);
        if (context == null || context.contextJson == null || context.contextJson.trim().isEmpty()) {
            return DispatchOutcome.STALE;
        }
        try {
            return store.claimAutomaticTurn(token, context.contextJson, now);
        } catch (RuntimeException error) {
            if (store.isRoleDeleteTombstoned(token.characterId)) return DispatchOutcome.STALE;
            throw error;
        }
    }

}
