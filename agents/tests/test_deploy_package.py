import io
import tarfile
from pathlib import Path

from infra.deploy_agent import package_spec


def test_agent_package_extracts_as_importable_top_level_module():
    root = Path(__file__).resolve().parents[2]
    workdir, package = package_spec(root)
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w:gz") as tar:
        tar.add(workdir / package, arcname=package)
    archive.seek(0)
    with tarfile.open(fileobj=archive, mode="r:gz") as tar:
        names = tar.getnames()
    assert "sceneatlas/__init__.py" in names
    assert all(name == "sceneatlas" or name.startswith("sceneatlas/") for name in names)
