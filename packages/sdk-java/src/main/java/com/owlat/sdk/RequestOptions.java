package com.owlat.sdk;

import java.util.regex.Pattern;

/**
 * Per-call options for the send methods ({@code transactional().send},
 * {@code events().send}). Mirrors the JS SDK's {@code RequestOptions}.
 *
 * <p>{@link #idempotencyKey(String)} sends the request with an
 * {@code Idempotency-Key} header. The server applies the request at most once
 * per key for 24 hours and answers a repeat with the first response, so the SDK
 * also retries a keyed send after a 5xx, network error or timeout. Reusing a key
 * for a different request fails with a {@code ConflictException} (409).
 *
 * <p>Needs an Owlat server released after 0.6.16; an older server ignores the
 * header, and a retried send could then go out twice.
 */
public final class RequestOptions {

    /** Longest key the API accepts. */
    public static final int MAX_IDEMPOTENCY_KEY_LENGTH = 255;

    /** The API's key rule: printable ASCII without spaces. */
    private static final Pattern KEY_PATTERN = Pattern.compile("^[\\x21-\\x7e]+$");

    private final String idempotencyKey;

    private RequestOptions(String idempotencyKey) {
        this.idempotencyKey = idempotencyKey;
    }

    /**
     * Options carrying an idempotency key: 1 to {@value #MAX_IDEMPOTENCY_KEY_LENGTH}
     * printable ASCII characters without spaces, such as a UUID or your own
     * order id.
     *
     * @throws IllegalArgumentException if the key is null or breaks that rule
     */
    public static RequestOptions idempotencyKey(String key) {
        if (key == null
                || key.isEmpty()
                || key.length() > MAX_IDEMPOTENCY_KEY_LENGTH
                || !KEY_PATTERN.matcher(key).matches()) {
            throw new IllegalArgumentException(
                    "idempotencyKey must be 1 to " + MAX_IDEMPOTENCY_KEY_LENGTH
                            + " printable ASCII characters without spaces");
        }
        return new RequestOptions(key);
    }

    /** The idempotency key, or {@code null} when none was set. */
    public String getIdempotencyKey() {
        return idempotencyKey;
    }
}
