import { LoaderCircle } from "lucide-react";

export function LoadingState({
  title = "Opening your workspace…",
  detail = "Bringing your production into view.",
  canvas = false,
}: {
  title?: string;
  detail?: string;
  canvas?: boolean;
}) {
  return (
    <div
      className={`loading-scene ${canvas ? "loading-canvas" : ""}`}
      role="status"
      aria-label={title}
    >
      <div className="loading-graph" aria-hidden="true">
        <div className="skeleton-card root">
          <i />
          <i />
          <i />
        </div>
        <div className="skeleton-wire" />
        <div className="skeleton-branches">
          <div className="skeleton-card">
            <i />
            <i />
          </div>
          <div className="skeleton-card">
            <i />
            <i />
          </div>
        </div>
      </div>
      <div className="loading-caption">
        <LoaderCircle className="spin brass" size={18} />
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
    </div>
  );
}

export function WorkspaceSkeleton() {
  return (
    <div role="status" aria-label="Loading your productions">
      <span className="sr-only">Loading your productions…</span>
      <div className="workspace-grid" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div className="workspace-tile skeleton-tile" key={i}>
            <div className="tile-canvas">
              <div className="skeleton-card">
                <i />
                <i />
              </div>
            </div>
            <div className="tile-details">
              <div className="skeleton-line" />
              <div className="skeleton-line short" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
