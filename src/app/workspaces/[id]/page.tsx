import { AuthGate } from "../../../components/auth-gate";
import { LiveBoard } from "../../../features/canvas/live-board";
export default async function Page({params}:{params:Promise<{id:string}>}){const {id}=await params;return <AuthGate><LiveBoard boardId={id}/></AuthGate>;}
