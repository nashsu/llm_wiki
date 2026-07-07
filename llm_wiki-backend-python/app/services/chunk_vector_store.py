"""Chunk-level vector store using LanceDB.

Each chunk in a wiki page gets its own embedding vector, enabling
fine-grained semantic search within pages.

Database location: ``{project_path}/.llm-wiki/vectors/``
Table name: ``chunks``

Schema
------
* ``chunk_id`` (str) – primary key, ``"{page_id}::{chunk_index}"``
* ``page_id`` (str) – wiki page identifier
* ``chunk_index`` (int) – zero-based index within the page
* ``chunk_text`` (str) – the raw text of this chunk
* ``heading_path`` (str) – section breadcrumb, e.g. ``"Introduction > Methods"``
* ``vector`` (list[float]) – the embedding vector
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import lancedb
from lancedb.table import Table


class ChunkVectorStore:
    """Chunk-level vector store backed by LanceDB.

    Usage::

        store = ChunkVectorStore("/path/to/project")
        store.upsert_chunks("my-page", [
            {
                "chunk_index": 0,
                "chunk_text": "Hello world",
                "heading_path": "",
                "embedding": [0.1, 0.2, ...],
            },
        ])
        results = store.search_chunks([0.1, 0.2, ...], top_k=30)
    """

    def __init__(self, project_path: str) -> None:
        """Open (or create) a LanceDB database at *project_path*.

        Parameters
        ----------
        project_path:
            Filesystem path to the wiki project root.
        """
        db_path = Path(project_path) / ".llm-wiki" / "vectors"
        self._db = lancedb.connect(str(db_path))
        self._table: Table | None = None

    # ------------------------------------------------------------------
    # Table lifecycle
    # ------------------------------------------------------------------

    def _ensure_table(self, dimension: int = 1536) -> None:
        """Open the ``chunks`` table, creating it if necessary.

        Parameters
        ----------
        dimension:
            Number of dimensions for the embedding vectors (default 1536
            — the standard ``text-embedding-3-small`` size).
        """
        if self._table is not None:
            return
        try:
            self._table = self._db.open_table("chunks")
        except Exception:
            # Create with a placeholder row, then remove it
            data = [
                {
                    "chunk_id": "__init__",
                    "page_id": "",
                    "chunk_index": 0,
                    "chunk_text": "",
                    "heading_path": "",
                    "vector": [0.0] * dimension,
                }
            ]
            self._table = self._db.create_table("chunks", data, mode="overwrite")
            self._table.delete('chunk_id = "__init__"')

    @property
    def table(self) -> Table:
        """Return the underlying LanceDB table, ensuring it exists."""
        if self._table is None:
            self._ensure_table()
        # After _ensure_table, _table is guaranteed to be non-None
        assert self._table is not None
        return self._table

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    def upsert_chunks(self, page_id: str, chunks: list[dict]) -> None:
        """Replace all chunks for *page_id*, then insert new ones.

        Parameters
        ----------
        page_id:
            Wiki page identifier.
        chunks:
            List of dicts with keys ``chunk_index``, ``chunk_text``,
            ``heading_path``, and ``embedding``.
        """
        dim = len(chunks[0]["embedding"]) if chunks else 1536
        tbl = self.table  # ensures table exists

        # Delete existing chunks for this page
        tbl.delete(f'page_id = "{page_id}"')

        # Insert new chunks
        data: list[dict[str, Any]] = []
        for c in chunks:
            chunk_id = f"{page_id}::{c['chunk_index']}"
            data.append(
                {
                    "chunk_id": chunk_id,
                    "page_id": page_id,
                    "chunk_index": c["chunk_index"],
                    "chunk_text": c["chunk_text"],
                    "heading_path": c["heading_path"],
                    "vector": c["embedding"],
                }
            )

        if data:
            tbl.add(data)

    def search_chunks(
        self,
        query_vector: list[float],
        top_k: int = 30,
    ) -> list[dict[str, Any]]:
        """Run ANN search for the closest chunks to *query_vector*.

        Parameters
        ----------
        query_vector:
            The query embedding.
        top_k:
            How many neighbours to return.

        Returns
        -------
        list[dict]:
            Each entry contains all schema columns plus LanceDB's
            ``_distance`` score (cosine distance — lower is closer).
        """
        self._ensure_table(len(query_vector))
        return self.table.search(query_vector).limit(top_k).to_list()

    def delete_page(self, page_id: str) -> None:
        """Delete all chunks belonging to *page_id*.

        Silently no-ops if the table does not exist.
        """
        try:
            self.table.delete(f'page_id = "{page_id}"')
        except Exception:
            pass

    def count(self) -> int:
        """Return the total number of chunk rows."""
        try:
            return self.table.count_rows()
        except Exception:
            return 0

    def clear(self) -> None:
        """Drop and recreate the chunks table (removes all data)."""
        try:
            self._db.drop_table("chunks")
        except Exception:
            pass
        self._table = None

    def optimize(self) -> None:
        """Compact the underlying LanceDB table."""
        try:
            self.table.compact()
        except Exception:
            pass
