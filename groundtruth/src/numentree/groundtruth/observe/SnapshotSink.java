package numentree.groundtruth.observe;

import java.util.Map;

/** Server-thread block capture; the pure HTTP layer only names the region. */
@FunctionalInterface
public interface SnapshotSink {
    Map<String, String> capture(SnapshotStore.Region region) throws Exception;
}
