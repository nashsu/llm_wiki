"""Ingestion pipeline package.

两步摄入管线：先分析源文件，再生成 Wiki 页面。
"""

from app.core.ingest.analyzer import IngestAnalyzer
from app.core.ingest.cache import IngestCache, content_hash, normalize_content
from app.core.ingest.generator import IngestGenerator
from app.core.ingest.pipeline import IngestPipeline
from app.core.ingest.queue import IngestQueue
from app.core.ingest.source_identity import get_source_identity
from app.core.ingest.worker import IngestWorker

__all__ = [
    "IngestAnalyzer",
    "IngestCache",
    "IngestGenerator",
    "IngestPipeline",
    "IngestQueue",
    "IngestWorker",
    "content_hash",
    "get_source_identity",
    "normalize_content",
]
