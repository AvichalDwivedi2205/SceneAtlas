"use client";
import { use, useState } from "react";
import { useAction } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../../../convex/_generated/api";
import { AuthGate } from "../../../components/auth-gate";
export default function Page({params}:{params:Promise<{token:string}>}){const {token}=use(params);return <AuthGate><Invite token={token}/></AuthGate>;}
function Invite({token}:{token:string}){const accept=useAction(api.memberActions.accept);const router=useRouter();const [error,setError]=useState("");const [busy,setBusy]=useState(false);
 return <main className="centered-page"><div className="glass setup-card"><span className="eyebrow">YOU&apos;RE INVITED</span><h1>A seat at the production table.</h1><p>Accept this invitation to open the shared SceneAtlas workspace.</p><button disabled={busy} className="button primary" onClick={async()=>{setBusy(true);try{const id=await accept({token});router.push(`/workspaces/${id}`);}catch(e){setError(e instanceof Error?e.message:"Could not accept invite.");setBusy(false);}}}>{busy?"Opening…":"Accept invitation"}</button>{error&&<p role="alert" className="error">{error}</p>}</div></main>;
}
