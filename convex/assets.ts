import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireMember } from "./lib/auth";
export const requestUpload=mutation({args:{boardId:v.id("boards"),filename:v.string(),mime:v.string(),size:v.number()},handler:async(ctx,args)=>{
  const {user}=await requireMember(ctx,args.boardId,"editor");if(!["application/pdf","text/plain"].includes(args.mime)||args.size<=0||args.size>50*1024*1024||args.filename.length>250)throw new ConvexError("Choose a text-based PDF up to 50 MB, or paste screenplay text.");
  const ticketId=await ctx.db.insert("uploadTickets",{...args,userId:user._id,createdAt:Date.now(),used:false});return {ticketId,url:await ctx.storage.generateUploadUrl()};
}});
export const finishUpload=mutation({args:{ticketId:v.id("uploadTickets"),storageId:v.id("_storage")},returns:v.id("assets"),handler:async(ctx,args)=>{
  const ticket=await ctx.db.get(args.ticketId);if(!ticket)throw new ConvexError("Upload expired. Retry.");
  const {user}=await requireMember(ctx,ticket.boardId,"editor");if(ticket.userId!==user._id||ticket.used||Date.now()-ticket.createdAt>3600000)throw new ConvexError("Upload expired. Retry.");
  const existing=await ctx.db.query("assets").withIndex("by_storage",q=>q.eq("storageId",args.storageId)).unique();if(existing)throw new ConvexError("File already registered.");
  const file=await ctx.db.system.get(args.storageId);if(!file||file.size!==ticket.size||file._creationTime<ticket.createdAt||file.contentType!==ticket.mime)throw new ConvexError("Uploaded file does not match the selected file.");
  const id=await ctx.db.insert("assets",{boardId:ticket.boardId,storageId:args.storageId,filename:ticket.filename,mime:ticket.mime,size:ticket.size,createdBy:user._id,createdAt:Date.now()});
  await ctx.db.patch(ticket._id,{used:true});return id;
}});
export const info=query({args:{assetId:v.id("assets")},handler:async(ctx,{assetId})=>{const asset=await ctx.db.get(assetId);if(!asset)throw new ConvexError("File not found.");await requireMember(ctx,asset.boardId);return asset;}});
export const forRun=internalQuery({args:{runId:v.id("runs"),attempt:v.number(),assetId:v.id("assets")},handler:async(ctx,args)=>{
  const [run,asset]=await Promise.all([ctx.db.get(args.runId),ctx.db.get(args.assetId)]);if(!run||!asset||run.boardId!==asset.boardId||run.attempt!==args.attempt||!["queued","running"].includes(run.status))throw new ConvexError("File access denied.");
  const member=await ctx.db.query("members").withIndex("by_board_user",q=>q.eq("boardId",run.boardId).eq("userId",run.createdBy)).unique();if(!member||member.role==="viewer")throw new ConvexError("Run permission revoked.");return asset;
}});
export const storeArtifact=internalMutation({args:{runId:v.id("runs"),attempt:v.number(),storageId:v.id("_storage"),filename:v.string(),mime:v.string(),size:v.number()},returns:v.id("assets"),handler:async(ctx,args)=>{
  const run=await ctx.db.get(args.runId);if(!run||run.status!=="running"||run.attempt!==args.attempt||run.kind!=="packet")throw new ConvexError("Artifact is not expected for this run.");
  return await ctx.db.insert("assets",{boardId:run.boardId,storageId:args.storageId,filename:args.filename,mime:args.mime,size:args.size,createdBy:`agent:${run._id}`,createdAt:Date.now()});
}});
