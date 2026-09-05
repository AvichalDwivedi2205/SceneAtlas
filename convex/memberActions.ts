"use node";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Id } from "./_generated/dataModel";
export const invite=action({args:{boardId:v.id("boards"),email:v.string(),role:v.union(v.literal("editor"),v.literal("viewer"))},returns:v.string(),handler:async(ctx,args)=>{
  await ctx.runQuery(api.members.context,{boardId:args.boardId});const email=z.email().parse(args.email.trim().toLowerCase());
  const token=randomBytes(32).toString("base64url");await ctx.runMutation(internal.members.storeInvite,{...args,email,tokenHash:createHash("sha256").update(token).digest("hex")});return token;
}});
export const accept=action({args:{token:v.string()},returns:v.id("boards"),handler:async(ctx,args):Promise<Id<"boards">>=>{
  if(args.token.length>200)throw new ConvexError("Invalid invite.");const user=await ctx.runQuery(api.members.me,{});
  let emails:string[]=[];
  if(user.emailVerified&&user.email)emails=[user.email];
  else {
    const secret=process.env.CLERK_SECRET_KEY;if(!secret)throw new ConvexError("Verified email checking is not configured yet.");
    const response=await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(user.subject)}`,{headers:{Authorization:`Bearer ${secret}`}});
    if(!response.ok)throw new ConvexError("Could not verify your email. Retry shortly.");
    const profile=await response.json() as {email_addresses:{email_address:string;verification:{status:string}|null}[]};
    emails=profile.email_addresses.filter(e=>e.verification?.status==="verified").map(e=>e.email_address);
  }
  return await ctx.runMutation(internal.members.acceptVerified,{tokenHash:createHash("sha256").update(args.token).digest("hex"),verifiedEmails:emails});
}});
