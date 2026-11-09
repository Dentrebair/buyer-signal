// Job handlers for Flow A (PRD §5.1). Each takes its dependencies explicitly so tests can run
// them with fakes; main.ts wires the real ones. Every handler is safe to run twice (§5.3a).
// The handlers live in jobs/, one module per area; this file re-exports them for main.ts and the tests.
export type { Deps, Send, Settings } from "./jobs/deps.ts";
export * from "./jobs/runs.ts";
export * from "./jobs/boards.ts";
export * from "./jobs/linkedin.ts";
export * from "./jobs/cards.ts";
export * from "./jobs/resolve.ts";
export * from "./jobs/sniff.ts";
export * from "./jobs/leak.ts";
export * from "./jobs/drafts.ts";
export * from "./jobs/trends.ts";
export * from "./jobs/alerts.ts";
export * from "./jobs/archive.ts";
export * from "./jobs/drift.ts";
export * from "./jobs/contacts.ts";
