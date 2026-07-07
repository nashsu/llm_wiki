"""PDF document parser using PyMuPDF."""

import logging
from pathlib import Path

import fitz

from app.parsers.base import DocumentParser, ExtractedImage, ParseResult
from app.parsers.registry import register_parser

logger = logging.getLogger(__name__)


@register_parser()
class PDFParser(DocumentParser):
    """Parser for PDF documents using PyMuPDF (fitz)."""

    @property
    def supported_extensions(self) -> list[str]:
        return [".pdf"]

    @property
    def supports_images(self) -> bool:
        return True

    def parse(self, file_path: str) -> ParseResult:
        path = Path(file_path)
        try:
            doc = fitz.open(str(path))
        except Exception as exc:
            logger.error("Failed to open PDF %s: %s", path, exc)
            return ParseResult(
                text="",
                images=[],
                metadata={
                    "source": str(path),
                    "extension": path.suffix,
                    "parser": self.name,
                },
                success=False,
                error=f"Failed to open PDF: {exc}",
            )

        try:
            text_parts: list[str] = []
            images: list[ExtractedImage] = []

            for page_num in range(len(doc)):
                page = doc[page_num]

                # Extract text
                page_text = page.get_text()
                if page_text.strip():
                    text_parts.append(f"--- Page {page_num + 1} ---\n{page_text}")

                # Extract embedded images
                for img_index, img_info in enumerate(page.get_images(full=True)):
                    xref = img_info[0]
                    base_image = doc.extract_image(xref)
                    img_bytes = base_image["image"]
                    img_ext = base_image["ext"]
                    width = base_image.get("width", 0)
                    height = base_image.get("height", 0)

                    # Map extension to MIME type
                    mime_map = {
                        "png": "image/png",
                        "jpeg": "image/jpeg",
                        "jpg": "image/jpeg",
                        "gif": "image/gif",
                        "bmp": "image/bmp",
                        "tiff": "image/tiff",
                        "tif": "image/tiff",
                        "webp": "image/webp",
                        "jp2": "image/jp2",
                        "jpx": "image/jpx",
                    }
                    mime_type = mime_map.get(img_ext, f"image/{img_ext}")

                    images.append(
                        ExtractedImage(
                            filename=f"page{page_num + 1}_img{img_index}.{img_ext}",
                            data=img_bytes,
                            mime_type=mime_type,
                            width=width,
                            height=height,
                        )
                    )

            # Build metadata
            fitz_meta = doc.metadata or {}
            doc_metadata: dict = {
                "source": str(path),
                "extension": path.suffix,
                "parser": self.name,
                "page_count": len(doc),
            }
            if fitz_meta.get("title"):
                doc_metadata["title"] = fitz_meta["title"]
            if fitz_meta.get("author"):
                doc_metadata["author"] = fitz_meta["author"]

            text = "\n\n".join(text_parts)

            return ParseResult(
                text=text,
                images=images,
                metadata=doc_metadata,
            )
        except Exception as exc:
            logger.error("Error parsing PDF %s: %s", path, exc)
            return ParseResult(
                text="",
                images=[],
                metadata={
                    "source": str(path),
                    "extension": path.suffix,
                    "parser": self.name,
                },
                success=False,
                error=f"Error parsing PDF: {exc}",
            )
        finally:
            doc.close()
