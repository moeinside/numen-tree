package numentree.devtools.util;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON reader/writer.
 *
 * <p>The GM portal only accepts a tiny JSON envelope, so pulling Gson into the
 * test path would make the pure policy tests depend on the Minecraft classpath.
 * This parser intentionally supports only standard JSON values (no comments,
 * no trailing commas). Depth is bounded to keep hostile 64 KiB bodies cheap.</p>
 */
public final class Json {
    private static final int MAX_DEPTH = 32;

    private Json() {}

    public static Object parse(String text) {
        if (text == null) throw new IllegalArgumentException("json is null");
        Parser p = new Parser(text);
        Object value = p.readValue(0);
        p.skipWs();
        if (!p.atEnd()) throw new IllegalArgumentException("trailing characters at " + p.pos);
        return value;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String text) {
        Object value = parse(text);
        if (!(value instanceof Map<?, ?> map)) {
            throw new IllegalArgumentException("json root must be an object");
        }
        return (Map<String, Object>) map;
    }

    public static String quote(String value) {
        if (value == null) return "null";
        StringBuilder sb = new StringBuilder(value.length() + 2);
        sb.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
        return sb.toString();
    }

    public static String stringify(Object value) {
        StringBuilder sb = new StringBuilder(256);
        write(value, sb);
        return sb.toString();
    }

    private static void write(Object value, StringBuilder sb) {
        if (value == null) {
            sb.append("null");
        } else if (value instanceof String s) {
            sb.append(quote(s));
        } else if (value instanceof Boolean b) {
            sb.append(b);
        } else if (value instanceof Number n) {
            if (n instanceof Double d && (d.isNaN() || d.isInfinite())) {
                sb.append("null");
            } else {
                sb.append(n);
            }
        } else if (value instanceof Map<?, ?> map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : map.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append(quote(String.valueOf(e.getKey())));
                sb.append(':');
                write(e.getValue(), sb);
            }
            sb.append('}');
        } else if (value instanceof Iterable<?> it) {
            sb.append('[');
            boolean first = true;
            for (Object o : it) {
                if (!first) sb.append(',');
                first = false;
                write(o, sb);
            }
            sb.append(']');
        } else if (value.getClass().isArray()) {
            sb.append('[');
            int n = java.lang.reflect.Array.getLength(value);
            for (int i = 0; i < n; i++) {
                if (i > 0) sb.append(',');
                write(java.lang.reflect.Array.get(value, i), sb);
            }
            sb.append(']');
        } else {
            sb.append(quote(String.valueOf(value)));
        }
    }

    private static final class Parser {
        private final String s;
        private int pos;

        Parser(String s) {
            this.s = s;
        }

        boolean atEnd() {
            return pos >= s.length();
        }

        void skipWs() {
            while (pos < s.length()) {
                char c = s.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++;
                else break;
            }
        }

        Object readValue(int depth) {
            if (depth > MAX_DEPTH) throw err("nesting too deep");
            skipWs();
            if (atEnd()) throw err("unexpected end");
            char c = s.charAt(pos);
            return switch (c) {
                case '{' -> readObject(depth + 1);
                case '[' -> readArray(depth + 1);
                case '"' -> readString();
                case 't' -> readLiteral("true", Boolean.TRUE);
                case 'f' -> readLiteral("false", Boolean.FALSE);
                case 'n' -> readLiteral("null", null);
                default -> readNumber();
            };
        }

        Map<String, Object> readObject(int depth) {
            expect('{');
            Map<String, Object> map = new LinkedHashMap<>();
            skipWs();
            if (peek('}')) {
                pos++;
                return map;
            }
            while (true) {
                skipWs();
                if (!peek('"')) throw err("expected object key");
                String key = readString();
                skipWs();
                expect(':');
                map.put(key, readValue(depth));
                skipWs();
                if (peek('}')) {
                    pos++;
                    return map;
                }
                expect(',');
                skipWs();
                if (peek('}')) throw err("trailing comma");
            }
        }

        List<Object> readArray(int depth) {
            expect('[');
            List<Object> list = new ArrayList<>();
            skipWs();
            if (peek(']')) {
                pos++;
                return list;
            }
            while (true) {
                list.add(readValue(depth));
                skipWs();
                if (peek(']')) {
                    pos++;
                    return list;
                }
                expect(',');
                skipWs();
                if (peek(']')) throw err("trailing comma");
            }
        }

        String readString() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (pos < s.length()) {
                char c = s.charAt(pos++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    if (pos >= s.length()) throw err("bad escape");
                    char e = s.charAt(pos++);
                    switch (e) {
                        case '"' -> sb.append('"');
                        case '\\' -> sb.append('\\');
                        case '/' -> sb.append('/');
                        case 'b' -> sb.append('\b');
                        case 'f' -> sb.append('\f');
                        case 'n' -> sb.append('\n');
                        case 'r' -> sb.append('\r');
                        case 't' -> sb.append('\t');
                        case 'u' -> {
                            if (pos + 4 > s.length()) throw err("bad unicode escape");
                            String hex = s.substring(pos, pos + 4);
                            try {
                                sb.append((char) Integer.parseInt(hex, 16));
                            } catch (NumberFormatException ex) {
                                throw err("bad unicode escape");
                            }
                            pos += 4;
                        }
                        default -> throw err("bad escape \\" + e);
                    }
                } else {
                    if (c < 0x20) throw err("control character in string");
                    sb.append(c);
                }
            }
            throw err("unterminated string");
        }

        Object readNumber() {
            int start = pos;
            if (peek('-')) pos++;
            while (pos < s.length() && Character.isDigit(s.charAt(pos))) pos++;
            if (peek('.')) {
                pos++;
                while (pos < s.length() && Character.isDigit(s.charAt(pos))) pos++;
            }
            if (peek('e') || peek('E')) {
                pos++;
                if (peek('+') || peek('-')) pos++;
                while (pos < s.length() && Character.isDigit(s.charAt(pos))) pos++;
            }
            if (start == pos) throw err("unexpected character '" + s.charAt(pos) + "'");
            String raw = s.substring(start, pos);
            try {
                if (raw.contains(".") || raw.contains("e") || raw.contains("E")) {
                    return Double.parseDouble(raw);
                }
                return Long.parseLong(raw);
            } catch (NumberFormatException ex) {
                throw err("bad number " + raw);
            }
        }

        Object readLiteral(String literal, Object value) {
            if (!s.startsWith(literal, pos)) throw err("expected " + literal);
            pos += literal.length();
            return value;
        }

        void expect(char c) {
            if (!peek(c)) throw err("expected '" + c + "'");
            pos++;
        }

        boolean peek(char c) {
            return pos < s.length() && s.charAt(pos) == c;
        }

        IllegalArgumentException err(String message) {
            return new IllegalArgumentException(message + " (at " + pos + ")");
        }
    }
}
