/**
 * Streaming transport for the direct adapters.
 *
 * Obsidian's `requestUrl` returns a whole body at once, so a reply can only be
 * shown when it is complete. This is the other path: a plain `fetch` whose
 * body is read as it arrives, parsed as server-sent events. It is only ever
 * attempted when the plugin hands the adapter a stream client, and an adapter
 * falls back to `requestUrl` the moment a stream cannot be opened — a browser
 * refusing the cross-origin request, a server that ignores `stream: true` and
 * answers with JSON — so a writer on a phone still gets an answer, just not
 * word by word.
 */

import type { HttpRequest } from "./HttpClient";

export interface StreamResponse {
	status: number;
	ok: boolean;
	headers: Headers;
	/** Null when the transport could not provide a readable body. */
	body: ReadableStream<Uint8Array> | null;
	/** The whole body, for error responses and for servers that did not stream. */
	text(): Promise<string>;
}

export type StreamClient = (request: HttpRequest) => Promise<StreamResponse>;

/**
 * The most text one reply may carry, streamed or whole: well past any prose a
 * writer asks for, well short of what would hurt the app. Past it the reply
 * is refused as a whole rather than truncated, so nothing half-read is
 * mistaken for an answer.
 */
export const MAX_REPLY_CHARS = 2_000_000;
/** One server-sent event line beyond this is not a line; the stream is abandoned. */
export const MAX_SSE_LINE_CHARS = 1_000_000;

export class ReplyTooLargeError extends Error {
	constructor() {
		super("the reply exceeded " + MAX_REPLY_CHARS + " characters");
		this.name = "ReplyTooLargeError";
	}
}

/**
 * Thrown when a stream that had opened stops arriving: the connection was
 * closed under it by the server, a proxy, or the network. Whatever text came
 * before is not an answer, and the request cannot be retried blindly, so the
 * writer is told rather than shown a partial reply or a browser-internal message.
 */
export class StreamInterruptedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StreamInterruptedError";
	}
}

/**
 * Thrown when a stream could not be opened at all — before any byte arrived —
 * so the caller can retry the same request without streaming. A response that
 * did arrive, even an error, is not this: it is an answer to be reported.
 */
export class StreamUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StreamUnavailableError";
	}
}

/** A stream client over `fetch`; the renderer's own `fetch` unless a test hands one in. */
export function fetchStreamClient(fetchImpl?: typeof fetch): StreamClient {
	// `requestUrl` buffers the whole reply; token streaming needs a readable body.
	const doFetch = fetchImpl ?? (typeof window.fetch === "function" ? window.fetch.bind(window) : undefined);
	return async (request) => {
		if (!doFetch) throw new StreamUnavailableError("fetch is not available");
		let response: Response;
		try {
			response = await doFetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: request.signal });
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw error;
			// A TypeError here is the browser refusing the request (CORS, network);
			// nothing was sent that the server acted on, so the caller may retry.
			throw new StreamUnavailableError(error instanceof Error ? error.message : String(error));
		}
		return { status: response.status, ok: response.ok, headers: response.headers, body: response.body, text: () => response.text() };
	};
}

export function isEventStream(headers: Headers): boolean {
	return (headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

/**
 * The `data` payload of each server-sent event, in order. Multi-line data is
 * joined with newlines as the specification says; comments and other fields
 * are ignored; whatever is pending when the stream ends is delivered too.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let data: string[] = [];
	let dataChars = 0;
	const flush = () => { const out = data.length ? data.join("\n") : null; data = []; dataChars = 0; return out; };
	// An event's data lines are joined into one payload, so the event is bounded
	// as a whole: a server that never sends the blank line cannot grow it forever.
	const push = (line: string) => {
		dataChars += line.length + 1;
		if (dataChars > MAX_SSE_LINE_CHARS) throw new ReplyTooLargeError();
		data.push(line);
	};
	try {
		for (;;) {
			let value: Uint8Array | undefined;
			let done: boolean;
			try {
				({ value, done } = await reader.read());
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") throw error;
				throw new StreamInterruptedError(error instanceof Error ? error.message : String(error));
			}
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			if (buffer.length > MAX_SSE_LINE_CHARS) throw new ReplyTooLargeError();
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (line === "") { const out = flush(); if (out !== null) yield out; }
				else if (line.startsWith("data:")) push(line.slice(5).replace(/^ /, ""));
			}
			if (done) break;
		}
		if (buffer.startsWith("data:")) push(buffer.slice(5).replace(/^ /, ""));
		const out = flush();
		if (out !== null) yield out;
	} finally {
		reader.releaseLock();
	}
}
