import type { MessageImage } from "@/stores/chat-store"

/** Image MIME types every vision-capable provider on our wire accepts. */
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const

/** Per-image size cap. base64 inflates bytes ~33% and chat history is
 *  persisted to JSON, so we keep this conservative. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // 5 MB
export const MAX_IMAGE_MB = 5

/** Max images attachable to a single message. */
export const MAX_IMAGES_PER_MESSAGE = 5

export function isAcceptedImageType(type: string): boolean {
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type)
}

/**
 * Read a File/Blob into a {@link MessageImage} — raw base64 (no
 * `data:` prefix; the provider translators add their own framing).
 * FileReader's `readAsDataURL` gives us `data:<mime>;base64,<payload>`;
 * we strip the prefix and keep the payload + the file's mediaType.
 */
export function fileToMessageImage(file: File | Blob): Promise<MessageImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== "string") {
        reject(new Error("Unexpected FileReader result"))
        return
      }
      const comma = result.indexOf(",")
      const dataBase64 = comma >= 0 ? result.slice(comma + 1) : result
      resolve({ mediaType: file.type || "image/png", dataBase64 })
    }
    reader.readAsDataURL(file)
  })
}

/** Build the `data:` URL for rendering a stored image in an <img>. */
export function messageImageToDataUrl(img: MessageImage): string {
  return `data:${img.mediaType};base64,${img.dataBase64}`
}
