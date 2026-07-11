export class StaleAutoLinkReviewError extends Error {
  constructor() {
    super("This page changed after Auto Link scanned it. Scan the page again.")
    this.name = "StaleAutoLinkReviewError"
  }
}

export async function hashAutoLinkContent(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
