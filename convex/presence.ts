import { Presence } from "@convex-dev/presence";
import { components } from "./_generated/api";
import { mutation, query, internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireMember } from "./lib/auth";
const presence=new Presence(components.presence);
const point=v.object({x:v.number(),y:v.number()});
export const heartbeat=mutation({args:{boardId:v.id("boards"),sessionId:v.string()},handler:async(ctx,args)=>{
  const {user}=await requireMember(ctx,args.boardId);if(args.sessionId.length>100)throw new ConvexError("Invalid session.");
  return await presence.heartbeat(ctx,args.boardId,user._id,args.sessionId,15000);
}});
export const signal=mutation({args:{boardId:v.id("boards"),sessionId:v.string(),cursor:v.union(v.null(),point),selectedIds:v.array(v.string()),editingId:v.union(v.null(),v.string()),drag:v.union(v.null(),v.object({entityId:v.string(),x:v.number(),y:v.number()}))},returns:v.null(),handler:async(ctx,args)=>{
  const {user,membership}=await requireMember(ctx,args.boardId);if(args.selectedIds.length>100||args.sessionId.length>100)throw new ConvexError("Invalid presence update.");
  if(membership.role==="viewer"&&(args.drag||args.editingId))throw new ConvexError("Viewers cannot edit.");
  for(const id of [...args.selectedIds,...(args.editingId?[args.editingId]:[]),...(args.drag?[args.drag.entityId]:[])]){
    const normalized=ctx.db.normalizeId("entities",id);const entity=normalized?await ctx.db.get(normalized):null;if(!entity||entity.boardId!==args.boardId)throw new ConvexError("Invalid presence scope.");
  }
  const existing=await ctx.db.query("signals").withIndex("by_session",q=>q.eq("boardId",args.boardId).eq("sessionId",args.sessionId)).unique();
  if(existing&&existing.userId!==user._id)throw new ConvexError("Session belongs to another user.");
  if(existing&&Date.now()-existing.updatedAt<150)return null;
  const value={...args,userId:user._id,updatedAt:Date.now(),expiresAt:Date.now()+45000};
  if(existing)await ctx.db.patch(existing._id,value);else await ctx.db.insert("signals",value);return null;
}});
export const list=query({args:{boardId:v.id("boards")},handler:async(ctx,{boardId})=>{
  await requireMember(ctx,boardId);const online=await presence.listRoom(ctx,boardId,true,100);const signals=await ctx.db.query("signals").withIndex("by_board",q=>q.eq("boardId",boardId)).collect();
  const members=await ctx.db.query("members").withIndex("by_board_user",q=>q.eq("boardId",boardId)).collect();const allowed=new Set(members.map(m=>String(m.userId)));
  return await Promise.all(online.filter(p=>allowed.has(p.userId)).map(async p=>{const id=ctx.db.normalizeId("users",p.userId);const user=id?await ctx.db.get(id):null;
    return {userId:p.userId,name:user?.name||"Member",avatar:user?.avatar,online:p.online,signals:signals.filter(s=>s.userId===p.userId)};}));
}});
export const leave=mutation({args:{sessionToken:v.string()},returns:v.null(),handler:async(ctx,{sessionToken})=>{await presence.disconnect(ctx,sessionToken);return null;}});
export const cleanup=internalMutation({args:{},handler:async ctx=>{const old=await ctx.db.query("signals").withIndex("by_expiry",q=>q.lt("expiresAt",Date.now())).take(500);for(const s of old)await ctx.db.delete(s._id);return null;}});
