# Local decision engine image: ghcr.io/wolvesdotink/decision-local
#
# Answers the decision plane's yes/no, category and score questions on this
# server with a GLiNER2.5 Decide checkpoint, so no message text leaves the
# deployment (apps/api/convex/lib/decisionProviders/local.ts is the client).
# CPU only. The model is NOT baked in: it downloads into the /models volume on
# first start and is read from there afterwards, which keeps the image small
# and lets DECISION_LOCAL_MODEL pick a different checkpoint without a rebuild.
#
# requirements.txt is a full lock resolved from requirements.in on this base:
#   docker run --rm -v "$PWD:/w" -w /w python:3.12-slim-bookworm sh -c \
#     'pip install -q -r requirements.in && pip freeze > requirements.txt'
# then put the --extra-index-url line back at the top.
FROM python:3.12-slim-bookworm AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models \
    HF_HUB_DISABLE_TELEMETRY=1 \
    PORT=8080

WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY decide.py engine.py server.py ./

# The unit tests, against the pinned gliner2 this image ships: plain-Python CI
# skips the one that compiles real GLiNER schemas. The final stage copies the
# marker, so an image cannot be built from code whose tests fail. No model is
# downloaded; only the schema code runs.
FROM base AS test
COPY tests ./tests
RUN python -m unittest discover -s tests && touch /app/.tests-passed

FROM base
COPY --from=test /app/.tests-passed ./

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin decision \
    && mkdir -p /models \
    && chown decision /models
USER decision
VOLUME ["/models"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15m --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4)"]

ENTRYPOINT ["python", "server.py"]
