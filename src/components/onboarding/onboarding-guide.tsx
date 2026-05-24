import { useState } from "react"
import { X, ChevronRight, ChevronLeft, FolderOpen, FileText, GitBranch, Search, MessageSquare, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTranslation } from "react-i18next"

interface OnboardingGuideProps {
  open: boolean
  onClose: () => void
}

const steps = [
  {
    key: "welcome",
    icon: FolderOpen,
  },
  {
    key: "import",
    icon: FileText,
  },
  {
    key: "graph",
    icon: GitBranch,
  },
  {
    key: "search",
    icon: Search,
  },
  {
    key: "chat",
    icon: MessageSquare,
  },
]

export function OnboardingGuide({ open, onClose }: OnboardingGuideProps) {
  const { t } = useTranslation()
  const [currentStep, setCurrentStep] = useState(0)

  if (!open) return null

  const step = steps[currentStep]
  const Icon = step.icon
  const isLast = currentStep === steps.length - 1

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative w-full max-w-lg rounded-xl border bg-background p-6 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded p-1 text-muted-foreground hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-6 flex justify-center gap-2">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`h-2 rounded-full transition-all ${
                i === currentStep
                  ? "w-6 bg-primary"
                  : i < currentStep
                    ? "w-2 bg-primary/50"
                    : "w-2 bg-muted"
              }`}
            />
          ))}
        </div>

        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-4 rounded-full bg-primary/10 p-4">
            <Icon className="h-8 w-8 text-primary" />
          </div>
          <h3 className="mb-2 text-lg font-semibold">
            {t(`onboarding.${step.key}.title`)}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t(`onboarding.${step.key}.description`)}
          </p>
        </div>

        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCurrentStep(Math.max(0, currentStep - 1))}
            disabled={currentStep === 0}
          >
            <ChevronLeft className="mr-1 h-4 w-4" />
            {t("onboarding.previous")}
          </Button>

          {isLast ? (
            <Button size="sm" onClick={onClose}>
              <CheckCircle2 className="mr-1 h-4 w-4" />
              {t("onboarding.getStarted")}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => setCurrentStep(currentStep + 1)}
            >
              {t("onboarding.next")}
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          )}
        </div>

        <div className="mt-3 text-center">
          <button
            onClick={onClose}
            className="text-xs text-muted-foreground hover:underline"
          >
            {t("onboarding.skip")}
          </button>
        </div>
      </div>
    </div>
  )
}
