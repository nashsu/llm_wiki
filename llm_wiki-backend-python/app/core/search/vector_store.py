"""LanceDB vector store wrapper.

Provides CRUD operations and ANN (approximate nearest neighbour) search
for document embeddings.
"""

from __future__ import annotations

import json
from typing import Any

import lancedb


class VectorStore:
    """Thin wrapper around a LanceDB table for document vector storage.

    The table has three columns:

    * ``id`` (str) – unique document identifier
    * ``vector`` (fixed-size list[float]) – the embedding
    * ``metadata`` (str) – JSON-encoded document metadata

    Usage::

        store = VectorStore("/tmp/lancedb")
        store.create_index(dimension=384)
        store.add_embeddings(
            ids=["doc1", "doc2"],
            vectors=[[0.1, 0.2, ...], [0.3, 0.4, ...]],
            metadata=[{"path": "wiki/doc1.md"}, {"path": "wiki/doc2.md"}],
        )
        results = store.search([0.1, 0.2, ...], top_k=5)
    """

    def __init__(self, db_path: str, table_name: str = "vectors") -> None:
        """Open (or create) a LanceDB database at *db_path*.

        Parameters
        ----------
        db_path:
            Filesystem path to the LanceDB database directory.
        table_name:
            Name of the table to operate on (default ``"vectors"``).
        """
        self._db = lancedb.connect(db_path)
        self._table_name = table_name
        self._table = None

    # ------------------------------------------------------------------
    # Index lifecycle
    # ------------------------------------------------------------------

    def create_index(self, dimension: int) -> None:
        """Create a new vector index table.

        If a table with the configured name already exists it will be
        **overwritten**.

        Parameters
        ----------
        dimension:
            Number of dimensions for the embedding vectors.
        """
        data = [
            {
                "id": "__placeholder__",
                "vector": [0.0] * dimension,
                "metadata": "{}",
            }
        ]
        self._table = self._db.create_table(self._table_name, data, mode="overwrite")
        # Remove the placeholder row
        self._table.delete('id = "__placeholder__"')

    def open_table(self) -> None:
        """Open an existing table (raises if it does not exist)."""
        self._table = self._db.open_table(self._table_name)

    @property
    def table(self):
        """Return the underlying LanceDB table, opening it if needed."""
        if self._table is None:
            self.open_table()
        return self._table

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    def add_embeddings(
        self,
        ids: list[str],
        vectors: list[list[float]],
        metadata: list[dict[str, Any]],
    ) -> None:
        """Batch-insert embeddings into the vector store.

        Parameters
        ----------
        ids:
            Unique document identifiers (one per vector).
        vectors:
            Embedding vectors.
        metadata:
            Per-document metadata dicts.  These are JSON-encoded
            internally.
        """
        data = [
            {
                "id": doc_id,
                "vector": vec,
                "metadata": json.dumps(meta, ensure_ascii=False),
            }
            for doc_id, vec, meta in zip(ids, vectors, metadata)
        ]
        self.table.add(data)

    def search(
        self,
        query_vector: list[float],
        top_k: int = 10,
    ) -> list[dict[str, Any]]:
        """Run ANN search for the closest vectors to *query_vector*.

        Parameters
        ----------
        query_vector:
            The query embedding.
        top_k:
            How many neighbours to return.

        Returns
        -------
        list[dict]:
            Each entry has ``id``, ``vector``, ``metadata`` (parsed from
            JSON), and LanceDB's ``_distance`` score.
        """
        raw = (
            self.table.search(query_vector)
            .limit(top_k)
            .to_list()
        )
        for row in raw:
            if isinstance(row.get("metadata"), str):
                row["metadata"] = json.loads(row["metadata"])
        return raw

    def delete(self, ids: list[str]) -> None:
        """Delete vectors matching the given *ids*.

        Parameters
        ----------
        ids:
            Document identifiers to remove.
        """
        if not ids:
            return
        quoted = ", ".join(f"'{i}'" for i in ids)
        self.table.delete(f"id IN ({quoted})")
