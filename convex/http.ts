import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal, api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
const http=httpRouter();
async function signedBody(request:Request) {
  const secret=process.env.AGENT_CALLBACK_SECRET;if(!secret)throw new Error("Callback authentication is not configured.");
  const timestamp=request.headers.get("X-SceneAtlas-Time")||"";if(!/^\d+$/.test(timestamp)||Math.abs(Date.now()-Number(timestamp))>300000)throw new Error("Expired request.");
  const raw=await request.text();if(raw.length>14*1024*1024)throw new Error("Request too large.");
  const hex=request.headers.get("X-SceneAtlas-Signature")||"";if(!/^[0-9a-f]{64}$/.test(hex))throw new Error("Invalid signature.");
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
  const signature=Uint8Array.from(hex.match(/../g)!,b=>parseInt(b,16));
  if(!await crypto.subtle.verify("HMAC",key,signature,new TextEncoder().encode(`${timestamp}.${raw}`)))throw new Error("Invalid signature.");
  return JSON.parse(raw);
}
http.route({pathPrefix:"/agent/",method:"POST",handler:httpAction(async(ctx,request)=>{
  try{
    const body=await signedBody(request);const operation=new URL(request.url).pathname.slice("/agent/".length);
    if(operation==="claim")return Response.json(await ctx.runMutation(internal.runs.claim,body));
    if(operation==="context")return Response.json(await ctx.runQuery(internal.runs.context,body));
    if(operation==="event")return Response.json(await ctx.runMutation(internal.runs.event,body));
    if(operation==="sceneBatch")return Response.json(await ctx.runQuery(internal.screenplay.batch,body));
    if(operation==="saveSceneBatch")return Response.json(await ctx.runMutation(internal.screenplay.saveBatch,body));
    if(operation==="asset"){
      const asset=await ctx.runQuery(internal.assets.forRun,body);const blob=await ctx.storage.get(asset.storageId);if(!blob)return new Response("File not found",{status:404});
      return new Response(blob,{headers:{"Content-Type":asset.mime,"Cache-Control":"no-store"}});
    }
    if(operation==="artifact"){
      const {runId,attempt,filename,mime,data}=body as {runId:Id<"runs">;attempt:number;filename:string;mime:string;data:string};
      if(data.length>12*1024*1024||!['application/pdf','application/zip','application/json'].includes(mime)||filename.length>200)throw new Error("Invalid artifact.");
      const context=await ctx.runQuery(internal.runs.context,{runId,attempt});if(context.run.kind!=="packet")throw new Error("Artifact not expected.");
      const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));const storageId=await ctx.storage.store(new Blob([bytes],{type:mime}));
      try{return Response.json({assetId:await ctx.runMutation(internal.assets.storeArtifact,{runId,attempt,storageId,filename,mime,size:bytes.length})});}
      catch(error){await ctx.storage.delete(storageId);throw error;}
    }
    return new Response("Not found",{status:404});
  }catch(error){console.error("Agent callback rejected:",error instanceof Error?error.message:"invalid request");return Response.json({error:"Agent request rejected. Check the run and server logs."},{status:400});}
})});
http.route({path:"/files",method:"GET",handler:httpAction(async(ctx,request)=>{
  try{
    const assetId=new URL(request.url).searchParams.get("assetId") as Id<"assets">|null;if(!assetId)return new Response("File required",{status:400});
    const asset=await ctx.runQuery(api.assets.info,{assetId});const blob=await ctx.storage.get(asset.storageId);if(!blob)return new Response("File not found",{status:404});
    const headers=new Headers({"Content-Type":asset.mime,"Content-Disposition":`inline; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,"Cache-Control":"private, no-store","Accept-Ranges":"bytes","X-Content-Type-Options":"nosniff"});
    const range=request.headers.get("Range");if(range){const match=/^bytes=(\d+)-(\d*)$/.exec(range);if(!match)return new Response(null,{status:416});
      const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),blob.size-1):blob.size-1;if(start>end||start>=blob.size)return new Response(null,{status:416});
      headers.set("Content-Range",`bytes ${start}-${end}/${blob.size}`);headers.set("Content-Length",String(end-start+1));return new Response(blob.slice(start,end+1),{status:206,headers});}
    headers.set("Content-Length",String(blob.size));return new Response(blob,{headers});
  }catch{return new Response("File access denied",{status:403});}
})});
export default http;
