import { connection, NextResponse, type NextRequest } from "next/server";
import { getIngestTask, toIngestTaskData } from "../../../../../../lib/ingest-api/service";

/** USAPI status query / reconciliation. Internal network only, no auth. */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ taskId: string }> },
) {
  await connection();
  const { taskId } = await context.params;
  if (!taskId) {
    return NextResponse.json(
      {
        code: 400,
        message: "task_id 缺失",
        data: { error_code: "INVALID_ARGUMENT", retryable: false },
      },
      { status: 400 },
    );
  }
  const task = await getIngestTask(taskId);
  if (!task) {
    return NextResponse.json(
      {
        code: 404,
        message: "任务不存在",
        data: { error_code: "TASK_NOT_FOUND", retryable: false },
      },
      { status: 404 },
    );
  }
  return NextResponse.json({ code: 200, message: "ok", data: toIngestTaskData(task) });
}
