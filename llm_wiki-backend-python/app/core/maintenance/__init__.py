"""Maintenance utilities for Wiki projects.

Provides deduplication detection, WikiLink enrichment, and the automatic
maintenance agent with three-phase safety workflow.
"""

from app.core.maintenance.agent import MaintenanceAgent
from app.core.maintenance.dedup import DedupDetector
from app.core.maintenance.wikilinks import WikiLinkEnricher

__all__ = [
    "DedupDetector",
    "MaintenanceAgent",
    "WikiLinkEnricher",
]
