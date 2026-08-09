package com.siyi.al.execution;

/**
 * Shared, side-effect-free gate for automatic/proactive dispatch paths.
 * The Room store remains the authority; this adapter only makes the
 * preflight and post-submit checks injectable and testable.
 */
public final class RoleDeletionDispatchPolicy {
    private RoleDeletionDispatchPolicy() {}

    public interface TombstoneReader {
        boolean isRoleDeleteTombstoned(String characterId);
    }

    /** Small injectable seam for cancelling a notification after a deletion race. */
    public interface NotificationCanceller {
        void cancel(int notificationId);
    }

    public static boolean blocked(TombstoneReader reader, String characterId) {
        return reader != null
            && characterId != null
            && !characterId.trim().isEmpty()
            && reader.isRoleDeleteTombstoned(characterId);
    }

    public static boolean suppressFailure(TombstoneReader reader, String characterId) {
        return blocked(reader, characterId);
    }

    /**
     * Re-checks the role tombstone after a pending notification has been posted.
     * The caller supplies the deterministic id used for that post, so a deletion
     * racing with notification presentation can retract exactly the same entry.
     */
    public static boolean cancelPostedNotificationIfDeleted(
        TombstoneReader reader,
        String characterId,
        int notificationId,
        NotificationCanceller canceller
    ) {
        if (!blocked(reader, characterId)) return false;
        if (notificationId >= 0 && canceller != null) canceller.cancel(notificationId);
        return true;
    }
}
