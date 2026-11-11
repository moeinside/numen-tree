package numentree.devtools.tests;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import numentree.devtools.CommandOutcome;
import numentree.devtools.CommandSink;
import numentree.devtools.DevToolsConfig;
import numentree.devtools.audit.AuditLog;
import numentree.devtools.portal.PortalCore;
import numentree.devtools.security.CommandPolicy;
import numentree.devtools.security.RateLimiter;
import numentree.devtools.security.TokenStore;
import numentree.devtools.util.Json;

/**
 * Dependency-free self-test for the GM portal policy + HTTP layer.
 *
 * <p>Run with the Minecraft classpath absent: only pure classes are compiled.
 * Writes a machine-readable summary to the path given as argv[0] (default
 * {@code devtools/build/selftest.json}).</p>
 */
public final class Selftest {
    private static final List<Map<String, Object>> CASES = new ArrayList<>();
    private static int failures;
    private static Path tempRoot;

    public static void main(String[] args) throws Exception {
        Path out = args.length > 0 ? Path.of(args[0]) : Path.of("devtools", "build", "selftest.json");
        tempRoot = Files.createTempDirectory("numen-devtools-selftest-");
        try {
            policyTests();
            executionPolicyTests();
            tokenTests();
            httpTests();
        } finally {
            writeReport(out);
            deleteTree(tempRoot);
        }
        System.out.println("cases=" + CASES.size() + " failures=" + failures);
        System.out.println("evidence=" + out.toAbsolutePath());
        if (failures > 0) System.exit(1);
    }

    // ── policy ──────────────────────────────────────────────

