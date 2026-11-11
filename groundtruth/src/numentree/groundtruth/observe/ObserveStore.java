package numentree.groundtruth.observe;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Pure in-memory observer: monotonic event cursor + game-tick clock.
 *
 * <p>No Minecraft references, so this is exercised by the pure self-test path.
 * The server adapter appends events and ticks this store from the server thread;
 * HTTP readers only call the synchronized snapshot methods.</p>
 */
public final class ObserveStore {
    public record Event(
            long seq,
            long gameTick,
            long wall,
            String type,
            Map<String, Object> payload) {
        public Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("seq", seq);
            m.put("gameTick", gameTick);
            m.put("wall", wall);
            m.put("type", type);
            m.put("payload", payload == null ? Map.of() : payload);
            return m;
        }
    }

    public record Clock(
            long gameTick,
            long dayTime,
            boolean frozen,
            int pendingSteps,
            long observedAt) {
        public Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("gameTick", gameTick);
            m.put("dayTime", dayTime);
            m.put("frozen", frozen);
            m.put("pendingSteps", pendingSteps);
            m.put("observedAt", observedAt);
            return m;
        }
    }

    private static final int MAX_EVENTS = 10_000;

    private final Deque<Event> events = new ArrayDeque<>();
    private long seq;
    private long gameTick;
    private long dayTime;
    private boolean frozen;
    private int pendingSteps;
    private long observedAt = System.currentTimeMillis();

    public synchronized Event append(String type, Map<String, Object> payload) {
        seq += 1;
        Event e = new Event(seq, gameTick, System.currentTimeMillis(), type,
                payload == null ? Map.of() : new LinkedHashMap<>(payload));
        events.addLast(e);
        while (events.size() > MAX_EVENTS) events.removeFirst();
        return e;
    }

    public synchronized List<Event> since(long afterSeq, int limit) {
        int cap = Math.max(1, Math.min(1000, limit));
        List<Event> out = new ArrayList<>(Math.min(cap, events.size()));
        for (Event e : events) {
            if (e.seq() > afterSeq) {
                out.add(e);
                if (out.size() >= cap) break;
            }
        }
        return out;
    }

    public synchronized long seq() {
        return seq;
    }

    /** Called once per server tick; frozen time only advances by explicit step(). */
    public synchronized void tick(long dayTime) {
        this.dayTime = dayTime;
        observedAt = System.currentTimeMillis();
        if (!frozen) {
            gameTick += 1;
        } else if (pendingSteps > 0) {
            gameTick += 1;
            pendingSteps -= 1;
        }
    }

    public synchronized Clock clock() {
        return new Clock(gameTick, dayTime, frozen, pendingSteps, observedAt);
    }

    public synchronized Clock setFrozen(boolean frozen) {
        this.frozen = frozen;
        if (!frozen) pendingSteps = 0;
        observedAt = System.currentTimeMillis();
        return clock();
    }

    public synchronized Clock step(int steps) {
        if (steps > 0) pendingSteps = Math.min(1000, pendingSteps + steps);
        observedAt = System.currentTimeMillis();
        return clock();
    }

    public synchronized Clock setDayTime(long dayTime) {
        this.dayTime = dayTime;
        observedAt = System.currentTimeMillis();
        return clock();
    }

    /** Test-only: clear events/clock. */
    public synchronized void reset() {
        events.clear();
        seq = 0;
        gameTick = 0;
        dayTime = 0;
        frozen = false;
        pendingSteps = 0;
        observedAt = System.currentTimeMillis();
    }
}
