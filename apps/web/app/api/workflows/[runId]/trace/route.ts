import { connection, NextResponse, type NextRequest } from "next/server";
import { getRunTrace } from "../../../../../lib/run-trace";
import { getWorkflowRepository, resolveGlobalWorkspace } from "../../../../../lib/workflow-runtime";

/**
 * Read-only post-mortem trace for one workflow run: tool-call timeline, search
 * snapshots (with prefilter scores), pick decisions, transfer attempts, audit
 * events and notifications. Scoped to the active drive via `?w`; a run owned by
 * another account (or already pruned) yields 404 rather than leaking its shape.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
) {
  await connection();
  const { runId } = await context.params;
  if (!runId) {
    return NextResponse.json({ error: "runId required" }, { status: 400 });
  }
  const repository = getWorkflowRepository();
  const { accountId, connectedStorageId } = await resolveGlobalWorkspace(
    request.nextUrl.searchParams.get("w") ?? undefined,
  );
  const trace = await getRunTrace({
    repository,
    runId,
    scope: { accountId, connectedStorageId },
  });
  if (!trace) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  return NextResponse.json(trace);
}
