import {
	projectPaths,
} from "../storage/paths";
import { isSafeSessionId } from "../util/id";

export type ProjectDataPath =
	| { kind: "conversation"; sessionId: string }
	| { kind: "skill" };

/**
 * Classify only the project data WritingBuddy owns and may refresh live.
 *
 * A conversation is two shapes since schema 6: the manifest at
 * `conversations/<id>.json`, and its transcript shards at
 * `conversations/<id>/NNNN.json`. Both resolve to the same session, because a
 * shard arriving from sync changes what that conversation says just as much as
 * its manifest does.
 *
 * The nesting is admitted by exact shape rather than by relaxing the check.
 * Rejecting anything containing a slash was doing double duty here — it also
 * stopped `../` from walking out of the folder — so the replacement validates
 * both segments independently: the first against `isSafeSessionId`, the second
 * against the four-digit shard name this plugin writes. Nothing else nests.
 */
export function projectDataPath(path: string): ProjectDataPath | null {
	const normalized = path.replace(/\\/g, "/");
	const conversationPrefix = `${projectPaths.conversationsDir}/`;
	if (normalized.startsWith(conversationPrefix) && normalized.endsWith(".json")) {
		const name = normalized.slice(conversationPrefix.length, -".json".length);
		if (!name.includes("/")) {
			return isSafeSessionId(name) ? { kind: "conversation", sessionId: name } : null;
		}
		const segments = name.split("/");
		if (segments.length !== 2) return null;
		const [sessionId, shard] = segments;
		if (!isSafeSessionId(sessionId) || !/^\d{4}$/u.test(shard)) return null;
		return { kind: "conversation", sessionId };
	}
	if (normalized === projectPaths.skillMigrationFile || normalized === projectPaths.skillResetStateFile) return { kind: "skill" };
	if (normalized.startsWith(`${projectPaths.skillsDir}/`) && normalized.endsWith(".md")) return { kind: "skill" };
	return null;
}
