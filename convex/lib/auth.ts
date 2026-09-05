import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { Role } from "../../src/domain/model";
const rank:Record<Role,number>={viewer:0,editor:1,owner:2};
export async function currentUser(ctx:Pick<QueryCtx,"auth"|"db">) {
  const identity=await ctx.auth.getUserIdentity(); if(!identity) throw new ConvexError("Sign in to continue.");
  const user=await ctx.db.query("users").withIndex("by_identity",q=>q.eq("tokenIdentifier",identity.tokenIdentifier)).unique();
  if(!user) throw new ConvexError("Your profile is still initializing. Retry in a moment.");
  return user;
}
export async function requireMember(ctx:Pick<QueryCtx,"auth"|"db">,boardId:Id<"boards">,minimum:Role="viewer") {
  const user=await currentUser(ctx);
  const [board,membership]=await Promise.all([ctx.db.get(boardId),ctx.db.query("members").withIndex("by_board_user",q=>q.eq("boardId",boardId).eq("userId",user._id)).unique()]);
  if(!board || !membership || rank[membership.role]<rank[minimum]) throw new ConvexError("You do not have access to this board or action.");
  if(board.archived && minimum!=="viewer") throw new ConvexError("This board is archived.");
  return {user,board,membership};
}
export async function boardEntity(ctx:Pick<QueryCtx,"db">,boardId:Id<"boards">,id:Id<"entities">) {
  const e=await ctx.db.get(id);if(!e||e.boardId!==boardId)throw new ConvexError("Record not found on this board.");return e;
}
export function assertRevision(actual:number,expected:number) {
  if(actual!==expected)throw new ConvexError("Someone changed this record. Your draft is preserved; review the latest version.");
}
export async function syncUser(ctx:MutationCtx) {
  const i=await ctx.auth.getUserIdentity();if(!i)throw new ConvexError("Sign in to continue.");
  const existing=await ctx.db.query("users").withIndex("by_identity",q=>q.eq("tokenIdentifier",i.tokenIdentifier)).unique();
  const value={tokenIdentifier:i.tokenIdentifier,subject:i.subject,name:i.name||i.nickname||"Producer",email:i.email,
    emailVerified:i.emailVerified===true,avatar:i.pictureUrl};
  if(existing){await ctx.db.patch(existing._id,value);return existing._id;}
  return await ctx.db.insert("users",value);
}
