import pytest
from sqlmodel import Session, SQLModel, create_engine

from app import models  # noqa: F401  -- registers tables on SQLModel.metadata
from app.exchange import Exchange

TEST_URL = "postgresql+psycopg://localhost:5432/paper_exchange_test"


@pytest.fixture(name="session")
def session_fixture():
    engine = create_engine(TEST_URL)
    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


@pytest.fixture(name="ex")
def exchange_fixture(session):
    return Exchange(session)
