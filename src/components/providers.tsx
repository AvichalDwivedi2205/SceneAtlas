"use client";
import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
export const configured=Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY&&process.env.NEXT_PUBLIC_CONVEX_URL);
const client=process.env.NEXT_PUBLIC_CONVEX_URL?new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL):null;
export function Providers({children}:{children:React.ReactNode}){
 if(!configured||!client)return children;
 return <ClerkProvider appearance={{variables:{colorPrimary:"#DCA83C",colorBackground:"#20251b",colorText:"#EDF0E2",colorInputBackground:"#131610",colorInputText:"#EDF0E2",borderRadius:"12px"}}}><ConvexProviderWithClerk client={client} useAuth={useAuth}>{children}</ConvexProviderWithClerk></ClerkProvider>;
}
