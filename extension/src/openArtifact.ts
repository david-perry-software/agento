export const MARKDOWN_PREVIEW_VIEW_TYPE = "vscode.markdown.preview.editor";

export interface OpenArtifactDeps<U> {
  // vscode.openWith silently opens a text editor when the view type is unregistered, so check first.
  previewAvailable(): boolean;
  openWith(uri: U, viewType: string): Thenable<unknown>;
  openSource(uri: U): Thenable<unknown>;
  log(message: string): void;
}

export async function openArtifactPreview<U>(uri: U, deps: OpenArtifactDeps<U>): Promise<"preview" | "source"> {
  if (!deps.previewAvailable()) {
    deps.log(`Markdown preview unavailable (the built-in Markdown extension is disabled or missing); opening ${String(uri)} as source text.`);
    await deps.openSource(uri);
    return "source";
  }
  try {
    await deps.openWith(uri, MARKDOWN_PREVIEW_VIEW_TYPE);
    return "preview";
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log(`Markdown preview unavailable (${reason}); opening ${String(uri)} as source text.`);
    await deps.openSource(uri);
    return "source";
  }
}
