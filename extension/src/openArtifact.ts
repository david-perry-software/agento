export const MARKDOWN_PREVIEW_VIEW_TYPE = "vscode.markdown.preview.editor";

export interface OpenArtifactDeps<U> {
  openWith(uri: U, viewType: string): Thenable<unknown>;
  openSource(uri: U): Thenable<unknown>;
  log(message: string): void;
}

export async function openArtifactPreview<U>(uri: U, deps: OpenArtifactDeps<U>): Promise<"preview" | "source"> {
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
