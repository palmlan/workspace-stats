/**
 * Host half of the workspace-stats bundle.
 *
 * It registers nothing: every number the widget shows comes from the shipped
 * `workspaceFiles` Remote (`ctx.remote.workspaceFiles.list`), which the Client
 * half calls directly. The Host half exists because the bundle patch inserts a
 * package row, and a row must resolve to a loadable plugin.
 *
 * `apply` may stay empty, but it must be exported: a row whose module has no
 * `apply` is rejected by the Loader.
 */
export function apply() {}
