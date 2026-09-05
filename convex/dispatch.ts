"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { createHmac } from "node:crypto";
export const send=internalAction({args:{runId:v.id("runs")},returns:v.null(),handler:async(ctx,{runId})=>{
  const {run}=await ctx.runQuery(internal.runs.dispatchInfo,{runId});if(!run||run.status!=="queued")return null;
  let error:string|undefined;
  try{
    const url=process.env.AGENT_BRIDGE_URL,secret=process.env.AGENT_BRIDGE_SECRET,callbackUrl=process.env.CONVEX_SITE_URL;
    if(!url||!secret||!callbackUrl)throw new Error("Google Cloud agent connection is not configured yet.");
    const body=JSON.stringify({runId,attempt:run.attempt,callbackUrl});const timestamp=String(Date.now());
    const signature=createHmac("sha256",secret).update(`${timestamp}.${body}`).digest("hex");
    const response=await fetch(`${url.replace(/\/$/,"")}/dispatch`,{method:"POST",body,headers:{"Content-Type":"application/json","X-SceneAtlas-Time":timestamp,"X-SceneAtlas-Signature":signature},signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(`Agent dispatch returned ${response.status}. Check Google Cloud transport logs.`);
  }catch(e){error=e instanceof Error?e.message:"Agent dispatch failed.";}
  await ctx.runMutation(internal.runs.dispatchResult,{runId,error});return null;
}});
