import type { CSSProperties } from "react";

type IconProps = { className?: string; style?: CSSProperties };

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconUpload({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <path d="M12 16V4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </svg>
  );
}

export function IconBolt({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <path d="M13 3 4 14h6l-1 7 9-11h-6l1-7z" />
    </svg>
  );
}

export function IconBookOpen({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <path d="M12 6c-1.5-1.3-3.6-2-6-2H4v14h2c2.4 0 4.5.7 6 2" />
      <path d="M12 6c1.5-1.3 3.6-2 6-2h2v14h-2c-2.4 0-4.5.7-6 2" />
      <path d="M12 6v14" />
    </svg>
  );
}

export function IconBank({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <path d="M3 10l9-6 9 6" />
      <path d="M5 10v9M10 10v9M14 10v9M19 10v9" />
      <path d="M3 19h18" />
    </svg>
  );
}

export function IconChart({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <path d="M4 20V10M11 20V4M18 20v-7" />
      <path d="M3 20h18" />
    </svg>
  );
}

export function IconTag({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <path d="M12 3h6a2 2 0 0 1 2 2v6l-9 9-8-8 9-9z" />
      <circle cx="16.5" cy="7.5" r="1.25" />
    </svg>
  );
}

export function IconLayers({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <path d="M12 3 3 8l9 5 9-5-9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 16l9 5 9-5" />
    </svg>
  );
}

export function IconShield({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function IconCheck({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </svg>
  );
}

export function IconCoins({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <ellipse cx="9" cy="7" rx="6" ry="3" />
      <path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7" />
      <path d="M9 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5" />
      <ellipse cx="15" cy="12" rx="6" ry="3" />
    </svg>
  );
}

export function IconPerson({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7" />
    </svg>
  );
}

export function IconBag({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <path d="M6 8h12l1 12H5L6 8z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

export function IconGlobe({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.5 4 5.7 4 9s-1.5 6.5-4 9c-2.5-2.5-4-5.7-4-9s1.5-6.5 4-9z" />
    </svg>
  );
}

export function IconInstagram({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="17.2" cy="6.8" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconFacebook({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <path d="M14 21v-8h2.5l.5-3H14V8c0-.9.3-1.5 1.7-1.5H17V3.8C16.6 3.7 15.6 3.6 14.5 3.6 12.1 3.6 10.5 5.1 10.5 7.7V10H8v3h2.5v8h3.5z" />
    </svg>
  );
}

export function IconUnlock({ className, style }: IconProps) {
  return (
    <svg {...base} className={className} style={style}>
      <rect x="4" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a5 5 0 0 1 9-3" />
    </svg>
  );
}
