package numentree.groundtruth.observe;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Per-run call ledger for Track A rejection.
 *
 * <p>Read-only health/manifest requests are not recorded. Any other groundtruth
 * request recorded under a runId makes that run ineligible as Track A evidence.</p>
 */
public final class RunLedger {
    public static final class Stat {
        private final AtomicInteger calls = new AtomicInteger();
        private final Map<String, AtomicInteger> byKind = new ConcurrentHashMap<>();
        private volatile boolean clockFrozen;
        private volatile long lastCallAt;

        public void record(String kind, boolean frozen) {
            calls.incrementAndGet();
            byKind.computeIfAbsent(kind, k -> new AtomicInteger()).incrementAndGet();
            clockFrozen = frozen;
            lastCallAt = System.currentTimeMillis();
        }

        public Map<String, Object> toMap(String runId) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("runId", runId);
            m.put("calls", calls.get());
            Map<String, Object> kinds = new LinkedHashMap<>();
            byKind.forEach((k, v) -> kinds.put(k, v.get()));
            m.put("byKind", kinds);
            m.put("clockFrozen", clockFrozen);
            m.put("lastCallAt", lastCallAt);
            return m;
        }
    }

    private final Map<String, Stat> stats = new ConcurrentHashMap<>();

    public void record(String runId, String kind, boolean clockFrozen) {
        String key = runId == null || runId.isBlank() ? "unattributed" : runId;
        stats.computeIfAbsent(key, k -> new Stat()).record(kind, clockFrozen);
    }

    public Map<String, Object> manifest(String runId) {
        String key = runId == null || runId.isBlank() ? "unattributed" : runId;
        Stat s = stats.get(key);
        if (s == null) {
            Map<String, Object> empty = new LinkedHashMap<>();
            empty.put("runId", key);
            empty.put("calls", 0);
            empty.put("byKind", Map.of());
            empty.put("clockFrozen", false);
            empty.put("lastCallAt", 0);
            return empty;
        }
        return s.toMap(key);
    }

    public void reset() {
        stats.clear();
    }
}
