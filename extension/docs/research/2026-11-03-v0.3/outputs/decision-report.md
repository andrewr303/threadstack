# Threadkeeper 0.3: research decision report

Research ran on 2026-11-03 with the research-first-creator workflow in manual mode. Its automated gates (repo-hunt-plus, insane-research) are not installed here, so there is no `verified_claims.json` and no automated PASS. Three researchers built evidence ledgers, and a separate adversarial verifier per topic re-checked each high-risk claim against primary sources. Claims cited in the body below are either confirmed by that verifier or executable claims I ran myself. Everything else sits in the annexes.

- Sources: `sources/sources.jsonl` (107 entries)
- Claims: `artifacts/claim_ledger.jsonl` (93 claims: 41 independently confirmed, 1 refuted, 48 not re-checked, plus 3 executable)

## 1. The Edge "`<id>` is blocked" error

Edge blocks the extension's own static-ID pages when the running manifest marks them `use_dynamic_url`. It keeps running that manifest after a rebuild until the extension is reloaded. I reproduced both halves in Microsoft Edge 155.0.4283.62 (clm_X01). The 0.2 fix removed the flag but could not take effect without a reload, which is why the error came back. Version 0.3 stamps every build into `version_name`, reloads once per build when the running manifest is older than the code, and shows a Reload banner and a Diagnostics panel. `npm run test:edge` covers the scenario.

## 2. Requirement matrix

| Requirement | Evidence | Decision |
|---|---|---|
| Claude through AWS from a browser extension | Mantle endpoint `bedrock-mantle.{region}.api.aws/anthropic/v1/messages` takes a Bedrock key; SigV4 signing name `bedrock-mantle` (clm_B07, clm_B08). The official AWS-flavoured SDKs do not bundle for a browser (clm_X03) | Official `@anthropic-ai/sdk` client with the Mantle `baseURL`. IAM keys are signed by a custom `fetch` using aws4fetch (MIT), checked against the AWS SigV4 test vector (clm_X02) |
| Bedrock API keys | Short-term keys last at most 12 hours; long-term keys are for exploration (clm_B01). Bearer header on bedrock-runtime (clm_B02). Not accepted by Agents Runtime operations (clm_B03) | API key or IAM keys per region. Reranking falls back to IAM-only where keys are rejected |
| Bedrock embeddings | Titan Text v2 contract (clm_B11), InvokeModel route (clm_B12), Cohere Embed v4 contract (clm_B13) | Titan v2 (one text per call) and Cohere Embed v4 (batches of 96) through the shared AWS fetch |
| Voyage reranking | rerank-3 and rerank-3-lite are current; 2.5 is legacy (clm_C08, clm_C09). Contract and limits (clm_C10, clm_C13, clm_C14, clm_C15) | Reuse the `rerankModel` setting (rerank-3-lite default). Rerank only on explicit search or Ask, never per keystroke |
| Voyage embeddings | The voyage-4 series is current; nothing newer exists (clm_C01, clm_C02); limits (clm_C03, clm_C05) | Keep the existing model list and the per-model vector spaces |
| ChatGPT capture | Turn keys, streaming flags, thinking pseudo-message, URL forms, Projects and composer change (clm_A05 to clm_A10) | Stable message keys, skip streaming and thinking turns, optional project slug, real project labels |
| Claude capture | Virtual list keyed by `data-turn-key` (clm_A02); routes (clm_A03); sidebar titles and placeholders (clm_A04); the turn selector lacks the artifact guard (clm_A01 refuted, see annex) | Key messages by `data-turn-key`, exclude `#markdown-artifact`, take titles from the active sidebar row |
| Gemini capture | Custom elements, title selectors, `model-thoughts` (clm_A11) | Extra title selectors; strip reasoning |
| Grok on grok.com | Newest selector evidence is stale (clm_A12) | Keep the selectors; use `.response-content-markdown` as the content root |
| Grok on X ("Grok bot") | `x.com/i/grok?conversation=<id>`; the only open-source capture reads X's own `GrokConversationItemsByRestId` responses (clm_A13) | New `grok_x` provider. A MAIN-world script passively reads those responses without altering them |
| Copilot | Four live hosts, `copilot.com` canonical (clm_A14) | Add `copilot.com` and `www.copilot.com` |

## 3. Finalists and licences

