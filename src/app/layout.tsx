import type { Metadata } from "next";
import { Archivo, Bricolage_Grotesque } from "next/font/google";
import { Providers } from "../components/providers";
import "./globals.css";
const archivo=Archivo({subsets:["latin"],variable:"--font-body"});
const bricolage=Bricolage_Grotesque({subsets:["latin"],variable:"--font-heading"});
export const metadata:Metadata={title:"SceneAtlas — From screenplay to shooting plan",description:"A shared canvas of scenes, researched locations, production decisions, and evidence-backed preparation packets."};
export default function RootLayout({children}:{children:React.ReactNode}){
 return <html lang="en" className={`${archivo.variable} ${bricolage.variable}`}><body><Providers>{children}</Providers></body></html>;
}
