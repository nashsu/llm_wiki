"""API routes for LLM provider CRUD and assignment management (global SQLite)."""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from app.core.llm.factory import LLMFactory
from app.models.config import (
    ModelProvider,
    ProviderProtocol,
)
from app.services.config_service import (
    GlobalConfigService,
    mask_api_key,
)

logger = logging.getLogger("llm-wiki")

router = APIRouter(prefix="/providers", tags=["providers"])

_global_svc = GlobalConfigService()

# ── Helper ──────────────────────────────────────────────────────────


def _provider_to_response(provider_dict: dict) -> dict:
    """Convert snake_case provider dict to camelCase API response with masked key."""
    mp = ModelProvider(**provider_dict)
    data = mp.model_dump(by_alias=True, mode="json", exclude_none=True)
    if data.get("apiKey"):
        data["apiKey"] = mask_api_key(data["apiKey"])
    return data


def _to_snake(d: dict) -> dict:
    """Convert camelCase keys to snake_case for internal use."""
    mapping = {
        "apiBase": "api_base",
        "apiKey": "api_key",
        "defaultModel": "default_model",
        "customHeaders": "custom_headers",
        "maxContext": "max_context",
    }
    result = {}
    for k, v in d.items():
        sk = mapping.get(k, k)
        result[sk] = v
    return result


_FEATURES = ("chat", "ingest", "maintenance")


# ── CRUD ────────────────────────────────────────────────────────────


@router.post("")
async def create_provider(body: dict):
    """Create a new LLM provider and test its connection.

    Request body (``ModelProvider`` fields in camelCase):
        ``name``: Human-readable name (required).
        ``protocol``: ``"openai"`` | ``"anthropic"`` | ``"google"``.
        ``apiBase``: Optional base URL.
        ``apiKey``: API key (required).
        ``models``: List of supported model names.
        ``defaultModel``: Default model to use.
        ``customHeaders``: Optional dict of extra HTTP headers.
        ``maxContext``: Maximum context window size (default 128000).
        ``temperature``: Temperature (default 0.7).
    """
    name = body.get("name", "")
    api_key = body.get("apiKey", "")

    if not name:
        raise HTTPException(status_code=422, detail="Field 'name' is required")
    if not api_key:
        raise HTTPException(status_code=422, detail="Field 'apiKey' is required")

    now = datetime.now(timezone.utc)
    provider_data = {
        "id": body.get("id", name).lower().replace(" ", "-"),
        "name": name,
        "protocol": body.get("protocol", "openai"),
        "api_base": body.get("apiBase", ""),
        "api_key": api_key,
        "models": body.get("models", []),
        "default_model": body.get("defaultModel", ""),
        "custom_headers": body.get("customHeaders", {}),
        "max_context": body.get("maxContext", 128000),
        "temperature": body.get("temperature", 0.7),
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
    }

    # Check for duplicate ID
    existing = _global_svc.get_provider(provider_data["id"])
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Provider with id '{provider_data['id']}' already exists",
        )

    # Test connection before saving
    mp = ModelProvider(**provider_data)
    test_result = LLMFactory.test_connection(mp)
    if not test_result["success"]:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Connection test failed",
                "error": test_result["error"],
            },
        )

    saved = _global_svc.add_provider(provider_data)
    logger.info("Provider created: %s (%s)", saved["id"], saved["protocol"])
    return _provider_to_response(saved)


@router.get("")
async def list_providers():
    """List all providers with masked API keys."""
    providers = _global_svc.list_providers()
    return [_provider_to_response(p) for p in providers]


# ── Feature Assignment ──────────────────────────────────────────────


@router.get("/assignment")
async def get_assignment():
    """Get the current feature-to-provider assignments (global)."""
    return _global_svc.get_assignment()


@router.put("/assignment")
async def update_assignment(body: dict):
    """Update feature-to-provider assignments.

    Request body (camelCase):
        ``chat`` (dict | None): ``{providerId: str, model: str}``
        ``ingest`` (dict | None): ``{providerId: str, model: str}``
        ``maintenance`` (dict | None): ``{providerId: str, model: str}``
    """
    # Validate that referenced providers exist in global DB
    errors: list[str] = []
    for feature in _FEATURES:
        raw = body.get(feature)
        if raw is not None and isinstance(raw, dict):
            pid = raw.get("providerId", "")
            if pid and not _global_svc.get_provider(pid):
                errors.append(
                    f"Provider '{pid}' not found for feature '{feature}'"
                )

    if errors:
        raise HTTPException(
            status_code=422,
            detail={"message": "Invalid assignments", "errors": errors},
        )

    result = _global_svc.update_assignment(body)
    logger.info("Assignment updated")
    return result


@router.get("/features")
async def list_features():
    """List all supported features."""
    return {"features": list(_FEATURES)}


@router.get("/{provider_id}")
async def get_provider(provider_id: str):
    """Get a single provider with masked API key."""
    provider = _global_svc.get_provider(provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")
    return _provider_to_response(provider)


@router.put("/{provider_id}")
async def update_provider(provider_id: str, body: dict):
    """Update an existing provider configuration."""
    existing = _global_svc.get_provider(provider_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Provider not found")

    # Build update data from body (accept camelCase keys, convert to snake_case)
    updates = _to_snake(body)
    updates.pop("id", None)  # cannot change provider id

    # Handle fields that need type conversion from camelCase body
    if "models" in updates and isinstance(updates["models"], list):
        pass  # already list
    if "custom_headers" in updates and isinstance(updates["custom_headers"], dict):
        pass  # already dict
    if "protocol" in updates:
        # Validate protocol
        try:
            ProviderProtocol(updates["protocol"])
        except ValueError:
            raise HTTPException(
                status_code=422, detail=f"Invalid protocol: {updates['protocol']}"
            )

    merged = _global_svc.update_provider(provider_id, updates)
    if merged is None:
        raise HTTPException(status_code=404, detail="Provider not found")
    logger.info("Provider updated: %s", provider_id)
    return _provider_to_response(merged)


@router.delete("/{provider_id}")
async def delete_provider(provider_id: str):
    """Delete a provider and remove it from any feature assignments."""
    deleted = _global_svc.delete_provider(provider_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Provider not found")
    logger.info("Provider deleted: %s", provider_id)
    return {"status": "ok", "id": provider_id}


# ── Connection Test ─────────────────────────────────────────────────


@router.post("/{provider_id}/test")
async def test_provider_connection(provider_id: str):
    """Test connectivity for a specific provider."""
    provider = _global_svc.get_provider(provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")
    mp = ModelProvider(**provider)
    try:
        llm = LLMFactory.create(mp)
        import time

        start = time.time()
        llm.invoke("Hi")
        latency = int((time.time() - start) * 1000)
        return {
            "success": True,
            "model": mp.default_model,
            "latency_ms": latency,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
