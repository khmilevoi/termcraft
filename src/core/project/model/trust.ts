import type { GitIdentityV1, TrustGate, TrustSubjectV1 } from "core/ports";
import type { FailureDtoV1 } from "core/protocol";

import type { TrustDecisionV1 } from "../types";

/**
 * Trust subject build, the grant decision, and untrusted-read-only enforcement (KCC §7.1
 * lines 204-205, §12.8 lines 1197-1202).
 *
 * "A grant matches only the same COMPLETE subject... `isGranted` never fails open" —
 * `core/ports/trust.ts`'s own header, restated because `resolveTrustDecision`'s refusal
 * branch depends on that exact non-failing-open behavior: this file never needs a
 * defensive check against `isGranted` throwing or returning a false positive, because the
 * port's own contract already forecloses it.
 *
 * WHAT THIS FILE DOES NOT DO: enforce the "only `project.setTrust`, `project.close`, and
 * read-only `history.open` remain available" restriction (§7.1's untrusted-read-only
 * exemption list). That enforcement already exists — `core/capabilities/model/guards.ts`'s
 * `projectUntrustedReason` implements the identical exemption set against the same three
 * kinds. This file's job stops at PRODUCING the `TrustDecisionV1` that feeds
 * `KernelStateSnapshot.project.trust`; nothing here re-implements a second copy of that
 * guard. §12.8's "starts... no mutation" property instead falls out of a narrower fact:
 * `resolveTrustDecision`'s refusal branch calls nothing but `TrustGate` (see its own
 * comment below) — a caller cannot start Gate/HostSupervisor/migration/export through a
 * dependency this module never asks for in the first place.
 */

export interface TrustResolutionDeps {
  readonly trustGate: TrustGate;
  readonly root: string;
  readonly projectId: string;
  /** `null` when the project's worktree carries no Git repository (storage-identity §8). */
  readonly git: GitIdentityV1 | null;
}

/** The built subject plus whether a PRIOR session already durably granted it. */
export interface TrustStatusV1 {
  readonly subject: TrustSubjectV1;
  readonly granted: boolean;
}

/** Builds the trust subject for `deps.root`/`deps.projectId`/`deps.git` and checks the durable ledger — no grant/refuse decision yet, just the current fact. */
export async function buildTrustStatus(
  deps: TrustResolutionDeps,
): Promise<FailureDtoV1 | TrustStatusV1> {
  const subject = await deps.trustGate.buildSubject(deps.root, deps.projectId, deps.git);
  // `TrustSubjectV1` carries no `code` field, so this structural check — the ring's own
  // idiom for a `FailureDtoV1 | T` union where `T` is a plain DTO, not an `Error`
  // instance (see `core/ports/fakes/page-store.test.ts`'s identical `"code" in result`) —
  // cannot collide with a genuine subject.
  if ("code" in subject) return subject;

  const granted = await deps.trustGate.isGranted(subject);
  return { subject, granted };
}

/**
 * `project.create`'s implicit grant (KCC §7.1's own project-machine comment set: "the
 * implicit-grant-on-create path"; this slice's master doc names it "implicit grant on
 * create"). A project the user just created has no external content to distrust, so it is
 * durably granted without ever asking — `resolveTrustDecision` below is for `project.open`
 * only, where the content predates this Kernel process.
 */
export async function grantImplicitTrust(
  deps: TrustResolutionDeps,
): Promise<FailureDtoV1 | TrustSubjectV1> {
  const subject = await deps.trustGate.buildSubject(deps.root, deps.projectId, deps.git);
  if ("code" in subject) return subject;

  // `TrustGate.grant`'s success is `undefined` (§8.5-style "the write itself carries no
  // payload"), so the failure check here is presence, not shape.
  const granted = await deps.trustGate.grant(subject);
  if (granted !== undefined) return granted;

  return subject;
}

/**
 * Applies an explicit `project.setTrust` decision for an already-built `subject` (KCC
 * §7.1: "Records the validated trust decision"). `"refuse"` is "a valid decision" that
 * "does not trigger close" (§7.1) and durably records NOTHING — it returns
 * `"untrusted-read-only"` without ever calling `trustGate.grant`, which is the exact
 * negative §12.8 requires ("neither transitions to closed nor starts Gate,
 * HostSupervisor, migration transformation, export, or any mutation"): this function
 * touches no dependency besides `trustGate`, so a refusal cannot reach any of those.
 */
export async function resolveTrustDecision(
  trustGate: TrustGate,
  subject: TrustSubjectV1,
  decision: "grant" | "refuse",
): Promise<FailureDtoV1 | TrustDecisionV1> {
  if (decision === "refuse") return "untrusted-read-only";

  const granted = await trustGate.grant(subject);
  if (granted !== undefined) return granted;

  return "trusted";
}
