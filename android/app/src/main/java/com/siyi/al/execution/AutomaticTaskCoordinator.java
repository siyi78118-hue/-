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
            if (!ID.matcher(normalized).matches()) {
                throw new IllegalArgumentException("automatic claim " + label + " is invalid");
            }
            return normalized;
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
                if (!"scheduled".equals(authority.state) || authority.dueAt == null) continue;
                ClaimToken token = ClaimToken.from(authority);
                AutomaticTaskAlarmScheduler.schedule(context, token, authority.dueAt);
                AlExecutionWakeWorker.enqueueAutomatic(context, token, authority.dueAt);
                scheduled += 1;
            } catch (Exception ignored) {
                // Corrupt or obsolete authority never becomes executable work.
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
