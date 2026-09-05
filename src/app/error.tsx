"use client";
import Link from "next/link";
export default function ErrorPage({error,reset}:{error:Error;reset:()=>void}){return <main className="centered-page"><div className="glass setup-card"><h1>We couldn’t open this view.</h1><p role="alert">{error.message.includes("access")?"Your access to this board changed. Ask its owner for an invitation.":"Your saved work is preserved. Try reconnecting to the workspace."}</p><div className="actions"><button className="button primary" onClick={reset}>Retry</button><Link className="button" href="/workspaces">Workspaces</Link></div></div></main>;}
