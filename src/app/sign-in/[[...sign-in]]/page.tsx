"use client";
import { SignIn } from "@clerk/nextjs";
import { configured } from "../../../components/providers";
import { SetupRequired } from "../../../components/auth-gate";
export default function Page(){return configured?<main className="centered-page"><SignIn forceRedirectUrl="/workspaces"/></main>:<SetupRequired/>;}
