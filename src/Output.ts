import type { Annotation, Feedback } from "./Protocol.ts";

/**
 * Pure output shaping for intervu's CLI.
 *
 * Commands build plain JS views with these shapers, render them to TOON via
 * `Toon.encode`, and write through the single `emit` boundary at the CLI. Keep
 * this module free of effects and IO: every function is a total transformation
 * from inputs to a serializable view, so renders stay deterministic and unit
 * testable.
 */

/**
 * A live Session as it appears in the home view, in canonical key order: `key`,
 * `path`, `status`. `path` is the handle every command takes, so the home view
 * carries it for the agent to `poll` (ADR 0013).
 */
export interface SessionSummary {
  readonly key: string;
  readonly path: string;
  readonly status: string;
}

/**
 * The content-first home view shown on bare `intervu` invocation, in canonical
 * key order: `bin`, `description`, `sessions`, `help`.
 */
export interface HomeView {
  readonly bin: string;
  readonly description: string;
  readonly sessions: readonly SessionSummary[];
  readonly help: string;
}

/**
 * Shape the home view, pinning key order so the TOON render is stable
 * regardless of how the caller ordered its fields - including each session row's
 * `{key, path, status}` order.
 */
export const home = (params: HomeView): HomeView => ({
  bin: params.bin,
  description: params.description,
  sessions: params.sessions.map((session) => ({
    key: session.key,
    path: session.path,
    status: session.status,
  })),
  help: params.help,
});

/**
 * A Session as printed by `open`, in canonical key order: `key`, `path`,
 * `status`, `help`.
 */
export interface SessionView {
  readonly key: string;
  readonly path: string;
  readonly status: string;
  readonly help: string;
}

/**
 * Shape the Session view, pinning key order so the TOON render is stable
 * regardless of how the caller ordered its fields.
 */
export const session = (params: SessionView): SessionView => ({
  key: params.key,
  path: params.path,
  status: params.status,
  help: params.help,
});

/**
 * One annotation as the poll prints it: `n` is the 1-based badge number the
 * human saw, then the selector context. `selectedText` is present only on the
 * `text` kind, so the key is omitted entirely for an `element` annotation.
 */
export interface PollAnnotationView {
  readonly n: number;
  readonly kind: string;
  readonly selector: string;
  readonly tag: string;
  readonly text: string;
  readonly selectedText?: string;
}

/**
 * One drained Feedback: the human's message, its numbered annotations, and the
 * DOM snapshot last (it is the bulky field, kept out of the way).
 */
export interface PollFeedbackView {
  readonly message: string;
  readonly annotations: readonly PollAnnotationView[];
  readonly domSnapshot: string;
}

/** The poll's feedback document: the drained collection plus a next-step line. */
export interface PollView {
  readonly feedback: readonly PollFeedbackView[];
  readonly help: string;
}

/** The poll's distinct expiry document, emitted only when `--timeout` is set. */
export interface PollTimedOutView {
  readonly timedOut: true;
  readonly help: string;
}

/**
 * The poll's ended document (ADR 0011): the Session closed. Carries any final
 * feedback the human sent with Send & end (empty for a plain End), so the agent
 * applies the last edit and stops in one poll.
 */
export interface PollEndedView {
  readonly ended: true;
  readonly feedback: readonly PollFeedbackView[];
  readonly help: string;
}

const shapeAnnotation = (
  annotation: Annotation,
  index: number,
): PollAnnotationView => {
  const base = {
    n: index + 1,
    kind: annotation.kind,
    selector: annotation.selector,
    tag: annotation.tag,
    text: annotation.text,
  };
  return annotation.kind === "text"
    ? { ...base, selectedText: annotation.selectedText }
    : base;
};

const shapeFeedback = (feedback: Feedback): PollFeedbackView => ({
  message: feedback.message,
  annotations: feedback.annotations.map(shapeAnnotation),
  domSnapshot: feedback.domSnapshot,
});

/**
 * Shape the poll's drained feedback into its view, pinning the canonical order
 * (`feedback`, then `help`) so the TOON render is stable.
 */
export const pollFeedback = (params: {
  readonly feedback: readonly Feedback[];
  readonly help: string;
}): PollView => ({
  feedback: params.feedback.map(shapeFeedback),
  help: params.help,
});

/** Shape the poll's bounded-timeout expiry into its distinct view. */
export const pollTimedOut = (params: {
  readonly help: string;
}): PollTimedOutView => ({
  timedOut: true,
  help: params.help,
});

/**
 * Shape the poll's ended outcome (ADR 0011), pinning the canonical order
 * (`ended`, `feedback`, then `help`) so the TOON render is stable. The agent
 * applies any final feedback, sees `ended`, and stops.
 */
export const pollEnded = (params: {
  readonly feedback: readonly Feedback[];
  readonly help: string;
}): PollEndedView => ({
  ended: true,
  feedback: params.feedback.map(shapeFeedback),
  help: params.help,
});

/** A view for `intervu end <file>`: the Session is ended. */
export interface EndedView {
  readonly ended: true;
  readonly help: string;
}

/** Shape the `intervu end` confirmation into its view. */
export const ended = (params: { readonly help: string }): EndedView => ({
  ended: true,
  help: params.help,
});

/**
 * One artifact of `intervu setup`: what happened to it (`installed` or
 * `already-present`) and where it landed, in canonical key order. Used for both
 * the Skill and the Hook.
 */
export interface SetupArtifactView {
  readonly action: string;
  readonly path: string;
}

/**
 * The `setup` view, in canonical key order: `skill`, `hook`, then `help`. Each
 * artifact key is present only when that half was in scope (issue #15), so a
 * `--skill-only` / `--hooks-only` run reports just the half it wired.
 */
export interface SetupView {
  readonly skill?: SetupArtifactView;
  readonly hook?: SetupArtifactView;
  readonly help: string;
}

/**
 * Shape the `setup` result, pinning key order so the TOON render is stable
 * regardless of how the caller ordered its fields. An out-of-scope half is
 * passed as `undefined` and omitted from the view entirely.
 */
export const setup = (params: {
  readonly skill?:
    | { readonly action: string; readonly path: string }
    | undefined;
  readonly hook?:
    | { readonly action: string; readonly path: string }
    | undefined;
  readonly help: string;
}): SetupView => ({
  ...(params.skill
    ? { skill: { action: params.skill.action, path: params.skill.path } }
    : {}),
  ...(params.hook
    ? { hook: { action: params.hook.action, path: params.hook.path } }
    : {}),
  help: params.help,
});

/**
 * A structured error view. Errors are success-only here - the failure path is
 * wired in the AXI-polish slice (#9) - but the shape is the seam they land on.
 */
export interface ErrorView {
  readonly error: {
    readonly tag: string;
    readonly message: string;
  };
  readonly help: string;
}

/**
 * Shape a structured error into its view.
 */
export const error = (params: {
  readonly tag: string;
  readonly message: string;
  readonly help: string;
}): ErrorView => ({
  error: { tag: params.tag, message: params.message },
  help: params.help,
});

/**
 * Merge two view fragments into one, with `extra` winning on key conflicts.
 * Used to graft a trailing fragment (a `help` line, an error block) onto a
 * content view before rendering.
 */
export const merge = <A extends object, B extends object>(
  base: A,
  extra: B,
): A & B => ({ ...base, ...extra });
