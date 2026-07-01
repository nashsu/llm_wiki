import { templates } from "@/lib/templates"
import { cn } from "@/lib/utils"
import { useTranslation } from "react-i18next"

interface TemplatePickerProps {
  selected: string
  onSelect: (id: string) => void
}

export function TemplatePicker({ selected, onSelect }: TemplatePickerProps) {
  const { t } = useTranslation()

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {templates.map((template) => {
        const name = t(`templates.${template.id}.name`, { defaultValue: template.name })
        const description = t(`templates.${template.id}.description`, {
          defaultValue: template.description,
        })

        return (
          <button
            key={template.id}
            type="button"
            onClick={() => onSelect(template.id)}
            className={cn(
              "flex flex-col gap-1 rounded-md border p-3 text-left transition-colors hover:bg-accent",
              selected === template.id
                ? "border-primary bg-accent ring-1 ring-primary"
                : "border-border bg-background",
            )}
          >
            <span className="text-xl leading-none">{template.icon}</span>
            <span className="text-sm font-medium leading-tight">{name}</span>
            <span className="text-xs text-muted-foreground leading-tight">{description}</span>
          </button>
        )
      })}
    </div>
  )
}
