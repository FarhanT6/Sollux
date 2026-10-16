/** SF Symbols-like glyphs for the iOS layer. Stroke icons, currentColor. */
const S = ({ size = 20, children, w = 2 }: { size?: number; children: React.ReactNode; w?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
export const Chevron = ({ size = 14 }: { size?: number }) => <S size={size} w={2.6}><path d="M9 5l7 7-7 7" /></S>;
export const Back = ({ size = 22 }: { size?: number }) => <S size={size} w={2.4}><path d="M15 4l-8 8 8 8" /></S>;
export const Plus = ({ size = 22 }: { size?: number }) => <S size={size} w={2.2}><path d="M12 5v14M5 12h14" /></S>;
export const Search = ({ size = 17 }: { size?: number }) => <S size={size} w={2.2}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></S>;
export const Close = ({ size = 16 }: { size?: number }) => <S size={size} w={2.4}><path d="M6 6l12 12M18 6L6 18" /></S>;
export const Ellipsis = ({ size = 22 }: { size?: number }) => <S size={size}><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></S>;
