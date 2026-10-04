// The one HTTP shape every API client uses. The plugin passes a wrapper around Obsidian's `requestUrl`
// (src/obsidianHttp.ts), tests pass a fake that replays recorded responses. No obsidian import here.

export interface HttpRequest {
	url: string;
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: string;
}

/** Any status, including 4xx/5xx: the client decides what is an error */
export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
}

export type HttpFn = (request: HttpRequest) => Promise<HttpResponse>;

/** Clock for pacing and retries; tests pass a fake one so nothing really waits */
export interface Clock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A failed API call. The message never holds a key or the RSS URL, so it is safe to show and to log */
export class ApiError extends Error {
	constructor(message: string, readonly status: number | null = null) {
		super(message);
		this.name = "ApiError";
	}
}

/** Header lookup ignoring case (requestUrl and Node don't agree on header casing) */
export function header(response: HttpResponse, name: string): string | null {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(response.headers)) {
		if (key.toLowerCase() === lower) {
			return value;
		}
	}
	return null;
}

/** Seconds from a numeric Retry-After header, or null (missing, or the HTTP-date form) */
export function retryAfterSeconds(response: HttpResponse): number | null {
	const raw = header(response, "Retry-After")?.trim();
	const value = Number(raw);
	return raw && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Stops waiting after `ms`. The request itself can't be cancelled (requestUrl has no abort), so a timed-out write
 * may still land: callers never retry after a timeout.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new ApiError(`${what} did not answer within ${Math.round(ms / 1000)}s`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/** Spaces request starts `intervalMs` per unit of cost apart, across every caller sharing this pacer */
export class Pacer {
	private next = 0;

	constructor(private readonly intervalMs: number, private readonly clock: Clock) {}

	async wait(cost = 1): Promise<void> {
		const now = this.clock.now();
		const start = Math.max(now, this.next);
		this.next = start + this.intervalMs * cost;
		if (start > now) {
			await this.clock.sleep(start - now);
		}
	}
}

/** The first `max` characters of a response body, for error messages */
export function snippet(text: string, max = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}
