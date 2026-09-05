"use client";
import { createContext, useContext } from "react";
import type { BoardSnapshot, Entity, EntityData, Scope, TaskKind } from "../../domain/model";
export type Move={nodeId:string;x:number;y:number;expectedRevision:number};
export type BoardActions={
 upload:(file:File)=>Promise<void>;start:(kind:TaskKind,targetId?:string,scope?:Scope,request?:unknown)=>Promise<void>;
 preview:(entity:Entity,data:EntityData)=>Promise<string>;move:(moves:Move[],manual:boolean)=>Promise<void>;
 choose:(planId:string,sceneId:string,locationId:string,locked:boolean,expectedRevision:number)=>Promise<void>;
 note:(text:string,x:number,y:number)=>Promise<void>;cancel:(runId:string)=>Promise<void>;retry:(runId:string)=>Promise<void>;
 signal?:(value:{cursor:{x:number;y:number}|null;selectedIds:string[];editingId:string|null;drag:{entityId:string;x:number;y:number}|null})=>void;
 change:(action:"commitInputs"|"regenerate"|"apply"|"undo"|"discard",id:string)=>Promise<void>;
};
export type ChangeView={_id:string;summary:string;status:string;targetId?:string;proposed?:EntityData;before?:EntityData;affectedIds:string[];runIds:string[]};
export type MessageView={_id:string;scope:Scope;role:"user"|"assistant";text:string;changeId?:string};
export type Person={userId:string;name:string;avatar?:string;online:boolean;signals:{cursor:{x:number;y:number}|null;updatedAt:number;expiresAt:number;selectedIds:string[];editingId:string|null;drag:{entityId:string;x:number;y:number}|null}[]};
export const BoardContext=createContext<{snapshot:BoardSnapshot;actions:BoardActions;activePlanId?:string;previewMode:boolean;focus:(id:string)=>void;inspect:(e:Entity)=>void;edit:(e:Entity)=>void;act:(f:()=>Promise<unknown>,message?:string)=>Promise<void>}|null>(null);
export function useBoard(){const c=useContext(BoardContext);if(!c)throw new Error("Board context missing");return c;}