| Repository @ commit | Grade | Licence | Use |
|---|---|---|---|
| Nagi-ovo/gemini-voyager @13f0fd2 | strong | GPL-3.0 | Selector strings and field names as facts only. No code copied |
| dlamarre-dev/AI-Gemini-Folders @b87c5cf | match | MIT | Host list and title strategies |
| pionxzh/chatgpt-exporter @6935bc1 | match | MIT | ChatGPT URL forms |
| InledGroup/open-ai-exporter @a11f5ff | match | none declared | Facts only. The missing licence blocks reuse |
| Drolese/Grok2Blogger @2d38607 | weak, stale | MIT (README only) | Field names for Grok on X, re-implemented |
| openai/codex @80a8710, ryoppippi/ccusage @8995f3b | adjacent | Apache-2.0, MIT | Codex rollout and Claude Code session formats |
| mhart/aws4fetch @f279a7e | dependency | MIT | SigV4 signing (stale since 2024-12, but small and dependency-free) |

Rejected alternatives:
- `@anthropic-ai/bedrock-sdk` and `@anthropic-ai/aws-sdk`: they import Node built-ins and fail to bundle for a browser.
- `@smithy/signature-v4`: actively maintained, but it needs a separate hash implementation and request glue in a browser.
- Private web APIs for capture: they would give full history, but they depend on undocumented endpoints and cookies. Threadkeeper stays DOM-first. Grok on X observes responses the page already requested; it never calls an endpoint itself.

## 4. Provenance map

| Requirement | Adopted idea | Evidence | Original implementation |
|---|---|---|---|
| Edge block | Build id in `version_name`, guarded self-reload | clm_X01 | `src/core/build-info.ts`, `src/core/diagnostics.ts`, `scripts/run-edge-smoke.mjs` |
| AWS auth | Bearer or SigV4 per credential type | clm_B02, clm_B07, clm_B08, clm_B10, clm_X02 | `src/core/aws.ts` |
| Claude backends | Official SDK client per backend | clm_B07, clm_X03 | `src/core/ai/backends.ts` |
| Bedrock embeddings and reranking | Titan v2, Cohere v4, Rerank API or InvokeModel | clm_B11 to clm_B13 | `src/core/embeddings.ts`, `src/core/rerank.ts` |
| Two-stage retrieval | Rerank the fused top candidates and blend with first-stage rank so strong lexical hits survive | Voyage guide (clm_C13); tobi/qmd blend (not re-checked, see annex) | `src/core/rerank.ts` |
| Capture fixes | Message keys, streaming and thinking filters | clm_A02 to clm_A14 | `src/core/dom-capture.ts`, `src/core/providers.ts` |

## Unresolved

These claims were reported by a researcher but not independently re-checked, or a primary source contradicts another. The code treats them as unconfirmed and says so where it relies on one.

- **Bedrock Rerank API contract.** The request and response shape (clm_B15), the model ARN format (clm_B16), per-region availability (clm_B17) and the IAM actions (clm_B20) are researcher-reported from the AWS API reference but were not in the verifier's sample.
- **Rerank through InvokeModel.** The `cohere.rerank-v3-5:0` body (`query`, `documents`, `top_n`, `api_version: 2`; clm_B18) is documented only by third parties (OpenSearch, continue). Threadkeeper labels this path experimental and uses it only with a Bedrock API key. The `amazon.rerank-v1:0` body is undocumented (clm_B19), so that model requires IAM keys.
- **Bearer header on Mantle.** AWS examples show `x-api-key`, while Anthropic documents passing the key as the SDK's `apiKey`, which SDK 1.3.0 sends as `Authorization: Bearer`. Threadkeeper follows the SDK path; neither has been tested live.
- **Fallback beta on Bedrock.** Whether Bedrock accepts the `fallback-credit-2026-07-01` beta header used by the SDK's refusal-fallback middleware is unconfirmed. Threadkeeper drops the middleware automatically if Bedrock rejects the header.
- **Selectors with no current open-source evidence.** Claude Code on the web, Codex cloud on chatgpt.com, Grok on X (DOM), Meta AI, Qwen, Poe and HuggingChat message selectors.
- **CLI session formats.** The Claude Code `custom-title` and `agent-name` field names, and whether every record in subagent files sets `isSidechain`.
- **Other claims not re-checked.** The remaining 48 such claims are listed in `artifacts/claim_ledger.jsonl` with `independent_verification.verdict = "not_rechecked"`.

## Refuted

- **clm_A01** said Threadkeeper's Claude turn selector already covered every current selector. The verifier showed it lacks the `[data-test-render-count]` container and the `.font-claude-response:not(#markdown-artifact)` guard, so artifact panels can be captured as messages. The capture changes in 0.3 add the guard.
