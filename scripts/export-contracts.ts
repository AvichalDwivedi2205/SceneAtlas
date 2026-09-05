import { writeFileSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { entitySchema } from "../src/domain/model";
mkdirSync("agents/sceneatlas",{recursive:true});
writeFileSync("agents/sceneatlas/entity.schema.json",JSON.stringify(z.toJSONSchema(entitySchema,{unrepresentable:"any"}),null,2)+"\n");
