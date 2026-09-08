import io
import tarfile
from pathlib import Path
import pytest

from infra.deploy_agent import package_spec, parallel_secret_bindings


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


def test_parallel_deployment_retains_legacy_secret_and_binds_four_ordered_slots():
    single = parallel_secret_bindings()
    assert list(single) == ["PARALLEL_API_KEY"]
    assert single["PARALLEL_API_KEY"].secret == "sceneatlas-parallel-api-key"
    four = parallel_secret_bindings("4")
    assert list(four) == ["PARALLEL_API_KEY", "PARALLEL_API_KEY2", "PARALLEL_API_KEY3", "PARALLEL_API_KEY4"]
    assert [reference.secret for reference in four.values()] == ["sceneatlas-parallel-api-key", "sceneatlas-parallel-api-key-2", "sceneatlas-parallel-api-key-3", "sceneatlas-parallel-api-key-4"]
    assert all(reference.version == "latest" for reference in four.values())


@pytest.mark.parametrize("count", ["", "0", "5", "-1", "1.0", "invalid"])
def test_parallel_deployment_rejects_unsupported_key_count(count):
    with pytest.raises(RuntimeError, match="PARALLEL_API_KEY_COUNT"):
        parallel_secret_bindings(count)
