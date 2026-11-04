import type { ResourceCandidate } from "../domain.js";

/**
 * Phase 6 glue: the real provider adapter and the real storage adapter live in
 * the same process but talk through the V2 interfaces, which carry only the
 * fields the AGENT judges from (id/title/hints) — NOT the raw share url. The
 * registry is the side channel that keeps each observed candidate's full
 * ResourceCandidate (with providerPayload) so the storage adapter can transfer
 * it by id. The agent never sees raw urls; the system resolves them.
 */
export class CandidateRegistry {
  private readonly byId = new Map<string, ResourceCandidate>();

  /** Records under the real id and, when given, under the short alias the agent
   *  was shown — the storage adapter resolves whichever it is handed. */
  record(candidate: ResourceCandidate, alias?: string): void {
    this.byId.set(candidate.id, candidate);
    if (alias !== undefined) this.byId.set(alias, candidate);
  }

  get(candidateId: string): ResourceCandidate | undefined {
    return this.byId.get(candidateId);
  }

  /** Replace every entry (real id and agent alias) that points at this candidate.
   *  Used when a lazy link is resolved at transfer time, so retries and the alias
   *  view see the url instead of re-resolving a paid link. */
  update(candidate: ResourceCandidate): void {
    for (const [key, value] of this.byId) {
      if (value.id === candidate.id) {
        this.byId.set(key, candidate);
      }
    }
  }
}
