# GitHub Copilot provider

The GitHub Copilot provider supports text generation for ingestion and the existing backend Agent. It uses independent device authorization and does not read another application's credential store. The project's GPL-3.0 license and notices remain unchanged.

## Compatibility and policy

This integration uses GitHub Copilot's internal device-flow/token-exchange and completion endpoints. These are not a documented public third-party API. Protocol details, model availability and account entitlement may change without notice. Check account and organizational policy before sending documents. Maintainers may reasonably choose not to support this integration.

The authorization client and compatibility headers match the Copilot protocol; this application does not claim to be an official GitHub client. Review the identity and permissions shown by GitHub before approving authorization.

## Sign in

In Settings > LLM Models, expand GitHub Copilot (device sign-in) and choose Sign in to GitHub Copilot. Open the displayed official verification URL in your own browser, enter the pairing value shown in the app, and review the authorization. The browser may be on another device. Do not share authorization values or credentials publicly.

After authorization, refresh the model catalog and select an available chat model. Models must explicitly advertise `/chat/completions` support in the authenticated catalog. Configure the Copilot preset for Chat and Ingest as desired; project overrides also use the catalog picker. A saved model name is not proof of current availability.

Credentials exist only in the native process's memory. Restarting the app or signing out requires another authorization. No bearer credentials or provider endpoint configuration are exposed through frontend IPC or saved in project Markdown/provider settings.

## Behavior and limits

Responses are buffered, not incrementally streamed. The existing stream callback interface receives a single completed text delta. Input must contain only system, user and assistant text messages. Images, native function-call messages and Responses-only models are unsupported. Backend queries retain the existing Agent's retrieval and tool orchestration; that orchestration is distinct from native model function calling.

Cancellation stops frontend delivery but does not guarantee cancellation of an already running native or remote request. Signing out invalidates concurrent results and pauses active Copilot ingestion. Device polling respects intervals, slow-down and expiration. Credential refresh is singleflight. The first buffered completion rejected with HTTP 401 may refresh and retry once; HTTP 403/429 and a second 401 are not replayed. HTTPS origins are restricted, redirects disabled, response sizes bounded, and errors do not include remote response bodies or credentials.

Empty assistant text is treated as an error, not a successful answer or clean lint result. If a catalog-confirmed model returns no assistant text for a task, try another eligible model rather than treating that response as evidence.

Document extraction, ingestion, retrieval and semantic-lint context are sent to the selected Copilot service after authorization. This is not an offline or local-model provider.

## Development checks

Run the existing frontend typecheck and mocked test suite, MCP tests, and the Rust tests filtered by `copilot`. The tests use clearly fabricated protocol fixtures and do not require live account authorization. Live account checks require explicit local device authorization and should use non-sensitive inputs.
