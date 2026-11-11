package numentree.devtools;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import numentree.devtools.util.Json;

/**
 * Dev-only GM portal configuration.
 *
 * <p>The file lives at {@code <gameDir>/config/numen-devtools.json}. It is
 * written with {@code enabled=false} on first launch; the token is never part
 * of this file or of the repository.</p>
 */
public record DevToolsConfig(
        boolean enabled,
        String bindAddress,
        int port,
        String tokenFile,
        List<String> allowedWorlds,
        int maxPerMinute,
        int maxCommandLength,
        int maxBodyBytes) {

    public static final String FILE_NAME = "numen-devtools.json";
    public static final String DEFAULT_TOKEN_FILE = "config/numen-devtools.token";
    public static final int DEFAULT_PORT = 8770;

    public DevToolsConfig {
        bindAddress = bindAddress == null ? "127.0.0.1" : bindAddress.trim();
        tokenFile = tokenFile == null ? DEFAULT_TOKEN_FILE : tokenFile.trim();
        allowedWorlds = List.copyOf(allowedWorlds == null ? List.of() : allowedWorlds);
    }

    public static DevToolsConfig defaults() {
        return new DevToolsConfig(
                false,
                "127.0.0.1",
                DEFAULT_PORT,
                DEFAULT_TOKEN_FILE,
                List.of("numen-test"),
                10,
                512,
                65_536);
    }

    /** Loads (or creates) {@code <gameDir>/config/numen-devtools.json}. */
    public static DevToolsConfig load(Path gameDir) throws IOException {
        Path configDir = gameDir.resolve("config");
        Path file = configDir.resolve(FILE_NAME);
        if (!Files.exists(file)) {
            DevToolsConfig defaults = defaults();
            Files.createDirectories(configDir);
            Files.writeString(file, Json.stringify(defaults.toMap()) + "\n", StandardCharsets.UTF_8);
            return defaults;
        }
        String text = Files.readString(file, StandardCharsets.UTF_8);
        Map<String, Object> obj;
        try {
            obj = Json.parseObject(text);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("invalid " + FILE_NAME + ": " + e.getMessage(), e);
        }
        return fromMap(obj);
    }

    public static DevToolsConfig fromMap(Map<String, Object> obj) {
        DevToolsConfig d = defaults();
        boolean enabled = bool(obj, "enabled", d.enabled);
        String bind = str(obj, "bindAddress", d.bindAddress);
        int port = integer(obj, "port", d.port);
        String tokenFile = str(obj, "tokenFile", d.tokenFile);
        List<String> worlds = stringList(obj, "allowedWorlds", d.allowedWorlds);
        int rpm = integer(obj, "maxPerMinute", d.maxPerMinute);
        int maxLen = integer(obj, "maxCommandLength", d.maxCommandLength);
        int maxBody = integer(obj, "maxBodyBytes", d.maxBodyBytes);
        return new DevToolsConfig(enabled, bind, port, tokenFile, worlds, rpm, maxLen, maxBody);
    }

    public Map<String, Object> toMap() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("enabled", enabled);
        m.put("bindAddress", bindAddress);
        m.put("port", port);
        m.put("tokenFile", tokenFile);
        m.put("allowedWorlds", allowedWorlds);
        m.put("maxPerMinute", maxPerMinute);
        m.put("maxCommandLength", maxCommandLength);
        m.put("maxBodyBytes", maxBodyBytes);
        m.put("_comment",
                "dev-only GM command portal. Keep enabled=false except during an authorized dev session; "
                        + "token lives in tokenFile, never in git.");
        return m;
    }

    /** Resolves the token file relative to the game directory. */
    public Path resolveTokenPath(Path gameDir) {
        Path p = Path.of(tokenFile);
        return p.isAbsolute() ? p : gameDir.resolve(p);
    }

    /** Returns human-readable problems; empty means the service may start. */
    public List<String> validateForServer() {
        List<String> problems = new ArrayList<>();
        if (!isLoopback(bindAddress)) {
            problems.add("bindAddress must be loopback (127.0.0.1, ::1 or localhost), got: " + bindAddress);
        }
        if (port < 1 || port > 65_535) {
            problems.add("port must be 1..65535, got: " + port);
        }
        if (tokenFile.isBlank()) {
            problems.add("tokenFile must not be blank");
        }
        if (allowedWorlds.isEmpty()) {
            problems.add("allowedWorlds must contain at least one test world (fail closed)");
        }
        if (maxPerMinute < 1 || maxPerMinute > 600) {
            problems.add("maxPerMinute must be 1..600, got: " + maxPerMinute);
        }
        if (maxCommandLength < 16 || maxCommandLength > 4096) {
            problems.add("maxCommandLength must be 16..4096, got: " + maxCommandLength);
        }
        if (maxBodyBytes < 1024 || maxBodyBytes > 1_048_576) {
            problems.add("maxBodyBytes must be 1024..1048576, got: " + maxBodyBytes);
        }
        return problems;
    }

    public static boolean isLoopback(String host) {
        if (host == null) return false;
        String h = host.trim().toLowerCase(java.util.Locale.ROOT);
        return h.equals("127.0.0.1") || h.equals("::1") || h.equals("localhost");
    }

    private static String str(Map<String, Object> obj, String key, String fallback) {
        Object v = obj.get(key);
        if (v == null) return fallback;
        if (!(v instanceof String s)) throw new IllegalArgumentException(key + " must be a string");
        return s;
    }

    private static boolean bool(Map<String, Object> obj, String key, boolean fallback) {
        Object v = obj.get(key);
        if (v == null) return fallback;
        if (!(v instanceof Boolean b)) throw new IllegalArgumentException(key + " must be a boolean");
        return b;
    }

    private static int integer(Map<String, Object> obj, String key, int fallback) {
        Object v = obj.get(key);
        if (v == null) return fallback;
        if (!(v instanceof Number n)) throw new IllegalArgumentException(key + " must be a number");
        return n.intValue();
    }

    private static List<String> stringList(Map<String, Object> obj, String key, List<String> fallback) {
        Object v = obj.get(key);
        if (v == null) return fallback;
        if (!(v instanceof List<?> list)) throw new IllegalArgumentException(key + " must be an array");
        List<String> out = new ArrayList<>();
        for (Object o : list) {
            if (!(o instanceof String s)) throw new IllegalArgumentException(key + " must contain strings");
            out.add(s);
        }
        return out;
    }
}
