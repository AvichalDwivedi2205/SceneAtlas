"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { AsyncButton } from "./async-button";

export function AssetButton({
  assetId,
  filename,
  mode = "download",
  className = "button",
  children,
}: {
  assetId: string;
  filename: string;
  mode?: "download" | "open";
  className?: string;
  children: ReactNode;
}) {
  const objectUrl = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );
  if (mode === "open")
    return (
      <a
        className={className}
        href={`/api/assets/${encodeURIComponent(assetId)}?disposition=inline`}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  return (
    <AsyncButton
      className={className}
      pendingLabel="Preparing download…"
      onClick={async () => {
        const response = await fetch(
          `/api/assets/${encodeURIComponent(assetId)}?disposition=attachment`,
        );
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? "Sign in again to download this file."
              : "Could not download this file. Try again.",
          );
        const blob = await response.blob();
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectUrl.current;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
      }}
    >
      {children}
    </AsyncButton>
  );
}
