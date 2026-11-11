package numentree.devtools.security;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;

/** Loads the portal bearer token from a restricted file. Never logs it. */
public final class TokenStore {
    public static final int MIN_LENGTH = 32;

    private final byte[] secret;

    private TokenStore(byte[] secret) {
        this.secret = secret;
    }

    public static TokenStore load(Path file) throws IOException {
        if (file == null) throw new IOException("token file path is null");
        if (!Files.isRegularFile(file)) {
            throw new IOException("token file not found: " + file);
        }
        String text = Files.readString(file, StandardCharsets.UTF_8).trim();
        if (text.isEmpty()) {
            throw new IllegalArgumentException("token file is empty: " + file);
        }
        return of(text);
    }

    public static TokenStore of(String token) {
        if (token == null) throw new IllegalArgumentException("token is null");
        String trimmed = token.trim();
        if (trimmed.length() < MIN_LENGTH) {
            throw new IllegalArgumentException(
                    "token must be at least " + MIN_LENGTH + " characters; generate with 32 random bytes");
        }
        for (int i = 0; i < trimmed.length(); i++) {
            if (Character.isWhitespace(trimmed.charAt(i))) {
                throw new IllegalArgumentException("token must not contain whitespace");
            }
        }
        return new TokenStore(trimmed.getBytes(StandardCharsets.UTF_8));
    }

    /** Constant-time comparison; null/empty never matches. */
    public boolean matches(String presented) {
        if (presented == null || presented.isEmpty()) return false;
        byte[] candidate = presented.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(secret, candidate);
    }

    public int length() {
        return secret.length;
    }

    @Override
    public String toString() {
        return "TokenStore[redacted,length=" + secret.length + "]";
    }
}
