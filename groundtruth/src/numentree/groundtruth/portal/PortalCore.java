package numentree.groundtruth.portal;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import numentree.groundtruth.CommandOutcome;
import numentree.groundtruth.CommandSink;
import numentree.groundtruth.DevToolsConfig;
import numentree.groundtruth.audit.AuditLog;
import numentree.groundtruth.security.CommandPolicy;
import numentree.groundtruth.security.RateLimiter;
import numentree.groundtruth.security.TokenStore;
import numentree.groundtruth.observe.ObserveStore;
import numentree.groundtruth.observe.QuerySink;
import numentree.groundtruth.observe.RunLedger;
import numentree.groundtruth.observe.SnapshotSink;
import numentree.groundtruth.observe.SnapshotStore;
import numentree.groundtruth.observe.StateSink;
import numentree.groundtruth.util.Json;

/**
 * HTTP front-end of the dev-only GM portal.
 *
 * <p>Pure JDK: it does not reference Minecraft classes, so the same code path
 * is exercised by mock HTTP self-tests. The Minecraft adapter ({@code
 * PortalService}) supplies a {@link CommandSink} that hops to the server
 * thread.</p>
 */
public final class PortalCore {
    public static final String MOD_ID = "numen_groundtruth";
    public static final String VERSION = "0.1.0";
    public static final String COMMAND_PATH = "/dev/v1/command";
    public static final String EVENTS_PATH = "/dev/v1/events";
    public static final String CLOCK_PATH = "/dev/v1/clock";
    public static final String SNAPSHOT_PATH = "/dev/v1/snapshot";
    public static final String SNAPSHOT_DIFF_PATH = "/dev/v1/snapshot/diff";
    public static final String SNAPSHOT_LIST_PATH = "/dev/v1/snapshot/list";
    public static final String BLOCK_PATH = "/dev/v1/block";
    public static final String SCAN_PATH = "/dev/v1/scan";
    public static final String ENTITIES_PATH = "/dev/v1/entities";
    public static final String LIGHT_PATH = "/dev/v1/light";
    public static final String MANIFEST_PATH = "/dev/v1/manifest";
    public static final String STATE_PATH = "/dev/v1/state";

