// One sync run through the review window: one step at a time, like sync_books.py. Each step plans (reads only),
// waits for Apply or Skip, then the next step plans on what the previous one wrote. No obsidian import, so the flow
// is unit-tested; the view only renders the state and calls these methods.
// - A plan with no changes passes on by itself; its notes stay in the entry for the summary
// - A failing plan (no key, network) stops on that step: plan again or skip it
// - apply() runs at most once per step, however often it is called (double click)
// - After end(), nothing new starts: answers still in flight are dropped, no later step is planned or applied

import { ApplyResult, Plan, selectedChanges, StepId } from "../core/changes";

export type EntryStatus = "pending" | "planning" | "review" | "applying" | "applied" | "skipped" | "empty" | "failed";

export interface SessionEntry {
	id: StepId;
	status: EntryStatus;
	plan: Plan | null;
	result: ApplyResult | null;
	/** Why planning or applying failed */
	error: string | null;
	/** True when the error came from apply(): some changes may have been written */
	applyFailed: boolean;
}

export interface StepRunner {
	plan(id: StepId): Promise<Plan>;
	apply(plan: Plan): Promise<ApplyResult>;
}

export class SyncSession {
	readonly entries: SessionEntry[];
	private index = 0;
	private endedFlag = false;

	constructor(steps: StepId[], private readonly runner: StepRunner, private readonly onChange: () => void = () => {}) {
		this.entries = steps.map((id) => ({ id, status: "pending", plan: null, result: null, error: null, applyFailed: false }));
	}

	/** The step on screen, or null once every step is through */
	get current(): SessionEntry | null {
		return this.entries[this.index] ?? null;
	}

	get position(): number {
		return this.index;
	}

	get finished(): boolean {
		return this.index >= this.entries.length;
	}

	get ended(): boolean {
		return this.endedFlag;
	}

	/** Planning or applying right now */
	get busy(): boolean {
		const status = this.current?.status;
		return status === "planning" || status === "applying";
	}

	start(): Promise<void> {
		return this.plan();
	}

	/** Plans the current step; steps with nothing to do pass on to the next one */
	private async plan(): Promise<void> {
		while (!this.endedFlag && !this.finished) {
			const entry = this.current!;
			entry.status = "planning";
			entry.error = null;
			entry.applyFailed = false;
			entry.plan = null;
			this.onChange();
			try {
				const plan = await this.runner.plan(entry.id);
				if (this.endedFlag) {
					return;
				}
				entry.plan = plan;
				if (plan.changes.length) {
					entry.status = "review";
					this.onChange();
					return;
				}
				entry.status = "empty";
				this.index++;
			} catch (err) {
				if (this.endedFlag) {
					return;
				}
				entry.status = "failed";
				entry.error = message(err);
				this.onChange();
				return;
			}
		}
		this.onChange();
	}

	/** Writes the current step's ticked, ready changes. Does nothing unless the step waits for review */
	async apply(): Promise<void> {
		const entry = this.current;
		if (this.endedFlag || !entry?.plan || entry.status !== "review" || !selectedChanges(entry.plan).length) {
			return;
		}
		entry.status = "applying";
		this.onChange();
		try {
			entry.result = await this.runner.apply(entry.plan);
			entry.status = "applied";
		} catch (err) {
			entry.status = "failed";
			entry.error = message(err);
			entry.applyFailed = true;
		}
		// Recorded even after end(): the write happened, the summary should say so
		this.onChange();
	}

	/** Leaves the current step unwritten and plans the next one */
	skip(): Promise<void> {
		const entry = this.current;
		if (this.endedFlag || !entry || (entry.status !== "review" && entry.status !== "failed")) {
			return Promise.resolve();
		}
		entry.status = "skipped";
		this.index++;
		return this.plan();
	}

	/** After an applied step: plans the next one */
	next(): Promise<void> {
		const entry = this.current;
		if (this.endedFlag || !entry || entry.status !== "applied") {
			return Promise.resolve();
		}
		this.index++;
		return this.plan();
	}

	/** Plans a failed step again (a key fixed in the settings, the network back) */
	retry(): Promise<void> {
		if (this.endedFlag || this.current?.status !== "failed") {
			return Promise.resolve();
		}
		return this.plan();
	}

	/** Stops the run: no later step is planned or applied */
	end(): void {
		if (this.endedFlag) {
			return;
		}
		this.endedFlag = true;
		this.onChange();
	}
}

export interface StepTally {
	id: StepId;
	status: EntryStatus;
	written: number;
	skipped: number;
}

export function tally(session: SyncSession): StepTally[] {
	return session.entries.map((entry) => ({
		id: entry.id,
		status: entry.status,
		written: entry.result?.applied.length ?? 0,
		skipped: entry.result?.skipped.length ?? 0,
	}));
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
