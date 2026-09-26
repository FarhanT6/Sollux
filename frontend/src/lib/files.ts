/** A picked file as base64 (no data: prefix), with its name, for JSON upload. */
export function fileToPayload(file: File): Promise<{ name: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve({ name: file.name, data: String(e.target!.result).split(',')[1] ?? '' });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export const filesToPayload = (files: FileList | File[] | null) => Promise.all(Array.from(files ?? []).map(fileToPayload));