    private static final Pattern RUN_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,95}");
    private static final int MAX_REASON = 300;
    private static final int MAX_CHALLENGE_ITEMS = 8;
    private static final int MAX_CHALLENGE_ITEM = 300;

    private final DevToolsConfig config;
    private final CommandSink sink;
    private final AuditLog audit;
    private final TokenStore tokens;
    private final ObserveStore observe;
    private final SnapshotStore snapshots;
    private final SnapshotSink snapshotSink;
    private final QuerySink querySink;
    private final RunLedger ledger;
    private final StateSink stateSink;
    private final RateLimiter limiter;
    private final Object lifecycle = new Object();
    private HttpServer server;
    private ExecutorService executor;
    private int boundPort = -1;

    public PortalCore(DevToolsConfig config, CommandSink sink, AuditLog audit, TokenStore tokens) {
        this(config, sink, audit, tokens, new RateLimiter(config.maxPerMinute()));
    }

    public PortalCore(DevToolsConfig config, CommandSink sink, AuditLog audit, TokenStore tokens,
                      RateLimiter limiter) {
        this(config, sink, audit, tokens, limiter, null);
    }

    public PortalCore(DevToolsConfig config, CommandSink sink, AuditLog audit, TokenStore tokens,
                      RateLimiter limiter, ObserveStore observe) {
        this(config, sink, audit, tokens, limiter, observe, null, null, null);
    }

    public PortalCore(DevToolsConfig config, CommandSink sink, AuditLog audit, TokenStore tokens,
                      RateLimiter limiter, ObserveStore observe, SnapshotStore snapshots,
                      SnapshotSink snapshotSink) {
        this(config, sink, audit, tokens, limiter, observe, snapshots, snapshotSink, null);
    }

    public PortalCore(DevToolsConfig config, CommandSink sink, AuditLog audit, TokenStore tokens,
                      RateLimiter limiter, ObserveStore observe, SnapshotStore snapshots,
                      SnapshotSink snapshotSink, QuerySink querySink) {
        this(config, sink, audit, tokens, limiter, observe, snapshots, snapshotSink, querySink, null, null);
    }

    public PortalCore(DevToolsConfig config, CommandSink sink, AuditLog audit, TokenStore tokens,
                      RateLimiter limiter, ObserveStore observe, SnapshotStore snapshots,
                      SnapshotSink snapshotSink, QuerySink querySink, RunLedger ledger) {
        this(config, sink, audit, tokens, limiter, observe, snapshots, snapshotSink, querySink, ledger, null);
    }

    public PortalCore(DevToolsConfig config, CommandSink sink, AuditLog audit, TokenStore tokens,
                      RateLimiter limiter, ObserveStore observe, SnapshotStore snapshots,
                      SnapshotSink snapshotSink, QuerySink querySink, RunLedger ledger, StateSink stateSink) {
        this.config = config;
        this.sink = sink;
        this.audit = audit;
        this.tokens = tokens;
        this.limiter = limiter;
        this.observe = observe;
        this.snapshots = snapshots;
        this.snapshotSink = snapshotSink;
        this.querySink = querySink;
        this.ledger = ledger == null ? new RunLedger() : ledger;
        this.stateSink = stateSink;
    }

    public synchronized void start() throws IOException {
        if (server != null) return;
        InetSocketAddress bind = new InetSocketAddress(config.bindAddress(), config.port());
        server = HttpServer.create(bind, 16);
        AtomicInteger n = new AtomicInteger();
        ThreadFactory factory = r -> {
            Thread t = new Thread(r, "numen-groundtruth-http-" + n.incrementAndGet());
            t.setDaemon(true);
            return t;
        };
        executor = Executors.newFixedThreadPool(4, factory);
        server.setExecutor(executor);
        server.createContext("/", this::handle);
        server.start();
        boundPort = server.getAddress().getPort();
    }

    public synchronized void stop() {
        if (server != null) {
            server.stop(0);
            server = null;
        }
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
        boundPort = -1;
    }

    public int port() {
        return boundPort;
    }

    private void handle(HttpExchange exchange) {
        try {
            if (!isLoopback(exchange)) {
                sendJson(exchange, 403, error("loopback_only", "requests are accepted from loopback only", null));
                return;
            }
            String path = exchange.getRequestURI().getPath();
            String method = exchange.getRequestMethod().toUpperCase(Locale.ROOT);
            if (path.equals("/health") || path.equals("/dev/v1/health")) {
                if (!method.equals("GET")) {
                    methodNotAllowed(exchange, "GET");
                    return;
                }
                Map<String, Object> body = new LinkedHashMap<>();
                body.put("ok", true);
                body.put("mod", MOD_ID);
                body.put("version", VERSION);
                body.put("portal", "dev");
                body.put("bind", config.bindAddress());
                sendJson(exchange, 200, body);
                return;
            }
            if (path.equals(COMMAND_PATH)) {
                if (!method.equals("POST")) {
                    methodNotAllowed(exchange, "POST");
                    return;
                }
                handleCommand(exchange);
                return;
            }
            if (path.equals(EVENTS_PATH) || path.equals(CLOCK_PATH)) {
                handleObserve(exchange, path, method);
                return;
            }
            if (path.equals(SNAPSHOT_PATH) || path.equals(SNAPSHOT_DIFF_PATH)
                    || path.equals(SNAPSHOT_LIST_PATH)) {
                handleSnapshot(exchange, path, method);
                return;
            }
            if (path.equals(BLOCK_PATH) || path.equals(SCAN_PATH)
                    || path.equals(ENTITIES_PATH) || path.equals(LIGHT_PATH)) {
                handleQuery(exchange, path, method);
                return;
            }
            if (path.equals(MANIFEST_PATH)) {
                handleManifest(exchange, method);
                return;
            }
            if (path.equals(STATE_PATH)) {
                handleState(exchange, method);
                return;
            }
            sendJson(exchange, 404, error("not_found", "unknown endpoint", null));
        } catch (Throwable t) {
            try {
                sendJson(exchange, 500, error("internal_error", safeMessage(t), null));
            } catch (IOException ignored) {
                // client already gone
            }
        } finally {
            exchange.close();
        }
    }

    private void methodNotAllowed(HttpExchange exchange, String allow) throws IOException {
        exchange.getResponseHeaders().set("Allow", allow);
        sendJson(exchange, 405, error("method_not_allowed", "use " + allow, null));
    }

    private void handleObserve(HttpExchange exchange, String path, String method) throws IOException {
        if (observe == null) {
            sendJson(exchange, 503, error("observe_unavailable", "observer is not enabled", null));
            return;
        }
        if (!authorized(exchange)) {
            sendJson(exchange, 401, error("unauthorized", "missing or invalid bearer token", null));
            return;
        }
        if (path.equals(EVENTS_PATH)) {
            recordCall(exchange, "events");            if (!method.equals("GET")) {
                methodNotAllowed(exchange, "GET");
                return;
            }
            long since = queryLong(exchange, "since", 0);
            int limit = (int) queryLong(exchange, "limit", 100);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("ok", true);
            body.put("events", observe.since(since, limit).stream().map(ObserveStore.Event::toMap).toList());
            body.put("nextSeq", observe.seq());
            sendJson(exchange, 200, body);
            return;
        }

        if (method.equals("GET")) {
            recordCall(exchange, "clock");
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("ok", true);
            body.put("clock", observe.clock().toMap());
            sendJson(exchange, 200, body);
            return;
        }
        if (!method.equals("POST")) {
            methodNotAllowed(exchange, "GET or POST");
            return;
        }
        String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        if (contentType == null || !contentType.toLowerCase(Locale.ROOT).contains("application/json")) {
            sendJson(exchange, 415, error("unsupported_media_type", "Content-Type must be application/json", null));
            return;
        }
        byte[] bodyBytes;
        try {
            bodyBytes = readLimited(exchange.getRequestBody(), config.maxBodyBytes());
        } catch (BodyTooLarge e) {
            sendJson(exchange, 413, error("body_too_large", "request body is too large", null));
            return;
        }
        Map<String, Object> body;
        try {
            body = Json.parseObject(new String(bodyBytes, StandardCharsets.UTF_8));
        } catch (IllegalArgumentException e) {
            sendJson(exchange, 400, error("invalid_json", e.getMessage(), null));
            return;
        }
        String runId = str(body.get("runId"));
        String reason = str(body.get("reason"));
        if (runId == null || !RUN_ID.matcher(runId).matches()) {
            sendJson(exchange, 400, error("invalid_request", "runId is required", "runId"));
            return;
        }
        if (reason == null || reason.isBlank() || reason.length() > MAX_REASON) {
            sendJson(exchange, 400, error("invalid_request", "reason is required", "reason"));
            return;
        }
        Object challengeObj = body.get("selfChallenge");
        if (!(challengeObj instanceof List<?> list) || list.isEmpty() || list.size() > MAX_CHALLENGE_ITEMS) {
            sendJson(exchange, 400, error("invalid_request", "selfChallenge is required", "selfChallenge"));
            return;
        }
        Map<String, Object> auditFields = baseAudit(exchange);
        auditFields.put("runId", runId);
        auditFields.put("reason", reason);
        auditFields.put("decision", "clock_control");
        try {
            audit.append(auditFields);
        } catch (Exception e) {
            sendJson(exchange, 500, error("audit_unavailable", "audit append failed; clock unchanged", null));
            return;
        }
        if (body.containsKey("frozen")) {            Object frozen = body.get("frozen");
            if (!(frozen instanceof Boolean)) {
                sendJson(exchange, 400, error("invalid_request", "frozen must be boolean", "frozen"));
                return;
            }
            observe.setFrozen((Boolean) frozen);
            observe.append("clock_freeze", Map.of("frozen", frozen, "runId", runId));
        }
        if (body.containsKey("step")) {
            try {
                int steps = Integer.parseInt(String.valueOf(body.get("step")));
                observe.step(steps);
                observe.append("clock_step", Map.of("steps", steps, "runId", runId));
            } catch (NumberFormatException e) {
                sendJson(exchange, 400, error("invalid_request", "step must be integer", "step"));
                return;
            }
        }
        if (body.containsKey("dayTime")) {
            try {
                long dayTime = Long.parseLong(String.valueOf(body.get("dayTime")));
                observe.setDayTime(dayTime);
                observe.append("clock_set", Map.of("dayTime", dayTime, "runId", runId));
            } catch (NumberFormatException e) {
                sendJson(exchange, 400, error("invalid_request", "dayTime must be integer", "dayTime"));
                return;
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        ledger.record(runId, "clock", observe.clock().frozen());
        result.put("ok", true);
        result.put("clock", observe.clock().toMap());
        sendJson(exchange, 200, result);
    }

    private static long queryLong(HttpExchange exchange, String name, long fallback) {
        String query = exchange.getRequestURI().getQuery();
        if (query == null) return fallback;
        for (String part : query.split("&")) {
            String[] kv = part.split("=", 2);
            if (kv.length == 2 && kv[0].equals(name)) {
                try {
                    return Long.parseLong(kv[1]);
                } catch (NumberFormatException ignored) {
                    return fallback;
                }
            }
        }
        return fallback;
    }

    private static String str(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private void handleState(HttpExchange exchange, String method) throws IOException {
        if (stateSink == null) {
            sendJson(exchange, 503, error("state_unavailable", "state service is not enabled", null));
            return;
        }
        if (!authorized(exchange)) {
            sendJson(exchange, 401, error("unauthorized", "missing or invalid bearer token", null));
            return;
        }
        if (!method.equals("POST")) {
            methodNotAllowed(exchange, "POST");
            return;
        }
        String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        if (contentType == null || !contentType.toLowerCase(Locale.ROOT).contains("application/json")) {
            sendJson(exchange, 415, error("unsupported_media_type", "Content-Type must be application/json", null));
            return;
        }
        byte[] bodyBytes;
        try {
            bodyBytes = readLimited(exchange.getRequestBody(), config.maxBodyBytes());
        } catch (BodyTooLarge e) {
            sendJson(exchange, 413, error("body_too_large", "request body is too large", null));
            return;
        }
        Map<String, Object> body;
        try {
            body = Json.parseObject(new String(bodyBytes, StandardCharsets.UTF_8));
        } catch (IllegalArgumentException e) {
            sendJson(exchange, 400, error("invalid_json", e.getMessage(), null));
            return;
        }
        String runId = str(body.get("runId"));
        String reason = str(body.get("reason"));
        String action = str(body.get("action"));
        String target = str(body.get("target"));
        if (runId == null || !RUN_ID.matcher(runId).matches()) {
            sendJson(exchange, 400, error("invalid_request", "runId is required", "runId"));
            return;
        }
        if (reason == null || reason.isBlank() || reason.length() > MAX_REASON) {
            sendJson(exchange, 400, error("invalid_request", "reason is required", "reason"));
            return;
        }
        Object challengeObj = body.get("selfChallenge");
        if (!(challengeObj instanceof List<?> list) || list.isEmpty() || list.size() > MAX_CHALLENGE_ITEMS) {
            sendJson(exchange, 400, error("invalid_request", "selfChallenge is required", "selfChallenge"));
            return;
        }
        if (!List.of("set_health", "set_food", "damage", "kill_tag", "teleport").contains(action)) {
            sendJson(exchange, 400, error("invalid_request", "unknown action", "action"));
            return;
        }
        if (target == null || target.isBlank()) {
            sendJson(exchange, 400, error("invalid_request", "target is required", "target"));
            return;
        }
        double value = numberDouble(body.get("value"));
        double x = numberDouble(body.get("x"));
        double y = numberDouble(body.get("y"));
        double z = numberDouble(body.get("z"));
        Map<String, Object> auditFields = baseAudit(exchange);
        auditFields.put("runId", runId);
        auditFields.put("reason", reason);
        auditFields.put("decision", "state");
        auditFields.put("action", action);
        auditFields.put("target", target);
        auditFields.put("value", value);
        try {
            audit.append(auditFields);
        } catch (Exception e) {
            sendJson(exchange, 500, error("audit_unavailable", "audit append failed; state unchanged", null));
            return;
        }
        ledger.record(runId, "state", observe != null && observe.clock().frozen());
        try {
            Map<String, Object> result = stateSink.apply(action, target, value, x, y, z);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("ok", true);
            out.put("result", result);
            sendJson(exchange, 200, out);
        } catch (Exception e) {
            sendJson(exchange, 500, error("state_failed", safeMessage(e), null));
        }
    }

    private static double numberDouble(Object value) {
        if (value == null) return 0;
        try {
            return Double.parseDouble(String.valueOf(value));
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("not a number: " + value);
        }
    }

    private void handleManifest(HttpExchange exchange, String method) throws IOException {
        if (!authorized(exchange)) {
            sendJson(exchange, 401, error("unauthorized", "missing or invalid bearer token", null));
            return;
        }
        if (!method.equals("GET")) {
            methodNotAllowed(exchange, "GET");
            return;
        }
        String runId = runIdOf(exchange);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("manifest", ledger.manifest(runId));
        sendJson(exchange, 200, body);
    }

    private String runIdOf(HttpExchange exchange) {
        String header = exchange.getRequestHeaders().getFirst("X-Run-Id");
        if (header != null && !header.isBlank()) return header;
        String query = exchange.getRequestURI().getQuery();
        if (query != null) {
            for (String part : query.split("&")) {
                String[] kv = part.split("=", 2);
                if (kv.length == 2 && kv[0].equals("runId")) return kv[1];
            }
        }
        return "unattributed";
    }

    private void recordCall(HttpExchange exchange, String kind) {
        boolean frozen = observe != null && observe.clock().frozen();
        ledger.record(runIdOf(exchange), kind, frozen);
    }

    private void handleQuery(HttpExchange exchange, String path, String method) throws IOException {
        if (querySink == null) {
            sendJson(exchange, 503, error("query_unavailable", "query service is not enabled", null));
            return;
        }
        if (!authorized(exchange)) {
            sendJson(exchange, 401, error("unauthorized", "missing or invalid bearer token", null));
            return;
        }
        if (!method.equals("GET")) {
            methodNotAllowed(exchange, "GET");
            return;
        }
        recordCall(exchange, "query");
        try {
            Map<String, Object> result;
            if (path.equals(BLOCK_PATH) || path.equals(LIGHT_PATH)) {
                int x = (int) queryLong(exchange, "x", 0);
                int y = (int) queryLong(exchange, "y", 0);
                int z = (int) queryLong(exchange, "z", 0);
                result = path.equals(BLOCK_PATH) ? querySink.blockAt(x, y, z) : querySink.lightAt(x, y, z);
            } else {
                SnapshotStore.Region region = new SnapshotStore.Region(
                        (int) queryLong(exchange, "x", 0), (int) queryLong(exchange, "y", 0),
                        (int) queryLong(exchange, "z", 0), (int) queryLong(exchange, "rx", 0),
                        (int) queryLong(exchange, "ry", 0), (int) queryLong(exchange, "rz", 0));
                if (!region.valid()) {
                    sendJson(exchange, 400, error("invalid_request", "region exceeds 33^3 or radius >16", "region"));
                    return;
                }
                result = path.equals(SCAN_PATH)
                        ? querySink.scanBox(region) : querySink.entitiesIn(region);
            }
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("ok", true);
            body.put("result", result);
            sendJson(exchange, 200, body);
        } catch (Throwable t) {
            sendJson(exchange, 500, error("query_failed", safeMessage(t), null));
        }
    }

    private void handleSnapshot(HttpExchange exchange, String path, String method) throws IOException {
        if (snapshots == null || snapshotSink == null) {
            sendJson(exchange, 503, error("snapshot_unavailable", "snapshot service is not enabled", null));
            return;
        }
        if (!authorized(exchange)) {
            sendJson(exchange, 401, error("unauthorized", "missing or invalid bearer token", null));
            return;
        }
        if (path.equals(SNAPSHOT_LIST_PATH)) {
            if (!method.equals("GET")) {
                methodNotAllowed(exchange, "GET");
                return;
            }
            recordCall(exchange, "snapshot");
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("ok", true);
            body.put("snapshots", snapshots.list((int) queryLong(exchange, "limit", 20))
                    .stream().map(s -> s.toMap(false)).toList());
            sendJson(exchange, 200, body);
            return;
        }
        if (path.equals(SNAPSHOT_DIFF_PATH)) {
            recordCall(exchange, "snapshot");
            if (!method.equals("GET")) {
                methodNotAllowed(exchange, "GET");
                return;
            }
            long from = queryLong(exchange, "from", -1);
            long to = queryLong(exchange, "to", -1);
            try {
                Map<String, Object> body = new LinkedHashMap<>();
                body.put("ok", true);
                body.put("from", from);
                body.put("to", to);
                body.put("changes", snapshots.diff(from, to).stream().map(SnapshotStore.Change::toMap).toList());
                sendJson(exchange, 200, body);
            } catch (IllegalArgumentException e) {
                sendJson(exchange, 404, error("snapshot_not_found", e.getMessage(), null));
            }
            return;
        }

        if (method.equals("GET")) {
            recordCall(exchange, "snapshot");
            long seq = queryLong(exchange, "seq", 0);
            SnapshotStore.Snapshot s = seq <= 0 ? snapshots.latest() : snapshots.get(seq);
            if (s == null) {
                sendJson(exchange, 404, error("snapshot_not_found", "snapshot not found", null));
                return;
            }
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("ok", true);
            body.put("snapshot", s.toMap(true));
            sendJson(exchange, 200, body);
            return;
        }
        if (!method.equals("POST")) {
            methodNotAllowed(exchange, "GET or POST");
            return;
        }
        String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        if (contentType == null || !contentType.toLowerCase(Locale.ROOT).contains("application/json")) {
            sendJson(exchange, 415, error("unsupported_media_type", "Content-Type must be application/json", null));
            return;
        }
        byte[] bodyBytes;
        try {
            bodyBytes = readLimited(exchange.getRequestBody(), config.maxBodyBytes());
        } catch (BodyTooLarge e) {
            sendJson(exchange, 413, error("body_too_large", "request body is too large", null));
            return;
        }
        Map<String, Object> body;
        try {
            body = Json.parseObject(new String(bodyBytes, StandardCharsets.UTF_8));
        } catch (IllegalArgumentException e) {
            sendJson(exchange, 400, error("invalid_json", e.getMessage(), null));
            return;
        }
        String runId = str(body.get("runId"));
        String reason = str(body.get("reason"));
        if (runId == null || !RUN_ID.matcher(runId).matches()) {
            sendJson(exchange, 400, error("invalid_request", "runId is required", "runId"));
            return;
        }
        if (reason == null || reason.isBlank() || reason.length() > MAX_REASON) {
            sendJson(exchange, 400, error("invalid_request", "reason is required", "reason"));
            return;
        }
        Object regionObj = body.get("region");
        if (!(regionObj instanceof Map<?, ?> regionMap)) {
            sendJson(exchange, 400, error("invalid_request", "region is required", "region"));
            return;
        }
        SnapshotStore.Region region;
        try {
            region = new SnapshotStore.Region(
                    number(regionMap.get("x")), number(regionMap.get("y")), number(regionMap.get("z")),
                    number(regionMap.get("rx")), number(regionMap.get("ry")), number(regionMap.get("rz")));
        } catch (RuntimeException e) {
            sendJson(exchange, 400, error("invalid_request", "region fields must be integers", "region"));
            return;
        }
        if (!region.valid()) {
            sendJson(exchange, 400, error("invalid_request", "region exceeds 33^3 or radius >16", "region"));
            return;
        }
        Map<String, String> blocks;
        try {
            blocks = snapshotSink.capture(region);
        } catch (Exception e) {
            sendJson(exchange, 500, error("snapshot_failed", safeMessage(e), null));
            return;
        }
        String label = body.get("label") == null ? "" : String.valueOf(body.get("label"));
        ledger.record(runId, "snapshot", observe != null && observe.clock().frozen());
        SnapshotStore.Snapshot snapshot = snapshots.add(
                observe == null ? 0 : observe.clock().gameTick(), label, region, blocks);
        Map<String, Object> auditFields = baseAudit(exchange);
        auditFields.put("runId", runId);
        auditFields.put("reason", reason);
        auditFields.put("decision", "snapshot");
        auditFields.put("snapshotSeq", snapshot.seq());
        auditFields.put("hash", snapshot.hash());
        appendAuditQuietly(auditFields);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("ok", true);
        result.put("snapshot", snapshot.toMap(false));
        sendJson(exchange, 200, result);
    }

    private static int number(Object value) {
        if (value == null) throw new IllegalArgumentException("missing number");
        return Integer.parseInt(String.valueOf(value));
    }

    private void handleCommand(HttpExchange exchange) throws IOException {
        Map<String, Object> auditFields = baseAudit(exchange);
        String rawCommand = null;
        String runId = null;
        String reason = null;
        List<String> challenges = List.of();

        if (!authorized(exchange)) {
            sendJson(exchange, 401, error("unauthorized", "missing or invalid bearer token", null));
            auditFields.put("decision", "denied");
            auditFields.put("code", "unauthorized");
            auditFields.put("httpStatus", 401);
            appendAuditQuietly(auditFields);
            return;
        }

        String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        if (contentType == null || !contentType.toLowerCase(Locale.ROOT).contains("application/json")) {
            sendJson(exchange, 415, error("unsupported_media_type", "Content-Type must be application/json", null));
            auditFields.put("decision", "denied");
            auditFields.put("code", "unsupported_media_type");
            auditFields.put("httpStatus", 415);
            appendAuditQuietly(auditFields);
            return;
        }

        byte[] bodyBytes;
        try {
            bodyBytes = readLimited(exchange.getRequestBody(), config.maxBodyBytes());
        } catch (BodyTooLarge e) {
            sendJson(exchange, 413, error("body_too_large",
                    "request body exceeds " + config.maxBodyBytes() + " bytes", null));
            auditFields.put("decision", "denied");
            auditFields.put("code", "body_too_large");
            auditFields.put("httpStatus", 413);
            appendAuditQuietly(auditFields);
            return;
        }
        if (bodyBytes.length == 0) {
            sendJson(exchange, 400, error("invalid_json", "request body is empty", null));
            auditFields.put("decision", "denied");
            auditFields.put("code", "invalid_json");
            auditFields.put("httpStatus", 400);
            appendAuditQuietly(auditFields);
            return;
        }

        Map<String, Object> body;
        try {
            body = Json.parseObject(new String(bodyBytes, StandardCharsets.UTF_8));
        } catch (IllegalArgumentException e) {
            sendJson(exchange, 400, error("invalid_json", e.getMessage(), null));
            auditFields.put("decision", "denied");
            auditFields.put("code", "invalid_json");
            auditFields.put("httpStatus", 400);
            appendAuditQuietly(auditFields);
            return;
        }

        RequestCheck request = validateRequest(body);
        if (!request.ok()) {
            sendJson(exchange, 400, error(request.code(), request.message(), request.field()));
            auditFields.put("decision", "denied");
            auditFields.put("code", request.code());
            auditFields.put("httpStatus", 400);
            if (request.field() != null) auditFields.put("field", request.field());
            appendAuditQuietly(auditFields);
            return;
        }
        runId = request.runId();
        rawCommand = request.command();
        reason = request.reason();
        challenges = request.selfChallenge();
        ledger.record(runId, "command", observe != null && observe.clock().frozen());
        auditFields.put("runId", runId);
        auditFields.put("command", rawCommand);
        auditFields.put("reason", reason);
        auditFields.put("selfChallenge", challenges);

        RateLimiter.Decision rate = limiter.acquire();
        if (!rate.allowed()) {
            long retrySec = Math.max(1L, (rate.retryAfterMs() + 999L) / 1000L);
            exchange.getResponseHeaders().set("Retry-After", Long.toString(retrySec));
            int status = 429;
            sendJson(exchange, status, error("rate_limited",
                    "more than " + config.maxPerMinute() + " commands per minute", null));
            auditFields.put("decision", "denied");
            auditFields.put("code", "rate_limited");
            auditFields.put("httpStatus", status);
            auditFields.put("retryAfterMs", rate.retryAfterMs());
            appendAuditQuietly(auditFields);
            return;
        }

        CommandPolicy.CommandCheck check = CommandPolicy.checkCommand(rawCommand, config.maxCommandLength());
        if (!check.allowed()) {
            boolean syntax = isRequestSyntaxCode(check.code());
            int status = syntax ? 400 : 403;
            sendJson(exchange, status, error(check.code(), check.message(), "command"));
            auditFields.put("decision", "denied");
            auditFields.put("code", check.code());
            auditFields.put("httpStatus", status);
            appendAuditQuietly(auditFields);
            return;
        }

        auditFields.put("command", check.command());
        auditFields.put("roots", CommandPolicy.distinct(check.roots()));
        long started = System.nanoTime();
        CommandOutcome outcome;
        try {
            outcome = sink.execute(check.command());
        } catch (Exception e) {
            outcome = CommandOutcome.error("", "execution_failed", safeMessage(e));
        }
        long durationMs = (System.nanoTime() - started) / 1_000_000L;
        auditFields.put("durationMs", durationMs);
        auditFields.put("world", outcome.world());
        auditFields.put("result", outcome.result());
        auditFields.put("outputCount", outcome.output().size());

        int status;
        Map<String, Object> response;
        if (outcome.ok()) {
            status = 200;
            response = success(outcome);
            auditFields.put("decision", "allowed");
            auditFields.put("code", "ok");
        } else {
            status = statusForOutcome(outcome.errorCode());
            response = error(outcome.errorCode(), outcome.errorMessage(), null);
            response.put("world", outcome.world());
            response.put("result", outcome.result());
            auditFields.put("decision", status >= 500 ? "error" : "denied");
            auditFields.put("code", outcome.errorCode());
        }
        auditFields.put("httpStatus", status);

        if (!appendAudit(auditFields)) {
            sendJson(exchange, 500, error("audit_unavailable",
                    "command outcome could not be audited; see server log", null));
            return;
        }
        sendJson(exchange, status, response);
    }

    private static boolean isRequestSyntaxCode(String code) {
        return code.equals("empty_command")
                || code.equals("command_too_long")
                || code.equals("bad_characters")
                || code.equals("invalid_syntax");
    }

    private static int statusForOutcome(String code) {
        return switch (code) {
            case "world_not_allowed" -> 403;
            case "server_not_ready" -> 503;
            case "timeout" -> 504;
            case "execution_failed" -> 500;
            case "command_failed" -> 200;
            default -> 500;
        };
    }

    private boolean authorized(HttpExchange exchange) {
        String header = exchange.getRequestHeaders().getFirst("Authorization");
        if (header == null) return false;
        int space = header.indexOf(' ');
        if (space <= 0) return false;
        if (!header.substring(0, space).equalsIgnoreCase("Bearer")) return false;
        String presented = header.substring(space + 1).trim();
        return tokens.matches(presented);
    }

    private boolean isLoopback(HttpExchange exchange) {
        InetSocketAddress remote = exchange.getRemoteAddress();
        return remote != null && remote.getAddress() != null && remote.getAddress().isLoopbackAddress();
    }

    private Map<String, Object> baseAudit(HttpExchange exchange) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("event", "command");
        String remote = String.valueOf(exchange.getRemoteAddress());
        m.put("remote", remote);
        return m;
    }

    private void appendAuditQuietly(Map<String, Object> fields) {
        if (!appendAudit(fields)) {
            System.err.println("[numen_groundtruth] audit append failed: " + fields.get("code"));
        }
    }

    private boolean appendAudit(Map<String, Object> fields) {
        try {
            audit.append(fields);
            return true;
        } catch (Throwable t) {
            System.err.println("[numen_groundtruth] audit write failed: " + t);
            return false;
        }
    }

    private record RequestCheck(
            boolean ok, String code, String message, String field,
            String runId, String command, String reason, List<String> selfChallenge) {

        static RequestCheck deny(String code, String message, String field) {
            return new RequestCheck(false, code, message, field, null, null, null, List.of());
        }

        static RequestCheck ok(String runId, String command, String reason, List<String> challenges) {
            return new RequestCheck(true, "ok", "", null, runId, command, reason, challenges);
        }
    }

    private static RequestCheck validateRequest(Map<String, Object> body) {
        if (!(body.get("runId") instanceof String runId) || runId.isBlank()) {
            return RequestCheck.deny("invalid_run_id", "runId is required", "runId");
        }
        if (!RUN_ID.matcher(runId).matches()) {
            return RequestCheck.deny("invalid_run_id",
                    "runId must match [A-Za-z0-9][A-Za-z0-9._:-]{0,95}", "runId");
        }
        if (!(body.get("command") instanceof String command) || command.isBlank()) {
            return RequestCheck.deny("invalid_command", "command is required", "command");
        }
        if (!(body.get("reason") instanceof String reason) || reason.isBlank()) {
            return RequestCheck.deny("invalid_reason", "reason is required", "reason");
        }
        if (reason.length() > MAX_REASON) {
            return RequestCheck.deny("invalid_reason",
                    "reason must be at most " + MAX_REASON + " characters", "reason");
        }
        Object rawChallenges = body.get("selfChallenge");
        if (!(rawChallenges instanceof List<?> list) || list.isEmpty()) {
            return RequestCheck.deny("invalid_self_challenge",
                    "selfChallenge must be a non-empty array", "selfChallenge");
        }
        if (list.size() > MAX_CHALLENGE_ITEMS) {
            return RequestCheck.deny("invalid_self_challenge",
                    "selfChallenge must contain at most " + MAX_CHALLENGE_ITEMS + " items", "selfChallenge");
        }
        List<String> challenges = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof String s) || s.isBlank()) {
                return RequestCheck.deny("invalid_self_challenge",
                        "selfChallenge items must be non-empty strings", "selfChallenge");
            }
            if (s.length() > MAX_CHALLENGE_ITEM) {
                return RequestCheck.deny("invalid_self_challenge",
                        "selfChallenge items must be at most " + MAX_CHALLENGE_ITEM + " characters",
                        "selfChallenge");
            }
            challenges.add(s);
        }
        return RequestCheck.ok(runId, command, reason, List.copyOf(challenges));
    }

    private static Map<String, Object> success(CommandOutcome outcome) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("result", outcome.result());
        body.put("output", outcome.output());
        body.put("world", outcome.world());
        return body;
    }

    private static Map<String, Object> error(String code, String message, String field) {
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("code", code == null || code.isBlank() ? "error" : code);
        err.put("message", message == null ? "" : message);
        if (field != null) err.put("field", field);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", false);
        body.put("error", err);
        return body;
    }

    private static byte[] readLimited(InputStream in, int max) throws IOException, BodyTooLarge {
        byte[] data = in.readNBytes(max + 1);
        if (data.length > max) throw new BodyTooLarge();
        return data;
    }

    private static void sendJson(HttpExchange exchange, int status, Map<String, Object> body) throws IOException {
        byte[] bytes = Json.stringify(body).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    private static String safeMessage(Throwable t) {
        String m = t.getMessage();
        String s = t.getClass().getSimpleName() + (m == null ? "" : ": " + m);
        return s.length() > 500 ? s.substring(0, 500) : s;
    }

    /** Utility for constant-time token tests / future diagnostics. */
    static boolean constantTimeEquals(byte[] a, byte[] b) {
        return MessageDigest.isEqual(a, b);
    }

    private static final class BodyTooLarge extends Exception {
        BodyTooLarge() {
            super("body too large");
        }
    }
}
