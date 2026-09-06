"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { AsyncButton } from "./async-button";

export function AssetButton({
  assetId,
  filename,
  className = "button",
  children,
}: {
  assetId: string;
  filename: string;
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
  return (
    <AsyncButton
      className={className}
      pendingLabel="Preparing download…"
      onClick={async () => {
        const response = await fetch(
          `/api/assets/${encodeURIComponent(assetId)}`,
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
