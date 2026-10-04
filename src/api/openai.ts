// Label suggestions via OpenAI chat completions, plain HTTP like the Python (no SDK). Port of
// scripts/propose_labels.py: the prompts are kept word for word, and every answer is filtered against the closed
// label vocabulary, so a made-up or misspelled label never reaches a file.

import { ApiError, HttpFn, snippet, withTimeout } from "./http";

export const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
// propose_labels.py waits 60s
const TIMEOUT_MS = 60_000;
/** Example titles per label in the prompt */
export const EXAMPLES_PER_LABEL = 6;

/** Label -> up to EXAMPLES_PER_LABEL example titles */
export type Vocabulary = Map<string, string[]>;

/** By book id (as given in the request) */
export type LabelProposals = Record<string, string[]>;

export interface LabelRequest {
	id: string;
	title: string;
	author: string;
}

export interface OpenAiOptions {
	apiKey: string;
	model: string;
	http: HttpFn;
	url?: string;
	timeoutMs?: number;
}

/**
 * The vocabulary from Database/ notes' `labels`, with example titles in note order. Notes without a `labels`
 * list (or an empty one) add nothing. Port of load_label_vocabulary
 */
export function labelVocabulary(notes: { title: string; labels: string[] | null }[]): Vocabulary {
	const vocabulary: Vocabulary = new Map();
	for (const note of notes) {
		for (const raw of note.labels ?? []) {
			const label = raw.trim();
			if (!label) {
				continue;
			}
			const titles = vocabulary.get(label) ?? [];
			vocabulary.set(label, titles);
			if (titles.length < EXAMPLES_PER_LABEL) {
				titles.push(note.title);
			}
		}
	}
	return vocabulary;
}

/** Port of build_system_prompt. `guidance` is the hand-written label section of Hardcover Lists.md */
export function buildSystemPrompt(vocabulary: Vocabulary, guidance = ""): string {
	const lines = [
		"You propose reading-tracker labels for books, matching how one " +
			"specific reader already uses them. Only ever propose labels from " +
			"this exact closed set (case-sensitive, use these spellings " +
			"verbatim) - never invent a new label:",
		"",
	];
	for (const label of [...vocabulary.keys()].sort()) {
		lines.push(`- ${label}: e.g. ${(vocabulary.get(label) ?? []).join(", ")}`);
	}
	if (guidance) {
		lines.push("");
		lines.push(
			"The reader has also written down exactly what some of these " +
				"labels mean to him - defer to this over your own assumptions " +
				"about what a label name usually implies:",
		);
		lines.push("");
		lines.push(guidance);
	}
	lines.push("");
	lines.push(
		"For each book given (title, author), return zero or more labels " +
			"that fit, based only on your own knowledge of the book plus the " +
			"pattern of the examples above. A book can have zero, one, or " +
			"several labels. Be conservative - only propose a label you're " +
			"reasonably confident about, since these are reviewed by hand " +
			"before being kept. Respond with a JSON object mapping each " +
			"book's id (as given) to an array of label strings.",
	);
	return lines.join("\n");
}

const REFINE_INSTRUCTIONS =
	"\n\nYou already produced an initial label proposal for these " +
	"books, given below as initial_proposal ({id: [labels]}). The " +
	"reader has now given feedback in plain language on that proposal " +
	"- apply it, changing only what the feedback actually asks you to " +
	"change, and leave every other book's labels exactly as proposed. " +
	"Respond with the same JSON shape: an object mapping every book id " +
	"given in `books` (not just the ones the feedback mentions) to its " +
	"final array of label strings.";

/** Only labels in the vocabulary (exact spelling), only string arrays; anything else is dropped */
export function restrictToVocabulary(content: unknown, vocabulary: Vocabulary): LabelProposals {
	const result: LabelProposals = {};
	if (!content || typeof content !== "object" || Array.isArray(content)) {
		return result;
	}
	for (const [id, labels] of Object.entries(content)) {
		if (Array.isArray(labels)) {
			result[id] = labels.filter((label): label is string => typeof label === "string" && vocabulary.has(label));
		}
	}
	return result;
}

export class OpenAiClient {
	constructor(private readonly options: OpenAiOptions) {}

	/** One chat completion that must answer a JSON object. Throws ApiError; callers fall back to blank Labels */
	async chatJson(systemPrompt: string, userPayload: unknown): Promise<unknown> {
		if (!this.options.apiKey) {
			throw new ApiError("No OpenAI API key set. Add it in the plugin settings.");
		}
		const response = await withTimeout(
			this.options.http({
				url: this.options.url ?? OPENAI_CHAT_URL,
				method: "POST",
				headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					model: this.options.model,
					// No temperature: the default model only supports the default (propose_labels.py)
					response_format: { type: "json_object" },
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: JSON.stringify(userPayload) },
					],
				}),
			}),
			this.options.timeoutMs ?? TIMEOUT_MS,
			"OpenAI",
		);
		let result: { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
		try {
			result = JSON.parse(response.text);
		} catch {
			throw new ApiError(`OpenAI answered HTTP ${response.status} with something that isn't JSON: ${snippet(response.text)}`, response.status);
		}
		if (response.status < 200 || response.status >= 300) {
			// OpenAI's own message; it never repeats the key in full
			throw new ApiError(`OpenAI answered HTTP ${response.status}: ${result.error?.message ?? snippet(response.text)}`, response.status);
		}
		const content = result.choices?.[0]?.message?.content;
		if (typeof content !== "string") {
			throw new ApiError(`OpenAI answered without a message: ${snippet(response.text)}`, response.status);
		}
		try {
			return JSON.parse(content);
		} catch {
			throw new ApiError(`OpenAI's answer isn't JSON: ${snippet(content)}`, response.status);
		}
	}

	/** First suggestion from title and author. Empty vocabulary: nothing to choose from, no call */
	async proposeLabels(entries: LabelRequest[], vocabulary: Vocabulary, guidance = ""): Promise<LabelProposals> {
		if (!vocabulary.size) {
			return {};
		}
		const payload = entries.map((e) => ({ id: e.id, title: e.title, author: e.author }));
		return restrictToVocabulary(await this.chatJson(buildSystemPrompt(vocabulary, guidance), payload), vocabulary);
	}

	/**
	 * The proposal revised by plain-language feedback ("make the werewolf one Fantasy"), for every entry, not just
	 * the ones the feedback names. Empty vocabulary: the proposal comes back unchanged
	 */
	async refineLabels(
		entries: LabelRequest[],
		proposals: LabelProposals,
		feedback: string,
		vocabulary: Vocabulary,
		guidance = "",
	): Promise<LabelProposals> {
		if (!vocabulary.size) {
			return proposals;
		}
		const payload = {
			books: entries.map((e) => ({ id: e.id, title: e.title, author: e.author })),
			initial_proposal: proposals,
			feedback,
		};
		const answer = await this.chatJson(buildSystemPrompt(vocabulary, guidance) + REFINE_INSTRUCTIONS, payload);
		return restrictToVocabulary(answer, vocabulary);
	}
}
