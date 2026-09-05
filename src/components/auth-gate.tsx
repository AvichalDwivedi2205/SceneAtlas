"use client";
import { useEffect, useState } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { SignInButton } from "@clerk/nextjs";
import Link from "next/link";
import { api } from "../../convex/_generated/api";
import { configured } from "./providers";
import { ArrowRight, KeyRound, LoaderCircle } from "lucide-react";
export function SetupRequired(){return <main className="centered-page"><Link className="brand" href="/"><i/>SceneAtlas</Link><div className="setup-card glass"><KeyRound size={28} className="brass"/><h1>Your production workspace is almost ready.</h1><p>Sign-in is being connected. Once it is ready, you can create a private board and invite your team.</p><Link className="button primary" href="/preview">Explore the example board <ArrowRight size={16}/></Link><p className="small muted">Example board uses clearly labeled sample data.</p></div></main>;}
export function AuthGate({children}:{children:React.ReactNode}){return configured?<LiveGate>{children}</LiveGate>:<SetupRequired/>;}
function LiveGate({children}:{children:React.ReactNode}){
 const {isAuthenticated,isLoading}=useConvexAuth();const initialize=useMutation(api.boards.initialize);const [ready,setReady]=useState(false);const [error,setError]=useState("");
 useEffect(()=>{let active=true;if(isAuthenticated)initialize().then(()=>{if(active)setReady(true);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[isAuthenticated,initialize]);
 if(error)return <main className="centered-page"><div className="glass setup-card"><h1>Could not open your workspace</h1><p role="alert">{error}</p><button className="button" onClick={()=>window.location.reload()}>Try again</button></div></main>;
 if(isLoading||(isAuthenticated&&!ready))return <main className="centered-page"><LoaderCircle className="spin brass"/><p>Opening your workspace…</p></main>;
 if(!isAuthenticated)return <main className="centered-page"><Link href="/" className="brand"><i/>SceneAtlas</Link><h1>Your next shoot starts here.</h1><p className="muted">Sign in to create a private production workspace.</p><SignInButton mode="modal"><button className="button primary">Sign in <ArrowRight size={16}/></button></SignInButton></main>;
 return children;
}
