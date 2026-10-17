/**
 * A phone photo made small enough to send: at most 1600px on the long side,
 * as a JPEG. A 12-megapixel picture goes from ~4MB to ~300KB, which is
 * plenty to show a leak or a broken part.
 */
export async function shrinkPhoto(file: File, maxSide = 1600): Promise<{ name: string; data: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Not an image'));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { name: file.name.replace(/\.\w+$/, '') + '.jpg', data: canvas.toDataURL('image/jpeg', 0.82) };
  } finally {
    URL.revokeObjectURL(url);
  }
}
