import os

import pytest

os.environ.setdefault("NIRNAYA_LLM", "off")

from nirnaya.calibration import Calibrator  # noqa: E402
from nirnaya.engine import Engine  # noqa: E402
from nirnaya.llm import LLM  # noqa: E402
from nirnaya.store import Store  # noqa: E402


@pytest.fixture(scope="session")
def calibrator():
    return Calibrator()


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "nirnaya.db")


@pytest.fixture
def engine(store, calibrator):
    return Engine(store, step_delay=0, llm=LLM(), calibrator=calibrator)


@pytest.fixture
def run_case(engine):
    async def _run(customer, message, channel="chat"):
        c = engine.create_case(customer, message, channel)
        return await engine.run(c["id"])
    return _run
