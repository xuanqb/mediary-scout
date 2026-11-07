import { connection, NextResponse, type NextRequest } from "next/server";
import {
  IngestRequestError,
  createIngestTask,
  toIngestTaskData,
} from "../../../../../lib/ingest-api/service";

/**
 * USAPI provider entrypoint. Internal network only, no auth (the port is
 * restricted to the USAPI subnet — see the integration doc §7.1).
 */
export async function POST(request: NextRequest) {
  await connection();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        code: 400,
        message: "请求体必须是 JSON",
        data: { error_code: "INVALID_ARGUMENT", retryable: false },
      },
      { status: 400 },
    );
  }

  try {
    const { task, created } = await createIngestTask(body);
    return NextResponse.json(
      {
        code: 200,
        message: created ? "已受理" : "已存在相同请求",
        data: { ...toIngestTaskData(task), deduplicated: !created },
      },
      { status: created ? 202 : 200 },
    );
  } catch (error) {
    if (error instanceof IngestRequestError) {
      return NextResponse.json(
        {
          code: error.status,
          message: error.message,
          data: { error_code: error.code, retryable: error.retryable },
        },
        { status: error.status },
      );
    }
    console.error(`[ingest] create failed: ${String(error)}`);
    return NextResponse.json(
      {
        code: 500,
        message: "服务内部错误",
        data: { error_code: "INTERNAL_ERROR", retryable: true },
      },
      { status: 500 },
    );
  }
}
