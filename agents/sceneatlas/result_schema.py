"""Constrain model output to the entities owned by the current workflow stage."""
from copy import deepcopy
import json
from pathlib import Path

CONTRACT = json.loads(Path(__file__).with_name("entity.schema.json").read_text())
ENTITIES = {schema["properties"]["kind"]["const"]: schema for schema in CONTRACT["oneOf"]}

def breakdown_schema() -> dict:
    return {"type": "object", "additionalProperties": False, "required": ["segments"], "properties": {
        "segments": {"type": "array", "minItems": 1, "maxItems": 6, "items": {
            "type": "object", "additionalProperties": False,
            "required": ["number", "part", "setting", "interiorExterior", "timeOfDay", "needs"],
            "properties": {
                "number": {"type": "integer", "minimum": 1}, "part": {"type": "integer", "minimum": 1},
                "setting": {"type": "string", "maxLength": 300},
                "interiorExterior": {"type": "string", "enum": ["INT", "EXT", "INT/EXT", "UNKNOWN"]},
                "timeOfDay": {"type": "string", "maxLength": 100},
                "needs": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 200}},
            },
        }},
    }}

def generation_shape(schema: dict) -> dict:
    """Keep structure small enough for Gemini; validate all domain bounds afterward."""
    result = {key: value for key, value in schema.items() if key in {"type", "enum", "const", "required", "additionalProperties"}}
    if "properties" in schema:
        result["properties"] = {key: generation_shape(value) for key, value in schema["properties"].items()}
    if "items" in schema:
        result["items"] = generation_shape(schema["items"])
    for key in ["anyOf", "oneOf"]:
        if key in schema:
            result["anyOf"] = [generation_shape(value) for value in schema[key]]
    return result

def workflow_schema(kind: str) -> dict:
    question = deepcopy(ENTITIES["question"])
    # New questions cannot silently establish a production decision.
    question["properties"].update(answer={"type": "null"}, rule={"type": "null"}, resolution={"type": "string", "enum": ["open"]})
    envelope = {"type": "object", "properties": {"data": question}, "required": ["data"], "additionalProperties": False}
    if kind == "scenes":
        envelope["properties"]["sceneNumber"] = {"type": "integer", "minimum": 1}
        envelope["required"].append("sceneNumber")
    properties = {"message": {"type": "string"}}
    if kind != "packet":
        properties["questions"] = {"type": "array", "items": envelope, "maxItems": 30 if kind == "scenes" else 3}
    if kind == "ingest":
        properties["script"] = deepcopy(ENTITIES["script"])
    if kind == "scenes":
        properties["scenes"] = {"type": "array", "items": deepcopy(ENTITIES["scene"]), "minItems": 1, "maxItems": 150}
    if kind in {"research", "requirements"}:
        properties["locations"] = {"type": "array", "items": deepcopy(ENTITIES["location"]), "maxItems": 5}
        properties["lockConflicts"] = {"type": "array", "items": {"type": "string"}}
    if kind in {"chat", "interpret"}:
        properties["proposals"] = {"type": "array", "maxItems": 10, "items": {
            "type": "object", "additionalProperties": False,
            "properties": {"targetId": {"type": "string"}, "summary": {"type": "string"},
                           "data": {"anyOf": [deepcopy(ENTITIES[name]) for name in ["scene", "plan", "question", "note"]]}},
            "required": ["targetId", "summary", "data"],
        }}
    return generation_shape({"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False})
