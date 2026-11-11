package numentree.devtools.security;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Pure command policy for the GM portal.
 *
 * <p>Only a small root allowlist is accepted. {@code execute} is validated
 * recursively: its child command (after the first top-level {@code run}
 * keyword) must itself pass the same policy. Forbidden roots are rejected with
 * a distinct code so audits show an intentional block rather than a typo.</p>
 *
 * <p>This class has no Minecraft dependency so it can be unit tested without a
 * game classpath.</p>
 */
public final class CommandPolicy {
    public static final int MAX_EXECUTE_DEPTH = 8;

    public static final Set<String> ALLOWED_ROOTS = Set.of(
            "tp", "give", "time", "weather", "setblock", "fill", "summon", "effect",
            "gamemode", "xp", "execute", "spawnpoint", "setworldspawn");

    public static final Set<String> FORBIDDEN_ROOTS = Set.of(
            "stop", "reload", "op", "deop", "ban", "whitelist",
            "gamerule", "difficulty", "peaceful",
            "kill", "clear", "data");

    private CommandPolicy() {}

    /** Result of validating one raw command string. */
    public record CommandCheck(
            boolean allowed,
            String code,
            String message,
            String command,
            List<String> roots) {

        public static CommandCheck ok(String command, List<String> roots) {
            return new CommandCheck(true, "ok", "", command, List.copyOf(roots));
        }

        public static CommandCheck deny(String code, String message) {
            return new CommandCheck(false, code, message, "", List.of());
        }
    }

    /** Result of validating the current world name. */
    public record WorldCheck(boolean allowed, String code, String message, String world) {
        public static WorldCheck ok(String world) {
            return new WorldCheck(true, "ok", "", world);
        }

        public static WorldCheck deny(String world, String message) {
            return new WorldCheck(false, "world_not_allowed", message, world == null ? "" : world);
        }
    }

    private record Token(String text, boolean quoted) {}

    /**
     * Validates and normalizes a command. A single optional leading slash is
     * removed; the dispatcher expects a command without it.
     */
    public static CommandCheck checkCommand(String raw, int maxLength) {
        if (raw == null || raw.isBlank()) {
            return CommandCheck.deny("empty_command", "command must not be empty");
        }
        if (raw.length() > maxLength) {
            return CommandCheck.deny("command_too_long",
                    "command length " + raw.length() + " exceeds " + maxLength);
        }
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if ((c < 0x20 && c != '\t') || c == 0x7f) {
                return CommandCheck.deny("bad_characters", "control characters are not allowed");
            }
        }
        String normalized = raw.trim();
        if (normalized.startsWith("/")) {
            normalized = normalized.substring(1).trim();
        }
        if (normalized.isEmpty()) {
            return CommandCheck.deny("empty_command", "command must not be empty");
        }
        if (normalized.length() > maxLength) {
            return CommandCheck.deny("command_too_long",
                    "command length " + normalized.length() + " exceeds " + maxLength);
        }

        List<Token> tokens;
        try {
            tokens = tokenize(normalized);
        } catch (IllegalArgumentException e) {
            return CommandCheck.deny("invalid_syntax", e.getMessage());
        }
        if (tokens.isEmpty()) {
            return CommandCheck.deny("empty_command", "command must not be empty");
        }
        if (tokens.get(0).quoted()) {
            return CommandCheck.deny("invalid_syntax", "root command must not be quoted");
        }

