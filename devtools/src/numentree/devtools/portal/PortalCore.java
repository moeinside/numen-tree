package numentree.devtools.portal;

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

import numentree.devtools.CommandOutcome;
import numentree.devtools.CommandSink;
import numentree.devtools.DevToolsConfig;
import numentree.devtools.audit.AuditLog;
import numentree.devtools.security.CommandPolicy;
import numentree.devtools.security.RateLimiter;
import numentree.devtools.security.TokenStore;
import numentree.devtools.util.Json;

/**
 * HTTP front-end of the dev-only GM portal.
 *
 * <p>Pure JDK: it does not reference Minecraft classes, so the same code path
 * is exercised by mock HTTP self-tests. The Minecraft adapter ({@code
 * PortalService}) supplies a {@link CommandSink} that hops to the server
 * thread.</p>
 */
public final class PortalCore {
    public static final String MOD_ID = "numen_devtools";
    public static final String VERSION = "0.1.0";
    public static final String COMMAND_PATH = "/dev/v1/command";

    private static final Pattern RUN_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,95}");
    private static final int MAX_REASON = 300;
    private static final int MAX_CHALLENGE_ITEMS = 8;
    private static final int MAX_CHALLENGE_ITEM = 300;

    private final DevToolsConfig config;
    private final CommandSink sink;
    private final AuditLog audit;
    private final TokenStore tokens;
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
        this.config = config;
        this.sink = sink;
        this.audit = audit;
        this.tokens = tokens;
        this.limiter = limiter;
    }

    public synchronized void start() throws IOException {
        if (server != null) return;
        InetSocketAddress bind = new InetSocketAddress(config.bindAddress(), config.port());
        server = HttpServer.create(bind, 16);
        AtomicInteger n = new AtomicInteger();
        ThreadFactory factory = r -> {
            Thread t = new Thread(r, "numen-devtools-http-" + n.incrementAndGet());
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
            System.err.println("[numen_devtools] audit append failed: " + fields.get("code"));
        }
    }

    private boolean appendAudit(Map<String, Object> fields) {
        try {
            audit.append(fields);
            return true;
        } catch (Throwable t) {
            System.err.println("[numen_devtools] audit write failed: " + t);
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
