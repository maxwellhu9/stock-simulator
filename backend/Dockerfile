# syntax=docker/dockerfile:1

# --- build stage: resolve dependencies into a virtualenv -------------------
FROM python:3.12-slim AS builder

# uv gives us fast, lockfile-exact installs. Copied from its own image rather
# than pip-installed so the version is pinned and the layer is cached.
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app

# Dependencies change far less often than source, so install them in their own
# layer. Editing app code then rebuilds in seconds instead of re-resolving.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

COPY app ./app
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# --- runtime stage: ship only what is needed to run ------------------------
FROM python:3.12-slim AS runtime

# Never run as root. A container escape should not land on a root shell.
RUN useradd --create-home --uid 10001 exchange

WORKDIR /app
COPY --from=builder --chown=exchange:exchange /app /app

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

USER exchange
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; \
sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health').status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
