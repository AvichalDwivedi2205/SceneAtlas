import { query, mutation, internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { currentUser, requireMember } from "./lib/auth";
export const context=query({args:{boardId:v.id("boards")},handler:async(ctx,{boardId})=>{
  const {user,membership}=await requireMember(ctx,boardId,"owner");return {user,role:membership.role};
}});
export const me=query({args:{},handler:currentUser});
export const list=query({args:{boardId:v.id("boards")},handler:async(ctx,{boardId})=>{
  const {membership}=await requireMember(ctx,boardId);
  const members=await ctx.db.query("members").withIndex("by_board_user",q=>q.eq("boardId",boardId)).collect();
  const invites=membership.role==="owner"?await ctx.db.query("invites").withIndex("by_board",q=>q.eq("boardId",boardId)).collect():[];
  return {members:await Promise.all(members.map(async m=>{const user=await ctx.db.get(m.userId);return {...m,name:user?.name||"Member",avatar:user?.avatar};})),
    invites:invites.map(({_id,email,role,expiresAt,revoked,acceptedBy})=>({_id,email,role,expiresAt,revoked,accepted:Boolean(acceptedBy)}))};
}});
export const storeInvite=internalMutation({args:{boardId:v.id("boards"),email:v.string(),role:v.union(v.literal("editor"),v.literal("viewer")),tokenHash:v.string()},handler:async(ctx,args)=>{
  const {user}=await requireMember(ctx,args.boardId,"owner");
  const pending=await ctx.db.query("invites").withIndex("by_board",q=>q.eq("boardId",args.boardId)).collect();
  if(pending.filter(i=>!i.revoked&&!i.acceptedBy&&i.expiresAt>Date.now()).length>=50)throw new ConvexError("Revoke an unused invite before creating another.");
  await ctx.db.insert("invites",{...args,email:args.email.toLowerCase(),expiresAt:Date.now()+7*86400000,createdBy:user._id,revoked:false});return null;
}});
export const acceptVerified=internalMutation({args:{tokenHash:v.string(),verifiedEmails:v.array(v.string())},returns:v.id("boards"),handler:async(ctx,args)=>{
  const user=await currentUser(ctx);const invite=await ctx.db.query("invites").withIndex("by_hash",q=>q.eq("tokenHash",args.tokenHash)).unique();
  if(!invite||invite.revoked||invite.expiresAt<Date.now())throw new ConvexError("This invite expired or was revoked.");
  if(invite.acceptedBy){if(invite.acceptedBy===user._id)return invite.boardId;throw new ConvexError("This invite was already used.");}
  if(!args.verifiedEmails.map(e=>e.toLowerCase()).includes(invite.email))throw new ConvexError("Sign in with the verified email this invite was sent to.");
  const board=await ctx.db.get(invite.boardId);if(!board||board.archived)throw new ConvexError("This board is unavailable.");
  const existing=await ctx.db.query("members").withIndex("by_board_user",q=>q.eq("boardId",invite.boardId).eq("userId",user._id)).unique();
  if(!existing)await ctx.db.insert("members",{boardId:invite.boardId,userId:user._id,role:invite.role,createdAt:Date.now()});
  await ctx.db.patch(invite._id,{acceptedBy:user._id});return invite.boardId;
}});
export const revokeInvite=mutation({args:{inviteId:v.id("invites")},returns:v.null(),handler:async(ctx,{inviteId})=>{
  const invite=await ctx.db.get(inviteId);if(!invite)throw new ConvexError("Invite not found.");await requireMember(ctx,invite.boardId,"owner");await ctx.db.patch(inviteId,{revoked:true});return null;
}});
export const changeRole=mutation({args:{boardId:v.id("boards"),userId:v.id("users"),role:v.union(v.literal("editor"),v.literal("viewer"),v.literal("remove"))},returns:v.null(),handler:async(ctx,args)=>{
  const {board}=await requireMember(ctx,args.boardId,"owner");if(board.ownerId===args.userId)throw new ConvexError("Transfer ownership before removing the owner.");
  const m=await ctx.db.query("members").withIndex("by_board_user",q=>q.eq("boardId",args.boardId).eq("userId",args.userId)).unique();if(!m)throw new ConvexError("Member not found.");
  if(args.role==="remove")await ctx.db.delete(m._id);else await ctx.db.patch(m._id,{role:args.role});return null;
}});
export const transfer=mutation({args:{boardId:v.id("boards"),userId:v.id("users")},returns:v.null(),handler:async(ctx,args)=>{
  const {membership}=await requireMember(ctx,args.boardId,"owner");const next=await ctx.db.query("members").withIndex("by_board_user",q=>q.eq("boardId",args.boardId).eq("userId",args.userId)).unique();
  if(!next)throw new ConvexError("New owner must already be a member.");if(next._id===membership._id)return null;
  await ctx.db.patch(membership._id,{role:"editor"});await ctx.db.patch(next._id,{role:"owner"});await ctx.db.patch(args.boardId,{ownerId:args.userId});return null;
}});
