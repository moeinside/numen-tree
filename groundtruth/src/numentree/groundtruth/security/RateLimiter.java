package numentree.groundtruth.security;

import java.util.ArrayDeque;
import java.util.function.LongSupplier;

/** Sliding-window per-minute limiter; injectable clock for deterministic tests. */
public final class RateLimiter {
    public static final long WINDOW_MS = 60_000L;

    private final int maxPerWindow;
    private final LongSupplier clock;
    private final ArrayDeque<Long> stamps = new ArrayDeque<>();

    public RateLimiter(int maxPerWindow) {
        this(maxPerWindow, System::currentTimeMillis);
    }

    public RateLimiter(int maxPerWindow, LongSupplier clock) {
        if (maxPerWindow < 1) throw new IllegalArgumentException("maxPerWindow must be >= 1");
        this.maxPerWindow = maxPerWindow;
        this.clock = clock;
    }

    public record Decision(boolean allowed, int remaining, long retryAfterMs) {}

    public synchronized Decision acquire() {
        long now = clock.getAsLong();
        prune(now);
        if (stamps.size() >= maxPerWindow) {
            long oldest = stamps.peekFirst();
            long retry = Math.max(1L, WINDOW_MS - (now - oldest));
            return new Decision(false, 0, retry);
        }
        stamps.addLast(now);
        return new Decision(true, maxPerWindow - stamps.size(), 0);
    }

    private void prune(long now) {
        while (!stamps.isEmpty() && now - stamps.peekFirst() >= WINDOW_MS) {
            stamps.removeFirst();
        }
    }

    public synchronized int used() {
        prune(clock.getAsLong());
        return stamps.size();
    }
}
