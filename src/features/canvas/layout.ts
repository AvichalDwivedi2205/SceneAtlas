import ELK from "elkjs/lib/elk.bundled.js";
import type { BoardSnapshot } from "../../domain/model";
import type { Move } from "./board-context";
const elk=new ELK();
export async function arrange(snapshot:BoardSnapshot):Promise<Move[]>{
 const graph=await elk.layout({id:"board",layoutOptions:{"elk.algorithm":"layered","elk.direction":"DOWN","elk.spacing.nodeNode":"70","elk.layered.spacing.nodeNodeBetweenLayers":"120","elk.layered.nodePlacement.strategy":"NETWORK_SIMPLEX"},
  children:snapshot.nodes.map(n=>({id:n.entityId,width:n.width,height:estimatedHeight(snapshot.entities.find(e=>e._id===n.entityId)?.data.kind)})),
  edges:snapshot.edges.map(e=>({id:e._id,sources:[e.relation==="question"?e.targetId:e.sourceId],targets:[e.relation==="question"?e.sourceId:e.targetId]}))});
 return (graph.children??[]).flatMap(n=>{const old=snapshot.nodes.find(o=>o.entityId===n.id);return old&&!old.manual?[{nodeId:old._id,x:n.x??0,y:n.y??0,expectedRevision:old.geometryRevision}]:[];});
}
export function estimatedHeight(kind?:string){return ({script:240,scene:300,question:300,answer:100,location:330,cost:250,requirement:240,plan:290,schedule:300,packet:210,note:180} as Record<string,number>)[kind??"note"]??240;}
