"""Database connection and session handling."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine

# Load .env by hand -- one file, a handful of keys, no need for a dependency.
_env = Path(__file__).resolve().parent.parent / ".env"
if _env.exists():
    for line in _env.read_text().splitlines():
        if line.strip() and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql+psycopg://localhost:5432/paper_exchange"
)

engine = create_engine(DATABASE_URL, echo=False)


def _register_models() -> None:
    """Import the models so they attach themselves to SQLModel.metadata.

    create_all() only creates tables it knows about, and it learns about them as
    a side effect of the class definitions being imported. Without this it
    succeeds silently and creates nothing at all.
    """
    from . import models  # noqa: F401


def create_tables() -> None:
    _register_models()
    SQLModel.metadata.create_all(engine)


def drop_tables() -> None:
    _register_models()
    SQLModel.metadata.drop_all(engine)


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session