    private static void policyTests() {
        check("J1", "simple tp allowed", () -> {
            CommandPolicy.CommandCheck c = CommandPolicy.checkCommand("tp @s 1 2 3", 512);
            require(c.allowed(), c.code() + " " + c.message());
            require(c.command().equals("tp @s 1 2 3"), "normalized command");
            require(c.roots().equals(List.of("tp")), "roots=" + c.roots());
        });

        check("J2", "all allowed roots accepted", () -> {
            String[] cmds = {
                    "tp @s 0 0 0",
                    "give @s minecraft:bread 1",
                    "time set day",
                    "weather clear",
                    "setblock 0 0 0 minecraft:stone",
                    "fill 0 0 0 1 1 1 minecraft:stone",
                    "summon minecraft:pig 0 0 0",
                    "effect give @s minecraft:speed 1 1",
                    "gamemode creative @s",
                    "xp add @s 1",
                    "execute as @s at @s run tp @s 0 0 0",
            };
            for (String cmd : cmds) {
                CommandPolicy.CommandCheck c = CommandPolicy.checkCommand(cmd, 512);
                require(c.allowed(), "rejected: " + cmd + " -> " + c.code());
            }
        });

        check("J3", "execute recursively accepts nested allowed root", () -> {
            CommandPolicy.CommandCheck c = CommandPolicy.checkCommand(
                    "execute as @e[name=bigwhale,limit=1] at @s run tp @s 128.66 67 183.3", 512);
            require(c.allowed(), c.code() + " " + c.message());
            require(c.roots().equals(List.of("execute", "tp")), "roots=" + c.roots());
        });

        check("J4", "nested execute records every root", () -> {
            CommandPolicy.CommandCheck c = CommandPolicy.checkCommand(
                    "execute as @s at @s run execute as @s run tp @s 0 0 0", 512);
            require(c.allowed(), c.code() + " " + c.message());
            require(c.roots().equals(List.of("execute", "execute", "tp")), "roots=" + c.roots());
        });

        check("J5", "forbidden roots rejected explicitly", () -> {
            String[] roots = {"stop", "reload", "op", "deop", "ban", "whitelist",
                    "gamerule", "difficulty", "peaceful", "kill", "clear", "data"};
            for (String root : roots) {
                CommandPolicy.CommandCheck c = CommandPolicy.checkCommand(root + " @s", 512);
                require(!c.allowed(), "allowed forbidden root: " + root);
                require(c.code().equals("forbidden_root"),
                        root + " code=" + c.code());
            }
        });

        check("J6", "unknown root rejected", () -> {
            CommandPolicy.CommandCheck c = CommandPolicy.checkCommand("say hello", 512);
            require(!c.allowed(), "say allowed");
            require(c.code().equals("root_not_allowed"), "code=" + c.code());
        });

        check("J7", "execute without run rejected", () -> {
            CommandPolicy.CommandCheck c = CommandPolicy.checkCommand("execute as @s at @s", 512);
            require(!c.allowed(), "execute without run allowed");
            require(c.code().equals("execute_without_run"), "code=" + c.code());
        });

        check("J8", "execute with empty child rejected", () -> {
            CommandPolicy.CommandCheck c = CommandPolicy.checkCommand("execute as @s run", 512);
            require(!c.allowed(), "empty child allowed");
            require(c.code().equals("execute_without_run"), "code=" + c.code());
        });

        check("J9", "execute child forbidden rejected", () -> {
            CommandPolicy.CommandCheck c = CommandPolicy.checkCommand("execute as @s run stop", 512);
            require(!c.allowed(), "child stop allowed");
            require(c.code().equals("forbidden_root"), "code=" + c.code());
        });

        check("J10", "execute child unknown rejected", () -> {
            CommandPolicy.CommandCheck c = CommandPolicy.checkCommand(
                    "execute as @s run execute as @s run say hi", 512);
            require(!c.allowed(), "nested say allowed");
            require(c.code().equals("root_not_allowed"), "code=" + c.code());
        });

        check("J11", "leading slash is normalized", () -> {
            CommandPolicy.CommandCheck c = CommandPolicy.checkCommand("/tp @s 0 0 0", 512);
            require(c.allowed(), c.code() + " " + c.message());
            require(c.command().equals("tp @s 0 0 0"), "command=" + c.command());
        });

        check("J12", "command length limit enforced", () -> {
            String longCmd = "tp @s 0 0 0 " + "x".repeat(600);
            CommandPolicy.CommandCheck c = CommandPolicy.checkCommand(longCmd, 512);
            require(!c.allowed(), "long command allowed");
            require(c.code().equals("command_too_long"), "code=" + c.code());
        });

        check("J13", "newline injection rejected", () -> {
            CommandPolicy.CommandCheck c = CommandPolicy.checkCommand("tp @s 0 0 0\nstop", 512);
            require(!c.allowed(), "newline allowed");
            require(c.code().equals("bad_characters"), "code=" + c.code());
        });

        check("J14", "unterminated quote rejected", () -> {
            CommandPolicy.CommandCheck c = CommandPolicy.checkCommand("tp @s 0 0 0 \"", 512);
            require(!c.allowed(), "unterminated quote allowed");
            require(c.code().equals("invalid_syntax"), "code=" + c.code());
        });

        check("J15", "quoted argument with space accepted", () -> {
            CommandPolicy.CommandCheck c = CommandPolicy.checkCommand(
                    "summon minecraft:armor_stand 0 0 0 {CustomName:'\"a b\"'}", 512);
            require(c.allowed(), c.code() + " " + c.message());
        });

        check("J16", "quoted root rejected", () -> {
            CommandPolicy.CommandCheck c = CommandPolicy.checkCommand("\"tp\" @s 0 0 0", 512);
            require(!c.allowed(), "quoted root allowed");
            require(c.code().equals("invalid_syntax"), "code=" + c.code());
        });

        check("J17", "world allowlist is exact but case-insensitive", () -> {
            require(CommandPolicy.checkWorld("numen-test", List.of("numen-test")).allowed(), "exact");
            require(CommandPolicy.checkWorld("NUMEN-TEST", List.of("numen-test")).allowed(), "case");
            require(!CommandPolicy.checkWorld("world", List.of("numen-test")).allowed(), "other world");
            require(!CommandPolicy.checkWorld("numen-test", List.of()).allowed(), "empty allowlist");
            require(!CommandPolicy.checkWorld(null, List.of("numen-test")).allowed(), "null world");
        });
    }

    private static void executionPolicyTests() {
        check("J18", "execute depth limit enforced", () -> {
            String cmd = "execute run ".repeat(9) + "tp @s 0 0 0";
            CommandPolicy.CommandCheck c = CommandPolicy.checkCommand(cmd, 512);
            require(!c.allowed(), "deep execute allowed");
            require(c.code().equals("execute_too_deep"), "code=" + c.code());
        });
    }

    // ── token / rate / audit / config ───────────────────────

