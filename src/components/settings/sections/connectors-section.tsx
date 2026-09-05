/**
 * Settings → Connectors: configure sources that are pulled into the project
 * automatically (local folder, Google Drive, …). The form is generated from
 * the descriptors the backend publishes, so adding a connector kind in Rust
 * needs no UI change here.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Check,
  Folder,
  Link2,
  Link2Off,
  Loader2,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  Unplug,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { backend } from "@/lib/backend"
import { useAppDialog } from "@/stores/app-dialog-store"
import { useWikiStore } from "@/stores/wiki-store"
import {
  connectorDelete,
  connectorDescriptors,
  connectorList,
  connectorOAuthDisconnect,
  connectorOAuthStart,
  connectorReset,
  connectorSave,
  connectorSync,
  connectorTest,
  oauthRedirectUri,
  onConnectorOAuth,
  onConnectorSync,
  type ConnectorDescriptor,
  type ConnectorField,
  type ConnectorInstance,
  type ConnectorSaveInput,
  type ConnectorSyncEvent,
} from "@/commands/connectors"

interface Progress {
  phase: ConnectorSyncEvent["phase"]
  done?: number
  total?: number
  error?: string
}

interface FormState {
  id?: string
  kind: string
  name: string
  enabled: boolean
  intervalMinutes: number
  maxFileSizeMb: number
  config: Record<string, unknown>
  secrets: Record<string, string>
}

function emptyForm(descriptor: ConnectorDescriptor): FormState {
  const config: Record<string, unknown> = {}
  for (const field of descriptor.fields) {
    if (field.kind !== "secret" && field.default !== undefined && field.default !== null) {
      config[field.key] = field.default
    }
  }
  return {
    kind: descriptor.kind,
    name: descriptor.label,
    enabled: true,
    intervalMinutes: 60,
    maxFileSizeMb: 0,
    config,
    secrets: {},
  }
}

function formFromInstance(instance: ConnectorInstance): FormState {
  return {
    id: instance.id,
    kind: instance.kind,
    name: instance.name,
    enabled: instance.enabled,
    intervalMinutes: instance.intervalMinutes,
    maxFileSizeMb: instance.maxFileSizeMb,
    config: { ...instance.config },
    secrets: {},
  }
}

export function ConnectorsSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const appDialog = useAppDialog()
  const [descriptors, setDescriptors] = useState<ConnectorDescriptor[]>([])
  const [instances, setInstances] = useState<ConnectorInstance[]>([])
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, string>>({})

  const descriptorByKind = useMemo(
    () => new Map(descriptors.map((d) => [d.kind, d])),
    [descriptors],
  )

  const refresh = useCallback(async () => {
    if (!project) return
    try {
      setInstances(await connectorList(project.id, project.path))
    } catch (err) {
      console.error("[connectors] list failed:", err)
    }
  }, [project])

  useEffect(() => {
    void connectorDescriptors().then(setDescriptors).catch((err) => {
      console.error("[connectors] descriptors failed:", err)
    })
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!project) return
    let unlistenSync: (() => void) | null = null
    let unlistenOAuth: (() => void) | null = null
    void onConnectorSync((event) => {
      if (event.projectId !== project.id) return
      setProgress((prev) => ({
        ...prev,
        [event.instanceId]: {
          phase: event.phase,
          done: event.done,
          total: event.total,
          error: event.error ?? event.report?.summary.errors[0],
        },
      }))
      if (event.phase === "finished" || event.phase === "failed") {
        void refresh()
      }
    }).then((fn) => {
      unlistenSync = fn
    })
    void onConnectorOAuth(() => {
      void refresh()
    }).then((fn) => {
      unlistenOAuth = fn
    })
    return () => {
      unlistenSync?.()
      unlistenOAuth?.()
    }
  }, [project, refresh])

  const setMessage = (id: string, text: string) =>
    setMessages((prev) => ({ ...prev, [id]: text }))

  const withBusy = async (id: string, label: string, run: () => Promise<void>) => {
    setBusy((prev) => ({ ...prev, [id]: label }))
    try {
      await run()
    } finally {
      setBusy((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
  }

  const handleSync = (instance: ConnectorInstance) => {
    if (!project) return
    void withBusy(instance.id, "sync", async () => {
      try {
        await connectorSync(project.id, project.path, instance.id)
        setMessage(instance.id, "")
      } catch (err) {
        setMessage(instance.id, String(err))
      }
    })
  }

  const handleTest = (instance: ConnectorInstance) => {
    if (!project) return
    void withBusy(instance.id, "test", async () => {
      try {
        setMessage(instance.id, await connectorTest(project.path, instance.id))
      } catch (err) {
        setMessage(instance.id, String(err))
      }
    })
  }

  const handleConnect = (instance: ConnectorInstance) => {
    if (!project) return
    void withBusy(instance.id, "connect", async () => {
      try {
        const url = await connectorOAuthStart(project.path, instance.id, oauthRedirectUri())
        await backend.openUrl(url)
        setMessage(
          instance.id,
          t("settings.sections.connectors.completeInBrowser", {
            defaultValue: "Finish signing in in the browser window, then come back here.",
          }),
        )
      } catch (err) {
        setMessage(instance.id, String(err))
      }
    })
  }

  const handleDisconnect = (instance: ConnectorInstance) => {
    void withBusy(instance.id, "disconnect", async () => {
      try {
        await connectorOAuthDisconnect(instance.id)
        await refresh()
      } catch (err) {
        setMessage(instance.id, String(err))
      }
    })
  }

  const handleDelete = async (instance: ConnectorInstance) => {
    if (!project) return
    const purge = await appDialog.confirm({
      title: t("settings.sections.connectors.deleteTitle", { defaultValue: "Remove connector" }),
      message: t("settings.sections.connectors.deleteMessage", {
        defaultValue:
          "Remove \"{{name}}\"? Choose whether the files it synced into {{folder}} should be deleted too.",
        name: instance.name,
        folder: instance.folder,
      }),
      confirmLabel: t("settings.sections.connectors.deleteWithFiles", {
        defaultValue: "Remove and delete files",
      }),
      cancelLabel: t("settings.sections.connectors.deleteKeepFiles", {
        defaultValue: "Remove, keep files",
      }),
    })
    try {
      await connectorDelete(project.path, instance.id, purge)
      await refresh()
    } catch (err) {
      setMessage(instance.id, String(err))
    }
  }

  const handleReset = async (instance: ConnectorInstance) => {
    if (!project) return
    try {
      await connectorReset(project.path, instance.id)
      setMessage(
        instance.id,
        t("settings.sections.connectors.resetDone", {
          defaultValue: "Sync state cleared; the next sync re-lists everything.",
        }),
      )
    } catch (err) {
      setMessage(instance.id, String(err))
    }
  }

  const handleSave = async () => {
    if (!project || !form) return
    setSaving(true)
    setFormError(null)
    try {
      const input: ConnectorSaveInput = {
        id: form.id,
        kind: form.kind,
        name: form.name,
        enabled: form.enabled,
        intervalMinutes: Math.max(0, Math.floor(form.intervalMinutes)),
        maxFileSizeMb: Math.max(0, Math.floor(form.maxFileSizeMb)),
        config: form.config,
        secrets: form.secrets,
      }
      await connectorSave(project.id, project.path, input)
      setForm(null)
      await refresh()
    } catch (err) {
      setFormError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const pickPath = async (key: string) => {
    const selected = await backend.dialog.open({
      directory: true,
      multiple: false,
      title: t("settings.sections.connectors.pickFolder", { defaultValue: "Choose a folder" }),
    })
    if (selected && typeof selected === "string" && form) {
      setForm({ ...form, config: { ...form.config, [key]: selected } })
    }
  }

  if (!project) {
    return (
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">{t("settings.sections.connectors.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("settings.sections.connectors.noProject", {
            defaultValue: "Open a project to configure connectors.",
          })}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.connectors.title", { defaultValue: "Connectors" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.connectors.description", {
            defaultValue:
              "Pull documents from other systems into this project. Synced files land in raw/sources/@<name>/ and are ingested like any other source; deletions on the remote side remove the mirrored file and clean up its wiki pages.",
          })}
        </p>
      </div>

      <div className="space-y-3">
        {instances.length === 0 && !form && (
          <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            {t("settings.sections.connectors.empty", { defaultValue: "No connectors yet." })}
          </div>
        )}
        {instances.map((instance) => (
          <ConnectorCard
            key={instance.id}
            instance={instance}
            descriptor={descriptorByKind.get(instance.kind)}
            progress={progress[instance.id]}
            message={messages[instance.id]}
            busy={busy[instance.id]}
            onSync={() => handleSync(instance)}
            onTest={() => handleTest(instance)}
            onConnect={() => handleConnect(instance)}
            onDisconnect={() => handleDisconnect(instance)}
            onEdit={() => {
              setFormError(null)
              setForm(formFromInstance(instance))
            }}
            onDelete={() => void handleDelete(instance)}
            onReset={() => void handleReset(instance)}
          />
        ))}
      </div>

      {form ? (
        <ConnectorForm
          form={form}
          descriptor={descriptorByKind.get(form.kind)}
          descriptors={descriptors}
          editing={Boolean(form.id)}
          saving={saving}
          error={formError}
          storedSecrets={instances.find((i) => i.id === form.id)?.auth.hasClientSecret ?? false}
          onChange={setForm}
          onPickPath={pickPath}
          onSave={() => void handleSave()}
          onCancel={() => setForm(null)}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {descriptors.map((descriptor) => (
            <Button
              key={descriptor.kind}
              variant="outline"
              size="sm"
              onClick={() => {
                setFormError(null)
                setForm(emptyForm(descriptor))
              }}
            >
              <Plus data-icon="inline-start" />
              {descriptor.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

function ConnectorCard({
  instance,
  descriptor,
  progress,
  message,
  busy,
  onSync,
  onTest,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
  onReset,
}: {
  instance: ConnectorInstance
  descriptor?: ConnectorDescriptor
  progress?: Progress
  message?: string
  busy?: string
  onSync: () => void
  onTest: () => void
  onConnect: () => void
  onDisconnect: () => void
  onEdit: () => void
  onDelete: () => void
  onReset: () => void
}) {
  const { t } = useTranslation()
  const oauth = descriptor?.auth.type === "oAuth2"
  const running =
    instance.running || (progress && progress.phase !== "finished" && progress.phase !== "failed")
  const last = instance.lastSync

  let statusLine: string
  if (running) {
    statusLine =
      progress?.phase === "progress" && progress.total
        ? t("settings.sections.connectors.syncingProgress", {
            defaultValue: "Syncing… {{done}} / {{total}}",
            done: progress.done ?? 0,
            total: progress.total,
          })
        : t("settings.sections.connectors.syncing", { defaultValue: "Syncing…" })
  } else if (last) {
    statusLine = t("settings.sections.connectors.lastSync", {
      defaultValue: "Last sync {{time}}: +{{added}} ~{{updated}} −{{deleted}}, {{unchanged}} unchanged, {{skipped}} skipped",
      time: new Date(last.finishedAt).toLocaleString(),
      added: last.added,
      updated: last.updated,
      deleted: last.deleted,
      unchanged: last.unchanged,
      skipped: last.skipped,
    })
  } else {
    statusLine = t("settings.sections.connectors.neverSynced", { defaultValue: "Never synced" })
  }
  const lastError = progress?.error ?? (last && !last.ok ? last.errors[0] : undefined)

  return (
    <div className="rounded-md border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Plug className="h-4 w-4 shrink-0 opacity-60" />
            <span className="font-medium">{instance.name}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {descriptor?.label ?? instance.kind}
            </span>
            {!instance.enabled && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                {t("settings.sections.connectors.disabled", { defaultValue: "disabled" })}
              </span>
            )}
            {oauth && (
              <span
                className={
                  instance.auth.connected
                    ? "rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200"
                    : "rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                }
              >
                {instance.auth.connected
                  ? t("settings.sections.connectors.connected", { defaultValue: "connected" })
                  : t("settings.sections.connectors.notConnected", { defaultValue: "not connected" })}
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            <code>{instance.folder}</code>
            {" · "}
            {instance.intervalMinutes > 0
              ? t("settings.sections.connectors.everyMinutes", {
                  defaultValue: "every {{minutes}} min",
                  minutes: instance.intervalMinutes,
                })
              : t("settings.sections.connectors.manualOnly", { defaultValue: "manual only" })}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {running && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
            {statusLine}
          </div>
          {lastError && <div className="mt-1 text-xs text-destructive">{lastError}</div>}
          {message && <div className="mt-1 text-xs">{message}</div>}
        </div>
        <div className="flex flex-wrap gap-1">
          {oauth &&
            (instance.auth.connected ? (
              <Button variant="ghost" size="sm" onClick={onDisconnect} disabled={Boolean(busy)}>
                <Link2Off data-icon="inline-start" />
                {t("settings.sections.connectors.disconnect", { defaultValue: "Disconnect" })}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={onConnect} disabled={Boolean(busy)}>
                <Link2 data-icon="inline-start" />
                {t("settings.sections.connectors.connect", { defaultValue: "Connect" })}
              </Button>
            ))}
          <Button variant="outline" size="sm" onClick={onTest} disabled={Boolean(busy)}>
            {busy === "test" ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Check data-icon="inline-start" />}
            {t("settings.sections.connectors.test", { defaultValue: "Test" })}
          </Button>
          <Button variant="default" size="sm" onClick={onSync} disabled={Boolean(busy) || Boolean(running)}>
            <RefreshCw data-icon="inline-start" className={running ? "animate-spin" : undefined} />
            {t("settings.sections.connectors.syncNow", { defaultValue: "Sync now" })}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onEdit} title={t("settings.sections.connectors.edit", { defaultValue: "Edit" })}>
            <Pencil />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onReset} title={t("settings.sections.connectors.reset", { defaultValue: "Clear sync state" })}>
            <Unplug />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onDelete} title={t("settings.sections.connectors.delete", { defaultValue: "Remove" })}>
            <Trash2 />
          </Button>
        </div>
      </div>
    </div>
  )
}

function ConnectorForm({
  form,
  descriptor,
  descriptors,
  editing,
  saving,
  error,
  storedSecrets,
  onChange,
  onPickPath,
  onSave,
  onCancel,
}: {
  form: FormState
  descriptor?: ConnectorDescriptor
  descriptors: ConnectorDescriptor[]
  editing: boolean
  saving: boolean
  error: string | null
  storedSecrets: boolean
  onChange: (form: FormState) => void
  onPickPath: (key: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const oauth = descriptor?.auth.type === "oAuth2"

  const setConfig = (key: string, value: unknown) =>
    onChange({ ...form, config: { ...form.config, [key]: value } })

  const renderField = (field: ConnectorField) => {
    const id = `connector-field-${field.key}`
    const value = form.config[field.key]
    switch (field.kind) {
      case "boolean":
        return (
          <label key={field.key} className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={Boolean(value ?? field.default ?? false)}
              onChange={(e) => setConfig(field.key, e.target.checked)}
            />
            <span className="text-sm">{field.label}</span>
            {field.help && <span className="text-xs text-muted-foreground">— {field.help}</span>}
          </label>
        )
      case "secret":
        return (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={id}>
              {field.label}
              {field.required && !storedSecrets && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <Input
              id={id}
              type="password"
              autoComplete="off"
              value={form.secrets[field.key] ?? ""}
              placeholder={
                storedSecrets
                  ? t("settings.sections.connectors.secretStored", { defaultValue: "(stored — leave blank to keep)" })
                  : field.placeholder ?? ""
              }
              onChange={(e) => onChange({ ...form, secrets: { ...form.secrets, [field.key]: e.target.value } })}
            />
            {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
          </div>
        )
      case "path":
        return (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={id}>
              {field.label}
              {field.required && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <div className="flex gap-2">
              <Input
                id={id}
                className="flex-1"
                value={typeof value === "string" ? value : ""}
                placeholder={field.placeholder ?? ""}
                onChange={(e) => setConfig(field.key, e.target.value)}
              />
              <Button type="button" variant="outline" onClick={() => onPickPath(field.key)}>
                <Folder className="h-4 w-4" />
              </Button>
            </div>
            {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
          </div>
        )
      case "number":
        return (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={id}>{field.label}</Label>
            <Input
              id={id}
              type="number"
              value={typeof value === "number" ? value : ""}
              placeholder={field.placeholder ?? ""}
              onChange={(e) => setConfig(field.key, e.target.value === "" ? null : Number(e.target.value))}
            />
            {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
          </div>
        )
      default:
        return (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={id}>
              {field.label}
              {field.required && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <Input
              id={id}
              value={typeof value === "string" ? value : ""}
              placeholder={field.placeholder ?? ""}
              onChange={(e) => setConfig(field.key, e.target.value)}
            />
            {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
          </div>
        )
    }
  }

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">
          {editing
            ? t("settings.sections.connectors.editTitle", { defaultValue: "Edit connector" })
            : t("settings.sections.connectors.addTitle", { defaultValue: "Add connector" })}
        </h3>
        {!editing && descriptors.length > 1 && (
          <select
            className="rounded-md border bg-background px-2 py-1 text-sm"
            value={form.kind}
            onChange={(e) => {
              const next = descriptors.find((d) => d.kind === e.target.value)
              if (next) onChange(emptyForm(next))
            }}
          >
            {descriptors.map((d) => (
              <option key={d.kind} value={d.kind}>
                {d.label}
              </option>
            ))}
          </select>
        )}
      </div>
      {descriptor && <p className="text-xs text-muted-foreground">{descriptor.description}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="connector-name">
            {t("settings.sections.connectors.name", { defaultValue: "Name" })}
            <span className="ml-1 text-destructive">*</span>
          </Label>
          <Input
            id="connector-name"
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.connectors.nameHelp", {
              defaultValue: "Files are mirrored into raw/sources/@<name>/",
            })}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="connector-interval">
            {t("settings.sections.connectors.interval", { defaultValue: "Sync every (minutes, 0 = manual)" })}
          </Label>
          <Input
            id="connector-interval"
            type="number"
            min={0}
            value={form.intervalMinutes}
            onChange={(e) => onChange({ ...form, intervalMinutes: Number(e.target.value) || 0 })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="connector-max-size">
            {t("settings.sections.connectors.maxSize", { defaultValue: "Max file size (MB, 0 = default 100)" })}
          </Label>
          <Input
            id="connector-max-size"
            type="number"
            min={0}
            value={form.maxFileSizeMb}
            onChange={(e) => onChange({ ...form, maxFileSizeMb: Number(e.target.value) || 0 })}
          />
        </div>
        <label className="flex items-center gap-2 self-end">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={form.enabled}
            onChange={(e) => onChange({ ...form, enabled: e.target.checked })}
          />
          <span className="text-sm">{t("settings.sections.connectors.enabled", { defaultValue: "Enabled" })}</span>
        </label>
      </div>

      {descriptor && <div className="space-y-3">{descriptor.fields.map(renderField)}</div>}

      {oauth && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          {t("settings.sections.connectors.oauthHint", {
            defaultValue:
              "Register this redirect URI with your OAuth client, save, then press Connect:",
          })}{" "}
          <code className="break-all">{oauthRedirectUri()}</code>
        </div>
      )}

      {error && <div className="text-sm text-destructive">{error}</div>}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          {t("common.cancel")}
        </Button>
        <Button onClick={onSave} disabled={saving || !form.name.trim()}>
          {saving && <Loader2 data-icon="inline-start" className="animate-spin" />}
          {t("settings.sections.connectors.save", { defaultValue: "Save" })}
        </Button>
      </div>
    </div>
  )
}
