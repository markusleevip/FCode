export type AttachmentKind = "local_file" | "resource" | "inline";

export interface AttachmentRef {
  id: string;
  kind: AttachmentKind;
  uri?: string;
  path?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  placeholder?: string;
  /** Transient media stays live but must not be copied into default history artifacts. */
  retention?: "transient";
  /** Host-verified capture provenance; never grants input authority. */
  captureOrigin?: "computer_use";
}
