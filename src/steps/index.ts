// Every step by id, in pipeline order (sync_books.py): backlog (pull -> link -> push), labels, archive
// (promote -> reconcile -> finished). push and labels follow in step 5.

import type { StepId } from "../core/changes";
import type { Step } from "./context";
import { finished } from "./finished";
import { linkIds } from "./linkIds";
import { promote } from "./promote";
import { pullGoodreads } from "./pullGoodreads";
import { reconcile } from "./reconcile";

export const STEPS: Record<StepId, Step<unknown>> = {
	"backlog/pullGoodreads": pullGoodreads as Step<unknown>,
	"backlog/linkIds": linkIds as Step<unknown>,
	"archive/promote": promote as Step<unknown>,
	"archive/reconcile": reconcile as Step<unknown>,
	"archive/finished": finished as Step<unknown>,
};
