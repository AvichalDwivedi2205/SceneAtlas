import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons=cronJobs();crons.interval("Expire cursor signals",{minutes:1},internal.presence.cleanup,{});crons.interval("Recover disconnected agent runs",{minutes:2},internal.runs.reap,{});export default crons;
