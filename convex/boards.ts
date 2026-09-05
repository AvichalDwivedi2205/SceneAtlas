import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { currentUser, requireMember, syncUser, assertRevision } from "./lib/auth";
import { putEntity } from "./lib/entities";
import { entitySchema } from "../src/domain/model";
export const initialize=mutation({args:{},returns:v.id("users"),handler:syncUser});
export const list=query({args:{},handler:async ctx=>{
  const me=await currentUser(ctx);const memberships=await ctx.db.query("members").withIndex("by_user",q=>q.eq("userId",me._id)).collect();
  return (await Promise.all(memberships.map(async m=>{const board=await ctx.db.get(m.boardId);if(!board)return null;
    const entities=await ctx.db.query("entities").withIndex("by_board",q=>q.eq("boardId",board._id)).collect();
    return {...board,role:m.role,scenes:entities.filter(e=>e.kind==="scene").length,open:entities.filter(e=>e.kind==="question"&&e.data.resolution!=="answered").length};}))).filter(b=>b!==null).sort((a,b)=>b.updatedAt-a.updatedAt);
}});
export const create=mutation({args:{name:v.string()},returns:v.id("boards"),handler:async(ctx,args)=>{
  const me=await currentUser(ctx);const name=args.name.trim();if(!name||name.length>100)throw new ConvexError("Use a production name between 1 and 100 characters.");
  const existing=await ctx.db.query("boards").withIndex("by_owner",q=>q.eq("ownerId",me._id)).take(51);if(existing.length>=50)throw new ConvexError("Workspace limit reached.");
  const now=Date.now();const boardId=await ctx.db.insert("boards",{name,ownerId:me._id,createdAt:now,updatedAt:now,archived:false});
  await ctx.db.insert("members",{boardId,userId:me._id,role:"owner",createdAt:now});return boardId;
}});
export const rename=mutation({args:{boardId:v.id("boards"),name:v.string()},returns:v.null(),handler:async(ctx,args)=>{
  await requireMember(ctx,args.boardId,"owner");const name=args.name.trim();if(!name||name.length>100)throw new ConvexError("Invalid name.");await ctx.db.patch(args.boardId,{name,updatedAt:Date.now()});return null;
}});
export const archive=mutation({args:{boardId:v.id("boards"),archived:v.boolean()},returns:v.null(),handler:async(ctx,args)=>{
  const {membership}=await requireMember(ctx,args.boardId);if(membership.role!=="owner")throw new ConvexError("Only the owner can archive this board.");await ctx.db.patch(args.boardId,{archived:args.archived});return null;
}});
export const snapshot=query({args:{boardId:v.id("boards")},handler:async(ctx,{boardId})=>{
  const {board,user,membership}=await requireMember(ctx,boardId);
  const [entities,nodes,edges,choices,runs]=await Promise.all([
    ctx.db.query("entities").withIndex("by_board",q=>q.eq("boardId",boardId)).collect(),ctx.db.query("nodes").withIndex("by_board",q=>q.eq("boardId",boardId)).collect(),
    ctx.db.query("edges").withIndex("by_board",q=>q.eq("boardId",boardId)).collect(),ctx.db.query("choices").withIndex("by_board",q=>q.eq("boardId",boardId)).collect(),
    ctx.db.query("runs").withIndex("by_board",q=>q.eq("boardId",boardId)).order("desc").take(50)]);
  return {board,role:membership.role,me:{_id:user._id,name:user.name,avatar:user.avatar},entities,nodes,edges,choices,
    runs:runs.map(({_id,kind,status,activity,error,scope,targetId,createdAt,updatedAt})=>({_id,kind,status,activity,error,scope,targetId,createdAt,updatedAt}))};
}});
export const move=mutation({args:{boardId:v.id("boards"),moves:v.array(v.object({nodeId:v.id("nodes"),x:v.number(),y:v.number(),expectedRevision:v.number()})),manual:v.boolean()},returns:v.null(),handler:async(ctx,args)=>{
  await requireMember(ctx,args.boardId,"editor");if(args.moves.length>300)throw new ConvexError("Move fewer cards at once.");
  for(const move of args.moves){const node=await ctx.db.get(move.nodeId);if(!node||node.boardId!==args.boardId)throw new ConvexError("Card not found.");assertRevision(node.geometryRevision,move.expectedRevision);
    if(!Number.isFinite(move.x)||!Number.isFinite(move.y)||Math.abs(move.x)>1e6||Math.abs(move.y)>1e6)throw new ConvexError("Invalid position.");
    if(!args.manual&&node.manual)continue;await ctx.db.patch(node._id,{x:move.x,y:move.y,manual:args.manual,geometryRevision:node.geometryRevision+1});}
  return null;
}});
export const addNote=mutation({args:{boardId:v.id("boards"),text:v.string(),x:v.number(),y:v.number()},returns:v.id("entities"),handler:async(ctx,args)=>{
  const {user}=await requireMember(ctx,args.boardId,"editor");return await putEntity(ctx,{boardId:args.boardId,data:entitySchema.parse({kind:"note",text:args.text}),scope:{kind:"workspace"},logicalKey:`note:${crypto.randomUUID()}`,actor:user._id,x:args.x,y:args.y});
}});
