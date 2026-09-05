import { auth } from "@clerk/nextjs/server";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 if(!process.env.CLERK_SECRET_KEY||!process.env.NEXT_PUBLIC_CONVEX_SITE_URL)return new Response("File access is not configured",{status:503});
 const session=await auth();if(!session.userId)return new Response("Sign in required",{status:401});const token=await session.getToken({template:"convex"});if(!token)return new Response("Session refresh required",{status:401});
 const {id}=await params;const headers:Record<string,string>={Authorization:`Bearer ${token}`};const range=request.headers.get("range");if(range)headers.Range=range;
 const response=await fetch(`${process.env.NEXT_PUBLIC_CONVEX_SITE_URL}/files?assetId=${encodeURIComponent(id)}`,{headers,cache:"no-store"});
 return new Response(response.body,{status:response.status,headers:response.headers});
}
