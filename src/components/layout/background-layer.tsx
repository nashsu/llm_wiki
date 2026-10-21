import { useBackgroundStore } from "@/stores/background-store"

/** Full-viewport background layer, drawn beneath the app content (negative
 *  z-index) and above the body's theme color (the canvas backdrop). Renders
 *  nothing when no background image is configured, so the default theme
 *  background is untouched. */
export function BackgroundLayer() {
  const imageUrl = useBackgroundStore((s) => s.imageUrl)
  const opacity = useBackgroundStore((s) => s.opacity)
  const brightness = useBackgroundStore((s) => s.brightness)

  if (!imageUrl) return null

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10"
      style={{
        backgroundImage: `url(${imageUrl})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        opacity,
        filter: `brightness(${brightness})`,
      }}
    />
  )
}
