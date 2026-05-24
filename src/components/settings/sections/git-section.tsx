import { useCallback, useEffect, useState } from "react"
import {
  GitBranch,
  GitCommitHorizontal,
  Download,
  Upload,
  Plus,
  RefreshCw,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  gitInit,
  gitStatus,
  gitCommit,
  gitPush,
  gitPull,
  gitLog,
  gitSetRemote,
  type GitStatus as GitStatusType,
  type CommitEntry,
} from "@/lib/git-sync"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useWikiStore } from "@/stores/wiki-store"

export function GitSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const projectPath = project?.path ?? ""

  const [status, setStatus] = useState<GitStatusType | null>(null)
  const [commits, setCommits] = useState<CommitEntry[]>([])
  const [remoteUrl, setRemoteUrl] = useState("")
  const [commitMessage, setCommitMessage] = useState("")
  const [autoCommit, setAutoCommit] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Load git status and recent commits
  const refresh = useCallback(async () => {
    if (!projectPath) return
    try {
      const [s, c] = await Promise.all([
        gitStatus(projectPath),
        gitLog(projectPath, 10),
      ])
      setStatus(s)
      setCommits(c)
    } catch (err) {
      console.warn("[git-section] refresh failed:", err)
    }
  }, [projectPath])

  useEffect(() => {
    refresh()
  }, [refresh])

  const clearFeedback = useCallback(() => {
    setError(null)
    setSuccess(null)
  }, [])

  const handleInit = useCallback(async () => {
    if (!projectPath) return
    setLoading("init")
    clearFeedback()
    try {
      const result = await gitInit(projectPath)
      setSuccess(result)
      await refresh()
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(null)
    }
  }, [projectPath, refresh, clearFeedback])

  const handleSetRemote = useCallback(async () => {
    if (!projectPath || !remoteUrl.trim()) return
    setLoading("remote")
    clearFeedback()
    try {
      await gitSetRemote(projectPath, remoteUrl.trim())
      setSuccess(
        t("settings.sections.git.remoteSet", { defaultValue: "Remote URL set" }),
      )
      await refresh()
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(null)
    }
  }, [projectPath, remoteUrl, refresh, clearFeedback, t])

  const handleCommit = useCallback(async () => {
    if (!projectPath) return
    const msg = commitMessage.trim() || "Manual commit"
    setLoading("commit")
    clearFeedback()
    try {
      const result = await gitCommit(projectPath, msg)
      setSuccess(result)
      setCommitMessage("")
      await refresh()
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(null)
    }
  }, [projectPath, commitMessage, refresh, clearFeedback])

  const handlePush = useCallback(async () => {
    if (!projectPath) return
    setLoading("push")
    clearFeedback()
    try {
      const result = await gitPush(projectPath)
      setSuccess(result)
      await refresh()
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(null)
    }
  }, [projectPath, refresh, clearFeedback])

  const handlePull = useCallback(async () => {
    if (!projectPath) return
    setLoading("pull")
    clearFeedback()
    try {
      const result = await gitPull(projectPath)
      setSuccess(result)
      await refresh()
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(null)
    }
  }, [projectPath, refresh, clearFeedback])

  const isRepo = status !== null && status.branch !== ""

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.git.title", { defaultValue: "Git Collaboration" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.git.description", {
            defaultValue:
              "Track wiki changes with git. Push to a remote repository for backup and collaboration across devices.",
          })}
        </p>
      </div>

      {!project && (
        <p className="text-sm text-muted-foreground">
          {t("settings.sections.git.noProject", {
            defaultValue: "Open a project first.",
          })}
        </p>
      )}

      {project && (
        <>
          {/* Init */}
          {!isRepo && (
            <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Plus className="h-4 w-4 text-muted-foreground" />
                {t("settings.sections.git.initRepo", {
                  defaultValue: "Initialize Repository",
                })}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("settings.sections.git.initHint", {
                  defaultValue:
                    "Initialize a git repository in the project directory. A .gitignore will be created automatically to exclude cache and temporary files.",
                })}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={handleInit}
                disabled={loading === "init"}
                className="gap-1.5"
              >
                {loading === "init" ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <GitBranch className="h-3.5 w-3.5" />
                )}
                {t("settings.sections.git.initButton", {
                  defaultValue: "Initialize Git Repo",
                })}
              </Button>
            </div>
          )}

          {/* Status */}
          {isRepo && (
            <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <GitBranch className="h-4 w-4 text-muted-foreground" />
                  {t("settings.sections.git.statusTitle", {
                    defaultValue: "Repository Status",
                  })}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={refresh}
                  className="gap-1 text-xs"
                >
                  <RefreshCw className="h-3 w-3" />
                  {t("settings.sections.git.refresh", {
                    defaultValue: "Refresh",
                  })}
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-3 rounded-md border border-border/40 bg-background/50 p-3 text-sm sm:grid-cols-4">
                <div className="space-y-0.5">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {t("settings.sections.git.branch", {
                      defaultValue: "Branch",
                    })}
                  </div>
                  <div className="font-mono text-xs">{status!.branch}</div>
                </div>
                <div className="space-y-0.5">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {t("settings.sections.git.staged", { defaultValue: "Staged" })}
                  </div>
                  <div className="font-mono text-xs">
                    {status!.staged > 0 ? (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {status!.staged}
                      </span>
                    ) : (
                      "0"
                    )}
                  </div>
                </div>
                <div className="space-y-0.5">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {t("settings.sections.git.modified", {
                      defaultValue: "Modified",
                    })}
                  </div>
                  <div className="font-mono text-xs">
                    {status!.modified > 0 ? (
                      <span className="text-amber-700 dark:text-amber-400">
                        {status!.modified}
                      </span>
                    ) : (
                      "0"
                    )}
                  </div>
                </div>
                <div className="space-y-0.5">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {t("settings.sections.git.untracked", {
                      defaultValue: "Untracked",
                    })}
                  </div>
                  <div className="font-mono text-xs">
                    {status!.untracked > 0 ? (
                      <span className="text-muted-foreground">
                        {status!.untracked}
                      </span>
                    ) : (
                      "0"
                    )}
                  </div>
                </div>
              </div>

              {!status!.hasRemote && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {t("settings.sections.git.noRemote", {
                    defaultValue:
                      "No remote configured. Set a remote URL below to enable push/pull.",
                  })}
                </p>
              )}
            </div>
          )}

          {/* Remote URL */}
          {isRepo && (
            <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
              <h3 className="text-sm font-semibold">
                {t("settings.sections.git.remoteTitle", {
                  defaultValue: "Remote Repository",
                })}
              </h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("settings.sections.git.remoteHint", {
                  defaultValue:
                    "Set the origin URL to a GitHub, GitLab, or any git-compatible remote. Push/pull will use this URL.",
                })}
              </p>
              <div className="flex gap-2">
                <Input
                  value={remoteUrl}
                  onChange={(e) => setRemoteUrl(e.target.value)}
                  placeholder="https://github.com/user/repo.git"
                  className="font-mono text-sm"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSetRemote}
                  disabled={loading === "remote" || !remoteUrl.trim()}
                >
                  {loading === "remote"
                    ? t("settings.sections.git.saving", {
                        defaultValue: "Saving...",
                      })
                    : t("settings.sections.git.setRemote", {
                        defaultValue: "Set",
                      })}
                </Button>
              </div>
            </div>
          )}

          {/* Commit / Push / Pull */}
          {isRepo && (
            <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
              <h3 className="text-sm font-semibold">
                {t("settings.sections.git.actionsTitle", {
                  defaultValue: "Actions",
                })}
              </h3>

              <div className="flex gap-2">
                <Input
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder={t("settings.sections.git.commitPlaceholder", {
                    defaultValue: "Commit message (optional)",
                  })}
                  className="text-sm"
                  autoComplete="off"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCommit}
                  disabled={loading === "commit"}
                  className="gap-1.5 shrink-0"
                >
                  <GitCommitHorizontal className="h-3.5 w-3.5" />
                  {t("settings.sections.git.commitButton", {
                    defaultValue: "Commit All",
                  })}
                </Button>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePush}
                  disabled={loading === "push" || !status?.hasRemote}
                  className="gap-1.5"
                >
                  <Upload className="h-3.5 w-3.5" />
                  {loading === "push"
                    ? t("settings.sections.git.pushing", {
                        defaultValue: "Pushing...",
                      })
                    : t("settings.sections.git.pushButton", {
                        defaultValue: "Push",
                      })}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePull}
                  disabled={loading === "pull" || !status?.hasRemote}
                  className="gap-1.5"
                >
                  <Download className="h-3.5 w-3.5" />
                  {loading === "pull"
                    ? t("settings.sections.git.pulling", {
                        defaultValue: "Pulling...",
                      })
                    : t("settings.sections.git.pullButton", {
                        defaultValue: "Pull",
                      })}
                </Button>
              </div>
            </div>
          )}

          {/* Auto-commit toggle */}
          {isRepo && (
            <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={autoCommit}
                  onChange={(e) => setAutoCommit(e.target.checked)}
                  className="mt-1 h-4 w-4"
                />
                <div className="space-y-1">
                  <div className="text-sm font-semibold">
                    {t("settings.sections.git.autoCommit", {
                      defaultValue: "Auto-commit on ingest",
                    })}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("settings.sections.git.autoCommitHint", {
                      defaultValue:
                        "Automatically commit changes after each file ingest. The commit message includes the ingested filename.",
                    })}
                  </p>
                </div>
              </label>
            </div>
          )}

          {/* Recent commits */}
          {isRepo && commits.length > 0 && (
            <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
              <h3 className="text-sm font-semibold">
                {t("settings.sections.git.recentCommits", {
                  defaultValue: "Recent Commits",
                })}
              </h3>
              <div className="space-y-1.5">
                {commits.map((c) => (
                  <div
                    key={c.hash}
                    className="flex items-start gap-2 rounded-md border border-border/40 bg-background/50 px-3 py-2 text-xs"
                  >
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {c.hash.slice(0, 7)}
                    </span>
                    <span className="flex-1 break-all">{c.message}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {c.date}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Feedback */}
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          {success && (
            <div className="rounded-md border border-emerald-500/50 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-400">
              {success}
            </div>
          )}
        </>
      )}
    </div>
  )
}
