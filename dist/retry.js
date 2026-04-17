const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);
function isRetryable(error) {
    if (error && typeof error === "object" && "status" in error) {
        const e = error;
        if (e.status && RETRYABLE_STATUS_CODES.has(e.status)) {
            let retryAfterMs;
            if (e.status === 429 && e.headers) {
                const retryAfter = e.headers.get("Retry-After");
                if (retryAfter) {
                    const seconds = parseFloat(retryAfter);
                    if (!isNaN(seconds))
                        retryAfterMs = seconds * 1000;
                }
            }
            return { retryable: true, retryAfterMs };
        }
    }
    return { retryable: false };
}
/**
 * Throw a retryable error if the response has a status code that withRetry
 * can retry (429, 500, 502, 503).  Native fetch resolves on non-OK responses
 * rather than throwing, so callers inside a withRetry callback should call
 * this to enable status-code-based retry.
 */
export function throwOnRetryableStatus(resp) {
    if (RETRYABLE_STATUS_CODES.has(resp.status)) {
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        err.headers = resp.headers;
        throw err;
    }
}
export async function withRetry(fn, opts = {}) {
    const maxRetries = opts.maxRetries ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 1000;
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            if (attempt >= maxRetries)
                break;
            const { retryable, retryAfterMs } = isRetryable(error);
            if (!retryable)
                throw error;
            const delay = retryAfterMs ?? baseDelayMs * Math.pow(2, attempt);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}
//# sourceMappingURL=retry.js.map