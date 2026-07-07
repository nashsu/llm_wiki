"""API router aggregation."""

from fastapi import APIRouter

from app.api.routes.chat import router as chat_router
from app.api.routes.config import router as config_router
from app.api.routes.files import router as files_router
from app.api.routes.graph import router as graph_router
from app.api.routes.ingest import router as ingest_router
from app.api.routes.lint import router as lint_router
from app.api.routes.maintenance import router as maintenance_router
from app.api.routes.projects import router as projects_router
from app.api.routes.providers import router as providers_router
from app.api.routes.research import router as research_router
from app.api.routes.review import router as review_router
from app.api.routes.sidecar import router as sidecar_router
from app.api.routes.vector import router as vector_router
from app.api.routes.version import router as version_router
from app.api.routes.watcher import router as watcher_router

api_router = APIRouter(prefix="/api")
api_router.include_router(chat_router)
api_router.include_router(config_router)
api_router.include_router(files_router)
api_router.include_router(graph_router)
api_router.include_router(ingest_router)
api_router.include_router(lint_router)
api_router.include_router(maintenance_router)
api_router.include_router(projects_router)
api_router.include_router(providers_router)
api_router.include_router(research_router)
api_router.include_router(review_router)
api_router.include_router(sidecar_router)
api_router.include_router(vector_router)
api_router.include_router(version_router)
api_router.include_router(watcher_router)


@api_router.get("/")
async def root():
    """API root endpoint."""
    return {"message": "LLM Wiki API", "version": "0.1.0"}
