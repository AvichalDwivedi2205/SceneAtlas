import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
const protectedRoute=createRouteMatcher(["/workspaces(.*)","/invite(.*)","/api/assets(.*)"]);
const clerk=clerkMiddleware(async(auth,request)=>{if(protectedRoute(request))await auth.protect();});
export default function proxy(request:NextRequest,event:Parameters<typeof clerk>[1]){
 if(!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY||!process.env.CLERK_SECRET_KEY)return NextResponse.next();return clerk(request,event);
}
export const config={matcher:["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)","/(api|trpc)(.*)"]};
