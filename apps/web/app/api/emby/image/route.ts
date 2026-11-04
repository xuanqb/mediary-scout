import { connection, NextResponse, type NextRequest } from "next/server";
import { fetchEmbyImage } from "../../../../lib/emby-client";
import {
  getCurrentAccountId,
  resolveAccountEmbyConfig,
  UNAUTHENTICATED_ACCOUNT_ID,
} from "../../../../lib/workflow-runtime";

/** Proxy an Emby poster through the app. The Emby API key stays server-side;
 *  the browser only ever sees this private, cacheable image URL. */
export async function GET(request: NextRequest) {
  await connection();
  const itemId = request.nextUrl.searchParams.get("itemId") ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(itemId)) {
    return new NextResponse(null, { status: 400 });
  }
  const accountId = await getCurrentAccountId();
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) {
    return new NextResponse(null, { status: 401 });
  }
  const config = await resolveAccountEmbyConfig(accountId);
  if (!config) {
    return new NextResponse(null, { status: 404 });
  }
  const image = await fetchEmbyImage(config, itemId);
  if (!image) {
    return new NextResponse(null, { status: 404 });
  }
  return new NextResponse(image.body, {
    headers: {
      "Content-Type": image.contentType,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
