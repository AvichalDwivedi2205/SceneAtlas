"use client";

import {
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { LoaderCircle } from "lucide-react";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  onClick: (event: MouseEvent<HTMLButtonElement>) => Promise<unknown>;
  pending?: boolean;
  pendingLabel?: string;
  pendingIcon?: ReactNode;
};

/** Keep feedback next to the action and prevent duplicate submissions. */
export function AsyncButton({
  onClick,
  pending = false,
  pendingLabel = "Saving…",
  pendingIcon,
  disabled,
  children,
  ...props
}: Props) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const busy = working || pending;
  return (
    <>
      <button
        {...props}
        type={props.type ?? "button"}
        disabled={disabled || busy}
        aria-busy={busy}
        onClick={async (event) => {
          if (inFlight.current || pending) return;
          inFlight.current = true;
          setWorking(true);
          setError("");
          try {
            await onClick(event);
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not complete this action. Try again.",
            );
          } finally {
            inFlight.current = false;
            setWorking(false);
          }
        }}
      >
        {busy ? (
          <>
            {pendingIcon ?? (
              <LoaderCircle size={14} className="spin" aria-hidden="true" />
            )}
            <span>{pendingLabel}</span>
          </>
        ) : (
          children
        )}
      </button>
      {error && (
        <span className="error action-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
