"use client";
import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Check, Copy, Link2, Users, LoaderCircle } from "lucide-react";
import { AsyncButton } from "../../components/async-button";
export function SharePanel({ boardId }: { boardId: Id<"boards"> }) {
  const data = useQuery(api.members.list, { boardId });
  const snapshot = useQuery(api.boards.snapshot, { boardId });
  const invite = useAction(api.memberActions.invite);
  const revoke = useMutation(api.members.revokeInvite);
  const changeRole = useMutation(api.members.changeRole);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("editor");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [changing, setChanging] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const token = await invite({ boardId, email, role });
      setCopied(false);
      setUrl(`${window.location.origin}/invite/${token}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create invite.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="share-content">
      <div className="drawer-intro">
        <Users size={24} className="brass" />
        <h2>Make room for your team.</h2>
        <p>Work on the same canvas, or invite someone to follow along.</p>
      </div>
      <div className="privacy-note">
        <Link2 size={16} />
        <div>
          <strong>Private workspace</strong>
          <p>Only invited members can open this board.</p>
        </div>
      </div>
      {snapshot?.role === "owner" && (
        <form onSubmit={submit} className="invite-form">
          <label>
            Email address
            <input
              type="email"
              placeholder="producer@studio.com"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Access
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "viewer" | "editor")}
            >
              <option value="editor">Can edit</option>
              <option value="viewer">Can view</option>
            </select>
          </label>
          <button className="button primary" disabled={busy} aria-busy={busy}>
            {busy ? (
              <>
                <LoaderCircle size={14} className="spin" /> Creating invite…
              </>
            ) : (
              "Create invite link"
            )}
          </button>
          <p className="small muted">
            Invite expires in 7 days. Recipient signs in with this verified
            email.
          </p>
        </form>
      )}
      {url && (
        <div className="invite-link">
          <input aria-label="Invitation link" readOnly value={url} />
          <AsyncButton
            pendingLabel="Copying…"
            aria-label={
              copied ? "Invitation link copied" : "Copy invitation link"
            }
            className="button"
            onClick={() =>
              navigator.clipboard.writeText(url).then(() => setCopied(true))
            }
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </AsyncButton>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <h3 className="list-heading">People with access</h3>
      {!data && (
        <div className="loading-block" role="status">
          <LoaderCircle size={16} className="spin brass" /> Loading
          collaborators…
        </div>
      )}
      {notice && (
        <p className="small moss" role="status">
          {notice}
        </p>
      )}
      {data?.members.map((m) => (
        <div className="member-row" key={m._id}>
          <span className="avatar">{m.name.slice(0, 1)}</span>
          <strong>{m.name}</strong>
          <div className="spacer" />
          {changing.includes(m.userId) && (
            <span className="member-saving" role="status">
              <LoaderCircle size={12} className="spin" /> Saving access…
            </span>
          )}
          {snapshot?.role === "owner" && m.role !== "owner" ? (
            <select
              aria-label={`Role for ${m.name}`}
              value={m.role}
              disabled={changing.includes(m.userId)}
              onChange={(e) => {
                setError("");
                setNotice("");
                setChanging((ids) => [...ids, m.userId]);
                void changeRole({
                  boardId,
                  userId: m.userId,
                  role: e.target.value as "viewer" | "editor" | "remove",
                })
                  .then(() => setNotice(`Access updated for ${m.name}.`))
                  .catch((e) => setError(e.message))
                  .finally(() =>
                    setChanging((ids) => ids.filter((id) => id !== m.userId)),
                  );
              }}
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
              <option value="remove">Remove access</option>
            </select>
          ) : (
            <span className="badge">{m.role}</span>
          )}
        </div>
      ))}
      {data?.invites
        .filter((i) => !i.accepted && !i.revoked)
        .map((i) => (
          <div className="member-row" key={i._id}>
            <span>
              {i.email}
              <small>Pending · {i.role}</small>
            </span>
            <AsyncButton
              pendingLabel="Revoking…"
              className="button quiet"
              onClick={async () => {
                await revoke({ inviteId: i._id });
                setNotice("Invitation revoked.");
              }}
            >
              Revoke
            </AsyncButton>
          </div>
        ))}
    </div>
  );
}
