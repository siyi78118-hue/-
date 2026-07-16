package com.siyi.al.execution;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONObject;

public final class RolePlanSchedule {
    private static final long MIN_INTERVAL_MS = 5 * 60 * 1000L;

    private RolePlanSchedule() {}

    public static Long nextOccurrence(JSONObject schedule, long afterMs) {
        if (schedule == null) return null;
        String kind = schedule.optString("kind", "");
        long endsAt = parseIso(schedule.optString("endsAt", ""), Long.MAX_VALUE);
        Long candidate = null;
        if ("once".equals(kind)) {
            long at = parseIso(schedule.optString("at", ""), Long.MIN_VALUE);
            candidate = at > afterMs ? at : null;
        } else if ("interval".equals(kind)) {
            long anchor = parseIso(schedule.optString("startsAt", ""), Long.MIN_VALUE);
            long interval = schedule.optLong("intervalMs", 0L);
            if (anchor != Long.MIN_VALUE && interval >= MIN_INTERVAL_MS) {
                candidate = anchor > afterMs ? anchor : anchor + ((afterMs - anchor) / interval + 1L) * interval;
            }
        } else if ("daily".equals(kind)) {
            candidate = nextLocalTime(afterMs, schedule.optString("time", ""), 1, null, null);
        } else if ("weekly".equals(kind)) {
            candidate = nextLocalTime(afterMs, schedule.optString("time", ""), 7, schedule.optJSONArray("weekdays"), null);
        } else if ("monthly".equals(kind)) {
            int day = schedule.optInt("day", 0);
            candidate = day >= 1 && day <= 31 ? nextLocalTime(afterMs, schedule.optString("time", ""), 13, null, day) : null;
        }
        return candidate != null && candidate <= endsAt ? candidate : null;
    }

    private static Long nextLocalTime(long afterMs, String time, int search, JSONArray weekdays, Integer monthDay) {
        int[] hm = parseClock(time);
        if (hm == null) return null;
        Calendar base = Calendar.getInstance();
        base.setTimeInMillis(afterMs);
        if (monthDay != null) {
            for (int offset = 0; offset < search; offset += 1) {
                Calendar value = (Calendar) base.clone();
                value.set(Calendar.DAY_OF_MONTH, 1);
                value.add(Calendar.MONTH, offset);
                value.set(Calendar.DAY_OF_MONTH, Math.min(monthDay, value.getActualMaximum(Calendar.DAY_OF_MONTH)));
                setClock(value, hm);
                if (value.getTimeInMillis() > afterMs) return value.getTimeInMillis();
            }
            return null;
        }
        for (int offset = 0; offset <= search; offset += 1) {
            Calendar value = (Calendar) base.clone();
            value.add(Calendar.DAY_OF_MONTH, offset);
            setClock(value, hm);
            if (value.getTimeInMillis() <= afterMs) continue;
            if (weekdays == null || containsWeekday(weekdays, value.get(Calendar.DAY_OF_WEEK) - Calendar.SUNDAY)) return value.getTimeInMillis();
        }
        return null;
    }

    private static void setClock(Calendar value, int[] hm) {
        value.set(Calendar.HOUR_OF_DAY, hm[0]);
        value.set(Calendar.MINUTE, hm[1]);
        value.set(Calendar.SECOND, 0);
        value.set(Calendar.MILLISECOND, 0);
    }

    private static boolean containsWeekday(JSONArray days, int wanted) {
        for (int index = 0; index < days.length(); index += 1) if (days.optInt(index, -1) == wanted) return true;
        return false;
    }

    private static int[] parseClock(String value) {
        String[] parts = value == null ? new String[0] : value.split(":");
        if (parts.length != 2) return null;
        try {
            int hour = Integer.parseInt(parts[0]);
            int minute = Integer.parseInt(parts[1]);
            return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? new int[]{hour, minute} : null;
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static long parseIso(String value, long fallback) {
        if (value == null || value.trim().isEmpty()) return fallback;
        String[] patterns = {"yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX", "yyyy-MM-dd'T'HH:mmXXX"};
        for (String pattern : patterns) {
            try {
                SimpleDateFormat parser = new SimpleDateFormat(pattern, Locale.US);
                parser.setLenient(false);
                Date parsed = parser.parse(value);
                if (parsed != null) return parsed.getTime();
            } catch (ParseException ignored) {}
        }
        return fallback;
    }
}
