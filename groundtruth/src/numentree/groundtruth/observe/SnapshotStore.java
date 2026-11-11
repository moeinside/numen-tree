package numentree.groundtruth.observe;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Pure region snapshot store: block map -> stable hash -> diff.
 *
 * <p>Region is a 3D AABB in block coordinates. The server adapter fills the
 * block map from the world; HTTP never scans blocks itself.</p>
 */
public final class SnapshotStore {
    public record Region(int x, int y, int z, int rx, int ry, int rz) {
        public Region {
            rx = Math.max(0, rx);
            ry = Math.max(0, ry);
            rz = Math.max(0, rz);
        }

        public int volume() {
            return (2 * rx + 1) * (2 * ry + 1) * (2 * rz + 1);
        }

        public boolean valid() {
            return volume() <= 33 * 33 * 33 && rx <= 16 && ry <= 16 && rz <= 16;
        }
    }

    public record Snapshot(
            long seq,
            long gameTick,
            long wall,
            String label,
            Region region,
            int volume,
            String hash,
            Map<String, String> blocks) {
        public Map<String, Object> toMap(boolean includeBlocks) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("seq", seq);
            m.put("gameTick", gameTick);
            m.put("wall", wall);
            m.put("label", label);
            m.put("region", Map.of("x", region.x(), "y", region.y(), "z", region.z(),
                    "rx", region.rx(), "ry", region.ry(), "rz", region.rz()));
            m.put("volume", volume);
            m.put("hash", hash);
            if (includeBlocks) m.put("blocks", blocks);
            return m;
        }
    }

    public record Change(String pos, String before, String after) {
        public Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("pos", pos);
            m.put("before", before);
            m.put("after", after);
            return m;
        }
    }

    private static final int MAX_SNAPSHOTS = 64;
    private final Deque<Snapshot> snapshots = new ArrayDeque<>();
    private long seq;

    public synchronized Snapshot add(long gameTick, String label, Region region, Map<String, String> blocks) {
        seq += 1;
        TreeMap<String, String> sorted = new TreeMap<>(blocks);
        String hash = hash(sorted);
        Snapshot s = new Snapshot(seq, gameTick, System.currentTimeMillis(),
                label == null ? "" : label, region, region.volume(), hash,
                Map.copyOf(sorted));
        snapshots.addLast(s);
        while (snapshots.size() > MAX_SNAPSHOTS) snapshots.removeFirst();
        return s;
    }

    public synchronized Snapshot get(long snapshotSeq) {
        for (Snapshot s : snapshots) if (s.seq() == snapshotSeq) return s;
        return null;
    }

    public synchronized Snapshot latest() {
        return snapshots.peekLast();
    }

    public synchronized List<Snapshot> list(int limit) {
        int cap = Math.max(1, Math.min(64, limit));
        List<Snapshot> all = new ArrayList<>(snapshots);
        int from = Math.max(0, all.size() - cap);
        return all.subList(from, all.size());
    }

    public synchronized List<Change> diff(long fromSeq, long toSeq) {
        Snapshot a = get(fromSeq);
        Snapshot b = get(toSeq);
        if (a == null || b == null) throw new IllegalArgumentException("snapshot not found");
        List<Change> out = new ArrayList<>();
        for (Map.Entry<String, String> e : b.blocks().entrySet()) {
            String before = a.blocks().get(e.getKey());
            if (before == null) {
                out.add(new Change(e.getKey(), "<absent>", e.getValue()));
            } else if (!before.equals(e.getValue())) {
                out.add(new Change(e.getKey(), before, e.getValue()));
            }
        }
        for (Map.Entry<String, String> e : a.blocks().entrySet()) {
            if (!b.blocks().containsKey(e.getKey())) {
                out.add(new Change(e.getKey(), e.getValue(), "<absent>"));
            }
        }
        return out;
    }

    public synchronized long seq() {
        return seq;
    }

    private static String hash(Map<String, String> blocks) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            for (Map.Entry<String, String> e : blocks.entrySet()) {
                md.update(e.getKey().getBytes(StandardCharsets.UTF_8));
                md.update((byte) '=');
                md.update(e.getValue().getBytes(StandardCharsets.UTF_8));
                md.update((byte) '\n');
            }
            return HexFormat.of().formatHex(md.digest());
        } catch (Exception e) {
            throw new IllegalStateException("sha-256 unavailable", e);
        }
    }

    public synchronized void reset() {
        snapshots.clear();
        seq = 0;
    }
}
