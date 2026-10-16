import type { Sky } from "@/lib/weather"

const LABEL: Record<Sky, string> = {
  sun: "Sun",
  cloud: "Cloud",
  rain: "Rain",
  snow: "Snow",
}

export function WeatherIcon({ sky }: { sky: Sky }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="inline-block size-4 shrink-0"
      role="img"
      aria-label={LABEL[sky]}
    >
      {sky === "sun" ? <Sun /> : null}
      {sky === "cloud" ? <Cloud /> : null}
      {sky === "rain" ? <Rain /> : null}
      {sky === "snow" ? <Snow /> : null}
    </svg>
  )
}

function Sun() {
  return (
    <g fill="currentColor">
      <circle cx="8" cy="8" r="3.1" />
      <rect x="7.35" y="0.6" width="1.3" height="2.3" rx="0.65" />
      <rect x="7.35" y="13.1" width="1.3" height="2.3" rx="0.65" />
      <rect x="0.6" y="7.35" width="2.3" height="1.3" rx="0.65" />
      <rect x="13.1" y="7.35" width="2.3" height="1.3" rx="0.65" />
      <rect x="2.15" y="2.7" width="2.2" height="1.25" rx="0.6" transform="rotate(-45 3.25 3.3)" />
      <rect x="11.65" y="2.7" width="2.2" height="1.25" rx="0.6" transform="rotate(45 12.75 3.3)" />
      <rect x="2.15" y="12.05" width="2.2" height="1.25" rx="0.6" transform="rotate(45 3.25 12.7)" />
      <rect x="11.65" y="12.05" width="2.2" height="1.25" rx="0.6" transform="rotate(-45 12.75 12.7)" />
    </g>
  )
}

function Cloud() {
  return (
    <g fill="currentColor">
      <circle cx="6" cy="8.6" r="2.5" />
      <circle cx="9.1" cy="7.3" r="3.1" />
      <circle cx="11.7" cy="8.8" r="2.2" />
      <rect x="5.2" y="8.4" width="7.4" height="2.7" rx="1.2" />
    </g>
  )
}

function Rain() {
  return (
    <g fill="currentColor">
      <circle cx="5.7" cy="6.5" r="2.15" />
      <circle cx="8.5" cy="5.4" r="2.7" />
      <circle cx="11.1" cy="6.7" r="1.9" />
      <rect x="4.9" y="6.4" width="6.8" height="2.3" rx="1" />
      <path d="M5.6 10.2c.5.85.5 1.45 0 2.4-.5-.95-.5-1.55 0-2.4z" />
      <path d="M8.2 10.5c.45.75.45 1.3 0 2.15-.45-.85-.45-1.4 0-2.15z" />
      <path d="M10.7 10.2c.45.75.45 1.3 0 2.15-.45-.85-.45-1.4 0-2.15z" />
    </g>
  )
}

function Snow() {
  return (
    <g fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round">
      <path d="M8 1.5v13M2.2 4.7l11.6 6.6M13.8 4.7 2.2 11.3" />
      <path d="M8 3.7 6.8 2.6M8 3.7l1.2-1.1M8 12.3 6.8 13.4M8 12.3l1.2 1.1" />
    </g>
  )
}
