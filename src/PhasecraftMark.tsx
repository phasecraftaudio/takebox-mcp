// The PHASECRAFT icon, inlined from brand/logo/icon.svg. It is drawn in currentColor,
// so it takes the surrounding text colour instead of needing its own asset per theme.
export default function PhasecraftMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 118 120"
      fill="none"
      role="img"
      aria-label="PHASECRAFT"
    >
      <g stroke="currentColor" strokeLinecap="butt">
        <path d="M30 14.5H87" strokeWidth="4" />
        <path d="M30 106H87" strokeWidth="3" />
        <path d="M14.5 28V48" strokeWidth="4" />
        <path d="M14.5 66V92" strokeWidth="4" />
        <path d="M103.5 28V50" strokeWidth="4" />
        <path d="M103.5 74V92" strokeWidth="3" />
        <path d="M14.5 60H55" strokeWidth="4" />
        <path d="M63 60H101" strokeWidth="4" />
      </g>
      <g fill="currentColor">
        <circle cx="14.5" cy="15" r="9" />
        <circle cx="103.5" cy="14.5" r="9" />
        <circle cx="14.5" cy="105.5" r="9" />
        <circle cx="103.5" cy="105.5" r="9" />
        <circle cx="103.5" cy="60" r="3.5" />
      </g>
    </svg>
  );
}