        List<String> roots = new ArrayList<>();
        CommandCheck nested = validateTokens(tokens, roots, 0);
        if (!nested.allowed()) {
            return nested;
        }
        return CommandCheck.ok(normalized, roots);
    }

    private static CommandCheck validateTokens(List<Token> tokens, List<String> roots, int depth) {
        if (depth > MAX_EXECUTE_DEPTH) {
            return CommandCheck.deny("execute_too_deep",
                    "execute nesting exceeds " + MAX_EXECUTE_DEPTH);
        }
        if (tokens.isEmpty()) {
            return CommandCheck.deny("invalid_syntax", "missing command root");
        }
        Token first = tokens.get(0);
        if (first.quoted() || first.text().isBlank()) {
            return CommandCheck.deny("invalid_syntax", "invalid command root");
        }
        String root = first.text().toLowerCase(Locale.ROOT);
        roots.add(root);

        if (FORBIDDEN_ROOTS.contains(root)) {
            return CommandCheck.deny("forbidden_root", "root command is forbidden: " + root);
        }
        if (!ALLOWED_ROOTS.contains(root)) {
            return CommandCheck.deny("root_not_allowed", "root command is not allowed: " + root);
        }
        if (!root.equals("execute")) {
            return CommandCheck.ok("", roots);
        }

        int runIndex = -1;
        for (int i = 1; i < tokens.size(); i++) {
            Token t = tokens.get(i);
            if (!t.quoted() && t.text().equalsIgnoreCase("run")) {
                runIndex = i;
                break;
            }
        }
        if (runIndex < 0) {
            return CommandCheck.deny("execute_without_run",
                    "execute must contain a top-level 'run' keyword");
        }
        List<Token> child = tokens.subList(runIndex + 1, tokens.size());
        if (child.isEmpty()) {
            return CommandCheck.deny("execute_without_run", "execute 'run' has no child command");
        }
        return validateTokens(child, roots, depth + 1);
    }

    /**
     * Splits a command into tokens, honoring single quotes, double quotes and
     * backslash escapes. Minecraft's Brigadier reader uses a similar model for
     * command strings.
     */
    static List<Token> tokenize(String command) {
        List<Token> tokens = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        boolean inToken = false;
        boolean quoted = false;
        char quote = 0;
        for (int i = 0; i < command.length(); i++) {
            char c = command.charAt(i);
            if (quote != 0) {
                if (c == '\\' && i + 1 < command.length()) {
                    current.append(command.charAt(++i));
                } else if (c == quote) {
                    quote = 0;
                } else {
                    current.append(c);
                }
                inToken = true;
            } else if (c == '"' || c == '\'') {
                quote = c;
                quoted = true;
                inToken = true;
            } else if (c == '\\' && i + 1 < command.length()) {
                current.append(command.charAt(++i));
                inToken = true;
            } else if (Character.isWhitespace(c)) {
                if (inToken) {
                    tokens.add(new Token(current.toString(), quoted));
                    current.setLength(0);
                    inToken = false;
                    quoted = false;
                }
            } else {
                current.append(c);
                inToken = true;
            }
        }
        if (quote != 0) {
            throw new IllegalArgumentException("unterminated quote");
        }
        if (inToken) {
            tokens.add(new Token(current.toString(), quoted));
        }
        return tokens;
    }

    /** Checks the world name against the configured test-world allowlist. */
    public static WorldCheck checkWorld(String world, List<String> allowedWorlds) {
        if (world == null || world.isBlank()) {
            return WorldCheck.deny(world, "server did not report a world name");
        }
        if (allowedWorlds == null || allowedWorlds.isEmpty()) {
            return WorldCheck.deny(world, "allowedWorlds is empty; refusing every world");
        }
        String needle = world.trim();
        for (String allowed : allowedWorlds) {
            if (allowed != null && allowed.trim().equalsIgnoreCase(needle)) {
                return WorldCheck.ok(needle);
            }
        }
        return WorldCheck.deny(needle,
                "world '" + needle + "' is not in allowedWorlds " + allowedWorlds);
    }

    /** Roots observed in the command, useful for audit tests. */
    public static List<String> rootsOf(String raw, int maxLength) {
        CommandCheck c = checkCommand(raw, maxLength);
        return c.allowed() ? c.roots() : List.of();
    }

    /** Distinct root list helper for audits. */
    public static List<String> distinct(List<String> roots) {
        return List.copyOf(new LinkedHashSet<>(roots));
    }
}