    private static void tokenTests() {
        check("J19", "token compare is exact", () -> {
            TokenStore store = TokenStore.of("a".repeat(64));
            require(store.matches("a".repeat(64)), "exact token rejected");
            require(!store.matches("a".repeat(63) + "b"), "wrong token accepted");
            require(!store.matches(""), "empty token accepted");
            require(!store.matches(null), "null token accepted");
        });

        check("J20", "weak token rejected", () -> {
            expectThrows(IllegalArgumentException.class, () -> TokenStore.of("short"));
            expectThrows(IllegalArgumentException.class,
                    () -> TokenStore.of("a".repeat(32) + " b"));
        });

        check("J21", "token file load and redaction", () -> {
            Path file = tempRoot.resolve("token");
            Files.writeString(file, "b".repeat(64) + "\n", StandardCharsets.UTF_8);
            TokenStore store = TokenStore.load(file);
            require(store.matches("b".repeat(64)), "loaded token does not match");
            require(!store.toString().contains("b".repeat(64)), "token leaked in toString");
            expectThrows(IOException.class, () -> TokenStore.load(tempRoot.resolve("missing")));
        });

        check("J22", "rate limiter blocks and recovers", () -> {
            AtomicLong clock = new AtomicLong(1_000L);
            RateLimiter limiter = new RateLimiter(3, clock::get);
            require(limiter.acquire().allowed(), "1");
            require(limiter.acquire().allowed(), "2");
            require(limiter.acquire().allowed(), "3");
            RateLimiter.Decision denied = limiter.acquire();
            require(!denied.allowed(), "4th allowed");
            require(denied.retryAfterMs() > 0, "no retryAfter");
            clock.addAndGet(60_000L);
            require(limiter.acquire().allowed(), "after window still blocked");
        });

        check("J23", "audit JSONL is parseable and contains no token", () -> {
            Path file = tempRoot.resolve("audit.jsonl");
            AuditLog log = new AuditLog(file);
            Map<String, Object> a = new LinkedHashMap<>();
            a.put("event", "command");
            a.put("runId", "run-a");
            a.put("decision", "allowed");
            a.put("command", "tp @s 0 0 0");
            a.put("selfChallenge", List.of("really?", "minimal?"));
            log.append(a);
            Map<String, Object> b = new LinkedHashMap<>();
            b.put("event", "command");
            b.put("decision", "denied");
            b.put("code", "forbidden_root");
            log.append(b);
            List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
            require(lines.size() == 2, "lines=" + lines.size());
            Map<String, Object> parsedA = Json.parseObject(lines.get(0));
            require("run-a".equals(parsedA.get("runId")), "runId missing");
            require(parsedA.get("ts") != null, "ts missing");
            require(parsedA.get("schema") != null, "schema missing");
            require(!lines.get(0).contains("a".repeat(64)), "token-like content present");
            require("forbidden_root".equals(Json.parseObject(lines.get(1)).get("code")), "deny code");
        });

        check("J24", "config defaults to disabled and test-world scoped", () -> {
            DevToolsConfig defaults = DevToolsConfig.defaults();
            require(!defaults.enabled(), "defaults enabled");
            require(defaults.port() == 8770, "default port");
            require(defaults.bindAddress().equals("127.0.0.1"), "default bind");
            require(defaults.allowedWorlds().equals(List.of("numen-test")), "default worlds");
            require(defaults.validateForServer().isEmpty(),
                    "defaults invalid: " + defaults.validateForServer());
        });

        check("J25", "config load writes disabled default file", () -> {
            Path gameDir = tempRoot.resolve("game");
            DevToolsConfig cfg = DevToolsConfig.load(gameDir);
            require(!cfg.enabled(), "new config enabled");
            Path file = gameDir.resolve("config").resolve("numen-devtools.json");
            require(Files.isRegularFile(file), "config file not written");
            Map<String, Object> raw = Json.parseObject(Files.readString(file, StandardCharsets.UTF_8));
            require(Boolean.FALSE.equals(raw.get("enabled")), "enabled not false");
            require(raw.get("tokenFile").equals("config/numen-devtools.token"), "tokenFile default");
            require(!Files.readString(file).toLowerCase().contains("bearer"), "token hint leaked");
        });

        check("J26", "config rejects unsafe bind/world limits", () -> {
            DevToolsConfig bad = new DevToolsConfig(true, "0.0.0.0", 8770,
                    "config/token", List.of(), 10, 512, 65_536);
            List<String> problems = bad.validateForServer();
            require(problems.size() >= 2, "expected bind+worlds problems, got " + problems);
        });
    }

    // ── mock HTTP ───────────────────────────────────────────

