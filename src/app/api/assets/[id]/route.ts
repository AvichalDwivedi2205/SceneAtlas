import { auth } from "@clerk/nextjs/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const privateHeaders = {
    "Cache-Control": "private, no-store",
    Vary: "Cookie",
  };
  if (!process.env.CLERK_SECRET_KEY || !process.env.NEXT_PUBLIC_CONVEX_SITE_URL)
    return new Response("File access is not configured", {
      status: 503,
      headers: privateHeaders,
    });
  const session = await auth();
  if (!session.userId)
    return new Response("Sign in required", {
      status: 401,
      headers: privateHeaders,
    });
  const token = await session.getToken({ template: "convex" });
  if (!token)
    return new Response("Session refresh required", {
      status: 401,
      headers: privateHeaders,
    });
  const { id } = await params;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const range = request.headers.get("range");
  if (range) headers.Range = range;
  // Convex checks board membership for every preview and download request.
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_CONVEX_SITE_URL}/files?assetId=${encodeURIComponent(id)}`,
    { headers, cache: "no-store" },
  );
  const resultHeaders = new Headers(response.headers);
  // Fetch already decoded the body. The outgoing server owns compression and
  // framing; forwarding these headers makes browsers decode the bytes twice.
  resultHeaders.delete("Content-Encoding");
  resultHeaders.delete("Content-Length");
  resultHeaders.delete("Transfer-Encoding");
  resultHeaders.set("Cache-Control", "private, no-store");
  resultHeaders.set("Vary", "Cookie");
  resultHeaders.set("X-Content-Type-Options", "nosniff");
  if (response.ok) {
    const disposition =
      new URL(request.url).searchParams.get("disposition") === "attachment"
        ? "attachment"
        : "inline";
    const upstream = resultHeaders.get("Content-Disposition") ?? "inline";
    resultHeaders.set(
      "Content-Disposition",
      upstream.replace(/^[^;]+/, disposition),
    );
  }
  return new Response(response.body, {
    status: response.status,
    headers: resultHeaders,
  });
}
