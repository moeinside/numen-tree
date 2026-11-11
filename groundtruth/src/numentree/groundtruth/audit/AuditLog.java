package numentree.groundtruth.audit;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

import numentree.groundtruth.util.Json;

/** Append-only JSONL audit sink. One line per request decision. */
public final class AuditLog {
    private final Path path;
    private final Object lock = new Object();

    public AuditLog(Path path) {
        this.path = path;
    }

    public Path path() {
        return path;
    }

    public void append(Map<String, Object> fields) throws IOException {
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("ts", Instant.now().toString());
        record.put("schema", "numen-groundtruth-audit/1");
        if (fields != null) record.putAll(fields);
        String line = Json.stringify(record) + "\n";
        synchronized (lock) {
            Path parent = path.toAbsolutePath().getParent();
            if (parent != null) Files.createDirectories(parent);
            Files.writeString(path, line, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        }
    }
}
