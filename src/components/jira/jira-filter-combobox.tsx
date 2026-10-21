import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
import type { JiraFilterOption } from "@/lib/jira-search"

/**
 * A filterable dropdown: typing `王` narrows the option list to `王锦 (12)`,
 * clicking or Enter commits the selection. The native `<select>` cannot do
 * this, and datalist's popup is unstyled/uncontrollable, so this small
 * combobox rolls its own popup with keyboard navigation.
 */

export interface JiraFilterComboboxProps {
  /** Dimension name shown on the closed trigger, e.g. 「经办人」. */
  dimension: string
  /** Current selection's value; `""` means "all". */
  value: string
  options: readonly JiraFilterOption[]
  /** Label for the "all" entry, e.g. 「全部」. */
  allLabel: string
  /** Placeholder inside the open popup's input. */
  searchPlaceholder: string
  onChange: (value: string) => void
}

function fold(value: string): string {
  return (value ?? "").normalize("NFKC").toLocaleLowerCase()
}

export function JiraFilterCombobox(props: JiraFilterComboboxProps) {
  const { dimension, value, options, allLabel, searchPlaceholder, onChange } = props
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState("")
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = options.find((option) => option.value === value)

  const visible = useMemo(() => {
    const needle = fold(input.trim())
    if (!needle) return options
    return options.filter((option) => fold(option.label).includes(needle))
  }, [options, input])

  // The "all" entry rides on top of the list; index 0 == all, i+1 == option i.
  const entryCount = visible.length + 1

  useEffect(() => {
    if (!open) return
    // Reopen resets the search and lands the highlight on the current choice.
    setInput("")
    const current = value ? visible.findIndex((o) => o.value === value) : -1
    setHighlight(current + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Close on outside pointer-down (mousedown, so a drag starting outside never
  // gets counted as a selection).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
  }, [open])

  function commit(index: number) {
    if (index <= 0) onChange("")
    else {
      const option = visible[index - 1]
      if (option) onChange(option.value)
    }
    setOpen(false)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setHighlight((previous) => (previous + 1) % entryCount)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setHighlight((previous) => (previous - 1 + entryCount) % entryCount)
    } else if (event.key === "Enter") {
      event.preventDefault()
      commit(highlight)
    } else if (event.key === "Escape") {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        title={selected ? `${dimension}: ${selected.label}` : dimension}
        className="flex h-8 max-w-[220px] items-center gap-1 rounded-md border border-input bg-background px-2 text-xs text-foreground hover:bg-accent"
      >
        <span className="whitespace-nowrap text-muted-foreground">{dimension}</span>
        <span className="truncate">
          {selected ? selected.label : <span className="text-muted-foreground">{allLabel}</span>}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-50 w-64 rounded-md border bg-background shadow-lg">
          <div className="border-b p-1.5">
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => {
                setInput(event.target.value)
                setHighlight(0)
              }}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              className="h-7 w-full rounded border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <ul className="max-h-60 overflow-y-auto p-1 text-xs">
            <li>
              <button
                type="button"
                className={`flex w-full items-center justify-between rounded px-2 py-1 text-left ${
                  highlight === 0 ? "bg-accent" : "hover:bg-accent/50"
                }`}
                onMouseEnter={() => setHighlight(0)}
                onClick={() => commit(0)}
              >
                <span className="text-muted-foreground">{allLabel}</span>
              </button>
            </li>
            {visible.map((option, index) => (
              <li key={option.value}>
                <button
                  type="button"
                  className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left ${
                    highlight === index + 1 ? "bg-accent" : "hover:bg-accent/50"
                  }`}
                  onMouseEnter={() => setHighlight(index + 1)}
                  onClick={() => commit(index + 1)}
                >
                  <span className="truncate">{option.label}</span>
                  <span className="shrink-0 text-muted-foreground">{option.count}</span>
                </button>
              </li>
            ))}
            {visible.length === 0 && (
              <li className="px-2 py-1.5 text-muted-foreground">—</li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
