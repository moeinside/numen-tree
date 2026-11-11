package numentree.groundtruth.observe;

import java.util.Map;

/** Server-thread controlled state writes; HTTP never touches entities directly. */
public interface StateSink {
    Map<String, Object> apply(String action, String target, double value, double x, double y, double z)
            throws Exception;
}
