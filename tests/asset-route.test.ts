import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@clerk/nextjs/server";
import { GET } from "../src/app/api/assets/[id]/route";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
const getToken = vi.fn();
const fetchFile = vi.fn();

beforeEach(() => {
  vi.stubEnv("CLERK_SECRET_KEY", "test-configured");
  vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "https://test.convex.site");
  vi.stubGlobal("fetch", fetchFile);
  getToken.mockResolvedValue("session-token");
  vi.mocked(auth).mockResolvedValue({
    userId: "viewer",
    getToken,
  } as unknown as Awaited<ReturnType<typeof auth>>);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function read(disposition = "inline", headers?: HeadersInit) {
  return GET(
    new Request(
      `https://sceneatlas.test/api/assets/pdf?disposition=${disposition}`,
      { headers },
    ),
    { params: Promise.resolve({ id: "pdf" }) },
  );
}

describe("authenticated PDF preview and download", () => {
  it("requires sign-in before requesting any file", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as unknown as Awaited<
      ReturnType<typeof auth>
    >);
    const response = await read();
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it("retains the board membership denial from Convex", async () => {
    fetchFile.mockResolvedValue(
      new Response("File access denied", { status: 403 }),
    );
    const response = await read();
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("File access denied");
  });

  it.each(["inline", "attachment"])(
    "serves %s PDF with private headers and browser range support",
    async (disposition) => {
      fetchFile.mockResolvedValue(
        new Response("PDF bytes", {
          status: 206,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": "inline; filename*=UTF-8''plan.pdf",
            "Content-Range": "bytes 0-8/100",
            "Accept-Ranges": "bytes",
          },
        }),
      );
      const response = await read(disposition, { Range: "bytes=0-8" });
      expect(fetchFile).toHaveBeenCalledWith(
        "https://test.convex.site/files?assetId=pdf",
        {
          headers: {
            Authorization: "Bearer session-token",
            Range: "bytes=0-8",
          },
          cache: "no-store",
        },
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Disposition")).toBe(
        `${disposition}; filename*=UTF-8''plan.pdf`,
      );
      expect(response.headers.get("Content-Range")).toBe("bytes 0-8/100");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Vary")).toBe("Cookie");
    },
  );
});
