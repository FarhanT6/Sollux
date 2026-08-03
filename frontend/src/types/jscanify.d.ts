declare module 'jscanify/client' {
  export default class jscanify {
    constructor();
    findPaperContour(img: any): any;
    getCornerPoints(contour: any, img?: any): {
      topLeftCorner?: { x: number; y: number };
      topRightCorner?: { x: number; y: number };
      bottomLeftCorner?: { x: number; y: number };
      bottomRightCorner?: { x: number; y: number };
    };
    highlightPaper(image: any, options?: { color?: string; thickness?: number }): HTMLCanvasElement;
    extractPaper(
      image: any,
      resultWidth: number,
      resultHeight: number,
      cornerPoints?: {
        topLeftCorner: { x: number; y: number };
        topRightCorner: { x: number; y: number };
        bottomLeftCorner: { x: number; y: number };
        bottomRightCorner: { x: number; y: number };
      },
    ): HTMLCanvasElement | null;
  }
}
