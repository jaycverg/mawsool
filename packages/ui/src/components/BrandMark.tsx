/** The two-ring Mawsool mark from the boards: two circles of radius 7 in a 28 unit box, stroke 2.5. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" className={className ?? 'text-accent'}>
      <circle cx="10" cy="14" r="7" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="18" cy="14" r="7" fill="none" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}
