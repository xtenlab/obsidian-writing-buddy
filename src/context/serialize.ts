/**
 * Turning assembled context into what the protocol carries.
 *
 * Two properties matter and are asserted by tests:
 *
 *   - **Vault-relative paths only.** Every citation is a path the writer would
 *     recognise inside their vault. No absolute filesystem path is ever sent,
 *     and nothing here reads like an instruction to open a file on the machine
 *     running the model — the content is already supplied, so there is nothing
 *     for the Runtime to go and fetch.
 *   - **Evidence is attributable.** Each excerpt carries its path, and the model
 *     cites it back, which is how a claim gets tied to a file.
 */

import type { ContextDocumentPayload } from "../backend/AIBackend";
import type { AssembledContext } from "./types";
import { buildEvidence, evidenceDocumentPayloads } from "./evidence";
import { instructionLocale, t } from "../i18n";

export interface DocumentPayloadOptions {
	/**
	 * Emit the selected passage itself as a document.
	 *
	 * True for chat, where the frozen V2 schema has no `context.selection` and
	 * `documents` is the documented channel for it. False for a rewrite, where
	 * the selection is a required top-level field and repeating it would send
	 * the same passage twice.
	 */
	includeSelection: boolean;
}

/**
 * Flatten assembled context into the documents the protocol carries.
 *
 * The role is appended to the path label so the model can tell the file being
 * worked on from a character sheet, while the path itself stays vault-relative
 * and citable.
 */
export function toDocumentPayloads(
	context: AssembledContext,
	options: DocumentPayloadOptions = { includeSelection: true },
): ContextDocumentPayload[] {
	const evidence = buildEvidence(context).filter(
		(item) => options.includeSelection || item.kind !== "selection",
	);
	return evidenceDocumentPayloads(evidence);
}

/**
 * Render documents as a Markdown block.
 *
 * Used by Direct API and Local adapters whose native chat endpoint has no
 * separate WritingBuddy documents channel. The framing sentence tells the
 * model the material is already supplied, so it does not try to read files it
 * has no access to.
 */
export function renderDocumentsBlock(documents: ContextDocumentPayload[]): string {
	const usable = documents.filter((document) => document.text.trim().length > 0);
	if (usable.length === 0) return "";

	const en = instructionLocale() === "en";
	return [
		en ? "## Project material (provided by Writing Buddy from the local Vault)" : "## 项目资料（由 WritingBuddy 从本地 Vault 提供）",
		en
			? "The material below is attached to this request. Use it directly; there is no need, and no way, to read files separately. When citing, use the marker in brackets at the start of an item's heading, such as [S1]; only an item without one is cited by its Vault-relative path."
			: "以下内容已随本次请求附上，请直接使用，不需要也无法另行读取文件。引用时用每项标题开头方括号里的编号，例如 [S1]；只有没有编号的条目才写它的 Vault 相对路径。",
		...usable.map((document) => `### \`${document.path}\`\n\n${document.text}`),
	].join("\n\n");
}

/**
 * Combine the writer's ask with a context block.
 *
 * The ask comes first: the model should know what it is being asked to do
 * before it reads several thousand characters of manuscript.
 */
export function composeMessageWithContext(ask: string, contextBlock: string): string {
	if (contextBlock.length === 0) return ask;
	return [ask, "---", contextBlock].join("\n\n");
}

/** A one-line summary for the activity disclosure. */
export function describeContext(context: AssembledContext): string {
	const parts: string[] = [];
	if (context.selection) parts.push(t("context.describeSelection", { count: Array.from(context.selection.text).length }));
	if (context.documents.length > 0) parts.push(t("context.describeDocuments", { count: context.documents.length }));
	parts.push(t("context.describeChars", { count: context.charsUsed }));
	if (context.omitted.length > 0) parts.push(t("context.describeOmitted", { count: context.omitted.length }));
	return parts.join(" · ");
}
