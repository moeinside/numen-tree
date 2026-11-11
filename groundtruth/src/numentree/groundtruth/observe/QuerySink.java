package numentree.groundtruth.observe;

import java.util.Map;

/** Server-thread read-only queries; HTTP never touches the world directly. */
public interface QuerySink {
    Map<String, Object> blockAt(int x, int y, int z) throws Exception;

    Map<String, Object> scanBox(SnapshotStore.Region region) throws Exception;

    Map<String, Object> entitiesIn(SnapshotStore.Region region) throws Exception;

    Map<String, Object> lightAt(int x, int y, int z) throws Exception;
}