    private static void httpTests() throws Exception {
        Path httpDir = Files.createDirectories(tempRoot.resolve("http"));
        Path auditPath = httpDir.resolve("audit.jsonl");
        AuditLog audit = new AuditLog(auditPath);
        String token = "c".repeat(64);
        DevToolsConfig cfg = new DevToolsConfig(true, "127.0.0.1", 0,
                "config/token", List.of("numen-test"), 10, 512, 1024);
        FakeSink sink = new FakeSink();
        PortalCore core = new PortalCore(cfg, sink, audit, TokenStore.of(token));
        core.start();
        try {
            String base = "http://127.0.0.1:" + core.port();
            HttpClient client = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(5))
                    .build();

            check("J27", "GET /health works without token", () -> {
                Resp r = send(client, base + "/health", "GET", null, null, null);
                require(r.status == 200, "status=" + r.status);
                Map<String, Object> body = Json.parseObject(r.body);
                require(Boolean.TRUE.equals(body.get("ok")), "ok false");
                require("numen_devtools".equals(body.get("mod")), "mod=" + body.get("mod"));
            });

            check("J28", "wrong method -> 405 Allow POST", () -> {
                Resp r = send(client, base + PortalCore.COMMAND_PATH, "PUT", "{}", token, "application/json");
                require(r.status == 405, "status=" + r.status);
                require("POST".equals(r.allow), "Allow=" + r.allow);
            });

            check("J29", "missing token -> 401 and no sink call", () -> {
                int before = sink.calls.get();
                Resp r = send(client, base + PortalCore.COMMAND_PATH, "POST", validBodyJson("tp @s 0 0 0"),
                        null, "application/json");
                require(r.status == 401, "status=" + r.status);
                require(codeOf(r).equals("unauthorized"), "code=" + codeOf(r));
                require(sink.calls.get() == before, "sink called without token");
            });

            check("J30", "wrong token -> 401", () -> {
                Resp r = send(client, base + PortalCore.COMMAND_PATH, "POST", validBodyJson("tp @s 0 0 0"),
                        "d".repeat(64), "application/json");
                require(r.status == 401, "status=" + r.status);
                require(codeOf(r).equals("unauthorized"), "code=" + codeOf(r));
            });

            check("J31", "invalid JSON -> 400", () -> {
                Resp r = send(client, base + PortalCore.COMMAND_PATH, "POST", "{not-json", token,
                        "application/json");
                require(r.status == 400, "status=" + r.status);
                require(codeOf(r).equals("invalid_json"), "code=" + codeOf(r));
            });

            check("J32", "missing runId/reason/selfChallenge rejected", () -> {
                Map<String, Object> baseReq = validBody("tp @s 0 0 0");
                for (String field : List.of("runId", "reason", "selfChallenge")) {
                    Map<String, Object> req = new LinkedHashMap<>(baseReq);
                    req.remove(field);
                    Resp r = send(client, base + PortalCore.COMMAND_PATH, "POST", Json.stringify(req), token,
                            "application/json");
                    require(r.status == 400, field + " status=" + r.status);
                    require(codeOf(r).startsWith("invalid_"), field + " code=" + codeOf(r));
                }
                Resp emptyChallenges = send(client, base + PortalCore.COMMAND_PATH, "POST",
                        Json.stringify(req("tp @s 0 0 0", List.of())), token, "application/json");
                require(emptyChallenges.status == 400, "empty selfChallenge status=" + emptyChallenges.status);
            });

            check("J33", "forbidden root -> 403 and no sink call", () -> {
                int before = sink.calls.get();
                Resp r = send(client, base + PortalCore.COMMAND_PATH, "POST", validBodyJson("stop"), token,
                        "application/json");
                require(r.status == 403, "status=" + r.status);
                require(codeOf(r).equals("forbidden_root"), "code=" + codeOf(r));
                require(sink.calls.get() == before, "sink called for forbidden root");
            });

            check("J34", "execute child forbidden -> 403", () -> {
                Resp r = send(client, base + PortalCore.COMMAND_PATH, "POST",
                        validBodyJson("execute as @s run stop"), token, "application/json");
                require(r.status == 403, "status=" + r.status);
                require(codeOf(r).equals("forbidden_root"), "code=" + codeOf(r));
            });

            check("J35", "allowed command dispatches normalized command", () -> {
                Resp r = send(client, base + PortalCore.COMMAND_PATH, "POST",
                        validBodyJson("/tp @s 0 0 0"), token, "application/json");
                require(r.status == 200, "status=" + r.status + " body=" + r.body);
                Map<String, Object> body = Json.parseObject(r.body);
                require(Boolean.TRUE.equals(body.get("ok")), "ok false");
                require(((Number) body.get("result")).intValue() == 1, "result=" + body.get("result"));
                require(sink.lastCommand.equals("tp @s 0 0 0"), "sink command=" + sink.lastCommand);
            });

            check("J36", "execute recursive allowed over HTTP", () -> {
                Resp r = send(client, base + PortalCore.COMMAND_PATH, "POST",
                        validBodyJson("execute as @s at @s run tp @s 0 0 0"), token, "application/json");
                require(r.status == 200, "status=" + r.status + " body=" + r.body);
            });

            check("J37", "world not allowed -> 403", () -> {
                sink.world = "prod-world";
                try {
                    Resp r = send(client, base + PortalCore.COMMAND_PATH, "POST",
                            validBodyJson("tp @s 0 0 0"), token, "application/json");
                    require(r.status == 403, "status=" + r.status);
                    require(codeOf(r).equals("world_not_allowed"), "code=" + codeOf(r));
                } finally {
                    sink.world = "numen-test";
                }
            });

            check("J38", "dispatcher failure is structured ok=false", () -> {
                Resp r = send(client, base + PortalCore.COMMAND_PATH, "POST",
                        validBodyJson("tp @s not-a-number"), token, "application/json");
                require(r.status == 200, "status=" + r.status);
                Map<String, Object> body = Json.parseObject(r.body);
                require(Boolean.FALSE.equals(body.get("ok")), "ok true");
                require("command_failed".equals(errorCode(body)), "code=" + errorCode(body));
            });

            check("J39", "wrong content type -> 415", () -> {
                Resp r = send(client, base + PortalCore.COMMAND_PATH, "POST", validBodyJson("tp @s 0 0 0"),
                        token, "text/plain");
                require(r.status == 415, "status=" + r.status);
                require(codeOf(r).equals("unsupported_media_type"), "code=" + codeOf(r));
            });

            check("J40", "oversized body -> 413", () -> {
                String huge = validBodyJson("tp @s 0 0 0").replace("stuck_water", "x".repeat(2000));
                Resp r = send(client, base + PortalCore.COMMAND_PATH, "POST", huge, token,
                        "application/json");
                require(r.status == 413, "status=" + r.status);
                require(codeOf(r).equals("body_too_large"), "code=" + codeOf(r));
            });

            check("J41", "audit records allowed and denied decisions", () -> {
                // give the handler a moment to finish appending deny records
                Thread.sleep(50);
                List<String> lines = Files.readAllLines(auditPath, StandardCharsets.UTF_8);
                require(lines.size() >= 8, "audit lines=" + lines.size());
                boolean allowed = false;
                boolean denied = false;
                boolean tokenLeak = false;
                for (String line : lines) {
                    require(!line.contains(token), "token leaked in audit");
                    if (line.contains(token)) tokenLeak = true;
                    Map<String, Object> rec = Json.parseObject(line);
                    if ("allowed".equals(rec.get("decision"))) allowed = true;
                    if ("denied".equals(rec.get("decision"))) denied = true;
                }
                require(!tokenLeak, "token leaked");
                require(allowed, "no allowed audit record");
                require(denied, "no denied audit record");
            });

            // fresh core with a 2/min limiter to test 429 deterministically
            Path rateAudit = httpDir.resolve("rate-audit.jsonl");
            PortalCore rateCore = new PortalCore(cfg, new FakeSink(), new AuditLog(rateAudit), TokenStore.of(token),
                    new RateLimiter(2, () -> 10_000L));
            rateCore.start();
            try {
                String rateBase = "http://127.0.0.1:" + rateCore.port();
                check("J42", "rate limit -> 429 + Retry-After", () -> {
                    Resp r1 = send(client, rateBase + PortalCore.COMMAND_PATH, "POST",
                            validBodyJson("tp @s 0 0 0"), token, "application/json");
                    Resp r2 = send(client, rateBase + PortalCore.COMMAND_PATH, "POST",
                            validBodyJson("tp @s 0 0 0"), token, "application/json");
                    Resp r3 = send(client, rateBase + PortalCore.COMMAND_PATH, "POST",
                            validBodyJson("tp @s 0 0 0"), token, "application/json");
                    require(r1.status == 200 && r2.status == 200, "first two statuses=" + r1.status + "," + r2.status);
                    require(r3.status == 429, "third status=" + r3.status);
                    require(codeOf(r3).equals("rate_limited"), "code=" + codeOf(r3));
                    require(r3.retryAfter != null && !r3.retryAfter.isBlank(), "no Retry-After");
                });
            } finally {
                rateCore.stop();
            }
        } finally {
            core.stop();
        }
    }

    private static final class FakeSink implements CommandSink {
        final AtomicInteger calls = new AtomicInteger();
        volatile String world = "numen-test";
        volatile String lastCommand = "";

        @Override
        public CommandOutcome execute(String command) {
            calls.incrementAndGet();
            lastCommand = command;
            CommandPolicy.WorldCheck wc = CommandPolicy.checkWorld(world, List.of("numen-test"));
            if (!wc.allowed()) return CommandOutcome.error(world, wc.code(), wc.message());
            if (command.contains("not-a-number")) {
                return CommandOutcome.error(world, "command_failed", "dispatcher rejected command");
            }
            return CommandOutcome.ok(world, 1, List.of("ok"));
        }
    }

    // ── HTTP helpers ────────────────────────────────────────

    private record Resp(int status, String body, String allow, String retryAfter) {}

    private static Resp send(HttpClient client, String url, String method, String body, String token,
                             String contentType) throws IOException, InterruptedException {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(5));
        if (token != null) b.header("Authorization", "Bearer " + token);
        if (contentType != null) b.header("Content-Type", contentType);
        if (body == null) {
            b.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            b.method(method, HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        }
        HttpResponse<String> r = client.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        return new Resp(r.statusCode(), r.body(),
                r.headers().firstValue("Allow").orElse(null),
                r.headers().firstValue("Retry-After").orElse(null));
    }

    private static Map<String, Object> validBody(String command) {
        return req(command, List.of("really no non-GM path?", "minimal operation?", "marked assisted"));
    }

    private static Map<String, Object> req(String command, List<String> challenges) {
        Map<String, Object> req = new LinkedHashMap<>();
        req.put("runId", "selftest-run");
        req.put("command", command);
        req.put("reason", "stuck_water");
        req.put("selfChallenge", challenges);
        return req;
    }

    private static String validBodyJson(String command) {
        return Json.stringify(validBody(command));
    }

    private static String codeOf(Resp r) {
        return errorCode(Json.parseObject(r.body));
    }

    private static String errorCode(Map<String, Object> body) {
        Object err = body.get("error");
        if (err instanceof Map<?, ?> m) {
            Object code = m.get("code");
            return code == null ? "" : String.valueOf(code);
        }
        return "";
    }

    // ── harness ─────────────────────────────────────────────

    private static void check(String id, String name, ThrowingRunnable body) {
        try {
            body.run();
            CASES.add(caseMap(id, name, true, ""));
            System.out.println("PASS " + id + " " + name);
        } catch (Throwable t) {
            failures++;
            String detail = t.getClass().getSimpleName() + ": " + t.getMessage();
            CASES.add(caseMap(id, name, false, detail));
            System.out.println("FAIL " + id + " " + name + " -- " + detail);
        }
    }

    private static Map<String, Object> caseMap(String id, String name, boolean ok, String detail) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("name", name);
        m.put("ok", ok);
        if (!detail.isBlank()) m.put("detail", detail);
        return m;
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static <T extends Throwable> void expectThrows(Class<T> type, ThrowingRunnable body) {
        try {
            body.run();
        } catch (Throwable t) {
            if (type.isInstance(t)) return;
            throw new AssertionError("expected " + type.getSimpleName() + " but got " + t, t);
        }
        throw new AssertionError("expected " + type.getSimpleName() + " but nothing was thrown");
    }

    private static void writeReport(Path out) throws IOException {
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("suite", "java-policy-http");
        report.put("version", PortalCore.VERSION);
        report.put("generatedAt", Instant.now().toString());
        report.put("passed", failures == 0);
        report.put("counts", Map.of("total", CASES.size(), "failed", failures));
        report.put("cases", CASES);
        Path parent = out.toAbsolutePath().getParent();
        if (parent != null) Files.createDirectories(parent);
        Files.writeString(out, Json.stringify(report) + "\n", StandardCharsets.UTF_8);
    }

    private static void deleteTree(Path root) {
        try (var stream = Files.walk(root)) {
            stream.sorted((a, b) -> b.getNameCount() - a.getNameCount()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                    // best effort
                }
            });
        } catch (IOException ignored) {
            // best effort
        }
    }

    @FunctionalInterface
    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}
