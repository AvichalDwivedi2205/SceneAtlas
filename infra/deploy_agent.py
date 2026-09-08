"""Deploy SceneAtlas ADK coordinator to managed Vertex AI Agent Engine."""
from __future__ import annotations

import os
from pathlib import Path

import vertexai
from google.cloud.aiplatform_v1.types.env_var import SecretRef
from google.cloud.aiplatform_v1.types.reasoning_engine import ReasoningEngineSpec
from vertexai import agent_engines

from sceneatlas.agent import root_agent


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Set {name}")
    return value


def package_spec(root: Path) -> tuple[Path, str]:
    return root / "agents", "sceneatlas"


def parallel_secret_bindings(count: str = "1") -> dict[str, SecretRef]:
    """Bind only provisioned slots; retain the original first-secret name."""
    if count not in {"1", "2", "3", "4"}:
        raise RuntimeError("PARALLEL_API_KEY_COUNT must be 1, 2, 3, or 4.")
    return {
        "PARALLEL_API_KEY" if index == 1 else f"PARALLEL_API_KEY{index}": SecretRef(
            secret="sceneatlas-parallel-api-key" if index == 1 else f"sceneatlas-parallel-api-key-{index}",
            version="latest",
        )
        for index in range(1, int(count) + 1)
    }


def deploy():
    project = required("GOOGLE_CLOUD_PROJECT")
    location = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")
    callback_url = required("CONVEX_SITE_URL")
    root = Path(__file__).resolve().parents[1]
    staging = os.getenv("AGENT_STAGING_BUCKET", f"gs://{project}-sceneatlas-agent-staging")
    service_account = os.getenv("AGENT_SERVICE_ACCOUNT", f"sceneatlas-agent@{project}.iam.gserviceaccount.com")
    package_workdir, package_path = package_spec(root)
    os.chdir(package_workdir)
    vertexai.init(project=project, location=location, staging_bucket=staging)
    app = agent_engines.AdkApp(agent=root_agent, app_name="sceneatlas", enable_tracing=True)
    options = dict(
        display_name="SceneAtlas production research coordinator",
        description="Scoped screenplay breakdown, Parallel-backed location research, scheduling, revisions, and preparation packets.",
        requirements=str(root / "agents" / "requirements.runtime.txt"),
        extra_packages=[package_path],
        env_vars={
            "CONVEX_SITE_URL": callback_url,
            "AGENT_CALLBACK_SECRET": SecretRef(secret="sceneatlas-agent-callback", version="latest"),
            **parallel_secret_bindings(os.getenv("PARALLEL_API_KEY_COUNT", "1")),
            "GEMINI_MODEL": os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
            "GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY": "true",
        },
        service_account=service_account,
        identity_type=ReasoningEngineSpec.IdentityType.SERVICE_ACCOUNT,
        min_instances=0,
        max_instances=4,
        container_concurrency=8,
    )
    resource = os.getenv("AGENT_RUNTIME_RESOURCE", "").strip()
    if resource:
        remote = agent_engines.get(resource).update(agent_engine=app, **options)
    else:
        remote = agent_engines.create(app, **options)
    print(remote.resource_name)


if __name__ == "__main__":
    deploy()
