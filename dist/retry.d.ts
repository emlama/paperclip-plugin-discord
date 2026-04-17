export interface RetryOptions {
    maxRetries?: number;
    baseDelayMs?: number;
}
/**
 * Throw a retryable error if the response has a status code that withRetry
 * can retry (429, 500, 502, 503).  Native fetch resolves on non-OK responses
 * rather than throwing, so callers inside a withRetry callback should call
 * this to enable status-code-based retry.
 */
export declare function throwOnRetryableStatus(resp: Response): void;
export declare function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T>;
